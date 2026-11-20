BEGIN;

ALTER TABLE public.store_configs
  ADD COLUMN IF NOT EXISTS max_item_discount_percent NUMERIC(5, 2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'store_configs_max_item_discount_percent_check'
      AND conrelid = 'public.store_configs'::regclass
  ) THEN
    ALTER TABLE public.store_configs
      ADD CONSTRAINT store_configs_max_item_discount_percent_check
      CHECK (max_item_discount_percent >= 0 AND max_item_discount_percent <= 100);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.services (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Serviço adicional',
  sell_price NUMERIC(12, 2) NOT NULL CHECK (sell_price >= 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT services_tenant_sku_key UNIQUE (tenant_id, sku),
  CONSTRAINT services_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT services_sku_not_blank CHECK (NULLIF(BTRIM(sku), '') IS NOT NULL),
  CONSTRAINT services_name_not_blank CHECK (NULLIF(BTRIM(name), '') IS NOT NULL),
  CONSTRAINT services_category_not_blank CHECK (NULLIF(BTRIM(category), '') IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS services_tenant_active_name_idx
  ON public.services (tenant_id, is_active, name);

DROP TRIGGER IF EXISTS enforce_current_tenant_trigger ON public.services;
CREATE TRIGGER enforce_current_tenant_trigger
  BEFORE INSERT OR UPDATE ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.enforce_current_tenant();

ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS services_tenant_read ON public.services;
CREATE POLICY services_tenant_read ON public.services
  FOR SELECT USING (public.current_user_can_access_tenant(tenant_id));
DROP POLICY IF EXISTS services_tenant_insert ON public.services;
CREATE POLICY services_tenant_insert ON public.services
  FOR INSERT WITH CHECK (public.current_user_can_access_tenant(tenant_id));
DROP POLICY IF EXISTS services_tenant_update ON public.services;
CREATE POLICY services_tenant_update ON public.services
  FOR UPDATE USING (public.current_user_can_access_tenant(tenant_id))
  WITH CHECK (public.current_user_can_access_tenant(tenant_id));
DROP POLICY IF EXISTS services_tenant_delete ON public.services;
CREATE POLICY services_tenant_delete ON public.services
  FOR DELETE USING (
    public.current_user_is_super_admin()
    OR (tenant_id = public.current_user_tenant_id() AND public.current_user_is_admin())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.services TO authenticated;

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
  max_item_discount_percent NUMERIC
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
    results.requires_unit_selection, v_max_discount
  FROM (
    SELECT product.id AS item_id, 'PRODUCT'::TEXT AS item_type, product.sku,
      product.name, product.brand, product.sell_price,
      COALESCE((inventory.quantities -> v_terminal.unit_id ->> 'qty')::INTEGER, 0) AS available_quantity,
      product.warranty_months,
      COALESCE(product.is_serialized, false) AS requires_unit_selection
    FROM public.products AS product
    JOIN public.inventory AS inventory
      ON inventory.tenant_id = v_terminal.tenant_id
      AND inventory.product_id = product.id
    WHERE product.tenant_id = v_terminal.tenant_id
      AND (
        product.sku ILIKE '%' || v_query || '%'
        OR product.name ILIKE '%' || v_query || '%'
        OR COALESCE(product.brand, '') ILIKE '%' || v_query || '%'
      )
      AND COALESCE((inventory.quantities -> v_terminal.unit_id ->> 'qty')::INTEGER, 0) > 0

    UNION ALL

    SELECT service.id AS item_id, 'SERVICE'::TEXT AS item_type, service.sku,
      service.name, NULL::TEXT AS brand, service.sell_price, 0 AS available_quantity,
      NULL::INTEGER AS warranty_months, false AS requires_unit_selection
    FROM public.services AS service
    WHERE service.tenant_id = v_terminal.tenant_id
      AND service.is_active
      AND (
        service.sku ILIKE '%' || v_query || '%'
        OR service.name ILIKE '%' || v_query || '%'
        OR service.category ILIKE '%' || v_query || '%'
      )
  ) AS results
  ORDER BY CASE WHEN results.sku ILIKE v_query THEN 0 ELSE 1 END, results.name
  LIMIT 30;
END;
$$;

REVOKE ALL ON FUNCTION public.search_pos_items(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_pos_items(TEXT) TO authenticated;

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
  p_requires_approval BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_cash public.cash_register_sessions%ROWTYPE;
  v_config public.store_configs%ROWTYPE;
  item JSONB;
  item_type TEXT;
  item_product_id TEXT;
  item_service_id TEXT;
  item_quantity INTEGER;
  current_qty INTEGER;
  item_discount NUMERIC;
  item_price NUMERIC;
  item_sku TEXT;
  item_name TEXT;
  line_total NUMERIC;
  calculated_gross NUMERIC := 0;
  normalized_items JSONB := '[]'::JSONB;
  item_serials JSONB;
  is_serialized_product BOOLEAN;
  inv_row public.inventory%ROWTYPE;
BEGIN
  SELECT * INTO v_terminal
  FROM public.pos_terminals
  WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;

  SELECT * INTO v_cash
  FROM public.cash_register_sessions
  WHERE terminal_id = v_terminal.id AND status = 'ABERTO'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Open cash register required before selling';
  END IF;

  SELECT * INTO v_config
  FROM public.store_configs
  WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Store configuration not found';
  END IF;

  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Sale must contain at least one item';
  END IF;
  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Sale must contain at least one item';
  END IF;

  INSERT INTO public.sales (
    id, tenant_id, cash_session_id, invoice_number, unit_id, items, payment_method, gross_amount, fee_amount,
    net_amount, operator_id, operator_name, client_cpf, client_name, timestamp, status, requires_approval
  ) VALUES (
    p_sale_id, v_terminal.tenant_id, v_cash.id, p_invoice_number, v_terminal.unit_id, p_items, p_payment_method,
    p_gross_amount, p_fee_amount, p_net_amount, v_terminal.id::TEXT, v_terminal.display_name,
    p_client_cpf, p_client_name, p_timestamp, p_status, p_requires_approval
  );

  FOR item IN SELECT entries.value FROM jsonb_array_elements(p_items) AS entries(value) LOOP
    item_type := UPPER(COALESCE(item->>'itemType', 'PRODUCT'));
    item_quantity := (item->>'quantity')::INTEGER;
    item_discount := COALESCE(NULLIF(item->>'discountPercent', '')::NUMERIC, 0);

    IF item_quantity IS NULL OR item_quantity <= 0 THEN
      RAISE EXCEPTION 'Item quantity must be greater than zero';
    END IF;
    IF item_discount < 0 OR item_discount > v_config.max_item_discount_percent THEN
      RAISE EXCEPTION 'Discount exceeds the store limit of % percent', v_config.max_item_discount_percent;
    END IF;

    IF item_type = 'SERVICE' THEN
      item_service_id := item->>'serviceId';
      SELECT service.sell_price, service.sku, service.name
      INTO item_price, item_sku, item_name
      FROM public.services AS service
      WHERE service.tenant_id = v_terminal.tenant_id
        AND service.id = item_service_id
        AND service.is_active;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Service % not found or inactive', item_service_id;
      END IF;
      item_serials := NULL;
    ELSIF item_type = 'PRODUCT' THEN
      item_product_id := item->>'productId';
      SELECT product.sell_price, COALESCE(product.is_serialized, false), product.sku, product.name
      INTO item_price, is_serialized_product, item_sku, item_name
      FROM public.products AS product
      WHERE product.tenant_id = v_terminal.tenant_id AND product.id = item_product_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Product % not found', item_product_id;
      END IF;

      item_serials := item->'serials';
      IF is_serialized_product THEN
        PERFORM public.mark_serial_units_sold(
          v_terminal.tenant_id, item_product_id, v_terminal.unit_id, p_sale_id, item_serials, item_quantity
        );
      ELSE
        IF jsonb_typeof(item_serials) = 'array' AND jsonb_array_length(item_serials) > 0 THEN
          RAISE EXCEPTION 'Non-serialized products cannot include serial units';
        END IF;
        SELECT * INTO inv_row
        FROM public.inventory
        WHERE tenant_id = v_terminal.tenant_id AND product_id = item_product_id
        FOR UPDATE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Product % was not found in inventory', item_product_id;
        END IF;
        current_qty := COALESCE((inv_row.quantities -> v_terminal.unit_id ->> 'qty')::INTEGER, 0);
        IF current_qty < item_quantity THEN
          RAISE EXCEPTION 'Insufficient stock for product % in store %', item_product_id, v_terminal.unit_id;
        END IF;
        UPDATE public.inventory
        SET quantities = jsonb_set(inv_row.quantities, ARRAY[v_terminal.unit_id, 'qty'], to_jsonb(current_qty - item_quantity), true), updated_at = NOW()
        WHERE tenant_id = v_terminal.tenant_id AND product_id = item_product_id;
      END IF;

      INSERT INTO public.movements (
        id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
        serials, card_condition, operator_id, operator_name, timestamp, reason
      ) VALUES (
        gen_random_uuid()::TEXT, v_terminal.tenant_id, item_product_id, item->>'variationId',
        v_terminal.unit_id, 'CLIENTE', 'SAIDA', item_quantity, item_serials, item->>'cardCondition',
        v_terminal.id::TEXT, v_terminal.display_name, p_timestamp, 'Venda registrada no PDV'
      );
    ELSE
      RAISE EXCEPTION 'Unsupported sale item type: %', item_type;
    END IF;

    line_total := ROUND(item_price * item_quantity * (100 - item_discount) / 100, 2);
    calculated_gross := calculated_gross + line_total;
    normalized_items := normalized_items || jsonb_build_array(
      item || jsonb_build_object(
        'itemType', item_type,
        'unitPrice', item_price,
        'itemSku', item_sku,
        'itemName', item_name,
        'discountPercent', item_discount,
        'lineTotal', line_total
      )
    );
  END LOOP;

  IF ABS(COALESCE(p_gross_amount, 0) - calculated_gross) > 0.01 THEN
    RAISE EXCEPTION 'Sale total does not match item prices and discounts';
  END IF;
  IF COALESCE(p_fee_amount, 0) < 0 OR ABS(COALESCE(p_net_amount, 0) - (p_gross_amount - p_fee_amount)) > 0.01 THEN
    RAISE EXCEPTION 'Invalid sale net amount or fee';
  END IF;

  UPDATE public.sales
  SET items = normalized_items
  WHERE tenant_id = v_terminal.tenant_id AND id = p_sale_id;
END;
$$;

REVOKE ALL ON FUNCTION public.process_pos_terminal_sale(TEXT, TEXT, JSONB, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_pos_terminal_sale(TEXT, TEXT, JSONB, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN) TO authenticated;

CREATE OR REPLACE FUNCTION public.process_sale_cancellation(p_sale_id TEXT, p_approved_by TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  active_tenant_id UUID := public.current_user_tenant_id();
  sale_row public.sales%ROWTYPE;
  item JSONB;
  item_type TEXT;
  item_product_id TEXT;
  item_quantity INTEGER;
  is_serialized_product BOOLEAN;
  updated_units INTEGER;
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

    IF is_serialized_product THEN
      UPDATE public.product_serial_units
      SET status = 'DISPONIVEL', sale_id = NULL
      WHERE tenant_id = active_tenant_id AND sale_id = p_sale_id
        AND product_id = item_product_id AND unit_id = sale_row.unit_id AND status = 'VENDIDO';
      GET DIAGNOSTICS updated_units = ROW_COUNT;
      IF updated_units <> item_quantity THEN
        RAISE EXCEPTION 'Could not return every serialized unit of product %', item_product_id;
      END IF;
    ELSE
      UPDATE public.inventory
      SET quantities = jsonb_set(
        quantities,
        ARRAY[sale_row.unit_id, 'qty'],
        to_jsonb(COALESCE((quantities -> sale_row.unit_id ->> 'qty')::INTEGER, 0) + item_quantity),
        true
      ), updated_at = NOW()
      WHERE tenant_id = active_tenant_id AND product_id = item_product_id;
    END IF;

    INSERT INTO public.movements (
      id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
      serials, card_condition, operator_id, operator_name, timestamp, reason
    ) VALUES (
      gen_random_uuid()::TEXT, active_tenant_id, item_product_id, item->>'variationId',
      'CLIENTE', sale_row.unit_id, 'SAIDA', item_quantity, item->'serials', item->>'cardCondition',
      auth.uid()::TEXT, sale_row.operator_name, NOW(), 'Cancelamento de venda'
    );
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.process_sale_cancellation(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_sale_cancellation(TEXT, TEXT) TO authenticated;

COMMIT;