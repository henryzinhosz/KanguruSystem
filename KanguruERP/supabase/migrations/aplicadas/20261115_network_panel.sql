-- =========================================================================
-- Painel da Rede, etapa 1 (desenho aprovado em 2026-11-01).
-- A franqueadora (ex.: BeB Games) acompanha as franquias da rede dela, so leitura.
-- - networks: a rede; tenants.network_id liga cada franqueado (lojas proprias da marca
--   entram como franqueado normal).
-- - network_users: logins da rede (OWNER = dono da rede, MANAGER = gerente da rede).
--   O SUPER_ADMIN cria a rede e o dono pelo UCP; o dono cria os gerentes no painel.
--   Logins sao criados pela Edge Function manage-network-users.
-- - Os numeros so saem por RPCs que conferem se a franquia e da rede de quem pergunta.
--   Nenhuma tabela das franquias ganhou politica nova de leitura.
-- Regras dos numeros iguais as do ERP (db/finance.ts): vendas CONCLUIDA no periodo;
-- faturamento = bruto - devolucoes (no periodo da venda); custo = custo congelado dos itens
-- de produto - custo que voltou; taxas = sales.fee_amount; despesas = expenses no periodo.
-- Aditiva: tabelas, coluna e funcoes novas.
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.networks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT networks_name_not_blank CHECK (NULLIF(BTRIM(name), '') IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS networks_name_key ON public.networks (LOWER(BTRIM(name)));

ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS network_id UUID REFERENCES public.networks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tenants_network_idx ON public.tenants (network_id);

CREATE TABLE IF NOT EXISTS public.network_users (
  auth_uid UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  network_id UUID NOT NULL REFERENCES public.networks(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('OWNER', 'MANAGER')),
  display_name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT network_users_name_not_blank CHECK (NULLIF(BTRIM(display_name), '') IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS network_users_network_idx ON public.network_users (network_id);

-- Sem politicas: leitura e escrita so pelas funcoes abaixo.
ALTER TABLE public.networks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.network_users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.networks, public.network_users FROM PUBLIC, anon, authenticated;

-- Login da rede ativo de quem esta logado (ou erro).
CREATE OR REPLACE FUNCTION public.current_network_user()
RETURNS public.network_users
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user public.network_users%ROWTYPE;
BEGIN
  SELECT * INTO v_user FROM public.network_users WHERE auth_uid = auth.uid() AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Acesso da rede negado';
  END IF;
  RETURN v_user;
END;
$$;

REVOKE ALL ON FUNCTION public.current_network_user() FROM PUBLIC, anon, authenticated;

-- ---------------- Acesso (login) ----------------

-- Quem esta logado e da rede? (o ERP usa para abrir o Painel da Rede). NULL = nao e.
CREATE OR REPLACE FUNCTION public.get_my_network_access()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'networkId', network.id, 'networkName', network.name, 'role', network_user.role,
    'displayName', network_user.display_name, 'isActive', network_user.is_active
  )
  FROM public.network_users AS network_user
  JOIN public.networks AS network ON network.id = network_user.network_id
  WHERE network_user.auth_uid = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.get_my_network_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_network_access() TO authenticated;

-- ---------------- UCP (SUPER_ADMIN) ----------------

CREATE OR REPLACE FUNCTION public.platform_list_networks()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.current_user_is_super_admin() THEN
    RAISE EXCEPTION 'Acesso negado';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', network.id, 'name', network.name,
      'tenants', (SELECT COUNT(*) FROM public.tenants WHERE network_id = network.id),
      'tenantIds', COALESCE((SELECT jsonb_agg(tenant.id) FROM public.tenants AS tenant WHERE tenant.network_id = network.id), '[]'::JSONB),
      'users', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'authUid', network_user.auth_uid, 'displayName', network_user.display_name, 'role', network_user.role,
          'isActive', network_user.is_active, 'email', auth_user.email
        ) ORDER BY network_user.role DESC, network_user.display_name)
        FROM public.network_users AS network_user
        JOIN auth.users AS auth_user ON auth_user.id = network_user.auth_uid
        WHERE network_user.network_id = network.id
      ), '[]'::JSONB)
    ) ORDER BY network.name)
    FROM public.networks AS network
  ), '[]'::JSONB);
