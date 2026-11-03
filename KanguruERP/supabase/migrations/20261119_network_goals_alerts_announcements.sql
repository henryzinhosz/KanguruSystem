-- =========================================================================
-- Painel da Rede (desenhos aprovados em 2026-11-03):
-- 4. Metas por LOJA (definidas pela rede, por mes) x realizado; o franqueado ve a meta no ERP.
--    Realizado = mesma base do repasse (bruto - devolucoes), por loja.
-- 5. Alertas da rede: loja sem vender, caixa com diferenca grande, caixa aberto ha muito tempo,
--    notas com problema, loja abaixo da meta, assinatura atrasada. Limites configuraveis pelo dono.
-- 6. Comunicados da rede: titulo, texto, Normal/Importante, publico (so donos ou donos + gerentes,
--    escolhido em cada comunicado), franquias de destino, validade e anexos (PDF/imagem no Storage,
--    bucket privado "network-announcements"). Importante abre janela no ERP com "Li e entendi".
-- Aditiva: tabelas novas (sem politicas, so RPC), funcoes novas, bucket e politicas do Storage.
-- =========================================================================

-- ---------------- 4. Metas por loja ----------------
CREATE TABLE IF NOT EXISTS public.network_store_goals (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  month TEXT NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  network_id UUID NOT NULL REFERENCES public.networks(id) ON DELETE CASCADE,
  amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_name TEXT,
  PRIMARY KEY (tenant_id, unit_id, month)
);

ALTER TABLE public.network_store_goals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.network_store_goals FROM PUBLIC, anon, authenticated;

-- Faturamento de uma loja num intervalo (bruto - devolucoes), igual a base do repasse.
CREATE OR REPLACE FUNCTION public.network_store_revenue(p_tenant_id UUID, p_unit_id TEXT, p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
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
  WHERE sale.tenant_id = p_tenant_id AND sale.unit_id = p_unit_id AND sale.status = 'CONCLUIDA'
    AND sale."timestamp" >= p_from AND sale."timestamp" < p_to;
$$;

REVOKE ALL ON FUNCTION public.network_store_revenue(UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

-- Linhas de meta x realizado de um mes para um conjunto de lojas.
CREATE OR REPLACE FUNCTION public.store_goal_rows(p_tenant_ids UUID[], p_unit_ids TEXT[], p_month TEXT, p_tz TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start TIMESTAMPTZ := ((p_month || '-01')::TIMESTAMP AT TIME ZONE p_tz);
  v_end TIMESTAMPTZ := (((p_month || '-01')::DATE + INTERVAL '1 month')::TIMESTAMP AT TIME ZONE p_tz);
  v_prev_month TEXT := to_char((p_month || '-01')::DATE - INTERVAL '1 month', 'YYYY-MM');
BEGIN
  IF p_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Mês inválido';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'tenantId', store.tenant_id, 'franchiseName', COALESCE(tenant.trade_name, tenant.legal_name),
      'unitId', store.unit_id, 'storeName', COALESCE(NULLIF(BTRIM(store.trade_name), ''), store.unit_id),
      'goal', goal.amount, 'goalUpdatedAt', goal.updated_at, 'goalUpdatedBy', goal.updated_by_name,
      'previousGoal', previous_goal.amount,
      'realized', public.network_store_revenue(store.tenant_id, store.unit_id, v_start, v_end),
      'lastYearRealized', public.network_store_revenue(store.tenant_id, store.unit_id, v_start - INTERVAL '1 year', v_end - INTERVAL '1 year')
    ) ORDER BY COALESCE(tenant.trade_name, tenant.legal_name), store.trade_name)
    FROM public.store_configs AS store
    JOIN public.tenants AS tenant ON tenant.id = store.tenant_id
    LEFT JOIN public.network_store_goals AS goal ON goal.tenant_id = store.tenant_id AND goal.unit_id = store.unit_id AND goal.month = p_month
    LEFT JOIN public.network_store_goals AS previous_goal ON previous_goal.tenant_id = store.tenant_id AND previous_goal.unit_id = store.unit_id AND previous_goal.month = v_prev_month
    WHERE store.tenant_id = ANY (p_tenant_ids) AND store.unit_id <> 'central'
      AND (p_unit_ids IS NULL OR store.unit_id = ANY (p_unit_ids))
  ), '[]'::JSONB);
