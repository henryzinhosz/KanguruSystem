-- Kanguru PDV: opening, movements and closing of terminal cash registers.

begin;

alter table public.sales
  add column if not exists cash_session_id uuid;

create table if not exists public.cash_register_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  unit_id text not null,
  terminal_id uuid not null references public.pos_terminals(id),
  cash_number text not null,
  status text not null check (status in ('ABERTO', 'FECHADO')),
  opened_at timestamptz not null default now(),
  opened_by_name text not null,
  opening_float_amount numeric not null default 0 check (opening_float_amount >= 0),
  closed_at timestamptz,
  closed_by_name text,
  notes text,
  expected_cash_amount numeric,
  counted_cash_amount numeric,
  cash_difference_amount numeric,
  expected_pix_amount numeric,
  counted_pix_amount numeric,
  pix_difference_amount numeric,
  expected_credit_amount numeric,
  counted_credit_amount numeric,
  credit_difference_amount numeric,
  expected_debit_amount numeric,
  counted_debit_amount numeric,
  debit_difference_amount numeric,
  expected_voucher_amount numeric,
  counted_voucher_amount numeric,
  voucher_difference_amount numeric,
  expected_credit_account_amount numeric,
  counted_credit_account_amount numeric,
  credit_account_difference_amount numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cash_register_closure_check check (
    (status = 'ABERTO' and closed_at is null)
    or (status = 'FECHADO' and closed_at is not null)
  )
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sales_cash_session_id_fkey'
      and conrelid = 'public.sales'::regclass
  ) then
    alter table public.sales
      add constraint sales_cash_session_id_fkey
      foreign key (cash_session_id) references public.cash_register_sessions(id);
  end if;
end;
$$;

create unique index if not exists cash_register_one_open_per_terminal_idx
  on public.cash_register_sessions (terminal_id)
  where status = 'ABERTO';

create index if not exists cash_register_sessions_terminal_idx
  on public.cash_register_sessions (terminal_id, opened_at desc);
create index if not exists sales_cash_session_idx
  on public.sales (cash_session_id);

create table if not exists public.cash_register_movements (
  id uuid primary key default gen_random_uuid(),
  cash_session_id uuid not null references public.cash_register_sessions(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id),
  unit_id text not null,
  terminal_id uuid not null references public.pos_terminals(id),
  type text not null check (type in ('SANGRIA', 'SUPRIMENTO')),
  amount numeric not null check (amount > 0),
  reason text not null,
  operator_name text not null,
  created_at timestamptz not null default now()
);

create index if not exists cash_register_movements_session_idx
  on public.cash_register_movements (cash_session_id, created_at);

alter table public.cash_register_sessions enable row level security;
alter table public.cash_register_movements enable row level security;

create or replace function public.get_open_pos_cash_register()
returns table (
  cash_session_id uuid, cash_number text, opened_at timestamptz,
  opened_by_name text, opening_float_amount numeric
)
language sql security definer set search_path = public
as $$
  select cash.id, cash.cash_number, cash.opened_at, cash.opened_by_name, cash.opening_float_amount
  from public.cash_register_sessions cash
  join public.pos_terminals terminal on terminal.id = cash.terminal_id
  where terminal.device_auth_uid = auth.uid()
    and terminal.is_active
    and cash.status = 'ABERTO';
$$;

create or replace function public.open_pos_cash_register(
  p_cash_number text,
  p_opened_by_name text,
  p_opening_float_amount numeric
)
returns table (
  cash_session_id uuid, cash_number text, opened_at timestamptz,
  opened_by_name text, opening_float_amount numeric
)
language plpgsql security definer set search_path = public
as $$
declare
  v_terminal public.pos_terminals%rowtype;
  v_cash public.cash_register_sessions%rowtype;
begin
  if coalesce(trim(p_cash_number), '') = '' or coalesce(trim(p_opened_by_name), '') = '' then
    raise exception 'Cash number and responsible name are required';
  end if;
  if p_opening_float_amount < 0 then raise exception 'Opening float cannot be negative'; end if;

  select * into v_terminal from public.pos_terminals
  where device_auth_uid = auth.uid() and is_active;
  if not found then raise exception 'Active terminal session required'; end if;

  insert into public.cash_register_sessions (
    tenant_id, unit_id, terminal_id, cash_number, status, opened_by_name, opening_float_amount
  ) values (
    v_terminal.tenant_id, v_terminal.unit_id, v_terminal.id,
    trim(p_cash_number), 'ABERTO', trim(p_opened_by_name), p_opening_float_amount
  ) returning * into v_cash;

  return query select v_cash.id, v_cash.cash_number, v_cash.opened_at, v_cash.opened_by_name, v_cash.opening_float_amount;
exception
  when unique_violation then raise exception 'There is already an open cash register for this terminal';
end;
$$;

