-- Reserva sem estoque (encomenda), voucher de reserva e busca com produtos sem estoque.
-- 1. Colunas: CPF do cliente na reserva, "encomenda" no item, regras do voucher na loja.
-- 2. search_pos_items: mostra tambem produtos sem estoque, desconta reservas ativas
--    (a versao viva era a antiga da 2.5, que nao descontava) e diz em quais outras
--    lojas ha estoque.
-- 3. get_pos_store_profile: dados da loja para o cabecalho do voucher.
-- 4-6. reserve_pos_cart (CPF + encomenda), list_pos_reservations (CPF + encomenda) e
--    process_pos_terminal_sale (entrega de encomenda com serial), copiados da 20261017.
-- Venda normal, reserva com estoque, caixa e estorno: sem mudanca de comportamento.
BEGIN;

-- ---- 1. Colunas novas ----
ALTER TABLE public.product_reservations
  ADD COLUMN IF NOT EXISTS customer_cpf TEXT;
ALTER TABLE public.product_reservation_items
  ADD COLUMN IF NOT EXISTS is_backorder BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.store_configs
  ADD COLUMN IF NOT EXISTS reservation_voucher_terms TEXT;

-- ---- 2. Busca do PDV ----
-- Interna (sem GRANT): disponivel na loja = estoque - linhas de reservas ativas sem
-- unidade (sem serial reservadas e encomendas). Serializado: o estoque ja conta so
-- as unidades DISPONIVEL (trigger sync_serialized_inventory_after_change).
CREATE OR REPLACE FUNCTION public.pos_store_available_qty(
  p_tenant_id UUID,
  p_product_id TEXT,
  p_unit_id TEXT,
  p_quantities JSONB
)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((p_quantities -> p_unit_id ->> 'qty')::INTEGER, 0)
    - COALESCE((
      SELECT SUM(reservation_item.quantity)::INTEGER
      FROM public.product_reservation_items AS reservation_item
      JOIN public.product_reservations AS reservation
        ON reservation.tenant_id = reservation_item.tenant_id
        AND reservation.id = reservation_item.reservation_id
      WHERE reservation_item.tenant_id = p_tenant_id
        AND reservation_item.product_id = p_product_id
        AND reservation.unit_id = p_unit_id
        AND reservation.status = 'ATIVA'
        AND reservation_item.serial_unit_id IS NULL
    ), 0);
$$;

REVOKE ALL ON FUNCTION public.pos_store_available_qty(UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

-- Retorno ganha stores_with_stock (nomes das outras lojas com estoque, so quando
-- esta loja nao tem): DROP + CREATE. Assinatura (p_query TEXT) igual.
DROP FUNCTION IF EXISTS public.search_pos_items(TEXT);
CREATE FUNCTION public.search_pos_items(p_query TEXT)
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
    results.requires_unit_selection, v_max_discount, results.stores_with_stock
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
      ) END AS stores_with_stock
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
      AND (
        product.sku ILIKE '%' || v_query || '%'
        OR product.name ILIKE '%' || v_query || '%'
        OR COALESCE(product.brand, '') ILIKE '%' || v_query || '%'
      )

    UNION ALL

    SELECT service.id AS item_id, 'SERVICE'::TEXT AS item_type, service.sku,
      service.name, NULL::TEXT AS brand, service.sell_price, 0 AS available_quantity,
      NULL::INTEGER AS warranty_months, false AS requires_unit_selection,
      ARRAY[]::TEXT[] AS stores_with_stock
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

