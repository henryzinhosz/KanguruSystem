-- =========================================================================
-- Painel da Rede, etapa 3: repasse (royalties) das franquias (desenho aprovado em 2026-11-03).
-- - Regra por franquia, configurada pelo dono ou gerente da rede:
--   PERCENT = % sobre a base; TIERS = faixas pelo total do mes (o mes inteiro cai numa faixa
--   so), cada faixa com valor fixo (FIXED) ou percentual (PERCENT). A ultima faixa pode ser
--   "acima de" (upTo nulo).
-- - Base do mes = faturamento bruto das vendas concluidas (produtos + servicos, com juros de
--   cartao repassados) menos as devolucoes dessas vendas, antes de taxas e despesas.
-- - Mes marcado como PAGO guarda a base, o valor e a regra do momento (nao muda se a regra
--   mudar depois). Boleto e visao do franqueado ficam para depois.
-- Aditiva: 2 tabelas novas (sem politicas, so RPC) e funcoes novas.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.network_royalty_rules (
  tenant_id UUID PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  network_id UUID NOT NULL REFERENCES public.networks(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('PERCENT', 'TIERS')),
  percent NUMERIC(6, 3),
  tiers JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_name TEXT
);

CREATE TABLE IF NOT EXISTS public.network_royalty_payments (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  network_id UUID NOT NULL REFERENCES public.networks(id) ON DELETE CASCADE,
  month TEXT NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  base_amount NUMERIC(14, 2) NOT NULL,
  royalty_amount NUMERIC(14, 2) NOT NULL,
  rule_snapshot JSONB NOT NULL,
  paid_at DATE NOT NULL,
  notes TEXT,
  marked_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, month)
);

ALTER TABLE public.network_royalty_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_royalty_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.network_royalty_rules, public.network_royalty_payments FROM PUBLIC, anon, authenticated;

-- Repasse de uma base pela regra (sem regra = 0).
CREATE OR REPLACE FUNCTION public.network_royalty_amount(p_base NUMERIC, p_mode TEXT, p_percent NUMERIC, p_tiers JSONB)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_tier JSONB;
BEGIN
  IF p_mode = 'PERCENT' THEN
    RETURN ROUND(GREATEST(p_base, 0) * COALESCE(p_percent, 0) / 100, 2);
  END IF;
  IF p_mode = 'TIERS' AND jsonb_typeof(p_tiers) = 'array' THEN
    -- Faixas em ordem do limite; a primeira que comporta a base vale para o mes inteiro.
    FOR v_tier IN
      SELECT value FROM jsonb_array_elements(p_tiers)
      ORDER BY NULLIF(value->>'upTo', '')::NUMERIC NULLS LAST
    LOOP
      IF NULLIF(v_tier->>'upTo', '') IS NULL OR p_base <= (v_tier->>'upTo')::NUMERIC THEN
        IF v_tier->>'type' = 'FIXED' THEN
          RETURN ROUND(COALESCE(NULLIF(v_tier->>'value', '')::NUMERIC, 0), 2);
        END IF;
        RETURN ROUND(GREATEST(p_base, 0) * COALESCE(NULLIF(v_tier->>'value', '')::NUMERIC, 0) / 100, 2);
      END IF;
    END LOOP;
  END IF;
  RETURN 0;
END;
$$;

REVOKE ALL ON FUNCTION public.network_royalty_amount(NUMERIC, TEXT, NUMERIC, JSONB) FROM PUBLIC, anon, authenticated;

-- Base do mes de uma franquia (bruto - devolucoes), no fuso informado.
CREATE OR REPLACE FUNCTION public.network_royalty_base(p_tenant_id UUID, p_month TEXT, p_tz TEXT)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ROUND(COALESCE(SUM(sale.gross_amount - COALESCE((
    SELECT SUM(sale_return.total_amount) FROM public.sale_returns AS sale_return
    WHERE sale_return.tenant_id = sale.tenant_id AND sale_return.sale_id = sale.id
  ), 0)), 0), 2)
  FROM public.sales AS sale
  WHERE sale.tenant_id = p_tenant_id AND sale.status = 'CONCLUIDA'
    AND sale."timestamp" >= ((p_month || '-01')::TIMESTAMP AT TIME ZONE p_tz)
    AND sale."timestamp" < (((p_month || '-01')::DATE + INTERVAL '1 month')::TIMESTAMP AT TIME ZONE p_tz);