create or replace function public.record_pos_cash_movement(
  p_type text, p_amount numeric, p_reason text, p_operator_name text
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_terminal public.pos_terminals%rowtype;
  v_cash public.cash_register_sessions%rowtype;
begin
  if p_type not in ('SANGRIA', 'SUPRIMENTO') then raise exception 'Invalid cash movement type'; end if;
  if p_amount <= 0 or coalesce(trim(p_reason), '') = '' or coalesce(trim(p_operator_name), '') = '' then
    raise exception 'Amount, reason and responsible name are required';
  end if;
  select * into v_terminal from public.pos_terminals where device_auth_uid = auth.uid() and is_active;
  if not found then raise exception 'Active terminal session required'; end if;
  select * into v_cash from public.cash_register_sessions
  where terminal_id = v_terminal.id and status = 'ABERTO' for update;
  if not found then raise exception 'Open cash register required'; end if;

  insert into public.cash_register_movements (
    cash_session_id, tenant_id, unit_id, terminal_id, type, amount, reason, operator_name
  ) values (
    v_cash.id, v_terminal.tenant_id, v_terminal.unit_id, v_terminal.id,
    p_type, p_amount, trim(p_reason), trim(p_operator_name)
  );
end;
$$;

create or replace function public.get_pos_cash_closure_summary()
returns table (
  cash_session_id uuid, cash_number text, opened_at timestamptz, opened_by_name text,
  opening_float_amount numeric, expected_cash_amount numeric, expected_pix_amount numeric,
  expected_credit_amount numeric, expected_debit_amount numeric, expected_voucher_amount numeric,
  expected_credit_account_amount numeric, supplies_amount numeric, withdrawals_amount numeric
)
language sql security definer set search_path = public
as $$
  with active_terminal as (
    select id from public.pos_terminals where device_auth_uid = auth.uid() and is_active
  ), active_cash as (
    select cash.* from public.cash_register_sessions cash
    join active_terminal terminal on terminal.id = cash.terminal_id
    where cash.status = 'ABERTO'
  ), sales_totals as (
    select sale.cash_session_id,
      coalesce(sum(sale.gross_amount) filter (where sale.payment_method = 'DINHEIRO'), 0) as cash_amount,
      coalesce(sum(sale.gross_amount) filter (where sale.payment_method = 'PIX'), 0) as pix_amount,
      coalesce(sum(sale.gross_amount) filter (where sale.payment_method = 'CREDITO'), 0) as credit_amount,
      coalesce(sum(sale.gross_amount) filter (where sale.payment_method = 'DEBITO'), 0) as debit_amount,
      coalesce(sum(sale.gross_amount) filter (where sale.payment_method = 'VOUCHER'), 0) as voucher_amount,
      coalesce(sum(sale.gross_amount) filter (where sale.payment_method = 'CREDIARIO'), 0) as credit_account_amount
    from public.sales sale join active_cash cash on cash.id = sale.cash_session_id
    where sale.status <> 'CANCELADA'
    group by sale.cash_session_id
  ), movement_totals as (
    select movement.cash_session_id,
      coalesce(sum(movement.amount) filter (where movement.type = 'SUPRIMENTO'), 0) as supplies_amount,
      coalesce(sum(movement.amount) filter (where movement.type = 'SANGRIA'), 0) as withdrawals_amount
    from public.cash_register_movements movement join active_cash cash on cash.id = movement.cash_session_id
    group by movement.cash_session_id
  )
  select cash.id, cash.cash_number, cash.opened_at, cash.opened_by_name, cash.opening_float_amount,
    cash.opening_float_amount + coalesce(sale.cash_amount, 0) + coalesce(movement.supplies_amount, 0) - coalesce(movement.withdrawals_amount, 0),
    coalesce(sale.pix_amount, 0), coalesce(sale.credit_amount, 0), coalesce(sale.debit_amount, 0),
    coalesce(sale.voucher_amount, 0), coalesce(sale.credit_account_amount, 0),
    coalesce(movement.supplies_amount, 0), coalesce(movement.withdrawals_amount, 0)
  from active_cash cash
  left join sales_totals sale on sale.cash_session_id = cash.id
  left join movement_totals movement on movement.cash_session_id = cash.id;
$$;

create or replace function public.close_pos_cash_register(
  p_closed_by_name text, p_counted_cash_amount numeric, p_counted_pix_amount numeric,
  p_counted_credit_amount numeric, p_counted_debit_amount numeric, p_counted_voucher_amount numeric,
  p_counted_credit_account_amount numeric, p_notes text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_terminal public.pos_terminals%rowtype;
  v_cash public.cash_register_sessions%rowtype;
  v_summary record;
begin
  if coalesce(trim(p_closed_by_name), '') = '' then raise exception 'Responsible name is required'; end if;
  if p_counted_cash_amount < 0 or p_counted_pix_amount < 0 or p_counted_credit_amount < 0
    or p_counted_debit_amount < 0 or p_counted_voucher_amount < 0 or p_counted_credit_account_amount < 0 then
    raise exception 'Counted amounts cannot be negative';
  end if;

  select * into v_terminal from public.pos_terminals
  where device_auth_uid = auth.uid() and is_active;
  if not found then raise exception 'Active terminal session required'; end if;
  select * into v_cash from public.cash_register_sessions
  where terminal_id = v_terminal.id and status = 'ABERTO' for update;
  if not found then raise exception 'Open cash register required'; end if;

  select * into v_summary from public.get_pos_cash_closure_summary();
  if not found then raise exception 'Open cash register required'; end if;

  update public.cash_register_sessions set
    status = 'FECHADO', closed_at = now(), closed_by_name = trim(p_closed_by_name), notes = nullif(trim(p_notes), ''),
    expected_cash_amount = v_summary.expected_cash_amount, counted_cash_amount = p_counted_cash_amount, cash_difference_amount = p_counted_cash_amount - v_summary.expected_cash_amount,
    expected_pix_amount = v_summary.expected_pix_amount, counted_pix_amount = p_counted_pix_amount, pix_difference_amount = p_counted_pix_amount - v_summary.expected_pix_amount,
    expected_credit_amount = v_summary.expected_credit_amount, counted_credit_amount = p_counted_credit_amount, credit_difference_amount = p_counted_credit_amount - v_summary.expected_credit_amount,
    expected_debit_amount = v_summary.expected_debit_amount, counted_debit_amount = p_counted_debit_amount, debit_difference_amount = p_counted_debit_amount - v_summary.expected_debit_amount,
    expected_voucher_amount = v_summary.expected_voucher_amount, counted_voucher_amount = p_counted_voucher_amount, voucher_difference_amount = p_counted_voucher_amount - v_summary.expected_voucher_amount,
    expected_credit_account_amount = v_summary.expected_credit_account_amount, counted_credit_account_amount = p_counted_credit_account_amount, credit_account_difference_amount = p_counted_credit_account_amount - v_summary.expected_credit_account_amount,
    updated_at = now()
  where id = v_summary.cash_session_id and status = 'ABERTO';
end;
$$;

create or replace function public.process_pos_terminal_sale(
  p_sale_id text, p_invoice_number text, p_items jsonb, p_payment_method text,
  p_gross_amount numeric, p_fee_amount numeric, p_net_amount numeric,
  p_client_cpf text, p_client_name text, p_timestamp timestamptz,
  p_status text, p_requires_approval boolean
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_terminal public.pos_terminals%rowtype;
  v_cash public.cash_register_sessions%rowtype;
  item jsonb; item_product_id text; item_quantity integer; current_qty integer;
  inv_row public.inventory%rowtype;
begin
  select * into v_terminal from public.pos_terminals where device_auth_uid = auth.uid() and is_active;
  if not found then raise exception 'Active terminal session required'; end if;
  select * into v_cash from public.cash_register_sessions where terminal_id = v_terminal.id and status = 'ABERTO' for update;
  if not found then raise exception 'Open cash register required before selling'; end if;

  insert into public.sales (
    id, tenant_id, cash_session_id, invoice_number, unit_id, items, payment_method, gross_amount, fee_amount,
    net_amount, operator_id, operator_name, client_cpf, client_name, timestamp, status, requires_approval
  ) values (
    p_sale_id, v_terminal.tenant_id, v_cash.id, p_invoice_number, v_terminal.unit_id, p_items, p_payment_method,
    p_gross_amount, p_fee_amount, p_net_amount, v_terminal.id::text, v_terminal.display_name,
    p_client_cpf, p_client_name, p_timestamp, p_status, p_requires_approval
  );
  for item in select * from jsonb_array_elements(p_items) loop
    item_product_id := item->>'productId'; item_quantity := (item->>'quantity')::integer;
    select * into inv_row from public.inventory where tenant_id = v_terminal.tenant_id and product_id = item_product_id for update;
    if not found then raise exception 'Product % was not found in inventory', item_product_id; end if;
    current_qty := coalesce((inv_row.quantities -> v_terminal.unit_id ->> 'qty')::integer, 0);
    if current_qty < item_quantity then raise exception 'Insufficient stock for product % in store %', item_product_id, v_terminal.unit_id; end if;
    update public.inventory set quantities = jsonb_set(inv_row.quantities, array[v_terminal.unit_id, 'qty'], to_jsonb(current_qty - item_quantity), true), updated_at = now()
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

grant execute on function public.get_open_pos_cash_register() to authenticated;
grant execute on function public.open_pos_cash_register(text, text, numeric) to authenticated;
grant execute on function public.record_pos_cash_movement(text, numeric, text, text) to authenticated;
grant execute on function public.get_pos_cash_closure_summary() to authenticated;
grant execute on function public.close_pos_cash_register(text, numeric, numeric, numeric, numeric, numeric, numeric, text) to authenticated;

commit;