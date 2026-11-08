-- Fase 3: cobranca da mensalidade e bloqueio por assinatura (desenho aprovado em 2026-11-08).
-- Regra: cada mes e uma mensalidade (competencia). Ex.: vencimento dia 5, tolerancia 10 dias:
--   ate dia 5 = ATIVO; dia 6 a 15 = ATRASADO (aviso, funciona normal); a partir do dia 16 = BLOQUEADO.
-- Cliente sem dia de vencimento (billing_due_day nulo) e ISENTO: so vale a situacao manual do UCP.
-- Bloqueio/cancelamento manual pelo UCP (subscription_manual_lock) nao e desfeito automaticamente.
-- Pagamento registrado a mao no UCP nesta versao (boleto/Pix automatico fica para depois).
-- Como bloqueia no banco:
--   * ERP: current_user_tenant_id() deixa de devolver a empresa bloqueada (RLS e RPCs negam).
--   * PDV: triggers impedem venda nova, reserva, OS, Troca Gamer e abertura de caixa.
--     Venda offline (offline_origin) nunca e recusada e venda em andamento tem 30 min de folga.
--     Fechar caixa continua permitido.
-- Aditiva: nenhuma funcao de venda, caixa, reserva ou estorno muda.
-- PRE-REQUISITO: conferir o corpo vivo de current_user_tenant_id (consulta enviada no chat).
BEGIN;

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS billing_due_day INTEGER,
  ADD COLUMN IF NOT EXISTS billing_start DATE,
  ADD COLUMN IF NOT EXISTS billing_amount NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS billing_grace_days INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS subscription_manual_lock BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS subscription_blocked_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_billing_due_day_check') THEN
    ALTER TABLE public.tenants ADD CONSTRAINT tenants_billing_due_day_check
      CHECK (billing_due_day IS NULL OR billing_due_day BETWEEN 1 AND 28);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_billing_grace_days_check') THEN
    ALTER TABLE public.tenants ADD CONSTRAINT tenants_billing_grace_days_check
      CHECK (billing_grace_days BETWEEN 0 AND 60);
  END IF;
END;
$$;

-- Quem ja esta bloqueado/cancelado a mao continua assim.
UPDATE public.tenants
SET subscription_manual_lock = true, subscription_blocked_at = COALESCE(subscription_blocked_at, NOW())
WHERE subscription_status IN ('BLOQUEADO', 'CANCELADO');

CREATE TABLE IF NOT EXISTS public.tenant_billing_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  competence DATE NOT NULL CHECK (EXTRACT(DAY FROM competence) = 1),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
  method TEXT,
  paid_on DATE NOT NULL,
  note TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, competence)
);

ALTER TABLE public.tenant_billing_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenant_billing_payments FROM PUBLIC, anon, authenticated;

-- ---------------- Calculo ----------------
-- Interna: situacao calculada da empresa, primeira mensalidade em aberto, vencimento e ultimo dia antes do bloqueio.
CREATE OR REPLACE FUNCTION public.tenant_billing_compute(p_tenant_id UUID)
RETURNS TABLE (status TEXT, first_unpaid DATE, due_date DATE, block_after DATE)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant public.tenants%ROWTYPE;
  v_today DATE := (NOW() AT TIME ZONE 'America/Sao_Paulo')::DATE;
  v_start DATE;
  v_first DATE;
  v_due DATE;
  v_block DATE;
BEGIN
  SELECT * INTO v_tenant FROM public.tenants WHERE id = p_tenant_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Isento ou travado a mao: vale o que esta gravado.
  IF v_tenant.billing_due_day IS NULL OR v_tenant.subscription_manual_lock THEN
    RETURN QUERY SELECT v_tenant.subscription_status::TEXT, NULL::DATE, NULL::DATE, NULL::DATE;
    RETURN;
  END IF;

  v_start := date_trunc('month', COALESCE(v_tenant.billing_start, v_today))::DATE;

  SELECT MIN(month_row.month_start::DATE) INTO v_first
  FROM generate_series(v_start, (date_trunc('month', v_today) + INTERVAL '24 months')::DATE, INTERVAL '1 month') AS month_row(month_start)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.tenant_billing_payments AS payment
    WHERE payment.tenant_id = p_tenant_id AND payment.competence = month_row.month_start::DATE
  );

  IF v_first IS NULL THEN
    RETURN QUERY SELECT 'ATIVO'::TEXT, NULL::DATE, NULL::DATE, NULL::DATE;
    RETURN;
  END IF;

  v_due := v_first + (v_tenant.billing_due_day - 1);
  v_block := v_due + v_tenant.billing_grace_days;

  RETURN QUERY SELECT
    CASE WHEN v_today <= v_due THEN 'ATIVO' WHEN v_today <= v_block THEN 'ATRASADO' ELSE 'BLOQUEADO' END,
    v_first, v_due, v_block;
