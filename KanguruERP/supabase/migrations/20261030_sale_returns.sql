-- 2.9: Trocas e devolucoes (desenho aprovado 2026-10-27).
-- Devolucao parcial pelo PDV (tela Cupons e notas), na loja da venda. O cliente recebe:
-- TROCA (vale usado na hora numa venda nova), VALE (vale-troca no CPF), DINHEIRO, PIX ou
-- estorno no cartao (CREDITO/DEBITO, feito na maquininha). Prazo padrao 7 dias por loja;
-- fora do prazo ou com dinheiro saindo exige a senha administrativa. Produto volta ao
-- estoque ou vai para "avariados". Venda com NFC-e autorizada gera NF-e de devolucao
-- (CFOP 1202) pela Edge Function nfe-return-emit.
-- Mudancas em funcoes existentes (aditivas): get_pos_cash_closure_summary desconta as
-- devolucoes em dinheiro/PIX/cartao; get_pos_cash_session_report ganha as devolucoes.
-- A funcao de venda NAO muda: o vale-troca e o metodo VOUCHER, debitado por trigger a partir
-- do CPF da venda; o estorno de uma venda paga com vale devolve o saldo.
BEGIN;

-- ---- 1. Prazo de troca por loja ----
ALTER TABLE public.store_configs ADD COLUMN IF NOT EXISTS exchange_days INTEGER NOT NULL DEFAULT 7;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_configs_exchange_days_check') THEN
    ALTER TABLE public.store_configs ADD CONSTRAINT store_configs_exchange_days_check CHECK (exchange_days BETWEEN 0 AND 365);
  END IF;
END;
$$;

-- ---- 2. Avariados ----
-- Serializados: unidade com status AVARIADO (fora da venda). Demais: saldo por loja.
ALTER TABLE public.product_serial_units DROP CONSTRAINT IF EXISTS product_serial_units_status_check;
ALTER TABLE public.product_serial_units ADD CONSTRAINT product_serial_units_status_check
  CHECK (status IN ('DISPONIVEL', 'VENDIDO', 'RESERVADO', 'PERDIDO', 'AVARIADO'));

CREATE TABLE IF NOT EXISTS public.product_damaged_stock (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, unit_id, product_id),
  CONSTRAINT product_damaged_stock_product_fk
    FOREIGN KEY (tenant_id, product_id) REFERENCES public.products(tenant_id, id) ON DELETE RESTRICT
);

ALTER TABLE public.product_damaged_stock ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS product_damaged_stock_read ON public.product_damaged_stock;
CREATE POLICY product_damaged_stock_read ON public.product_damaged_stock
  FOR SELECT USING (public.current_user_has_store_access(tenant_id, unit_id));
REVOKE ALL ON public.product_damaged_stock FROM PUBLIC, anon;
GRANT SELECT ON public.product_damaged_stock TO authenticated;

-- A senha administrativa ganha o contexto da devolucao.
ALTER TABLE public.pos_admin_password_attempts DROP CONSTRAINT IF EXISTS pos_admin_password_attempts_context_check;
ALTER TABLE public.pos_admin_password_attempts ADD CONSTRAINT pos_admin_password_attempts_context_check
  CHECK (context IN ('UNLOCK', 'DISCOUNT_APPROVAL', 'SALE_RETURN'));

-- ---- 3. Devolucoes ----
CREATE TABLE IF NOT EXISTS public.sale_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  terminal_id UUID NOT NULL REFERENCES public.pos_terminals(id),
  cash_session_id UUID NOT NULL REFERENCES public.cash_register_sessions(id),
  sale_id TEXT NOT NULL,
  return_number INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (NULLIF(BTRIM(reason), '') IS NOT NULL),
  refund_method TEXT NOT NULL CHECK (refund_method IN ('TROCA', 'VALE', 'DINHEIRO', 'PIX', 'CREDITO', 'DEBITO')),
  total_amount NUMERIC(12, 2) NOT NULL CHECK (total_amount > 0),
  customer_cpf TEXT,
  customer_name TEXT,
  customer_credit_id UUID,
  out_of_period BOOLEAN NOT NULL DEFAULT false,
  password_approved BOOLEAN NOT NULL DEFAULT false,
  operator_name TEXT NOT NULL,
  fiscal_status TEXT CHECK (fiscal_status IS NULL OR fiscal_status IN ('PENDENTE', 'AUTORIZADA', 'ERRO')),
  nfe_ref TEXT,
  nfe_environment TEXT,
  nfe_number TEXT,
  nfe_series TEXT,
  nfe_key TEXT,
  nfe_protocol TEXT,
  nfe_xml_url TEXT,
  nfe_danfe_url TEXT,
  nfe_message TEXT,
  nfe_authorized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sale_returns_sale_fk FOREIGN KEY (tenant_id, sale_id) REFERENCES public.sales(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT sale_returns_number_key UNIQUE (tenant_id, unit_id, return_number)
);

