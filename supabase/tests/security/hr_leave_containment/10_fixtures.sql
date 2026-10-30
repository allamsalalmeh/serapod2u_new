-- HR leave containment (B2A, 20261219100000). Synthetic fixtures; DISPOSABLE replica only.
-- Loaded as the database owner with triggers off. No real person, email or phone is used.
--
-- Organizations: o1 HQ Alpha · o2 Distributor under HQ Alpha (same company hierarchy) · o3 HQ Beta (another company)
-- People (u):
--   1 E1  employee o1, manager M1          2 E2  employee o1, manager M2        3 E5  employee o2 (child org), manager M1
--   5 M1  manager with Manager Self-Service (explicit, non-legacy)              6 M2  manager WITHOUT Manager Self-Service
--   7 H1  HR with explicit Leave & Attendance Administrator (o1 scope)         8 L1  legacy-compatibility-only (legacy-hq), HQ_ADMIN role level 10
--   9 R1  Root Access                                                           10 X1 employee o3
--   11 HX HR explicit in o3 (other company)                                     12 M3 ARCHIVED manager with Manager Self-Service
--   13 E4 employee o1, manager M3 (archived)                                   14 S1 Super Admin with hr.data.reset (reset/restore rehearsal)
--   15 D1 manager with MSS only through a delegation (delegation deferred)     16 E6 employee o1, manager M1, onboarding NOT completed
set check_function_bodies = off;
create schema if not exists hlc;
create or replace function hlc.o(n int) returns uuid language sql immutable as $$ select ('0000001a-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function hlc.u(n int) returns uuid language sql immutable as $$ select ('0000001b-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function hlc.x(n int) returns uuid language sql immutable as $$ select ('0000001c-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function hlc.expect(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAILED: %', p_msg; end if;
  raise notice 'ok - %', p_msg;
end $$;
-- Run one statement as an authenticated API user (PostgREST shape: role authenticated + JWT sub).
-- Returns 'OK:<rows affected>' or the error text. The role switch and claims are undone afterwards.
create or replace function hlc.run_as(p_user int, p_sql text, p_role text default 'authenticated') returns text language plpgsql as $$
declare v_rows bigint;
begin
  perform set_config('request.jwt.claims',
    case when p_user is null then json_build_object('role', p_role)::text
         else json_build_object('sub', hlc.u(p_user), 'role', p_role)::text end, true);
  perform set_config('sa_cache.epoch', gen_random_uuid()::text, true);
  begin
    execute format('set local role %I', p_role);
    execute p_sql;
    get diagnostics v_rows = row_count;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    return 'OK:' || v_rows;
  exception when others then
    perform set_config('request.jwt.claims', '', true);
    return 'ERR:' || sqlerrm;
  end;
end $$;
-- Scalar query as an API user (e.g. a count); errors are returned as text.
create or replace function hlc.val_as(p_user int, p_sql text, p_role text default 'authenticated') returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims',
    case when p_user is null then json_build_object('role', p_role)::text
         else json_build_object('sub', hlc.u(p_user), 'role', p_role)::text end, true);
  perform set_config('sa_cache.epoch', gen_random_uuid()::text, true);
  begin
    execute format('set local role %I', p_role);
    execute p_sql into v;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    return v;
  exception when others then
    perform set_config('request.jwt.claims', '', true);
    return 'ERR:' || sqlerrm;
  end;
end $$;
create or replace function hlc.status(p_req int) returns text language sql stable as $$
  select status from public.hr_leave_requests where id = hlc.x(p_req) $$;
grant usage on schema hlc to anon, authenticated, service_role;
grant execute on all functions in schema hlc to anon, authenticated, service_role;

do $guard$
begin
  if exists (select 1 from public.users where id not between hlc.u(0) and hlc.u(999)) then
    raise exception 'refusing to run: this database contains real users (use a disposable replica)';
  end if;
  if current_database() not like '%test%' then
    raise exception 'refusing to run: database name must contain "test" (disposable replica only)';
  end if;
end $guard$;

set session_replication_role = replica;

insert into public.organization_types(type_code, type_name, hierarchy_level) values ('HQ', 'Headquarters', 1), ('DIST', 'Distributor', 2) on conflict do nothing;
insert into public.roles(role_code, role_name, role_level, is_active) values
 ('SA', 'Super Admin', 1, true), ('HQ_ADMIN', 'HQ Admin', 10, true), ('HR_MANAGER', 'HR Manager', 30, true), ('USER', 'User', 50, true)
on conflict do nothing;
insert into public.organizations(id, org_type_code, parent_org_id, org_code, org_name, is_active) values
 (hlc.o(1), 'HQ', null, 'HLC-A', 'HLC HQ Alpha', true),
 (hlc.o(2), 'DIST', hlc.o(1), 'HLC-A-D', 'HLC Distributor under Alpha', true),
 (hlc.o(3), 'HQ', null, 'HLC-B', 'HLC HQ Beta', true);
insert into public.hr_go_live_state(organization_id, phase, note) values (hlc.o(1), 'pre_go_live', 'test'), (hlc.o(3), 'pre_go_live', 'test');

insert into auth.users(id, email, aud, role)
select hlc.u(n), 'hlc-' || n || '@example.test', 'authenticated', 'authenticated' from generate_series(1, 16) n;
insert into public.users(id, email, full_name, role_code, organization_id, is_active, principal_type, account_status, account_scope, manager_user_id)
select hlc.u(n), 'hlc-' || n || '@example.test', label, role_code, hlc.o(org), n <> 12, 'INTERNAL_EMPLOYEE',
       case when n = 12 then 'ARCHIVED' else 'ACTIVE' end, 'portal', case when mgr is null then null else hlc.u(mgr) end
from (values
  (1, 1, 'USER', 'E1', 5), (2, 1, 'USER', 'E2', 6), (3, 2, 'USER', 'E5 child org', 5),
  (5, 1, 'USER', 'M1 manager (MSS)', 7), (6, 1, 'USER', 'M2 manager (no MSS)', 7), (7, 1, 'HR_MANAGER', 'H1 HR explicit', null),
  (8, 1, 'HQ_ADMIN', 'L1 legacy-compat only', null), (9, 1, 'USER', 'R1 root', null), (10, 3, 'USER', 'X1 other company', 11),
  (11, 3, 'HR_MANAGER', 'HX HR other company', null), (12, 1, 'USER', 'M3 archived manager', 7), (13, 1, 'USER', 'E4', 12),
  (14, 1, 'SA', 'S1 super admin', null), (15, 1, 'USER', 'D1 delegate', 7), (16, 1, 'USER', 'E6 not onboarded', 5)
) t(n, org, role_code, label, mgr);

insert into public.hr_employees(id, employee_no, user_id, organization_id, hire_date, status, manager_user_id, employment_type,
                                onboarding_status, onboarding_source, onboarded_at, hire_date_confirmed)
select hlc.x(100 + n), 910000 + n, hlc.u(n), u.organization_id, date '2026-01-05',
       case when n = 12 then 'terminated' else 'active' end, u.manager_user_id, 'Full-time',
       case when n = 16 then 'pending' else 'completed' end, case when n = 16 then null else 'hr_onboarding' end,
       case when n = 16 then null else now() - interval '30 days' end, n <> 16
from generate_series(1, 16) n join public.users u on u.id = hlc.u(n) where n <> 4;

-- S&A catalogue rows used by the tests (synthetic copies of the production keys/policies).
insert into public.sa_permissions(id, permission_key, module, resource, action, status) values
 (hlc.x(500), 'hr.leave.approve', 'hr', 'leave', 'approve', 'active'),
 (hlc.x(501), 'hr.mss.leave_approve', 'hr', 'mss', 'leave_approve', 'active'),
 (hlc.x(502), 'hr.mss.leave_view', 'hr', 'mss', 'leave_view', 'active'),
 (hlc.x(503), 'hr.data.reset', 'hr', 'data', 'reset', 'active')
on conflict (permission_key) do nothing;
insert into public.sa_business_roles(id, role_key, name, source, status) values
 (hlc.x(510), 'hr-leave-attendance-administrator', 'Leave & Attendance Administrator', 'template', 'active'),
 (hlc.x(511), 'manager-self-service', 'Manager Self-Service', 'template', 'active'),
 (hlc.x(512), 'legacy-hq', 'Legacy HQ compatibility', 'legacy', 'active'),
 (hlc.x(513), 'hr-data-reset-administrator', 'HR Data Reset Administrator', 'template', 'active')
on conflict (role_key) do nothing;
insert into public.sa_business_role_permissions(role_id, permission_id)
select r.id, p.id from (values
  ('hr-leave-attendance-administrator', 'hr.leave.approve'),
  ('manager-self-service', 'hr.mss.leave_approve'), ('manager-self-service', 'hr.mss.leave_view'),
  ('legacy-hq', 'hr.leave.approve'), ('legacy-hq', 'hr.mss.leave_approve'), ('legacy-hq', 'hr.mss.leave_view'),
  ('hr-data-reset-administrator', 'hr.data.reset')) v(rk, pk)
join public.sa_business_roles r on r.role_key = v.rk join public.sa_permissions p on p.permission_key = v.pk
on conflict do nothing;
-- Production last recorded HR keys as SHADOW: the legacy RLS branch decides in the unpatched schema.
insert into public.sa_migration_modes(permission_key, mode) values ('hr.leave.approve', 'SHADOW')
on conflict (permission_key) do update set mode = excluded.mode;

insert into public.sa_organization_memberships(id, user_id, organization_id, membership_type, is_primary, status, source)
select hlc.x(200 + n), hlc.u(n), u.organization_id, 'employee', true, 'active', 'manual'
from generate_series(1, 16) n join public.users u on u.id = hlc.u(n);
insert into public.sa_scope_definitions(id, organization_id, scope_type, scope_value, display_name, status) values
 (hlc.x(301), hlc.o(1), 'organization', hlc.o(1)::text, 'HLC Alpha (incl. children)', 'active'),
 (hlc.x(303), hlc.o(3), 'organization', hlc.o(3)::text, 'HLC Beta', 'active');
insert into public.sa_role_assignments(id, user_id, role_id, membership_id, status, source, assignment_reason)
select hlc.x(600 + n), hlc.u(n), (select id from public.sa_business_roles where role_key = rk), hlc.x(200 + n), 'active', 'manual', 'hlc test'
from (values (5, 'manager-self-service'), (7, 'hr-leave-attendance-administrator'), (8, 'legacy-hq'),
             (11, 'hr-leave-attendance-administrator'), (12, 'manager-self-service'), (14, 'hr-data-reset-administrator')) t(n, rk);
insert into public.sa_assignment_scopes(assignment_id, scope_id)
select hlc.x(600 + n), hlc.x(case when n = 11 then 303 else 301 end) from unnest(array[5, 7, 8, 11, 12, 14]) n;
insert into public.sa_root_access_grants(user_id, status, grant_method, reason) values (hlc.u(9), 'active', 'grant', 'hlc replica test root grant');
-- D1 receives Manager Self-Service only by delegation from M1 (must NOT count: delegation deferred to B6).
insert into public.sa_delegations(delegator_id, delegate_id, organization_id, permission_keys, status, effective_from, effective_until, reason, created_by)
values (hlc.u(5), hlc.u(15), hlc.o(1), array['hr.mss.leave_approve', 'hr.mss.leave_view'], 'active', now() - interval '1 day', now() + interval '30 days', 'hlc test', hlc.u(5));

insert into public.hr_leave_types(id, organization_id, code, name, status) values
 (hlc.x(401), hlc.o(1), 'AL', 'Annual', 'active'), (hlc.x(402), hlc.o(2), 'AL', 'Annual', 'active'),
 (hlc.x(403), hlc.o(3), 'AL', 'Annual', 'active'), (hlc.x(404), hlc.o(1), 'OLD', 'Retired type', 'inactive');

-- Leave requests (x(1..) ids are request numbers used by the tests)
insert into public.hr_leave_requests(id, organization_id, employee_id, leave_type_id, start_date, end_date, total_days, reason, status, approved_by, approved_at)
values
 (hlc.x(1),  hlc.o(1), hlc.u(1),  hlc.x(401), date '2026-11-02', date '2026-11-02', 1, 'R1 pending E1', 'pending', null, null),
 (hlc.x(2),  hlc.o(1), hlc.u(2),  hlc.x(401), date '2026-11-03', date '2026-11-03', 1, 'R2 pending E2 (medical, confidential)', 'pending', null, null),
 (hlc.x(3),  hlc.o(1), hlc.u(1),  hlc.x(401), date '2026-10-01', date '2026-10-01', 1, 'R3 approved by M1', 'approved', hlc.u(5), now() - interval '20 days'),
 (hlc.x(4),  hlc.o(1), hlc.u(2),  hlc.x(401), date '2026-10-05', date '2026-10-05', 1, 'R4 historical self-approved', 'approved', hlc.u(2), now() - interval '19 days'),
 (hlc.x(5),  hlc.o(2), hlc.u(3),  hlc.x(402), date '2026-11-04', date '2026-11-04', 1, 'R5 pending E5 child org', 'pending', null, null),
 (hlc.x(6),  hlc.o(3), hlc.u(10), hlc.x(403), date '2026-11-05', date '2026-11-05', 1, 'R6 pending X1 other company', 'pending', null, null),
 (hlc.x(7),  hlc.o(1), hlc.u(7),  hlc.x(401), date '2026-11-06', date '2026-11-06', 1, 'R7 pending H1 own', 'pending', null, null),
 (hlc.x(8),  hlc.o(1), hlc.u(13), hlc.x(401), date '2026-11-07', date '2026-11-07', 1, 'R8 pending E4 (archived manager)', 'pending', null, null),
 (hlc.x(9),  hlc.o(1), hlc.u(5),  hlc.x(401), date '2026-11-08', date '2026-11-08', 1, 'R9 pending M1 own', 'pending', null, null),
 (hlc.x(10), hlc.o(1), hlc.u(2),  hlc.x(401), date '2026-09-01', date '2026-09-01', 1, 'R10 legacy status value', 'Approved', null, null),
 (hlc.x(11), hlc.o(1), hlc.u(1),  hlc.x(401), date '2026-11-09', date '2026-11-09', 1, 'R11 pending E1 (cancel test)', 'pending', null, null),
 (hlc.x(12), hlc.o(1), hlc.u(2),  hlc.x(401), date '2026-08-03', date '2026-08-03', 1, 'R12 approved, no approver recorded', 'approved', null, null);

insert into public.hr_leave_balances(id, organization_id, employee_id, leave_type_id, year, entitled)
select hlc.x(700 + n), u.organization_id, hlc.u(n), case u.organization_id when hlc.o(1) then hlc.x(401) when hlc.o(2) then hlc.x(402) else hlc.x(403) end, 2026, 14
from unnest(array[1, 2, 3, 5, 7, 10]) n join public.users u on u.id = hlc.u(n);
insert into public.hr_leave_approvals(id, organization_id, request_id, approver_id, action, actioned_at)
values (hlc.x(800), hlc.o(1), hlc.x(3), hlc.u(5), 'approved', now() - interval '20 days');

set session_replication_role = origin;
select hlc.expect(true, 'fixtures loaded');
