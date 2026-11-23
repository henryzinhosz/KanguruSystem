-- =========================================================================
-- Peças avulsas - PC (desenho aprovado em 2026-11-22).
-- No PDV o vendedor informa tipo, nome e preço de cada peça; o banco cria um cadastro por peça
-- (como o Orçamento de PC, porque a venda usa o nome e o preço do cadastro) com 1 unidade de
-- custo zero na loja. A venda segue normal (desconto, cartão, NFC-e, estorno, devolução, garantia).
-- Depois, no ERP, o dono informa o custo: corrige o custo congelado nas vendas daquela peça.
-- Peça vendida (sem estoque) some da busca do PDV e do Catálogo; peça que não foi vendida
-- (removida do carrinho / venda descartada) é descartada: estoque zera e o cadastro é arquivado.
--
-- NCM por tipo informados pelo usuário em 2026-11-22. Origem 2, CSOSN 102, ICMS 0, tributos 26%
-- (padrão dos produtos da loja). Garantia padrão 3 meses (vendedor pode mudar).
--
-- Muda: products.loose_part / cost_pending (novas), funções novas e search_pos_items
-- (copia da 20261206 trocando só o filtro do orçamento para valer também para peça avulsa).
-- ANTES DE APLICAR: md5(prosrc) vivo de search_pos_items deve ser
--   2adb5bca5171e1a06836e7f1ce830803 (LF) ou 009d69739714d7d377a3e415ffe4eb89 (CRLF). Se não bater, PARAR.
-- =========================================================================

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS loose_part BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cost_pending BOOLEAN NOT NULL DEFAULT false;

