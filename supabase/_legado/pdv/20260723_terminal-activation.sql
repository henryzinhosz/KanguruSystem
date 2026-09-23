-- Kanguru PDV: anonymous device activation and terminal-level admin password.
-- Prerequisite: enable Anonymous Sign-Ins in Supabase Authentication settings.

begin;

create extension if not exists pgcrypto;

alter table public.pos_terminals
  add column if not exists device_auth_uid uuid references auth.users(id) on delete cascade,
  add column if not exists admin_password_hash text,
  add column if not exists activated_at timestamptz,
  add column if not exists last_unlocked_at timestamptz;

alter table public.pos_terminals
  alter column auth_user_id drop not null;

create unique index if not exists pos_terminals_device_auth_uid_key
  on public.pos_terminals (device_auth_uid)
  where device_auth_uid is not null;

create table if not exists public.pos_terminal_activations (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null,
  tenant_id uuid not null references public.tenants(id),
  unit_id text not null,
  terminal_label text not null default 'Caixa',
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by_auth_uid uuid references auth.users(id),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint pos_terminal_activations_expiration check (expires_at > created_at)
);

create index if not exists pos_terminal_activations_pending_idx
  on public.pos_terminal_activations (tenant_id, unit_id, expires_at)
  where used_at is null and revoked_at is null;

create table if not exists public.pos_terminal_activation_attempts (
  id uuid primary key default gen_random_uuid(),
  device_auth_uid uuid not null references auth.users(id) on delete cascade,
  succeeded boolean not null,
  created_at timestamptz not null default now()
);

create index if not exists pos_terminal_activation_attempts_rate_idx
  on public.pos_terminal_activation_attempts (device_auth_uid, created_at desc);

alter table public.pos_terminal_activations enable row level security;
alter table public.pos_terminal_activation_attempts enable row level security;

drop policy if exists "terminal reads own configuration" on public.pos_terminals;
create policy "device reads own terminal"
  on public.pos_terminals for select to authenticated
  using (device_auth_uid = auth.uid() and is_active);

create or replace function public.activate_pos_terminal(
  p_code text,
  p_terminal_name text default null
)
returns table (
  terminal_id uuid,
  terminal_name text,
  tenant_id uuid,
  unit_id text,
  trade_name text,
  legal_name text,
  cnpj text,
  address text,
  needs_admin_password boolean
)
language plpgsql
security definer
set search_path = public, extensions
as $$
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

  insert into public.pos_terminals (
    device_auth_uid, tenant_id, unit_id, display_name, is_active, activated_at
  ) values (
    auth.uid(), v_activation.tenant_id, v_activation.unit_id,
    coalesce(nullif(trim(p_terminal_name), ''), v_activation.terminal_label), true, now()
  ) returning * into v_terminal;

  update public.pos_terminal_activations
  set used_at = now(), used_by_auth_uid = auth.uid()
  where id = v_activation.id;

  insert into public.pos_terminal_activation_attempts (device_auth_uid, succeeded)
  values (auth.uid(), true);

  return query
  select v_terminal.id, v_terminal.display_name, v_terminal.tenant_id, v_terminal.unit_id,
    config.trade_name, config.legal_name, config.cnpj, config.address, true
  from public.store_configs config
  where config.tenant_id = v_terminal.tenant_id and config.unit_id = v_terminal.unit_id;
end;
$$;

create or replace function public.get_pos_terminal_context()
returns table (
  terminal_id uuid,
  terminal_name text,
  tenant_id uuid,
  unit_id text,
  trade_name text,
  legal_name text,
  cnpj text,
  address text,
  needs_admin_password boolean
)
language sql
security definer
set search_path = public
as $$
  select terminal.id, terminal.display_name, terminal.tenant_id, terminal.unit_id,
    config.trade_name, config.legal_name, config.cnpj, config.address,
    terminal.admin_password_hash is null
  from public.pos_terminals terminal
  join public.store_configs config
    on config.tenant_id = terminal.tenant_id and config.unit_id = terminal.unit_id
  where terminal.device_auth_uid = auth.uid() and terminal.is_active;
$$;

