-- =========================================================================
-- Contato do franqueado (pedido do usuario em 2026-11-01): nome real do franqueado,
-- telefone e e-mail de contato. Ficam no cadastro da empresa (tenants), para a futura
-- visao da marca no UCP (acompanhar as franquias). O dono (ADMIN) edita no ERP ›
-- Configuracoes › Minha conta; o UCP (SUPER_ADMIN) le direto da tabela.
-- Aditiva: 3 colunas novas em tenants e 2 RPCs novas.
-- =========================================================================

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS owner_name TEXT,
  ADD COLUMN IF NOT EXISTS owner_phone TEXT,
  ADD COLUMN IF NOT EXISTS owner_email TEXT;

-- Leitura para o ERP (qualquer usuario da empresa ve; so o dono edita).
CREATE OR REPLACE FUNCTION public.get_my_tenant_contact()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant public.tenants%ROWTYPE;
BEGIN
  SELECT * INTO v_tenant FROM public.tenants WHERE id = public.current_user_tenant_id();
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object('ownerName', v_tenant.owner_name, 'ownerPhone', v_tenant.owner_phone, 'ownerEmail', v_tenant.owner_email);
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_tenant_contact() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_tenant_contact() TO authenticated;

CREATE OR REPLACE FUNCTION public.save_my_tenant_contact(p_owner_name TEXT, p_owner_phone TEXT, p_owner_email TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := public.current_user_tenant_id();
  v_email TEXT := NULLIF(LOWER(BTRIM(COALESCE(p_owner_email, ''))), '');
BEGIN
  IF v_tenant_id IS NULL OR NOT public.current_user_is_admin() THEN
    RAISE EXCEPTION 'Só o administrador da empresa pode alterar os dados do franqueado';
  END IF;
  IF v_email IS NOT NULL AND v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'E-mail de contato inválido';
  END IF;
  UPDATE public.tenants
  SET owner_name = NULLIF(BTRIM(COALESCE(p_owner_name, '')), ''),
      owner_phone = NULLIF(BTRIM(COALESCE(p_owner_phone, '')), ''),
      owner_email = v_email,
      updated_at = NOW()
  WHERE id = v_tenant_id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_my_tenant_contact(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_my_tenant_contact(TEXT, TEXT, TEXT) TO authenticated;
