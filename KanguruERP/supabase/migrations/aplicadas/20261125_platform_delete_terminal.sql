-- UCP: lista os terminais ativados e exclui terminal (desenho aprovado em 2026-11-08).
-- Terminal sem movimento: apagado. Com movimento (vendas, caixas, reservas...): fica oculto e
-- solto do aparelho, porque vendas e relatorios antigos apontam para ele.
-- Caixa aberto e fechado junto, sem contagem: o aparelho pode nem existir mais.
-- O aparelho volta a poder ser ativado com um codigo novo (device_auth_uid fica livre).
-- Aditiva: so 2 funcoes novas, nada existente muda.
BEGIN;

CREATE OR REPLACE FUNCTION public.platform_list_pos_terminals(p_tenant_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.current_user_is_super_admin() THEN RAISE EXCEPTION 'Acesso negado'; END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', terminal.id,
      'unitId', terminal.unit_id,
      'name', terminal.display_name,
      'activatedAt', COALESCE(terminal.activated_at, terminal.created_at),
      'lastUsedAt', terminal.last_unlocked_at,
      'openCashAt', (
        SELECT MIN(cash.opened_at)
        FROM public.cash_register_sessions AS cash
        WHERE cash.terminal_id = terminal.id AND cash.status = 'ABERTO'
      )
    ) ORDER BY terminal.last_unlocked_at DESC NULLS LAST, terminal.created_at DESC)
    FROM public.pos_terminals AS terminal
    WHERE terminal.tenant_id = p_tenant_id AND terminal.is_active
  ), '[]'::JSONB);
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_delete_pos_terminal(p_terminal_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_closed INTEGER := 0;
  v_mode TEXT;
BEGIN
  IF NOT public.current_user_is_super_admin() THEN RAISE EXCEPTION 'Acesso negado'; END IF;

  PERFORM 1 FROM public.pos_terminals WHERE id = p_terminal_id AND is_active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Terminal não encontrado ou já excluído.'; END IF;

  UPDATE public.cash_register_sessions
  SET status = 'FECHADO',
      closed_at = now(),
      closed_by_name = 'Exclusão do terminal',
      notes = concat_ws(' | ', NULLIF(notes, ''), 'Fechado ao excluir o terminal (sem contagem)')
  WHERE terminal_id = p_terminal_id AND status = 'ABERTO';
  GET DIAGNOSTICS v_closed = ROW_COUNT;

  BEGIN
    DELETE FROM public.pos_terminals WHERE id = p_terminal_id;
    v_mode := 'APAGADO';
  EXCEPTION WHEN foreign_key_violation THEN
    UPDATE public.pos_terminals
    SET is_active = false,
        device_auth_uid = NULL,
        admin_password_hash = NULL,
        updated_at = now()
    WHERE id = p_terminal_id;
    v_mode := 'DESATIVADO';
  END;

  RETURN jsonb_build_object('mode', v_mode, 'closedCash', v_closed);
END;
$$;

REVOKE ALL ON FUNCTION public.platform_list_pos_terminals(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_delete_pos_terminal(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_list_pos_terminals(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_delete_pos_terminal(UUID) TO authenticated;

COMMIT;
