-- =========================================================================
-- Troca Gamer com varios itens + produtos repetidos (desenho aprovado em 2026-11-22).
--
-- 1. products.archived_at / archived_into: produto arquivado some do Catalogo do ERP e da busca do
--    PDV, mas continua existindo (vendas antigas, estorno, devolucao e garantia apontam para ele).
-- 2. stock_trade_in(p_trade_id, p_lines): "Conferir e Estocar" do ERP com varios itens. Cada linha usa
--    um produto existente ou cria um novo; quantidade, serial e custo por item; linha "skip" = nao vai
--    para o estoque. A soma dos custos tem que dar o valor pago ao cliente. Usa as RPCs de entrada que
--    ja existem (register_stock_entry / register_serialized_stock_entry). Tudo ou nada.
-- 3. merge_products(p_main_id, p_duplicate_ids): junta produtos repetidos (so o dono). Passa unidades
--    com serial, estoque e custo medio para o principal e arquiva os repetidos. Recusa se algum
--    repetido estiver numa reserva ativa.
-- 4. search_pos_items: copia da 20261128 com um filtro a mais (produto arquivado nao aparece).
--    Mesma assinatura e retorno.
--
-- ANTES DE APLICAR: md5(prosrc) vivo de search_pos_items deve ser
--   16a01380f100ffe6e1ba4a9ab3524fb8 (LF) ou 59f5af227540a69c0080f275a25f7797 (CRLF). Se nao bater, PARAR.
-- Os PCs de orcamento ja vendidos (sem estoque) sao escondidos pelo proprio ERP: nao precisam de banco.
-- =========================================================================

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_into TEXT;

