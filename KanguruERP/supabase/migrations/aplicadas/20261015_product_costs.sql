-- =========================================================================
-- 2.7b Parte 1 — Custo por loja e lucro real
--
-- 1. Custo medio ponderado POR LOJA para produtos sem serial
--    (product_store_costs). products.cost_price vira o "custo padrao":
--    referencia e valor de reserva quando a loja ainda nao tem custo.
-- 2. Custo de compra em cada unidade serializada (product_serial_units.unit_cost).
-- 3. Historico de custo em cada movimentacao (movements.unit_cost).
-- 4. Estoque minimo por produto (products.min_stock; NULL = nao definido).
-- 5. Custo congelado em cada item da venda (sales.items: unitCost, costTotal)
--    no PDV e no ERP. Assinaturas e retornos das RPCs NAO mudam.
-- 6. Nova RPC atomica de entrada de estoque com custo (register_stock_entry).
-- 7. Transferencia leva o custo da loja de origem; perda/ajuste nao mudam a
--    media; estorno devolve as unidades com o custo congelado na venda.
--
-- Corrige tambem: jsonb_set nao cria a loja dentro de inventory.quantities
-- quando ela ainda nao existe (entrada/transferencia para loja nova).
-- =========================================================================

-- ---- 1. Colunas novas ----------------------------------------------------

ALTER TABLE public.product_serial_units
  ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(12, 2);
ALTER TABLE public.product_serial_units
  DROP CONSTRAINT IF EXISTS product_serial_units_unit_cost_check;
ALTER TABLE public.product_serial_units
  ADD CONSTRAINT product_serial_units_unit_cost_check CHECK (unit_cost IS NULL OR unit_cost >= 0);

ALTER TABLE public.movements
  ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(12, 4);

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS min_stock INTEGER;
ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_min_stock_check;
ALTER TABLE public.products
  ADD CONSTRAINT products_min_stock_check CHECK (min_stock IS NULL OR min_stock >= 0);

-- ---- 2. Custo medio por loja ---------------------------------------------

CREATE TABLE IF NOT EXISTS public.product_store_costs (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  avg_cost NUMERIC(12, 4) NOT NULL CHECK (avg_cost >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, product_id, unit_id),
  CONSTRAINT product_store_costs_store_fk
    FOREIGN KEY (tenant_id, unit_id) REFERENCES public.store_configs(tenant_id, unit_id) ON DELETE CASCADE
);

ALTER TABLE public.product_store_costs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.product_store_costs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.product_store_costs TO authenticated;

-- Leitura: usuario do ERP com acesso a loja. Escrita somente via RPC.
DROP POLICY IF EXISTS product_store_costs_read ON public.product_store_costs;
CREATE POLICY product_store_costs_read ON public.product_store_costs
  FOR SELECT USING (public.current_user_has_store_access(tenant_id, unit_id));

-- Estoque ja existente: parte do custo padrao do cadastro.
INSERT INTO public.product_store_costs (tenant_id, product_id, unit_id, avg_cost)
SELECT inv.tenant_id, inv.product_id, store_entry.key, GREATEST(COALESCE(product.cost_price, 0), 0)
FROM public.inventory AS inv
JOIN public.products AS product
  ON product.tenant_id = inv.tenant_id AND product.id = inv.product_id
CROSS JOIN LATERAL jsonb_each(inv.quantities) AS store_entry
JOIN public.store_configs AS store
  ON store.tenant_id = inv.tenant_id AND store.unit_id = store_entry.key
WHERE NOT COALESCE(product.is_serialized, false)
ON CONFLICT (tenant_id, product_id, unit_id) DO NOTHING;

UPDATE public.product_serial_units AS unit
SET unit_cost = GREATEST(COALESCE(product.cost_price, 0), 0)
FROM public.products AS product
WHERE product.tenant_id = unit.tenant_id
  AND product.id = unit.product_id
  AND unit.unit_cost IS NULL;

-- ---- 3. Funcoes internas (sem GRANT para authenticated) ------------------

-- Garante a estrutura da loja dentro de inventory.quantities antes do jsonb_set.
CREATE OR REPLACE FUNCTION public.inventory_with_unit(p_quantities JSONB, p_unit_id TEXT)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN jsonb_typeof(COALESCE(p_quantities, '{}'::JSONB) -> p_unit_id) = 'object'
      THEN p_quantities
    ELSE COALESCE(p_quantities, '{}'::JSONB) || jsonb_build_object(
      p_unit_id,
      jsonb_build_object('unitId', p_unit_id, 'qty', 0, 'serials', '[]'::JSONB, 'cardConditions', '{}'::JSONB)
    )
  END;
$$;

-- Custo medio atual da loja; sem registro, usa o custo padrao do cadastro.
CREATE OR REPLACE FUNCTION public.get_store_avg_cost(p_tenant_id UUID, p_product_id TEXT, p_unit_id TEXT)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT cost.avg_cost FROM public.product_store_costs AS cost
     WHERE cost.tenant_id = p_tenant_id AND cost.product_id = p_product_id AND cost.unit_id = p_unit_id),
    (SELECT GREATEST(COALESCE(product.cost_price, 0), 0) FROM public.products AS product
     WHERE product.tenant_id = p_tenant_id AND product.id = p_product_id),
    0
  );
$$;

