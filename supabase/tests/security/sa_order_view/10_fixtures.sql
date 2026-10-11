-- Isolated View Orders fixtures (never real data). Builds on the sa_group_policies / sa_root_access fixtures:
--   o1 HQ, o2 Balakong WH and o3 Alma WH under HQ, o4 manufacturer, o5 North Distributor (own tree). u1 legacy Super
--   Admin with S&A authority.
-- New: o11 South Distributor under HQ.
--   u40 HQ level 50, Order Approver only (the orderapp@dev.com situation) | u41 HQ level 50, no order policy
--   u42 HQ level 50, Order Creator | u43 distributor (o11) level 50, Order Creator
--   u44 HQ level 50, a CUSTOM policy holding only order approval | u45 HQ level 40 with its compatibility role only
--   u46 HQ level 50, Order Approver + Warehouse Operator (revocation keeps the independent grant)
do $g$ begin if current_database() !~ '^sa_prof_test' then raise exception 'Refusing: not a disposable sa_prof_test* database'; end if; end $g$;
insert into public.roles(role_code, role_name, role_level) values ('GUEST', 'Guest', 50), ('DIST_USER', 'Distributor User', 50),
  ('HQ_STAFF', 'HQ Staff', 40)
  on conflict (role_code) do nothing;
insert into public.organizations(id, org_name, org_type_code, parent_org_id) values (saf.o(11), 'South Distributor', 'DIST', saf.o(1));
insert into public.sa_scope_definitions(id, organization_id, scope_type, scope_value, display_name) values
  (saf.s(11), saf.o(11), 'organization', saf.o(11)::text, 'South Distributor');
insert into auth.users(id, email) select saf.u(n), 'u' || n || '@dev.com' from generate_series(40, 46) n;
insert into public.users(id, email, full_name, role_code, organization_id, is_active) values
  (saf.u(40), 'u40@dev.com', 'Order Approver Only', 'GUEST', saf.o(1), true),
  (saf.u(41), 'u41@dev.com', 'No Order Policy', 'GUEST', saf.o(1), true),
  (saf.u(42), 'u42@dev.com', 'Order Creator HQ', 'GUEST', saf.o(1), true),
  (saf.u(43), 'u43@dev.com', 'Order Creator Distributor', 'DIST_USER', saf.o(11), true),
  (saf.u(44), 'u44@dev.com', 'Custom Approve Only', 'GUEST', saf.o(1), true),
  (saf.u(45), 'u45@dev.com', 'Legacy Level 40', 'HQ_STAFF', saf.o(1), true),
  (saf.u(46), 'u46@dev.com', 'Approver And Operator', 'GUEST', saf.o(1), true);
insert into public.sa_organization_memberships(user_id, organization_id, membership_type, is_primary, status)
select saf.u(n), saf.o(1), 'employee', true, 'active' from unnest(array[40, 41, 42, 44, 45, 46]) n;
insert into public.sa_organization_memberships(user_id, organization_id, membership_type, is_primary, status) values
  (saf.u(43), saf.o(11), 'partner', true, 'active');

-- Order approval/creation are S&A-authoritative (staging), so the migration seeds supply_chain.order.view NEW_ENFORCED.
insert into public.sa_migration_modes(permission_key, mode)
select k, 'LEGACY_RETIRED' from unnest(array['supply_chain.order.create', 'supply_chain.order.approve', 'supply_chain.order.cancel']) k
on conflict (permission_key) do update set mode = excluded.mode;

-- Compatibility roles as the lifecycle generates them (GUEST included to prove it is never selected).
select public.sa_refresh_compat_role(rc, true) from unnest(array['SA', 'HQ_MGR', 'WH_MGR', 'MFG_USER', 'HQ_STAFF', 'GUEST', 'DIST_USER']) rc;

-- A custom policy holding only order approval (must NOT be broadened by the migration).
insert into public.sa_business_roles(id, role_key, name, description, source, status, applicable_org_types)
values ('00000000-0000-0000-0005-000000000044', 'custom-approve-only', 'Custom Approve Only', 'Custom fixture', 'new', 'active', array['HQ']);
insert into public.sa_business_role_permissions(role_id, permission_id)
select '00000000-0000-0000-0005-000000000044', p.id from public.sa_permissions p where p.permission_key = 'supply_chain.order.approve';

-- Grants that do not depend on the new migration.
select public.sa_assign_role(saf.u(1), saf.u(40), saf.role('order-approver'), saf.o(1), array[saf.s(1)], now(), null, 'Approves HQ orders (fixture)');
select public.sa_assign_role(saf.u(1), saf.u(42), saf.role('order-creator'), saf.o(1), array[saf.s(1)], now(), null, 'Creates HQ orders (fixture)');
select public.sa_assign_role(saf.u(1), saf.u(43), saf.role('order-creator'), saf.o(11), array[saf.s(11)], now(), null, 'Creates distributor orders (fixture)');
select public.sa_assign_role(saf.u(1), saf.u(44), saf.role('custom-approve-only'), saf.o(1), array[saf.s(1)], now(), null, 'Custom approval only (fixture)');
select public.sa_assign_role(saf.u(1), saf.u(46), saf.role('order-approver'), saf.o(1), array[saf.s(1)], now(), null, 'Approves HQ orders (fixture)');
select public.sa_assign_role(saf.u(1), saf.u(46), saf.role('warehouse-operator'), saf.o(1), array[saf.s(1)], now(), null, 'Warehouse operations (fixture)');
select public.sa_create_assignment_internal(saf.u(1), saf.u(45), saf.role('legacy-hq-staff'), saf.o(1), array[saf.s(1)], now(), null,
  'Lifecycle compatibility backfill (fixture)', 'backfill');

create function saf.assignment(p_user uuid, p_role text) returns uuid language sql stable as $$
  select a.id from public.sa_role_assignments a where a.user_id = p_user and a.role_id = saf.role(p_role) and a.status = 'active' $$;
create function saf.d(p_user int, p_key text, p_org int) returns text language sql as $$
  select public.sa_evaluate_permission(saf.u(p_user), p_key, jsonb_build_object('organization_id', saf.o(p_org)))->>'decision' $$;
grant usage on schema saf to public;
grant execute on all functions in schema saf to public;
