BEGIN;

CREATE OR REPLACE FUNCTION public.platform_create_pos_terminal_activation(
  p_tenant_id UUID,
  p_unit_id TEXT,
  p_terminal_label TEXT,
  p_expires_in_minutes INTEGER DEFAULT 15
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  activation public.pos_terminal_activations;
  activation_code TEXT;
BEGIN
  IF NOT public.current_user_is_super_admin() THEN
    RAISE EXCEPTION 'Acesso restrito à administração da plataforma';
  END IF;

  IF NULLIF(BTRIM(p_unit_id), '') IS NULL THEN
    RAISE EXCEPTION 'Unidade obrigatória';
  END IF;

  IF NULLIF(BTRIM(p_terminal_label), '') IS NULL THEN
    RAISE EXCEPTION 'Identificação do terminal obrigatória';
  END IF;

  IF p_expires_in_minutes IS NULL OR p_expires_in_minutes NOT BETWEEN 1 AND 1440 THEN
    RAISE EXCEPTION 'O prazo deve estar entre 1 e 1440 minutos';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.store_configs
    WHERE tenant_id = p_tenant_id
      AND unit_id = BTRIM(p_unit_id)
  ) THEN
    RAISE EXCEPTION 'Unidade não encontrada para este tenant';
  END IF;

  activation_code := UPPER(SUBSTR(ENCODE(gen_random_bytes(9), 'hex'), 1, 12));

  INSERT INTO public.pos_terminal_activations (
    code_hash,
    tenant_id,
    unit_id,
    terminal_label,
    expires_at
  )
  VALUES (
    crypt(activation_code, gen_salt('bf', 12)),
    p_tenant_id,
    BTRIM(p_unit_id),
    BTRIM(p_terminal_label),
    NOW() + make_interval(mins => p_expires_in_minutes)
  )
  RETURNING * INTO activation;

  RETURN jsonb_build_object(
    'code', activation_code,
    'activation', jsonb_build_object(
      'id', activation.id,
      'code_hash', activation.code_hash,
      'tenant_id', activation.tenant_id,
      'unit_id', activation.unit_id,
      'terminal_label', activation.terminal_label,
      'expires_at', activation.expires_at,
      'used_at', activation.used_at,
      'used_by_auth_uid', activation.used_by_auth_uid,
      'revoked_at', activation.revoked_at,
      'created_at', activation.created_at
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_list_pos_terminal_activations(
  p_tenant_id UUID,
  p_unit_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  code_hash TEXT,
  tenant_id UUID,
  unit_id TEXT,
  terminal_label TEXT,
  expires_at TIMESTAMPTZ,
  used_at TIMESTAMPTZ,
  used_by_auth_uid UUID,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  status TEXT
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
    activation.id,
    activation.code_hash,
    activation.tenant_id,
    activation.unit_id,
    activation.terminal_label,
    activation.expires_at,
    activation.used_at,
    activation.used_by_auth_uid,
    activation.revoked_at,
    activation.created_at,
    CASE
      WHEN activation.revoked_at IS NOT NULL THEN 'REVOGADO'
      WHEN activation.used_at IS NOT NULL THEN 'USADO'
      WHEN activation.expires_at <= NOW() THEN 'EXPIRADO'
      ELSE 'PENDENTE'
    END
  FROM public.pos_terminal_activations AS activation
  WHERE activation.tenant_id = p_tenant_id
    AND (p_unit_id IS NULL OR activation.unit_id = BTRIM(p_unit_id))
  ORDER BY activation.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.platform_create_pos_terminal_activation(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.platform_list_pos_terminal_activations(UUID, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.platform_create_pos_terminal_activation(UUID, TEXT, TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_list_pos_terminal_activations(UUID, TEXT) TO authenticated;

COMMIT;