-- Apply once if validate_pos_operator_pin reports:
-- column reference "expires_at" is ambiguous

create or replace function public.validate_pos_operator_pin(p_pin text)
returns table (
  authorization_id uuid,
  operator_auth_uid uuid,
  operator_name text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_terminal public.pos_terminals%rowtype;
  v_operator record;
  v_authorization_id uuid;
  v_expires_at timestamptz;
begin
  select * into v_terminal
  from public.pos_terminals
  where auth_user_id = auth.uid() and is_active;

  if not found then
    raise exception 'Active POS terminal session required';
  end if;

  select user_record.auth_uid, user_record.display_name into v_operator
  from public.app_users user_record
  join public.pos_operator_units unit_access
    on unit_access.operator_auth_uid = user_record.auth_uid
    and unit_access.tenant_id = v_terminal.tenant_id
    and unit_access.unit_id = v_terminal.unit_id
    and unit_access.is_active
  join public.pos_operator_pins pin
    on pin.operator_auth_uid = user_record.auth_uid
  where user_record.tenant_id = v_terminal.tenant_id
    and user_record.role in ('SELLER', 'OPERATOR')
    and pin.pin_hash = crypt(p_pin, pin.pin_hash);

  if not found then
    insert into public.pos_operator_pin_events (terminal_id, tenant_id, unit_id, succeeded)
    values (v_terminal.id, v_terminal.tenant_id, v_terminal.unit_id, false);
    return;
  end if;

  v_authorization_id := gen_random_uuid();
  v_expires_at := now() + interval '15 minutes';

  insert into public.pos_operator_authorizations (
    id, terminal_id, tenant_id, unit_id, operator_auth_uid, expires_at
  ) values (
    v_authorization_id,
    v_terminal.id,
    v_terminal.tenant_id,
    v_terminal.unit_id,
    v_operator.auth_uid,
    v_expires_at
  );

  insert into public.pos_operator_pin_events (
    terminal_id, tenant_id, unit_id, operator_auth_uid, succeeded
  ) values (
    v_terminal.id,
    v_terminal.tenant_id,
    v_terminal.unit_id,
    v_operator.auth_uid,
    true
  );

  return query
  select v_authorization_id, v_operator.auth_uid, v_operator.display_name, v_expires_at;
end;
$$;

grant execute on function public.validate_pos_operator_pin(text) to authenticated;