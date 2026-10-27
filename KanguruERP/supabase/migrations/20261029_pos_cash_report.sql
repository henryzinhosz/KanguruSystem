-- Relatorio de fechamento de caixa (adaptado da "Reducao de caixa" do Degust).
-- Uma RPC nova, so de leitura, para o caixa ABERTO do terminal: numero da abertura, cupons,
-- faturamento a preco cheio, desconto, venda direta x reserva convertida, NFC-e x Nao Fiscal,
-- estornos e sinais de reserva. Os valores por forma de pagamento continuam vindo de
-- get_pos_cash_closure_summary (nao muda). Nenhuma funcao de venda, caixa ou estorno muda.
BEGIN;

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
    'depositsRefunded', (SELECT refunded FROM deposits)
  ) INTO v_result
  FROM session_sales;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_pos_cash_session_report() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pos_cash_session_report() TO authenticated;

COMMIT;
