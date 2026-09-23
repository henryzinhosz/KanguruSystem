-- Kanguru PDV migration for the current KanguruERP schema.
-- app_users: auth_uid, tenant_id, role, unit_id, display_name.

begin;

create extension if not exists pgcrypto;

create table if not exists public.pos_terminals (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id),
  unit_id text not null,
  display_name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, tenant_id, unit_id)
);

create table if not exists public.pos_operator_units (
  operator_auth_uid uuid not null references public.app_users(auth_uid) on delete cascade,
  tenant_id uuid not null references public.tenants(id),
  unit_id text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (operator_auth_uid, tenant_id, unit_id)
);

create table if not exists public.pos_operator_pins (
  operator_auth_uid uuid primary key references public.app_users(auth_uid) on delete cascade,
  pin_hash text not null,
  changed_at timestamptz not null default now(),
  changed_by uuid references auth.users(id)
);

create table if not exists public.pos_operator_authorizations (
  id uuid primary key default gen_random_uuid(),
  terminal_id uuid not null references public.pos_terminals(id) on delete cascade,
  tenant_id uuid not null,
  unit_id text not null,
  operator_auth_uid uuid not null references public.app_users(auth_uid),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint pos_operator_authorizations_expiration check (expires_at > created_at)
);

create table if not exists public.pos_operator_pin_events (
  id uuid primary key default gen_random_uuid(),
  terminal_id uuid not null references public.pos_terminals(id) on delete cascade,
  tenant_id uuid not null,
  unit_id text not null,
  operator_auth_uid uuid references public.app_users(auth_uid),
  succeeded boolean not null,
  created_at timestamptz not null default now()
);

create index if not exists pos_operator_authorizations_active_idx
  on public.pos_operator_authorizations (terminal_id, operator_auth_uid, expires_at)
  where revoked_at is null;

alter table public.pos_terminals enable row level security;
alter table public.pos_operator_units enable row level security;
alter table public.pos_operator_pins enable row level security;
alter table public.pos_operator_authorizations enable row level security;
alter table public.pos_operator_pin_events enable row level security;

create policy "terminal reads own configuration"
  on public.pos_terminals for select to authenticated
  using (auth_user_id = auth.uid() and is_active);

-- These tables are accessible only from security-definer functions.

create or replace function public.set_pos_operator_pin(
  p_operator_auth_uid uuid,
  p_pin text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not exists (
    select 1
    from public.app_users acting_user
    join public.app_users target_user
      on target_user.auth_uid = p_operator_auth_uid
      and target_user.tenant_id = acting_user.tenant_id
      and target_user.role in ('SELLER', 'OPERATOR')
    where acting_user.auth_uid = auth.uid()
      and acting_user.role in ('ADMIN', 'MANAGER')
  ) then
    raise exception 'Only an active administrator or manager from the same tenant can set a PIN';
  end if;

  if p_pin !~ '^[0-9]{4,8}$' then
    raise exception 'PIN must have 4 to 8 digits';
  end if;

  insert into public.pos_operator_pins (operator_auth_uid, pin_hash, changed_at, changed_by)
  values (p_operator_auth_uid, crypt(p_pin, gen_salt('bf', 12)), now(), auth.uid())
  on conflict (operator_auth_uid) do update
    set pin_hash = excluded.pin_hash,
        changed_at = excluded.changed_at,
        changed_by = excluded.changed_by;
end;
$$;

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
    v_authorization_id, v_terminal.id, v_terminal.tenant_id, v_terminal.unit_id, v_operator.auth_uid, v_expires_at
  );

  insert into public.pos_operator_pin_events (
    terminal_id, tenant_id, unit_id, operator_auth_uid, succeeded
  ) values (
    v_terminal.id, v_terminal.tenant_id, v_terminal.unit_id, v_operator.auth_uid, true
  );

  return query select v_authorization_id, v_operator.auth_uid, v_operator.display_name, v_expires_at;
end;
$$;

