-- Synthetic organizations, users and S&A assignments. No real data.
-- Loaded as the database owner with triggers off (fixtures only; the tests run with triggers on).
do $guard$
begin
  if exists (select 1 from public.users where id not between pht.u(0) and pht.u(999)) then
    raise exception 'refusing to run: this database contains real users (use a disposable replica)';
  end if;
end $guard$;

set session_replication_role = replica;

insert into public.organizations(id, org_type_code, parent_org_id, org_code, org_name, is_active) values
 (pht.o(1), 'HQ',   null,     'LC-HQ',  'Test HQ',            true),
 (pht.o(2), 'WH',   pht.o(1), 'LC-WH1', 'Test Warehouse 1',   true),
 (pht.o(3), 'DIST', null,     'LC-D3',  'Other tenant (DIST)', true);

insert into auth.users(id, email, aud, role)
select pht.u(n), 'lc-test-' || n || '@example.test', 'authenticated', 'authenticated' from generate_series(1, 9) n;
insert into public.users(id, email, full_name, role_code, organization_id, is_active, principal_type, account_status, account_scope)
select pht.u(n), 'lc-test-' || n || '@example.test', label, rc, pht.o(org), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal'
from (values
  (1, 1, 'USER', 'Alif-like: Legacy USER + C&G Full Access + Reporting Viewer'),
  (2, 1, 'USER', 'Ordinary user: Legacy USER only'),
  (3, 1, 'SA',   'Root Administrator + Legacy SA'),
  (4, 1, 'SA',   'Legacy SA without Root'),
  (5, 1, 'USER', 'C&G Full Access only'),
  (6, 1, 'USER', 'Expired explicit grant + Legacy USER'),
  (7, 1, 'USER', 'C&G Full Access on an inactive scope'),
  (8, 2, 'USER', 'Warehouse: Legacy USER on warehouse scope'),
  (9, 1, 'USER', 'Two memberships: HQ Reporting Viewer, warehouse nothing')
) t(n, org, rc, label);

insert into public.sa_organization_memberships(id, user_id, organization_id, membership_type, is_primary, status, source)
select pht.u(100 + n), pht.u(n), u.organization_id, 'employee', true, 'active', 'derived'
from generate_series(1, 9) n join public.users u on u.id = pht.u(n);
insert into public.sa_organization_memberships(id, user_id, organization_id, membership_type, is_primary, status, source)
values (pht.u(209), pht.u(9), pht.o(2), 'employee', false, 'active', 'manual');

insert into public.sa_scope_definitions(id, organization_id, scope_type, scope_value, display_name, status) values
 (pht.o(101), pht.o(1), 'organization', pht.o(1)::text, 'LC scope HQ', 'active'),
 (pht.o(102), pht.o(2), 'warehouse',    pht.o(2)::text, 'LC scope WH', 'active'),
 (pht.o(103), pht.o(2), 'organization', pht.o(2)::text, 'LC scope WH org (deprecated)', 'deprecated');

-- (user, membership, role_key, scope, status, source, effective_until)
do $assign$
declare r record; v_id uuid;
begin
  for r in select * from (values
    (1, 101, 'legacy-user', 101, 'active', 'backfill', null::timestamptz),
    (1, 101, 'customer-growth-full-access', 101, 'active', 'manual', null),
    (1, 101, 'reporting-viewer', 101, 'active', 'manual', null),
    (2, 102, 'legacy-user', 101, 'active', 'backfill', null),
    (3, 103, 'legacy-sa', 101, 'active', 'backfill', null),
    (4, 104, 'legacy-sa', 101, 'active', 'backfill', null),
    (5, 105, 'customer-growth-full-access', 101, 'active', 'manual', null),
    (6, 106, 'legacy-user', 101, 'active', 'backfill', null),
    (6, 106, 'finance-viewer', 101, 'active', 'manual', now() - interval '1 day'),
    (7, 107, 'customer-growth-full-access', 103, 'active', 'manual', null),
    (8, 108, 'legacy-user', 102, 'active', 'backfill', null),
    (9, 109, 'reporting-viewer', 101, 'active', 'manual', null)) t(n, m, role_key, scope, status, source, until)
  loop
    insert into public.sa_role_assignments(user_id, role_id, membership_id, status, source, assignment_reason, effective_from, effective_until)
    values (pht.u(r.n), (select id from public.sa_business_roles where role_key = r.role_key), pht.u(r.m), r.status, r.source, 'lc test',
            case when r.until is not null then now() - interval '10 days' end, r.until)
    returning id into v_id;
    insert into public.sa_assignment_scopes(assignment_id, scope_id) values (v_id, pht.o(r.scope));
  end loop;
end $assign$;

insert into public.sa_root_access_grants(id, user_id, status, grant_method, reason)
values (pht.o(900), pht.u(3), 'active', 'bootstrap', 'lc test root administrator');

set session_replication_role = origin;
select pht.expect((select count(*) from public.sa_role_assignments where assignment_reason = 'lc test') = 12, 'fixtures loaded');
