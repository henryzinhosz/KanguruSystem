-- Apply once to the ERP project where app_users was created without display_name.
-- The POS RPCs require a non-null name to record sales and stock movements.

alter table public.app_users
  add column if not exists display_name text;

update public.app_users app_user
set display_name = coalesce(
  nullif(app_user.display_name, ''),
  nullif(auth_user.raw_user_meta_data ->> 'display_name', ''),
  nullif(auth_user.raw_user_meta_data ->> 'name', ''),
  split_part(auth_user.email, '@', 1)
)
from auth.users auth_user
where auth_user.id = app_user.auth_uid
  and coalesce(app_user.display_name, '') = '';

-- Fail early if a user still has no display name after the backfill.
do $$
begin
  if exists (select 1 from public.app_users where display_name is null or display_name = '') then
    raise exception 'Every app_users record must have a display_name before POS use';
  end if;
end;
$$;