END;
$$;

REVOKE ALL ON FUNCTION public.platform_list_networks() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_list_networks() TO authenticated;

CREATE OR REPLACE FUNCTION public.platform_save_network(p_id UUID, p_name TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF NOT public.current_user_is_super_admin() THEN
    RAISE EXCEPTION 'Acesso negado';
  END IF;
  IF NULLIF(BTRIM(COALESCE(p_name, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Informe o nome da rede';
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.networks (name) VALUES (BTRIM(p_name)) RETURNING id INTO v_id;
  ELSE
    UPDATE public.networks SET name = BTRIM(p_name) WHERE id = p_id RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'Rede não encontrada';
    END IF;
  END IF;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.platform_save_network(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_save_network(UUID, TEXT) TO authenticated;

-- Liga (ou desliga, com NULL) um franqueado a uma rede.
CREATE OR REPLACE FUNCTION public.platform_set_tenant_network(p_tenant_id UUID, p_network_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.current_user_is_super_admin() THEN
    RAISE EXCEPTION 'Acesso negado';
  END IF;
  UPDATE public.tenants SET network_id = p_network_id, updated_at = NOW() WHERE id = p_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Franqueado não encontrado';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.platform_set_tenant_network(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_set_tenant_network(UUID, UUID) TO authenticated;

-- Grava um login da rede (so a Edge Function, com a chave de servico, que ja conferiu
-- quem pediu: SUPER_ADMIN cria o dono; o dono cria gerentes da propria rede).
CREATE OR REPLACE FUNCTION public.service_save_network_user(
  p_auth_uid UUID,
  p_network_id UUID,
  p_role TEXT,
  p_display_name TEXT,
  p_active BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Função restrita ao serviço de usuários';
  END IF;
  INSERT INTO public.network_users (auth_uid, network_id, role, display_name, is_active)
  VALUES (p_auth_uid, p_network_id, p_role, BTRIM(p_display_name), COALESCE(p_active, true))
  ON CONFLICT (auth_uid) DO UPDATE
  SET role = EXCLUDED.role, display_name = EXCLUDED.display_name, is_active = EXCLUDED.is_active;
END;
$$;

REVOKE ALL ON FUNCTION public.service_save_network_user(UUID, UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_save_network_user(UUID, UUID, TEXT, TEXT, BOOLEAN) TO service_role;

-- ---------------- Painel da Rede ----------------

-- Usuarios da rede (o dono gerencia; o gerente so ve).
CREATE OR REPLACE FUNCTION public.network_list_users()
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
      'authUid', network_user.auth_uid, 'displayName', network_user.display_name, 'role', network_user.role,
      'isActive', network_user.is_active, 'email', auth_user.email, 'lastSignInAt', auth_user.last_sign_in_at
    ) ORDER BY network_user.role DESC, network_user.display_name)
    FROM public.network_users AS network_user
    JOIN auth.users AS auth_user ON auth_user.id = network_user.auth_uid
    WHERE network_user.network_id = v_me.network_id
  ), '[]'::JSONB);
END;
$$;

REVOKE ALL ON FUNCTION public.network_list_users() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_list_users() TO authenticated;

-- Franquias da rede: franqueado, contato e lojas.
CREATE OR REPLACE FUNCTION public.network_list_franchises()
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
      'tenantId', tenant.id, 'legalName', tenant.legal_name, 'tradeName', tenant.trade_name, 'cnpj', tenant.cnpj,
      'ownerName', tenant.owner_name, 'ownerPhone', tenant.owner_phone, 'ownerEmail', tenant.owner_email,
      'subscriptionStatus', tenant.subscription_status, 'createdAt', tenant.created_at,
      'stores', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'unitId', store.unit_id, 'tradeName', store.trade_name, 'legalName', store.legal_name, 'cnpj', store.cnpj,
          'address', store.address, 'phone', store.phone,
          'activeTerminals', (SELECT COUNT(*) FROM public.pos_terminals AS terminal
            WHERE terminal.tenant_id = store.tenant_id AND terminal.unit_id = store.unit_id AND terminal.is_active),
          'openCash', EXISTS (SELECT 1 FROM public.cash_register_sessions AS cash
            JOIN public.pos_terminals AS terminal ON terminal.id = cash.terminal_id
            WHERE terminal.tenant_id = store.tenant_id AND terminal.unit_id = store.unit_id AND cash.status = 'ABERTO'),
          'lastSaleAt', (SELECT MAX(sale."timestamp") FROM public.sales AS sale
            WHERE sale.tenant_id = store.tenant_id AND sale.unit_id = store.unit_id)
        ) ORDER BY store.trade_name)
        FROM public.store_configs AS store
        WHERE store.tenant_id = tenant.id AND store.unit_id <> 'central'
      ), '[]'::JSONB)
    ) ORDER BY COALESCE(tenant.trade_name, tenant.legal_name))
    FROM public.tenants AS tenant
    WHERE tenant.network_id = v_me.network_id
  ), '[]'::JSONB);