-- ---- 2. Estocar a troca com varios itens ------------------------------------
-- p_lines: [{
--   "skip": false,
--   "productId": "..."                     (produto existente)   OU
--   "newProduct": { "sku": "", "name": "", "category": "", "sellPrice": 0, "warrantyMonths": 3,
--                   "isSerialized": true, "ncm": "", "cest": null, "icmsOrigin": "0", "icmsCst": null,
--                   "csosn": "102", "icmsRate": 0, "icmsReduction": 0, "taxBurdenPercent": 26.87 },
--   "quantity": 1, "unitCost": 100.00,
--   "serials": [{ "serialNumber": "...", "imei": "..." }]   (so produto com serial; quantidade = nº de seriais)
-- }]
CREATE OR REPLACE FUNCTION public.stock_trade_in(p_trade_id TEXT, p_lines JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_trade public.trade_ins%ROWTYPE;
  v_line JSONB;
  v_new JSONB;
  v_product_id TEXT;
  v_first_product TEXT;
  v_is_serialized BOOLEAN;
  v_quantity INTEGER;
  v_cost NUMERIC;
  v_total_cents BIGINT := 0;
  v_stocked INTEGER := 0;
  v_serials JSONB;
  v_reason TEXT;
  v_result JSONB := '[]'::JSONB;
BEGIN
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Acesso negado';
  END IF;

  SELECT * INTO v_trade FROM public.trade_ins
  WHERE tenant_id = v_tenant_id AND id = p_trade_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Troca não encontrada';
  END IF;
  IF NOT public.current_user_has_store_access(v_tenant_id, v_trade.unit_id) THEN
    RAISE EXCEPTION 'Acesso negado à loja';
  END IF;
  IF v_trade.status <> 'AVALIADO' THEN
    RAISE EXCEPTION 'Esta troca já foi estocada ou dispensada';
  END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'Informe ao menos um item da troca';
  END IF;

  -- Confere quantidades, custos e a soma antes de gravar qualquer coisa.
  FOR v_line IN SELECT entries.value FROM jsonb_array_elements(p_lines) AS entries(value) LOOP
    CONTINUE WHEN COALESCE((v_line->>'skip')::BOOLEAN, false);
    v_quantity := NULLIF(v_line->>'quantity', '')::INTEGER;
    v_cost := NULLIF(v_line->>'unitCost', '')::NUMERIC;
    IF v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Quantidade inválida em um dos itens';
    END IF;
    IF v_cost IS NULL OR v_cost < 0 OR v_cost <> ROUND(v_cost, 2) THEN
      RAISE EXCEPTION 'Custo inválido em um dos itens (zero ou mais, até duas casas)';
    END IF;
    v_total_cents := v_total_cents + ROUND(v_cost * 100)::BIGINT * v_quantity;
    v_stocked := v_stocked + 1;
  END LOOP;
  IF v_stocked = 0 THEN
    RAISE EXCEPTION 'Ao menos um item precisa ir para o estoque';
  END IF;
  IF v_total_cents <> ROUND(v_trade.valuation_amount * 100)::BIGINT THEN
    RAISE EXCEPTION 'A soma dos custos (R$ %) precisa ser igual ao valor pago na troca (R$ %)',
      to_char(v_total_cents / 100.0, 'FM999G999G990D00'), to_char(v_trade.valuation_amount, 'FM999G999G990D00');
  END IF;

  v_reason := 'Troca Gamer' || COALESCE(' nº ' || v_trade.trade_number::TEXT, '') || ': compra de '
    || COALESCE(NULLIF(BTRIM(v_trade.seller_name), ''), 'cliente');

  FOR v_line IN SELECT entries.value FROM jsonb_array_elements(p_lines) AS entries(value) LOOP
    CONTINUE WHEN COALESCE((v_line->>'skip')::BOOLEAN, false);
    v_quantity := (v_line->>'quantity')::INTEGER;
    v_cost := (v_line->>'unitCost')::NUMERIC;
    v_product_id := NULLIF(BTRIM(COALESCE(v_line->>'productId', '')), '');

    IF v_product_id IS NOT NULL THEN
      SELECT COALESCE(product.is_serialized, false) INTO v_is_serialized
      FROM public.products AS product
      WHERE product.tenant_id = v_tenant_id AND product.id = v_product_id AND product.archived_at IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Produto escolhido não encontrado (ou arquivado)';
      END IF;
    ELSE
      v_new := v_line->'newProduct';
      IF v_new IS NULL OR NULLIF(BTRIM(COALESCE(v_new->>'name', '')), '') IS NULL THEN
        RAISE EXCEPTION 'Informe o nome do produto novo';
      END IF;
      IF COALESCE(NULLIF(v_new->>'sellPrice', '')::NUMERIC, 0) <= 0 THEN
        RAISE EXCEPTION 'Informe o preço de venda de %', BTRIM(v_new->>'name');
      END IF;
      v_is_serialized := COALESCE((v_new->>'isSerialized')::BOOLEAN, false);
      v_product_id := gen_random_uuid()::TEXT;
      INSERT INTO public.products (
        id, tenant_id, sku, name, category, brand, cost_price, sell_price, ncm, warranty_months,
        is_serialized, is_used, cest, icms_origin, icms_cst, csosn, icms_rate, icms_reduction, tax_burden_percent
      ) VALUES (
        v_product_id, v_tenant_id, NULLIF(BTRIM(COALESCE(v_new->>'sku', '')), ''), LEFT(BTRIM(v_new->>'name'), 120),
        COALESCE(NULLIF(BTRIM(v_new->>'category'), ''), 'Outros'), 'Troca Gamer', v_cost,
        (v_new->>'sellPrice')::NUMERIC, NULLIF(BTRIM(COALESCE(v_new->>'ncm', '')), ''),
        COALESCE(NULLIF(v_new->>'warrantyMonths', '')::INTEGER, 0), v_is_serialized, true,
        NULLIF(BTRIM(COALESCE(v_new->>'cest', '')), ''), NULLIF(v_new->>'icmsOrigin', ''), NULLIF(v_new->>'icmsCst', ''),
        NULLIF(v_new->>'csosn', ''), NULLIF(v_new->>'icmsRate', '')::NUMERIC, NULLIF(v_new->>'icmsReduction', '')::NUMERIC,
        NULLIF(v_new->>'taxBurdenPercent', '')::NUMERIC
      );
    END IF;

    IF v_is_serialized THEN
      IF jsonb_typeof(v_line->'serials') IS DISTINCT FROM 'array' OR jsonb_array_length(v_line->'serials') <> v_quantity THEN
        RAISE EXCEPTION 'Produto com serial: informe um serial para cada unidade';
      END IF;
      SELECT jsonb_agg(jsonb_build_object(
        'serialNumber', UPPER(BTRIM(serial->>'serialNumber')),
        'imei', NULLIF(regexp_replace(COALESCE(serial->>'imei', ''), '\s', '', 'g'), ''),
        'unitCost', v_cost
      )) INTO v_serials
      FROM jsonb_array_elements(v_line->'serials') AS serial;
      PERFORM public.register_serialized_stock_entry(v_product_id, v_trade.unit_id, v_serials, v_reason);
    ELSE
      v_serials := NULL;
      PERFORM public.register_stock_entry(
        v_product_id,
        jsonb_build_array(jsonb_build_object('unitId', v_trade.unit_id, 'quantity', v_quantity)),
        v_cost,
        v_reason
      );
    END IF;

    v_first_product := COALESCE(v_first_product, v_product_id);
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'productId', v_product_id, 'quantity', v_quantity,
      'serials', COALESCE((SELECT jsonb_agg(item->>'serialNumber') FROM jsonb_array_elements(v_serials) AS item), '[]'::JSONB)
    ));
  END LOOP;

  UPDATE public.trade_ins
  SET status = 'APROVADO', created_product_id = v_first_product
  WHERE tenant_id = v_tenant_id AND id = p_trade_id;

  RETURN jsonb_build_object('status', 'OK', 'items', v_result);
