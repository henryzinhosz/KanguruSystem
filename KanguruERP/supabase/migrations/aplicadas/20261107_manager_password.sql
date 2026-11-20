-- =========================================================================
-- Senha Gerente (desenho aprovado em 2026-10-29): substitui a senha administrativa.
-- Uma senha por loja, criada/trocada pelo dono (ADMIN) no ERP; vale para todos os
-- PDVs da loja. Onde e pedida: tudo que pedia a administrativa (desbloquear, desconto
-- acima do limite, devolucao em dinheiro/fora do prazo, Troca Gamer em dinheiro/Pix)
-- e as acoes novas: abrir a gaveta, sangria, cancelar reserva com sinal e fechar o caixa.
-- Transicao: loja sem senha Gerente continua usando a senha administrativa do terminal.
--
-- Como fica aditivo: a conferencia central (check_pos_admin_password, interna) passa a
-- olhar a senha da loja primeiro. As RPCs de caixa/reserva NAO mudam: o PDV confere a
-- senha antes (authorize_pos_manager) e triggers exigem essa autorizacao recente.
--
-- ANTES DE APLICAR: md5 vivo de check_pos_admin_password deve ser
-- 8e2b3e85ce26687981960c1705acefd0 (LF) ou 5b327d297f4b5988a7182cd7050e66fc (CRLF).
-- =========================================================================

-- ---- 1. Senha da loja (tabela fechada: so funcoes SECURITY DEFINER leem/gravam) ----
CREATE TABLE IF NOT EXISTS public.store_manager_passwords (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  set_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  set_by_name TEXT,
  PRIMARY KEY (tenant_id, unit_id),
  FOREIGN KEY (tenant_id, unit_id) REFERENCES public.store_configs(tenant_id, unit_id) ON DELETE CASCADE
);

ALTER TABLE public.store_manager_passwords ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.store_manager_passwords FROM PUBLIC, anon, authenticated;

-- Autorizacao usada uma vez (sangria, fechamento, cancelamento de reserva com sinal).
ALTER TABLE public.pos_admin_password_attempts ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;

ALTER TABLE public.pos_admin_password_attempts DROP CONSTRAINT IF EXISTS pos_admin_password_attempts_context_check;
ALTER TABLE public.pos_admin_password_attempts ADD CONSTRAINT pos_admin_password_attempts_context_check
  CHECK (context IN (
    'UNLOCK', 'DISCOUNT_APPROVAL', 'SALE_RETURN', 'TRADE_IN_PAYOUT',
    'CASH_DRAWER', 'CASH_WITHDRAWAL', 'CASH_CLOSE', 'RESERVATION_CANCEL'
  ));

-- ---- 2. Conferencia central: senha Gerente da loja; sem ela, a administrativa ----
-- Copia da 20261008; mudam so a origem do hash e a mensagem sem senha.
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
  v_hash TEXT;
  v_last_success TIMESTAMPTZ;
  v_lock_anchor TIMESTAMPTZ;
  v_recent_failures INTEGER;
BEGIN
  -- FOR UPDATE serializa tentativas simultaneas do mesmo terminal.
  SELECT * INTO v_terminal FROM public.pos_terminals
  WHERE id = p_terminal_id AND is_active
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active terminal session required'; END IF;

  SELECT manager.password_hash INTO v_hash
  FROM public.store_manager_passwords AS manager
  WHERE manager.tenant_id = v_terminal.tenant_id AND manager.unit_id = v_terminal.unit_id;
  v_hash := COALESCE(v_hash, v_terminal.admin_password_hash);
  IF v_hash IS NULL THEN
    RAISE EXCEPTION 'Manager password is not configured';
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
    AND v_hash = crypt(p_password, v_hash) THEN
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

