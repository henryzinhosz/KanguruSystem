BEGIN;

CREATE TABLE IF NOT EXISTS public.pdv_operators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  unit_id TEXT,
  name TEXT NOT NULL,
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pdv_operators_name_not_blank CHECK (NULLIF(BTRIM(name), '') IS NOT NULL),
  CONSTRAINT pdv_operators_permissions_object CHECK (jsonb_typeof(permissions) = 'object'),
  CONSTRAINT pdv_operators_store_fk
    FOREIGN KEY (tenant_id, unit_id)
    REFERENCES public.store_configs(tenant_id, unit_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS pdv_operators_tenant_id_idx ON public.pdv_operators(tenant_id);
CREATE INDEX IF NOT EXISTS pdv_operators_tenant_unit_id_idx ON public.pdv_operators(tenant_id, unit_id);

CREATE OR REPLACE FUNCTION public.set_pdv_operator_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_pdv_operator_updated_at ON public.pdv_operators;
CREATE TRIGGER set_pdv_operator_updated_at
  BEFORE UPDATE ON public.pdv_operators
  FOR EACH ROW EXECUTE FUNCTION public.set_pdv_operator_updated_at();

DROP TRIGGER IF EXISTS enforce_current_tenant_trigger ON public.pdv_operators;
CREATE TRIGGER enforce_current_tenant_trigger
  BEFORE INSERT OR UPDATE ON public.pdv_operators
  FOR EACH ROW EXECUTE FUNCTION public.enforce_current_tenant();

CREATE OR REPLACE FUNCTION public.current_user_is_tenant_admin_or_manager()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((
    SELECT role IN ('ADMIN', 'MANAGER')
    FROM public.app_users
    WHERE auth_uid = auth.uid()
  ), false);
$$;

ALTER TABLE public.pdv_operators ENABLE ROW LEVEL SECURITY;

CREATE POLICY pdv_operators_tenant_read ON public.pdv_operators
  FOR SELECT
  USING (
    public.current_user_is_tenant_admin_or_manager()
    AND tenant_id = public.current_user_tenant_id()
  );

CREATE POLICY pdv_operators_tenant_insert ON public.pdv_operators
  FOR INSERT
  WITH CHECK (
    public.current_user_is_tenant_admin_or_manager()
    AND tenant_id = public.current_user_tenant_id()
  );

CREATE POLICY pdv_operators_tenant_update ON public.pdv_operators
  FOR UPDATE
  USING (
    public.current_user_is_tenant_admin_or_manager()
    AND tenant_id = public.current_user_tenant_id()
  )
  WITH CHECK (
    public.current_user_is_tenant_admin_or_manager()
    AND tenant_id = public.current_user_tenant_id()
  );

CREATE POLICY pdv_operators_tenant_delete ON public.pdv_operators
  FOR DELETE
  USING (
    public.current_user_is_tenant_admin_or_manager()
    AND tenant_id = public.current_user_tenant_id()
  );

CREATE OR REPLACE FUNCTION public.platform_list_pdv_operators(p_tenant_id UUID)
RETURNS TABLE (
  id UUID,
  tenant_id UUID,
  unit_id TEXT,
  name TEXT,
  permissions JSONB,
  is_active BOOLEAN,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
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
    operator.id,
    operator.tenant_id,
    operator.unit_id,
    operator.name,
    operator.permissions,
    operator.is_active,
    operator.created_at,
    operator.updated_at
  FROM public.pdv_operators AS operator
  WHERE operator.tenant_id = p_tenant_id
  ORDER BY operator.name;
END;
$$;

REVOKE ALL ON FUNCTION public.platform_list_pdv_operators(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_list_pdv_operators(UUID) TO authenticated;

COMMIT;