END;
$$;

REVOKE ALL ON FUNCTION public.stock_trade_in(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stock_trade_in(TEXT, JSONB) TO authenticated;

-- ---- 3. Juntar produtos repetidos (so o dono) -------------------------------
CREATE OR REPLACE FUNCTION public.merge_products(p_main_id TEXT, p_duplicate_ids TEXT[])
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_main public.products%ROWTYPE;
  v_dup_id TEXT;
  v_units TEXT[];
  v_dups TEXT[];
  v_main_inv JSONB;
  v_dup_inv JSONB;
  v_unit TEXT;
  v_qty_main INTEGER;
  v_qty_dup INTEGER;
  v_dup_cost NUMERIC;
  v_operator TEXT;
  v_units_moved INTEGER := 0;
  v_count INTEGER;
BEGIN
  IF v_tenant_id IS NULL OR NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'Só o dono da empresa junta produtos';
  END IF;

  SELECT ARRAY(SELECT DISTINCT BTRIM(item) FROM unnest(COALESCE(p_duplicate_ids, ARRAY[]::TEXT[])) AS item
               WHERE NULLIF(BTRIM(item), '') IS NOT NULL AND BTRIM(item) <> p_main_id) INTO v_dups;
  IF COALESCE(array_length(v_dups, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Escolha ao menos um produto repetido';
  END IF;

  SELECT * INTO v_main FROM public.products
  WHERE tenant_id = v_tenant_id AND id = p_main_id AND archived_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Produto principal não encontrado';
  END IF;

  SELECT COUNT(*) INTO v_count FROM public.products
  WHERE tenant_id = v_tenant_id AND id = ANY(v_dups) AND archived_at IS NULL
    AND COALESCE(is_serialized, false) = COALESCE(v_main.is_serialized, false);
  IF v_count <> array_length(v_dups, 1) THEN
    RAISE EXCEPTION 'Os produtos repetidos precisam existir e ser do mesmo tipo do principal (com ou sem serial)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.product_reservation_items AS item
    JOIN public.product_reservations AS reservation
      ON reservation.tenant_id = item.tenant_id AND reservation.id = item.reservation_id
    WHERE item.tenant_id = v_tenant_id AND item.product_id = ANY(v_dups) AND reservation.status = 'ATIVA'
  ) THEN
    RAISE EXCEPTION 'Um dos produtos repetidos está numa reserva ativa. Converta ou cancele a reserva antes de juntar.';
  END IF;

  SELECT COALESCE(NULLIF(BTRIM(display_name), ''), 'Usuário do ERP') INTO v_operator
  FROM public.app_users WHERE auth_uid = auth.uid() LIMIT 1;

  IF COALESCE(v_main.is_serialized, false) THEN
    -- Lojas afetadas (antes de mover) para recalcular o estoque das duas pontas.
    v_units := ARRAY(
      SELECT DISTINCT unit.unit_id FROM public.product_serial_units AS unit
      WHERE unit.tenant_id = v_tenant_id AND unit.product_id = ANY(v_dups) AND unit.unit_id IS NOT NULL
    );

    UPDATE public.product_serial_units SET product_id = p_main_id
    WHERE tenant_id = v_tenant_id AND product_id = ANY(v_dups);
    GET DIAGNOSTICS v_units_moved = ROW_COUNT;

    FOREACH v_unit IN ARRAY v_units LOOP
      PERFORM public.sync_serialized_inventory_quantity(v_tenant_id, p_main_id, v_unit);
      FOREACH v_dup_id IN ARRAY v_dups LOOP
        PERFORM public.sync_serialized_inventory_quantity(v_tenant_id, v_dup_id, v_unit);
      END LOOP;
    END LOOP;
  ELSE
    SELECT quantities INTO v_main_inv FROM public.inventory
    WHERE tenant_id = v_tenant_id AND product_id = p_main_id FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO public.inventory (tenant_id, product_id, quantities, updated_at)
      VALUES (v_tenant_id, p_main_id, '{}'::JSONB, NOW());
      v_main_inv := '{}'::JSONB;
    END IF;
    v_main_inv := COALESCE(v_main_inv, '{}'::JSONB);

    FOREACH v_dup_id IN ARRAY v_dups LOOP
      SELECT quantities INTO v_dup_inv FROM public.inventory
      WHERE tenant_id = v_tenant_id AND product_id = v_dup_id FOR UPDATE;
      CONTINUE WHEN v_dup_inv IS NULL;
      FOR v_unit IN SELECT jsonb_object_keys(v_dup_inv) LOOP
        v_qty_dup := COALESCE((v_dup_inv -> v_unit ->> 'qty')::INTEGER, 0);
        CONTINUE WHEN v_qty_dup = 0;
        v_main_inv := public.inventory_with_unit(v_main_inv, v_unit);
        v_qty_main := COALESCE((v_main_inv -> v_unit ->> 'qty')::INTEGER, 0);
        IF v_qty_dup > 0 THEN
          v_dup_cost := public.get_store_avg_cost(v_tenant_id, v_dup_id, v_unit);
          PERFORM public.apply_store_cost_entry(v_tenant_id, p_main_id, v_unit, v_qty_main, v_qty_dup, v_dup_cost);
        END IF;
        v_main_inv := jsonb_set(v_main_inv, ARRAY[v_unit, 'qty'], to_jsonb(v_qty_main + v_qty_dup), true);
        v_dup_inv := jsonb_set(v_dup_inv, ARRAY[v_unit, 'qty'], to_jsonb(0), true);
        INSERT INTO public.movements (
          id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
          serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost
        ) VALUES (
          gen_random_uuid()::TEXT, v_tenant_id, p_main_id, NULL, v_unit, v_unit, 'AJUSTE', v_qty_dup,
          NULL, NULL, auth.uid()::TEXT, v_operator, NOW(), 'Junção de produtos: veio de ' || COALESCE((SELECT name FROM public.products WHERE tenant_id = v_tenant_id AND id = v_dup_id), v_dup_id),
          ROUND(COALESCE(v_dup_cost, 0), 4)
        );
      END LOOP;
      UPDATE public.inventory SET quantities = v_dup_inv, updated_at = NOW()
      WHERE tenant_id = v_tenant_id AND product_id = v_dup_id;
      v_dup_inv := NULL;
    END LOOP;

    UPDATE public.inventory SET quantities = v_main_inv, updated_at = NOW()
    WHERE tenant_id = v_tenant_id AND product_id = p_main_id;
  END IF;

  UPDATE public.products SET archived_at = NOW(), archived_into = p_main_id
  WHERE tenant_id = v_tenant_id AND id = ANY(v_dups);

  RETURN jsonb_build_object('status', 'OK', 'archived', array_length(v_dups, 1), 'serialUnitsMoved', v_units_moved);
END;
$$;

REVOKE ALL ON FUNCTION public.merge_products(TEXT, TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merge_products(TEXT, TEXT[]) TO authenticated;

-- ---- 4. Busca do PDV sem produtos arquivados --------------------------------
-- Copia da 20261128 com um filtro a mais: produto arquivado nao aparece.
CREATE OR REPLACE FUNCTION public.search_pos_items(p_query TEXT)
RETURNS TABLE (
  item_id TEXT,
  item_type TEXT,
  sku TEXT,
  name TEXT,
  brand TEXT,
  sell_price NUMERIC,
  available_quantity INTEGER,
  warranty_months INTEGER,
  requires_unit_selection BOOLEAN,
  max_item_discount_percent NUMERIC,
  stores_with_stock TEXT[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_query TEXT := BTRIM(p_query);
  v_max_discount NUMERIC(5, 2);
BEGIN
  IF COALESCE(v_query, '') = '' THEN
    RETURN;
  END IF;

  SELECT * INTO v_terminal
  FROM public.pos_terminals
  WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;

  SELECT COALESCE(config.max_item_discount_percent, 0)
  INTO v_max_discount
  FROM public.store_configs AS config
  WHERE config.tenant_id = v_terminal.tenant_id
    AND config.unit_id = v_terminal.unit_id;
  v_max_discount := COALESCE(v_max_discount, 0);

  RETURN QUERY
  SELECT results.item_id, results.item_type, results.sku, results.name, results.brand,
    results.sell_price, results.available_quantity, results.warranty_months,
    results.requires_unit_selection, COALESCE(results.item_limit, v_max_discount), results.stores_with_stock
  FROM (
    SELECT product.id AS item_id, 'PRODUCT'::TEXT AS item_type, product.sku,
      product.name, product.brand, product.sell_price,
      GREATEST(local_stock.qty, 0) AS available_quantity,
      product.warranty_months,
      COALESCE(product.is_serialized, false) AS requires_unit_selection,
      CASE WHEN local_stock.qty > 0 THEN ARRAY[]::TEXT[] ELSE ARRAY(
        SELECT COALESCE(NULLIF(BTRIM(store.trade_name), ''), store.unit_id)
        FROM public.store_configs AS store
        WHERE store.tenant_id = v_terminal.tenant_id
          AND store.unit_id <> v_terminal.unit_id
          AND store.unit_id <> 'central'
          AND public.pos_store_available_qty(
            v_terminal.tenant_id, product.id, store.unit_id, COALESCE(inventory.quantities, '{}'::JSONB)
          ) > 0
        ORDER BY 1
      ) END AS stores_with_stock,
      product.max_discount_percent AS item_limit
    FROM public.products AS product
    LEFT JOIN public.inventory AS inventory
      ON inventory.tenant_id = v_terminal.tenant_id
      AND inventory.product_id = product.id
    CROSS JOIN LATERAL (
      SELECT public.pos_store_available_qty(
        v_terminal.tenant_id, product.id, v_terminal.unit_id, COALESCE(inventory.quantities, '{}'::JSONB)
      ) AS qty
    ) AS local_stock
    WHERE product.tenant_id = v_terminal.tenant_id
      AND (product.quote_id IS NULL OR local_stock.qty > 0)
      AND product.archived_at IS NULL
      AND (
        product.sku ILIKE '%' || v_query || '%'
        OR product.name ILIKE '%' || v_query || '%'
        OR COALESCE(product.brand, '') ILIKE '%' || v_query || '%'
      )

    UNION ALL

    SELECT service.id AS item_id, 'SERVICE'::TEXT AS item_type, service.sku,
      service.name, NULL::TEXT AS brand, service.sell_price, 0 AS available_quantity,
      NULL::INTEGER AS warranty_months, false AS requires_unit_selection,
      ARRAY[]::TEXT[] AS stores_with_stock,
      NULL::NUMERIC AS item_limit
    FROM public.services AS service
    WHERE service.tenant_id = v_terminal.tenant_id
      AND service.is_active
      AND (
        service.sku ILIKE '%' || v_query || '%'
        OR service.name ILIKE '%' || v_query || '%'
        OR service.category ILIKE '%' || v_query || '%'
      )
  ) AS results
  -- Codigo exato primeiro; depois quem tem estoque (servico conta como disponivel).
  ORDER BY CASE WHEN results.sku ILIKE v_query THEN 0 ELSE 1 END,
    CASE WHEN results.item_type = 'PRODUCT' AND results.available_quantity <= 0 THEN 1 ELSE 0 END,
    results.name
  LIMIT 30;
END;
$$;

REVOKE ALL ON FUNCTION public.search_pos_items(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_pos_items(TEXT) TO authenticated;