$$;

REVOKE ALL ON FUNCTION public.network_royalty_base(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- Relatorio do mes: cada franquia da rede com base, regra, repasse e pagamento.
CREATE OR REPLACE FUNCTION public.network_royalty_report(p_month TEXT, p_tz TEXT DEFAULT 'America/Sao_Paulo')
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.network_users%ROWTYPE := public.current_network_user();
BEGIN
  IF p_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Mês inválido';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(row_data ORDER BY row_data->>'name')
    FROM (
      SELECT jsonb_build_object(
        'tenantId', tenant.id, 'name', COALESCE(tenant.trade_name, tenant.legal_name), 'cnpj', tenant.cnpj,
        'ownerName', tenant.owner_name,
        'rule', CASE WHEN rule.tenant_id IS NULL THEN NULL ELSE jsonb_build_object(
          'mode', rule.mode, 'percent', rule.percent, 'tiers', rule.tiers,
          'updatedAt', rule.updated_at, 'updatedByName', rule.updated_by_name) END,
        'base', COALESCE(payment.base_amount, base.amount),
        'royalty', COALESCE(payment.royalty_amount, public.network_royalty_amount(base.amount, rule.mode, rule.percent, rule.tiers)),
        'paid', payment.tenant_id IS NOT NULL,
        'paidAt', payment.paid_at, 'notes', payment.notes, 'markedByName', payment.marked_by_name,
        'paidRule', payment.rule_snapshot
      ) AS row_data
      FROM public.tenants AS tenant
      CROSS JOIN LATERAL (SELECT public.network_royalty_base(tenant.id, p_month, p_tz) AS amount) AS base
      LEFT JOIN public.network_royalty_rules AS rule ON rule.tenant_id = tenant.id
      LEFT JOIN public.network_royalty_payments AS payment ON payment.tenant_id = tenant.id AND payment.month = p_month
      WHERE tenant.network_id = v_me.network_id
    ) AS rows_data
  ), '[]'::JSONB);
END;
$$;