END;
$$;

REVOKE ALL ON FUNCTION public.store_goal_rows(UUID[], TEXT[], TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- Painel da Rede: metas do mes de todas as lojas da rede.
CREATE OR REPLACE FUNCTION public.network_goals_report(p_month TEXT, p_tz TEXT DEFAULT 'America/Sao_Paulo')
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.network_users%ROWTYPE := public.current_network_user();
BEGIN
  RETURN public.store_goal_rows(
    ARRAY(SELECT id FROM public.tenants WHERE network_id = v_me.network_id), NULL, p_month, p_tz);
END;
$$;

REVOKE ALL ON FUNCTION public.network_goals_report(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_goals_report(TEXT, TEXT) TO authenticated;

-- Grava as metas de um mes: [{tenantId, unitId, amount}] (amount vazio ou 0 = sem meta).
CREATE OR REPLACE FUNCTION public.network_save_store_goals(p_month TEXT, p_goals JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.network_users%ROWTYPE := public.current_network_user();
  v_goal JSONB;
  v_tenant UUID;
  v_unit TEXT;
  v_amount NUMERIC;
BEGIN
  IF p_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Mês inválido';
  END IF;
  IF jsonb_typeof(p_goals) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Metas inválidas';
  END IF;
  FOR v_goal IN SELECT value FROM jsonb_array_elements(p_goals) LOOP
    v_tenant := (v_goal->>'tenantId')::UUID;
    v_unit := v_goal->>'unitId';
    v_amount := NULLIF(v_goal->>'amount', '')::NUMERIC;
    PERFORM public.network_assert_tenant(v_tenant);
    IF NOT EXISTS (SELECT 1 FROM public.store_configs WHERE tenant_id = v_tenant AND unit_id = v_unit AND unit_id <> 'central') THEN
      RAISE EXCEPTION 'Loja não encontrada';
    END IF;
    IF v_amount IS NULL OR v_amount <= 0 THEN
      DELETE FROM public.network_store_goals WHERE tenant_id = v_tenant AND unit_id = v_unit AND month = p_month;
    ELSE
      INSERT INTO public.network_store_goals (tenant_id, unit_id, month, network_id, amount, updated_at, updated_by_name)
      VALUES (v_tenant, v_unit, p_month, v_me.network_id, ROUND(v_amount, 2), NOW(), v_me.display_name)
      ON CONFLICT (tenant_id, unit_id, month) DO UPDATE
      SET amount = EXCLUDED.amount, network_id = EXCLUDED.network_id, updated_at = NOW(), updated_by_name = EXCLUDED.updated_by_name;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.network_save_store_goals(TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_save_store_goals(TEXT, JSONB) TO authenticated;

-- ERP do franqueado: metas das lojas que o usuario enxerga (definidas pela rede).
CREATE OR REPLACE FUNCTION public.get_my_store_goals(p_month TEXT, p_tz TEXT DEFAULT 'America/Sao_Paulo')
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant UUID := public.current_user_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN
    RETURN '[]'::JSONB;
  END IF;
  RETURN (
    SELECT COALESCE(jsonb_agg(entry.row_data), '[]'::JSONB)
    FROM jsonb_array_elements(public.store_goal_rows(ARRAY[v_tenant],
      ARRAY(SELECT store.unit_id FROM public.store_configs AS store
        WHERE store.tenant_id = v_tenant AND public.current_user_has_store_access(v_tenant, store.unit_id)),
      p_month, p_tz)) AS entry(row_data)
    WHERE entry.row_data->>'goal' IS NOT NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_store_goals(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_store_goals(TEXT, TEXT) TO authenticated;

-- ---------------- 5. Alertas da rede ----------------
CREATE TABLE IF NOT EXISTS public.network_alert_settings (
  network_id UUID PRIMARY KEY REFERENCES public.networks(id) ON DELETE CASCADE,
  no_sale_days INTEGER NOT NULL DEFAULT 2 CHECK (no_sale_days BETWEEN 1 AND 60),
  cash_difference NUMERIC(12, 2) NOT NULL DEFAULT 50 CHECK (cash_difference >= 0),
  cash_open_hours INTEGER NOT NULL DEFAULT 24 CHECK (cash_open_hours BETWEEN 1 AND 240),
  goal_min_percent INTEGER NOT NULL DEFAULT 70 CHECK (goal_min_percent BETWEEN 1 AND 100),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_name TEXT
);

ALTER TABLE public.network_alert_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.network_alert_settings FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.network_get_alert_settings()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.network_users%ROWTYPE := public.current_network_user();
  v_settings public.network_alert_settings%ROWTYPE;
BEGIN
  SELECT * INTO v_settings FROM public.network_alert_settings WHERE network_id = v_me.network_id;
  RETURN jsonb_build_object(
    'noSaleDays', COALESCE(v_settings.no_sale_days, 2),
    'cashDifference', COALESCE(v_settings.cash_difference, 50),
    'cashOpenHours', COALESCE(v_settings.cash_open_hours, 24),
    'goalMinPercent', COALESCE(v_settings.goal_min_percent, 70),
    'updatedAt', v_settings.updated_at, 'updatedByName', v_settings.updated_by_name
  );
END;
$$;

REVOKE ALL ON FUNCTION public.network_get_alert_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_get_alert_settings() TO authenticated;

-- So o dono da rede altera os limites.
CREATE OR REPLACE FUNCTION public.network_save_alert_settings(
  p_no_sale_days INTEGER, p_cash_difference NUMERIC, p_cash_open_hours INTEGER, p_goal_min_percent INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.network_users%ROWTYPE := public.current_network_user();
BEGIN
  IF v_me.role <> 'OWNER' THEN
    RAISE EXCEPTION 'Só o dono da rede pode alterar os limites dos alertas';
  END IF;
  INSERT INTO public.network_alert_settings (network_id, no_sale_days, cash_difference, cash_open_hours, goal_min_percent, updated_at, updated_by_name)
  VALUES (v_me.network_id, p_no_sale_days, p_cash_difference, p_cash_open_hours, p_goal_min_percent, NOW(), v_me.display_name)
  ON CONFLICT (network_id) DO UPDATE
  SET no_sale_days = EXCLUDED.no_sale_days, cash_difference = EXCLUDED.cash_difference,
      cash_open_hours = EXCLUDED.cash_open_hours, goal_min_percent = EXCLUDED.goal_min_percent,
      updated_at = NOW(), updated_by_name = EXCLUDED.updated_by_name;
END;
$$;

REVOKE ALL ON FUNCTION public.network_save_alert_settings(INTEGER, NUMERIC, INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_save_alert_settings(INTEGER, NUMERIC, INTEGER, INTEGER) TO authenticated;

-- Lista de alertas da rede. Cada linha: kind, tenantId, franchiseName, unitId, storeName, title, detail, date.
CREATE OR REPLACE FUNCTION public.network_alerts(p_tz TEXT DEFAULT 'America/Sao_Paulo')
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.network_users%ROWTYPE := public.current_network_user();
  v_settings public.network_alert_settings%ROWTYPE;
  v_no_sale_days INTEGER;
  v_cash_difference NUMERIC;
  v_cash_open_hours INTEGER;
  v_goal_min INTEGER;
  v_today DATE := (NOW() AT TIME ZONE p_tz)::DATE;
  v_month TEXT := to_char(NOW() AT TIME ZONE p_tz, 'YYYY-MM');
  v_month_start TIMESTAMPTZ := (date_trunc('month', NOW() AT TIME ZONE p_tz) AT TIME ZONE p_tz);
  v_days_in_month INTEGER := EXTRACT(DAY FROM (date_trunc('month', NOW() AT TIME ZONE p_tz) + INTERVAL '1 month - 1 day'))::INTEGER;
  v_days_elapsed INTEGER := EXTRACT(DAY FROM NOW() AT TIME ZONE p_tz)::INTEGER;
BEGIN
  SELECT * INTO v_settings FROM public.network_alert_settings WHERE network_id = v_me.network_id;
  v_no_sale_days := COALESCE(v_settings.no_sale_days, 2);
  v_cash_difference := COALESCE(v_settings.cash_difference, 50);
  v_cash_open_hours := COALESCE(v_settings.cash_open_hours, 24);
  v_goal_min := COALESCE(v_settings.goal_min_percent, 70);

  RETURN COALESCE((
    WITH stores AS (
      SELECT store.tenant_id, store.unit_id, COALESCE(NULLIF(BTRIM(store.trade_name), ''), store.unit_id) AS store_name,
        COALESCE(tenant.trade_name, tenant.legal_name) AS franchise_name, tenant.subscription_status
      FROM public.store_configs AS store
      JOIN public.tenants AS tenant ON tenant.id = store.tenant_id
      WHERE tenant.network_id = v_me.network_id AND store.unit_id <> 'central'
    ), alerts AS (
      -- Loja sem vender ha X dias (so lojas com PDV ativado).
      SELECT stores.tenant_id, stores.unit_id, 'SEM_VENDA' AS kind,
        CASE WHEN last_sale.at IS NULL THEN 'Nenhuma venda registrada'
          ELSE 'Sem vender há ' || (v_today - (last_sale.at AT TIME ZONE p_tz)::DATE) || ' dia(s)' END AS title,
        CASE WHEN last_sale.at IS NULL THEN 'A loja tem PDV ativado e ainda não vendeu'
          ELSE 'Última venda em ' || to_char(last_sale.at AT TIME ZONE p_tz, 'DD/MM/YYYY HH24:MI') END AS detail,
        last_sale.at AS date
      FROM stores
      CROSS JOIN LATERAL (SELECT MAX(sale."timestamp") AS at FROM public.sales AS sale
        WHERE sale.tenant_id = stores.tenant_id AND sale.unit_id = stores.unit_id AND sale.status = 'CONCLUIDA') AS last_sale
      WHERE EXISTS (SELECT 1 FROM public.pos_terminals AS terminal
          WHERE terminal.tenant_id = stores.tenant_id AND terminal.unit_id = stores.unit_id AND terminal.is_active)
        AND (last_sale.at IS NULL OR (last_sale.at AT TIME ZONE p_tz)::DATE <= v_today - v_no_sale_days)
      UNION ALL
      -- Caixa fechado nos ultimos 7 dias com diferenca acima do limite da rede.
      SELECT cash.tenant_id, cash.unit_id, 'CAIXA_DIFERENCA',
        'Caixa ' || COALESCE(cash.cash_number, '') || ' com diferença de ' || public.format_brl(cash.total_difference),
        concat_ws(' · ', 'Fechado em ' || to_char(cash.closed_at AT TIME ZONE p_tz, 'DD/MM/YYYY HH24:MI'), 'por ' || cash.closed_by_name),
        cash.closed_at
      FROM (
        SELECT session.*, COALESCE(session.cash_difference_amount, 0) + COALESCE(session.pix_difference_amount, 0)
          + COALESCE(session.credit_difference_amount, 0) + COALESCE(session.debit_difference_amount, 0)
          + COALESCE(session.voucher_difference_amount, 0) + COALESCE(session.credit_account_difference_amount, 0) AS total_difference
        FROM public.cash_register_sessions AS session
        JOIN stores ON stores.tenant_id = session.tenant_id AND stores.unit_id = session.unit_id
        WHERE session.closed_at >= NOW() - INTERVAL '7 days'
      ) AS cash
      WHERE ABS(cash.total_difference) > v_cash_difference
      UNION ALL
      -- Caixa aberto ha muito tempo.
      SELECT session.tenant_id, session.unit_id, 'CAIXA_ABERTO',
        'Caixa ' || COALESCE(session.cash_number, '') || ' aberto há ' || FLOOR(EXTRACT(EPOCH FROM NOW() - session.opened_at) / 3600)::INTEGER || ' h',
        concat_ws(' · ', 'Aberto em ' || to_char(session.opened_at AT TIME ZONE p_tz, 'DD/MM/YYYY HH24:MI'), 'por ' || session.opened_by_name),
        session.opened_at
      FROM public.cash_register_sessions AS session
      JOIN stores ON stores.tenant_id = session.tenant_id AND stores.unit_id = session.unit_id
      WHERE session.status = 'ABERTO' AND session.opened_at < NOW() - make_interval(hours => v_cash_open_hours)
      UNION ALL
      -- Notas com problema (NFC-e e NFS-e com erro/pendente, contingencia vencendo, NF-e de devolucao com erro).
      SELECT problems.tenant_id, problems.unit_id, 'NOTAS',
        problems.total || ' nota(s) com problema',
        concat_ws(' · ',
          CASE WHEN problems.nfce > 0 THEN problems.nfce || ' NFC-e' END,
          CASE WHEN problems.contingency > 0 THEN problems.contingency || ' em contingência há mais de 12 h' END,
          CASE WHEN problems.nfse > 0 THEN problems.nfse || ' NFS-e' END,
          CASE WHEN problems.return_errors > 0 THEN problems.return_errors || ' NF-e de devolução' END),
        problems.oldest
      FROM (
        SELECT stores.tenant_id, stores.unit_id, counts.*,
          counts.nfce + counts.contingency + counts.nfse + counts.return_errors AS total
        FROM stores
        CROSS JOIN LATERAL (
          SELECT
            (SELECT COUNT(*) FROM public.sales AS sale WHERE sale.tenant_id = stores.tenant_id AND sale.unit_id = stores.unit_id
              AND sale.status = 'CONCLUIDA' AND sale.fiscal_status IN ('ERRO', 'PENDENTE') AND sale."timestamp" < NOW() - INTERVAL '10 minutes')::INTEGER AS nfce,
            (SELECT COUNT(*) FROM public.sales AS sale WHERE sale.tenant_id = stores.tenant_id AND sale.unit_id = stores.unit_id
              AND sale.status = 'CONCLUIDA' AND sale.nfce_contingency AND NOT sale.nfce_contingency_done
              AND sale.fiscal_status = 'AUTORIZADA' AND sale."timestamp" < NOW() - INTERVAL '12 hours')::INTEGER AS contingency,
            (SELECT COUNT(*) FROM public.sale_service_invoices AS invoice
              JOIN public.sales AS sale ON sale.tenant_id = invoice.tenant_id AND sale.id = invoice.sale_id AND sale.status = 'CONCLUIDA'
              WHERE invoice.tenant_id = stores.tenant_id AND invoice.unit_id = stores.unit_id
                AND invoice.status IN ('ERRO', 'PENDENTE') AND invoice.created_at < NOW() - INTERVAL '10 minutes')::INTEGER AS nfse,
            (SELECT COUNT(*) FROM public.sale_returns AS sale_return WHERE sale_return.tenant_id = stores.tenant_id
              AND sale_return.unit_id = stores.unit_id AND sale_return.fiscal_status = 'ERRO')::INTEGER AS return_errors,
            (SELECT MIN(sale."timestamp") FROM public.sales AS sale WHERE sale.tenant_id = stores.tenant_id AND sale.unit_id = stores.unit_id
              AND sale.status = 'CONCLUIDA' AND sale.fiscal_status IN ('ERRO', 'PENDENTE')) AS oldest
        ) AS counts
      ) AS problems
      WHERE problems.total > 0
      UNION ALL
      -- Loja abaixo da meta: projecao do mes (ritmo atual) abaixo do minimo.
      SELECT goal_rows.tenant_id, goal_rows.unit_id, 'META',
        'Projeção de ' || ROUND(goal_rows.projection * 100 / goal_rows.amount) || '% da meta',
        'Realizado ' || public.format_brl(goal_rows.realized) || ' de ' || public.format_brl(goal_rows.amount)
          || ' · projeção ' || public.format_brl(goal_rows.projection),
        NOW()
      FROM (
        SELECT goal.tenant_id, goal.unit_id, goal.amount, revenue.realized,
          ROUND(revenue.realized / GREATEST(v_days_elapsed, 1) * v_days_in_month, 2) AS projection
        FROM public.network_store_goals AS goal
        JOIN stores ON stores.tenant_id = goal.tenant_id AND stores.unit_id = goal.unit_id
        CROSS JOIN LATERAL (SELECT public.network_store_revenue(goal.tenant_id, goal.unit_id, v_month_start, NOW()) AS realized) AS revenue
        WHERE goal.month = v_month
      ) AS goal_rows
      WHERE goal_rows.projection * 100 < goal_rows.amount * v_goal_min
      UNION ALL
      -- Assinatura do sistema atrasada ou bloqueada (uma linha por franquia).
      SELECT tenant.id, NULL, 'ASSINATURA',
        'Assinatura ' || CASE WHEN tenant.subscription_status = 'ATRASADO' THEN 'atrasada' ELSE 'bloqueada' END,
        'Situação no sistema: ' || tenant.subscription_status, NULL
      FROM public.tenants AS tenant
      WHERE tenant.network_id = v_me.network_id AND tenant.subscription_status IN ('ATRASADO', 'BLOQUEADO')
    )
    SELECT jsonb_agg(jsonb_build_object(
      'kind', alerts.kind, 'tenantId', alerts.tenant_id,
      'franchiseName', (SELECT COALESCE(tenant.trade_name, tenant.legal_name) FROM public.tenants AS tenant WHERE tenant.id = alerts.tenant_id),
      'unitId', alerts.unit_id,
      'storeName', (SELECT stores.store_name FROM stores WHERE stores.tenant_id = alerts.tenant_id AND stores.unit_id = alerts.unit_id),
      'title', alerts.title, 'detail', alerts.detail, 'date', alerts.date
    ) ORDER BY alerts.kind, alerts.date DESC NULLS LAST)
    FROM alerts
  ), '[]'::JSONB);
END;
$$;

REVOKE ALL ON FUNCTION public.network_alerts(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_alerts(TEXT) TO authenticated;

-- ---------------- 6. Comunicados ----------------
CREATE TABLE IF NOT EXISTS public.network_announcements (
  id UUID PRIMARY KEY,
  network_id UUID NOT NULL REFERENCES public.networks(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (NULLIF(BTRIM(title), '') IS NOT NULL),
  body TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL', 'IMPORTANTE')),
  audience TEXT NOT NULL DEFAULT 'OWNERS' CHECK (audience IN ('OWNERS', 'ALL')),
  target_tenant_ids UUID[],
  expires_on DATE,
  archived BOOLEAN NOT NULL DEFAULT false,
  attachments JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS network_announcements_network_idx ON public.network_announcements (network_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.network_announcement_reads (
  announcement_id UUID NOT NULL REFERENCES public.network_announcements(id) ON DELETE CASCADE,
  auth_uid UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  display_name TEXT,
  email TEXT,
  read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (announcement_id, auth_uid)
);

ALTER TABLE public.network_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_announcement_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.network_announcements, public.network_announcement_reads FROM PUBLIC, anon, authenticated;

-- O usuario do ERP logado deve ver este comunicado? (empresa da rede, franquia de destino, publico, validade)
CREATE OR REPLACE FUNCTION public.announcement_visible_to_me(p_announcement public.network_announcements)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.app_users AS app_user
    JOIN public.tenants AS tenant ON tenant.id = app_user.tenant_id
    WHERE app_user.auth_uid = auth.uid() AND app_user.is_active
      AND tenant.network_id = p_announcement.network_id
      AND NOT p_announcement.archived
      AND (p_announcement.expires_on IS NULL OR p_announcement.expires_on >= (NOW() AT TIME ZONE 'America/Sao_Paulo')::DATE)
      AND (p_announcement.target_tenant_ids IS NULL OR app_user.tenant_id = ANY (p_announcement.target_tenant_ids))
      AND (app_user.role = 'ADMIN' OR (p_announcement.audience = 'ALL' AND app_user.role = 'MANAGER'))
  );
$$;

REVOKE ALL ON FUNCTION public.announcement_visible_to_me(public.network_announcements) FROM PUBLIC, anon, authenticated;

-- Anexo: lista [{path, name, size, type}] com caminho dentro da pasta do comunicado.
CREATE OR REPLACE FUNCTION public.network_save_announcement(
  p_id UUID, p_title TEXT, p_body TEXT, p_priority TEXT, p_audience TEXT,
  p_target_tenant_ids UUID[], p_expires_on DATE, p_attachments JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.network_users%ROWTYPE := public.current_network_user();
  v_existing public.network_announcements%ROWTYPE;
  v_attachment JSONB;
  v_targets UUID[] := NULLIF(p_target_tenant_ids, ARRAY[]::UUID[]);
BEGIN
  IF p_id IS NULL THEN RAISE EXCEPTION 'Comunicado sem identificador'; END IF;
  IF NULLIF(BTRIM(COALESCE(p_title, '')), '') IS NULL THEN RAISE EXCEPTION 'Informe o título'; END IF;
  IF p_priority NOT IN ('NORMAL', 'IMPORTANTE') THEN RAISE EXCEPTION 'Tipo inválido'; END IF;
  IF p_audience NOT IN ('OWNERS', 'ALL') THEN RAISE EXCEPTION 'Público inválido'; END IF;
  IF v_targets IS NOT NULL AND EXISTS (
    SELECT 1 FROM unnest(v_targets) AS target(id)
    WHERE NOT EXISTS (SELECT 1 FROM public.tenants WHERE tenants.id = target.id AND tenants.network_id = v_me.network_id)
  ) THEN
    RAISE EXCEPTION 'Franquia fora da sua rede';
  END IF;
  IF jsonb_typeof(COALESCE(p_attachments, '[]'::JSONB)) <> 'array' THEN RAISE EXCEPTION 'Anexos inválidos'; END IF;
  FOR v_attachment IN SELECT value FROM jsonb_array_elements(COALESCE(p_attachments, '[]'::JSONB)) LOOP
    IF COALESCE(v_attachment->>'path', '') NOT LIKE v_me.network_id::TEXT || '/' || p_id::TEXT || '/%' THEN
      RAISE EXCEPTION 'Anexo inválido';
    END IF;
  END LOOP;

  SELECT * INTO v_existing FROM public.network_announcements WHERE id = p_id;
  IF FOUND AND v_existing.network_id <> v_me.network_id THEN
    RAISE EXCEPTION 'Comunicado de outra rede';
  END IF;

  INSERT INTO public.network_announcements (id, network_id, title, body, priority, audience, target_tenant_ids,
    expires_on, attachments, created_by_name, created_at, updated_at)
  VALUES (p_id, v_me.network_id, BTRIM(p_title), COALESCE(p_body, ''), p_priority, p_audience, v_targets,
    p_expires_on, COALESCE(p_attachments, '[]'::JSONB), v_me.display_name, NOW(), NOW())
  ON CONFLICT (id) DO UPDATE
  SET title = EXCLUDED.title, body = EXCLUDED.body, priority = EXCLUDED.priority, audience = EXCLUDED.audience,
      target_tenant_ids = EXCLUDED.target_tenant_ids, expires_on = EXCLUDED.expires_on,
      attachments = EXCLUDED.attachments, updated_at = NOW();
  RETURN p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.network_save_announcement(UUID, TEXT, TEXT, TEXT, TEXT, UUID[], DATE, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_save_announcement(UUID, TEXT, TEXT, TEXT, TEXT, UUID[], DATE, JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.network_set_announcement_archived(p_id UUID, p_archived BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.network_users%ROWTYPE := public.current_network_user();
BEGIN
  UPDATE public.network_announcements SET archived = p_archived, updated_at = NOW()
  WHERE id = p_id AND network_id = v_me.network_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Comunicado não encontrado'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.network_set_announcement_archived(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_set_announcement_archived(UUID, BOOLEAN) TO authenticated;

-- Painel da Rede: comunicados com quem deve ler e quem ja leu.
CREATE OR REPLACE FUNCTION public.network_list_announcements()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.network_users%ROWTYPE := public.current_network_user();
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', announcement.id, 'title', announcement.title, 'body', announcement.body,
      'priority', announcement.priority, 'audience', announcement.audience,
      'targetTenantIds', to_jsonb(announcement.target_tenant_ids), 'expiresOn', announcement.expires_on,
      'archived', announcement.archived, 'attachments', announcement.attachments,
      'createdByName', announcement.created_by_name, 'createdAt', announcement.created_at, 'updatedAt', announcement.updated_at,
      -- Por franquia de destino: quantos usuarios devem ler e quem ja leu.
      'franchises', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'tenantId', tenant.id, 'name', COALESCE(tenant.trade_name, tenant.legal_name),
          'recipients', (SELECT COUNT(*) FROM public.app_users AS app_user WHERE app_user.tenant_id = tenant.id AND app_user.is_active
            AND (app_user.role = 'ADMIN' OR (announcement.audience = 'ALL' AND app_user.role = 'MANAGER'))),
          'reads', COALESCE((SELECT jsonb_agg(jsonb_build_object('displayName', reading.display_name, 'email', reading.email, 'readAt', reading.read_at)
              ORDER BY reading.read_at)
            FROM public.network_announcement_reads AS reading
            WHERE reading.announcement_id = announcement.id AND reading.tenant_id = tenant.id), '[]'::JSONB)
        ) ORDER BY COALESCE(tenant.trade_name, tenant.legal_name))
        FROM public.tenants AS tenant
        WHERE tenant.network_id = v_me.network_id
          AND (announcement.target_tenant_ids IS NULL OR tenant.id = ANY (announcement.target_tenant_ids))
      ), '[]'::JSONB)
    ) ORDER BY announcement.created_at DESC)
    FROM public.network_announcements AS announcement
    WHERE announcement.network_id = v_me.network_id
  ), '[]'::JSONB);
END;
$$;

REVOKE ALL ON FUNCTION public.network_list_announcements() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_list_announcements() TO authenticated;

-- ERP: comunicados para o usuario logado (vazio para quem nao e de uma rede).
CREATE OR REPLACE FUNCTION public.list_my_announcements()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', announcement.id, 'title', announcement.title, 'body', announcement.body,
      'priority', announcement.priority, 'attachments', announcement.attachments,
      'networkName', network.name, 'createdByName', announcement.created_by_name,
      'createdAt', announcement.created_at, 'expiresOn', announcement.expires_on,
      'readAt', (SELECT reading.read_at FROM public.network_announcement_reads AS reading
        WHERE reading.announcement_id = announcement.id AND reading.auth_uid = auth.uid())
    ) ORDER BY announcement.created_at DESC)
    FROM public.network_announcements AS announcement
    JOIN public.networks AS network ON network.id = announcement.network_id
    WHERE public.announcement_visible_to_me(announcement)
  ), '[]'::JSONB);
END;
$$;

REVOKE ALL ON FUNCTION public.list_my_announcements() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_my_announcements() TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_my_announcement_read(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_announcement public.network_announcements%ROWTYPE;
  v_user public.app_users%ROWTYPE;
BEGIN
  SELECT * INTO v_announcement FROM public.network_announcements WHERE id = p_id;
  IF NOT FOUND OR NOT public.announcement_visible_to_me(v_announcement) THEN
    RAISE EXCEPTION 'Comunicado não encontrado';
  END IF;
  SELECT * INTO v_user FROM public.app_users WHERE auth_uid = auth.uid();
  INSERT INTO public.network_announcement_reads (announcement_id, auth_uid, tenant_id, display_name, email, read_at)
  VALUES (p_id, auth.uid(), v_user.tenant_id, v_user.display_name, (SELECT email FROM auth.users WHERE id = auth.uid()), NOW())
  ON CONFLICT (announcement_id, auth_uid) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_my_announcement_read(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_my_announcement_read(UUID) TO authenticated;

-- ---------------- Anexos (Storage) ----------------
-- Caminho: <network_id>/<announcement_id>/<arquivo>. Escreve/apaga: usuario da rede dona da pasta.
-- Le: usuario da rede dona da pasta ou usuario do ERP que pode ver o comunicado.
CREATE OR REPLACE FUNCTION public.network_announcement_file_allowed(p_name TEXT, p_write BOOLEAN)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_network TEXT := split_part(COALESCE(p_name, ''), '/', 1);
  v_announcement TEXT := split_part(COALESCE(p_name, ''), '/', 2);
  v_row public.network_announcements%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM public.network_users WHERE auth_uid = auth.uid() AND is_active AND network_id::TEXT = v_network) THEN
    RETURN true;
  END IF;
  IF p_write OR v_announcement !~ '^[0-9a-fA-F-]{36}$' THEN
    RETURN false;
  END IF;
  SELECT * INTO v_row FROM public.network_announcements WHERE id = v_announcement::UUID AND network_id::TEXT = v_network;
  RETURN FOUND AND public.announcement_visible_to_me(v_row);
END;
$$;

REVOKE ALL ON FUNCTION public.network_announcement_file_allowed(TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_announcement_file_allowed(TEXT, BOOLEAN) TO authenticated;

-- Bucket privado: PDF e imagens ate 10 MB.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('network-announcements', 'network-announcements', false, 10485760,
  ARRAY['application/pdf', 'image/png', 'image/jpeg', 'image/webp'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS network_announcements_files_read ON storage.objects;
CREATE POLICY network_announcements_files_read ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'network-announcements' AND public.network_announcement_file_allowed(name, false));

DROP POLICY IF EXISTS network_announcements_files_insert ON storage.objects;
CREATE POLICY network_announcements_files_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'network-announcements' AND public.network_announcement_file_allowed(name, true));

DROP POLICY IF EXISTS network_announcements_files_delete ON storage.objects;
CREATE POLICY network_announcements_files_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'network-announcements' AND public.network_announcement_file_allowed(name, true));
