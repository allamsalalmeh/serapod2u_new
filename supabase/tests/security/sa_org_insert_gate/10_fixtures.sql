-- Synthetic organizations, users and S&A assignments. No real data. Loaded as the owner with triggers off.
do $guard$
begin
  if exists (select 1 from public.users where id not between smt.u(0) and smt.u(999)) then
    raise exception 'refusing to run: this database contains real users (use a disposable replica)';
  end if;
end $guard$;

set session_replication_role = replica;

-- Organization types as on staging (2026-10-22, read-only); the schema-only replica has no rows.
insert into public.organization_types(type_code, type_name, hierarchy_level, is_active) values
 ('HQ', 'Headquarters', 1, true), ('MFG', 'Manufacturer', 2, true), ('DIST', 'Distributor', 3, true),
 ('WH', 'Warehouse', 4, true), ('SHOP', 'Shop', 5, true), ('INDEP', 'Independent', 50, true), ('END_USER', 'End User', 99, true)
on conflict do nothing;

-- Company A: HQ(1) → WH1(2), DIST1(4) → SHOP1(6), MFG1(7). Unrelated company X: XHQ(8) → XDIST(9).
-- Standalone manufacturer SMFG(10), no parent.
insert into public.organizations(id, org_type_code, parent_org_id, org_code, org_name, is_active) values
 (smt.o(1),  'HQ',   null,     'T-HQ',    'Test HQ',                 true),
 (smt.o(2),  'WH',   smt.o(1), 'T-WH1',   'Test Warehouse 1',        true),
 (smt.o(4),  'DIST', smt.o(1), 'T-DIST1', 'Test Distributor 1',      true),
 (smt.o(6),  'SHOP', smt.o(4), 'T-SHOP1', 'Test Shop 1',             true),
 (smt.o(7),  'MFG',  smt.o(1), 'T-MFG1',  'Test Manufacturer',       true),
 (smt.o(8),  'HQ',   null,     'X-HQ',    'Unrelated HQ',            true),
 (smt.o(9),  'DIST', smt.o(8), 'X-DIST',  'Unrelated Distributor',   true),
 (smt.o(10), 'MFG',  null,     'S-MFG',   'Standalone Manufacturer', true);

insert into auth.users(id, email, aud, role)
select smt.u(n), 'og-test-' || n || '@example.test', 'authenticated', 'authenticated' from generate_series(1, 8) n;
insert into public.users(id, email, full_name, role_code, organization_id, is_active, principal_type, account_status, account_scope)
select smt.u(n), 'og-test-' || n || '@example.test', label, role_code, smt.o(org), active, principal, case when active then 'ACTIVE' else 'SUSPENDED' end, 'portal'
from (values
  (1, 1,  'USER', true,  'INTERNAL_EMPLOYEE',   'HQ user, Platform Settings Full Access at HQ'),
  (2, 4,  'DIST', true,  'DISTRIBUTOR_USER',    'Distributor 1 user, Platform Settings Full Access at DIST1'),
  (3, 1,  'USER', true,  'INTERNAL_EMPLOYEE',   'HQ employee, self-service only'),
  (4, 8,  'USER', true,  'INTERNAL_EMPLOYEE',   'Unrelated company user, Full Access at XHQ'),
  (5, 1,  'USER', true,  'INTERNAL_EMPLOYEE',   'Root Access holder'),
  (6, 10, 'USER', true,  'MANUFACTURER_USER',   'Standalone manufacturer user, Full Access at SMFG'),
  (7, 1,  'USER', false, 'INTERNAL_EMPLOYEE',   'Inactive HQ user, Full Access at HQ'),
  (8, 1,  'HQ',   true,  'INTERNAL_EMPLOYEE',   'Legacy HQ admin (level 10), self-service only in S&A')
) t(n, org, role_code, active, principal, label);

insert into public.sa_organization_memberships(id, user_id, organization_id, membership_type, is_primary, status, source)
select smt.u(100 + n), smt.u(n), u.organization_id, 'employee', true, 'active', 'manual'
from generate_series(1, 8) n join public.users u on u.id = smt.u(n);

insert into public.sa_scope_definitions(id, organization_id, scope_type, scope_value, display_name, status)
select smt.o(100 + n), smt.o(n), 'organization', smt.o(n)::text, 'Test scope ' || n, 'active'
from unnest(array[1, 2, 4, 6, 7, 8, 9, 10]) n;

do $assign$
declare r record; v_id uuid;
begin
  for r in select * from (values
    (1, 'platform-settings-full-access', 1),
    (2, 'platform-settings-full-access', 4),
    (3, 'employee-self-service', 1),
    (4, 'platform-settings-full-access', 8),
    (5, 'employee-self-service', 1),
    (6, 'platform-settings-full-access', 10),
    (7, 'platform-settings-full-access', 1),
    (8, 'employee-self-service', 1)) t(n, role_key, scope_org)
  loop
    insert into public.sa_role_assignments(user_id, role_id, membership_id, status, source, assignment_reason)
    values (smt.u(r.n), (select id from public.sa_business_roles where role_key = r.role_key), smt.u(100 + r.n), 'active', 'manual', 'og test')
    returning id into v_id;
    insert into public.sa_assignment_scopes(assignment_id, scope_id) values (v_id, smt.o(100 + r.scope_org));
  end loop;
end $assign$;

insert into public.sa_root_access_grants(user_id, status, grant_method, reason, granted_at)
values (smt.u(5), 'active', 'bootstrap', 'organization insert gate test fixture', now());

-- Registry row as on staging (2026-10-22, read-only): organization_expression 'id'.
insert into public.sa_policy_rewrites(table_name, policy_name, permission_key, organization_expression)
values ('organizations', 'orgs_insert_admin', 'platform.organization.manage', 'id')
on conflict (table_name, policy_name) do update set organization_expression = excluded.organization_expression;

set session_replication_role = origin;

-- Insert an organization as the current request user; NULL on success, else SQLSTATE + message.
create or replace function smt.add_org(p_code text, p_type text, p_parent int) returns text language sql as $$
  select smt.try(format(
    'insert into public.organizations(org_type_code, org_code, org_name, parent_org_id, country_code, is_active) values (%L, %L, %L, %L, ''MY'', true)',
    p_type, p_code, 'Gate test ' || p_code, case when p_parent is null then null else smt.o(p_parent) end));
$$;
grant execute on function smt.add_org(text, text, int) to authenticated;