CREATE INDEX IF NOT EXISTS sale_returns_sale_idx ON public.sale_returns (tenant_id, sale_id);
CREATE INDEX IF NOT EXISTS sale_returns_cash_idx ON public.sale_returns (cash_session_id, refund_method);

CREATE TABLE IF NOT EXISTS public.sale_return_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  return_id UUID NOT NULL REFERENCES public.sale_returns(id) ON DELETE CASCADE,
  sale_id TEXT NOT NULL,
  item_index INTEGER NOT NULL CHECK (item_index >= 0),
  product_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  item_sku TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  serials JSONB NOT NULL DEFAULT '[]'::JSONB,
  unit_amount NUMERIC(12, 4) NOT NULL,
  line_amount NUMERIC(12, 2) NOT NULL,
  unit_cost NUMERIC(12, 4),
  destination TEXT NOT NULL CHECK (destination IN ('ESTOQUE', 'AVARIADO'))
);

CREATE INDEX IF NOT EXISTS sale_return_items_sale_idx ON public.sale_return_items (tenant_id, sale_id, item_index);

ALTER TABLE public.sale_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_return_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sale_returns_read ON public.sale_returns;
CREATE POLICY sale_returns_read ON public.sale_returns
  FOR SELECT USING (public.current_user_has_store_access(tenant_id, unit_id));
DROP POLICY IF EXISTS sale_return_items_read ON public.sale_return_items;
CREATE POLICY sale_return_items_read ON public.sale_return_items
  FOR SELECT USING (EXISTS (
    SELECT 1 FROM public.sale_returns AS sale_return
    WHERE sale_return.id = return_id AND public.current_user_has_store_access(sale_return.tenant_id, sale_return.unit_id)
  ));
REVOKE ALL ON public.sale_returns, public.sale_return_items FROM PUBLIC, anon;
GRANT SELECT ON public.sale_returns, public.sale_return_items TO authenticated;