-- ---- 3. ERP: cadastrar/trocar e ver a situacao (so ADMIN da empresa) ----
CREATE OR REPLACE FUNCTION public.set_store_manager_password(p_unit_id TEXT, p_password TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_name TEXT;
  v_set_at TIMESTAMPTZ := NOW();
BEGIN
  IF v_tenant_id IS NULL OR NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'Só o administrador da empresa pode definir a senha Gerente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.store_configs WHERE tenant_id = v_tenant_id AND unit_id = p_unit_id) THEN
    RAISE EXCEPTION 'Loja não encontrada';
  END IF;
  IF p_password IS NULL OR length(p_password) < 6 THEN
    RAISE EXCEPTION 'A senha Gerente precisa ter pelo menos 6 caracteres';
  END IF;

  SELECT display_name INTO v_name FROM public.app_users WHERE auth_uid = auth.uid() AND tenant_id = v_tenant_id;

  INSERT INTO public.store_manager_passwords (tenant_id, unit_id, password_hash, set_at, set_by_name)
  VALUES (v_tenant_id, p_unit_id, crypt(p_password, gen_salt('bf', 12)), v_set_at, v_name)
  ON CONFLICT (tenant_id, unit_id) DO UPDATE
  SET password_hash = EXCLUDED.password_hash, set_at = EXCLUDED.set_at, set_by_name = EXCLUDED.set_by_name;

  RETURN v_set_at;
END;
$$;

REVOKE ALL ON FUNCTION public.set_store_manager_password(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_store_manager_password(TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_store_manager_password_status()
RETURNS TABLE (unit_id TEXT, set_at TIMESTAMPTZ, set_by_name TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT manager.unit_id, manager.set_at, manager.set_by_name
  FROM public.store_manager_passwords AS manager
  WHERE manager.tenant_id = public.current_user_tenant_id()
    AND public.current_user_has_store_access(manager.tenant_id, manager.unit_id);
$$;

REVOKE ALL ON FUNCTION public.list_store_manager_password_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_store_manager_password_status() TO authenticated;

-- ---- 4. PDV: situacao da senha da loja e autorizacao ----
-- configured: a loja tem senha Gerente; setAt muda quando ela e trocada (o PDV descarta
-- a copia local da senha antiga); terminalHasAdmin: transicao (senha antiga do terminal).
CREATE OR REPLACE FUNCTION public.get_pos_manager_password_status()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_set_at TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_terminal FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;
  SELECT set_at INTO v_set_at FROM public.store_manager_passwords
  WHERE tenant_id = v_terminal.tenant_id AND unit_id = v_terminal.unit_id;
  RETURN jsonb_build_object(
    'configured', v_set_at IS NOT NULL,
    'setAt', v_set_at,
    'terminalHasAdmin', v_terminal.admin_password_hash IS NOT NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_pos_manager_password_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_manager_password_status() TO authenticated;

-- Confere a senha para uma acao (gaveta, sangria, fechamento, cancelar reserva com sinal).
-- O acerto fica registrado e vale por 5 minutos para a acao seguinte do mesmo terminal.
CREATE OR REPLACE FUNCTION public.authorize_pos_manager(p_password TEXT, p_context TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal_id UUID;
BEGIN
  IF p_context NOT IN ('CASH_DRAWER', 'CASH_WITHDRAWAL', 'CASH_CLOSE', 'RESERVATION_CANCEL') THEN
    RAISE EXCEPTION 'Ação inválida';
  END IF;
  SELECT id INTO v_terminal_id FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active terminal session required';
  END IF;
  RETURN public.check_pos_admin_password(v_terminal_id, p_password, p_context);
END;
$$;

REVOKE ALL ON FUNCTION public.authorize_pos_manager(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.authorize_pos_manager(TEXT, TEXT) TO authenticated;

-- Usa (uma vez) a autorizacao recente do terminal para uma das acoes.
CREATE OR REPLACE FUNCTION public.consume_pos_manager_authorization(p_terminal_id UUID, p_contexts TEXT[])
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attempt_id UUID;
BEGIN
  SELECT attempt.id INTO v_attempt_id
  FROM public.pos_admin_password_attempts AS attempt
  WHERE attempt.terminal_id = p_terminal_id
    AND attempt.success
    AND attempt.consumed_at IS NULL
    AND attempt.context = ANY (p_contexts)
    AND attempt.attempted_at > NOW() - INTERVAL '5 minutes'
  ORDER BY attempt.attempted_at DESC
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  UPDATE public.pos_admin_password_attempts SET consumed_at = NOW() WHERE id = v_attempt_id;
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_pos_manager_authorization(UUID, TEXT[]) FROM PUBLIC, anon, authenticated;

-- ---- 5. Triggers: acoes do PDV exigem a autorizacao (ERP/servidor nao sao afetados) ----
-- Sangria: a da Troca Gamer ja conferiu a senha na mesma transacao (TRADE_IN_PAYOUT).
-- Sangria feita sem internet chega depois com o marcador do PDV: a senha foi conferida
-- na copia local na hora.
CREATE OR REPLACE FUNCTION public.guard_pos_cash_withdrawal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.type <> 'SANGRIA' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pos_terminals WHERE id = NEW.terminal_id AND device_auth_uid = auth.uid()) THEN
    RETURN NEW;
  END IF;
  IF NEW.reason LIKE '%(registrado sem internet em %' THEN
    RETURN NEW;
  END IF;
  IF NOT public.consume_pos_manager_authorization(
    NEW.terminal_id,
    CASE WHEN NEW.reason LIKE 'Troca Gamer nº %' THEN ARRAY['TRADE_IN_PAYOUT'] ELSE ARRAY['CASH_WITHDRAWAL'] END
  ) THEN
    RAISE EXCEPTION 'Manager password required';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_pos_cash_withdrawal() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_pos_cash_withdrawal_manager ON public.cash_register_movements;
CREATE TRIGGER zz_pos_cash_withdrawal_manager
  BEFORE INSERT ON public.cash_register_movements
  FOR EACH ROW EXECUTE FUNCTION public.guard_pos_cash_withdrawal();

CREATE OR REPLACE FUNCTION public.guard_pos_cash_close()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'ABERTO' AND NEW.status = 'FECHADO'
     AND EXISTS (SELECT 1 FROM public.pos_terminals WHERE id = NEW.terminal_id AND device_auth_uid = auth.uid())
     AND NOT public.consume_pos_manager_authorization(NEW.terminal_id, ARRAY['CASH_CLOSE']) THEN
    RAISE EXCEPTION 'Manager password required';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_pos_cash_close() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_pos_cash_close_manager ON public.cash_register_sessions;
CREATE TRIGGER zz_pos_cash_close_manager
  BEFORE UPDATE OF status ON public.cash_register_sessions
  FOR EACH ROW EXECUTE FUNCTION public.guard_pos_cash_close();

CREATE OR REPLACE FUNCTION public.guard_pos_reservation_cancel()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal_id UUID;
BEGIN
  IF NEW.status <> 'CANCELADA' OR OLD.status <> 'ATIVA' OR COALESCE(OLD.deposit_amount, 0) <= 0 THEN
    RETURN NEW;
  END IF;
  SELECT id INTO v_terminal_id FROM public.pos_terminals WHERE device_auth_uid = auth.uid() AND is_active;
  IF v_terminal_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT public.consume_pos_manager_authorization(v_terminal_id, ARRAY['RESERVATION_CANCEL']) THEN
    RAISE EXCEPTION 'Manager password required';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_pos_reservation_cancel() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_pos_reservation_cancel_manager ON public.product_reservations;
CREATE TRIGGER zz_pos_reservation_cancel_manager
  BEFORE UPDATE OF status ON public.product_reservations
  FOR EACH ROW EXECUTE FUNCTION public.guard_pos_reservation_cancel();