-- Media ponderada de uma entrada na loja. O chamador DEVE ter travado a linha
-- de inventory do produto (FOR UPDATE) antes de ler p_qty_before.
CREATE OR REPLACE FUNCTION public.apply_store_cost_entry(
  p_tenant_id UUID,
  p_product_id TEXT,
  p_unit_id TEXT,
  p_qty_before INTEGER,
  p_qty_in INTEGER,
  p_unit_cost NUMERIC
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_cost NUMERIC;
  v_base_qty INTEGER;
  v_new_cost NUMERIC;
BEGIN
  IF p_qty_in IS NULL OR p_qty_in <= 0 THEN
    RAISE EXCEPTION 'Quantidade de entrada deve ser maior que zero';
  END IF;
  IF p_unit_cost IS NULL OR p_unit_cost < 0 THEN
    RAISE EXCEPTION 'Custo unitário inválido';
  END IF;

  v_old_cost := public.get_store_avg_cost(p_tenant_id, p_product_id, p_unit_id);
  -- Estoque zerado ou negativo nao pesa na media: o custo novo vira a media.
  v_base_qty := GREATEST(COALESCE(p_qty_before, 0), 0);
  v_new_cost := ROUND((v_base_qty * v_old_cost + p_qty_in * p_unit_cost) / (v_base_qty + p_qty_in), 4);

  INSERT INTO public.product_store_costs (tenant_id, product_id, unit_id, avg_cost, updated_at)
  VALUES (p_tenant_id, p_product_id, p_unit_id, v_new_cost, NOW())
  ON CONFLICT (tenant_id, product_id, unit_id) DO UPDATE
  SET avg_cost = EXCLUDED.avg_cost, updated_at = NOW();

  RETURN v_new_cost;
END;
$$;

REVOKE ALL ON FUNCTION public.inventory_with_unit(JSONB, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_store_avg_cost(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_store_cost_entry(UUID, TEXT, TEXT, INTEGER, INTEGER, NUMERIC) FROM PUBLIC, anon, authenticated;

-- ---- 4. Entrada de estoque com custo (produto sem serial) -----------------
-- p_entries: [{ "unitId": "...", "quantity": 10 }, ...]
-- Tudo ou nada: qualquer erro desfaz a entrada inteira.

CREATE OR REPLACE FUNCTION public.register_stock_entry(
  p_product_id TEXT,
  p_entries JSONB,
  p_unit_cost NUMERIC,
  p_reason TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  active_tenant_id UUID := public.current_user_tenant_id();
  v_is_serialized BOOLEAN;
  v_operator_name TEXT;
  v_quantities JSONB;
  v_entry JSONB;
  v_unit_id TEXT;
  v_quantity INTEGER;
  v_qty_before INTEGER;
  v_entry_count INTEGER;
  v_distinct_units INTEGER;
BEGIN
  IF active_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Acesso negado';
  END IF;
  IF p_unit_cost IS NULL OR p_unit_cost < 0 THEN
    RAISE EXCEPTION 'Informe o custo unitário da compra';
  END IF;
  IF p_unit_cost <> ROUND(p_unit_cost, 2) THEN
    RAISE EXCEPTION 'O custo unitário deve ter no máximo duas casas decimais';
  END IF;
  IF jsonb_typeof(p_entries) IS DISTINCT FROM 'array' OR jsonb_array_length(p_entries) = 0 THEN
    RAISE EXCEPTION 'Informe ao menos uma loja com quantidade';
  END IF;

  SELECT COUNT(*), COUNT(DISTINCT entries.value->>'unitId')
  INTO v_entry_count, v_distinct_units
  FROM jsonb_array_elements(p_entries) AS entries(value);
  IF v_entry_count <> v_distinct_units THEN
    RAISE EXCEPTION 'A mesma loja aparece mais de uma vez na entrada';
  END IF;

  SELECT COALESCE(product.is_serialized, false) INTO v_is_serialized
  FROM public.products AS product
  WHERE product.tenant_id = active_tenant_id AND product.id = p_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Produto não encontrado';
  END IF;
  IF v_is_serialized THEN
    RAISE EXCEPTION 'Use a entrada de estoque serializado para este produto';
  END IF;

  -- Valida todas as lojas antes de escrever qualquer coisa.
  FOR v_entry IN SELECT entries.value FROM jsonb_array_elements(p_entries) AS entries(value) LOOP
    v_unit_id := NULLIF(BTRIM(v_entry->>'unitId'), '');
    v_quantity := NULLIF(v_entry->>'quantity', '')::INTEGER;
    IF v_unit_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.store_configs AS store
      WHERE store.tenant_id = active_tenant_id AND store.unit_id = v_unit_id
    ) THEN
      RAISE EXCEPTION 'Loja inválida na entrada de estoque';
    END IF;
    IF NOT public.current_user_has_store_access(active_tenant_id, v_unit_id) THEN
      RAISE EXCEPTION 'Acesso negado à loja %', v_unit_id;
    END IF;
    IF v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Quantidade deve ser maior que zero';
    END IF;
  END LOOP;

  -- Trava o estoque do produto (serializa entradas, vendas e estornos).
  SELECT inv.quantities INTO v_quantities
  FROM public.inventory AS inv
  WHERE inv.tenant_id = active_tenant_id AND inv.product_id = p_product_id
  FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.inventory (tenant_id, product_id, quantities, updated_at)
    VALUES (active_tenant_id, p_product_id, '{}'::JSONB, NOW());
    SELECT inv.quantities INTO v_quantities
    FROM public.inventory AS inv
    WHERE inv.tenant_id = active_tenant_id AND inv.product_id = p_product_id
    FOR UPDATE;
  END IF;

  v_operator_name := COALESCE((SELECT display_name FROM public.app_users WHERE auth_uid = auth.uid()), '');

  FOR v_entry IN SELECT entries.value FROM jsonb_array_elements(p_entries) AS entries(value) LOOP
    v_unit_id := BTRIM(v_entry->>'unitId');
    v_quantity := (v_entry->>'quantity')::INTEGER;

    v_quantities := public.inventory_with_unit(v_quantities, v_unit_id);
    v_qty_before := COALESCE((v_quantities -> v_unit_id ->> 'qty')::INTEGER, 0);

    PERFORM public.apply_store_cost_entry(active_tenant_id, p_product_id, v_unit_id, v_qty_before, v_quantity, p_unit_cost);

    v_quantities := jsonb_set(v_quantities, ARRAY[v_unit_id, 'qty'], to_jsonb(v_qty_before + v_quantity), true);

    INSERT INTO public.movements (
      id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
      serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost
    ) VALUES (
      gen_random_uuid()::TEXT, active_tenant_id, p_product_id, NULL, 'FORNECEDOR', v_unit_id, 'ENTRADA', v_quantity,
      '[]'::JSONB, NULL, auth.uid()::TEXT, v_operator_name, NOW(),
      COALESCE(NULLIF(BTRIM(p_reason), ''), 'Entrada de estoque'), p_unit_cost
    );
  END LOOP;

  UPDATE public.inventory
  SET quantities = v_quantities, updated_at = NOW()
  WHERE tenant_id = active_tenant_id AND product_id = p_product_id;
END;
$$;

REVOKE ALL ON FUNCTION public.register_stock_entry(TEXT, JSONB, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_stock_entry(TEXT, JSONB, NUMERIC, TEXT) TO authenticated;

-- ---- 5. Entrada serializada: custo por unidade ---------------------------
-- p_units: [{ "serialNumber": "...", "imei": null, "unitCost": 4135.00 }, ...]
-- unitCost ausente = custo padrao do cadastro (compatibilidade com o ERP antigo).

CREATE OR REPLACE FUNCTION public.register_serialized_stock_entry(
  p_product_id TEXT,
  p_unit_id TEXT,
  p_units JSONB,
  p_reason TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  active_tenant_id UUID := public.current_user_tenant_id();
  warranty INTEGER;
  default_cost NUMERIC;
  unit_count INTEGER;
  serial_count INTEGER;
BEGIN
  IF active_tenant_id IS NULL OR NOT public.current_user_has_store_access(active_tenant_id, p_unit_id) THEN
    RAISE EXCEPTION 'Acesso negado à loja';
  END IF;
  IF jsonb_typeof(p_units) <> 'array' OR jsonb_array_length(p_units) = 0 THEN
    RAISE EXCEPTION 'Informe ao menos uma unidade serializada';
  END IF;

  SELECT warranty_months, GREATEST(COALESCE(cost_price, 0), 0) INTO warranty, default_cost
  FROM public.products
  WHERE tenant_id = active_tenant_id
    AND id = p_product_id
    AND is_serialized = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Produto serializado não encontrado';
  END IF;

  SELECT COUNT(*), COUNT(DISTINCT LOWER(BTRIM(unit_item->>'serialNumber')))
  INTO unit_count, serial_count
  FROM jsonb_array_elements(p_units) AS unit_item;
  IF unit_count <> serial_count OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_units) AS unit_item
    WHERE NULLIF(BTRIM(unit_item->>'serialNumber'), '') IS NULL
       OR (unit_item ? 'imei' AND unit_item->>'imei' IS NOT NULL AND NULLIF(BTRIM(unit_item->>'imei'), '') IS NULL)
  ) THEN
    RAISE EXCEPTION 'Cada unidade deve ter um serial único e IMEI válido quando informado';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_units) AS unit_item
    WHERE NULLIF(unit_item->>'unitCost', '') IS NOT NULL
      AND (
        (unit_item->>'unitCost')::NUMERIC < 0
        OR (unit_item->>'unitCost')::NUMERIC <> ROUND((unit_item->>'unitCost')::NUMERIC, 2)
      )
  ) THEN
    RAISE EXCEPTION 'O custo de cada unidade deve ser zero ou maior, com no máximo duas casas decimais';
  END IF;

  INSERT INTO public.product_serial_units (tenant_id, product_id, unit_id, serial_number, imei, status, warranty_months, unit_cost)
  SELECT
    active_tenant_id,
    p_product_id,
    p_unit_id,
    BTRIM(unit_item->>'serialNumber'),
    NULLIF(BTRIM(unit_item->>'imei'), ''),
    'DISPONIVEL',
    COALESCE(warranty, 0),
    COALESCE(NULLIF(unit_item->>'unitCost', '')::NUMERIC, default_cost)
  FROM jsonb_array_elements(p_units) AS unit_item;

  INSERT INTO public.movements (
    id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
    serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost
  )
  VALUES (
    gen_random_uuid()::TEXT, active_tenant_id, p_product_id, NULL, 'FORNECEDOR', p_unit_id, 'ENTRADA', unit_count,
    (SELECT jsonb_agg(BTRIM(unit_item->>'serialNumber')) FROM jsonb_array_elements(p_units) AS unit_item),
    NULL, auth.uid()::TEXT, COALESCE((SELECT display_name FROM public.app_users WHERE auth_uid = auth.uid()), ''), NOW(),
    COALESCE(NULLIF(BTRIM(p_reason), ''), 'Entrada de estoque serializado'),
    (SELECT ROUND(AVG(COALESCE(NULLIF(unit_item->>'unitCost', '')::NUMERIC, default_cost)), 4)
     FROM jsonb_array_elements(p_units) AS unit_item)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.register_serialized_stock_entry(TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_serialized_stock_entry(TEXT, TEXT, JSONB, TEXT) TO authenticated;

-- ---- 6. Movimentacao (transferencia / perda / ajuste / entrada legada) ----
-- Mesma assinatura. Mudancas: transferencia leva o custo da origem e recalcula
-- a media do destino; entrada do FORNECEDOR por aqui (fluxo legado, ex.: troca
-- de usado) usa o custo padrao do cadastro; loja nova dentro de quantities.

CREATE OR REPLACE FUNCTION public.process_inventory_movement(
  p_product_id TEXT,
  p_from_unit_id TEXT,
  p_to_unit_id TEXT,
  p_type TEXT,
  p_quantity INTEGER,
  p_serials JSONB,
  p_card_condition TEXT,
  p_operator_id TEXT,
  p_operator_name TEXT,
  p_timestamp TIMESTAMPTZ,
  p_reason TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  active_tenant_id UUID := public.current_user_tenant_id();
  inv_row public.inventory%ROWTYPE;
  current_qty INTEGER;
  is_serialized_product BOOLEAN;
  default_cost NUMERIC;
  serial_count INTEGER;
  updated_units INTEGER;
  movement_cost NUMERIC;
BEGIN
  IF active_tenant_id IS NULL OR NOT (
    public.current_user_has_store_access(active_tenant_id, p_from_unit_id)
    OR public.current_user_has_store_access(active_tenant_id, p_to_unit_id)
  ) THEN
    RAISE EXCEPTION 'Acesso negado à movimentação';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Quantidade deve ser maior que zero';
  END IF;

  SELECT is_serialized, GREATEST(COALESCE(cost_price, 0), 0) INTO is_serialized_product, default_cost
  FROM public.products
  WHERE tenant_id = active_tenant_id AND id = p_product_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Produto não encontrado';
  END IF;

  IF is_serialized_product THEN
    IF p_from_unit_id = 'FORNECEDOR' THEN
      RAISE EXCEPTION 'Use a entrada de estoque serializado para cadastrar unidades';
    END IF;
    IF jsonb_typeof(p_serials) <> 'array' THEN
      RAISE EXCEPTION 'Informe os números de série das unidades movimentadas';
    END IF;
    SELECT COUNT(*), COUNT(DISTINCT LOWER(BTRIM(value)))
    INTO serial_count, updated_units
    FROM jsonb_array_elements_text(p_serials) AS value;
    IF serial_count <> p_quantity OR serial_count <> updated_units OR EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(p_serials) AS value WHERE NULLIF(BTRIM(value), '') IS NULL
    ) THEN
      RAISE EXCEPTION 'Informe exatamente % números de série únicos', p_quantity;
    END IF;
    IF p_to_unit_id = 'CLIENTE' THEN
      RAISE EXCEPTION 'Use a transação de venda para vender unidades serializadas';
    END IF;

    -- O custo viaja com a propria unidade; aqui so registramos a media no historico.
    SELECT ROUND(AVG(COALESCE(unit.unit_cost, default_cost)), 4) INTO movement_cost
    FROM public.product_serial_units AS unit
    WHERE unit.tenant_id = active_tenant_id AND unit.product_id = p_product_id AND unit.unit_id = p_from_unit_id
      AND unit.status = 'DISPONIVEL'
      AND LOWER(unit.serial_number) IN (SELECT LOWER(BTRIM(value)) FROM jsonb_array_elements_text(p_serials) AS value);

    IF p_to_unit_id = 'PERDA' THEN
      UPDATE public.product_serial_units
      SET status = 'PERDIDO', sale_id = NULL
      WHERE tenant_id = active_tenant_id AND product_id = p_product_id AND unit_id = p_from_unit_id
        AND status = 'DISPONIVEL'
        AND LOWER(serial_number) IN (SELECT LOWER(BTRIM(value)) FROM jsonb_array_elements_text(p_serials) AS value);
    ELSE
      UPDATE public.product_serial_units
      SET unit_id = p_to_unit_id
      WHERE tenant_id = active_tenant_id AND product_id = p_product_id AND unit_id = p_from_unit_id
        AND status = 'DISPONIVEL'
        AND LOWER(serial_number) IN (SELECT LOWER(BTRIM(value)) FROM jsonb_array_elements_text(p_serials) AS value);
    END IF;
    GET DIAGNOSTICS updated_units = ROW_COUNT;
    IF updated_units <> p_quantity THEN
      RAISE EXCEPTION 'Uma ou mais unidades não estão disponíveis na origem';
    END IF;
    INSERT INTO public.movements (id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity, serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost)
    VALUES (gen_random_uuid()::TEXT, active_tenant_id, p_product_id, NULL, p_from_unit_id, p_to_unit_id, p_type, p_quantity, p_serials, p_card_condition, auth.uid()::TEXT, p_operator_name, p_timestamp, p_reason, movement_cost);
    RETURN;
  END IF;

  SELECT * INTO inv_row FROM public.inventory WHERE tenant_id = active_tenant_id AND product_id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    IF p_from_unit_id = 'FORNECEDOR' AND p_to_unit_id NOT IN ('CLIENTE', 'PERDA') THEN
      INSERT INTO public.inventory (tenant_id, product_id, quantities, updated_at)
      VALUES (active_tenant_id, p_product_id, '{}'::jsonb, NOW());
      SELECT * INTO inv_row FROM public.inventory WHERE tenant_id = active_tenant_id AND product_id = p_product_id FOR UPDATE;
    ELSE
      RAISE EXCEPTION 'Produto não encontrado no inventário';
    END IF;
  END IF;

  -- Custo de cada unidade que se move: o da origem (ou o padrao, se vier do fornecedor).
  IF p_from_unit_id = 'FORNECEDOR' THEN
    movement_cost := default_cost;
  ELSE
    movement_cost := public.get_store_avg_cost(active_tenant_id, p_product_id, p_from_unit_id);
  END IF;

  IF p_from_unit_id <> 'FORNECEDOR' THEN
    current_qty := COALESCE((inv_row.quantities -> p_from_unit_id ->> 'qty')::INTEGER, 0);
    IF current_qty < p_quantity THEN RAISE EXCEPTION 'Estoque insuficiente na origem %', p_from_unit_id; END IF;
    inv_row.quantities := jsonb_set(inv_row.quantities, ARRAY[p_from_unit_id, 'qty'], to_jsonb(current_qty - p_quantity), true);
  END IF;
  IF p_to_unit_id NOT IN ('CLIENTE', 'PERDA') THEN
    inv_row.quantities := public.inventory_with_unit(inv_row.quantities, p_to_unit_id);
    current_qty := COALESCE((inv_row.quantities -> p_to_unit_id ->> 'qty')::INTEGER, 0);
    -- Saidas (perda, venda, ajuste) nao mudam a media; so a loja que recebe recalcula.
    PERFORM public.apply_store_cost_entry(active_tenant_id, p_product_id, p_to_unit_id, current_qty, p_quantity, movement_cost);
    inv_row.quantities := jsonb_set(inv_row.quantities, ARRAY[p_to_unit_id, 'qty'], to_jsonb(current_qty + p_quantity), true);
  END IF;
  UPDATE public.inventory SET quantities = inv_row.quantities, updated_at = NOW()
  WHERE tenant_id = active_tenant_id AND product_id = p_product_id;
  INSERT INTO public.movements (id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity, serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost)
  VALUES (gen_random_uuid()::TEXT, active_tenant_id, p_product_id, NULL, p_from_unit_id, p_to_unit_id, p_type, p_quantity, p_serials, p_card_condition, auth.uid()::TEXT, p_operator_name, p_timestamp, p_reason, movement_cost);
END;
$$;

REVOKE ALL ON FUNCTION public.process_inventory_movement(TEXT, TEXT, TEXT, TEXT, INTEGER, JSONB, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_inventory_movement(TEXT, TEXT, TEXT, TEXT, INTEGER, JSONB, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) TO authenticated;

-- ---- 7. Venda do ERP: custo congelado em cada item ------------------------
-- Mesma assinatura e retorno. O custo e calculado pelo servidor (o valor que
-- vier do navegador em unitCost/costTotal e sobrescrito).

CREATE OR REPLACE FUNCTION public.process_sale_transaction(
  p_sale_id TEXT,
  p_invoice_number TEXT,
  p_unit_id TEXT,
  p_items JSONB,
  p_payment_method TEXT,
  p_gross_amount NUMERIC,
  p_fee_amount NUMERIC,
  p_net_amount NUMERIC,
  p_operator_id TEXT,
  p_operator_name TEXT,
  p_client_cpf TEXT,
  p_client_name TEXT,
  p_timestamp TIMESTAMPTZ,
  p_status TEXT,
  p_requires_approval BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  active_tenant_id UUID := public.current_user_tenant_id();
  item JSONB; item_product_id TEXT; item_quantity INTEGER; current_qty INTEGER;
  inv_row public.inventory%ROWTYPE;
  is_serialized_product BOOLEAN;
  default_cost NUMERIC;
  item_cost_total NUMERIC;
  item_unit_cost NUMERIC;
  normalized_items JSONB := '[]'::JSONB;
BEGIN
  IF active_tenant_id IS NULL OR NOT public.current_user_has_store_access(active_tenant_id, p_unit_id) THEN
    RAISE EXCEPTION 'Acesso negado à loja';
  END IF;

  INSERT INTO public.sales (id, tenant_id, invoice_number, unit_id, items, payment_method, gross_amount, fee_amount, net_amount, operator_id, operator_name, client_cpf, client_name, timestamp, status, requires_approval)
  VALUES (p_sale_id, active_tenant_id, p_invoice_number, p_unit_id, p_items, p_payment_method, p_gross_amount, p_fee_amount, p_net_amount, auth.uid()::TEXT, p_operator_name, p_client_cpf, p_client_name, p_timestamp, p_status, p_requires_approval);

  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    item_product_id := item->>'productId';
    item_quantity := (item->>'quantity')::INTEGER;
    IF item_quantity IS NULL OR item_quantity <= 0 THEN
      RAISE EXCEPTION 'Quantidade deve ser maior que zero';
    END IF;

    SELECT is_serialized, GREATEST(COALESCE(cost_price, 0), 0) INTO is_serialized_product, default_cost
    FROM public.products
    WHERE tenant_id = active_tenant_id AND id = item_product_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Produto % não encontrado', item_product_id;
    END IF;

    IF is_serialized_product THEN
      PERFORM public.mark_serial_units_sold(active_tenant_id, item_product_id, p_unit_id, p_sale_id, item->'serials', item_quantity);
      SELECT COALESCE(SUM(COALESCE(unit.unit_cost, default_cost)), 0) INTO item_cost_total
      FROM public.product_serial_units AS unit
      WHERE unit.tenant_id = active_tenant_id AND unit.product_id = item_product_id
        AND unit.sale_id = p_sale_id AND unit.status = 'VENDIDO'
        AND LOWER(unit.serial_number) IN (
          SELECT LOWER(BTRIM(value)) FROM jsonb_array_elements_text(item->'serials') AS value
        );
    ELSE
      SELECT * INTO inv_row
      FROM public.inventory
      WHERE tenant_id = active_tenant_id AND product_id = item_product_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Produto % não encontrado no inventário', item_product_id;
      END IF;
      current_qty := COALESCE((inv_row.quantities -> p_unit_id ->> 'qty')::INTEGER, 0);
      IF current_qty < item_quantity THEN
        RAISE EXCEPTION 'Estoque insuficiente para o produto % na loja %', item_product_id, p_unit_id;
      END IF;
      item_cost_total := public.get_store_avg_cost(active_tenant_id, item_product_id, p_unit_id) * item_quantity;
      UPDATE public.inventory
      SET quantities = jsonb_set(inv_row.quantities, ARRAY[p_unit_id, 'qty'], to_jsonb(current_qty - item_quantity), true), updated_at = NOW()
      WHERE tenant_id = active_tenant_id AND product_id = item_product_id;
    END IF;

    item_cost_total := ROUND(item_cost_total, 2);
    item_unit_cost := ROUND(item_cost_total / item_quantity, 4);
    normalized_items := normalized_items || jsonb_build_array(
      item || jsonb_build_object('unitCost', item_unit_cost, 'costTotal', item_cost_total)
    );

    INSERT INTO public.movements (id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity, serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost)
    VALUES (gen_random_uuid()::TEXT, active_tenant_id, item_product_id, item->>'variationId', p_unit_id, 'CLIENTE', 'SAIDA', item_quantity, item->'serials', item->>'cardCondition', auth.uid()::TEXT, p_operator_name, p_timestamp, 'Venda registrada', item_unit_cost);
  END LOOP;

  UPDATE public.sales
  SET items = normalized_items
  WHERE tenant_id = active_tenant_id AND id = p_sale_id;
END;
$$;

REVOKE ALL ON FUNCTION public.process_sale_transaction(TEXT, TEXT, TEXT, JSONB, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_sale_transaction(TEXT, TEXT, TEXT, JSONB, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN) TO authenticated;

-- ---- 8. Estorno: devolve as unidades com o custo congelado ---------------
-- Mesma assinatura e retorno.

CREATE OR REPLACE FUNCTION public.process_sale_cancellation(p_sale_id TEXT, p_approved_by TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  active_tenant_id UUID := public.current_user_tenant_id();
  sale_row public.sales%ROWTYPE;
  inv_row public.inventory%ROWTYPE;
  item JSONB;
  item_type TEXT;
  item_product_id TEXT;
  item_quantity INTEGER;
  is_serialized_product BOOLEAN;
  updated_units INTEGER;
  current_qty INTEGER;
  return_unit_cost NUMERIC;
BEGIN
  SELECT * INTO sale_row
  FROM public.sales
  WHERE tenant_id = active_tenant_id AND id = p_sale_id
  FOR UPDATE;
  IF NOT FOUND OR NOT public.current_user_has_store_access(active_tenant_id, sale_row.unit_id) THEN
    RAISE EXCEPTION 'Sale not found or access denied';
  END IF;
  IF sale_row.status = 'CANCELADA' THEN
    RAISE EXCEPTION 'Sale is already cancelled';
  END IF;

  UPDATE public.sales
  SET status = 'CANCELADA', approved_by = p_approved_by
  WHERE tenant_id = active_tenant_id AND id = p_sale_id;

  FOR item IN SELECT entries.value FROM jsonb_array_elements(sale_row.items) AS entries(value) LOOP
    item_type := UPPER(COALESCE(item->>'itemType', 'PRODUCT'));
    IF item_type = 'SERVICE' THEN
      CONTINUE;
    END IF;
    IF item_type <> 'PRODUCT' THEN
      RAISE EXCEPTION 'Unsupported sale item type in cancellation: %', item_type;
    END IF;

    item_product_id := item->>'productId';
    item_quantity := (item->>'quantity')::INTEGER;
    SELECT COALESCE(product.is_serialized, false)
    INTO is_serialized_product
    FROM public.products AS product
    WHERE product.tenant_id = active_tenant_id AND product.id = item_product_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Product % not found during cancellation', item_product_id;
    END IF;

    -- Custo congelado na venda; venda antiga sem custo usa a media atual (nao altera a media).
    return_unit_cost := NULLIF(item->>'costTotal', '')::NUMERIC / NULLIF(item_quantity, 0);

    IF is_serialized_product THEN
      -- unit_cost continua na propria unidade.
      UPDATE public.product_serial_units
      SET status = 'DISPONIVEL', sale_id = NULL
      WHERE tenant_id = active_tenant_id AND sale_id = p_sale_id
        AND product_id = item_product_id AND unit_id = sale_row.unit_id AND status = 'VENDIDO';
      GET DIAGNOSTICS updated_units = ROW_COUNT;
      IF updated_units <> item_quantity THEN
        RAISE EXCEPTION 'Could not return every serialized unit of product %', item_product_id;
      END IF;
    ELSE
      SELECT * INTO inv_row
      FROM public.inventory
      WHERE tenant_id = active_tenant_id AND product_id = item_product_id
      FOR UPDATE;
      IF NOT FOUND THEN
        INSERT INTO public.inventory (tenant_id, product_id, quantities, updated_at)
        VALUES (active_tenant_id, item_product_id, '{}'::JSONB, NOW());
        SELECT * INTO inv_row
        FROM public.inventory
        WHERE tenant_id = active_tenant_id AND product_id = item_product_id
        FOR UPDATE;
      END IF;

      inv_row.quantities := public.inventory_with_unit(inv_row.quantities, sale_row.unit_id);
      current_qty := COALESCE((inv_row.quantities -> sale_row.unit_id ->> 'qty')::INTEGER, 0);
      return_unit_cost := COALESCE(
        return_unit_cost,
        public.get_store_avg_cost(active_tenant_id, item_product_id, sale_row.unit_id)
      );
      PERFORM public.apply_store_cost_entry(
        active_tenant_id, item_product_id, sale_row.unit_id, current_qty, item_quantity, return_unit_cost
      );

      UPDATE public.inventory
      SET quantities = jsonb_set(inv_row.quantities, ARRAY[sale_row.unit_id, 'qty'], to_jsonb(current_qty + item_quantity), true),
          updated_at = NOW()
      WHERE tenant_id = active_tenant_id AND product_id = item_product_id;
    END IF;

    INSERT INTO public.movements (
      id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
      serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost
    ) VALUES (
      gen_random_uuid()::TEXT, active_tenant_id, item_product_id, item->>'variationId',
      'CLIENTE', sale_row.unit_id, 'SAIDA', item_quantity, item->'serials', item->>'cardCondition',
      auth.uid()::TEXT, sale_row.operator_name, NOW(), 'Cancelamento de venda', ROUND(return_unit_cost, 4)
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.process_sale_cancellation(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_sale_cancellation(TEXT, TEXT) TO authenticated;

-- ---- 9. Venda do PDV: custo congelado em cada item ------------------------
-- Copia integral da versao 20261008 (conferida contra o banco ativo) com tres
-- acrescimos: calculo do custo por item, unitCost/costTotal no item e
-- unit_cost na movimentacao. Mesma assinatura, mesmos defaults e mesmo retorno.

CREATE OR REPLACE FUNCTION public.process_pos_terminal_sale(
  p_sale_id TEXT,
  p_invoice_number TEXT,
  p_items JSONB,
  p_payment_method TEXT,
  p_gross_amount NUMERIC,
  p_fee_amount NUMERIC,
  p_net_amount NUMERIC,
  p_client_cpf TEXT,
  p_client_name TEXT,
  p_timestamp TIMESTAMPTZ,
  p_status TEXT,
  p_requires_approval BOOLEAN,
  p_reservation_id UUID DEFAULT NULL,
  p_payments JSONB DEFAULT NULL,
  p_admin_password TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_cash public.cash_register_sessions%ROWTYPE;
  v_config public.store_configs%ROWTYPE;
  v_reservation public.product_reservations%ROWTYPE;
  v_reservation_item public.product_reservation_items%ROWTYPE;
  item JSONB;
  payment JSONB;
  item_type TEXT;
  item_product_id TEXT;
  item_service_id TEXT;
  item_quantity INTEGER;
  current_qty INTEGER;
  reserved_qty INTEGER;
  item_discount NUMERIC;
  item_price NUMERIC;
  item_sku TEXT;
  item_name TEXT;
  item_default_cost NUMERIC;
  item_cost_total NUMERIC;
  item_unit_cost NUMERIC;
  line_total NUMERIC;
  calculated_gross NUMERIC := 0;
  normalized_items JSONB := '[]'::JSONB;
  item_serials JSONB;
  is_serialized_product BOOLEAN;
  inv_row public.inventory%ROWTYPE;
  updated_units INTEGER;
  submitted_item_count INTEGER;
  distinct_reservation_items INTEGER;
  v_max_discount NUMERIC(5, 2);
  v_has_over_limit BOOLEAN := FALSE;
  v_password_check JSONB;
  v_payment_method TEXT;
  v_payment_total NUMERIC := 0;
  v_expected_payment_total NUMERIC;
  v_payment_count INTEGER := 0;
  v_payment_method_input TEXT;
  v_payment_amount_input NUMERIC;
  v_installments_input INTEGER;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals
  WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active terminal session required'; END IF;

  SELECT * INTO v_cash FROM public.cash_register_sessions
  WHERE terminal_id = v_terminal.id AND status = 'ABERTO' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Open cash register required before selling'; END IF;

  SELECT * INTO v_config FROM public.store_configs
  WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Store configuration not found'; END IF;
  v_max_discount := COALESCE(v_config.max_item_discount_percent, 0);

  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Sale items must be a JSON array';
  END IF;
  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Sale must contain at least one item';
  END IF;

  -- ---- Validacao das linhas de pagamento (se informadas) ----
  IF p_payments IS NOT NULL THEN
    IF jsonb_typeof(p_payments) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Sale payments must be a JSON array';
    END IF;
    v_payment_count := jsonb_array_length(p_payments);
    IF v_payment_count = 0 THEN
      RAISE EXCEPTION 'Sale payments array cannot be empty';
    END IF;
    FOR payment IN SELECT entries.value FROM jsonb_array_elements(p_payments) AS entries(value) LOOP
      v_payment_method_input := UPPER(COALESCE(payment->>'paymentMethod', ''));
      v_payment_amount_input := NULLIF(payment->>'amount', '')::NUMERIC;
      v_installments_input := COALESCE(NULLIF(payment->>'installments', '')::INTEGER, 1);
      IF v_payment_method_input NOT IN ('DINHEIRO', 'PIX', 'CREDITO', 'DEBITO', 'VOUCHER', 'CREDIARIO') THEN
        RAISE EXCEPTION 'Invalid payment method: %', v_payment_method_input;
      END IF;
      IF v_payment_amount_input IS NULL OR v_payment_amount_input <= 0 THEN
        RAISE EXCEPTION 'Payment amount must be greater than zero';
      END IF;
      IF v_payment_amount_input <> ROUND(v_payment_amount_input, 2) THEN
        RAISE EXCEPTION 'Payment amount must have at most two decimal places';
      END IF;
      IF v_installments_input < 1 THEN
        RAISE EXCEPTION 'Installments must be at least one';
      END IF;
      v_payment_total := v_payment_total + v_payment_amount_input;
    END LOOP;
  ELSIF UPPER(COALESCE(p_payment_method, '')) = 'DIVIDIDO' THEN
    RAISE EXCEPTION 'Split payment requires payment lines';
  END IF;

  -- ---- Aprovacao de desconto (antes de qualquer escrita da venda) ----
  -- O servidor decide sozinho se ha item acima do limite. Em conversao de
  -- reserva o desconto vem congelado e nunca exige senha.
  IF p_reservation_id IS NULL THEN
    FOR item IN SELECT entries.value FROM jsonb_array_elements(p_items) AS entries(value) LOOP
      item_discount := COALESCE(NULLIF(item->>'discountPercent', '')::NUMERIC, 0);
      IF item_discount > v_max_discount THEN
        v_has_over_limit := TRUE;
      END IF;
    END LOOP;
  END IF;

  IF v_has_over_limit THEN
    IF p_admin_password IS NULL OR p_admin_password = '' THEN
      RAISE EXCEPTION 'Administrative password required to approve discounts above the store limit';
    END IF;
    v_password_check := public.check_pos_admin_password(v_terminal.id, p_admin_password, 'DISCOUNT_APPROVAL');
    IF v_password_check->>'status' = 'LOCKED' THEN
      RETURN jsonb_build_object('status', 'LOCKED', 'lockedUntil', v_password_check->'lockedUntil');
    END IF;
    IF v_password_check->>'status' <> 'OK' THEN
      -- Retorna sem excecao: a tentativa errada fica registrada e nada da
      -- venda foi gravado ate aqui.
      RETURN jsonb_build_object(
        'status', 'INVALID_PASSWORD',
        'remainingAttempts', v_password_check->'remainingAttempts'
      );
    END IF;
  END IF;

  IF p_reservation_id IS NOT NULL THEN
    SELECT * INTO v_reservation
    FROM public.product_reservations
    WHERE id = p_reservation_id AND tenant_id = v_terminal.tenant_id
      AND unit_id = v_terminal.unit_id AND status = 'ATIVA'
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active reservation not found for this terminal store'; END IF;

    SELECT COUNT(*), COUNT(DISTINCT entries.value->>'reservationItemId')
    INTO submitted_item_count, distinct_reservation_items
    FROM jsonb_array_elements(p_items) AS entries(value);
    IF submitted_item_count <> distinct_reservation_items THEN
      RAISE EXCEPTION 'Reservation contains duplicate sale lines';
    END IF;
    IF submitted_item_count <> (
      SELECT COUNT(*) FROM public.product_reservation_items
      WHERE tenant_id = v_terminal.tenant_id AND reservation_id = p_reservation_id
    ) THEN
      RAISE EXCEPTION 'Sale lines do not match the reservation';
    END IF;
  END IF;

  INSERT INTO public.sales (
    id, tenant_id, cash_session_id, invoice_number, unit_id, items, payment_method, gross_amount, fee_amount,
    net_amount, operator_id, operator_name, client_cpf, client_name, timestamp, status, requires_approval,
    reservation_deposit_applied
  ) VALUES (
    p_sale_id, v_terminal.tenant_id, v_cash.id, p_invoice_number, v_terminal.unit_id, p_items, p_payment_method,
    p_gross_amount, p_fee_amount, p_net_amount, v_terminal.id::TEXT, v_terminal.display_name,
    p_client_cpf, p_client_name, p_timestamp, p_status, p_requires_approval, 0
  );

  FOR item IN SELECT entries.value FROM jsonb_array_elements(p_items) AS entries(value) LOOP
    item_type := UPPER(COALESCE(item->>'itemType', 'PRODUCT'));
    item_quantity := (item->>'quantity')::INTEGER;
    item_discount := COALESCE(NULLIF(item->>'discountPercent', '')::NUMERIC, 0);
    IF item_quantity IS NULL OR item_quantity <= 0 THEN RAISE EXCEPTION 'Item quantity must be greater than zero'; END IF;
    IF item_discount < 0 THEN RAISE EXCEPTION 'Discount cannot be negative'; END IF;
    IF item_discount > 100 THEN RAISE EXCEPTION 'Discount cannot exceed 100 percent'; END IF;

    IF item_type = 'SERVICE' THEN
      IF p_reservation_id IS NOT NULL THEN RAISE EXCEPTION 'Services cannot be included in product reservations'; END IF;
      item_product_id := NULL;
      item_service_id := item->>'serviceId';
      SELECT service.sell_price, service.sku, service.name INTO item_price, item_sku, item_name
      FROM public.services AS service
      WHERE service.tenant_id = v_terminal.tenant_id AND service.id = item_service_id AND service.is_active;
      IF NOT FOUND THEN RAISE EXCEPTION 'Service % not found or inactive', item_service_id; END IF;
      item_serials := NULL;
      -- Servico nao tem mercadoria: custo zero.
      item_cost_total := 0;
    ELSIF item_type = 'PRODUCT' THEN
      item_service_id := NULL;
      item_product_id := item->>'productId';
      SELECT product.sell_price, COALESCE(product.is_serialized, false), product.sku, product.name,
             GREATEST(COALESCE(product.cost_price, 0), 0)
      INTO item_price, is_serialized_product, item_sku, item_name, item_default_cost
      FROM public.products AS product
      WHERE product.tenant_id = v_terminal.tenant_id AND product.id = item_product_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Product % not found', item_product_id; END IF;
      item_serials := item->'serials';

      IF p_reservation_id IS NOT NULL THEN
        SELECT * INTO v_reservation_item
        FROM public.product_reservation_items
        WHERE id = (item->>'reservationItemId')::UUID
          AND tenant_id = v_terminal.tenant_id AND reservation_id = p_reservation_id
          AND product_id = item_product_id AND quantity = item_quantity
        FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Sale item does not match the reservation'; END IF;
        IF item_discount <> v_reservation_item.discount_percent THEN RAISE EXCEPTION 'Reservation discount has changed'; END IF;
        item_price := v_reservation_item.unit_price;
        item_discount := v_reservation_item.discount_percent;
        item_sku := v_reservation_item.item_sku;
        item_name := v_reservation_item.item_name;

        IF is_serialized_product THEN
          IF v_reservation_item.serial_unit_id IS NULL OR item_quantity <> 1 THEN
            RAISE EXCEPTION 'Serialized reservation line is invalid';
          END IF;
          UPDATE public.product_serial_units
          SET status = 'VENDIDO', sale_id = p_sale_id
          WHERE id = v_reservation_item.serial_unit_id
            AND tenant_id = v_terminal.tenant_id AND product_id = item_product_id
            AND unit_id = v_terminal.unit_id AND status = 'RESERVADO';
          GET DIAGNOSTICS updated_units = ROW_COUNT;
          IF updated_units <> 1 THEN RAISE EXCEPTION 'Reserved serialized unit is no longer available'; END IF;
          item_serials := jsonb_build_array(v_reservation_item.serial_number);
          SELECT COALESCE(unit.unit_cost, item_default_cost) INTO item_cost_total
          FROM public.product_serial_units AS unit
          WHERE unit.id = v_reservation_item.serial_unit_id AND unit.tenant_id = v_terminal.tenant_id;
        ELSE
          IF v_reservation_item.serial_unit_id IS NOT NULL THEN RAISE EXCEPTION 'Non-serialized reservation line contains a serial'; END IF;
        END IF;
      ELSIF is_serialized_product THEN
        PERFORM public.mark_serial_units_sold(
          v_terminal.tenant_id, item_product_id, v_terminal.unit_id, p_sale_id, item_serials, item_quantity
        );
        SELECT COALESCE(SUM(COALESCE(unit.unit_cost, item_default_cost)), 0) INTO item_cost_total
        FROM public.product_serial_units AS unit
        WHERE unit.tenant_id = v_terminal.tenant_id AND unit.product_id = item_product_id
          AND unit.sale_id = p_sale_id AND unit.status = 'VENDIDO'
          AND LOWER(unit.serial_number) IN (
            SELECT LOWER(BTRIM(value)) FROM jsonb_array_elements_text(item_serials) AS value
          );
      END IF;

      IF NOT is_serialized_product THEN
        IF jsonb_typeof(item_serials) = 'array' AND jsonb_array_length(item_serials) > 0 THEN
          RAISE EXCEPTION 'Non-serialized products cannot include serial units';
        END IF;
        SELECT * INTO inv_row FROM public.inventory
        WHERE tenant_id = v_terminal.tenant_id AND product_id = item_product_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Product % was not found in inventory', item_product_id; END IF;
        current_qty := COALESCE((inv_row.quantities -> v_terminal.unit_id ->> 'qty')::INTEGER, 0);
        IF p_reservation_id IS NULL THEN
          SELECT COALESCE(SUM(reservation_item.quantity), 0)::INTEGER INTO reserved_qty
          FROM public.product_reservation_items AS reservation_item
          JOIN public.product_reservations AS reservation
            ON reservation.tenant_id = reservation_item.tenant_id AND reservation.id = reservation_item.reservation_id
          WHERE reservation_item.tenant_id = v_terminal.tenant_id AND reservation_item.product_id = item_product_id
            AND reservation.unit_id = v_terminal.unit_id AND reservation.status = 'ATIVA'
            AND reservation_item.serial_unit_id IS NULL;
          IF current_qty - reserved_qty < item_quantity THEN
            RAISE EXCEPTION 'Insufficient unreserved stock for product % in store %', item_product_id, v_terminal.unit_id;
          END IF;
        ELSIF current_qty < item_quantity THEN
          RAISE EXCEPTION 'Insufficient physical stock for reserved product %', item_product_id;
        END IF;
        -- Custo medio da loja no momento da venda (inventario ja travado acima).
        item_cost_total := public.get_store_avg_cost(v_terminal.tenant_id, item_product_id, v_terminal.unit_id) * item_quantity;
        UPDATE public.inventory
        SET quantities = jsonb_set(inv_row.quantities, ARRAY[v_terminal.unit_id, 'qty'], to_jsonb(current_qty - item_quantity), true), updated_at = NOW()
        WHERE tenant_id = v_terminal.tenant_id AND product_id = item_product_id;
      END IF;

      INSERT INTO public.movements (
        id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
        serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost
      ) VALUES (
        gen_random_uuid()::TEXT, v_terminal.tenant_id, item_product_id, item->>'variationId',
        v_terminal.unit_id, 'CLIENTE', 'SAIDA', item_quantity, item_serials, item->>'cardCondition',
        v_terminal.id::TEXT, v_terminal.display_name, p_timestamp,
        CASE WHEN p_reservation_id IS NULL THEN 'Venda registrada no PDV' ELSE 'Reserva convertida em venda' END,
        ROUND(item_cost_total / item_quantity, 4)
      );
    ELSE
      RAISE EXCEPTION 'Unsupported sale item type: %', item_type;
    END IF;

    -- Auditoria da liberacao (senha ja validada acima).
    IF p_reservation_id IS NULL AND item_discount > v_max_discount THEN
      INSERT INTO public.sale_discount_approvals (
        tenant_id, unit_id, terminal_id, cash_session_id, sale_id, item_type,
        product_id, service_id, item_sku, item_name, discount_percent, store_limit_percent
      ) VALUES (
        v_terminal.tenant_id, v_terminal.unit_id, v_terminal.id, v_cash.id, p_sale_id, item_type,
        item_product_id, item_service_id, item_sku, item_name, item_discount, v_max_discount
      );
    END IF;

    item_cost_total := ROUND(item_cost_total, 2);
    item_unit_cost := ROUND(item_cost_total / item_quantity, 4);
    line_total := ROUND(item_price * item_quantity * (100 - item_discount) / 100, 2);
    calculated_gross := calculated_gross + line_total;
    normalized_items := normalized_items || jsonb_build_array(
      item || jsonb_build_object(
        'itemType', item_type, 'unitPrice', item_price, 'itemSku', item_sku,
        'itemName', item_name, 'discountPercent', item_discount,
        'lineTotal', line_total, 'serials', item_serials,
        'unitCost', item_unit_cost, 'costTotal', item_cost_total
      )
    );
  END LOOP;

  IF ABS(COALESCE(p_gross_amount, 0) - calculated_gross) > 0.01 THEN
    RAISE EXCEPTION 'Sale total does not match item prices and discounts';
  END IF;
  IF COALESCE(p_fee_amount, 0) < 0 OR ABS(COALESCE(p_net_amount, 0) - (p_gross_amount - p_fee_amount)) > 0.01 THEN
    RAISE EXCEPTION 'Invalid sale net amount or fee';
  END IF;
  IF p_reservation_id IS NOT NULL AND v_reservation.deposit_amount > calculated_gross THEN
    RAISE EXCEPTION 'Reservation deposit exceeds the sale total';
  END IF;

  -- ---- Pagamento dividido: soma exata ao centavo ----
  -- Base: total calculado pelo servidor. Em conversao de reserva, o saldo
  -- apos o sinal (o sinal ja entrou no caixa como pos_reservation_payments).
  IF p_payments IS NOT NULL THEN
    v_expected_payment_total := calculated_gross;
    IF p_reservation_id IS NOT NULL THEN
      v_expected_payment_total := calculated_gross - v_reservation.deposit_amount;
    END IF;
    IF v_payment_total <> v_expected_payment_total THEN
      RAISE EXCEPTION 'Payment lines do not match the sale total';
    END IF;

    IF v_payment_count = 1 THEN
      v_payment_method := UPPER(p_payments->0->>'paymentMethod');
    ELSE
      v_payment_method := 'DIVIDIDO';
    END IF;
    FOR payment IN SELECT entries.value FROM jsonb_array_elements(p_payments) AS entries(value) LOOP
      INSERT INTO public.sale_payments (
        tenant_id, unit_id, terminal_id, cash_session_id, sale_id,
        payment_method, amount, installments, created_by_name
      ) VALUES (
        v_terminal.tenant_id, v_terminal.unit_id, v_terminal.id, v_cash.id, p_sale_id,
        UPPER(payment->>'paymentMethod'),
        (payment->>'amount')::NUMERIC,
        COALESCE(NULLIF(payment->>'installments', '')::INTEGER, 1),
        v_terminal.display_name
      );
    END LOOP;
  ELSE
    -- Legado: nenhuma lista de pagamentos -> mantem o metodo recebido.
    v_payment_method := p_payment_method;
  END IF;

  UPDATE public.sales
  SET items = normalized_items,
      payment_method = v_payment_method,
      reservation_deposit_applied = CASE WHEN p_reservation_id IS NULL THEN 0 ELSE v_reservation.deposit_amount END
  WHERE tenant_id = v_terminal.tenant_id AND id = p_sale_id;

  IF p_reservation_id IS NOT NULL THEN
    UPDATE public.product_reservations
    SET status = 'CONVERTIDA', sale_id = p_sale_id, updated_at = NOW()
    WHERE id = p_reservation_id AND tenant_id = v_terminal.tenant_id AND status = 'ATIVA';
  END IF;

  RETURN jsonb_build_object('status', 'OK');
END;
$$;

REVOKE ALL ON FUNCTION public.process_pos_terminal_sale(
  TEXT, TEXT, JSONB, TEXT, NUMERIC, NUMERIC, NUMERIC,
  TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, UUID, JSONB, TEXT
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_pos_terminal_sale(
  TEXT, TEXT, JSONB, TEXT, NUMERIC, NUMERIC, NUMERIC,
  TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, UUID, JSONB, TEXT
) TO authenticated;

-- ---- 10. Leitura do custo por loja para o ERP -----------------------------
-- Sem serial: media da tabela. Com serial: media das unidades em estoque
-- (disponiveis ou reservadas). Somente lojas que o usuario pode acessar.

CREATE OR REPLACE FUNCTION public.list_product_store_costs()
RETURNS TABLE (product_id TEXT, unit_id TEXT, avg_cost NUMERIC, unit_count INTEGER)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT cost.product_id, cost.unit_id, cost.avg_cost, NULL::INTEGER
  FROM public.product_store_costs AS cost
  JOIN public.products AS product
    ON product.tenant_id = cost.tenant_id AND product.id = cost.product_id
  WHERE cost.tenant_id = public.current_user_tenant_id()
    AND NOT COALESCE(product.is_serialized, false)
    AND public.current_user_has_store_access(cost.tenant_id, cost.unit_id)
  UNION ALL
  SELECT unit.product_id, unit.unit_id,
         ROUND(AVG(COALESCE(unit.unit_cost, GREATEST(COALESCE(product.cost_price, 0), 0))), 4),
         COUNT(*)::INTEGER
  FROM public.product_serial_units AS unit
  JOIN public.products AS product
    ON product.tenant_id = unit.tenant_id AND product.id = unit.product_id
  WHERE unit.tenant_id = public.current_user_tenant_id()
    AND unit.status IN ('DISPONIVEL', 'RESERVADO')
    AND public.current_user_has_store_access(unit.tenant_id, unit.unit_id)
  GROUP BY unit.product_id, unit.unit_id;
$$;

REVOKE ALL ON FUNCTION public.list_product_store_costs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_product_store_costs() TO authenticated;