create or replace function public.search_pos_products(p_query text)
returns table (
  product_id text,
  sku text,
  name text,
  brand text,
  sell_price numeric,
  available_quantity integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_terminal public.pos_terminals%rowtype;
begin
  select * into v_terminal
  from public.pos_terminals
  where auth_user_id = auth.uid() and is_active;

  if not found then
    raise exception 'Active POS terminal session required';
  end if;

  return query
  select
    product.id,
    product.sku,
    product.name,
    product.brand,
    product.sell_price,
    coalesce((inventory.quantities -> v_terminal.unit_id ->> 'qty')::integer, 0)
  from public.products product
  join public.inventory inventory
    on inventory.tenant_id = v_terminal.tenant_id
    and inventory.product_id = product.id
  where product.tenant_id = v_terminal.tenant_id
    and (
      product.name ilike '%' || p_query || '%'
      or product.sku ilike '%' || p_query || '%'
    )
    and coalesce((inventory.quantities -> v_terminal.unit_id ->> 'qty')::integer, 0) > 0
  order by product.name
  limit 20;
end;
$$;

create or replace function public.process_pos_sale_transaction(
  p_operator_authorization_id uuid,
  p_sale_id text, p_invoice_number text, p_unit_id text, p_items jsonb, p_payment_method text,
  p_gross_amount numeric, p_fee_amount numeric, p_net_amount numeric, p_client_cpf text,
  p_client_name text, p_timestamp timestamptz, p_status text, p_requires_approval boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_terminal public.pos_terminals%rowtype;
  v_authorization public.pos_operator_authorizations%rowtype;
  v_operator public.app_users%rowtype;
  item jsonb;
  item_product_id text;
  item_quantity integer;
  current_qty integer;
  inv_row public.inventory%rowtype;
begin
  select * into v_terminal
  from public.pos_terminals
  where auth_user_id = auth.uid() and is_active;

  if not found or v_terminal.unit_id <> p_unit_id then
    raise exception 'Active POS terminal session for the selected store is required';
  end if;

  select * into v_authorization
  from public.pos_operator_authorizations
  where id = p_operator_authorization_id
    and terminal_id = v_terminal.id
    and tenant_id = v_terminal.tenant_id
    and unit_id = v_terminal.unit_id
    and revoked_at is null
    and expires_at > now()
  for update;

  if not found then
    raise exception 'Valid operator authorization required';
  end if;

  select * into v_operator
  from public.app_users
  where auth_uid = v_authorization.operator_auth_uid
    and tenant_id = v_terminal.tenant_id
    and role in ('SELLER', 'OPERATOR');

  if not found then
    raise exception 'Authorized operator is no longer eligible for POS sales';
  end if;

  insert into public.sales (
    id, tenant_id, invoice_number, unit_id, items, payment_method, gross_amount, fee_amount,
    net_amount, operator_id, operator_name, client_cpf, client_name, timestamp, status, requires_approval
  ) values (
    p_sale_id, v_terminal.tenant_id, p_invoice_number, v_terminal.unit_id, p_items, p_payment_method,
    p_gross_amount, p_fee_amount, p_net_amount, v_operator.auth_uid::text, v_operator.display_name,
    p_client_cpf, p_client_name, p_timestamp, p_status, p_requires_approval
  );

  for item in select * from jsonb_array_elements(p_items) loop
    item_product_id := item->>'productId';
    item_quantity := (item->>'quantity')::integer;
    select * into inv_row from public.inventory
    where tenant_id = v_terminal.tenant_id and product_id = item_product_id
    for update;

    if not found then
      raise exception 'Product % was not found in inventory', item_product_id;
    end if;

    current_qty := coalesce((inv_row.quantities -> v_terminal.unit_id ->> 'qty')::integer, 0);
    if current_qty < item_quantity then
      raise exception 'Insufficient stock for product % in store %', item_product_id, v_terminal.unit_id;
    end if;

    update public.inventory
    set quantities = jsonb_set(
          inv_row.quantities,
          array[v_terminal.unit_id, 'qty'],
          to_jsonb(current_qty - item_quantity),
          true
        ),
        updated_at = now()
    where tenant_id = v_terminal.tenant_id and product_id = item_product_id;

    insert into public.movements (
      id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
      serials, card_condition, operator_id, operator_name, timestamp, reason
    ) values (
      gen_random_uuid()::text, v_terminal.tenant_id, item_product_id, item->>'variationId',
      v_terminal.unit_id, 'CLIENTE', 'SAIDA', item_quantity, item->'serials', item->>'cardCondition',
      v_operator.auth_uid::text, v_operator.display_name, p_timestamp, 'Venda registrada'
    );
  end loop;
end;
$$;

create or replace function public.process_pos_sale_cancellation(
  p_operator_authorization_id uuid,
  p_sale_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_terminal public.pos_terminals%rowtype;
  v_authorization public.pos_operator_authorizations%rowtype;
  v_operator public.app_users%rowtype;
  sale_row public.sales%rowtype;
  item jsonb;
  item_product_id text;
  item_quantity integer;
begin
  select * into v_terminal from public.pos_terminals
  where auth_user_id = auth.uid() and is_active;
  if not found then raise exception 'Active POS terminal session required'; end if;

  select * into v_authorization from public.pos_operator_authorizations
  where id = p_operator_authorization_id and terminal_id = v_terminal.id
    and tenant_id = v_terminal.tenant_id and unit_id = v_terminal.unit_id
    and revoked_at is null and expires_at > now()
  for update;
  if not found then raise exception 'Valid operator authorization required'; end if;

  select * into v_operator from public.app_users
  where auth_uid = v_authorization.operator_auth_uid and tenant_id = v_terminal.tenant_id
    and role in ('SELLER', 'OPERATOR');
  if not found then raise exception 'Authorized operator is no longer eligible for POS cancellation'; end if;

  select * into sale_row from public.sales
  where tenant_id = v_terminal.tenant_id and unit_id = v_terminal.unit_id and id = p_sale_id
  for update;
  if not found then raise exception 'Sale not found for this terminal store'; end if;
  if sale_row.status = 'CANCELADA' then raise exception 'Sale is already cancelled'; end if;

  update public.sales set status = 'CANCELADA', approved_by = v_operator.display_name
  where tenant_id = v_terminal.tenant_id and id = p_sale_id;

  for item in select * from jsonb_array_elements(sale_row.items) loop
    item_product_id := item->>'productId';
    item_quantity := (item->>'quantity')::integer;
    update public.inventory
    set quantities = jsonb_set(
          quantities,
          array[v_terminal.unit_id, 'qty'],
          to_jsonb(coalesce((quantities -> v_terminal.unit_id ->> 'qty')::integer, 0) + item_quantity),
          true
        ),
        updated_at = now()
    where tenant_id = v_terminal.tenant_id and product_id = item_product_id;

    insert into public.movements (
      id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
      serials, card_condition, operator_id, operator_name, timestamp, reason
    ) values (
      gen_random_uuid()::text, v_terminal.tenant_id, item_product_id, item->>'variationId',
      'CLIENTE', v_terminal.unit_id, 'SAIDA', item_quantity, item->'serials', item->>'cardCondition',
      v_operator.auth_uid::text, v_operator.display_name, now(), 'Cancelamento de venda'
    );
  end loop;
end;
$$;

revoke all on public.pos_operator_pins from anon, authenticated;
revoke all on public.pos_operator_authorizations from anon, authenticated;
revoke all on public.pos_operator_pin_events from anon, authenticated;
revoke all on function public.set_pos_operator_pin(uuid, text) from public;
grant execute on function public.set_pos_operator_pin(uuid, text) to authenticated;
grant execute on function public.validate_pos_operator_pin(text) to authenticated;
grant execute on function public.search_pos_products(text) to authenticated;
grant execute on function public.process_pos_sale_transaction(
  uuid, text, text, text, jsonb, text, numeric, numeric, numeric, text, text, timestamptz, text, boolean
) to authenticated;
grant execute on function public.process_pos_sale_cancellation(uuid, text) to authenticated;

commit;