-- ---- 3. Dados da loja para o voucher (sessao de terminal) ----
CREATE OR REPLACE FUNCTION public.get_pos_store_profile()
RETURNS TABLE (
  trade_name TEXT,
  legal_name TEXT,
  cnpj TEXT,
  address TEXT,
  phone TEXT,
  reservation_voucher_terms TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
BEGIN
  SELECT * INTO v_terminal
  FROM public.pos_terminals
  WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;

  RETURN QUERY
  SELECT config.trade_name, config.legal_name, config.cnpj, config.address, config.phone,
    config.reservation_voucher_terms
  FROM public.store_configs AS config
  WHERE config.tenant_id = v_terminal.tenant_id AND config.unit_id = v_terminal.unit_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_pos_store_profile() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_store_profile() TO authenticated;

-- ---- 4. Reserva com CPF e encomenda (copia da 20261017 + trechos novos) ----
-- 7 -> 8 parametros (p_customer_cpf no fim). O PDV antigo deixa de reservar:
-- aplicar junto com o PDV novo.
DROP FUNCTION IF EXISTS public.reserve_pos_cart(TEXT, TEXT, TIMESTAMPTZ, NUMERIC, TEXT, JSONB, TEXT);
CREATE FUNCTION public.reserve_pos_cart(
  p_customer_name TEXT,
  p_customer_phone TEXT,
  p_expires_at TIMESTAMPTZ,
  p_deposit_amount NUMERIC,
  p_deposit_payment_method TEXT,
  p_items JSONB,
  p_seller_code TEXT DEFAULT NULL,
  p_customer_cpf TEXT DEFAULT NULL
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
  v_seller public.pdv_operators%ROWTYPE;
  v_backorder BOOLEAN;
  v_customer_cpf TEXT := regexp_replace(COALESCE(p_customer_cpf, ''), '[^0-9]', '', 'g');
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

  -- Vendedor obrigatorio: e ele quem fica com a venda quando a reserva for convertida.
  v_seller := public.resolve_pos_seller(v_terminal.tenant_id, v_terminal.unit_id, p_seller_code);
  IF v_seller.id IS NULL THEN
    RAISE EXCEPTION 'Código de vendedor inválido para esta loja';
  END IF;

  IF NULLIF(BTRIM(p_customer_name), '') IS NULL THEN RAISE EXCEPTION 'Customer name is required'; END IF;
  -- CPF obrigatorio: o voucher e o documento de garantia da reserva.
  IF length(v_customer_cpf) <> 11 THEN RAISE EXCEPTION 'Customer CPF is required'; END IF;
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
    deposit_amount, deposit_payment_method, created_by, created_by_name,
    seller_id, seller_code, seller_name, customer_cpf
  ) VALUES (
    v_reservation_id, v_terminal.tenant_id, v_terminal.unit_id, v_terminal.id,
    BTRIM(p_customer_name), NULLIF(BTRIM(p_customer_phone), ''), p_expires_at,
    p_deposit_amount, CASE WHEN p_deposit_amount > 0 THEN p_deposit_payment_method ELSE NULL END,
    auth.uid()::TEXT, v_terminal.display_name,
    v_seller.id, v_seller.code, v_seller.name, v_customer_cpf
  );

  FOR item IN SELECT entries.value FROM jsonb_array_elements(p_items) AS entries(value) LOOP
    IF UPPER(COALESCE(item->>'itemType', 'PRODUCT')) <> 'PRODUCT' THEN
      RAISE EXCEPTION 'Only products can be reserved';
    END IF;
    v_product_id := item->>'productId';
    v_quantity := (item->>'quantity')::INTEGER;
    v_discount := COALESCE(NULLIF(item->>'discountPercent', '')::NUMERIC, 0);
    -- Encomenda: produto sem estoque agora, reservado para quando chegar.
    v_backorder := COALESCE(NULLIF(item->>'backorder', '')::BOOLEAN, false);
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

    IF v_serialized AND v_backorder THEN
      -- A unidade ainda nao existe: o serial e escolhido na entrega.
      IF v_quantity <> 1 OR NULLIF(item->>'serialUnitId', '') IS NOT NULL THEN
        RAISE EXCEPTION 'Backorder lines of serialized products must have quantity 1 and no unit';
      END IF;
      v_serial_unit_id := NULL;
      v_serial_number := NULL;
    ELSIF v_serialized THEN
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
    ELSIF v_backorder THEN
      -- Encomenda sem serial: nao confere estoque agora. Quando a mercadoria
      -- chegar, a quantidade fica segurada (conta como reservada).
      IF NULLIF(item->>'serialUnitId', '') IS NOT NULL THEN RAISE EXCEPTION 'Non-serialized product cannot select a serial unit'; END IF;
      v_serial_unit_id := NULL;
      v_serial_number := NULL;
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
      item_sku, item_name, unit_price, discount_percent, line_total, is_backorder
    ) VALUES (
      v_terminal.tenant_id, v_reservation_id, v_product_id, v_quantity, v_serial_unit_id, v_serial_number,
      v_sku, v_name, v_unit_price, v_discount, v_line_total, v_backorder
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

REVOKE ALL ON FUNCTION public.reserve_pos_cart(TEXT, TEXT, TIMESTAMPTZ, NUMERIC, TEXT, JSONB, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reserve_pos_cart(TEXT, TEXT, TIMESTAMPTZ, NUMERIC, TEXT, JSONB, TEXT, TEXT) TO authenticated;

-- ---- 5. Lista de reservas com CPF e itens de encomenda ----
DROP FUNCTION IF EXISTS public.list_pos_reservations();
CREATE FUNCTION public.list_pos_reservations()
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
  items JSONB,
  seller_code TEXT,
  seller_name TEXT,
  customer_cpf TEXT
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
      'lineTotal', reservation_item.line_total,
      'isBackorder', reservation_item.is_backorder,
      'isSerialized', COALESCE((
        SELECT product.is_serialized FROM public.products AS product
        WHERE product.tenant_id = reservation_item.tenant_id AND product.id = reservation_item.product_id
      ), false)
    ) ORDER BY reservation_item.created_at) FILTER (WHERE reservation_item.id IS NOT NULL), '[]'::JSONB),
    reservation.seller_code, reservation.seller_name, reservation.customer_cpf
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

