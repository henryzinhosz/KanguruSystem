-- =========================================================================
-- Troca Gamer pelo PDV (desenho aprovado em 2026-10-29).
-- O vendedor registra a compra do videogame usado no PDV (cliente do cadastro,
-- serial, itens, estado, valor, forma de pagamento) e imprime o termo; o ERP so
-- confere e estoca (fluxo de aprovacao ja existente).
-- Formas: VALE (vale-troca no CPF, igual ao da devolucao), DINHEIRO (sai do caixa
-- como sangria "Troca Gamer nº X") e PIX; dinheiro e Pix pedem a senha administrativa.
-- Aditiva: nenhuma RPC de venda, caixa, fechamento ou devolucao muda.
-- =========================================================================

-- ---- 1. Colunas novas ----
ALTER TABLE public.trade_ins
  ADD COLUMN IF NOT EXISTS trade_number INTEGER,
  ADD COLUMN IF NOT EXISTS seller_phone TEXT,
  ADD COLUMN IF NOT EXISTS seller_address TEXT,
  ADD COLUMN IF NOT EXISTS seller_document TEXT,
  ADD COLUMN IF NOT EXISTS customer_id UUID REFERENCES public.customers(id),
  ADD COLUMN IF NOT EXISTS serial_number TEXT,
  ADD COLUMN IF NOT EXISTS imei TEXT,
  ADD COLUMN IF NOT EXISTS accessories TEXT,
  ADD COLUMN IF NOT EXISTS payment_method TEXT,
  ADD COLUMN IF NOT EXISTS terminal_id UUID REFERENCES public.pos_terminals(id),
  ADD COLUMN IF NOT EXISTS cash_session_id UUID REFERENCES public.cash_register_sessions(id),
  ADD COLUMN IF NOT EXISTS staff_code TEXT,
  ADD COLUMN IF NOT EXISTS staff_name TEXT,
  ADD COLUMN IF NOT EXISTS customer_credit_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trade_ins_payment_method_check') THEN
    ALTER TABLE public.trade_ins ADD CONSTRAINT trade_ins_payment_method_check
      CHECK (payment_method IS NULL OR payment_method IN ('VALE', 'DINHEIRO', 'PIX'));
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS trade_ins_number_idx
  ON public.trade_ins (tenant_id, unit_id, trade_number) WHERE trade_number IS NOT NULL;

-- Texto do termo editavel por loja (nulo = texto padrao do PDV).
ALTER TABLE public.store_configs ADD COLUMN IF NOT EXISTS trade_in_terms TEXT;

-- Vale-troca pode nascer de uma Troca Gamer.
ALTER TABLE public.customer_credits ADD COLUMN IF NOT EXISTS origin_trade_in_id TEXT;

-- Senha administrativa ganha o contexto da Troca Gamer (pagamento em dinheiro/Pix).
ALTER TABLE public.pos_admin_password_attempts DROP CONSTRAINT IF EXISTS pos_admin_password_attempts_context_check;
ALTER TABLE public.pos_admin_password_attempts ADD CONSTRAINT pos_admin_password_attempts_context_check
  CHECK (context IN ('UNLOCK', 'DISCOUNT_APPROVAL', 'SALE_RETURN', 'TRADE_IN_PAYOUT'));

