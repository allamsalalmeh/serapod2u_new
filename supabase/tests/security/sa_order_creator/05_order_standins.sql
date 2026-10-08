-- Stand-ins for the order tables and helpers the order authorization objects use (disposable DB only).
-- public.orders already exists (sa_profiles/05_qr_standins.sql); it is extended to the columns save_order_with_items writes.
do $g$ begin if current_database() !~ '^sa_prof_test' then raise exception 'Refusing: not a disposable sa_prof_test* database'; end if; end $g$;
create type public.order_type as enum ('H2M', 'D2H', 'S2D');
alter table public.orders alter column order_type type public.order_type using order_type::public.order_type;
alter table public.orders add column if not exists warehouse_org_id uuid, add column if not exists units_per_case integer,
  add column if not exists qr_buffer_percent numeric, add column if not exists extra_qr_master integer,
  add column if not exists has_rfid boolean, add column if not exists has_points boolean, add column if not exists has_lucky_draw boolean,
  add column if not exists has_redeem boolean, add column if not exists payment_terms jsonb, add column if not exists notes text,
  add column if not exists created_by uuid, add column if not exists updated_by uuid,
  add column if not exists updated_at timestamptz not null default now(), add column if not exists order_no text;
alter table public.organizations add column if not exists default_warehouse_org_id uuid, add column if not exists payment_term_id uuid;
create table public.payment_terms (id uuid primary key default gen_random_uuid(), deposit_percentage numeric, balance_percentage numeric);
create table public.product_variants (id uuid primary key, product_id uuid not null);
create table public.order_items (id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid, variant_id uuid, qty integer, unit_price numeric, company_id uuid, units_per_case integer);

create function public.current_user_org_id() returns uuid language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select u.organization_id from public.users u where u.id = auth.uid() $$;
create function public.current_user_role_level() returns integer language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select r.role_level from public.users u join public.roles r on r.role_code = u.role_code where u.id = auth.uid() $$;
create function public.get_org_type(p_org uuid) returns text language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select o.org_type_code from public.organizations o where o.id = p_org $$;
create function public.get_company_id(p_org uuid) returns uuid language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  with recursive up as (select id, parent_org_id, org_type_code from public.organizations where id = p_org
    union all select o.id, o.parent_org_id, o.org_type_code from public.organizations o join up on o.id = up.parent_org_id)
  select id from up where org_type_code = 'HQ' limit 1 $$;
create function public.is_power_user() returns boolean language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select coalesce(public.current_user_role_level() <= 20, false) $$;

-- Row access stand-ins (production: orders_select/update, order_items_write); orders_insert is the REAL policy.
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
create policy saf_orders_read on public.orders for select to authenticated
  using (buyer_org_id = public.current_user_org_id() or seller_org_id = public.current_user_org_id());
create policy saf_orders_update on public.orders for update to authenticated
  using (buyer_org_id = public.current_user_org_id() or seller_org_id = public.current_user_org_id());
create policy saf_items_write on public.order_items for all to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and o.buyer_org_id = public.current_user_org_id()))
  with check (exists (select 1 from public.orders o where o.id = order_id and o.buyer_org_id = public.current_user_org_id()));
grant select, insert, update, delete on public.orders, public.order_items to authenticated;
grant select on public.product_variants, public.payment_terms, public.organizations to authenticated;
-- Supabase grants API roles usage on auth (auth.uid()); the bootstrap stand-in does not.
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant select on public.users, public.roles to authenticated;  -- the SECURITY INVOKER RPC reads them, as in Supabase
