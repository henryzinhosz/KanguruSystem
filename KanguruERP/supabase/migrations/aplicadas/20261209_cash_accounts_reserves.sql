-- =========================================================================
-- Caixa e Bancos + Reserva de reposição por fornecedor (desenho aprovado em 2026-11-23).
--
-- 1. Caixa e Bancos: contas de dinheiro por loja (ex.: Gaveta e Stone) com saldo inicial
--    informado pelo dono. O saldo anda sozinho:
--    - Conta do PDV (gaveta): vale o valor CONTADO no último fechamento do caixa; depois
--      dele somam só os lançamentos de dias seguintes (o dia do fechamento já está na contagem).
--    - Conta dos repasses (Stone): soma o que o dono CONFERIU em Recebimentos (o que caiu de fato).
--    - Contas a pagar pagas, contas a receber recebidas, Troca Gamer paga em Pix e devolução
--      paga em Pix entram na conta da forma de pagamento (configurável por loja).
--    - Lançamentos manuais: aporte, empréstimo do sócio, devolução ao sócio, retirada,
--      transferência entre contas e ajuste. Aporte/empréstimo passado no cartão do sócio:
--      a taxa vira despesa da loja e o líquido entra pelo repasse conferido (não soma duas vezes).
-- 2. Reserva de reposição: o custo de cada produto vendido vai para a reserva do fornecedor
--    da marca (marcas ligadas em suppliers.brands; sem fornecedor = "Outros"); pagar uma conta
--    de mercadoria do fornecedor consome a reserva. Livre = saldo total - reservas.
--
-- Aditiva: 2 colunas, 2 tabelas (leitura pela RLS da loja, escrita só pelas RPCs), funções
-- novas e gatilhos do registro de ações. Nenhuma função existente muda.
-- Conferido no banco em 2026-11-23: suppliers (id, name, cnpj, contact, category,
-- history_count, phone, website, created_at, tenant_id), cash_register_sessions
-- (counted_cash_amount, closed_at, status, unit_id), 0 fornecedores cadastrados.
-- =========================================================================

-- ---- 1. Colunas ----
ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS brands TEXT[] NOT NULL DEFAULT '{}';

-- {pdvCashAccountId, payoutAccountId, methodAccounts: {DINHEIRO, PIX, ...}, reserveStartDate}
-- Nulo ou chave ausente = padrão (dinheiro na gaveta, o resto no banco, cartão em nenhuma).
ALTER TABLE public.store_configs
  ADD COLUMN IF NOT EXISTS cash_settings JSONB;

