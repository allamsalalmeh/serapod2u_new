-- Stand-ins for the platform pieces the QR migration touches (disposable DB only).
alter table public.users add column if not exists principal_type text;
create table public.orders (id uuid primary key default gen_random_uuid(), order_type text, status text, seller_org_id uuid, buyer_org_id uuid, company_id uuid);
create table public.qr_batches (id uuid primary key default gen_random_uuid(), order_id uuid references public.orders(id), company_id uuid, status text default 'generated');
create function public.sa_actor_org_id() returns uuid language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select u.organization_id from public.users u where u.id = auth.uid() and u.is_active is true $$;
create function public.sa_actor_is_staff(p_max integer) returns boolean language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select exists (select 1 from public.users u where u.id = auth.uid() and u.principal_type = 'INTERNAL_EMPLOYEE') $$;
create function public.sa_actor_is_supply_partner() returns boolean language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select exists (select 1 from public.users u where u.id = auth.uid() and u.principal_type in ('MANUFACTURER_USER','DISTRIBUTOR_USER')) $$;
alter table public.qr_batches enable row level security;
create policy sa_staff_read on public.qr_batches for select to authenticated using (public.sa_actor_is_staff(40) or public.sa_actor_is_supply_partner());
grant select on public.qr_batches, public.orders to authenticated;
-- Same shape as the production function: DECLARE ... BEGIN with the existing S&A guard right after it.
create function public.mark_batch_as_printed(p_batch_id uuid) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
DECLARE
  v_updated integer := 0;
BEGIN
  /* sa-guard:qr.batch.manage */
  PERFORM public.sa_require_operation('qr.batch.manage', jsonb_build_object('organization_id', public.sa_actor_org_id()), 'qr_batch', p_batch_id::text);
  UPDATE public.qr_batches SET status = 'printing' WHERE id = p_batch_id AND status = 'generated';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN jsonb_build_object('updated', v_updated);
END
$$;
grant execute on function public.mark_batch_as_printed(uuid) to authenticated;
