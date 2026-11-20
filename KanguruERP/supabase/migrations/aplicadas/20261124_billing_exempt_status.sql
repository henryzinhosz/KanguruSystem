-- Correcao da 20261122: ao marcar o cliente como ISENTO, a situacao ficava parada no que estava
-- gravado (ex.: ATRASADO), com aviso sem datas. Agora isento volta para ATIVO, salvo bloqueio manual.
-- So troca platform_save_billing (mesma assinatura).
BEGIN;

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

  -- Isento: sem cobranca, sem atraso (bloqueio manual continua valendo).
  IF p_due_day IS NULL THEN
    UPDATE public.tenants
    SET subscription_status = 'ATIVO', subscription_blocked_at = NULL
    WHERE id = p_tenant_id AND NOT subscription_manual_lock;
  END IF;

  PERFORM public.tenant_subscription_sync(p_tenant_id);
END;
$$;

REVOKE ALL ON FUNCTION public.platform_save_billing(UUID, INTEGER, DATE, NUMERIC, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_save_billing(UUID, INTEGER, DATE, NUMERIC, INTEGER) TO authenticated;

COMMIT;