-- ---- 2. Tabelas ----
CREATE TABLE IF NOT EXISTS public.cash_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (NULLIF(BTRIM(name), '') IS NOT NULL),
  kind TEXT NOT NULL CHECK (kind IN ('GAVETA', 'BANCO')),
  opening_balance NUMERIC(12, 2) NOT NULL DEFAULT 0,
  opening_date DATE NOT NULL, -- saldo no FIM deste dia; lançamentos contam a partir do dia seguinte
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cash_accounts_store_fk
    FOREIGN KEY (tenant_id, unit_id) REFERENCES public.store_configs(tenant_id, unit_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cash_accounts_store_idx ON public.cash_accounts (tenant_id, unit_id);

CREATE TABLE IF NOT EXISTS public.cash_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  movement_type TEXT NOT NULL CHECK (movement_type IN
    ('APORTE', 'EMPRESTIMO_SOCIO', 'DEVOLUCAO_SOCIO', 'RETIRADA', 'TRANSFERENCIA', 'AJUSTE')),
  account_id UUID NOT NULL REFERENCES public.cash_accounts(id) ON DELETE RESTRICT,
  to_account_id UUID REFERENCES public.cash_accounts(id) ON DELETE RESTRICT, -- só transferência
  direction TEXT NOT NULL CHECK (direction IN ('ENTRADA', 'SAIDA')), -- na conta account_id
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0), -- o que mexe na conta (no cartão: líquido)
  movement_date DATE NOT NULL,
  description TEXT,
  -- Passado no cartão do sócio: entra pelo repasse conferido (amount fica fora do saldo).
  via_card BOOLEAN NOT NULL DEFAULT false,
  card_gross NUMERIC(12, 2),
  card_fee NUMERIC(12, 2),
  card_installments INTEGER,
  payout_date DATE,
  expense_id TEXT, -- despesa da taxa (cash-<id>)
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT cash_movements_store_fk
    FOREIGN KEY (tenant_id, unit_id) REFERENCES public.store_configs(tenant_id, unit_id) ON DELETE CASCADE,
  CONSTRAINT cash_movements_transfer_check CHECK (
    (movement_type = 'TRANSFERENCIA' AND to_account_id IS NOT NULL AND to_account_id <> account_id)
    OR (movement_type <> 'TRANSFERENCIA' AND to_account_id IS NULL)),
  CONSTRAINT cash_movements_card_check CHECK (
    NOT via_card OR (movement_type IN ('APORTE', 'EMPRESTIMO_SOCIO') AND card_gross > 0
      AND card_fee >= 0 AND payout_date IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS cash_movements_store_idx ON public.cash_movements (tenant_id, unit_id, movement_date);

ALTER TABLE public.cash_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_movements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cash_accounts_read ON public.cash_accounts;
CREATE POLICY cash_accounts_read ON public.cash_accounts FOR SELECT TO authenticated
  USING (public.current_user_has_store_access(tenant_id, unit_id));

DROP POLICY IF EXISTS cash_movements_read ON public.cash_movements;
CREATE POLICY cash_movements_read ON public.cash_movements FOR SELECT TO authenticated
  USING (public.current_user_has_store_access(tenant_id, unit_id));

REVOKE ALL ON public.cash_accounts FROM PUBLIC, anon;
REVOKE ALL ON public.cash_movements FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.cash_accounts FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.cash_movements FROM authenticated;
GRANT SELECT ON public.cash_accounts TO authenticated;
GRANT SELECT ON public.cash_movements TO authenticated;

-- ---- 3. Funções internas (sem GRANT) ----

-- Configuração da loja com os padrões preenchidos (ids das contas como texto ou null).
CREATE OR REPLACE FUNCTION public.cash_settings_resolved(p_tenant_id UUID, p_unit_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_raw JSONB;
  v_drawer UUID;
  v_bank UUID;
  v_methods JSONB := '{}'::JSONB;
  v_key TEXT;
BEGIN
  SELECT cash_settings INTO v_raw FROM public.store_configs WHERE tenant_id = p_tenant_id AND unit_id = p_unit_id;
  v_raw := COALESCE(v_raw, '{}'::JSONB);
  SELECT id INTO v_drawer FROM public.cash_accounts
  WHERE tenant_id = p_tenant_id AND unit_id = p_unit_id AND is_active AND kind = 'GAVETA'
  ORDER BY sort_order, created_at LIMIT 1;
  SELECT id INTO v_bank FROM public.cash_accounts
  WHERE tenant_id = p_tenant_id AND unit_id = p_unit_id AND is_active AND kind = 'BANCO'
  ORDER BY sort_order, created_at LIMIT 1;

  FOREACH v_key IN ARRAY ARRAY['DINHEIRO', 'PIX', 'TRANSFERENCIA', 'BOLETO', 'DEBITO_AUTOMATICO', 'CARTAO', 'OUTRO'] LOOP
    IF jsonb_typeof(v_raw -> 'methodAccounts') = 'object' AND (v_raw -> 'methodAccounts') ? v_key THEN
      v_methods := v_methods || jsonb_build_object(v_key, v_raw -> 'methodAccounts' -> v_key);
    ELSE
      v_methods := v_methods || jsonb_build_object(v_key, CASE
        WHEN v_key = 'DINHEIRO' THEN to_jsonb(v_drawer)
        WHEN v_key IN ('CARTAO', 'OUTRO') THEN 'null'::JSONB
        ELSE to_jsonb(v_bank) END);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'pdvCashAccountId', CASE WHEN v_raw ? 'pdvCashAccountId' THEN v_raw -> 'pdvCashAccountId' ELSE to_jsonb(v_drawer) END,
    'payoutAccountId', CASE WHEN v_raw ? 'payoutAccountId' THEN v_raw -> 'payoutAccountId' ELSE to_jsonb(v_bank) END,
    'methodAccounts', v_methods,
    'reserveStartDate', v_raw -> 'reserveStartDate'
  );
END;
$$;

-- Só o dono da empresa (com acesso à loja) mexe nas contas e na configuração.
CREATE OR REPLACE FUNCTION public.cash_admin_actor(p_unit_id TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name TEXT := public.payable_actor(p_unit_id);
BEGIN
  IF NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'Só o dono da empresa altera as contas de Caixa e Bancos';
  END IF;
  RETURN v_name;
END;
$$;

-- Primeira configuração: a reserva de reposição começa a contar hoje (do zero).
CREATE OR REPLACE FUNCTION public.cash_ensure_reserve_start(p_tenant_id UUID, p_unit_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.store_configs
  SET cash_settings = COALESCE(cash_settings, '{}'::JSONB)
    || jsonb_build_object('reserveStartDate', to_char(public.payable_today(), 'YYYY-MM-DD'))
  WHERE tenant_id = p_tenant_id AND unit_id = p_unit_id
    AND NULLIF(COALESCE(cash_settings, '{}'::JSONB) ->> 'reserveStartDate', '') IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.cash_settings_resolved(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cash_admin_actor(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cash_ensure_reserve_start(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- ---- 4. RPCs ----

-- Cria ou altera uma conta (nome, tipo, saldo inicial e a data desse saldo, ativa).
CREATE OR REPLACE FUNCTION public.save_cash_account(
  p_id UUID,
  p_unit_id TEXT,
  p_name TEXT,
  p_kind TEXT,
  p_opening_balance NUMERIC,
  p_opening_date DATE,
  p_is_active BOOLEAN DEFAULT true
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_id UUID;
  v_kind TEXT := UPPER(COALESCE(p_kind, ''));
BEGIN
  PERFORM public.cash_admin_actor(p_unit_id);
  IF NULLIF(BTRIM(COALESCE(p_name, '')), '') IS NULL THEN RAISE EXCEPTION 'Informe o nome da conta'; END IF;
  IF v_kind NOT IN ('GAVETA', 'BANCO') THEN RAISE EXCEPTION 'Tipo de conta inválido'; END IF;
  IF p_opening_balance IS NULL OR p_opening_balance <> ROUND(p_opening_balance, 2) THEN
    RAISE EXCEPTION 'Saldo inicial inválido';
  END IF;
  IF p_opening_date IS NULL OR p_opening_date > public.payable_today() THEN
    RAISE EXCEPTION 'A data do saldo inicial não pode ser no futuro';
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.cash_accounts (tenant_id, unit_id, name, kind, opening_balance, opening_date, is_active, sort_order)
    VALUES (v_tenant_id, p_unit_id, BTRIM(p_name), v_kind, p_opening_balance, p_opening_date, COALESCE(p_is_active, true),
      (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM public.cash_accounts WHERE tenant_id = v_tenant_id AND unit_id = p_unit_id))
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.cash_accounts SET
      name = BTRIM(p_name), kind = v_kind, opening_balance = p_opening_balance, opening_date = p_opening_date,
      is_active = COALESCE(p_is_active, true), updated_at = NOW()
    WHERE id = p_id AND tenant_id = v_tenant_id AND unit_id = p_unit_id
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Conta não encontrada'; END IF;
  END IF;

  PERFORM public.cash_ensure_reserve_start(v_tenant_id, p_unit_id);
  RETURN v_id;
END;
$$;

-- Exclui uma conta sem lançamentos manuais e fora da configuração (senão: desative).
CREATE OR REPLACE FUNCTION public.delete_cash_account(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account public.cash_accounts;
  v_raw JSONB;
BEGIN
  SELECT * INTO v_account FROM public.cash_accounts WHERE id = p_id AND tenant_id = public.current_user_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Conta não encontrada'; END IF;
  PERFORM public.cash_admin_actor(v_account.unit_id);
  IF EXISTS (SELECT 1 FROM public.cash_movements WHERE account_id = p_id OR to_account_id = p_id) THEN
    RAISE EXCEPTION 'Esta conta tem lançamentos: desative em vez de excluir';
  END IF;
  SELECT COALESCE(cash_settings, '{}'::JSONB) INTO v_raw FROM public.store_configs
  WHERE tenant_id = v_account.tenant_id AND unit_id = v_account.unit_id;
  IF v_raw::TEXT LIKE '%' || p_id::TEXT || '%' THEN
    RAISE EXCEPTION 'Esta conta está escolhida em "Para onde vai cada forma": troque lá antes de excluir';
  END IF;
  DELETE FROM public.cash_accounts WHERE id = p_id;
END;
$$;

-- Grava "para onde vai cada forma" e a data de início da reserva.
CREATE OR REPLACE FUNCTION public.save_cash_settings(p_unit_id TEXT, p_settings JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_clean JSONB := '{}'::JSONB;
  v_methods JSONB := '{}'::JSONB;
  v_key TEXT;
  v_value TEXT;
  v_start DATE;
BEGIN
  PERFORM public.cash_admin_actor(p_unit_id);
  p_settings := COALESCE(p_settings, '{}'::JSONB);

  FOREACH v_key IN ARRAY ARRAY['pdvCashAccountId', 'payoutAccountId'] LOOP
    IF p_settings ? v_key THEN
      v_value := NULLIF(p_settings ->> v_key, '');
      IF v_value IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.cash_accounts WHERE id::TEXT = v_value AND tenant_id = v_tenant_id AND unit_id = p_unit_id
      ) THEN
        RAISE EXCEPTION 'Conta inválida na configuração';
      END IF;
      v_clean := v_clean || jsonb_build_object(v_key, v_value);
    END IF;
  END LOOP;

  IF jsonb_typeof(p_settings -> 'methodAccounts') = 'object' THEN
    FOREACH v_key IN ARRAY ARRAY['DINHEIRO', 'PIX', 'TRANSFERENCIA', 'BOLETO', 'DEBITO_AUTOMATICO', 'CARTAO', 'OUTRO'] LOOP
      IF (p_settings -> 'methodAccounts') ? v_key THEN
        v_value := NULLIF(p_settings -> 'methodAccounts' ->> v_key, '');
        IF v_value IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM public.cash_accounts WHERE id::TEXT = v_value AND tenant_id = v_tenant_id AND unit_id = p_unit_id
        ) THEN
          RAISE EXCEPTION 'Conta inválida na configuração';
        END IF;
        v_methods := v_methods || jsonb_build_object(v_key, v_value);
      END IF;
    END LOOP;
    v_clean := v_clean || jsonb_build_object('methodAccounts', v_methods);
  END IF;

  IF NULLIF(p_settings ->> 'reserveStartDate', '') IS NOT NULL THEN
    BEGIN
      v_start := (p_settings ->> 'reserveStartDate')::DATE;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Data de início da reserva inválida';
    END;
    IF v_start > public.payable_today() THEN RAISE EXCEPTION 'A reserva não pode começar no futuro'; END IF;
    v_clean := v_clean || jsonb_build_object('reserveStartDate', to_char(v_start, 'YYYY-MM-DD'));
  END IF;

  UPDATE public.store_configs SET cash_settings = v_clean
  WHERE tenant_id = v_tenant_id AND unit_id = p_unit_id;
  PERFORM public.cash_ensure_reserve_start(v_tenant_id, p_unit_id);
END;
$$;

-- Lançamento manual. p_card (só aporte/empréstimo): {gross, fee, installments, payoutDate}.
CREATE OR REPLACE FUNCTION public.add_cash_movement(
  p_unit_id TEXT,
  p_type TEXT,
  p_account_id UUID,
  p_to_account_id UUID,
  p_direction TEXT,
  p_amount NUMERIC,
  p_date DATE,
  p_description TEXT,
  p_card JSONB DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_name TEXT := public.payable_actor(p_unit_id);
  v_type TEXT := UPPER(COALESCE(p_type, ''));
  v_direction TEXT;
  v_amount NUMERIC(12, 2);
  v_account UUID := p_account_id;
  v_via_card BOOLEAN := p_card IS NOT NULL AND jsonb_typeof(p_card) = 'object';
  v_gross NUMERIC(12, 2);
  v_fee NUMERIC(12, 2);
  v_installments INTEGER;
  v_payout DATE;
  v_id UUID := gen_random_uuid();
  v_expense_id TEXT;
  v_label TEXT;
BEGIN
  IF v_type NOT IN ('APORTE', 'EMPRESTIMO_SOCIO', 'DEVOLUCAO_SOCIO', 'RETIRADA', 'TRANSFERENCIA', 'AJUSTE') THEN
    RAISE EXCEPTION 'Tipo de lançamento inválido';
  END IF;
  IF p_date IS NULL OR p_date > public.payable_today() THEN
    RAISE EXCEPTION 'A data do lançamento não pode ser no futuro';
  END IF;

  v_direction := CASE
    WHEN v_type IN ('APORTE', 'EMPRESTIMO_SOCIO') THEN 'ENTRADA'
    WHEN v_type IN ('DEVOLUCAO_SOCIO', 'RETIRADA', 'TRANSFERENCIA') THEN 'SAIDA'
    ELSE UPPER(COALESCE(p_direction, '')) END;
  IF v_direction NOT IN ('ENTRADA', 'SAIDA') THEN RAISE EXCEPTION 'Informe se o ajuste é entrada ou saída'; END IF;

  IF v_via_card THEN
    IF v_type NOT IN ('APORTE', 'EMPRESTIMO_SOCIO') THEN
      RAISE EXCEPTION 'Só aporte ou empréstimo do sócio podem ser passados no cartão';
    END IF;
    v_gross := NULLIF(p_card ->> 'gross', '')::NUMERIC;
    v_fee := COALESCE(NULLIF(p_card ->> 'fee', '')::NUMERIC, 0);
    v_installments := GREATEST(1, COALESCE(NULLIF(p_card ->> 'installments', '')::INTEGER, 1));
    v_payout := NULLIF(p_card ->> 'payoutDate', '')::DATE;
    IF v_gross IS NULL OR v_gross <= 0 OR v_gross <> ROUND(v_gross, 2) THEN RAISE EXCEPTION 'Valor passado no cartão inválido'; END IF;
    IF v_fee < 0 OR v_fee >= v_gross OR v_fee <> ROUND(v_fee, 2) THEN RAISE EXCEPTION 'Taxa do cartão inválida'; END IF;
    IF v_payout IS NULL OR v_payout < p_date THEN RAISE EXCEPTION 'Informe quando o dinheiro cai na conta'; END IF;
    v_amount := v_gross - v_fee;
    v_account := NULLIF(public.cash_settings_resolved(v_tenant_id, p_unit_id) ->> 'payoutAccountId', '')::UUID;
    IF v_account IS NULL THEN RAISE EXCEPTION 'Escolha antes qual conta recebe os repasses da maquininha'; END IF;
  ELSE
    v_amount := p_amount;
    IF v_amount IS NULL OR v_amount <= 0 OR v_amount <> ROUND(p_amount, 2) THEN RAISE EXCEPTION 'Valor inválido'; END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.cash_accounts WHERE id = v_account AND tenant_id = v_tenant_id AND unit_id = p_unit_id) THEN
    RAISE EXCEPTION 'Conta não encontrada';
  END IF;
  IF v_type = 'TRANSFERENCIA' THEN
    IF p_to_account_id IS NULL OR p_to_account_id = v_account OR NOT EXISTS (
      SELECT 1 FROM public.cash_accounts WHERE id = p_to_account_id AND tenant_id = v_tenant_id AND unit_id = p_unit_id
    ) THEN
      RAISE EXCEPTION 'Escolha a conta de destino (diferente da origem)';
    END IF;
  END IF;

  IF v_via_card AND v_fee > 0 THEN
    v_expense_id := 'cash-' || v_id::TEXT;
    v_label := CASE WHEN v_type = 'APORTE' THEN 'aporte' ELSE 'empréstimo do sócio' END;
    INSERT INTO public.expenses (id, tenant_id, unit_id, description, category, amount, operator_id, operator_name, "timestamp")
    VALUES (
      v_expense_id, v_tenant_id, p_unit_id,
      LEFT('Taxa do cartão (' || v_label || ' ' || v_installments || 'x de ' || to_char(v_gross, 'FM999G999G990D00') || ')'
        || COALESCE(' - ' || NULLIF(BTRIM(p_description), ''), ''), 200),
      'Taxas de cartão', v_fee, auth.uid()::TEXT, v_name,
      (p_date::TIMESTAMP + TIME '12:00') AT TIME ZONE 'America/Sao_Paulo'
    );
  END IF;

  INSERT INTO public.cash_movements (
    id, tenant_id, unit_id, movement_type, account_id, to_account_id, direction, amount, movement_date, description,
    via_card, card_gross, card_fee, card_installments, payout_date, expense_id, created_by_name
  ) VALUES (
    v_id, v_tenant_id, p_unit_id, v_type, v_account, CASE WHEN v_type = 'TRANSFERENCIA' THEN p_to_account_id END,
    v_direction, v_amount, p_date, NULLIF(BTRIM(COALESCE(p_description, '')), ''),
    v_via_card, v_gross, v_fee, v_installments, v_payout, v_expense_id, v_name
  );
  RETURN v_id;
END;
$$;

-- Exclui um lançamento manual (só o dono); a despesa da taxa sai junto.
CREATE OR REPLACE FUNCTION public.delete_cash_movement(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_movement public.cash_movements;
BEGIN
  SELECT * INTO v_movement FROM public.cash_movements WHERE id = p_id AND tenant_id = public.current_user_tenant_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'Lançamento não encontrado'; END IF;
  PERFORM public.cash_admin_actor(v_movement.unit_id);
  IF v_movement.expense_id IS NOT NULL THEN
    DELETE FROM public.expenses WHERE id = v_movement.expense_id AND tenant_id = v_movement.tenant_id;
  END IF;
  DELETE FROM public.cash_movements WHERE id = p_id;
END;
$$;

-- Saldo de cada conta + extrato a partir de p_from + configuração da loja.
CREATE OR REPLACE FUNCTION public.get_cash_overview(p_unit_id TEXT, p_from DATE DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_settings JSONB;
  v_raw JSONB;
  v_pdv UUID;
  v_payout UUID;
  v_from DATE := COALESCE(p_from, public.payable_today() - 60);
  v_result JSONB;
BEGIN
  PERFORM public.payable_actor(p_unit_id);
  v_settings := public.cash_settings_resolved(v_tenant_id, p_unit_id);
  SELECT cash_settings INTO v_raw FROM public.store_configs WHERE tenant_id = v_tenant_id AND unit_id = p_unit_id;
  v_pdv := NULLIF(v_settings ->> 'pdvCashAccountId', '')::UUID;
  v_payout := NULLIF(v_settings ->> 'payoutAccountId', '')::UUID;

  WITH acc AS (
    SELECT * FROM public.cash_accounts WHERE tenant_id = v_tenant_id AND unit_id = p_unit_id
  ),
  methods AS (
    SELECT key AS method, NULLIF(value #>> '{}', '')::UUID AS account_id
    FROM jsonb_each(v_settings -> 'methodAccounts')
  ),
  last_close AS (
    SELECT cs.cash_number, cs.closed_at, cs.counted_cash_amount,
      (cs.closed_at AT TIME ZONE 'America/Sao_Paulo')::DATE AS close_date
    FROM public.cash_register_sessions cs
    JOIN acc ON acc.id = v_pdv
    WHERE cs.tenant_id = v_tenant_id AND cs.unit_id = p_unit_id AND cs.status = 'FECHADO'
      AND cs.counted_cash_amount IS NOT NULL
      AND (cs.closed_at AT TIME ZONE 'America/Sao_Paulo')::DATE > acc.opening_date
    ORDER BY cs.closed_at DESC
    LIMIT 1
  ),
  base AS (
    SELECT acc.id AS account_id,
      CASE WHEN lc.closed_at IS NOT NULL THEN lc.close_date ELSE acc.opening_date END AS base_date,
      CASE WHEN lc.closed_at IS NOT NULL THEN lc.counted_cash_amount ELSE acc.opening_balance END AS base_amount,
      CASE WHEN lc.closed_at IS NOT NULL THEN 'CONTAGEM' ELSE 'INICIAL' END AS base_kind,
      lc.cash_number, lc.closed_at
    FROM acc
    LEFT JOIN last_close lc ON acc.id = v_pdv
  ),
  entries AS (
    -- Recebimentos conferidos (cartão e Pix): o que caiu de fato.
    SELECT v_payout AS account_id, pc.payout_date AS entry_date, 'REPASSE'::TEXT AS kind,
      'Recebimentos conferidos (cartão e Pix)'::TEXT AS description, pc.received_amount::NUMERIC AS amount,
      pc.id::TEXT AS ref
    FROM public.payout_checks pc
    WHERE v_payout IS NOT NULL AND pc.tenant_id = v_tenant_id AND pc.unit_id = p_unit_id
    UNION ALL
    SELECT m.account_id, rp.paid_at, 'CONTA_RECEBER',
      'Recebido de ' || rt.debtor_name || ' (conta a receber nº ' || rt.title_number || ')', rp.amount, rp.id::TEXT
    FROM public.receivable_payments rp
    JOIN public.receivable_titles rt ON rt.id = rp.title_id
    JOIN methods m ON m.method = rp.method AND m.account_id IS NOT NULL
    WHERE rp.tenant_id = v_tenant_id AND rp.unit_id = p_unit_id
    UNION ALL
    SELECT m.account_id, pb.paid_at, 'CONTA_PAGAR',
      'Pago: ' || pb.description || COALESCE(' - ' || pb.supplier_name, ''), -COALESCE(pb.paid_amount, pb.amount), pb.id::TEXT
    FROM public.payable_bills pb
    JOIN methods m ON m.method = pb.paid_method AND m.account_id IS NOT NULL
    WHERE pb.tenant_id = v_tenant_id AND pb.unit_id = p_unit_id AND pb.status = 'PAGO' AND pb.paid_at IS NOT NULL
    UNION ALL
    SELECT m.account_id, (ti."timestamp"::TIMESTAMPTZ AT TIME ZONE 'America/Sao_Paulo')::DATE, 'TROCA_PIX',
      'Troca nº ' || COALESCE(ti.trade_number::TEXT, '-') || ' paga em Pix', -ti.valuation_amount, ti.id::TEXT
    FROM public.trade_ins ti
    JOIN methods m ON m.method = 'PIX' AND m.account_id IS NOT NULL
    WHERE ti.tenant_id = v_tenant_id AND ti.unit_id = p_unit_id AND ti.payment_method = 'PIX'
    UNION ALL
    SELECT m.account_id, (sr.created_at AT TIME ZONE 'America/Sao_Paulo')::DATE, 'DEVOLUCAO_PIX',
      'Devolução nº ' || sr.return_number || ' paga em Pix', -sr.total_amount, sr.id::TEXT
    FROM public.sale_returns sr
    JOIN methods m ON m.method = 'PIX' AND m.account_id IS NOT NULL
    WHERE sr.tenant_id = v_tenant_id AND sr.unit_id = p_unit_id AND sr.refund_method = 'PIX'
    UNION ALL
    -- Lançamentos manuais (no cartão: fica fora do saldo, entra pelo repasse conferido).
    SELECT cm.account_id, cm.movement_date, cm.movement_type,
      COALESCE(cm.description, ''), CASE WHEN cm.via_card THEN 0
        WHEN cm.direction = 'ENTRADA' THEN cm.amount ELSE -cm.amount END, cm.id::TEXT
    FROM public.cash_movements cm
    WHERE cm.tenant_id = v_tenant_id AND cm.unit_id = p_unit_id
    UNION ALL
    SELECT cm.to_account_id, cm.movement_date, 'TRANSFERENCIA_ENTRADA', COALESCE(cm.description, ''), cm.amount, cm.id::TEXT
    FROM public.cash_movements cm
    WHERE cm.tenant_id = v_tenant_id AND cm.unit_id = p_unit_id AND cm.to_account_id IS NOT NULL
  ),
  balances AS (
    SELECT b.account_id,
      b.base_amount + COALESCE(SUM(e.amount) FILTER (WHERE e.entry_date > b.base_date), 0) AS balance
    FROM base b
    LEFT JOIN entries e ON e.account_id = b.account_id
    GROUP BY b.account_id, b.base_amount
  ),
  closings AS (
    SELECT cs.cash_number, cs.closed_at, cs.counted_cash_amount
    FROM public.cash_register_sessions cs
    WHERE v_pdv IS NOT NULL AND cs.tenant_id = v_tenant_id AND cs.unit_id = p_unit_id AND cs.status = 'FECHADO'
      AND cs.counted_cash_amount IS NOT NULL
      AND (cs.closed_at AT TIME ZONE 'America/Sao_Paulo')::DATE >= v_from
  )
  SELECT jsonb_build_object(
    'settings', v_settings,
    'rawSettings', COALESCE(v_raw, '{}'::JSONB),
    'accounts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', acc.id, 'name', acc.name, 'kind', acc.kind, 'isActive', acc.is_active,
        'openingBalance', acc.opening_balance, 'openingDate', acc.opening_date,
        'balance', ROUND(bal.balance, 2), 'baseKind', b.base_kind, 'baseDate', b.base_date,
        'baseAmount', b.base_amount, 'cashNumber', b.cash_number, 'closedAt', b.closed_at
      ) ORDER BY acc.sort_order, acc.created_at)
      FROM acc JOIN base b ON b.account_id = acc.id JOIN balances bal ON bal.account_id = acc.id
    ), '[]'::JSONB),
    'entries', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'accountId', e.account_id, 'date', e.entry_date, 'kind', e.kind, 'description', e.description,
        'amount', e.amount, 'ref', e.ref, 'counted', e.entry_date > b.base_date
      ) ORDER BY e.entry_date DESC, e.kind)
      FROM entries e JOIN base b ON b.account_id = e.account_id
      WHERE e.entry_date >= v_from
    ), '[]'::JSONB),
    'closings', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('cashNumber', c.cash_number, 'closedAt', c.closed_at, 'counted', c.counted_cash_amount)
        ORDER BY c.closed_at DESC)
      FROM closings c
    ), '[]'::JSONB),
    'partnerLoanBalance', COALESCE((
      SELECT SUM(CASE WHEN cm.movement_type = 'EMPRESTIMO_SOCIO' THEN COALESCE(cm.card_gross, cm.amount) ELSE -cm.amount END)
      FROM public.cash_movements cm
      WHERE cm.tenant_id = v_tenant_id AND cm.unit_id = p_unit_id AND cm.movement_type IN ('EMPRESTIMO_SOCIO', 'DEVOLUCAO_SOCIO')
    ), 0)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- Reserva de reposição por fornecedor (a partir da data de início da loja).
CREATE OR REPLACE FUNCTION public.get_restock_reserves(p_unit_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_start DATE;
  v_result JSONB;
BEGIN
  PERFORM public.payable_actor(p_unit_id);
  v_start := NULLIF(public.cash_settings_resolved(v_tenant_id, p_unit_id) ->> 'reserveStartDate', '')::DATE;

  WITH brand_map AS (
    SELECT DISTINCT ON (LOWER(BTRIM(brand))) LOWER(BTRIM(brand)) AS brand_key, s.id AS supplier_id
    FROM public.suppliers s
    CROSS JOIN LATERAL unnest(s.brands) AS brand
    WHERE s.tenant_id = v_tenant_id AND NULLIF(BTRIM(brand), '') IS NOT NULL
    ORDER BY LOWER(BTRIM(brand)), s.name
  ),
  restock_suppliers AS (
    SELECT s.id, s.name, s.brands FROM public.suppliers s
    WHERE s.tenant_id = v_tenant_id AND cardinality(s.brands) > 0
  ),
  sold AS (
    SELECT LOWER(BTRIM(COALESCE(p.brand, ''))) AS brand_key, SUM((item ->> 'costTotal')::NUMERIC) AS cost
    FROM public.sales s
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.items::JSONB, '[]'::JSONB)) AS item
    LEFT JOIN public.products p ON p.id = item ->> 'productId' AND p.tenant_id = s.tenant_id
    WHERE v_start IS NOT NULL AND s.tenant_id = v_tenant_id AND s.unit_id = p_unit_id AND s.status = 'CONCLUIDA'
      AND (s."timestamp"::TIMESTAMPTZ AT TIME ZONE 'America/Sao_Paulo')::DATE >= v_start
      AND COALESCE(item ->> 'itemType', 'PRODUCT') <> 'SERVICE'
      AND jsonb_typeof(item -> 'costTotal') = 'number'
    GROUP BY 1
  ),
  returned AS (
    SELECT LOWER(BTRIM(COALESCE(p.brand, ''))) AS brand_key, SUM(ri.quantity * COALESCE(ri.unit_cost, 0)) AS cost
    FROM public.sale_return_items ri
    JOIN public.sale_returns r ON r.id = ri.return_id
    JOIN public.sales s ON s.tenant_id = r.tenant_id AND s.id = r.sale_id
    LEFT JOIN public.products p ON p.id = ri.product_id AND p.tenant_id = r.tenant_id
    WHERE v_start IS NOT NULL AND r.tenant_id = v_tenant_id AND r.unit_id = p_unit_id
      AND (s."timestamp"::TIMESTAMPTZ AT TIME ZONE 'America/Sao_Paulo')::DATE >= v_start
    GROUP BY 1
  ),
  by_brand AS (
    SELECT COALESCE(sold.brand_key, returned.brand_key) AS brand_key,
      COALESCE(sold.cost, 0) AS sold_cost, COALESCE(returned.cost, 0) AS returned_cost
    FROM sold FULL JOIN returned ON returned.brand_key = sold.brand_key
  ),
  by_supplier AS (
    SELECT bm.supplier_id, SUM(bb.sold_cost) AS sold_cost, SUM(bb.returned_cost) AS returned_cost
    FROM by_brand bb LEFT JOIN brand_map bm ON bm.brand_key = bb.brand_key
    GROUP BY bm.supplier_id
  ),
  consumed AS (
    SELECT rs.id AS supplier_id, SUM(COALESCE(pb.paid_amount, pb.amount)) AS amount
    FROM public.payable_bills pb
    LEFT JOIN restock_suppliers rs ON rs.id = pb.supplier_id
    WHERE v_start IS NOT NULL AND pb.tenant_id = v_tenant_id AND pb.unit_id = p_unit_id AND pb.status = 'PAGO'
      AND pb.paid_at >= v_start AND pb.category IN ('Mercadoria/Fornecedor', 'Compras Urgentes')
    GROUP BY rs.id
  ),
  rows_out AS (
    SELECT rs.id AS supplier_id, rs.name, rs.brands,
      COALESCE(bs.sold_cost, 0) AS sold_cost, COALESCE(bs.returned_cost, 0) AS returned_cost, COALESCE(c.amount, 0) AS consumed
    FROM restock_suppliers rs
    LEFT JOIN by_supplier bs ON bs.supplier_id = rs.id
    LEFT JOIN consumed c ON c.supplier_id = rs.id
    UNION ALL
    SELECT NULL, 'Outros', '{}'::TEXT[],
      COALESCE((SELECT sold_cost FROM by_supplier WHERE supplier_id IS NULL), 0),
      COALESCE((SELECT returned_cost FROM by_supplier WHERE supplier_id IS NULL), 0),
      COALESCE((SELECT amount FROM consumed WHERE supplier_id IS NULL), 0)
  ),
  brand_list AS (
    SELECT LOWER(BTRIM(COALESCE(p.brand, ''))) AS brand_key, MIN(BTRIM(COALESCE(p.brand, ''))) AS brand, COUNT(*) AS products
    FROM public.products p
    WHERE p.tenant_id = v_tenant_id AND p.archived_at IS NULL
    GROUP BY 1
  )
  SELECT jsonb_build_object(
    'startDate', v_start,
    'suppliers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'supplierId', r.supplier_id, 'name', r.name, 'brands', to_jsonb(r.brands),
        'soldCost', ROUND(r.sold_cost, 2), 'returnedCost', ROUND(r.returned_cost, 2), 'consumed', ROUND(r.consumed, 2),
        'reserve', ROUND(r.sold_cost - r.returned_cost - r.consumed, 2)
      ) ORDER BY (r.supplier_id IS NULL), r.name)
      FROM rows_out r
    ), '[]'::JSONB),
    'brands', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'brand', bl.brand, 'products', bl.products, 'supplierId', bm.supplier_id,
        'soldCost', ROUND(COALESCE(bb.sold_cost, 0) - COALESCE(bb.returned_cost, 0), 2)
      ) ORDER BY (bm.supplier_id IS NOT NULL), bl.brand)
      FROM brand_list bl
      LEFT JOIN brand_map bm ON bm.brand_key = bl.brand_key
      LEFT JOIN by_brand bb ON bb.brand_key = bl.brand_key
    ), '[]'::JSONB)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- Liga uma marca a um fornecedor (ou a "Outros" com p_supplier_id nulo). Só o dono.
