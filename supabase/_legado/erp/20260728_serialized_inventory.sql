BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS sales_tenant_id_id_serial_units_idx
  ON public.sales (tenant_id, id);

CREATE TABLE IF NOT EXISTS public.product_serial_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  serial_number TEXT NOT NULL,
  imei TEXT,
  status TEXT NOT NULL DEFAULT 'DISPONIVEL',
  warranty_months INTEGER NOT NULL,
  sale_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT product_serial_units_product_fk
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES public.products(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT product_serial_units_store_fk
    FOREIGN KEY (tenant_id, unit_id)
    REFERENCES public.store_configs(tenant_id, unit_id) ON DELETE RESTRICT,
  CONSTRAINT product_serial_units_sale_fk
    FOREIGN KEY (tenant_id, sale_id)
    REFERENCES public.sales(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT product_serial_units_serial_not_blank
    CHECK (NULLIF(BTRIM(serial_number), '') IS NOT NULL),
  CONSTRAINT product_serial_units_imei_not_blank
    CHECK (imei IS NULL OR NULLIF(BTRIM(imei), '') IS NOT NULL),
  CONSTRAINT product_serial_units_warranty_non_negative
    CHECK (warranty_months >= 0),
  CONSTRAINT product_serial_units_status_check
    CHECK (status IN ('DISPONIVEL', 'VENDIDO', 'RESERVADO', 'PERDIDO')),
  CONSTRAINT product_serial_units_sale_status_check
    CHECK ((status = 'VENDIDO') = (sale_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS product_serial_units_tenant_serial_key
  ON public.product_serial_units (tenant_id, LOWER(serial_number));
CREATE UNIQUE INDEX IF NOT EXISTS product_serial_units_tenant_imei_key
  ON public.product_serial_units (tenant_id, LOWER(imei))
  WHERE imei IS NOT NULL;
CREATE INDEX IF NOT EXISTS product_serial_units_available_lookup_idx
  ON public.product_serial_units (tenant_id, product_id, unit_id)
  WHERE status = 'DISPONIVEL';
CREATE INDEX IF NOT EXISTS product_serial_units_sale_idx
  ON public.product_serial_units (tenant_id, sale_id)
  WHERE sale_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.inventory AS inventory
    JOIN public.products AS product
      ON product.tenant_id = inventory.tenant_id
      AND product.id = inventory.product_id
    CROSS JOIN LATERAL jsonb_each(inventory.quantities) AS unit_stock(unit_id, stock)
    WHERE product.is_serialized = true
      AND COALESCE((unit_stock.stock->>'qty')::INTEGER, 0) > 0
  ) THEN
    RAISE EXCEPTION
      'Há saldo legado de produto serializado. Concilie e cadastre os seriais reais antes de aplicar esta migration; seriais sintéticos não serão migrados.';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_product_serial_unit_fields()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.serial_number := BTRIM(NEW.serial_number);
  NEW.imei := NULLIF(BTRIM(NEW.imei), '');
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_product_serial_unit_fields ON public.product_serial_units;
CREATE TRIGGER set_product_serial_unit_fields
  BEFORE INSERT OR UPDATE ON public.product_serial_units
  FOR EACH ROW EXECUTE FUNCTION public.set_product_serial_unit_fields();

DROP TRIGGER IF EXISTS enforce_current_tenant_trigger ON public.product_serial_units;
CREATE TRIGGER enforce_current_tenant_trigger
  BEFORE INSERT OR UPDATE ON public.product_serial_units
  FOR EACH ROW EXECUTE FUNCTION public.enforce_current_tenant();

CREATE OR REPLACE FUNCTION public.sync_serialized_inventory_quantity(
  p_tenant_id UUID,
  p_product_id TEXT,
  p_unit_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  available_quantity INTEGER;
  available_serials JSONB;
BEGIN
  SELECT
    COUNT(*)::INTEGER,
    COALESCE(jsonb_agg(serial_number ORDER BY serial_number), '[]'::jsonb)
  INTO available_quantity, available_serials
  FROM public.product_serial_units
  WHERE tenant_id = p_tenant_id
    AND product_id = p_product_id
    AND unit_id = p_unit_id
    AND status = 'DISPONIVEL';

  INSERT INTO public.inventory (tenant_id, product_id, quantities, updated_at)
  VALUES (
    p_tenant_id,
    p_product_id,
    jsonb_build_object(
      p_unit_id,
      jsonb_build_object('unitId', p_unit_id, 'qty', available_quantity, 'serials', available_serials, 'cardConditions', '{}'::jsonb)
    ),
    NOW()
  )
  ON CONFLICT (tenant_id, product_id) DO UPDATE
  SET
    quantities = jsonb_set(
      jsonb_set(
        jsonb_set(COALESCE(public.inventory.quantities, '{}'::jsonb), ARRAY[p_unit_id, 'unitId'], to_jsonb(p_unit_id), true),
        ARRAY[p_unit_id, 'qty'], to_jsonb(available_quantity), true
      ),
      ARRAY[p_unit_id, 'serials'], available_serials, true
    ),
    updated_at = NOW();
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_serialized_inventory_after_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM public.sync_serialized_inventory_quantity(OLD.tenant_id, OLD.product_id, OLD.unit_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM public.sync_serialized_inventory_quantity(NEW.tenant_id, NEW.product_id, NEW.unit_id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS sync_serialized_inventory_after_change ON public.product_serial_units;
CREATE TRIGGER sync_serialized_inventory_after_change
  AFTER INSERT OR UPDATE OR DELETE ON public.product_serial_units
  FOR EACH ROW EXECUTE FUNCTION public.sync_serialized_inventory_after_change();

ALTER TABLE public.product_serial_units ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_serial_units_read ON public.product_serial_units;
CREATE POLICY product_serial_units_read ON public.product_serial_units
  FOR SELECT
  USING (public.current_user_has_store_access(tenant_id, unit_id));

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
  unit_count INTEGER;
  serial_count INTEGER;
BEGIN
  IF active_tenant_id IS NULL OR NOT public.current_user_has_store_access(active_tenant_id, p_unit_id) THEN
    RAISE EXCEPTION 'Acesso negado à loja';
  END IF;
  IF jsonb_typeof(p_units) <> 'array' OR jsonb_array_length(p_units) = 0 THEN
    RAISE EXCEPTION 'Informe ao menos uma unidade serializada';
  END IF;

  SELECT warranty_months INTO warranty
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

  INSERT INTO public.product_serial_units (tenant_id, product_id, unit_id, serial_number, imei, status, warranty_months)
  SELECT
    active_tenant_id,
    p_product_id,
    p_unit_id,
    BTRIM(unit_item->>'serialNumber'),
    NULLIF(BTRIM(unit_item->>'imei'), ''),
    'DISPONIVEL',
    COALESCE(warranty, 0)
  FROM jsonb_array_elements(p_units) AS unit_item;

  INSERT INTO public.movements (
    id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
    serials, card_condition, operator_id, operator_name, timestamp, reason
  )
  VALUES (
    gen_random_uuid()::TEXT, active_tenant_id, p_product_id, NULL, 'FORNECEDOR', p_unit_id, 'ENTRADA', unit_count,
    (SELECT jsonb_agg(BTRIM(unit_item->>'serialNumber')) FROM jsonb_array_elements(p_units) AS unit_item),
    NULL, auth.uid()::TEXT, COALESCE((SELECT display_name FROM public.app_users WHERE auth_uid = auth.uid()), ''), NOW(),
    COALESCE(NULLIF(BTRIM(p_reason), ''), 'Entrada de estoque serializado')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.pdv_list_available_serial_units(
  p_product_id TEXT,
  p_unit_id TEXT
)
RETURNS TABLE (
  id UUID,
  serial_number TEXT,
  imei TEXT,
  warranty_months INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  active_tenant_id UUID := public.current_user_tenant_id();
BEGIN
  IF active_tenant_id IS NULL OR NOT public.current_user_has_store_access(active_tenant_id, p_unit_id) THEN
    RAISE EXCEPTION 'Acesso negado à loja';
  END IF;

  RETURN QUERY
  SELECT serial_unit.id, serial_unit.serial_number, serial_unit.imei, serial_unit.warranty_months
  FROM public.product_serial_units AS serial_unit
  WHERE serial_unit.tenant_id = active_tenant_id
    AND serial_unit.product_id = p_product_id
    AND serial_unit.unit_id = p_unit_id
    AND serial_unit.status = 'DISPONIVEL'
  ORDER BY serial_unit.serial_number;
END;
$$;

CREATE OR REPLACE FUNCTION public.process_inventory_movement(
  p_product_id TEXT, p_from_unit_id TEXT, p_to_unit_id TEXT, p_type TEXT,
  p_quantity INTEGER, p_serials JSONB, p_card_condition TEXT, p_operator_id TEXT,
  p_operator_name TEXT, p_timestamp TIMESTAMPTZ, p_reason TEXT
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
  serial_count INTEGER;
  updated_units INTEGER;
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

  SELECT is_serialized INTO is_serialized_product
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
    ELSIF p_to_unit_id = 'PERDA' THEN
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
    INSERT INTO public.movements (id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity, serials, card_condition, operator_id, operator_name, timestamp, reason)
    VALUES (gen_random_uuid()::TEXT, active_tenant_id, p_product_id, NULL, p_from_unit_id, p_to_unit_id, p_type, p_quantity, p_serials, p_card_condition, auth.uid()::TEXT, p_operator_name, p_timestamp, p_reason);
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
  IF p_from_unit_id <> 'FORNECEDOR' THEN
    current_qty := COALESCE((inv_row.quantities -> p_from_unit_id ->> 'qty')::INTEGER, 0);
    IF current_qty < p_quantity THEN RAISE EXCEPTION 'Estoque insuficiente na origem %', p_from_unit_id; END IF;
    inv_row.quantities := jsonb_set(inv_row.quantities, ARRAY[p_from_unit_id, 'qty'], to_jsonb(current_qty - p_quantity), true);
  END IF;
  IF p_to_unit_id NOT IN ('CLIENTE', 'PERDA') THEN
    current_qty := COALESCE((inv_row.quantities -> p_to_unit_id ->> 'qty')::INTEGER, 0);
    inv_row.quantities := jsonb_set(inv_row.quantities, ARRAY[p_to_unit_id, 'qty'], to_jsonb(current_qty + p_quantity), true);
  END IF;
  UPDATE public.inventory SET quantities = inv_row.quantities, updated_at = NOW()
  WHERE tenant_id = active_tenant_id AND product_id = p_product_id;
  INSERT INTO public.movements (id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity, serials, card_condition, operator_id, operator_name, timestamp, reason)
  VALUES (gen_random_uuid()::TEXT, active_tenant_id, p_product_id, NULL, p_from_unit_id, p_to_unit_id, p_type, p_quantity, p_serials, p_card_condition, auth.uid()::TEXT, p_operator_name, p_timestamp, p_reason);
END;
$$;

CREATE OR REPLACE FUNCTION public.process_sale_transaction(
  p_sale_id TEXT, p_invoice_number TEXT, p_unit_id TEXT, p_items JSONB, p_payment_method TEXT,
  p_gross_amount NUMERIC, p_fee_amount NUMERIC, p_net_amount NUMERIC, p_operator_id TEXT,
  p_operator_name TEXT, p_client_cpf TEXT, p_client_name TEXT, p_timestamp TIMESTAMPTZ,
  p_status TEXT, p_requires_approval BOOLEAN
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
  serial_count INTEGER;
  updated_units INTEGER;
BEGIN
  IF active_tenant_id IS NULL OR NOT public.current_user_has_store_access(active_tenant_id, p_unit_id) THEN RAISE EXCEPTION 'Acesso negado à loja'; END IF;
  INSERT INTO public.sales (id, tenant_id, invoice_number, unit_id, items, payment_method, gross_amount, fee_amount, net_amount, operator_id, operator_name, client_cpf, client_name, timestamp, status, requires_approval)
  VALUES (p_sale_id, active_tenant_id, p_invoice_number, p_unit_id, p_items, p_payment_method, p_gross_amount, p_fee_amount, p_net_amount, auth.uid()::TEXT, p_operator_name, p_client_cpf, p_client_name, p_timestamp, p_status, p_requires_approval);
  FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    item_product_id := item->>'productId'; item_quantity := (item->>'quantity')::INTEGER;
    SELECT is_serialized INTO is_serialized_product FROM public.products WHERE tenant_id = active_tenant_id AND id = item_product_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Produto % não encontrado', item_product_id; END IF;
    IF is_serialized_product THEN
      IF jsonb_typeof(item->'serials') <> 'array' THEN RAISE EXCEPTION 'Selecione os seriais do produto %', item_product_id; END IF;
      SELECT COUNT(*), COUNT(DISTINCT LOWER(BTRIM(value))) INTO serial_count, updated_units FROM jsonb_array_elements_text(item->'serials') AS value;
      IF serial_count <> item_quantity OR serial_count <> updated_units OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(item->'serials') AS value WHERE NULLIF(BTRIM(value), '') IS NULL) THEN
        RAISE EXCEPTION 'A venda do produto % exige % seriais únicos', item_product_id, item_quantity;
      END IF;
      UPDATE public.product_serial_units
      SET status = 'VENDIDO', sale_id = p_sale_id
      WHERE tenant_id = active_tenant_id AND product_id = item_product_id AND unit_id = p_unit_id AND status = 'DISPONIVEL'
        AND LOWER(serial_number) IN (SELECT LOWER(BTRIM(value)) FROM jsonb_array_elements_text(item->'serials') AS value);
      GET DIAGNOSTICS updated_units = ROW_COUNT;
      IF updated_units <> item_quantity THEN RAISE EXCEPTION 'Uma ou mais unidades do produto % não estão disponíveis', item_product_id; END IF;
    ELSE
      SELECT * INTO inv_row FROM public.inventory WHERE tenant_id = active_tenant_id AND product_id = item_product_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Produto % não encontrado no inventário', item_product_id; END IF;
      current_qty := COALESCE((inv_row.quantities -> p_unit_id ->> 'qty')::INTEGER, 0);
      IF current_qty < item_quantity THEN RAISE EXCEPTION 'Estoque insuficiente para o produto % na loja %', item_product_id, p_unit_id; END IF;
      UPDATE public.inventory SET quantities = jsonb_set(inv_row.quantities, ARRAY[p_unit_id, 'qty'], to_jsonb(current_qty - item_quantity), true), updated_at = NOW()
      WHERE tenant_id = active_tenant_id AND product_id = item_product_id;
    END IF;
    INSERT INTO public.movements (id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity, serials, card_condition, operator_id, operator_name, timestamp, reason)
    VALUES (gen_random_uuid()::TEXT, active_tenant_id, item_product_id, item->>'variationId', p_unit_id, 'CLIENTE', 'SAIDA', item_quantity, item->'serials', item->>'cardCondition', auth.uid()::TEXT, p_operator_name, p_timestamp, 'Venda registrada');
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.process_sale_cancellation(p_sale_id TEXT, p_approved_by TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  active_tenant_id UUID := public.current_user_tenant_id();
  sale_row public.sales%ROWTYPE; item JSONB; item_product_id TEXT; item_quantity INTEGER;
  is_serialized_product BOOLEAN;
  updated_units INTEGER;
BEGIN
  SELECT * INTO sale_row FROM public.sales WHERE tenant_id = active_tenant_id AND id = p_sale_id FOR UPDATE;
  IF NOT FOUND OR NOT public.current_user_has_store_access(active_tenant_id, sale_row.unit_id) THEN RAISE EXCEPTION 'Venda não encontrada ou acesso negado'; END IF;
  UPDATE public.sales SET status = 'CANCELADA', approved_by = p_approved_by WHERE tenant_id = active_tenant_id AND id = p_sale_id;
  FOR item IN SELECT * FROM jsonb_array_elements(sale_row.items) LOOP
    item_product_id := item->>'productId'; item_quantity := (item->>'quantity')::INTEGER;
    SELECT is_serialized INTO is_serialized_product FROM public.products WHERE tenant_id = active_tenant_id AND id = item_product_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Produto % não encontrado', item_product_id; END IF;
    IF is_serialized_product THEN
      UPDATE public.product_serial_units
      SET status = 'DISPONIVEL', sale_id = NULL
      WHERE tenant_id = active_tenant_id AND sale_id = p_sale_id AND product_id = item_product_id AND unit_id = sale_row.unit_id AND status = 'VENDIDO';
      GET DIAGNOSTICS updated_units = ROW_COUNT;
      IF updated_units <> item_quantity THEN RAISE EXCEPTION 'Não foi possível devolver todas as unidades serializadas do produto %', item_product_id; END IF;
    ELSE
      UPDATE public.inventory SET quantities = jsonb_set(quantities, ARRAY[sale_row.unit_id, 'qty'], to_jsonb(COALESCE((quantities -> sale_row.unit_id ->> 'qty')::INTEGER, 0) + item_quantity), true), updated_at = NOW()
      WHERE tenant_id = active_tenant_id AND product_id = item_product_id;
    END IF;
    INSERT INTO public.movements (id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity, serials, card_condition, operator_id, operator_name, timestamp, reason)
    VALUES (gen_random_uuid()::TEXT, active_tenant_id, item_product_id, item->>'variationId', 'CLIENTE', sale_row.unit_id, 'SAIDA', item_quantity, item->'serials', item->>'cardCondition', auth.uid()::TEXT, sale_row.operator_name, NOW(), 'Cancelamento de venda');
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.register_serialized_stock_entry(TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.pdv_list_available_serial_units(TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.process_inventory_movement(TEXT, TEXT, TEXT, TEXT, INTEGER, JSONB, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.process_sale_transaction(TEXT, TEXT, TEXT, JSONB, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.process_sale_cancellation(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_serialized_stock_entry(TEXT, TEXT, JSONB, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pdv_list_available_serial_units(TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_inventory_movement(TEXT, TEXT, TEXT, TEXT, INTEGER, JSONB, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_sale_transaction(TEXT, TEXT, TEXT, JSONB, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_sale_cancellation(TEXT, TEXT) TO authenticated;

COMMIT;