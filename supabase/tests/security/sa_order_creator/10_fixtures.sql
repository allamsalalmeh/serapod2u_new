-- Isolated Order Creator fixtures (never real data). Builds on the sa_root_access fixtures (o1 HQ, o2/o3 warehouses under
-- HQ, o4 manufacturer; u1 legacy Super Admin with S&A authority, u3 plain HQ level-10 member, u8 manufacturer user).
-- New: u20 HQ level 50 holding Order Approver only (the order@dev.com situation) | u21 HQ level 50, no policy
--      u22 distributor level 50 (o11, under HQ) | u23 HQ level 50, Root Administrator | u24 HQ level 50 (scope tests)
do $g$ begin if current_database() !~ '^sa_prof_test' then raise exception 'Refusing: not a disposable sa_prof_test* database'; end if; end $g$;
insert into public.roles(role_code, role_name, role_level) values ('HQ_USER', 'HQ User', 50), ('DIST_USER', 'Distributor User', 50);
insert into public.organizations(id, org_name, org_type_code, parent_org_id) values (saf.o(11), 'South Distributor', 'DIST', saf.o(1));
update public.organizations set default_warehouse_org_id = saf.o(2) where id = saf.o(1);
insert into public.sa_scope_definitions(id, organization_id, scope_type, scope_value, display_name) values
  (saf.s(11), saf.o(11), 'organization', saf.o(11)::text, 'South Distributor');
insert into auth.users(id, email) select saf.u(n), 'u' || n || '@dev.com' from generate_series(20, 24) n;
insert into public.users(id, email, full_name, role_code, organization_id, is_active) values
  (saf.u(20), 'u20@dev.com', 'Order Approver Only', 'HQ_USER', saf.o(1), true),
  (saf.u(21), 'u21@dev.com', 'HQ User', 'HQ_USER', saf.o(1), true),
  (saf.u(22), 'u22@dev.com', 'Distributor User', 'DIST_USER', saf.o(11), true),
  (saf.u(23), 'u23@dev.com', 'Root HQ User', 'HQ_USER', saf.o(1), true),
  (saf.u(24), 'u24@dev.com', 'Scoped HQ User', 'HQ_USER', saf.o(1), true);
insert into public.sa_organization_memberships(user_id, organization_id, membership_type, is_primary, status) values
  (saf.u(20), saf.o(1), 'employee', true, 'active'), (saf.u(21), saf.o(1), 'employee', true, 'active'),
  (saf.u(22), saf.o(11), 'partner', true, 'active'), (saf.u(23), saf.o(1), 'employee', true, 'active'),
  (saf.u(24), saf.o(1), 'employee', true, 'active');
insert into public.product_variants(id, product_id) values ('00000000-0000-0000-0009-000000000001', '00000000-0000-0000-0008-000000000001');
insert into public.sa_migration_modes(permission_key, mode) values ('supply_chain.order.create', 'LEGACY_RETIRED')
  on conflict (permission_key) do update set mode = excluded.mode;
insert into public.sa_migration_modes(permission_key, mode) values ('supply_chain.order.cancel', 'LEGACY_RETIRED'), ('supply_chain.order.approve', 'LEGACY_RETIRED')
  on conflict (permission_key) do update set mode = excluded.mode;

select public.sa_assign_role(saf.u(1), saf.u(20), saf.role('order-approver'), saf.o(1), array[saf.s(1)], now(), null, 'Approves HQ orders (fixture)');

-- Save an order through the REAL RPC as the current role; returns 'OK:<status>' or the error message.
create function saf.save(p_order uuid, p_seller uuid, p_status text default 'draft', p_mode text default 'create', p_expected timestamptz default null)
returns text language plpgsql as $$
declare v jsonb;
begin
  v := public.save_order_with_items(p_order, p_mode, p_status, p_expected, p_seller, 100, 0, 0, false, true, false, false, 'harness',
         '[{"product_id":"00000000-0000-0000-0008-000000000001","variant_id":"00000000-0000-0000-0009-000000000001","qty":10,"unit_price":"1.50"}]'::jsonb);
  return 'OK:' || (v->>'status');
exception when others then return sqlerrm;
end $$;
create function saf.oid(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0007-' || lpad(n::text, 12, '0'))::uuid $$;
create function saf.assignment(p_user uuid, p_role text) returns uuid language sql stable as $$
  select a.id from public.sa_role_assignments a where a.user_id = p_user and a.role_id = saf.role(p_role) $$;
grant usage on schema saf to public;
grant execute on all functions in schema saf to public;