-- ---- 4. Vale-troca (credito no CPF do cliente) ----
CREATE TABLE IF NOT EXISTS public.customer_credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  customer_cpf TEXT NOT NULL CHECK (customer_cpf ~ '^[0-9]{11}$'),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  balance NUMERIC(12, 2) NOT NULL CHECK (balance >= 0),
  origin_return_id UUID REFERENCES public.sale_returns(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS customer_credits_cpf_idx ON public.customer_credits (tenant_id, customer_cpf, created_at);

CREATE TABLE IF NOT EXISTS public.customer_credit_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  credit_id UUID NOT NULL REFERENCES public.customer_credits(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('EMISSAO', 'USO', 'ESTORNO_USO')),
  amount NUMERIC(12, 2) NOT NULL,
  sale_id TEXT,
  return_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS customer_credit_movements_sale_idx ON public.customer_credit_movements (tenant_id, sale_id);

ALTER TABLE public.customer_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_credit_movements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_credits_read ON public.customer_credits;
CREATE POLICY customer_credits_read ON public.customer_credits
  FOR SELECT USING (public.current_user_can_access_tenant(tenant_id));
DROP POLICY IF EXISTS customer_credit_movements_read ON public.customer_credit_movements;
CREATE POLICY customer_credit_movements_read ON public.customer_credit_movements
  FOR SELECT USING (public.current_user_can_access_tenant(tenant_id));
REVOKE ALL ON public.customer_credits, public.customer_credit_movements FROM PUBLIC, anon;
GRANT SELECT ON public.customer_credits, public.customer_credit_movements TO authenticated;

-- Pagamento VOUCHER = vale-troca: debita os vales do CPF da venda (mais antigos primeiro).
-- Roda dentro da transacao da venda: saldo insuficiente desfaz a venda inteira.
CREATE OR REPLACE FUNCTION public.redeem_sale_voucher_payment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cpf TEXT;
  v_remaining NUMERIC(12, 2) := NEW.amount;
  v_credit RECORD;
  v_take NUMERIC(12, 2);
BEGIN
  IF NEW.payment_method <> 'VOUCHER' THEN
    RETURN NEW;
  END IF;
  SELECT regexp_replace(COALESCE(sale.client_cpf, ''), '\D', '', 'g') INTO v_cpf
  FROM public.sales AS sale
  WHERE sale.tenant_id = NEW.tenant_id AND sale.id = NEW.sale_id;
  IF COALESCE(v_cpf, '') = '' THEN
    RAISE EXCEPTION 'Vale-troca exige o CPF do cliente na venda';
  END IF;

  FOR v_credit IN
    SELECT credit.id, credit.balance FROM public.customer_credits AS credit
    WHERE credit.tenant_id = NEW.tenant_id AND credit.customer_cpf = v_cpf AND credit.balance > 0
    ORDER BY credit.created_at
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := LEAST(v_credit.balance, v_remaining);
    UPDATE public.customer_credits SET balance = balance - v_take WHERE id = v_credit.id;
    INSERT INTO public.customer_credit_movements (tenant_id, credit_id, kind, amount, sale_id)
    VALUES (NEW.tenant_id, v_credit.id, 'USO', -v_take, NEW.sale_id);
    v_remaining := v_remaining - v_take;
  END LOOP;

  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'Saldo de vale-troca insuficiente para este CPF';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_sale_voucher_payment() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_sale_payment_voucher ON public.sale_payments;
CREATE TRIGGER zz_sale_payment_voucher
  AFTER INSERT ON public.sale_payments
  FOR EACH ROW EXECUTE FUNCTION public.redeem_sale_voucher_payment();

-- Estorno: venda com devolucao nao pode ser estornada (devolveria o estoque duas vezes);
-- venda paga com vale-troca devolve o saldo usado.
CREATE OR REPLACE FUNCTION public.guard_sale_cancellation_returns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_use RECORD;
BEGIN
  IF NEW.status = 'CANCELADA' AND OLD.status IS DISTINCT FROM 'CANCELADA' THEN
    IF EXISTS (SELECT 1 FROM public.sale_returns WHERE tenant_id = NEW.tenant_id AND sale_id = NEW.id) THEN
      RAISE EXCEPTION 'Venda com troca/devolução registrada não pode ser estornada';
    END IF;
    FOR v_use IN
      SELECT movement.credit_id, -SUM(movement.amount) AS used
      FROM public.customer_credit_movements AS movement
      WHERE movement.tenant_id = NEW.tenant_id AND movement.sale_id = NEW.id
        AND movement.kind IN ('USO', 'ESTORNO_USO')
      GROUP BY movement.credit_id
      HAVING -SUM(movement.amount) > 0
    LOOP
      UPDATE public.customer_credits SET balance = balance + v_use.used WHERE id = v_use.credit_id;
      INSERT INTO public.customer_credit_movements (tenant_id, credit_id, kind, amount, sale_id)
      VALUES (NEW.tenant_id, v_use.credit_id, 'ESTORNO_USO', v_use.used, NEW.id);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_sale_cancellation_returns() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_sale_cancellation_returns ON public.sales;
CREATE TRIGGER zz_sale_cancellation_returns
  BEFORE UPDATE OF status ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.guard_sale_cancellation_returns();

-- ---- 5. RPCs do PDV (sessao de terminal) ----
-- Itens da venda com o que ainda pode ser devolvido.
CREATE OR REPLACE FUNCTION public.get_pos_sale_returnable(p_sale_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_sale public.sales%ROWTYPE;
  v_days INTEGER;
  v_cpf TEXT;
  v_address_ok BOOLEAN := false;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;
  SELECT * INTO v_sale FROM public.sales
  WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id AND id = p_sale_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT exchange_days INTO v_days FROM public.store_configs
  WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id;
  v_cpf := NULLIF(regexp_replace(COALESCE(v_sale.client_cpf, ''), '\D', '', 'g'), '');
  IF v_cpf IS NOT NULL THEN
    SELECT (NULLIF(BTRIM(customer.address), '') IS NOT NULL AND NULLIF(BTRIM(customer.address_number), '') IS NOT NULL
      AND NULLIF(BTRIM(customer.district), '') IS NOT NULL AND NULLIF(BTRIM(customer.city), '') IS NOT NULL
      AND NULLIF(BTRIM(customer.state), '') IS NOT NULL AND NULLIF(BTRIM(customer.cep), '') IS NOT NULL)
    INTO v_address_ok
    FROM public.customers AS customer
    WHERE customer.tenant_id = v_terminal.tenant_id AND customer.cpf = v_cpf;
  END IF;

  RETURN jsonb_build_object(
    'saleId', v_sale.id,
    'receiptNumber', v_sale.receipt_number,
    'timestamp', v_sale."timestamp",
    'status', v_sale.status,
    'fiscalStatus', v_sale.fiscal_status,
    'nfceNumber', v_sale.nfce_number,
    'clientCpf', v_cpf,
    'clientName', v_sale.client_name,
    'customerAddressComplete', COALESCE(v_address_ok, false),
    'exchangeDays', COALESCE(v_days, 7),
    'deadline', v_sale."timestamp" + make_interval(days => COALESCE(v_days, 7)),
    'withinPeriod', NOW() <= v_sale."timestamp" + make_interval(days => COALESCE(v_days, 7)),
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'index', entry.idx - 1,
        'itemType', UPPER(COALESCE(entry.item->>'itemType', 'PRODUCT')),
        'productId', entry.item->>'productId',
        'name', entry.item->>'itemName',
        'sku', entry.item->>'itemSku',
        'quantity', COALESCE((entry.item->>'quantity')::INTEGER, 0),
        'unitAmount', ROUND(COALESCE((entry.item->>'lineTotal')::NUMERIC, 0) / NULLIF((entry.item->>'quantity')::NUMERIC, 0), 4),
        'serials', COALESCE(entry.item->'serials', '[]'::JSONB),
        'returnedQuantity', COALESCE((
          SELECT SUM(returned.quantity) FROM public.sale_return_items AS returned
          WHERE returned.tenant_id = v_sale.tenant_id AND returned.sale_id = v_sale.id AND returned.item_index = entry.idx - 1
        ), 0),
        'returnedSerials', COALESCE((
          SELECT jsonb_agg(serial) FROM public.sale_return_items AS returned,
            jsonb_array_elements_text(returned.serials) AS serial
          WHERE returned.tenant_id = v_sale.tenant_id AND returned.sale_id = v_sale.id AND returned.item_index = entry.idx - 1
        ), '[]'::JSONB)
      ) ORDER BY entry.idx)
      FROM jsonb_array_elements(COALESCE(v_sale.items, '[]'::JSONB)) WITH ORDINALITY AS entry(item, idx)
    ), '[]'::JSONB),
    'returns', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'returnId', sale_return.id, 'returnNumber', sale_return.return_number, 'createdAt', sale_return.created_at,
        'refundMethod', sale_return.refund_method, 'totalAmount', sale_return.total_amount,
        'fiscalStatus', sale_return.fiscal_status, 'nfeNumber', sale_return.nfe_number
      ) ORDER BY sale_return.created_at)
      FROM public.sale_returns AS sale_return
      WHERE sale_return.tenant_id = v_sale.tenant_id AND sale_return.sale_id = v_sale.id
    ), '[]'::JSONB)
  );