create or replace function public.set_pos_terminal_admin_password(p_password text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if length(p_password) < 8 then
    raise exception 'Administrative password must have at least 8 characters';
  end if;

  update public.pos_terminals
  set admin_password_hash = crypt(p_password, gen_salt('bf', 12)), updated_at = now()
  where device_auth_uid = auth.uid() and is_active and admin_password_hash is null;

  if not found then
    raise exception 'Terminal not found or administrative password already defined';
  end if;
end;
$$;

create or replace function public.unlock_pos_terminal(p_password text)
returns table (
  terminal_id uuid,
  terminal_name text,
  tenant_id uuid,
  unit_id text,
  trade_name text,
  legal_name text,
  cnpj text,
  address text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  update public.pos_terminals
  set last_unlocked_at = now()
  where device_auth_uid = auth.uid()
    and is_active
    and admin_password_hash = crypt(p_password, admin_password_hash);

  if not found then
    raise exception 'Invalid administrative password';
  end if;

  return query
  select terminal.id, terminal.display_name, terminal.tenant_id, terminal.unit_id,
    config.trade_name, config.legal_name, config.cnpj, config.address
  from public.pos_terminals terminal
  join public.store_configs config
    on config.tenant_id = terminal.tenant_id and config.unit_id = terminal.unit_id
  where terminal.device_auth_uid = auth.uid() and terminal.is_active;
end;
$$;

create or replace function public.search_pos_products(p_query text)
returns table (
  product_id text, sku text, name text, brand text, sell_price numeric, available_quantity integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_terminal public.pos_terminals%rowtype;
begin
  select * into v_terminal from public.pos_terminals
  where device_auth_uid = auth.uid() and is_active;
  if not found then raise exception 'Active terminal session required'; end if;

  return query
  select product.id, product.sku, product.name, product.brand, product.sell_price,
    coalesce((inventory.quantities -> v_terminal.unit_id ->> 'qty')::integer, 0)
  from public.products product
  join public.inventory inventory
    on inventory.tenant_id = v_terminal.tenant_id and inventory.product_id = product.id
  where product.tenant_id = v_terminal.tenant_id
    and (product.name ilike '%' || p_query || '%' or product.sku ilike '%' || p_query || '%')
    and coalesce((inventory.quantities -> v_terminal.unit_id ->> 'qty')::integer, 0) > 0
  order by product.name limit 20;
end;
$$;

create or replace function public.process_pos_terminal_sale(
  p_sale_id text, p_invoice_number text, p_items jsonb, p_payment_method text,
  p_gross_amount numeric, p_fee_amount numeric, p_net_amount numeric,
  p_client_cpf text, p_client_name text, p_timestamp timestamptz,
  p_status text, p_requires_approval boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_terminal public.pos_terminals%rowtype;
  item jsonb; item_product_id text; item_quantity integer; current_qty integer;
  inv_row public.inventory%rowtype;
begin
  select * into v_terminal from public.pos_terminals
  where device_auth_uid = auth.uid() and is_active;
  if not found then raise exception 'Active terminal session required'; end if;

  insert into public.sales (
    id, tenant_id, invoice_number, unit_id, items, payment_method, gross_amount, fee_amount,
    net_amount, operator_id, operator_name, client_cpf, client_name, timestamp, status, requires_approval
  ) values (
    p_sale_id, v_terminal.tenant_id, p_invoice_number, v_terminal.unit_id, p_items, p_payment_method,
    p_gross_amount, p_fee_amount, p_net_amount, v_terminal.id::text, v_terminal.display_name,
    p_client_cpf, p_client_name, p_timestamp, p_status, p_requires_approval
  );

  for item in select * from jsonb_array_elements(p_items) loop
    item_product_id := item->>'productId';
    item_quantity := (item->>'quantity')::integer;
    select * into inv_row from public.inventory
    where tenant_id = v_terminal.tenant_id and product_id = item_product_id for update;
    if not found then raise exception 'Product % was not found in inventory', item_product_id; end if;
    current_qty := coalesce((inv_row.quantities -> v_terminal.unit_id ->> 'qty')::integer, 0);
    if current_qty < item_quantity then
      raise exception 'Insufficient stock for product % in store %', item_product_id, v_terminal.unit_id;
    end if;
    update public.inventory
    set quantities = jsonb_set(inv_row.quantities, array[v_terminal.unit_id, 'qty'], to_jsonb(current_qty - item_quantity), true), updated_at = now()
    where tenant_id = v_terminal.tenant_id and product_id = item_product_id;
    insert into public.movements (
      id, tenant_id, product_id, variation_id, from_unit_id, to_unit_id, type, quantity,
      serials, card_condition, operator_id, operator_name, timestamp, reason
    ) values (
      gen_random_uuid()::text, v_terminal.tenant_id, item_product_id, item->>'variationId',
      v_terminal.unit_id, 'CLIENTE', 'SAIDA', item_quantity, item->'serials', item->>'cardCondition',
      v_terminal.id::text, v_terminal.display_name, p_timestamp, 'Venda registrada no PDV'
    );
  end loop;
end;
$$;

revoke execute on function public.validate_pos_operator_pin(text) from authenticated;
revoke execute on function public.set_pos_operator_pin(uuid, text) from authenticated;
revoke execute on function public.process_pos_sale_transaction(
  uuid, text, text, text, jsonb, text, numeric, numeric, numeric, text, text, timestamptz, text, boolean
) from authenticated;

grant execute on function public.activate_pos_terminal(text, text) to authenticated;
grant execute on function public.get_pos_terminal_context() to authenticated;
grant execute on function public.set_pos_terminal_admin_password(text) to authenticated;
grant execute on function public.unlock_pos_terminal(text) to authenticated;
grant execute on function public.search_pos_products(text) to authenticated;
grant execute on function public.process_pos_terminal_sale(
  text, text, jsonb, text, numeric, numeric, numeric, text, text, timestamptz, text, boolean
) to authenticated;

commit;