-- NCM de cada tipo de peça (só dígitos, como os outros produtos criados pelo banco).
CREATE OR REPLACE FUNCTION public.loose_part_ncm(p_type TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE p_type
    WHEN 'Processador' THEN '85423190'
    WHEN 'Placa-mãe' THEN '84733041'
    WHEN 'Memória RAM' THEN '84733042'
    WHEN 'SSD' THEN '84717040'
    WHEN 'HD' THEN '84717010'
    WHEN 'Placa de vídeo' THEN '84733049'
    WHEN 'Fonte' THEN '85044090'
    WHEN 'Gabinete' THEN '84733019'
    WHEN 'Cooler' THEN '84145990'
    WHEN 'Monitor' THEN '85285200'
  END;
$$;

REVOKE ALL ON FUNCTION public.loose_part_ncm(TEXT) FROM PUBLIC, anon, authenticated;

-- PDV: cria as peças e lança 1 unidade de cada (custo zero, pendente).
-- p_parts: [{ "type": "Processador", "name": "AMD Ryzen 7 5700X", "price": 1618.12, "warrantyMonths": 3 }]
CREATE OR REPLACE FUNCTION public.create_pos_loose_parts(p_parts JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE := public.work_order_terminal();
  v_part JSONB;
  v_type TEXT;
  v_name TEXT;
  v_price NUMERIC;
  v_warranty INTEGER;
  v_ncm TEXT;
  v_product_id TEXT;
  v_sku TEXT;
  v_quantities JSONB;
  v_qty_before INTEGER;
  v_max_discount NUMERIC;
  v_result JSONB := '[]'::JSONB;
BEGIN
  IF jsonb_typeof(p_parts) IS DISTINCT FROM 'array' OR jsonb_array_length(p_parts) = 0 THEN
    RAISE EXCEPTION 'Informe ao menos uma peça';
  END IF;
  IF jsonb_array_length(p_parts) > 20 THEN
    RAISE EXCEPTION 'No máximo 20 peças de uma vez';
  END IF;

  -- Confere tudo antes de gravar.
  FOR v_part IN SELECT entries.value FROM jsonb_array_elements(p_parts) AS entries(value) LOOP
    IF public.loose_part_ncm(v_part->>'type') IS NULL THEN
      RAISE EXCEPTION 'Tipo de peça inválido: %', COALESCE(v_part->>'type', '');
    END IF;
    IF NULLIF(BTRIM(COALESCE(v_part->>'name', '')), '') IS NULL THEN
      RAISE EXCEPTION 'Informe o nome de cada peça';
    END IF;
    v_price := NULLIF(v_part->>'price', '')::NUMERIC;
    IF v_price IS NULL OR v_price <= 0 OR v_price <> ROUND(v_price, 2) THEN
      RAISE EXCEPTION 'Preço inválido em %', BTRIM(v_part->>'name');
    END IF;
    v_warranty := COALESCE(NULLIF(v_part->>'warrantyMonths', '')::INTEGER, 3);
    IF v_warranty < 0 OR v_warranty > 60 THEN
      RAISE EXCEPTION 'Garantia inválida em %', BTRIM(v_part->>'name');
    END IF;
  END LOOP;

  SELECT COALESCE(config.max_item_discount_percent, 0) INTO v_max_discount
  FROM public.store_configs AS config
  WHERE config.tenant_id = v_terminal.tenant_id AND config.unit_id = v_terminal.unit_id;

  FOR v_part IN SELECT entries.value FROM jsonb_array_elements(p_parts) AS entries(value) LOOP
    v_type := v_part->>'type';
    v_name := BTRIM(v_part->>'name');
    IF v_name NOT ILIKE v_type || '%' THEN
      v_name := v_type || ' ' || v_name;
    END IF;
    v_name := LEFT(v_name, 120);
    v_price := (v_part->>'price')::NUMERIC;
    v_warranty := COALESCE(NULLIF(v_part->>'warrantyMonths', '')::INTEGER, 3);
    v_ncm := public.loose_part_ncm(v_type);
    v_product_id := gen_random_uuid()::TEXT;

    INSERT INTO public.products (
      id, tenant_id, sku, name, category, cost_price, sell_price, ncm, icms_origin, csosn, icms_rate,
      icms_reduction, tax_burden_percent, warranty_months, is_serialized, is_used, loose_part, cost_pending
    ) VALUES (
      v_product_id, v_terminal.tenant_id, NULL, v_name, 'Peças', 0, v_price, v_ncm, '2', '102', 0,
      0, 26, v_warranty, false, false, true, true
    )
    RETURNING sku INTO v_sku;

    INSERT INTO public.inventory (tenant_id, product_id, quantities, updated_at)
    VALUES (v_terminal.tenant_id, v_product_id, '{}'::JSONB, NOW())
    ON CONFLICT DO NOTHING;
    SELECT inv.quantities INTO v_quantities FROM public.inventory AS inv
    WHERE inv.tenant_id = v_terminal.tenant_id AND inv.product_id = v_product_id
    FOR UPDATE;
    v_quantities := public.inventory_with_unit(COALESCE(v_quantities, '{}'::JSONB), v_terminal.unit_id);
    v_qty_before := COALESCE((v_quantities -> v_terminal.unit_id ->> 'qty')::INTEGER, 0);
    PERFORM public.apply_store_cost_entry(v_terminal.tenant_id, v_product_id, v_terminal.unit_id, v_qty_before, 1, 0);
    v_quantities := jsonb_set(v_quantities, ARRAY[v_terminal.unit_id, 'qty'], to_jsonb(v_qty_before + 1), true);
    UPDATE public.inventory SET quantities = v_quantities, updated_at = NOW()
    WHERE tenant_id = v_terminal.tenant_id AND product_id = v_product_id;

    INSERT INTO public.movements (
      id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
      serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost
    ) VALUES (
      gen_random_uuid()::TEXT, v_terminal.tenant_id, v_product_id, NULL, 'PECA_AVULSA', v_terminal.unit_id, 'ENTRADA', 1,
      '[]'::JSONB, NULL, auth.uid()::TEXT, COALESCE(v_terminal.display_name, 'PDV'), NOW(),
      'Peça avulsa (venda no PDV, custo a informar no ERP)', 0
    );

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'id', v_product_id, 'itemType', 'PRODUCT', 'sku', v_sku, 'name', v_name, 'brand', NULL,
      'sellPrice', v_price, 'availableQuantity', 1, 'warrantyMonths', v_warranty,
      'requiresUnitSelection', false, 'maxItemDiscountPercent', COALESCE(v_max_discount, 0),
      'storesWithStock', '[]'::JSONB
    ));
  END LOOP;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.create_pos_loose_parts(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_pos_loose_parts(JSONB) TO authenticated;

-- Descarta peças avulsas que não foram vendidas: zera o estoque e arquiva (interna).
CREATE OR REPLACE FUNCTION public.discard_loose_parts_core(p_tenant_id UUID, p_product_ids TEXT[], p_operator TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_product_id TEXT;
  v_quantities JSONB;
  v_unit TEXT;
  v_qty INTEGER;
  v_count INTEGER := 0;
BEGIN
  FOREACH v_product_id IN ARRAY COALESCE(p_product_ids, ARRAY[]::TEXT[]) LOOP
    -- So peca avulsa ainda pendente, ativa e que nao aparece em nenhuma venda.
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM public.products
      WHERE tenant_id = p_tenant_id AND id = v_product_id AND loose_part AND cost_pending AND archived_at IS NULL
    );
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.sales
      WHERE tenant_id = p_tenant_id AND items @> jsonb_build_array(jsonb_build_object('productId', v_product_id))
    );
    SELECT quantities INTO v_quantities FROM public.inventory
    WHERE tenant_id = p_tenant_id AND product_id = v_product_id FOR UPDATE;
    IF v_quantities IS NOT NULL THEN
      FOR v_unit IN SELECT jsonb_object_keys(v_quantities) LOOP
        v_qty := COALESCE((v_quantities -> v_unit ->> 'qty')::INTEGER, 0);
        CONTINUE WHEN v_qty = 0;
        v_quantities := jsonb_set(v_quantities, ARRAY[v_unit, 'qty'], to_jsonb(0), true);
        INSERT INTO public.movements (
          id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
          serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost
        ) VALUES (
          gen_random_uuid()::TEXT, p_tenant_id, v_product_id, NULL, v_unit, 'PECA_AVULSA', 'AJUSTE', v_qty,
          '[]'::JSONB, NULL, auth.uid()::TEXT, p_operator, NOW(), 'Peça avulsa não vendida (descartada)', 0
        );
      END LOOP;
      UPDATE public.inventory SET quantities = v_quantities, updated_at = NOW()
      WHERE tenant_id = p_tenant_id AND product_id = v_product_id;
    END IF;
    UPDATE public.products SET archived_at = NOW(), cost_pending = false
    WHERE tenant_id = p_tenant_id AND id = v_product_id;
    v_count := v_count + 1;
    v_quantities := NULL;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.discard_loose_parts_core(UUID, TEXT[], TEXT) FROM PUBLIC, anon, authenticated;