END;
$$;

-- Registra a devolucao. p_items: [{ "index": 0, "quantity": 1, "serials": ["SN1"], "destination": "ESTOQUE" }]
-- Retorno: { status: OK | PASSWORD_REQUIRED | INVALID_PASSWORD | LOCKED | CUSTOMER_REQUIRED |
--            CUSTOMER_ADDRESS_REQUIRED, returnId, returnNumber, totalAmount, creditId }
CREATE OR REPLACE FUNCTION public.process_pos_sale_return(
  p_sale_id TEXT,
  p_items JSONB,
  p_reason TEXT,
  p_refund_method TEXT,
  p_customer_cpf TEXT DEFAULT NULL,
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
  v_sale public.sales%ROWTYPE;
  v_days INTEGER;
  v_out_of_period BOOLEAN;
  v_method TEXT := UPPER(COALESCE(p_refund_method, ''));
  v_needs_password BOOLEAN;
  v_password_check JSONB;
  v_cpf TEXT;
  v_customer public.customers%ROWTYPE;
  v_return_id UUID := gen_random_uuid();
  v_return_number INTEGER;
  v_total NUMERIC(12, 2) := 0;
  v_credit_id UUID;
  v_entry JSONB;
  v_item JSONB;
  v_index INTEGER;
  v_quantity INTEGER;
  v_destination TEXT;
  v_serials JSONB;
  v_sold_serials JSONB;
  v_already INTEGER;
  v_product_id TEXT;
  v_is_serialized BOOLEAN;
  v_unit_amount NUMERIC;
  v_line_amount NUMERIC(12, 2);
  v_unit_cost NUMERIC;
  v_updated INTEGER;
  v_inv public.inventory%ROWTYPE;
  v_current_qty INTEGER;
  v_serial TEXT;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;
  SELECT * INTO v_cash FROM public.cash_register_sessions
  WHERE terminal_id = v_terminal.id AND status = 'ABERTO'
  ORDER BY opened_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Abra o caixa para registrar a devolução';
  END IF;
  IF v_method NOT IN ('TROCA', 'VALE', 'DINHEIRO', 'PIX', 'CREDITO', 'DEBITO') THEN
    RAISE EXCEPTION 'Forma de devolução inválida';
  END IF;
  IF NULLIF(BTRIM(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Informe o motivo da troca/devolução';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Selecione os itens devolvidos';
  END IF;

  -- Troca so na loja da venda.
  SELECT * INTO v_sale FROM public.sales
  WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id AND id = p_sale_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Venda não encontrada nesta loja';
  END IF;
  IF v_sale.status <> 'CONCLUIDA' THEN
    RAISE EXCEPTION 'Só vendas concluídas podem ter troca/devolução';
  END IF;

  SELECT exchange_days INTO v_days FROM public.store_configs
  WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id;
  v_out_of_period := NOW() > v_sale."timestamp" + make_interval(days => COALESCE(v_days, 7));

  -- Cliente: obrigatorio no vale/troca e quando a venda teve NFC-e (a NF-e de devolucao
  -- precisa do CPF e do endereco completo do consumidor).
  v_cpf := NULLIF(regexp_replace(COALESCE(p_customer_cpf, v_sale.client_cpf, ''), '\D', '', 'g'), '');
  IF v_cpf IS NOT NULL THEN
    SELECT * INTO v_customer FROM public.customers WHERE tenant_id = v_terminal.tenant_id AND cpf = v_cpf;
  END IF;
  IF (v_method IN ('TROCA', 'VALE') OR v_sale.fiscal_status = 'AUTORIZADA')
     AND (v_cpf IS NULL OR NOT public.is_valid_cpf(v_cpf)) THEN
    RETURN jsonb_build_object('status', 'CUSTOMER_REQUIRED');
  END IF;
  IF v_sale.fiscal_status = 'AUTORIZADA' AND (
    v_customer.id IS NULL OR NULLIF(BTRIM(v_customer.address), '') IS NULL OR NULLIF(BTRIM(v_customer.address_number), '') IS NULL
    OR NULLIF(BTRIM(v_customer.district), '') IS NULL OR NULLIF(BTRIM(v_customer.city), '') IS NULL
    OR NULLIF(BTRIM(v_customer.state), '') IS NULL OR NULLIF(BTRIM(v_customer.cep), '') IS NULL
  ) THEN
    RETURN jsonb_build_object('status', 'CUSTOMER_ADDRESS_REQUIRED');
  END IF;

  -- Senha: dinheiro saindo (dinheiro, PIX, cartao) ou fora do prazo.
  v_needs_password := v_method IN ('DINHEIRO', 'PIX', 'CREDITO', 'DEBITO') OR v_out_of_period;
  IF v_needs_password THEN
    IF p_admin_password IS NULL OR p_admin_password = '' THEN
      RETURN jsonb_build_object('status', 'PASSWORD_REQUIRED', 'outOfPeriod', v_out_of_period);
    END IF;
    v_password_check := public.check_pos_admin_password(v_terminal.id, p_admin_password, 'SALE_RETURN');
    IF v_password_check->>'status' = 'LOCKED' THEN
      RETURN jsonb_build_object('status', 'LOCKED', 'lockedUntil', v_password_check->'lockedUntil');
    ELSIF v_password_check->>'status' <> 'OK' THEN
      RETURN jsonb_build_object('status', 'INVALID_PASSWORD', 'remainingAttempts', v_password_check->'remainingAttempts');
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('sale_return:' || v_terminal.tenant_id::TEXT || ':' || v_terminal.unit_id));
  SELECT COALESCE(MAX(return_number), 0) + 1 INTO v_return_number
  FROM public.sale_returns WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id;

  INSERT INTO public.sale_returns (
    id, tenant_id, unit_id, terminal_id, cash_session_id, sale_id, return_number, reason, refund_method,
    total_amount, customer_cpf, customer_name, out_of_period, password_approved, operator_name, fiscal_status
  ) VALUES (
    v_return_id, v_terminal.tenant_id, v_terminal.unit_id, v_terminal.id, v_cash.id, v_sale.id, v_return_number,
    BTRIM(p_reason), v_method, 0.01, v_cpf, COALESCE(v_customer.name, v_sale.client_name), v_out_of_period,
    v_needs_password, v_terminal.display_name,
    CASE WHEN v_sale.fiscal_status = 'AUTORIZADA' THEN 'PENDENTE' ELSE NULL END
  );

  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    v_index := (v_entry->>'index')::INTEGER;
    v_quantity := (v_entry->>'quantity')::INTEGER;
    v_destination := UPPER(COALESCE(v_entry->>'destination', 'ESTOQUE'));
    v_serials := COALESCE(v_entry->'serials', '[]'::JSONB);
    IF v_destination NOT IN ('ESTOQUE', 'AVARIADO') THEN
      RAISE EXCEPTION 'Destino inválido para o item devolvido';
    END IF;
    IF v_index IS NULL OR v_index < 0 OR v_index >= jsonb_array_length(COALESCE(v_sale.items, '[]'::JSONB)) THEN
      RAISE EXCEPTION 'Item inválido na devolução';
    END IF;
    IF v_quantity IS NULL OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Quantidade inválida na devolução';
    END IF;
    v_item := v_sale.items -> v_index;
    IF UPPER(COALESCE(v_item->>'itemType', 'PRODUCT')) <> 'PRODUCT' THEN
      RAISE EXCEPTION 'Serviços não podem ser devolvidos';
    END IF;
    v_product_id := v_item->>'productId';
    SELECT COALESCE(SUM(quantity), 0) INTO v_already FROM public.sale_return_items
    WHERE tenant_id = v_sale.tenant_id AND sale_id = v_sale.id AND item_index = v_index;
    IF v_already + v_quantity > COALESCE((v_item->>'quantity')::INTEGER, 0) THEN
      RAISE EXCEPTION 'Quantidade devolvida maior que a vendida (%)', v_item->>'itemName';
    END IF;

    SELECT COALESCE(product.is_serialized, false) INTO v_is_serialized
    FROM public.products AS product WHERE product.tenant_id = v_sale.tenant_id AND product.id = v_product_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Produto % não encontrado', v_product_id;
    END IF;

    v_unit_amount := COALESCE((v_item->>'lineTotal')::NUMERIC, 0) / NULLIF((v_item->>'quantity')::NUMERIC, 0);
    v_line_amount := ROUND(v_unit_amount * v_quantity, 2);
    -- Custo congelado na venda (o mesmo do estorno); venda antiga sem custo usa a media atual.
    v_unit_cost := COALESCE(
      NULLIF(v_item->>'costTotal', '')::NUMERIC / NULLIF((v_item->>'quantity')::NUMERIC, 0),
      public.get_store_avg_cost(v_sale.tenant_id, v_product_id, v_sale.unit_id)
    );

    IF v_is_serialized THEN
      IF jsonb_typeof(v_serials) <> 'array' OR jsonb_array_length(v_serials) <> v_quantity THEN
        RAISE EXCEPTION 'Informe o serial de cada unidade devolvida (%)', v_item->>'itemName';
      END IF;
      v_sold_serials := COALESCE(v_item->'serials', '[]'::JSONB);
      FOR v_serial IN SELECT value FROM jsonb_array_elements_text(v_serials) LOOP
        IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_sold_serials) AS sold WHERE LOWER(sold) = LOWER(v_serial)) THEN
          RAISE EXCEPTION 'Serial % não pertence a esta venda', v_serial;
        END IF;
      END LOOP;
      UPDATE public.product_serial_units
      SET status = CASE WHEN v_destination = 'AVARIADO' THEN 'AVARIADO' ELSE 'DISPONIVEL' END,
          sale_id = NULL, updated_at = NOW()
      WHERE tenant_id = v_sale.tenant_id AND product_id = v_product_id AND sale_id = v_sale.id
        AND status = 'VENDIDO'
        AND LOWER(serial_number) IN (SELECT LOWER(value) FROM jsonb_array_elements_text(v_serials));
      GET DIAGNOSTICS v_updated = ROW_COUNT;
      IF v_updated <> v_quantity THEN
        RAISE EXCEPTION 'Uma ou mais unidades já foram devolvidas (%)', v_item->>'itemName';
      END IF;
    ELSIF v_destination = 'ESTOQUE' THEN
      SELECT * INTO v_inv FROM public.inventory
      WHERE tenant_id = v_sale.tenant_id AND product_id = v_product_id FOR UPDATE;
      IF NOT FOUND THEN
        INSERT INTO public.inventory (tenant_id, product_id, quantities, updated_at)
        VALUES (v_sale.tenant_id, v_product_id, '{}'::JSONB, NOW());
        SELECT * INTO v_inv FROM public.inventory
        WHERE tenant_id = v_sale.tenant_id AND product_id = v_product_id FOR UPDATE;
      END IF;
      v_inv.quantities := public.inventory_with_unit(v_inv.quantities, v_sale.unit_id);
      v_current_qty := COALESCE((v_inv.quantities -> v_sale.unit_id ->> 'qty')::INTEGER, 0);
      PERFORM public.apply_store_cost_entry(v_sale.tenant_id, v_product_id, v_sale.unit_id, v_current_qty, v_quantity, v_unit_cost);
      UPDATE public.inventory
      SET quantities = jsonb_set(v_inv.quantities, ARRAY[v_sale.unit_id, 'qty'], to_jsonb(v_current_qty + v_quantity), true),
          updated_at = NOW()
      WHERE tenant_id = v_sale.tenant_id AND product_id = v_product_id;
    ELSE
      INSERT INTO public.product_damaged_stock (tenant_id, unit_id, product_id, quantity)
      VALUES (v_sale.tenant_id, v_sale.unit_id, v_product_id, v_quantity)
      ON CONFLICT (tenant_id, unit_id, product_id)
      DO UPDATE SET quantity = public.product_damaged_stock.quantity + EXCLUDED.quantity, updated_at = NOW();
    END IF;

    INSERT INTO public.movements (
      id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
      serials, card_condition, operator_id, operator_name, timestamp, reason, unit_cost
    ) VALUES (
      gen_random_uuid()::TEXT, v_sale.tenant_id, v_product_id, NULL, 'CLIENTE',
      CASE WHEN v_destination = 'AVARIADO' THEN 'AVARIADOS' ELSE v_sale.unit_id END,
      'ENTRADA', v_quantity, CASE WHEN jsonb_array_length(v_serials) > 0 THEN v_serials ELSE NULL END, NULL,
      v_terminal.id::TEXT, v_terminal.display_name, NOW(),
      'Devolução nº ' || v_return_number || ' da venda (cupom ' || COALESCE(v_sale.receipt_number::TEXT, v_sale.id) || ')'
        || CASE WHEN v_destination = 'AVARIADO' THEN ' - avariado' ELSE '' END,
      ROUND(v_unit_cost, 4)
    );

    INSERT INTO public.sale_return_items (
      tenant_id, return_id, sale_id, item_index, product_id, item_name, item_sku, quantity, serials,
      unit_amount, line_amount, unit_cost, destination
    ) VALUES (
      v_sale.tenant_id, v_return_id, v_sale.id, v_index, v_product_id, COALESCE(v_item->>'itemName', ''),
      v_item->>'itemSku', v_quantity, v_serials, ROUND(v_unit_amount, 4), v_line_amount, ROUND(v_unit_cost, 4), v_destination
    );
    v_total := v_total + v_line_amount;
  END LOOP;

  IF v_total <= 0 THEN
    RAISE EXCEPTION 'Valor da devolução inválido';
  END IF;
  UPDATE public.sale_returns SET total_amount = v_total WHERE id = v_return_id;

  IF v_method IN ('TROCA', 'VALE') THEN
    INSERT INTO public.customer_credits (tenant_id, unit_id, customer_cpf, amount, balance, origin_return_id)
    VALUES (v_terminal.tenant_id, v_terminal.unit_id, v_cpf, v_total, v_total, v_return_id)
    RETURNING id INTO v_credit_id;
    INSERT INTO public.customer_credit_movements (tenant_id, credit_id, kind, amount, return_id)
    VALUES (v_terminal.tenant_id, v_credit_id, 'EMISSAO', v_total, v_return_id);
    UPDATE public.sale_returns SET customer_credit_id = v_credit_id WHERE id = v_return_id;
  END IF;

  RETURN jsonb_build_object(
    'status', 'OK', 'returnId', v_return_id, 'returnNumber', v_return_number,
    'totalAmount', v_total, 'creditId', v_credit_id, 'outOfPeriod', v_out_of_period,
    'needsFiscalNote', v_sale.fiscal_status = 'AUTORIZADA'
  );
