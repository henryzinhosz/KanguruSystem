-- Correcao da 20261122: o gatilho de assinatura e o mesmo para 5 tabelas, mas lia NEW.offline_origin
-- (coluna que so existe em sales) em todas elas. Resultado: erro
-- 'record "new" has no field "offline_origin"' ao criar reserva, abrir caixa, abrir OS ou Troca Gamer.
-- Agora a coluna so e lida quando a tabela e sales. Mesma regra de bloqueio; so troca esta funcao.
BEGIN;

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
  IF TG_TABLE_NAME = 'sales' THEN
    IF COALESCE(NEW.offline_origin, false) THEN RETURN NEW; END IF;
  END IF;

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

COMMIT;