-- PDV: peça removida do carrinho ou venda descartada.
CREATE OR REPLACE FUNCTION public.discard_pos_loose_parts(p_product_ids TEXT[])
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE := public.work_order_terminal();
BEGIN
  RETURN public.discard_loose_parts_core(v_terminal.tenant_id, p_product_ids, COALESCE(v_terminal.display_name, 'PDV'));
END;
$$;

REVOKE ALL ON FUNCTION public.discard_pos_loose_parts(TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.discard_pos_loose_parts(TEXT[]) TO authenticated;

-- ERP (só o dono): descarta peça que ficou sem vender (PDV fechado no meio da venda etc.).
CREATE OR REPLACE FUNCTION public.discard_loose_part(p_product_id TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_operator TEXT;
BEGIN
  IF v_tenant_id IS NULL OR NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'Só o dono da empresa descarta peças avulsas';
  END IF;
  SELECT COALESCE(NULLIF(BTRIM(display_name), ''), 'Usuário do ERP') INTO v_operator
  FROM public.app_users WHERE auth_uid = auth.uid() LIMIT 1;
  RETURN public.discard_loose_parts_core(v_tenant_id, ARRAY[p_product_id], v_operator);
END;
$$;

REVOKE ALL ON FUNCTION public.discard_loose_part(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.discard_loose_part(TEXT) TO authenticated;

-- ERP (só o dono): informa o custo da peça vendida e corrige o custo congelado nas vendas e devoluções.
CREATE OR REPLACE FUNCTION public.set_loose_part_cost(p_product_id TEXT, p_cost NUMERIC)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_sales INTEGER;
BEGIN
  IF v_tenant_id IS NULL OR NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'Só o dono da empresa informa o custo das peças avulsas';
  END IF;
  IF p_cost IS NULL OR p_cost < 0 OR p_cost <> ROUND(p_cost, 2) THEN
    RAISE EXCEPTION 'Custo inválido (zero ou mais, até duas casas)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.products WHERE tenant_id = v_tenant_id AND id = p_product_id AND loose_part) THEN
    RAISE EXCEPTION 'Peça avulsa não encontrada';
  END IF;

  UPDATE public.products SET cost_price = p_cost, cost_pending = false
  WHERE tenant_id = v_tenant_id AND id = p_product_id;
  UPDATE public.product_store_costs SET avg_cost = p_cost, updated_at = NOW()
  WHERE tenant_id = v_tenant_id AND product_id = p_product_id;

  UPDATE public.sales AS sale
  SET items = (
    SELECT jsonb_agg(
      CASE WHEN entry.item->>'productId' = p_product_id
        THEN entry.item || jsonb_build_object(
          'unitCost', p_cost,
          'costTotal', ROUND(p_cost * COALESCE(NULLIF(entry.item->>'quantity', '')::NUMERIC, 1), 2))
        ELSE entry.item END
      ORDER BY entry.ord)
    FROM jsonb_array_elements(sale.items) WITH ORDINALITY AS entry(item, ord)
  )
  WHERE sale.tenant_id = v_tenant_id
    AND sale.items @> jsonb_build_array(jsonb_build_object('productId', p_product_id));
  GET DIAGNOSTICS v_sales = ROW_COUNT;

  UPDATE public.sale_return_items SET unit_cost = p_cost
  WHERE tenant_id = v_tenant_id AND product_id = p_product_id;

  RETURN v_sales;
END;
$$;

REVOKE ALL ON FUNCTION public.set_loose_part_cost(TEXT, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_loose_part_cost(TEXT, NUMERIC) TO authenticated;

-- Busca do PDV: copia da 20261206 trocando só o filtro do orçamento (peça avulsa vendida também some).
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
      AND ((product.quote_id IS NULL AND NOT COALESCE(product.loose_part, false)) OR local_stock.qty > 0)
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
