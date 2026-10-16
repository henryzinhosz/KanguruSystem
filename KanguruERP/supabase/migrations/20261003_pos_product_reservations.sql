BEGIN;

ALTER TABLE public.sales
  ADD COLUMN IF NOT EXISTS reservation_deposit_applied NUMERIC(12, 2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sales_reservation_deposit_applied_check'
      AND conrelid = 'public.sales'::regclass
  ) THEN
    ALTER TABLE public.sales
      ADD CONSTRAINT sales_reservation_deposit_applied_check
      CHECK (reservation_deposit_applied >= 0 AND reservation_deposit_applied <= gross_amount);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.product_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  terminal_id UUID NOT NULL REFERENCES public.pos_terminals(id),
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  deposit_amount NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (deposit_amount >= 0),
  deposit_payment_method TEXT,
  status TEXT NOT NULL DEFAULT 'ATIVA' CHECK (status IN ('ATIVA', 'CONVERTIDA', 'CANCELADA')),
  sale_id TEXT,
  created_by TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT product_reservations_store_fk
    FOREIGN KEY (tenant_id, unit_id) REFERENCES public.store_configs(tenant_id, unit_id) ON DELETE RESTRICT,
  CONSTRAINT product_reservations_sale_fk
    FOREIGN KEY (tenant_id, sale_id) REFERENCES public.sales(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT product_reservations_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT product_reservations_deposit_method_check
    CHECK (
      (deposit_amount = 0 AND deposit_payment_method IS NULL)
      OR (deposit_amount > 0 AND deposit_payment_method IS NOT NULL
        AND deposit_payment_method IN ('DINHEIRO', 'PIX', 'CREDITO', 'DEBITO'))
    ),
  CONSTRAINT product_reservations_terminal_state_check
    CHECK ((status = 'CONVERTIDA') = (sale_id IS NOT NULL)),
  CONSTRAINT product_reservations_customer_not_blank
    CHECK (NULLIF(BTRIM(customer_name), '') IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS public.product_reservation_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  reservation_id UUID NOT NULL,
  product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  serial_unit_id UUID REFERENCES public.product_serial_units(id) ON DELETE RESTRICT,
  serial_number TEXT,
  item_sku TEXT NOT NULL,
  item_name TEXT NOT NULL,
  unit_price NUMERIC(12, 2) NOT NULL CHECK (unit_price >= 0),
  discount_percent NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
  line_total NUMERIC(12, 2) NOT NULL CHECK (line_total >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT product_reservation_items_reservation_fk
    FOREIGN KEY (tenant_id, reservation_id)
    REFERENCES public.product_reservations(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT product_reservation_items_product_fk
    FOREIGN KEY (tenant_id, product_id)
    REFERENCES public.products(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT product_reservation_items_serial_fields_check
    CHECK (
      (serial_unit_id IS NULL AND serial_number IS NULL)
      OR (serial_unit_id IS NOT NULL AND serial_number IS NOT NULL AND quantity = 1)
    )
);

CREATE INDEX IF NOT EXISTS product_reservations_active_store_idx
  ON public.product_reservations(tenant_id, unit_id, expires_at)
  WHERE status = 'ATIVA';
CREATE INDEX IF NOT EXISTS product_reservation_items_product_idx
  ON public.product_reservation_items(tenant_id, product_id, reservation_id);

CREATE TABLE IF NOT EXISTS public.pos_reservation_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  terminal_id UUID NOT NULL REFERENCES public.pos_terminals(id),
  cash_session_id UUID NOT NULL REFERENCES public.cash_register_sessions(id),
  reservation_id UUID NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('DEPOSITO', 'DEVOLUCAO')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('DINHEIRO', 'PIX', 'CREDITO', 'DEBITO')),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  operator_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pos_reservation_payments_store_fk
    FOREIGN KEY (tenant_id, unit_id) REFERENCES public.store_configs(tenant_id, unit_id) ON DELETE RESTRICT,
  CONSTRAINT pos_reservation_payments_reservation_fk
    FOREIGN KEY (tenant_id, reservation_id) REFERENCES public.product_reservations(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS pos_reservation_payments_cash_idx
  ON public.pos_reservation_payments(cash_session_id, payment_method, event_type);

ALTER TABLE public.product_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_reservation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_reservation_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.product_reservations, public.product_reservation_items, public.pos_reservation_payments FROM PUBLIC, anon, authenticated;

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
  IF COALESCE(v_query, '') = '' THEN RETURN; END IF;

  SELECT * INTO v_terminal
  FROM public.pos_terminals
  WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active terminal session required'; END IF;

  SELECT COALESCE(config.max_item_discount_percent, 0)
  INTO v_max_discount
  FROM public.store_configs AS config
  WHERE config.tenant_id = v_terminal.tenant_id AND config.unit_id = v_terminal.unit_id;
  v_max_discount := COALESCE(v_max_discount, 0);

  RETURN QUERY
  SELECT results.item_id, results.item_type, results.sku, results.name, results.brand,
    results.sell_price, results.available_quantity, results.warranty_months,
    results.requires_unit_selection, v_max_discount
  FROM (
    SELECT product.id AS item_id, 'PRODUCT'::TEXT AS item_type, product.sku,
      product.name, product.brand, product.sell_price,
      (COALESCE((inventory.quantities -> v_terminal.unit_id ->> 'qty')::INTEGER, 0)
        - COALESCE(reserved.quantity, 0))::INTEGER AS available_quantity,
      product.warranty_months, COALESCE(product.is_serialized, false) AS requires_unit_selection
    FROM public.products AS product
    JOIN public.inventory AS inventory
      ON inventory.tenant_id = v_terminal.tenant_id AND inventory.product_id = product.id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(reservation_item.quantity), 0)::INTEGER AS quantity
      FROM public.product_reservation_items AS reservation_item
      JOIN public.product_reservations AS reservation
        ON reservation.tenant_id = reservation_item.tenant_id
        AND reservation.id = reservation_item.reservation_id
      WHERE reservation_item.tenant_id = product.tenant_id
        AND reservation_item.product_id = product.id
        AND reservation.unit_id = v_terminal.unit_id
        AND reservation.status = 'ATIVA'
        AND reservation_item.serial_unit_id IS NULL
    ) AS reserved ON true
    WHERE product.tenant_id = v_terminal.tenant_id
      AND (product.sku ILIKE '%' || v_query || '%'
        OR product.name ILIKE '%' || v_query || '%'
        OR COALESCE(product.brand, '') ILIKE '%' || v_query || '%')
      AND COALESCE((inventory.quantities -> v_terminal.unit_id ->> 'qty')::INTEGER, 0)
        - COALESCE(reserved.quantity, 0) > 0

    UNION ALL

    SELECT service.id AS item_id, 'SERVICE'::TEXT AS item_type, service.sku,
      service.name, NULL::TEXT AS brand, service.sell_price, 0 AS available_quantity,
      NULL::INTEGER AS warranty_months, false AS requires_unit_selection
    FROM public.services AS service
    WHERE service.tenant_id = v_terminal.tenant_id AND service.is_active
      AND (service.sku ILIKE '%' || v_query || '%'
        OR service.name ILIKE '%' || v_query || '%'
        OR service.category ILIKE '%' || v_query || '%')
  ) AS results
  ORDER BY CASE WHEN results.sku ILIKE v_query THEN 0 ELSE 1 END, results.name
  LIMIT 30;
END;
$$;

REVOKE ALL ON FUNCTION public.search_pos_items(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_pos_items(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.reserve_pos_cart(
  p_customer_name TEXT,
  p_customer_phone TEXT,
  p_expires_at TIMESTAMPTZ,
  p_deposit_amount NUMERIC,
  p_deposit_payment_method TEXT,
  p_items JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_cash public.cash_register_sessions%ROWTYPE;
  v_config public.store_configs%ROWTYPE;
  v_reservation_id UUID := gen_random_uuid();
  item JSONB;
  v_product_id TEXT;
  v_quantity INTEGER;
  v_discount NUMERIC;
  v_unit_price NUMERIC;
  v_line_total NUMERIC;
  v_serialized BOOLEAN;
  v_sku TEXT;
  v_name TEXT;
  v_serial_unit_id UUID;
  v_serial_number TEXT;
  v_inventory public.inventory%ROWTYPE;
  v_available_quantity INTEGER;
  v_total NUMERIC := 0;
BEGIN
  SELECT * INTO v_terminal
  FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active terminal session required'; END IF;

  SELECT * INTO v_cash
  FROM public.cash_register_sessions
  WHERE terminal_id = v_terminal.id AND status = 'ABERTO'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Open cash register required before reserving'; END IF;

  SELECT * INTO v_config
  FROM public.store_configs
  WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Store configuration not found'; END IF;

  IF NULLIF(BTRIM(p_customer_name), '') IS NULL THEN RAISE EXCEPTION 'Customer name is required'; END IF;
  IF p_expires_at IS NULL OR p_expires_at <= NOW() THEN RAISE EXCEPTION 'Reservation deadline must be in the future'; END IF;
  IF p_deposit_amount IS NULL OR p_deposit_amount < 0 THEN RAISE EXCEPTION 'Deposit must be zero or greater'; END IF;
  IF p_deposit_amount > 0 AND p_deposit_payment_method NOT IN ('DINHEIRO', 'PIX', 'CREDITO', 'DEBITO') THEN
    RAISE EXCEPTION 'Select a valid payment method for the deposit';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Reservation items must be a JSON array';
  END IF;
  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Reservation must contain at least one product';
  END IF;

  INSERT INTO public.product_reservations (
    id, tenant_id, unit_id, terminal_id, customer_name, customer_phone, expires_at,
    deposit_amount, deposit_payment_method, created_by, created_by_name
  ) VALUES (
    v_reservation_id, v_terminal.tenant_id, v_terminal.unit_id, v_terminal.id,
    BTRIM(p_customer_name), NULLIF(BTRIM(p_customer_phone), ''), p_expires_at,
    p_deposit_amount, CASE WHEN p_deposit_amount > 0 THEN p_deposit_payment_method ELSE NULL END,
    auth.uid()::TEXT, v_terminal.display_name
  );

  FOR item IN SELECT entries.value FROM jsonb_array_elements(p_items) AS entries(value) LOOP
    IF UPPER(COALESCE(item->>'itemType', 'PRODUCT')) <> 'PRODUCT' THEN
      RAISE EXCEPTION 'Only products can be reserved';
    END IF;
    v_product_id := item->>'productId';
    v_quantity := (item->>'quantity')::INTEGER;
    v_discount := COALESCE(NULLIF(item->>'discountPercent', '')::NUMERIC, 0);
    IF v_quantity IS NULL OR v_quantity <= 0 THEN RAISE EXCEPTION 'Item quantity must be greater than zero'; END IF;
    IF v_discount < 0 OR v_discount > COALESCE(v_config.max_item_discount_percent, 0) THEN
      RAISE EXCEPTION 'Discount exceeds the store limit of % percent', v_config.max_item_discount_percent;
    END IF;

    SELECT product.sell_price, COALESCE(product.is_serialized, false), product.sku, product.name
    INTO v_unit_price, v_serialized, v_sku, v_name
    FROM public.products AS product
    WHERE product.tenant_id = v_terminal.tenant_id AND product.id = v_product_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Product % not found', v_product_id; END IF;
    v_line_total := ROUND(v_unit_price * v_quantity * (100 - v_discount) / 100, 2);

    IF v_serialized THEN
      IF v_quantity <> 1 OR NULLIF(item->>'serialUnitId', '') IS NULL THEN
        RAISE EXCEPTION 'Select one available serialized unit for each reservation line';
      END IF;
      v_serial_unit_id := (item->>'serialUnitId')::UUID;
      UPDATE public.product_serial_units
      SET status = 'RESERVADO'
      WHERE id = v_serial_unit_id AND tenant_id = v_terminal.tenant_id
        AND product_id = v_product_id AND unit_id = v_terminal.unit_id
        AND status = 'DISPONIVEL'
      RETURNING serial_number INTO v_serial_number;
      IF NOT FOUND THEN RAISE EXCEPTION 'Serialized unit is no longer available'; END IF;
    ELSE
      IF NULLIF(item->>'serialUnitId', '') IS NOT NULL THEN RAISE EXCEPTION 'Non-serialized product cannot select a serial unit'; END IF;
      SELECT * INTO v_inventory
      FROM public.inventory
      WHERE tenant_id = v_terminal.tenant_id AND product_id = v_product_id
      FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Product % was not found in inventory', v_product_id; END IF;
      SELECT COALESCE((v_inventory.quantities -> v_terminal.unit_id ->> 'qty')::INTEGER, 0)
        - COALESCE(SUM(reservation_item.quantity), 0)::INTEGER
      INTO v_available_quantity
      FROM public.product_reservation_items AS reservation_item
      JOIN public.product_reservations AS reservation
        ON reservation.tenant_id = reservation_item.tenant_id AND reservation.id = reservation_item.reservation_id
      WHERE reservation_item.tenant_id = v_terminal.tenant_id
        AND reservation_item.product_id = v_product_id
        AND reservation.unit_id = v_terminal.unit_id
        AND reservation.status = 'ATIVA'
        AND reservation_item.serial_unit_id IS NULL;
      IF v_available_quantity < v_quantity THEN RAISE EXCEPTION 'Insufficient available stock to reserve product %', v_product_id; END IF;
      v_serial_unit_id := NULL;
      v_serial_number := NULL;
    END IF;

    INSERT INTO public.product_reservation_items (
      tenant_id, reservation_id, product_id, quantity, serial_unit_id, serial_number,
      item_sku, item_name, unit_price, discount_percent, line_total
    ) VALUES (
      v_terminal.tenant_id, v_reservation_id, v_product_id, v_quantity, v_serial_unit_id, v_serial_number,
      v_sku, v_name, v_unit_price, v_discount, v_line_total
    );
    v_total := v_total + v_line_total;
  END LOOP;

  IF p_deposit_amount > v_total THEN RAISE EXCEPTION 'Deposit cannot exceed the reserved total'; END IF;
  IF p_deposit_amount > 0 THEN
    INSERT INTO public.pos_reservation_payments (
      tenant_id, unit_id, terminal_id, cash_session_id, reservation_id,
      event_type, payment_method, amount, operator_name
    ) VALUES (
      v_terminal.tenant_id, v_terminal.unit_id, v_terminal.id, v_cash.id, v_reservation_id,
      'DEPOSITO', p_deposit_payment_method, p_deposit_amount, v_terminal.display_name
    );
  END IF;
  RETURN v_reservation_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_pos_cart(TEXT, TEXT, TIMESTAMPTZ, NUMERIC, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reserve_pos_cart(TEXT, TEXT, TIMESTAMPTZ, NUMERIC, TEXT, JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_pos_reservations()
RETURNS TABLE (
  reservation_id UUID,
  customer_name TEXT,
  customer_phone TEXT,
  expires_at TIMESTAMPTZ,
  deposit_amount NUMERIC,
  deposit_payment_method TEXT,
  status TEXT,
  created_at TIMESTAMPTZ,
  is_expired BOOLEAN,
  items JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals
  WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active terminal session required'; END IF;

  RETURN QUERY
  SELECT reservation.id, reservation.customer_name, reservation.customer_phone,
    reservation.expires_at, reservation.deposit_amount, reservation.deposit_payment_method,
    reservation.status, reservation.created_at, reservation.expires_at <= NOW(),
    COALESCE(jsonb_agg(jsonb_build_object(
      'reservationItemId', reservation_item.id,
      'productId', reservation_item.product_id,
      'quantity', reservation_item.quantity,
      'serialUnitId', reservation_item.serial_unit_id,
      'serialNumber', reservation_item.serial_number,
      'itemSku', reservation_item.item_sku,
      'itemName', reservation_item.item_name,
      'unitPrice', reservation_item.unit_price,
      'discountPercent', reservation_item.discount_percent,
      'lineTotal', reservation_item.line_total
    ) ORDER BY reservation_item.created_at) FILTER (WHERE reservation_item.id IS NOT NULL), '[]'::JSONB)
  FROM public.product_reservations AS reservation
  LEFT JOIN public.product_reservation_items AS reservation_item
    ON reservation_item.tenant_id = reservation.tenant_id
    AND reservation_item.reservation_id = reservation.id
  WHERE reservation.tenant_id = v_terminal.tenant_id
    AND reservation.unit_id = v_terminal.unit_id
    AND reservation.status = 'ATIVA'
  GROUP BY reservation.id
  ORDER BY reservation.expires_at, reservation.created_at;
END;
$$;

REVOKE ALL ON FUNCTION public.list_pos_reservations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_pos_reservations() TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_pos_reservation(
  p_reservation_id UUID,
  p_refund_payment_method TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_cash public.cash_register_sessions%ROWTYPE;
  v_reservation public.product_reservations%ROWTYPE;
  v_serials_expected INTEGER;
  v_serials_released INTEGER;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals
  WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active terminal session required'; END IF;

  SELECT * INTO v_reservation
  FROM public.product_reservations
  WHERE id = p_reservation_id AND tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id
  FOR UPDATE;
  IF NOT FOUND OR v_reservation.status <> 'ATIVA' THEN RAISE EXCEPTION 'Active reservation not found'; END IF;

  SELECT COUNT(*) INTO v_serials_expected
  FROM public.product_reservation_items
  WHERE tenant_id = v_terminal.tenant_id AND reservation_id = p_reservation_id AND serial_unit_id IS NOT NULL;

  IF v_serials_expected > 0 THEN
    UPDATE public.product_serial_units AS serial_unit
    SET status = 'DISPONIVEL', sale_id = NULL
    FROM public.product_reservation_items AS reservation_item
    WHERE reservation_item.tenant_id = v_terminal.tenant_id
      AND reservation_item.reservation_id = p_reservation_id
      AND reservation_item.serial_unit_id = serial_unit.id
      AND serial_unit.status = 'RESERVADO';
    GET DIAGNOSTICS v_serials_released = ROW_COUNT;
    IF v_serials_released <> v_serials_expected THEN RAISE EXCEPTION 'Could not release every serialized unit'; END IF;
  END IF;

  SELECT * INTO v_cash
  FROM public.cash_register_sessions
  WHERE terminal_id = v_terminal.id AND status = 'ABERTO'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Open cash register required to cancel reservation'; END IF;

  IF v_reservation.deposit_amount > 0 THEN
    IF p_refund_payment_method NOT IN ('DINHEIRO', 'PIX', 'CREDITO', 'DEBITO') THEN
      RAISE EXCEPTION 'Select the method used to record the manual deposit refund';
    END IF;
    INSERT INTO public.pos_reservation_payments (
      tenant_id, unit_id, terminal_id, cash_session_id, reservation_id,
      event_type, payment_method, amount, operator_name
    ) VALUES (
      v_terminal.tenant_id, v_terminal.unit_id, v_terminal.id, v_cash.id, p_reservation_id,
      'DEVOLUCAO', p_refund_payment_method, v_reservation.deposit_amount, v_terminal.display_name
    );
  END IF;

  UPDATE public.product_reservations
  SET status = 'CANCELADA', updated_at = NOW()
  WHERE id = p_reservation_id AND tenant_id = v_terminal.tenant_id;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_pos_reservation(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_pos_reservation(UUID, TEXT) TO authenticated;

DROP FUNCTION IF EXISTS public.process_pos_terminal_sale(TEXT, TEXT, JSONB, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN);
CREATE FUNCTION public.process_pos_terminal_sale(
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
  p_reservation_id UUID DEFAULT NULL
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
  v_reservation public.product_reservations%ROWTYPE;
  v_reservation_item public.product_reservation_items%ROWTYPE;
  item JSONB;
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
  line_total NUMERIC;
  calculated_gross NUMERIC := 0;
  normalized_items JSONB := '[]'::JSONB;
  item_serials JSONB;
  is_serialized_product BOOLEAN;
  inv_row public.inventory%ROWTYPE;
  updated_units INTEGER;
  submitted_item_count INTEGER;
  distinct_reservation_items INTEGER;
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
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Sale items must be a JSON array';
  END IF;
  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Sale must contain at least one item';
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
    IF item_discount < 0 OR (p_reservation_id IS NULL
      AND item_discount > COALESCE(v_config.max_item_discount_percent, 0)) THEN
      RAISE EXCEPTION 'Discount exceeds the store limit of % percent', v_config.max_item_discount_percent;
    END IF;

    IF item_type = 'SERVICE' THEN
      IF p_reservation_id IS NOT NULL THEN RAISE EXCEPTION 'Services cannot be included in product reservations'; END IF;
      item_service_id := item->>'serviceId';
      SELECT service.sell_price, service.sku, service.name INTO item_price, item_sku, item_name
      FROM public.services AS service
      WHERE service.tenant_id = v_terminal.tenant_id AND service.id = item_service_id AND service.is_active;
      IF NOT FOUND THEN RAISE EXCEPTION 'Service % not found or inactive', item_service_id; END IF;
      item_serials := NULL;
    ELSIF item_type = 'PRODUCT' THEN
      item_product_id := item->>'productId';
      SELECT product.sell_price, COALESCE(product.is_serialized, false), product.sku, product.name
      INTO item_price, is_serialized_product, item_sku, item_name
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
        ELSE
          IF v_reservation_item.serial_unit_id IS NOT NULL THEN RAISE EXCEPTION 'Non-serialized reservation line contains a serial'; END IF;
        END IF;
      ELSIF is_serialized_product THEN
        PERFORM public.mark_serial_units_sold(
          v_terminal.tenant_id, item_product_id, v_terminal.unit_id, p_sale_id, item_serials, item_quantity
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
        v_terminal.id::TEXT, v_terminal.display_name, p_timestamp,
        CASE WHEN p_reservation_id IS NULL THEN 'Venda registrada no PDV' ELSE 'Reserva convertida em venda' END
      );
    ELSE
      RAISE EXCEPTION 'Unsupported sale item type: %', item_type;
    END IF;

    line_total := ROUND(item_price * item_quantity * (100 - item_discount) / 100, 2);
    calculated_gross := calculated_gross + line_total;
    normalized_items := normalized_items || jsonb_build_array(
      item || jsonb_build_object(
        'itemType', item_type, 'unitPrice', item_price, 'itemSku', item_sku,
        'itemName', item_name, 'discountPercent', item_discount,
        'lineTotal', line_total, 'serials', item_serials
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

  UPDATE public.sales
  SET items = normalized_items,
      reservation_deposit_applied = CASE WHEN p_reservation_id IS NULL THEN 0 ELSE v_reservation.deposit_amount END
  WHERE tenant_id = v_terminal.tenant_id AND id = p_sale_id;

  IF p_reservation_id IS NOT NULL THEN
    UPDATE public.product_reservations
    SET status = 'CONVERTIDA', sale_id = p_sale_id, updated_at = NOW()
    WHERE id = p_reservation_id AND tenant_id = v_terminal.tenant_id AND status = 'ATIVA';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.process_pos_terminal_sale(TEXT, TEXT, JSONB, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_pos_terminal_sale(TEXT, TEXT, JSONB, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_pos_cash_closure_summary()
RETURNS TABLE (
  cash_session_id UUID, cash_number TEXT, opened_at TIMESTAMPTZ, opened_by_name TEXT,
  opening_float_amount NUMERIC, expected_cash_amount NUMERIC, expected_pix_amount NUMERIC,
  expected_credit_amount NUMERIC, expected_debit_amount NUMERIC, expected_voucher_amount NUMERIC,
  expected_credit_account_amount NUMERIC, supplies_amount NUMERIC, withdrawals_amount NUMERIC
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public
AS $$
  WITH active_terminal AS (
    SELECT id FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active
  ), active_cash AS (
    SELECT cash.* FROM public.cash_register_sessions AS cash
    JOIN active_terminal AS terminal ON terminal.id = cash.terminal_id
    WHERE cash.status = 'ABERTO'
  ), sales_totals AS (
    SELECT sale.cash_session_id,
      COALESCE(SUM(sale.gross_amount - sale.reservation_deposit_applied) FILTER (WHERE sale.payment_method = 'DINHEIRO'), 0) AS cash_amount,
      COALESCE(SUM(sale.gross_amount - sale.reservation_deposit_applied) FILTER (WHERE sale.payment_method = 'PIX'), 0) AS pix_amount,
      COALESCE(SUM(sale.gross_amount - sale.reservation_deposit_applied) FILTER (WHERE sale.payment_method = 'CREDITO'), 0) AS credit_amount,
      COALESCE(SUM(sale.gross_amount - sale.reservation_deposit_applied) FILTER (WHERE sale.payment_method = 'DEBITO'), 0) AS debit_amount,
      COALESCE(SUM(sale.gross_amount - sale.reservation_deposit_applied) FILTER (WHERE sale.payment_method = 'VOUCHER'), 0) AS voucher_amount,
      COALESCE(SUM(sale.gross_amount - sale.reservation_deposit_applied) FILTER (WHERE sale.payment_method = 'CREDIARIO'), 0) AS credit_account_amount
    FROM public.sales AS sale
    JOIN active_cash AS cash ON cash.id = sale.cash_session_id
    WHERE sale.status <> 'CANCELADA'
    GROUP BY sale.cash_session_id
  ), movement_totals AS (
    SELECT movement.cash_session_id,
      COALESCE(SUM(movement.amount) FILTER (WHERE movement.type = 'SUPRIMENTO'), 0) AS supplies_amount,
      COALESCE(SUM(movement.amount) FILTER (WHERE movement.type = 'SANGRIA'), 0) AS withdrawals_amount
    FROM public.cash_register_movements AS movement
    JOIN active_cash AS cash ON cash.id = movement.cash_session_id
    GROUP BY movement.cash_session_id
  ), reservation_payment_totals AS (
    SELECT payment.cash_session_id,
      COALESCE(SUM(payment.amount) FILTER (WHERE payment.payment_method = 'DINHEIRO' AND payment.event_type = 'DEPOSITO'), 0)
        - COALESCE(SUM(payment.amount) FILTER (WHERE payment.payment_method = 'DINHEIRO' AND payment.event_type = 'DEVOLUCAO'), 0) AS cash_amount,
      COALESCE(SUM(payment.amount) FILTER (WHERE payment.payment_method = 'PIX' AND payment.event_type = 'DEPOSITO'), 0)
        - COALESCE(SUM(payment.amount) FILTER (WHERE payment.payment_method = 'PIX' AND payment.event_type = 'DEVOLUCAO'), 0) AS pix_amount,
      COALESCE(SUM(payment.amount) FILTER (WHERE payment.payment_method = 'CREDITO' AND payment.event_type = 'DEPOSITO'), 0)
        - COALESCE(SUM(payment.amount) FILTER (WHERE payment.payment_method = 'CREDITO' AND payment.event_type = 'DEVOLUCAO'), 0) AS credit_amount,
      COALESCE(SUM(payment.amount) FILTER (WHERE payment.payment_method = 'DEBITO' AND payment.event_type = 'DEPOSITO'), 0)
        - COALESCE(SUM(payment.amount) FILTER (WHERE payment.payment_method = 'DEBITO' AND payment.event_type = 'DEVOLUCAO'), 0) AS debit_amount
    FROM public.pos_reservation_payments AS payment
    JOIN active_cash AS cash ON cash.id = payment.cash_session_id
    GROUP BY payment.cash_session_id
  )
  SELECT cash.id, cash.cash_number, cash.opened_at, cash.opened_by_name, cash.opening_float_amount,
    cash.opening_float_amount + COALESCE(sales.cash_amount, 0) + COALESCE(movement.supplies_amount, 0)
      - COALESCE(movement.withdrawals_amount, 0) + COALESCE(payment.cash_amount, 0),
    COALESCE(sales.pix_amount, 0) + COALESCE(payment.pix_amount, 0),
    COALESCE(sales.credit_amount, 0) + COALESCE(payment.credit_amount, 0),
    COALESCE(sales.debit_amount, 0) + COALESCE(payment.debit_amount, 0),
    COALESCE(sales.voucher_amount, 0), COALESCE(sales.credit_account_amount, 0),
    COALESCE(movement.supplies_amount, 0), COALESCE(movement.withdrawals_amount, 0)
  FROM active_cash AS cash
  LEFT JOIN sales_totals AS sales ON sales.cash_session_id = cash.id
  LEFT JOIN movement_totals AS movement ON movement.cash_session_id = cash.id
  LEFT JOIN reservation_payment_totals AS payment ON payment.cash_session_id = cash.id;
$$;

REVOKE ALL ON FUNCTION public.get_pos_cash_closure_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_cash_closure_summary() TO authenticated;

COMMIT;
