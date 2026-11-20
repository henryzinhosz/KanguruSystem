-- =========================================================================
-- Senha Gerente tambem no suprimento e nas Configuracoes do PDV (pedido do usuario
-- em 2026-10-29). Complementa a 20261107 (mesmas funcoes, recriadas so com os tipos novos).
-- Suprimento: o banco exige a autorizacao (como a sangria). Configuracoes: so no PDV
-- (impressora, Comunicador, versao ficam no computador), a senha fica registrada.
-- =========================================================================

ALTER TABLE public.pos_admin_password_attempts DROP CONSTRAINT IF EXISTS pos_admin_password_attempts_context_check;
ALTER TABLE public.pos_admin_password_attempts ADD CONSTRAINT pos_admin_password_attempts_context_check
  CHECK (context IN (
    'UNLOCK', 'DISCOUNT_APPROVAL', 'SALE_RETURN', 'TRADE_IN_PAYOUT',
    'CASH_DRAWER', 'CASH_WITHDRAWAL', 'CASH_SUPPLY', 'CASH_CLOSE', 'RESERVATION_CANCEL', 'PDV_SETTINGS'
  ));

CREATE OR REPLACE FUNCTION public.authorize_pos_manager(p_password TEXT, p_context TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal_id UUID;
BEGIN
  IF p_context NOT IN ('CASH_DRAWER', 'CASH_WITHDRAWAL', 'CASH_SUPPLY', 'CASH_CLOSE', 'RESERVATION_CANCEL', 'PDV_SETTINGS') THEN
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

-- Sangria e suprimento feitos pelo PDV exigem a autorizacao recente.
CREATE OR REPLACE FUNCTION public.guard_pos_cash_withdrawal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.pos_terminals WHERE id = NEW.terminal_id AND device_auth_uid = auth.uid()) THEN
    RETURN NEW;
  END IF;
  IF NEW.reason LIKE '%(registrado sem internet em %' THEN
    RETURN NEW;
  END IF;
  IF NOT public.consume_pos_manager_authorization(
    NEW.terminal_id,
    CASE
      WHEN NEW.type = 'SUPRIMENTO' THEN ARRAY['CASH_SUPPLY']
      WHEN NEW.reason LIKE 'Troca Gamer nº %' THEN ARRAY['TRADE_IN_PAYOUT']
      ELSE ARRAY['CASH_WITHDRAWAL']
    END
  ) THEN
    RAISE EXCEPTION 'Manager password required';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_pos_cash_withdrawal() FROM PUBLIC, anon, authenticated;
