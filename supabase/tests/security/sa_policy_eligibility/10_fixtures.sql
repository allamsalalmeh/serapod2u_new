-- Isolated Group Policy eligibility fixtures (never real data). Builds on the sa_order_creator fixtures:
--   o1 HQ, o2/o3 warehouses (WH) under HQ, o4 manufacturer, o5 distributor, o6 shop, o11 distributor under HQ
--   u1 legacy Super Admin (S&A authority everywhere) | u2 delegated HQ S&A administrator | u3 plain HQ member
--   u4 Balakong (WH) employee | u6 HQ employee | u8 manufacturer user (o4) | u12 shop staff (o6) | u22 distributor user (o11)
--   u23 HQ user (Root Administrator below)
-- New here: o30 End User organization (consumers) | o31 Independent organization | u30 consumer | u31 independent user
--           u32 HQ employee (concurrency / re-grant) | u33 second shop staff (o6)
do $g$ begin if current_database() !~ '^sa_prof_test' then raise exception 'Refusing: not a disposable sa_prof_test* database'; end if; end $g$;

insert into public.organizations(id, org_name, org_type_code, parent_org_id) values
  (saf.o(30), 'End User', 'END_USER', saf.o(1)), (saf.o(31), 'Independent Portal', 'INDEP', null);
insert into public.sa_scope_definitions(id, organization_id, scope_type, scope_value, display_name) values
  (saf.s(30), saf.o(30), 'organization', saf.o(30)::text, 'End User'), (saf.s(31), saf.o(31), 'organization', saf.o(31)::text, 'Independent Portal');
insert into auth.users(id, email) select saf.u(n), 'u' || n || '@dev.com' from generate_series(30, 33) n;
insert into public.users(id, email, full_name, role_code, organization_id, is_active) values
  (saf.u(30), 'u30@dev.com', 'Consumer', 'HQ_USER', saf.o(30), true),
  (saf.u(31), 'u31@dev.com', 'Independent', 'HQ_USER', saf.o(31), true),
  (saf.u(32), 'u32@dev.com', 'HQ Employee Two', 'HQ_USER', saf.o(1), true),
  (saf.u(33), 'u33@dev.com', 'Shop Staff Two', 'MFG_USER', saf.o(6), true);
insert into public.sa_organization_memberships(user_id, organization_id, membership_type, is_primary, status) values
  (saf.u(30), saf.o(30), 'partner', true, 'active'), (saf.u(31), saf.o(31), 'partner', true, 'active'),
  (saf.u(32), saf.o(1), 'employee', true, 'active'), (saf.u(33), saf.o(6), 'partner', true, 'active');

-- Policies as they exist BEFORE the eligibility migration.
insert into public.sa_business_roles(id, role_key, name, source, status, applicable_account_types, applicable_org_types) values
  ('00000000-0000-0000-0015-000000000030', 'saf-mfg-ops',        'Manufacturer Operations (standard)', 'template', 'active', array['partner'], array['MFG']),
  ('00000000-0000-0000-0015-000000000031', 'saf-custom-any',     'Custom without eligibility',         'new',      'active', '{}', '{}'),
  ('00000000-0000-0000-0015-000000000032', 'saf-custom-partner', 'Custom shop ordering',               'new',      'active', '{}', array['DIST','SHOP']),
  ('00000000-0000-0000-0015-000000000033', 'saf-custom-hq',      'Custom HQ stock counter',            'new',      'active', '{}', array['HQ']);
insert into public.sa_business_role_permissions(role_id, permission_id)
  select '00000000-0000-0000-0015-000000000030', id from public.sa_permissions where permission_key = 'manufacturing.production.manage';
insert into public.sa_business_role_permissions(role_id, permission_id)
  select '00000000-0000-0000-0015-000000000031', id from public.sa_permissions where permission_key = 'inventory.stock_count.view';
insert into public.sa_business_role_permissions(role_id, permission_id)
  select '00000000-0000-0000-0015-000000000032', id from public.sa_permissions where permission_key = 'supply_chain.order.create';
insert into public.sa_business_role_permissions(role_id, permission_id)
  select '00000000-0000-0000-0015-000000000033', id from public.sa_permissions where permission_key = 'inventory.stock_count.view';

-- u23 is the Root Administrator (owner bootstrap, as in production); partner organizations outside the HQ tree are administered by Root.
select public.sa_bootstrap_root_access(saf.u(23), 'Root Administrator for the eligibility suite');

-- An existing (pre-migration) custom-policy grant to a shop that the policy will later be narrowed away from.
select public.sa_assign_role(saf.u(23), saf.u(33), saf.role('saf-custom-partner'), saf.o(6), array[saf.s(7)], now(), null, 'Existing shop ordering grant (fixture)');

-- An existing grant that the migration makes incompatible (HQ policy held by a Shop member): must stay, and be reported.
select public.sa_assign_role(saf.u(23), saf.u(12), saf.role('order-approver'), saf.o(6), array[saf.s(7)], now(), null, 'Legacy-era shop approval grant (fixture)');


create function saf.grant_ok(actor int, target int, role_key text, org int, scope int) returns text language sql as $$
  select saf.try(format($q$select public.sa_assign_role(%L, %L, %L, %L, array[%L]::uuid[], now(), null, null)$q$,
    saf.u(actor), saf.u(target), saf.role(role_key), saf.o(org), saf.s(scope))) $$;
create function saf.request(target int, role_key text, org int, scope int) returns uuid language sql as $$
  select public.sa_submit_access_request(saf.u(target), saf.u(target), saf.role(role_key), saf.o(org), array[saf.s(scope)], null, null, 'Need it for daily work (fixture)') $$;
create function saf.approve(actor int, request uuid) returns text language sql as $$
  select saf.try(format($q$select public.sa_decide_access_request(%L, %L, true, 'approved (fixture)')$q$, saf.u(actor), request)) $$;
create function saf.active(target int, role_key text) returns bigint language sql stable as $$
  select count(*) from public.sa_role_assignments where user_id = saf.u(target) and role_id = saf.role(role_key) and status = 'active' $$;
grant execute on all functions in schema saf to public;

create table saf.assignments_before as select id, user_id, role_id, membership_id, status, source, effective_from, effective_until, assignment_reason
  from public.sa_role_assignments;
create table saf.elig_modes_before as select permission_key, mode from public.sa_migration_modes;
create table saf.root_before as select * from public.sa_root_access_grants;
