-- Kanguru PDV: search scope aligned with real catalog schema (sub-phase 2.3).
-- Expands search to SKU, name and brand.
-- Adds warranty months and serialized-product signal in RPC result.

begin;

drop function if exists public.search_pos_products(text);

create function public.search_pos_products(p_query text)
returns table (
  product_id text,
  sku text,
  name text,
  brand text,
  sell_price numeric,
  available_quantity integer,
  warranty_months integer,
  requires_unit_selection boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_terminal public.pos_terminals%rowtype;
  v_query text := trim(p_query);
begin
  if coalesce(v_query, '') = '' then
    return;
  end if;

  select * into v_terminal
  from public.pos_terminals
  where device_auth_uid = auth.uid() and is_active;

  if not found then
    raise exception 'Active terminal session required';
  end if;

  return query
  select
    product.id,
    product.sku,
    product.name,
    product.brand,
    product.sell_price,
    coalesce((inventory.quantities -> v_terminal.unit_id ->> 'qty')::integer, 0) as available_quantity,
    product.warranty_months,
    coalesce(product.is_serialized, false) as requires_unit_selection
  from public.products product
  join public.inventory inventory
    on inventory.tenant_id = v_terminal.tenant_id
    and inventory.product_id = product.id
  where product.tenant_id = v_terminal.tenant_id
    and (
      product.sku ilike '%' || v_query || '%'
      or product.name ilike '%' || v_query || '%'
      or coalesce(product.brand, '') ilike '%' || v_query || '%'
    )
    and coalesce((inventory.quantities -> v_terminal.unit_id ->> 'qty')::integer, 0) > 0
  order by
    case when product.sku ilike v_query then 0 else 1 end,
    product.name
  limit 20;
end;
$$;

grant execute on function public.search_pos_products(text) to authenticated;

commit;
