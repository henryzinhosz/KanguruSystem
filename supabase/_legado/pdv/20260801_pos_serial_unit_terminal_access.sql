begin;

create or replace function public.pdv_list_available_serial_units(
  p_product_id text,
  p_unit_id text
)
returns table (
  id uuid,
  serial_number text,
  imei text,
  warranty_months integer
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
  where device_auth_uid = auth.uid()
    and is_active;

  if not found then
    raise exception 'Active terminal session required';
  end if;

  if p_unit_id <> v_terminal.unit_id then
    raise exception 'Acesso negado à loja';
  end if;

  return query
  select
    serial_unit.id,
    serial_unit.serial_number,
    serial_unit.imei,
    serial_unit.warranty_months
  from public.product_serial_units as serial_unit
  where serial_unit.tenant_id = v_terminal.tenant_id
    and serial_unit.product_id = p_product_id
    and serial_unit.unit_id = v_terminal.unit_id
    and serial_unit.status = 'DISPONIVEL'
  order by serial_unit.serial_number;
end;
$$;

commit;