END;
$$;

-- Saldo de vale-troca do CPF (qualquer loja do franqueado).
CREATE OR REPLACE FUNCTION public.get_pos_customer_credit(p_cpf TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_cpf TEXT := regexp_replace(COALESCE(p_cpf, ''), '\D', '', 'g');
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;
  RETURN jsonb_build_object('balance', COALESCE((
    SELECT SUM(balance) FROM public.customer_credits
    WHERE tenant_id = v_terminal.tenant_id AND customer_cpf = v_cpf
  ), 0));
END;
$$;

-- Dados do comprovante de troca/devolucao (reimpressao).
CREATE OR REPLACE FUNCTION public.get_pos_sale_return(p_return_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_return public.sale_returns%ROWTYPE;
  v_sale public.sales%ROWTYPE;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;
  SELECT * INTO v_return FROM public.sale_returns
  WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id AND id = p_return_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_sale FROM public.sales WHERE tenant_id = v_return.tenant_id AND id = v_return.sale_id;
  RETURN jsonb_build_object(
    'returnId', v_return.id, 'returnNumber', v_return.return_number, 'createdAt', v_return.created_at,
    'saleId', v_return.sale_id, 'saleReceiptNumber', v_sale.receipt_number, 'saleTimestamp', v_sale."timestamp",
    'reason', v_return.reason, 'refundMethod', v_return.refund_method, 'totalAmount', v_return.total_amount,
    'customerCpf', v_return.customer_cpf, 'customerName', v_return.customer_name,
    'operatorName', v_return.operator_name, 'outOfPeriod', v_return.out_of_period,
    'creditBalance', (SELECT balance FROM public.customer_credits WHERE id = v_return.customer_credit_id),
    'fiscalStatus', v_return.fiscal_status, 'nfeNumber', v_return.nfe_number, 'nfeSeries', v_return.nfe_series,
    'nfeKey', v_return.nfe_key, 'nfeMessage', v_return.nfe_message,
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'name', item.item_name, 'sku', item.item_sku, 'quantity', item.quantity, 'serials', item.serials,
        'lineAmount', item.line_amount, 'destination', item.destination
      ) ORDER BY item.item_index)
      FROM public.sale_return_items AS item WHERE item.return_id = v_return.id
    ), '[]'::JSONB)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_pos_sale_returnable(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.process_pos_sale_return(TEXT, JSONB, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_pos_customer_credit(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_pos_sale_return(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_sale_returnable(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_pos_sale_return(TEXT, JSONB, TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_pos_customer_credit(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_pos_sale_return(UUID) TO authenticated;

-- ---- 6. Fechamento de caixa: copia da 20261008 + devolucoes (CTE return_refunds) ----
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
  ), return_refunds AS (
    -- 2.9: devolucoes com dinheiro saindo (troca e vale-troca nao saem do caixa).
    SELECT sale_return.cash_session_id,
      COALESCE(SUM(sale_return.total_amount) FILTER (WHERE sale_return.refund_method = 'DINHEIRO'), 0) AS cash_amount,
      COALESCE(SUM(sale_return.total_amount) FILTER (WHERE sale_return.refund_method = 'PIX'), 0) AS pix_amount,
      COALESCE(SUM(sale_return.total_amount) FILTER (WHERE sale_return.refund_method = 'CREDITO'), 0) AS credit_amount,
      COALESCE(SUM(sale_return.total_amount) FILTER (WHERE sale_return.refund_method = 'DEBITO'), 0) AS debit_amount
    FROM public.sale_returns AS sale_return
    JOIN active_cash AS cash ON cash.id = sale_return.cash_session_id
    GROUP BY sale_return.cash_session_id
  )
  SELECT cash.id, cash.cash_number, cash.opened_at, cash.opened_by_name, cash.opening_float_amount,
    cash.opening_float_amount + COALESCE(sales.cash_amount, 0) + COALESCE(movement.supplies_amount, 0)
      - COALESCE(movement.withdrawals_amount, 0) + COALESCE(payment.cash_amount, 0) - COALESCE(refund.cash_amount, 0),
    COALESCE(sales.pix_amount, 0) + COALESCE(payment.pix_amount, 0) - COALESCE(refund.pix_amount, 0),
    COALESCE(sales.credit_amount, 0) + COALESCE(payment.credit_amount, 0) - COALESCE(refund.credit_amount, 0),
    COALESCE(sales.debit_amount, 0) + COALESCE(payment.debit_amount, 0) - COALESCE(refund.debit_amount, 0),
    COALESCE(sales.voucher_amount, 0), COALESCE(sales.credit_account_amount, 0),
    COALESCE(movement.supplies_amount, 0), COALESCE(movement.withdrawals_amount, 0)
  FROM active_cash AS cash
  LEFT JOIN sales_totals AS sales ON sales.cash_session_id = cash.id
  LEFT JOIN movement_totals AS movement ON movement.cash_session_id = cash.id
  LEFT JOIN reservation_payment_totals AS payment ON payment.cash_session_id = cash.id
  LEFT JOIN return_refunds AS refund ON refund.cash_session_id = cash.id;
$$;

-- ---- 7. Relatorio do fechamento (20261029) + devolucoes ----
CREATE OR REPLACE FUNCTION public.get_pos_cash_session_report()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_cash public.cash_register_sessions%ROWTYPE;
  v_result JSONB;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;

  SELECT * INTO v_cash FROM public.cash_register_sessions
  WHERE terminal_id = v_terminal.id AND status = 'ABERTO'
  ORDER BY opened_at DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  WITH session_sales AS (
    SELECT sale.*,
      EXISTS (
        SELECT 1 FROM public.product_reservations AS reservation
        WHERE reservation.tenant_id = sale.tenant_id AND reservation.sale_id = sale.id
      ) AS from_reservation,
      COALESCE((
        SELECT SUM(COALESCE((item->>'unitPrice')::NUMERIC, 0) * COALESCE((item->>'quantity')::NUMERIC, 0))
        FROM jsonb_array_elements(COALESCE(sale.items, '[]'::JSONB)) AS item
      ), 0) AS list_total
    FROM public.sales AS sale
    WHERE sale.tenant_id = v_cash.tenant_id AND sale.cash_session_id = v_cash.id
  ), deposits AS (
    SELECT
      COALESCE(SUM(payment.amount) FILTER (WHERE payment.event_type = 'DEPOSITO'), 0) AS received,
      COALESCE(SUM(payment.amount) FILTER (WHERE payment.event_type = 'DEVOLUCAO'), 0) AS refunded
    FROM public.pos_reservation_payments AS payment
    WHERE payment.tenant_id = v_cash.tenant_id AND payment.cash_session_id = v_cash.id
  )
  SELECT jsonb_build_object(
    'sessionNumber', (
      SELECT COUNT(*) FROM public.cash_register_sessions AS session
      WHERE session.terminal_id = v_terminal.id AND session.opened_at <= v_cash.opened_at
    ),
    'terminalName', v_terminal.display_name,
    'saleCount', COUNT(*) FILTER (WHERE status <> 'CANCELADA'),
    'listTotal', COALESCE(SUM(list_total) FILTER (WHERE status <> 'CANCELADA'), 0),
    'grossTotal', COALESCE(SUM(gross_amount) FILTER (WHERE status <> 'CANCELADA'), 0),
    'directTotal', COALESCE(SUM(gross_amount) FILTER (WHERE status <> 'CANCELADA' AND NOT from_reservation), 0),
    'reservationTotal', COALESCE(SUM(gross_amount) FILTER (WHERE status <> 'CANCELADA' AND from_reservation), 0),
    'nfceCount', COUNT(*) FILTER (WHERE status <> 'CANCELADA' AND fiscal_status = 'AUTORIZADA'),
    'nonFiscalCount', COUNT(*) FILTER (WHERE status <> 'CANCELADA' AND fiscal_status IS DISTINCT FROM 'AUTORIZADA'),
    'cancelledCount', COUNT(*) FILTER (WHERE status = 'CANCELADA'),
    'cancelledTotal', COALESCE(SUM(gross_amount) FILTER (WHERE status = 'CANCELADA'), 0),
    'depositsReceived', (SELECT received FROM deposits),
    'depositsRefunded', (SELECT refunded FROM deposits),
    'returnCount', (SELECT COUNT(*) FROM public.sale_returns WHERE cash_session_id = v_cash.id),
    'returnRefunds', COALESCE((SELECT SUM(total_amount) FROM public.sale_returns
      WHERE cash_session_id = v_cash.id AND refund_method IN ('DINHEIRO', 'PIX', 'CREDITO', 'DEBITO')), 0),
    'returnCredits', COALESCE((SELECT SUM(total_amount) FROM public.sale_returns
      WHERE cash_session_id = v_cash.id AND refund_method IN ('TROCA', 'VALE')), 0)
  ) INTO v_result
  FROM session_sales;

  RETURN v_result;
END;
$$;

COMMIT;
