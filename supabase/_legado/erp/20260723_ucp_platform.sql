BEGIN;

ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS legal_name TEXT;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS trade_name TEXT;
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS cnpj TEXT;
ALTER TABLE public.app_users ALTER COLUMN unit_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.current_user_is_super_admin()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT role = 'SUPER_ADMIN'
    FROM public.app_users
    WHERE auth_uid = auth.uid()
  ), false);
$$;

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Platform super admins can read all tenants" ON public.tenants;
CREATE POLICY "Platform super admins can read all tenants"
  ON public.tenants
  FOR SELECT
  USING (public.current_user_is_super_admin());

DROP POLICY IF EXISTS "Platform super admins can update tenants" ON public.tenants;
CREATE POLICY "Platform super admins can update tenants"
  ON public.tenants
  FOR UPDATE
  USING (public.current_user_is_super_admin())
  WITH CHECK (public.current_user_is_super_admin());

DROP POLICY IF EXISTS "Platform super admins can read all app users" ON public.app_users;
CREATE POLICY "Platform super admins can read all app users"
  ON public.app_users
  FOR SELECT
  USING (public.current_user_is_super_admin());

DROP POLICY IF EXISTS "Platform super admins can read all store configs" ON public.store_configs;
CREATE POLICY "Platform super admins can read all store configs"
  ON public.store_configs
  FOR SELECT
  USING (public.current_user_is_super_admin());

CREATE OR REPLACE FUNCTION public.platform_list_tenants()
RETURNS TABLE (
  id UUID,
  legal_name TEXT,
  trade_name TEXT,
  cnpj TEXT,
  store_count BIGINT,
  subscription_status TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.current_user_is_super_admin() THEN
    RAISE EXCEPTION 'Acesso restrito à administração da plataforma';
  END IF;

  RETURN QUERY
  SELECT
    tenant.id,
    tenant.legal_name,
    tenant.trade_name,
    tenant.cnpj,
    COUNT(store.*),
    tenant.subscription_status,
    tenant.created_at
  FROM public.tenants AS tenant
  LEFT JOIN public.store_configs AS store ON store.tenant_id = tenant.id
  GROUP BY tenant.id
  ORDER BY tenant.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_tenant_details(p_tenant_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  tenant_details JSONB;
BEGIN
  IF NOT public.current_user_is_super_admin() THEN
    RAISE EXCEPTION 'Acesso restrito à administração da plataforma';
  END IF;

  SELECT jsonb_build_object(
    'tenant', jsonb_build_object(
      'id', tenant.id,
      'legalName', tenant.legal_name,
      'tradeName', tenant.trade_name,
      'cnpj', tenant.cnpj,
      'planCode', tenant.plan_code,
      'subscriptionStatus', tenant.subscription_status,
      'createdAt', tenant.created_at
    ),
    'stores', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'unitId', store.unit_id,
        'tradeName', store.trade_name,
        'legalName', store.legal_name,
        'cnpj', store.cnpj,
        'createdAt', store.created_at
      ) ORDER BY store.created_at)
      FROM public.store_configs AS store
      WHERE store.tenant_id = tenant.id
    ), '[]'::jsonb),
    'users', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'authUid', app_user.auth_uid,
        'email', auth_user.email,
        'role', app_user.role,
        'unitId', app_user.unit_id,
        'createdAt', auth_user.created_at
      ) ORDER BY auth_user.created_at)
      FROM public.app_users AS app_user
      LEFT JOIN auth.users AS auth_user ON auth_user.id = app_user.auth_uid
      WHERE app_user.tenant_id = tenant.id
    ), '[]'::jsonb)
  ) INTO tenant_details
  FROM public.tenants AS tenant
  WHERE tenant.id = p_tenant_id;

  IF tenant_details IS NULL THEN
    RAISE EXCEPTION 'Cliente não encontrado';
  END IF;

  RETURN tenant_details;
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_update_subscription_status(
  p_tenant_id UUID,
  p_subscription_status TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_tenant public.tenants;
BEGIN
  IF NOT public.current_user_is_super_admin() THEN
    RAISE EXCEPTION 'Acesso restrito à administração da plataforma';
  END IF;

  IF p_subscription_status NOT IN ('ATIVO', 'ATRASADO', 'BLOQUEADO', 'CANCELADO') THEN
    RAISE EXCEPTION 'Status de assinatura inválido';
  END IF;

  UPDATE public.tenants
  SET
    subscription_status = p_subscription_status,
    updated_at = NOW()
  WHERE id = p_tenant_id
  RETURNING * INTO updated_tenant;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cliente não encontrado';
  END IF;

  RETURN jsonb_build_object(
    'id', updated_tenant.id,
    'subscriptionStatus', updated_tenant.subscription_status
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.provision_tenant_admin(
  p_auth_uid UUID,
  p_legal_name TEXT,
  p_cnpj TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_tenant_id UUID;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Função restrita ao serviço de provisionamento';
  END IF;

  IF NULLIF(BTRIM(p_legal_name), '') IS NULL THEN
    RAISE EXCEPTION 'Razão social é obrigatória';
  END IF;

  IF p_cnpj !~ '^[0-9]{14}$' THEN
    RAISE EXCEPTION 'CNPJ inválido';
  END IF;

  INSERT INTO public.tenants (legal_name, trade_name, cnpj, subscription_status)
  VALUES (BTRIM(p_legal_name), BTRIM(p_legal_name), p_cnpj, 'ATIVO')
  RETURNING id INTO new_tenant_id;

  INSERT INTO public.app_users (auth_uid, role, tenant_id, unit_id)
  VALUES (p_auth_uid, 'ADMIN', new_tenant_id, NULL);

  RETURN new_tenant_id;
END;
$$;

REVOKE ALL ON FUNCTION public.platform_list_tenants() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_tenant_details(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_update_subscription_status(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.provision_tenant_admin(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.platform_list_tenants() TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_tenant_details(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_update_subscription_status(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.provision_tenant_admin(UUID, TEXT, TEXT) TO service_role;

COMMIT;