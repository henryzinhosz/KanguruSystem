-- Aprovados em 2026-11-08.
-- A. Codigo de reativacao de terminal: o computador volta para o MESMO terminal (nome, caixa
--    aberto, historico e vendas offline pendentes), sem criar terminal novo.
--    activate_pos_terminal copiada da versao viva (md5 b4eff8ec848541a1c193108b13068cee):
--    so mudam o ramo da reativacao e o needs_admin_password final (mesmo resultado para terminal novo).
-- B. Exclusao da cobranca de repasse de um mes: o repasse e calculado na hora, entao a exclusao
--    fica registrada numa tabela propria e pode ser desfeita.
-- Aditiva: coluna e tabela novas, 2 funcoes novas e 2 CREATE OR REPLACE com a mesma assinatura.
BEGIN;

-- ---------------- A. Reativacao de terminal ----------------

-- CASCADE (e nao SET NULL): codigo pendente nunca pode virar codigo de terminal novo.
ALTER TABLE public.pos_terminal_activations
  ADD COLUMN IF NOT EXISTS target_terminal_id UUID REFERENCES public.pos_terminals(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION public.activate_pos_terminal(p_code text, p_terminal_name text DEFAULT NULL::text)
RETURNS TABLE(terminal_id uuid, terminal_name text, tenant_id uuid, unit_id text, trade_name text, legal_name text, cnpj text, address text, needs_admin_password boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_activation public.pos_terminal_activations%rowtype;
  v_terminal public.pos_terminals%rowtype;
  v_code text := upper(regexp_replace(p_code, '[^A-Za-z0-9]', '', 'g'));
begin
  if auth.uid() is null then
    raise exception 'Anonymous device session required';
  end if;

  if v_code !~ '^[A-Z0-9]{12}$' then
    raise exception 'Activation code must contain 12 letters or digits';
  end if;

  if (
    select count(*)
    from public.pos_terminal_activation_attempts attempt
    where attempt.device_auth_uid = auth.uid()
      and not attempt.succeeded
      and attempt.created_at > now() - interval '15 minutes'
  ) >= 5 then
    raise exception 'Too many activation attempts. Wait 15 minutes and try again';
  end if;

  select * into v_terminal
  from public.pos_terminals
  where device_auth_uid = auth.uid() and is_active;
  if found then
    return query
    select v_terminal.id, v_terminal.display_name, v_terminal.tenant_id, v_terminal.unit_id,
      config.trade_name, config.legal_name, config.cnpj, config.address,
      v_terminal.admin_password_hash is null
    from public.store_configs config
    where config.tenant_id = v_terminal.tenant_id and config.unit_id = v_terminal.unit_id;
    return;
  end if;

  select * into v_activation
  from public.pos_terminal_activations activation
  where activation.used_at is null
    and activation.revoked_at is null
    and activation.expires_at > now()
    and activation.code_hash = crypt(v_code, activation.code_hash)
  for update;

  if not found then
    insert into public.pos_terminal_activation_attempts (device_auth_uid, succeeded)
    values (auth.uid(), false);
    return;
  end if;

  if v_activation.target_terminal_id is not null then
    -- Reativacao: este aparelho assume o terminal que ja existe; o aparelho antigo perde o acesso.
    update public.pos_terminals as terminal
    set device_auth_uid = auth.uid(), activated_at = now(), updated_at = now()
    where terminal.id = v_activation.target_terminal_id and terminal.is_active
    returning terminal.* into v_terminal;

    if not found then
      -- Terminal excluido depois de gerar o codigo: o codigo nao vale mais.
      insert into public.pos_terminal_activation_attempts (device_auth_uid, succeeded)
      values (auth.uid(), false);
      return;
    end if;
  else
    insert into public.pos_terminals (
      device_auth_uid, tenant_id, unit_id, display_name, is_active, activated_at
    ) values (
      auth.uid(), v_activation.tenant_id, v_activation.unit_id,
      coalesce(nullif(trim(p_terminal_name), ''), v_activation.terminal_label), true, now()
    ) returning * into v_terminal;
  end if;

  update public.pos_terminal_activations
  set used_at = now(), used_by_auth_uid = auth.uid()
  where id = v_activation.id;

  insert into public.pos_terminal_activation_attempts (device_auth_uid, succeeded)
  values (auth.uid(), true);

  return query
  select v_terminal.id, v_terminal.display_name, v_terminal.tenant_id, v_terminal.unit_id,
    config.trade_name, config.legal_name, config.cnpj, config.address,
    v_terminal.admin_password_hash is null
  from public.store_configs config
  where config.tenant_id = v_terminal.tenant_id and config.unit_id = v_terminal.unit_id;
end;
$function$;

-- Gera o codigo de reativacao (mesmo retorno de platform_create_pos_terminal_activation).
CREATE OR REPLACE FUNCTION public.platform_create_pos_terminal_reactivation(p_terminal_id UUID, p_expires_in_minutes INTEGER DEFAULT 15)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_terminal public.pos_terminals%ROWTYPE;
  activation public.pos_terminal_activations;
  activation_code TEXT;
BEGIN
  IF NOT public.current_user_is_super_admin() THEN
    RAISE EXCEPTION 'Acesso restrito à administração da plataforma';
  END IF;

  IF p_expires_in_minutes IS NULL OR p_expires_in_minutes NOT BETWEEN 1 AND 1440 THEN
    RAISE EXCEPTION 'O prazo deve estar entre 1 e 1440 minutos';
  END IF;

  SELECT * INTO v_terminal FROM public.pos_terminals WHERE id = p_terminal_id AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Terminal não encontrado ou já excluído.';
  END IF;

  -- So um codigo valido por terminal: gerar outro invalida o anterior.
  UPDATE public.pos_terminal_activations
  SET revoked_at = NOW()
  WHERE target_terminal_id = p_terminal_id AND used_at IS NULL AND revoked_at IS NULL;

  activation_code := UPPER(SUBSTR(ENCODE(gen_random_bytes(9), 'hex'), 1, 12));

  INSERT INTO public.pos_terminal_activations (
    code_hash, tenant_id, unit_id, terminal_label, expires_at, target_terminal_id
  )
  VALUES (
    crypt(activation_code, gen_salt('bf', 12)),
    v_terminal.tenant_id,
    v_terminal.unit_id,
    v_terminal.display_name || ' (reativação)',
    NOW() + make_interval(mins => p_expires_in_minutes),
    p_terminal_id
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

REVOKE ALL ON FUNCTION public.platform_create_pos_terminal_reactivation(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.platform_create_pos_terminal_reactivation(UUID, INTEGER) TO authenticated;

-- ---------------- B. Exclusao da cobranca de repasse ----------------

CREATE TABLE IF NOT EXISTS public.network_royalty_waivers (
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  network_id UUID NOT NULL REFERENCES public.networks(id) ON DELETE CASCADE,
  month TEXT NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  waived_by_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, month)
);

ALTER TABLE public.network_royalty_waivers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.network_royalty_waivers FROM PUBLIC, anon, authenticated;

-- Copia da 20261117 (unica versao desta funcao) + cobranca excluida.
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
        'royalty', CASE
          WHEN payment.tenant_id IS NOT NULL THEN payment.royalty_amount
          WHEN waiver.tenant_id IS NOT NULL THEN 0
          ELSE public.network_royalty_amount(base.amount, rule.mode, rule.percent, rule.tiers)
        END,
        'paid', payment.tenant_id IS NOT NULL,
        'paidAt', payment.paid_at, 'notes', payment.notes, 'markedByName', payment.marked_by_name,
        'paidRule', payment.rule_snapshot,
        'waived', payment.tenant_id IS NULL AND waiver.tenant_id IS NOT NULL,
        'waivedByName', waiver.waived_by_name
      ) AS row_data
      FROM public.tenants AS tenant
      CROSS JOIN LATERAL (SELECT public.network_royalty_base(tenant.id, p_month, p_tz) AS amount) AS base
      LEFT JOIN public.network_royalty_rules AS rule ON rule.tenant_id = tenant.id
      LEFT JOIN public.network_royalty_payments AS payment ON payment.tenant_id = tenant.id AND payment.month = p_month
      LEFT JOIN public.network_royalty_waivers AS waiver ON waiver.tenant_id = tenant.id AND waiver.month = p_month
      WHERE tenant.network_id = v_me.network_id
    ) AS rows_data
  ), '[]'::JSONB);
END;
$$;

-- Exclui a cobranca do mes (dono ou gerente da rede, como marcar pago) ou desfaz.
CREATE OR REPLACE FUNCTION public.network_set_royalty_waived(p_tenant_id UUID, p_month TEXT, p_waived BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me public.network_users%ROWTYPE := public.current_network_user();
BEGIN
  PERFORM public.network_assert_tenant(p_tenant_id);
  IF p_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Mês inválido';
  END IF;
  IF NOT p_waived THEN
    DELETE FROM public.network_royalty_waivers WHERE tenant_id = p_tenant_id AND month = p_month;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.network_royalty_payments WHERE tenant_id = p_tenant_id AND month = p_month) THEN
    RAISE EXCEPTION 'Este mês já está pago. Desfaça o pagamento antes de excluir a cobrança.';
  END IF;
  INSERT INTO public.network_royalty_waivers (tenant_id, network_id, month, waived_by_name)
  VALUES (p_tenant_id, v_me.network_id, p_month, v_me.display_name)
  ON CONFLICT (tenant_id, month) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.network_set_royalty_waived(UUID, TEXT, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.network_set_royalty_waived(UUID, TEXT, BOOLEAN) TO authenticated;

COMMIT;
