-- =========================================================================
-- Relatorio do caixa (parcial e fechamento) com cada sangria e suprimento
-- detalhado (motivo, hora e valor). Pedido do usuario em 2026-10-29.
-- Nova RPC so de leitura, com a sessao do terminal; nada existente muda.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.get_pos_cash_movements()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  v_cash public.cash_register_sessions%ROWTYPE;
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
    RETURN '[]'::JSONB;
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'type', movement.type,
      'amount', movement.amount,
      'reason', movement.reason,
      'operatorName', movement.operator_name,
      'createdAt', movement.created_at
    ) ORDER BY movement.created_at)
    FROM public.cash_register_movements AS movement
    WHERE movement.cash_session_id = v_cash.id
  ), '[]'::JSONB);
END;
$$;

REVOKE ALL ON FUNCTION public.get_pos_cash_movements() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_cash_movements() TO authenticated;
