-- Agencia de IA (etapa A, desenho aprovado em 2026-11-24).
-- Escritorio com 6 salas (agentes) dentro do ERP. A IA e chamada so pela Edge Function
-- agency-chat (chave no servidor). O agente so SUGERE: nada aqui lanca, paga ou envia nada.
--
-- Acesso: dono (ADMIN) ou gerente com a area "agencia" liberada (app_users.permissions).
-- Limite: perguntas respondidas por empresa por mes (padrao 300), controlado no UCP.
--
-- Aditiva: so colunas novas em tenants, 2 tabelas novas e funcoes novas. Nenhuma funcao
-- existente muda.

-- ---------------- Configuracao por empresa ----------------
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS agency_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS agency_monthly_limit INTEGER NOT NULL DEFAULT 300;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_agency_monthly_limit_check') THEN
    ALTER TABLE public.tenants
      ADD CONSTRAINT tenants_agency_monthly_limit_check CHECK (agency_monthly_limit BETWEEN 0 AND 100000);
  END IF;
END $$;

-- ---------------- Conversas ----------------
-- context = retrato dos dados da loja no inicio da conversa (fica fixo na conversa inteira:
-- assim a IA reaproveita o cache e o historico continua valido).
CREATE TABLE IF NOT EXISTS public.agency_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  room TEXT NOT NULL CHECK (room IN ('recepcao', 'marketing', 'vendas', 'financeiro', 'compras', 'atendimento')),
  title TEXT NOT NULL DEFAULT '',
  scope_label TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agency_conversations_user_idx
  ON public.agency_conversations (user_id, room, updated_at DESC);

-- ---------------- Mensagens ----------------
-- content = texto mostrado na tela; blocks = resposta completa da IA (devolvida igual nas
-- proximas perguntas da conversa). Uso e custo (US$) so nas respostas.
CREATE TABLE IF NOT EXISTS public.agency_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.agency_conversations(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL DEFAULT '',
  blocks JSONB,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agency_messages_conversation_idx
  ON public.agency_messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS agency_messages_usage_idx
  ON public.agency_messages (tenant_id, created_at) WHERE role = 'assistant';

-- Leitura: so a propria pessoa, na empresa liberada. Escrita: so o servidor (service role).
ALTER TABLE public.agency_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agency_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agency_conversations FROM anon;
REVOKE ALL ON public.agency_messages FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.agency_conversations FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.agency_messages FROM authenticated;
GRANT SELECT ON public.agency_conversations TO authenticated;
GRANT SELECT ON public.agency_messages TO authenticated;

DROP POLICY IF EXISTS agency_conversations_own_select ON public.agency_conversations;
CREATE POLICY agency_conversations_own_select ON public.agency_conversations
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND tenant_id = public.current_user_tenant_id());

DROP POLICY IF EXISTS agency_messages_own_select ON public.agency_messages;
CREATE POLICY agency_messages_own_select ON public.agency_messages
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND tenant_id = public.current_user_tenant_id());

-- ---------------- Funcoes internas ----------------
-- Inicio do mes no horario de Brasilia.
CREATE OR REPLACE FUNCTION public.agency_month_start()
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
$$;

-- Perguntas respondidas no mes pela empresa.
CREATE OR REPLACE FUNCTION public.agency_used_this_month(p_tenant_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::INTEGER
  FROM public.agency_messages
  WHERE tenant_id = p_tenant_id
    AND role = 'assistant'
    AND created_at >= public.agency_month_start();
$$;

-- Situacao de acesso de um login. Usada pela Edge Function (p_user = login conferido no
-- servidor) e pelo ERP (get_agency_status, com o proprio login).
CREATE OR REPLACE FUNCTION public.agency_access_of(p_user UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user public.app_users%ROWTYPE;
  v_tenant public.tenants%ROWTYPE;
  v_used INTEGER;
  v_reason TEXT := NULL;
BEGIN
  SELECT * INTO v_user FROM public.app_users WHERE auth_uid = p_user;
  IF NOT FOUND OR v_user.tenant_id IS NULL OR v_user.is_active IS FALSE THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'SEM_ACESSO');
  END IF;

  IF v_user.role <> 'ADMIN' AND NOT (
    v_user.role = 'MANAGER' AND COALESCE(v_user.permissions ->> 'agencia', 'false') = 'true'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'SEM_PERMISSAO');
  END IF;

  SELECT * INTO v_tenant FROM public.tenants WHERE id = v_user.tenant_id;
  IF NOT FOUND OR COALESCE(v_tenant.subscription_status, 'ATIVO') IN ('BLOQUEADO', 'CANCELADO') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'BLOQUEADO');
  END IF;

  v_used := public.agency_used_this_month(v_tenant.id);
  IF NOT v_tenant.agency_enabled THEN
    v_reason := 'DESLIGADA';
  ELSIF v_used >= v_tenant.agency_monthly_limit THEN
    v_reason := 'LIMITE';
  END IF;

  RETURN jsonb_build_object(
    'ok', v_reason IS NULL,
    'reason', v_reason,
    'tenantId', v_tenant.id,
    'displayName', COALESCE(NULLIF(BTRIM(v_user.display_name), ''), 'Usuário'),
    'role', v_user.role,
    'enabled', v_tenant.agency_enabled,
    'limit', v_tenant.agency_monthly_limit,
    'used', v_used
  );