CREATE OR REPLACE FUNCTION public.set_brand_supplier(p_brand TEXT, p_supplier_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_brand TEXT := BTRIM(COALESCE(p_brand, ''));
BEGIN
  IF v_tenant_id IS NULL THEN RAISE EXCEPTION 'Sessão do ERP necessária'; END IF;
  IF NOT public.current_user_is_admin() THEN RAISE EXCEPTION 'Só o dono da empresa liga marcas a fornecedores'; END IF;
  IF v_brand = '' THEN RAISE EXCEPTION 'Produtos sem marca vão para "Outros": cadastre a marca no produto'; END IF;
  IF p_supplier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.suppliers WHERE id = p_supplier_id AND tenant_id = v_tenant_id) THEN
    RAISE EXCEPTION 'Fornecedor não encontrado';
  END IF;

  UPDATE public.suppliers
  SET brands = ARRAY(SELECT b FROM unnest(brands) AS b WHERE LOWER(BTRIM(b)) <> LOWER(v_brand))
  WHERE tenant_id = v_tenant_id AND EXISTS (SELECT 1 FROM unnest(brands) AS b WHERE LOWER(BTRIM(b)) = LOWER(v_brand));

  IF p_supplier_id IS NOT NULL THEN
    UPDATE public.suppliers SET brands = array_append(brands, v_brand)
    WHERE id = p_supplier_id AND tenant_id = v_tenant_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.save_cash_account(UUID, TEXT, TEXT, TEXT, NUMERIC, DATE, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_cash_account(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_cash_settings(TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.add_cash_movement(TEXT, TEXT, UUID, UUID, TEXT, NUMERIC, DATE, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_cash_movement(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_cash_overview(TEXT, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_restock_reserves(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_brand_supplier(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_cash_account(UUID, TEXT, TEXT, TEXT, NUMERIC, DATE, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_cash_account(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_cash_settings(TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_cash_movement(TEXT, TEXT, UUID, UUID, TEXT, NUMERIC, DATE, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_cash_movement(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_cash_overview(TEXT, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_restock_reserves(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_brand_supplier(TEXT, TEXT) TO authenticated;

-- ---- 5. Registro de ações (gatilho genérico da 20261205) ----
DROP TRIGGER IF EXISTS zz_audit_cash_accounts ON public.cash_accounts;
CREATE TRIGGER zz_audit_cash_accounts AFTER INSERT OR UPDATE OR DELETE ON public.cash_accounts
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('FINANCEIRO', 'exclude', 'updated_at,sort_order');

DROP TRIGGER IF EXISTS zz_audit_cash_movements ON public.cash_movements;
CREATE TRIGGER zz_audit_cash_movements AFTER INSERT OR DELETE ON public.cash_movements
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('FINANCEIRO', 'exclude', '');