END;
$$;

REVOKE ALL ON FUNCTION public.tenant_billing_compute(UUID) FROM PUBLIC, anon, authenticated;

-- Interna: grava em tenants.subscription_status a situacao calculada (so quando muda).
CREATE OR REPLACE FUNCTION public.tenant_subscription_sync(p_tenant_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT computed.status INTO v_status FROM public.tenant_billing_compute(p_tenant_id) AS computed;
  IF v_status IS NULL THEN RETURN NULL; END IF;

  UPDATE public.tenants
  SET subscription_status = v_status,
      subscription_blocked_at = CASE
        WHEN v_status IN ('BLOQUEADO', 'CANCELADO') THEN COALESCE(subscription_blocked_at, NOW())
        ELSE NULL END
  WHERE id = p_tenant_id
    AND (subscription_status IS DISTINCT FROM v_status
      OR (v_status IN ('BLOQUEADO', 'CANCELADO') AND subscription_blocked_at IS NULL)
      OR (v_status NOT IN ('BLOQUEADO', 'CANCELADO') AND subscription_blocked_at IS NOT NULL));

  RETURN v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.tenant_subscription_sync(UUID) FROM PUBLIC, anon, authenticated;

-- ---------------- Consulta da situacao ----------------
CREATE OR REPLACE FUNCTION public.subscription_state_payload(p_tenant_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT := public.tenant_subscription_sync(p_tenant_id);
  v_row RECORD;
BEGIN
  SELECT * INTO v_row FROM public.tenant_billing_compute(p_tenant_id);
  RETURN jsonb_build_object('status', v_status, 'competence', v_row.first_unpaid, 'dueDate', v_row.due_date, 'blockAfter', v_row.block_after);
END;
$$;

REVOKE ALL ON FUNCTION public.subscription_state_payload(UUID) FROM PUBLIC, anon, authenticated;

-- ERP: nao usa current_user_tenant_id, para responder tambem quando a empresa esta bloqueada.
CREATE OR REPLACE FUNCTION public.get_my_subscription_state()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID;
BEGIN
  SELECT tenant_id INTO v_tenant FROM public.app_users WHERE auth_uid = auth.uid();
  IF v_tenant IS NULL THEN RETURN NULL; END IF;
  RETURN public.subscription_state_payload(v_tenant);
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_subscription_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_subscription_state() TO authenticated;

-- PDV (sessao de terminal).
CREATE OR REPLACE FUNCTION public.get_pos_subscription_state()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active terminal session required'; END IF;
  RETURN public.subscription_state_payload(v_terminal.tenant_id);
END;
$$;

REVOKE ALL ON FUNCTION public.get_pos_subscription_state() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_subscription_state() TO authenticated;

-- ---------------- Bloqueio no banco ----------------
-- ERP: empresa bloqueada/cancelada deixa de ser "a empresa do usuario" (RLS e RPCs negam).
-- Mesmo resultado de antes para qualquer outra situacao.
CREATE OR REPLACE FUNCTION public.current_user_tenant_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT app_user.tenant_id
  FROM public.app_users AS app_user
  JOIN public.tenants AS tenant ON tenant.id = app_user.tenant_id
  WHERE app_user.auth_uid = auth.uid()
    AND COALESCE(tenant.subscription_status, 'ATIVO') NOT IN ('BLOQUEADO', 'CANCELADO');
$$;

-- PDV: nada novo com a empresa bloqueada. Fechamento de caixa nao passa por aqui.
CREATE OR REPLACE FUNCTION public.guard_tenant_subscription()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
  v_blocked_at TIMESTAMPTZ;
BEGIN
  IF NEW.tenant_id IS NULL THEN RETURN NEW; END IF;
  -- Venda feita sem internet sempre sobe (registro fiscal nao pode se perder).
  IF TG_TABLE_NAME = 'sales' AND COALESCE(NEW.offline_origin, false) THEN RETURN NEW; END IF;

  v_status := public.tenant_subscription_sync(NEW.tenant_id);
  IF v_status IS NULL OR v_status NOT IN ('BLOQUEADO', 'CANCELADO') THEN RETURN NEW; END IF;

  -- Venda que ja estava em andamento quando bloqueou termina normalmente.
  IF TG_TABLE_NAME = 'sales' THEN
    SELECT subscription_blocked_at INTO v_blocked_at FROM public.tenants WHERE id = NEW.tenant_id;
    IF v_blocked_at IS NOT NULL AND v_blocked_at > NOW() - INTERVAL '30 minutes' THEN RETURN NEW; END IF;
  END IF;

  RAISE EXCEPTION 'SUBSCRIPTION_BLOCKED' USING ERRCODE = 'P0001';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_tenant_subscription() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zz_guard_subscription ON public.sales;
CREATE TRIGGER zz_guard_subscription BEFORE INSERT ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.guard_tenant_subscription();
DROP TRIGGER IF EXISTS zz_guard_subscription ON public.cash_register_sessions;
CREATE TRIGGER zz_guard_subscription BEFORE INSERT ON public.cash_register_sessions
  FOR EACH ROW EXECUTE FUNCTION public.guard_tenant_subscription();
DROP TRIGGER IF EXISTS zz_guard_subscription ON public.product_reservations;
CREATE TRIGGER zz_guard_subscription BEFORE INSERT ON public.product_reservations
  FOR EACH ROW EXECUTE FUNCTION public.guard_tenant_subscription();
DROP TRIGGER IF EXISTS zz_guard_subscription ON public.work_orders;
CREATE TRIGGER zz_guard_subscription BEFORE INSERT ON public.work_orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_tenant_subscription();
DROP TRIGGER IF EXISTS zz_guard_subscription ON public.trade_ins;
CREATE TRIGGER zz_guard_subscription BEFORE INSERT ON public.trade_ins
  FOR EACH ROW EXECUTE FUNCTION public.guard_tenant_subscription();

-- ---------------- UCP (so SUPER_ADMIN) ----------------
-- Atualiza a situacao de todos os clientes (roda ao abrir o UCP).
CREATE OR REPLACE FUNCTION public.platform_sync_subscriptions()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF NOT public.current_user_is_super_admin() THEN RAISE EXCEPTION 'Acesso negado'; END IF;
  FOR v_id IN SELECT id FROM public.tenants WHERE billing_due_day IS NOT NULL LOOP
    PERFORM public.tenant_subscription_sync(v_id);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_get_billing(p_tenant_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant public.tenants%ROWTYPE;
  v_status TEXT;
  v_row RECORD;
BEGIN
  IF NOT public.current_user_is_super_admin() THEN RAISE EXCEPTION 'Acesso negado'; END IF;
  v_status := public.tenant_subscription_sync(p_tenant_id);
  SELECT * INTO v_tenant FROM public.tenants WHERE id = p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cliente não encontrado'; END IF;
  SELECT * INTO v_row FROM public.tenant_billing_compute(p_tenant_id);
  RETURN jsonb_build_object(
    'status', v_status,
    'dueDay', v_tenant.billing_due_day,
    'startMonth', v_tenant.billing_start,
    'amount', v_tenant.billing_amount,
    'graceDays', v_tenant.billing_grace_days,
    'manualLock', v_tenant.subscription_manual_lock,
    'firstUnpaid', v_row.first_unpaid,
    'dueDate', v_row.due_date,
    'blockAfter', v_row.block_after,
    'payments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', payment.id, 'competence', payment.competence, 'amount', payment.amount,
        'method', payment.method, 'paidOn', payment.paid_on, 'note', payment.note
      ) ORDER BY payment.competence DESC)
      FROM public.tenant_billing_payments AS payment WHERE payment.tenant_id = p_tenant_id), '[]'::JSONB)
  );
