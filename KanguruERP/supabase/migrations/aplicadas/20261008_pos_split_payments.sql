BEGIN;

-- =========================================================================
-- Fase 2.7 — Pagamento dividido e aprovacao de desconto por senha
-- Mudanca aditiva: chamadas antigas a process_pos_terminal_sale continuam
-- funcionando (parametros novos sao DEFAULT NULL e sao tratados como
-- "venda legada de pagamento unico e sem desconto acima do limite").
-- =========================================================================

-- ---- Linhas de pagamento da venda (valor APLICADO; troco nao entra) ----
CREATE TABLE IF NOT EXISTS public.sale_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  terminal_id UUID NOT NULL REFERENCES public.pos_terminals(id),
  cash_session_id UUID NOT NULL REFERENCES public.cash_register_sessions(id),
  sale_id TEXT NOT NULL,
  payment_method TEXT NOT NULL
    CHECK (payment_method IN ('DINHEIRO', 'PIX', 'CREDITO', 'DEBITO', 'VOUCHER', 'CREDIARIO')),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  installments SMALLINT NOT NULL DEFAULT 1 CHECK (installments >= 1),
  created_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sale_payments_store_fk
    FOREIGN KEY (tenant_id, unit_id) REFERENCES public.store_configs(tenant_id, unit_id) ON DELETE RESTRICT,
  CONSTRAINT sale_payments_sale_fk
    FOREIGN KEY (tenant_id, sale_id) REFERENCES public.sales(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS sale_payments_cash_idx
  ON public.sale_payments(cash_session_id, payment_method);
CREATE INDEX IF NOT EXISTS sale_payments_sale_idx
  ON public.sale_payments(tenant_id, sale_id);

-- ---- Auditoria: um registro por item liberado acima do limite ----
CREATE TABLE IF NOT EXISTS public.sale_discount_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  terminal_id UUID NOT NULL REFERENCES public.pos_terminals(id),
  cash_session_id UUID NOT NULL REFERENCES public.cash_register_sessions(id),
  sale_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('PRODUCT', 'SERVICE')),
  product_id TEXT,
  service_id TEXT,
  item_sku TEXT,
  item_name TEXT,
  discount_percent NUMERIC(5, 2) NOT NULL,
  store_limit_percent NUMERIC(5, 2) NOT NULL,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sale_discount_approvals_store_fk
    FOREIGN KEY (tenant_id, unit_id) REFERENCES public.store_configs(tenant_id, unit_id) ON DELETE RESTRICT,
  CONSTRAINT sale_discount_approvals_sale_fk
    FOREIGN KEY (tenant_id, sale_id) REFERENCES public.sales(tenant_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS sale_discount_approvals_sale_idx
  ON public.sale_discount_approvals(tenant_id, sale_id);

-- ---- Tentativas de senha administrativa (contador de bloqueio + historico) ----
CREATE TABLE IF NOT EXISTS public.pos_admin_password_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  terminal_id UUID NOT NULL REFERENCES public.pos_terminals(id),
  context TEXT NOT NULL CHECK (context IN ('UNLOCK', 'DISCOUNT_APPROVAL')),
  success BOOLEAN NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pos_admin_password_attempts_terminal_idx
  ON public.pos_admin_password_attempts(terminal_id, attempted_at DESC);

-- ---- RLS ----
-- sale_payments e sale_discount_approvals: leitura pelo ERP (mesmo tenant e
-- loja com acesso). Escrita somente via RPC SECURITY DEFINER.
-- pos_admin_password_attempts: somente via funcoes SECURITY DEFINER.
ALTER TABLE public.sale_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_discount_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_admin_password_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sale_payments, public.sale_discount_approvals, public.pos_admin_password_attempts
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sale_payments, public.sale_discount_approvals TO authenticated;

DROP POLICY IF EXISTS sale_payments_read ON public.sale_payments;
CREATE POLICY sale_payments_read ON public.sale_payments
  FOR SELECT
  USING (
    tenant_id = public.current_user_tenant_id()
    AND public.current_user_has_store_access(tenant_id, unit_id)
  );

DROP POLICY IF EXISTS sale_discount_approvals_read ON public.sale_discount_approvals;
CREATE POLICY sale_discount_approvals_read ON public.sale_discount_approvals
  FOR SELECT
  USING (
    tenant_id = public.current_user_tenant_id()
    AND public.current_user_has_store_access(tenant_id, unit_id)
  );

-- =========================================================================
-- check_pos_admin_password: confere a senha administrativa do terminal com
-- limite de tentativas. Nunca levanta excecao por senha errada, para que a
-- tentativa registrada sobreviva (quem chama decide o que responder).
-- Regra: no maximo 5 erros a cada 15 minutos (janela deslizante, zerada por
-- um acerto). Bloqueado: a senha nem e conferida e nada e registrado.
-- Retorno: {status: OK | INVALID | LOCKED, remainingAttempts?, lockedUntil?}
-- Uso interno: sem GRANT para authenticated.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.check_pos_admin_password(
  p_terminal_id UUID,
  p_password TEXT,
  p_context TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  c_max_failures CONSTANT INTEGER := 5;
  c_window CONSTANT INTERVAL := INTERVAL '15 minutes';
  v_terminal public.pos_terminals%ROWTYPE;
  v_last_success TIMESTAMPTZ;
  v_lock_anchor TIMESTAMPTZ;
  v_recent_failures INTEGER;
BEGIN
  -- FOR UPDATE serializa tentativas simultaneas do mesmo terminal.
  SELECT * INTO v_terminal FROM public.pos_terminals
  WHERE id = p_terminal_id AND is_active
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active terminal session required'; END IF;
  IF v_terminal.admin_password_hash IS NULL THEN
    RAISE EXCEPTION 'Administrative password is not configured';
  END IF;

  SELECT MAX(attempt.attempted_at) INTO v_last_success
  FROM public.pos_admin_password_attempts AS attempt
  WHERE attempt.terminal_id = p_terminal_id AND attempt.success;

  -- Bloqueado enquanto o 5o erro mais recente (desde o ultimo acerto)
  -- estiver dentro da janela.
  SELECT attempt.attempted_at INTO v_lock_anchor
  FROM public.pos_admin_password_attempts AS attempt
  WHERE attempt.terminal_id = p_terminal_id AND NOT attempt.success
    AND attempt.attempted_at > COALESCE(v_last_success, '-infinity'::TIMESTAMPTZ)
  ORDER BY attempt.attempted_at DESC
  OFFSET c_max_failures - 1 LIMIT 1;
  IF v_lock_anchor IS NOT NULL AND v_lock_anchor + c_window > NOW() THEN
    RETURN jsonb_build_object('status', 'LOCKED', 'lockedUntil', v_lock_anchor + c_window);
  END IF;

  IF p_password IS NOT NULL AND p_password <> ''
    AND v_terminal.admin_password_hash = crypt(p_password, v_terminal.admin_password_hash) THEN
    INSERT INTO public.pos_admin_password_attempts (tenant_id, terminal_id, context, success)
    VALUES (v_terminal.tenant_id, p_terminal_id, p_context, TRUE);
    RETURN jsonb_build_object('status', 'OK');
  END IF;

  INSERT INTO public.pos_admin_password_attempts (tenant_id, terminal_id, context, success)
  VALUES (v_terminal.tenant_id, p_terminal_id, p_context, FALSE);

  SELECT COUNT(*)::INTEGER INTO v_recent_failures
  FROM public.pos_admin_password_attempts AS attempt
  WHERE attempt.terminal_id = p_terminal_id AND NOT attempt.success
    AND attempt.attempted_at > COALESCE(v_last_success, '-infinity'::TIMESTAMPTZ)
    AND attempt.attempted_at > NOW() - c_window;

  RETURN jsonb_build_object(
    'status', 'INVALID',
    'remainingAttempts', GREATEST(0, c_max_failures - v_recent_failures)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.check_pos_admin_password(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- =========================================================================
-- unlock_pos_terminal: mesma assinatura e retorno de antes, agora com
-- limite de tentativas. Senha errada devolve ZERO linhas (sem excecao, para
-- a tentativa ficar registrada); terminal bloqueado levanta excecao.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.unlock_pos_terminal(p_password TEXT)
RETURNS TABLE (
  terminal_id UUID,
  terminal_name TEXT,
  tenant_id UUID,
  unit_id TEXT,
  trade_name TEXT,
  legal_name TEXT,
  cnpj TEXT,
  address TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_terminal_id UUID;
  v_check JSONB;
BEGIN
  SELECT terminal.id INTO v_terminal_id
  FROM public.pos_terminals AS terminal
  WHERE terminal.device_auth_uid = auth.uid() AND terminal.is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invalid administrative password'; END IF;

  v_check := public.check_pos_admin_password(v_terminal_id, p_password, 'UNLOCK');
  IF v_check->>'status' = 'LOCKED' THEN
    RAISE EXCEPTION 'Administrative password locked until %', v_check->>'lockedUntil';
  END IF;
  IF v_check->>'status' <> 'OK' THEN
    RETURN;
  END IF;

  UPDATE public.pos_terminals AS terminal
  SET last_unlocked_at = NOW()
  WHERE terminal.id = v_terminal_id;

  RETURN QUERY
  SELECT terminal.id, terminal.display_name, terminal.tenant_id, terminal.unit_id,
    config.trade_name, config.legal_name, config.cnpj, config.address
  FROM public.pos_terminals AS terminal
  JOIN public.store_configs AS config
    ON config.tenant_id = terminal.tenant_id AND config.unit_id = terminal.unit_id
  WHERE terminal.id = v_terminal_id;
END;
$$;

REVOKE ALL ON FUNCTION public.unlock_pos_terminal(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unlock_pos_terminal(TEXT) TO authenticated;

-- =========================================================================
-- process_pos_terminal_sale: novos parametros opcionais
--   p_payments JSONB      -- lista {paymentMethod, amount, installments?};
--                            NULL = legado (usa p_payment_method)
--   p_admin_password TEXT -- senha administrativa para liberar desconto
--                            acima de max_item_discount_percent
-- Retorno (JSONB):
--   {status: 'OK'}
--   {status: 'INVALID_PASSWORD', remainingAttempts}  -- nada da venda gravado
--   {status: 'LOCKED', lockedUntil}                  -- nada da venda gravado
-- =========================================================================

DROP FUNCTION IF EXISTS public.process_pos_terminal_sale(
  TEXT, TEXT, JSONB, TEXT, NUMERIC, NUMERIC, NUMERIC,
  TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, UUID
);
DROP FUNCTION IF EXISTS public.process_pos_terminal_sale(
  TEXT, TEXT, JSONB, TEXT, NUMERIC, NUMERIC, NUMERIC,
  TEXT, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN, UUID, JSONB, TEXT
);
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
    ELSIF item_type = 'PRODUCT' THEN
      item_service_id := NULL;
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

-- =========================================================================
-- get_pos_cash_closure_summary: vendas com linhas em sale_payments somam por
-- linha (valor ja liquido do sinal); vendas sem linhas usam o campo legado e
-- subtraem o sinal. Vendas canceladas nao entram em nenhum dos caminhos.
-- =========================================================================

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
  ), split_totals AS (
    -- Vendas com linhas de pagamento: cada linha conta em seu metodo.
    SELECT payment.cash_session_id,
      COALESCE(SUM(payment.amount) FILTER (WHERE payment.payment_method = 'DINHEIRO'), 0) AS cash_amount,
      COALESCE(SUM(payment.amount) FILTER (WHERE payment.payment_method = 'PIX'), 0) AS pix_amount,
      COALESCE(SUM(payment.amount) FILTER (WHERE payment.payment_method = 'CREDITO'), 0) AS credit_amount,
      COALESCE(SUM(payment.amount) FILTER (WHERE payment.payment_method = 'DEBITO'), 0) AS debit_amount,
      COALESCE(SUM(payment.amount) FILTER (WHERE payment.payment_method = 'VOUCHER'), 0) AS voucher_amount,
      COALESCE(SUM(payment.amount) FILTER (WHERE payment.payment_method = 'CREDIARIO'), 0) AS credit_account_amount
    FROM public.sale_payments AS payment
    JOIN active_cash AS cash ON cash.id = payment.cash_session_id
    JOIN public.sales AS sale ON sale.tenant_id = payment.tenant_id AND sale.id = payment.sale_id
    WHERE sale.status <> 'CANCELADA'
    GROUP BY payment.cash_session_id
  ), legacy_totals AS (
    -- Vendas sem linhas em sale_payments: usa o campo legado.
    -- Ajusta pelo sinal ja descontado em reservation_deposit_applied.
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
      AND NOT EXISTS (
        SELECT 1 FROM public.sale_payments AS payment
        WHERE payment.tenant_id = sale.tenant_id AND payment.sale_id = sale.id
      )
    GROUP BY sale.cash_session_id
  ), sales_totals AS (
    SELECT
      COALESCE(split.cash_session_id, legacy.cash_session_id) AS cash_session_id,
      COALESCE(split.cash_amount, 0) + COALESCE(legacy.cash_amount, 0) AS cash_amount,
      COALESCE(split.pix_amount, 0) + COALESCE(legacy.pix_amount, 0) AS pix_amount,
      COALESCE(split.credit_amount, 0) + COALESCE(legacy.credit_amount, 0) AS credit_amount,
      COALESCE(split.debit_amount, 0) + COALESCE(legacy.debit_amount, 0) AS debit_amount,
      COALESCE(split.voucher_amount, 0) + COALESCE(legacy.voucher_amount, 0) AS voucher_amount,
      COALESCE(split.credit_account_amount, 0) + COALESCE(legacy.credit_account_amount, 0) AS credit_account_amount
    FROM split_totals AS split
    FULL OUTER JOIN legacy_totals AS legacy ON legacy.cash_session_id = split.cash_session_id
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
