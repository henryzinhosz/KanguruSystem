-- =========================================================================
-- Previsao de recebimentos (cartao e Pix) + conferencia com o extrato (desenho aprovado
-- em 2026-11-20). A previsao e calculada no ERP a partir das vendas que ja existem
-- (sale_payments.fee_percent = taxa gravada na venda). Aqui so entram:
--   1. store_configs.settlement_rules: quando o dinheiro de cada forma cai na conta, por loja
--      (nulo = padrao: Pix na hora, debito e credito no proximo dia util, segunda a sabado).
--   2. payout_checks: dias marcados como "Conferido" (quanto caiu de fato, quem conferiu).
-- Aditiva: 1 coluna, 1 tabela (leitura pela RLS da loja, escrita so pelas RPCs), 2 RPCs.
-- Nenhuma funcao existente muda.
-- =========================================================================

ALTER TABLE public.store_configs
  ADD COLUMN IF NOT EXISTS settlement_rules JSONB;

CREATE TABLE IF NOT EXISTS public.payout_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  payout_date DATE NOT NULL,
  expected_amount NUMERIC(12, 2) NOT NULL,
  received_amount NUMERIC(12, 2) NOT NULL,
  note TEXT,
  checked_by_name TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payout_checks_day_key UNIQUE (tenant_id, unit_id, payout_date),
  CONSTRAINT payout_checks_store_fk
    FOREIGN KEY (tenant_id, unit_id) REFERENCES public.store_configs(tenant_id, unit_id) ON DELETE CASCADE
);

ALTER TABLE public.payout_checks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payout_checks_read ON public.payout_checks;
CREATE POLICY payout_checks_read ON public.payout_checks FOR SELECT TO authenticated
  USING (public.current_user_has_store_access(tenant_id, unit_id));

REVOKE ALL ON public.payout_checks FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.payout_checks FROM authenticated;
GRANT SELECT ON public.payout_checks TO authenticated;

-- Marca (ou atualiza) o dia como conferido.
CREATE OR REPLACE FUNCTION public.set_payout_check(
  p_unit_id TEXT,
  p_payout_date DATE,
  p_expected_amount NUMERIC,
  p_received_amount NUMERIC,
  p_note TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_name TEXT;
BEGIN
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Sessão do ERP necessária';
  END IF;
  IF p_unit_id IS NULL OR NOT public.current_user_has_store_access(v_tenant_id, p_unit_id) THEN
    RAISE EXCEPTION 'Sem acesso a esta loja';
  END IF;
  IF p_payout_date IS NULL OR p_payout_date > (NOW() AT TIME ZONE 'America/Sao_Paulo')::DATE THEN
    RAISE EXCEPTION 'Só é possível conferir dias que já chegaram';
  END IF;
  IF p_received_amount IS NULL OR p_expected_amount IS NULL THEN
    RAISE EXCEPTION 'Informe o valor que caiu na conta';
  END IF;

  SELECT display_name INTO v_name FROM public.app_users WHERE auth_uid = auth.uid() AND tenant_id = v_tenant_id;

  INSERT INTO public.payout_checks (tenant_id, unit_id, payout_date, expected_amount, received_amount, note, checked_by_name)
  VALUES (v_tenant_id, p_unit_id, p_payout_date, ROUND(p_expected_amount, 2), ROUND(p_received_amount, 2),
    NULLIF(LEFT(BTRIM(COALESCE(p_note, '')), 300), ''), COALESCE(NULLIF(BTRIM(v_name), ''), 'Usuário do ERP'))
  ON CONFLICT (tenant_id, unit_id, payout_date) DO UPDATE SET
    expected_amount = EXCLUDED.expected_amount,
    received_amount = EXCLUDED.received_amount,
    note = EXCLUDED.note,
    checked_by_name = EXCLUDED.checked_by_name,
    checked_at = NOW();
END;
$$;

-- Desfaz a conferencia do dia.
CREATE OR REPLACE FUNCTION public.clear_payout_check(p_unit_id TEXT, p_payout_date DATE)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
BEGIN
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'Sessão do ERP necessária';
  END IF;
  IF p_unit_id IS NULL OR NOT public.current_user_has_store_access(v_tenant_id, p_unit_id) THEN
    RAISE EXCEPTION 'Sem acesso a esta loja';
  END IF;
  DELETE FROM public.payout_checks
  WHERE tenant_id = v_tenant_id AND unit_id = p_unit_id AND payout_date = p_payout_date;
END;
$$;

REVOKE ALL ON FUNCTION public.set_payout_check(TEXT, DATE, NUMERIC, NUMERIC, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.clear_payout_check(TEXT, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_payout_check(TEXT, DATE, NUMERIC, NUMERIC, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.clear_payout_check(TEXT, DATE) TO authenticated;