END;
$$;

-- p_due_day nulo = cliente isento.
CREATE OR REPLACE FUNCTION public.platform_save_billing(
  p_tenant_id UUID,
  p_due_day INTEGER,
  p_start_month DATE,
  p_amount NUMERIC,
  p_grace_days INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.current_user_is_super_admin() THEN RAISE EXCEPTION 'Acesso negado'; END IF;
  IF p_due_day IS NOT NULL AND (p_due_day < 1 OR p_due_day > 28) THEN
    RAISE EXCEPTION 'O dia de vencimento deve ser de 1 a 28.';
  END IF;
  IF p_due_day IS NOT NULL AND p_start_month IS NULL THEN
    RAISE EXCEPTION 'Informe o mês da primeira mensalidade.';
  END IF;
  IF p_amount IS NOT NULL AND p_amount < 0 THEN RAISE EXCEPTION 'Valor inválido.'; END IF;

  UPDATE public.tenants
  SET billing_due_day = p_due_day,
      billing_start = CASE WHEN p_due_day IS NULL THEN NULL ELSE date_trunc('month', p_start_month)::DATE END,
      billing_amount = p_amount,
      billing_grace_days = COALESCE(p_grace_days, billing_grace_days)
  WHERE id = p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cliente não encontrado'; END IF;

  PERFORM public.tenant_subscription_sync(p_tenant_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_register_payment(
  p_tenant_id UUID,
  p_competence DATE,
  p_amount NUMERIC,
  p_method TEXT,
  p_paid_on DATE,
  p_note TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.current_user_is_super_admin() THEN RAISE EXCEPTION 'Acesso negado'; END IF;
  IF p_competence IS NULL THEN RAISE EXCEPTION 'Informe o mês da mensalidade.'; END IF;
  IF p_amount IS NULL OR p_amount < 0 THEN RAISE EXCEPTION 'Informe o valor pago.'; END IF;

  BEGIN
    INSERT INTO public.tenant_billing_payments (tenant_id, competence, amount, method, paid_on, note, created_by)
    VALUES (p_tenant_id, date_trunc('month', p_competence)::DATE, p_amount, NULLIF(BTRIM(p_method), ''),
      COALESCE(p_paid_on, (NOW() AT TIME ZONE 'America/Sao_Paulo')::DATE), NULLIF(BTRIM(p_note), ''), auth.uid());
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Essa mensalidade já está registrada como paga.';
  END;

  PERFORM public.tenant_subscription_sync(p_tenant_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_remove_payment(p_payment_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID;
BEGIN
  IF NOT public.current_user_is_super_admin() THEN RAISE EXCEPTION 'Acesso negado'; END IF;
  DELETE FROM public.tenant_billing_payments WHERE id = p_payment_id RETURNING tenant_id INTO v_tenant;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Pagamento não encontrado'; END IF;
  PERFORM public.tenant_subscription_sync(v_tenant);
END;
$$;

-- Situacao escolhida a mao no UCP. BLOQUEADO/CANCELADO ficam travados ate voltar para ATIVO.
CREATE OR REPLACE FUNCTION public.platform_set_subscription_manual(p_tenant_id UUID, p_status TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lock BOOLEAN := p_status IN ('BLOQUEADO', 'CANCELADO');
BEGIN
  IF NOT public.current_user_is_super_admin() THEN RAISE EXCEPTION 'Acesso negado'; END IF;
  IF p_status NOT IN ('ATIVO', 'ATRASADO', 'BLOQUEADO', 'CANCELADO') THEN RAISE EXCEPTION 'Situação inválida.'; END IF;

  UPDATE public.tenants
  SET subscription_status = p_status,
      subscription_manual_lock = v_lock,
      subscription_blocked_at = CASE WHEN v_lock THEN NOW() ELSE NULL END
  WHERE id = p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cliente não encontrado'; END IF;

  -- Sem trava: quem tem cobranca configurada volta para a situacao calculada.
  PERFORM public.tenant_subscription_sync(p_tenant_id);
END;
$$;

REVOKE ALL ON FUNCTION public.platform_sync_subscriptions() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_get_billing(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_save_billing(UUID, INTEGER, DATE, NUMERIC, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_register_payment(UUID, DATE, NUMERIC, TEXT, DATE, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_remove_payment(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_set_subscription_manual(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_sync_subscriptions() TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_get_billing(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_save_billing(UUID, INTEGER, DATE, NUMERIC, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_register_payment(UUID, DATE, NUMERIC, TEXT, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_remove_payment(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_set_subscription_manual(UUID, TEXT) TO authenticated;

COMMIT;
