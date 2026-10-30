-- =========================================================================
-- Usuarios do ERP criados pelo proprio franqueado (desenho aprovado em 2026-10-30).
-- O dono (ADMIN) cria logins para a equipe: Administrador (tudo) ou Gerente de loja
-- (uma ou mais lojas; areas do ERP marcaveis). A separacao por loja ja e feita no banco
-- por current_user_has_store_access (app_users.unit_id + user_store_access).
-- Login (criar, trocar senha, desativar) e feito pela Edge Function manage-tenant-users
-- com a chave de servico; aqui ficam as colunas e as funcoes que ela e o ERP usam.
-- Aditiva: colunas novas em app_users e funcoes novas.
-- =========================================================================

ALTER TABLE public.app_users
  ADD COLUMN IF NOT EXISTS permissions JSONB,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- Lojas que o usuario logado acessa (o ERP mostra so estas nos seletores).
-- NULL = todas (administrador).
CREATE OR REPLACE FUNCTION public.get_my_erp_access()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user public.app_users%ROWTYPE;
  v_stores TEXT[];
BEGIN
  SELECT * INTO v_user FROM public.app_users WHERE auth_uid = auth.uid();
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_user.role <> 'ADMIN' AND v_user.role <> 'SUPER_ADMIN' THEN
    SELECT array_agg(DISTINCT unit_id ORDER BY unit_id) INTO v_stores
    FROM (
      SELECT v_user.unit_id AS unit_id WHERE v_user.unit_id IS NOT NULL
      UNION
      SELECT access.unit_id FROM public.user_store_access AS access
      WHERE access.auth_uid = v_user.auth_uid AND access.tenant_id = v_user.tenant_id
    ) AS stores;
  END IF;
  RETURN jsonb_build_object(
    'displayName', v_user.display_name,
    'permissions', v_user.permissions,
    'isActive', v_user.is_active,
    'stores', to_jsonb(v_stores)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_erp_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_erp_access() TO authenticated;

-- Lista da equipe para o dono (e-mail e ultimo acesso vem do login).
CREATE OR REPLACE FUNCTION public.list_tenant_users()
RETURNS TABLE (
  auth_uid UUID,
  email TEXT,
  display_name TEXT,
  role TEXT,
  stores TEXT[],
  permissions JSONB,
  is_active BOOLEAN,
  last_sign_in_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
BEGIN
  IF v_tenant_id IS NULL OR NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'Só o administrador da empresa vê os usuários';
  END IF;
  RETURN QUERY
  SELECT app_user.auth_uid, auth_user.email::TEXT, app_user.display_name, app_user.role,
    (SELECT array_agg(DISTINCT unit_id ORDER BY unit_id) FROM (
       SELECT app_user.unit_id AS unit_id WHERE app_user.unit_id IS NOT NULL
       UNION
       SELECT access.unit_id FROM public.user_store_access AS access
       WHERE access.auth_uid = app_user.auth_uid AND access.tenant_id = v_tenant_id
     ) AS user_stores),
    app_user.permissions, app_user.is_active, auth_user.last_sign_in_at
  FROM public.app_users AS app_user
  JOIN auth.users AS auth_user ON auth_user.id = app_user.auth_uid
  WHERE app_user.tenant_id = v_tenant_id
  ORDER BY app_user.role, app_user.display_name;
END;
$$;

REVOKE ALL ON FUNCTION public.list_tenant_users() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_tenant_users() TO authenticated;

-- Grava perfil, lojas e areas de um usuario da empresa. Usada pela Edge Function
-- (criacao, com p_caller) e pelo ERP (edicao, caller = quem esta logado).
-- Regras: so ADMIN mexe; o dono nao pode tirar o proprio acesso de administrador;
-- gerente precisa de ao menos uma loja da propria empresa.
CREATE OR REPLACE FUNCTION public.save_tenant_user(
  p_caller UUID,
  p_auth_uid UUID,
  p_display_name TEXT,
  p_role TEXT,
  p_stores TEXT[],
  p_permissions JSONB,
  p_create BOOLEAN DEFAULT false
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller public.app_users%ROWTYPE;
  v_target public.app_users%ROWTYPE;
  v_store TEXT;
BEGIN
  -- Pelo ERP o chamador e sempre quem esta logado; so a chave de servico informa outro.
  IF auth.role() <> 'service_role' THEN
    p_caller := auth.uid();
  END IF;
  SELECT * INTO v_caller FROM public.app_users WHERE auth_uid = p_caller;
  IF NOT FOUND OR v_caller.role <> 'ADMIN' OR v_caller.tenant_id IS NULL OR NOT v_caller.is_active THEN
    RAISE EXCEPTION 'Só o administrador da empresa pode gerenciar usuários';
  END IF;
  IF p_role NOT IN ('ADMIN', 'MANAGER') THEN
    RAISE EXCEPTION 'Perfil inválido';
  END IF;
  IF NULLIF(BTRIM(COALESCE(p_display_name, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Informe o nome do usuário';
  END IF;

  IF p_role = 'MANAGER' THEN
    IF p_stores IS NULL OR array_length(p_stores, 1) IS NULL THEN
      RAISE EXCEPTION 'Escolha ao menos uma loja para o gerente';
    END IF;
    FOREACH v_store IN ARRAY p_stores LOOP
      IF NOT EXISTS (SELECT 1 FROM public.store_configs WHERE tenant_id = v_caller.tenant_id AND unit_id = v_store) THEN
        RAISE EXCEPTION 'Loja % não encontrada', v_store;
      END IF;
    END LOOP;
  END IF;

  IF p_create THEN
    IF auth.role() <> 'service_role' THEN
      RAISE EXCEPTION 'Usuário novo é criado pelo serviço de usuários';
    END IF;
    INSERT INTO public.app_users (auth_uid, role, tenant_id, unit_id, display_name, permissions, is_active)
    VALUES (p_auth_uid, p_role, v_caller.tenant_id, CASE WHEN p_role = 'MANAGER' THEN p_stores[1] END,
      BTRIM(p_display_name), CASE WHEN p_role = 'MANAGER' THEN p_permissions END, true);
  ELSE
    SELECT * INTO v_target FROM public.app_users WHERE auth_uid = p_auth_uid AND tenant_id = v_caller.tenant_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Usuário não encontrado nesta empresa';
    END IF;
    IF p_auth_uid = p_caller AND p_role <> 'ADMIN' THEN
      RAISE EXCEPTION 'Você não pode tirar o seu próprio acesso de administrador';
    END IF;
    UPDATE public.app_users
    SET role = p_role,
        unit_id = CASE WHEN p_role = 'MANAGER' THEN p_stores[1] END,
        display_name = BTRIM(p_display_name),
        permissions = CASE WHEN p_role = 'MANAGER' THEN p_permissions END
    WHERE auth_uid = p_auth_uid AND tenant_id = v_caller.tenant_id;
  END IF;

  DELETE FROM public.user_store_access WHERE auth_uid = p_auth_uid AND tenant_id = v_caller.tenant_id;
  IF p_role = 'MANAGER' THEN
    INSERT INTO public.user_store_access (auth_uid, tenant_id, unit_id)
    SELECT p_auth_uid, v_caller.tenant_id, store FROM unnest(p_stores) AS store
    ON CONFLICT DO NOTHING;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.save_tenant_user(UUID, UUID, TEXT, TEXT, TEXT[], JSONB, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_tenant_user(UUID, UUID, TEXT, TEXT, TEXT[], JSONB, BOOLEAN) TO authenticated, service_role;

-- Ativar/desativar (a Edge Function tambem bloqueia o login). So pela chave de servico.
CREATE OR REPLACE FUNCTION public.set_tenant_user_active(p_caller UUID, p_auth_uid UUID, p_active BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller public.app_users%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Função restrita ao serviço de usuários';
  END IF;
  SELECT * INTO v_caller FROM public.app_users WHERE auth_uid = p_caller;
  IF NOT FOUND OR v_caller.role <> 'ADMIN' OR v_caller.tenant_id IS NULL OR NOT v_caller.is_active THEN
    RAISE EXCEPTION 'Só o administrador da empresa pode gerenciar usuários';
  END IF;
  IF p_auth_uid = p_caller THEN
    RAISE EXCEPTION 'Você não pode desativar a sua própria conta';
  END IF;
  UPDATE public.app_users SET is_active = p_active
  WHERE auth_uid = p_auth_uid AND tenant_id = v_caller.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Usuário não encontrado nesta empresa';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_tenant_user_active(UUID, UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_tenant_user_active(UUID, UUID, BOOLEAN) TO service_role;