REVOKE ALL ON FUNCTION public.network_royalty_report(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_royalty_report(TEXT, TEXT) TO authenticated;

-- Grava a regra de uma franquia (dono ou gerente da rede).
CREATE OR REPLACE FUNCTION public.network_save_royalty_rule(p_tenant_id UUID, p_mode TEXT, p_percent NUMERIC, p_tiers JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.network_users%ROWTYPE := public.current_network_user();
  v_tier JSONB;
  v_open_ended INTEGER := 0;
BEGIN
  PERFORM public.network_assert_tenant(p_tenant_id);
  IF p_mode NOT IN ('PERCENT', 'TIERS') THEN
    RAISE EXCEPTION 'Tipo de regra inválido';
  END IF;
  IF p_mode = 'PERCENT' AND (p_percent IS NULL OR p_percent < 0 OR p_percent > 100) THEN
    RAISE EXCEPTION 'Informe um percentual entre 0 e 100';
  END IF;
  IF p_mode = 'TIERS' THEN
    IF jsonb_typeof(p_tiers) IS DISTINCT FROM 'array' OR jsonb_array_length(p_tiers) = 0 THEN
      RAISE EXCEPTION 'Informe ao menos uma faixa';
    END IF;
    FOR v_tier IN SELECT value FROM jsonb_array_elements(p_tiers) LOOP
      IF v_tier->>'type' NOT IN ('FIXED', 'PERCENT') THEN
        RAISE EXCEPTION 'Cada faixa precisa ser valor fixo ou percentual';
      END IF;
      IF NULLIF(v_tier->>'value', '') IS NULL OR (v_tier->>'value')::NUMERIC < 0
        OR (v_tier->>'type' = 'PERCENT' AND (v_tier->>'value')::NUMERIC > 100) THEN
        RAISE EXCEPTION 'Valor de faixa inválido';
      END IF;
      IF NULLIF(v_tier->>'upTo', '') IS NULL THEN
        v_open_ended := v_open_ended + 1;
      ELSIF (v_tier->>'upTo')::NUMERIC <= 0 THEN
        RAISE EXCEPTION 'O limite da faixa precisa ser maior que zero';
      END IF;
    END LOOP;
    IF v_open_ended > 1 THEN
      RAISE EXCEPTION 'Só pode existir uma faixa "acima de"';
    END IF;
  END IF;
  INSERT INTO public.network_royalty_rules (tenant_id, network_id, mode, percent, tiers, updated_at, updated_by_name)
  VALUES (p_tenant_id, v_me.network_id, p_mode, CASE WHEN p_mode = 'PERCENT' THEN p_percent END,
    CASE WHEN p_mode = 'TIERS' THEN p_tiers END, NOW(), v_me.display_name)
  ON CONFLICT (tenant_id) DO UPDATE
  SET network_id = EXCLUDED.network_id, mode = EXCLUDED.mode, percent = EXCLUDED.percent, tiers = EXCLUDED.tiers,
      updated_at = NOW(), updated_by_name = EXCLUDED.updated_by_name;
END;
$$;

REVOKE ALL ON FUNCTION public.network_save_royalty_rule(UUID, TEXT, NUMERIC, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_save_royalty_rule(UUID, TEXT, NUMERIC, JSONB) TO authenticated;

-- Marca o mes como pago (guarda base, valor e regra do momento) ou desfaz.
CREATE OR REPLACE FUNCTION public.network_set_royalty_paid(
  p_tenant_id UUID, p_month TEXT, p_paid BOOLEAN, p_paid_at DATE DEFAULT NULL, p_notes TEXT DEFAULT NULL,
  p_tz TEXT DEFAULT 'America/Sao_Paulo'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.network_users%ROWTYPE := public.current_network_user();
  v_rule public.network_royalty_rules%ROWTYPE;
  v_base NUMERIC;
BEGIN
  PERFORM public.network_assert_tenant(p_tenant_id);
  IF p_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Mês inválido';
  END IF;
  IF NOT p_paid THEN
    DELETE FROM public.network_royalty_payments WHERE tenant_id = p_tenant_id AND month = p_month;
    RETURN;
  END IF;
  SELECT * INTO v_rule FROM public.network_royalty_rules WHERE tenant_id = p_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Configure a regra de repasse desta franquia antes de marcar como pago';
  END IF;
  v_base := public.network_royalty_base(p_tenant_id, p_month, p_tz);
  INSERT INTO public.network_royalty_payments (
    tenant_id, network_id, month, base_amount, royalty_amount, rule_snapshot, paid_at, notes, marked_by_name
  ) VALUES (
    p_tenant_id, v_me.network_id, p_month, v_base,
    public.network_royalty_amount(v_base, v_rule.mode, v_rule.percent, v_rule.tiers),
    jsonb_build_object('mode', v_rule.mode, 'percent', v_rule.percent, 'tiers', v_rule.tiers),
    COALESCE(p_paid_at, CURRENT_DATE), NULLIF(BTRIM(COALESCE(p_notes, '')), ''), v_me.display_name
  )
  ON CONFLICT (tenant_id, month) DO UPDATE
  SET paid_at = EXCLUDED.paid_at, notes = EXCLUDED.notes, marked_by_name = EXCLUDED.marked_by_name;
END;
$$;

REVOKE ALL ON FUNCTION public.network_set_royalty_paid(UUID, TEXT, BOOLEAN, DATE, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_set_royalty_paid(UUID, TEXT, BOOLEAN, DATE, TEXT, TEXT) TO authenticated;
