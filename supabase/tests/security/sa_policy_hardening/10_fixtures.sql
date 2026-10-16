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
 (pht.o(1), 'HQ', null,     'P-HQ',  'Test HQ',          true),
 (pht.o(2), 'WH', pht.o(1), 'P-WH1', 'Test Warehouse 1', true);

insert into auth.users(id, email, aud, role)
select pht.u(n), 'ph-test-' || n || '@example.test', 'authenticated', 'authenticated' from generate_series(1, 10) n;
insert into public.users(id, email, full_name, role_code, organization_id, is_active, principal_type, account_status, account_scope)
select pht.u(n), 'ph-test-' || n || '@example.test', label, 'USER', pht.o(org), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal'
from (values
  (1, 1, 'Finance Full Access holder (time-boxed)'),
  (2, 1, 'Platform & Settings Full Access holder'),
  (3, 1, 'HR & Payroll Full Access holder'),
  (4, 1, 'Revoked Platform Full Access'),
  (5, 1, 'Expired Finance Full Access'),
  (6, 1, 'Payroll officer + approver'),
  (7, 1, 'Payment requester + approver'),
  (8, 2, 'Warehouse staff'),
  (9, 1, 'HQ employee granted after the migration'),
  (10, 1, 'Finance Full Access holder who also has Finance Viewer')
) t(n, org, label);

insert into public.sa_organization_memberships(id, user_id, organization_id, membership_type, is_primary, status, source)
select pht.u(100 + n), pht.u(n), u.organization_id, 'employee', true, 'active', 'manual'
from generate_series(1, 10) n join public.users u on u.id = pht.u(n);

insert into public.sa_scope_definitions(id, organization_id, scope_type, scope_value, display_name, status)
select pht.o(100 + n), pht.o(n), 'organization', pht.o(n)::text, 'Test scope ' || n, 'active' from generate_series(1, 2) n;

-- (user, role_key, scope org, status, effective_until)
do $assign$
declare r record; v_id uuid;
begin
  for r in select * from (values
    (1, 'finance-full-access', 1, 'active', now() + interval '30 days'),
    (2, 'platform-settings-full-access', 1, 'active', null),
    (3, 'hr-payroll-full-access', 1, 'active', null),
    (4, 'platform-settings-full-access', 1, 'revoked', null),
    (5, 'finance-full-access', 1, 'active', now() - interval '1 day'),
    (6, 'payroll-officer', 1, 'active', null), (6, 'payroll-approver', 1, 'active', null),
    (7, 'payment-approver', 1, 'active', null),
    (10, 'finance-full-access', 1, 'active', null), (10, 'finance-viewer', 1, 'active', null)) t(n, role_key, scope_org, status, until)
  loop
    insert into public.sa_role_assignments(user_id, role_id, membership_id, status, source, assignment_reason, effective_from, effective_until)
    values (pht.u(r.n), (select id from public.sa_business_roles where role_key = r.role_key), pht.u(100 + r.n), r.status, 'manual', 'ph test',
            case when r.until is not null then now() - interval '10 days' end, r.until)
    returning id into v_id;
    insert into public.sa_assignment_scopes(assignment_id, scope_id) values (v_id, pht.o(100 + r.scope_org));
  end loop;
end $assign$;

set session_replication_role = origin;
select pht.expect(true, 'fixtures loaded');