-- ---- 2. Registro pelo PDV ----
-- Cliente precisa estar no cadastro (o PDV cadastra antes). Devolve os dados do termo.
CREATE OR REPLACE FUNCTION public.register_pos_trade_in(
  p_customer_cpf TEXT,
  p_document TEXT,
  p_description TEXT,
  p_serial TEXT,
  p_imei TEXT,
  p_accessories TEXT,
  p_condition TEXT,
  p_amount NUMERIC,
  p_payment_method TEXT,
  p_seller_code TEXT,
  p_admin_password TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_cash public.cash_register_sessions%ROWTYPE;
  v_customer public.customers%ROWTYPE;
  v_seller public.pdv_operators%ROWTYPE;
  v_cpf TEXT := regexp_replace(COALESCE(p_customer_cpf, ''), '\D', '', 'g');
  v_method TEXT := UPPER(COALESCE(p_payment_method, ''));
  v_serial TEXT := UPPER(BTRIM(COALESCE(p_serial, '')));
  v_imei TEXT := NULLIF(regexp_replace(COALESCE(p_imei, ''), '\D', '', 'g'), '');
  v_amount NUMERIC(12, 2);
  v_password_check JSONB;
  v_number INTEGER;
  v_id TEXT := 't_' || replace(gen_random_uuid()::TEXT, '-', '');
  v_address TEXT;
  v_credit_id UUID;
  v_terms TEXT;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;
  SELECT * INTO v_cash FROM public.cash_register_sessions
  WHERE terminal_id = v_terminal.id AND status = 'ABERTO'
  ORDER BY opened_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Abra o caixa para registrar a Troca Gamer';
  END IF;

  IF v_method NOT IN ('VALE', 'DINHEIRO', 'PIX') THEN
    RAISE EXCEPTION 'Forma de pagamento inválida';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> ROUND(p_amount, 2) THEN
    RAISE EXCEPTION 'Informe o valor da troca';
  END IF;
  v_amount := p_amount;
  IF NULLIF(BTRIM(COALESCE(p_description, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Informe o modelo do videogame';
  END IF;
  IF v_serial = '' THEN
    RAISE EXCEPTION 'Informe o número de série do videogame';
  END IF;
  IF v_imei IS NOT NULL AND v_imei !~ '^[0-9]{15}$' THEN
    RAISE EXCEPTION 'IMEI inválido: são 15 números';
  END IF;
  IF COALESCE(p_condition, '') NOT IN ('Excelente', 'Bom', 'Com defeito') THEN
    RAISE EXCEPTION 'Estado do videogame inválido';
  END IF;

  SELECT * INTO v_customer FROM public.customers WHERE tenant_id = v_terminal.tenant_id AND cpf = v_cpf;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'CUSTOMER_REQUIRED');
  END IF;

  v_seller := public.resolve_pos_seller(v_terminal.tenant_id, v_terminal.unit_id, p_seller_code);
  IF v_seller.id IS NULL THEN
    RETURN jsonb_build_object('status', 'INVALID_SELLER');
  END IF;

  -- Serial ja no estoque ou em outra troca em aberto: provavel erro de digitacao ou aparelho repetido.
  IF EXISTS (
    SELECT 1 FROM public.product_serial_units
    WHERE tenant_id = v_terminal.tenant_id AND LOWER(serial_number) = LOWER(v_serial) AND status IN ('DISPONIVEL', 'RESERVADO')
  ) OR EXISTS (
    SELECT 1 FROM public.trade_ins
    WHERE tenant_id = v_terminal.tenant_id AND LOWER(serial_number) = LOWER(v_serial) AND status = 'AVALIADO'
  ) THEN
    RETURN jsonb_build_object('status', 'SERIAL_EXISTS');
  END IF;

  IF v_method IN ('DINHEIRO', 'PIX') THEN
    IF p_admin_password IS NULL OR p_admin_password = '' THEN
      RETURN jsonb_build_object('status', 'PASSWORD_REQUIRED');
    END IF;
    v_password_check := public.check_pos_admin_password(v_terminal.id, p_admin_password, 'TRADE_IN_PAYOUT');
    IF v_password_check->>'status' = 'LOCKED' THEN
      RETURN jsonb_build_object('status', 'LOCKED', 'lockedUntil', v_password_check->'lockedUntil');
    ELSIF v_password_check->>'status' <> 'OK' THEN
      RETURN jsonb_build_object('status', 'INVALID_PASSWORD', 'remainingAttempts', v_password_check->'remainingAttempts');
    END IF;
  END IF;

  v_address := NULLIF(concat_ws(', ',
    NULLIF(BTRIM(v_customer.address), ''),
    NULLIF(BTRIM(v_customer.address_number), ''),
    NULLIF(BTRIM(v_customer.complement), ''),
    NULLIF(BTRIM(v_customer.district), ''),
    NULLIF(concat_ws('/', NULLIF(BTRIM(v_customer.city), ''), NULLIF(BTRIM(v_customer.state), '')), ''),
    CASE WHEN NULLIF(BTRIM(v_customer.cep), '') IS NULL THEN NULL ELSE 'CEP ' || BTRIM(v_customer.cep) END
  ), '');

  PERFORM pg_advisory_xact_lock(hashtext('trade_in:' || v_terminal.tenant_id::TEXT || ':' || v_terminal.unit_id));
  SELECT COALESCE(MAX(trade_number), 0) + 1 INTO v_number
  FROM public.trade_ins WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id;

  INSERT INTO public.trade_ins (
    id, tenant_id, seller_name, seller_cpf, item_description, category, condition, valuation_amount,
    operator_id, operator_name, unit_id, "timestamp", status, trade_number, seller_phone, seller_address,
    seller_document, customer_id, serial_number, imei, accessories, payment_method, terminal_id,
    cash_session_id, staff_code, staff_name
  ) VALUES (
    v_id, v_terminal.tenant_id, v_customer.name, v_customer.cpf, BTRIM(p_description), 'Videogames', p_condition, v_amount,
    v_terminal.id::TEXT, v_seller.name, v_terminal.unit_id, NOW(), 'AVALIADO', v_number, v_customer.phone, v_address,
    NULLIF(BTRIM(COALESCE(p_document, '')), ''), v_customer.id, v_serial, v_imei, NULLIF(BTRIM(COALESCE(p_accessories, '')), ''),
    v_method, v_terminal.id, v_cash.id, v_seller.code, v_seller.name
  );

  IF v_method = 'VALE' THEN
    INSERT INTO public.customer_credits (tenant_id, unit_id, customer_cpf, amount, balance, origin_trade_in_id)
    VALUES (v_terminal.tenant_id, v_terminal.unit_id, v_customer.cpf, v_amount, v_amount, v_id)
    RETURNING id INTO v_credit_id;
    INSERT INTO public.customer_credit_movements (tenant_id, credit_id, kind, amount)
    VALUES (v_terminal.tenant_id, v_credit_id, 'EMISSAO', v_amount);
    UPDATE public.trade_ins SET customer_credit_id = v_credit_id WHERE id = v_id;
  ELSIF v_method = 'DINHEIRO' THEN
    -- Sai da gaveta: entra no fechamento como sangria.
    INSERT INTO public.cash_register_movements (cash_session_id, tenant_id, unit_id, terminal_id, type, amount, reason, operator_name)
    VALUES (v_cash.id, v_terminal.tenant_id, v_terminal.unit_id, v_terminal.id, 'SANGRIA', v_amount,
      'Troca Gamer nº ' || v_number || ' - ' || v_customer.name, v_seller.name);
  END IF;

  SELECT trade_in_terms INTO v_terms FROM public.store_configs
  WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id;

  RETURN jsonb_build_object(
    'status', 'OK',
    'tradeInId', v_id,
    'tradeNumber', v_number,
    'createdAt', NOW(),
    'customerName', v_customer.name,
    'customerCpf', v_customer.cpf,
    'customerPhone', v_customer.phone,
    'customerAddress', v_address,
    'document', NULLIF(BTRIM(COALESCE(p_document, '')), ''),
    'description', BTRIM(p_description),
    'serialNumber', v_serial,
    'imei', v_imei,
    'accessories', NULLIF(BTRIM(COALESCE(p_accessories, '')), ''),
    'condition', p_condition,
    'amount', v_amount,
    'paymentMethod', v_method,
    'staffCode', v_seller.code,
    'staffName', v_seller.name,
    'terms', v_terms
  );
END;
$$;

REVOKE ALL ON FUNCTION public.register_pos_trade_in(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_pos_trade_in(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT) TO authenticated;