END;
$$;

REVOKE ALL ON FUNCTION public.network_list_franchises() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_list_franchises() TO authenticated;

-- Numeros por loja no periodo (mesmas regras do ERP).
CREATE OR REPLACE FUNCTION public.network_store_metrics(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ)
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
    WITH stores AS (
      SELECT store.tenant_id, store.unit_id, store.trade_name
      FROM public.store_configs AS store
      JOIN public.tenants AS tenant ON tenant.id = store.tenant_id
      WHERE tenant.network_id = v_me.network_id AND store.unit_id <> 'central'
    ), period_sales AS (
      SELECT sale.*
      FROM public.sales AS sale
      JOIN stores ON stores.tenant_id = sale.tenant_id AND stores.unit_id = sale.unit_id
      WHERE sale.status = 'CONCLUIDA' AND sale."timestamp" >= p_from AND sale."timestamp" < p_to
    ), sale_totals AS (
      SELECT sale.tenant_id, sale.unit_id,
        COUNT(*) AS sales_count,
        COALESCE(SUM(sale.gross_amount), 0) AS gross,
        COALESCE(SUM(sale.fee_amount), 0) AS fees,
        COALESCE(SUM((
          SELECT SUM(COALESCE(NULLIF(item->>'costTotal', '')::NUMERIC, 0))
          FROM jsonb_array_elements(COALESCE(sale.items, '[]'::JSONB)) AS item
          WHERE UPPER(COALESCE(item->>'itemType', 'PRODUCT')) = 'PRODUCT'
        )), 0) AS cost,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(sale.items, '[]'::JSONB)) AS item
          WHERE UPPER(COALESCE(item->>'itemType', 'PRODUCT')) = 'PRODUCT' AND NULLIF(item->>'costTotal', '') IS NULL
        )) AS missing_cost,
        COALESCE(SUM((
          SELECT SUM(COALESCE(NULLIF(item->>'lineTotal', '')::NUMERIC, 0))
          FROM jsonb_array_elements(COALESCE(sale.items, '[]'::JSONB)) AS item
          WHERE UPPER(COALESCE(item->>'itemType', '')) = 'SERVICE'
        )), 0) AS services
      FROM period_sales AS sale
      GROUP BY sale.tenant_id, sale.unit_id
    ), return_totals AS (
      SELECT sale.tenant_id, sale.unit_id,
        COALESCE(SUM(sale_return.total_amount), 0) AS returned,
        COALESCE(SUM((
          SELECT SUM(COALESCE(return_item.unit_cost, 0) * return_item.quantity)
          FROM public.sale_return_items AS return_item WHERE return_item.return_id = sale_return.id
        )), 0) AS cost_back
      FROM period_sales AS sale
      JOIN public.sale_returns AS sale_return ON sale_return.tenant_id = sale.tenant_id AND sale_return.sale_id = sale.id
      GROUP BY sale.tenant_id, sale.unit_id
    ), expense_totals AS (
      SELECT expense.tenant_id, expense.unit_id, COALESCE(SUM(expense.amount), 0) AS expenses
      FROM public.expenses AS expense
      JOIN stores ON stores.tenant_id = expense.tenant_id AND stores.unit_id = expense.unit_id
      WHERE expense."timestamp" >= p_from AND expense."timestamp" < p_to
      GROUP BY expense.tenant_id, expense.unit_id
    )
    SELECT jsonb_agg(jsonb_build_object(
      'tenantId', stores.tenant_id, 'unitId', stores.unit_id, 'storeName', stores.trade_name,
      'salesCount', COALESCE(sale_totals.sales_count, 0),
      'gross', ROUND(COALESCE(sale_totals.gross, 0), 2),
      'returned', ROUND(COALESCE(return_totals.returned, 0), 2),
      'cost', ROUND(COALESCE(sale_totals.cost, 0) - COALESCE(return_totals.cost_back, 0), 2),
      'fees', ROUND(COALESCE(sale_totals.fees, 0), 2),
      'expenses', ROUND(COALESCE(expense_totals.expenses, 0), 2),
      'services', ROUND(COALESCE(sale_totals.services, 0), 2),
      'salesMissingCost', COALESCE(sale_totals.missing_cost, 0)
    ) ORDER BY stores.trade_name)
    FROM stores
    LEFT JOIN sale_totals ON sale_totals.tenant_id = stores.tenant_id AND sale_totals.unit_id = stores.unit_id
    LEFT JOIN return_totals ON return_totals.tenant_id = stores.tenant_id AND return_totals.unit_id = stores.unit_id
    LEFT JOIN expense_totals ON expense_totals.tenant_id = stores.tenant_id AND expense_totals.unit_id = stores.unit_id
  ), '[]'::JSONB);
