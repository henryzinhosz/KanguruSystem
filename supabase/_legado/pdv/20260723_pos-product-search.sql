-- Apply this once if pos-terminal-and-pin.sql was already applied before
-- search_pos_products was added.

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

grant execute on function public.search_pos_products(text) to authenticated;