END;
$$;

REVOKE ALL ON FUNCTION public.agency_month_start() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agency_used_this_month(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agency_access_of(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agency_month_start() TO service_role;
GRANT EXECUTE ON FUNCTION public.agency_used_this_month(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.agency_access_of(UUID) TO service_role;

-- ---------------- ERP ----------------
-- Situacao da Agencia para quem esta logado (mostra o uso do mes e se pode perguntar).
CREATE OR REPLACE FUNCTION public.get_agency_status()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Acesso negado'; END IF;
  RETURN public.agency_access_of(auth.uid()) - 'tenantId';
END;
$$;

-- Apaga uma conversa da propria pessoa.
CREATE OR REPLACE FUNCTION public.delete_agency_conversation(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Acesso negado'; END IF;
  DELETE FROM public.agency_conversations
  WHERE id = p_id AND user_id = auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.get_agency_status() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_agency_conversation(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_agency_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_agency_conversation(UUID) TO authenticated;

-- ---------------- UCP (so SUPER_ADMIN) ----------------
CREATE OR REPLACE FUNCTION public.platform_get_agency(p_tenant_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant public.tenants%ROWTYPE;
  v_start TIMESTAMPTZ := public.agency_month_start();
  v_prev TIMESTAMPTZ := (date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo') - INTERVAL '1 month')) AT TIME ZONE 'America/Sao_Paulo';
  v_month RECORD;
  v_last RECORD;
BEGIN
  IF NOT public.current_user_is_super_admin() THEN RAISE EXCEPTION 'Acesso negado'; END IF;
  SELECT * INTO v_tenant FROM public.tenants WHERE id = p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cliente não encontrado'; END IF;

  SELECT COUNT(*)::INTEGER AS answers, COALESCE(SUM(cost_usd), 0) AS cost, COUNT(DISTINCT user_id)::INTEGER AS people
  INTO v_month
  FROM public.agency_messages
  WHERE tenant_id = p_tenant_id AND role = 'assistant' AND created_at >= v_start;

  SELECT COUNT(*)::INTEGER AS answers, COALESCE(SUM(cost_usd), 0) AS cost
  INTO v_last
  FROM public.agency_messages
  WHERE tenant_id = p_tenant_id AND role = 'assistant' AND created_at >= v_prev AND created_at < v_start;

  RETURN jsonb_build_object(
    'enabled', v_tenant.agency_enabled,
    'limit', v_tenant.agency_monthly_limit,
    'used', v_month.answers,
    'costUsd', v_month.cost,
    'people', v_month.people,
    'lastMonthUsed', v_last.answers,
    'lastMonthCostUsd', v_last.cost
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_save_agency(p_tenant_id UUID, p_enabled BOOLEAN, p_limit INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.current_user_is_super_admin() THEN RAISE EXCEPTION 'Acesso negado'; END IF;
  IF p_limit IS NULL OR p_limit < 0 OR p_limit > 100000 THEN
    RAISE EXCEPTION 'Limite inválido: use de 0 a 100000 perguntas por mês';
  END IF;
  UPDATE public.tenants
  SET agency_enabled = COALESCE(p_enabled, true),
      agency_monthly_limit = p_limit
  WHERE id = p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cliente não encontrado'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.platform_get_agency(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_save_agency(UUID, BOOLEAN, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_get_agency(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_save_agency(UUID, BOOLEAN, INTEGER) TO authenticated;