-- ---- 6. Venda: entrega de encomenda com serial (mesma assinatura e retorno) ----
-- Unico trecho novo: linha de reserva marcada como encomenda e sem unidade recebe
-- a unidade escolhida no PDV (item.serialUnitId), que precisa estar DISPONIVEL.
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
  p_admin_password TEXT DEFAULT NULL,
  p_seller_code TEXT DEFAULT NULL
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
  v_backorder_unit_id UUID;
  v_backorder_serial TEXT;
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
  v_finalizer public.pdv_operators%ROWTYPE;
  v_seller_id UUID;
  v_seller_code TEXT;
  v_seller_name TEXT;
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

  -- ---- Vendedor que esta finalizando (obrigatorio, antes de qualquer escrita) ----
  -- Codigo invalido nao gera excecao: devolve o status para o PDV pedir de novo.
  v_finalizer := public.resolve_pos_seller(v_terminal.tenant_id, v_terminal.unit_id, p_seller_code);
  IF v_finalizer.id IS NULL THEN
    RETURN jsonb_build_object('status', 'INVALID_SELLER');
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

  -- Venda de reserva fica com quem iniciou a reserva (comissao de quem atendeu o
  -- cliente); quem finaliza fica registrado a parte. Reserva antiga sem vendedor:
  -- a venda fica com quem finaliza.
  IF p_reservation_id IS NOT NULL AND v_reservation.seller_id IS NOT NULL THEN
    v_seller_id := v_reservation.seller_id;
    v_seller_code := v_reservation.seller_code;
    v_seller_name := v_reservation.seller_name;
  ELSE
    v_seller_id := v_finalizer.id;
    v_seller_code := v_finalizer.code;
    v_seller_name := v_finalizer.name;
  END IF;

  INSERT INTO public.sales (
    id, tenant_id, cash_session_id, invoice_number, unit_id, items, payment_method, gross_amount, fee_amount,
    net_amount, operator_id, operator_name, client_cpf, client_name, timestamp, status, requires_approval,
    reservation_deposit_applied,
    seller_id, seller_code, seller_name, finalized_by_id, finalized_by_code, finalized_by_name
  ) VALUES (
    p_sale_id, v_terminal.tenant_id, v_cash.id, p_invoice_number, v_terminal.unit_id, p_items, p_payment_method,
    p_gross_amount, p_fee_amount, p_net_amount, v_terminal.id::TEXT, v_terminal.display_name,
    p_client_cpf, p_client_name, p_timestamp, p_status, p_requires_approval, 0,
    v_seller_id, v_seller_code, v_seller_name, v_finalizer.id, v_finalizer.code, v_finalizer.name
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

        IF is_serialized_product AND v_reservation_item.serial_unit_id IS NULL
          AND v_reservation_item.is_backorder THEN
          -- Encomenda com serial: na entrega o vendedor escolhe uma unidade que chegou.
          IF item_quantity <> 1 THEN RAISE EXCEPTION 'Serialized reservation line is invalid'; END IF;
          v_backorder_unit_id := NULLIF(item->>'serialUnitId', '')::UUID;
          IF v_backorder_unit_id IS NULL THEN
            RAISE EXCEPTION 'Select the arrived unit for the backorder line';
          END IF;
          UPDATE public.product_serial_units
          SET status = 'VENDIDO', sale_id = p_sale_id
          WHERE id = v_backorder_unit_id
            AND tenant_id = v_terminal.tenant_id AND product_id = item_product_id
            AND unit_id = v_terminal.unit_id AND status = 'DISPONIVEL'
          RETURNING serial_number INTO v_backorder_serial;
          IF NOT FOUND THEN RAISE EXCEPTION 'Selected serialized unit is not available'; END IF;
          -- Guarda na reserva qual unidade foi entregue.
          UPDATE public.product_reservation_items
          SET serial_unit_id = v_backorder_unit_id, serial_number = v_backorder_serial
          WHERE id = v_reservation_item.id AND tenant_id = v_terminal.tenant_id;
          item_serials := jsonb_build_array(v_backorder_serial);
          SELECT COALESCE(unit.unit_cost, item_default_cost) INTO item_cost_total
          FROM public.product_serial_units AS unit
          WHERE unit.id = v_backorder_unit_id AND unit.tenant_id = v_terminal.tenant_id;
        ELSIF is_serialized_product THEN
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
  TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, UUID, JSONB, TEXT, TEXT
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_pos_terminal_sale(
  TEXT, TEXT, JSONB, TEXT, NUMERIC, NUMERIC, NUMERIC,
  TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, UUID, JSONB, TEXT, TEXT
) TO authenticated;

COMMIT;