END;
$$;

REVOKE ALL ON FUNCTION public.network_store_metrics(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_store_metrics(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- Faturamento (bruto - devolucoes) por mes e por loja, para o grafico de evolucao.
-- p_tz: fuso de quem consulta (ex.: America/Sao_Paulo) para o mes bater com o calendario local.
CREATE OR REPLACE FUNCTION public.network_monthly_revenue(p_from TIMESTAMPTZ, p_to TIMESTAMPTZ, p_tz TEXT DEFAULT 'America/Sao_Paulo')
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
      'month', monthly.month, 'tenantId', monthly.tenant_id, 'unitId', monthly.unit_id,
      'revenue', ROUND(monthly.revenue, 2), 'salesCount', monthly.sales_count
    ) ORDER BY monthly.month, monthly.unit_id)
    FROM (
      SELECT to_char(sale."timestamp" AT TIME ZONE p_tz, 'YYYY-MM') AS month, sale.tenant_id, sale.unit_id,
        SUM(sale.gross_amount - COALESCE((
          SELECT SUM(sale_return.total_amount) FROM public.sale_returns AS sale_return
          WHERE sale_return.tenant_id = sale.tenant_id AND sale_return.sale_id = sale.id
        ), 0)) AS revenue,
        COUNT(*) AS sales_count
      FROM public.sales AS sale
      JOIN public.tenants AS tenant ON tenant.id = sale.tenant_id
      WHERE tenant.network_id = v_me.network_id AND sale.status = 'CONCLUIDA'
        AND sale."timestamp" >= p_from AND sale."timestamp" < p_to
      GROUP BY 1, 2, 3
    ) AS monthly
  ), '[]'::JSONB);
END;
$$;

REVOKE ALL ON FUNCTION public.network_monthly_revenue(TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_monthly_revenue(TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO authenticated;
