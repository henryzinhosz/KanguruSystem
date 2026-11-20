-- =========================================================================
-- Estorno de venda de caixa ja fechado: bloqueado (desenho aprovado em 2026-10-29, opcao A).
-- Motivo: o fechamento fica gravado e o dinheiro devolvido sairia da gaveta do caixa
-- de hoje sem registro. Para vendas de caixa fechado o caminho e o Trocar/Devolver
-- do PDV (2.9), que lanca a saida no caixa aberto e emite a NF-e de devolucao.
-- Aditiva: trigger nova + RPC so de leitura para o ERP; process_sale_cancellation nao muda.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.guard_sale_cancellation_closed_cash()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status IN ('CANCELADA', 'PENDENTE_APROVACAO')
     AND OLD.status IN ('CONCLUIDA', 'PENDENTE_APROVACAO')
     AND NEW.status IS DISTINCT FROM OLD.status
     AND NEW.cash_session_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.cash_register_sessions AS session
       WHERE session.id = NEW.cash_session_id AND session.status = 'FECHADO'
     ) THEN
    RAISE EXCEPTION 'O caixa desta venda já foi fechado. Use Trocar/Devolver no PDV.';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_sale_cancellation_closed_cash() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_sale_cancellation_closed_cash ON public.sales;
CREATE TRIGGER zz_sale_cancellation_closed_cash
  BEFORE UPDATE OF status ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.guard_sale_cancellation_closed_cash();

-- ERP: caixas ja fechados das lojas que o usuario acessa (para esconder o botao Estornar).
CREATE OR REPLACE FUNCTION public.list_closed_cash_session_ids()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT session.id
  FROM public.cash_register_sessions AS session
  WHERE session.status = 'FECHADO'
    AND session.tenant_id = public.current_user_tenant_id()
    AND public.current_user_has_store_access(session.tenant_id, session.unit_id);
$$;

REVOKE ALL ON FUNCTION public.list_closed_cash_session_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_closed_cash_session_ids() TO authenticated;
