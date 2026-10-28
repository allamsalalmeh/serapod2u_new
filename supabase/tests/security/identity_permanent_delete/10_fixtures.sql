-- Permanent identity deletion (20261216100000). Synthetic fixtures; DISPOSABLE replica only.
-- Loaded as the database owner with triggers off; every test runs with triggers on.
set check_function_bodies = off;
create schema if not exists ipd;
create or replace function ipd.o(n int) returns uuid language sql immutable as $$ select ('0000001c-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function ipd.u(n int) returns uuid language sql immutable as $$ select ('0000001d-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function ipd.x(n int) returns uuid language sql immutable as $$ select ('0000001e-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function ipd.expect(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAILED: %', p_msg; end if;
  raise notice 'ok - %', p_msg;
end $$;
create or replace function ipd.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ' ' || sqlerrm; end $$;
create or replace function ipd.preview(a int, t int, entry text default 'user_management') returns jsonb language sql as $$
  select public.identity_deletion_preview(ipd.u(a), ipd.u(t), entry) $$;
create or replace function ipd.exec(a int, t int, req int, entry text default 'user_management', token text default null,
                                    reason text default 'Pre-go-live test account clean-up', confirmation text default null) returns jsonb language sql as $$
  select public.identity_deletion_execute(ipd.u(a), ipd.u(t), entry, ipd.x(9000 + req),
    coalesce(token, public.identity_deletion_preview(ipd.u(a), ipd.u(t), entry)->>'preview_token'), reason,
    coalesce(confirmation, 'ipd-' || t || '@example.test')) $$;
create or replace function ipd.codes(p jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(distinct b->>'code' order by b->>'code'), '{}') from jsonb_array_elements(p->'blockers') b $$;
create or replace function ipd.categories(p jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(distinct b->>'category' order by b->>'category') filter (where b ? 'category'), '{}') from jsonb_array_elements(p->'blockers') b $$;
-- Is anything of the identity left anywhere?
create or replace function ipd.exists_anywhere(t int) returns boolean language sql stable as $$
  select exists (select 1 from public.users where id = ipd.u(t)) or exists (select 1 from auth.users where id = ipd.u(t))
      or exists (select 1 from public.hr_employees where user_id = ipd.u(t))
      or exists (select 1 from public.sa_role_assignments where user_id = ipd.u(t))
      or exists (select 1 from public.sa_organization_memberships where user_id = ipd.u(t))
      or exists (select 1 from auth.identities where user_id = ipd.u(t)) or exists (select 1 from auth.sessions where user_id = ipd.u(t)) $$;
create or replace function ipd.fully_present(t int) returns boolean language sql stable as $$
  select exists (select 1 from public.users where id = ipd.u(t)) and exists (select 1 from auth.users where id = ipd.u(t))
     and exists (select 1 from public.hr_employees where user_id = ipd.u(t)) $$;

do $guard$
begin
  if exists (select 1 from public.users where id not between ipd.u(0) and ipd.u(999)) then
    raise exception 'refusing to run: this database contains real users (use a disposable replica)';
  end if;
end $guard$;

set session_replication_role = replica;

insert into public.organizations(id, org_type_code, parent_org_id, org_code, org_name, is_active) values
 (ipd.o(1), 'HQ', null, 'IPD-A', 'IPD HQ Alpha', true),
 (ipd.o(2), 'HQ', null, 'IPD-B', 'IPD HQ Beta', true);
insert into public.hr_go_live_state(organization_id, phase, note) values (ipd.o(1), 'pre_go_live', 'test'), (ipd.o(2), 'pre_go_live', 'test');
insert into public.departments(id, organization_id, dept_name, dept_code, is_active) values (ipd.x(1), ipd.o(1), 'Ops', 'OPS', true);

-- n, org, role_code, onboarding (null = no employment record), label
create temp table ipd_people(n int, org int, role_code text, onboarding text, label text);
insert into ipd_people values
  (1, 1, 'USER', 'completed', 'Identity purge administrator (platform data maintenance + HR record administrator, o1)'),
  (2, 1, 'SA',   'completed', 'Legacy Super Admin without any grant'),
  (3, 1, 'USER', 'pending',   'Pending employee, no dependencies'),
  (4, 1, 'USER', 'reset',     'Reset employee, no dependencies'),
  (5, 1, 'USER', 'completed', 'Completed employee with S&A assignment only'),
  (6, 1, 'USER', 'completed', 'Supply Chain history (orders.created_by)'),
  (7, 1, 'USER', 'completed', 'Payroll history'),
  (8, 1, 'USER', 'completed', 'Audit log actor'),
  (9, 1, 'USER', 'completed', 'Manager of 10'),
  (10, 1, 'USER', 'completed', 'Reports to 9'),
  (11, 2, 'USER', 'pending',  'Employee of organization B'),
  (12, 1, 'USER', 'completed', 'Root Access holder'),
  (13, 1, 'USER', 'completed', 'HR records officer (hr.employee.manage only)'),
  (14, 1, 'USER', 'completed', 'HR record administrator only (hr.employee.delete, no identity delete)'),
  (15, 1, 'USER', 'pending',  'Concurrency target'),
  (16, 1, 'SA',   'completed', 'Super Admin target'),
  (17, 1, 'USER', 'completed', 'Assignment under access review (someone else''s governance record)'),
  (18, 1, 'USER', null,       'Non-HR account (no employment record)'),
  (19, 1, 'USER', 'pending',  'Auth deletion failure target'),
  (20, 1, 'USER', 'pending',  'Database cleanup failure target'),
  (22, 1, 'USER', 'reset',    'HR records kept by a restorable reset snapshot'),
  (23, 1, 'USER', 'pending',  'Stale preview target'),
  (24, 1, 'USER', 'completed', 'Retained S&A decision log only (logged in once)'),
  (25, 1, 'USER', 'pending',  'Idempotency target'),
  (26, 1, 'USER', 'pending',  'HR entry target (deleted from HR)'),
  (27, 1, 'USER', 'completed', 'FK-less business attribution (stock_count_sessions.created_by)'),
  (28, 1, 'USER', 'completed', 'Platform owner with Root Access (actor)');

insert into auth.users(id, email, aud, role, updated_at)
select ipd.u(n), 'ipd-' || n || '@example.test', 'authenticated', 'authenticated', now() from ipd_people;
-- 21: login left behind without a central identity (earlier two-step delete)
insert into auth.users(id, email, aud, role, updated_at) values (ipd.u(21), 'ipd-21@example.test', 'authenticated', 'authenticated', now());
insert into auth.identities(id, provider_id, user_id, identity_data, provider)
select gen_random_uuid(), ipd.u(n)::text, ipd.u(n), jsonb_build_object('sub', ipd.u(n)::text), 'email' from ipd_people;
insert into auth.sessions(id, user_id) select gen_random_uuid(), ipd.u(n) from ipd_people;

insert into public.users(id, email, full_name, role_code, organization_id, is_active, principal_type, account_status, account_scope,
                         department_id, manager_user_id, employee_no, updated_at)
select ipd.u(n), 'ipd-' || n || '@example.test', label, role_code, ipd.o(org), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal',
       ipd.x(1), case when n = 10 then ipd.u(9) end, case when onboarding is not null then 910000 + n end, now()
from ipd_people;

insert into public.hr_employees(id, employee_no, user_id, organization_id, hire_date, status, department_id, manager_user_id, employment_type,
                                onboarding_status, onboarding_source, onboarded_at, onboarded_by, hire_date_confirmed)
select ipd.x(100 + n), 910000 + n, ipd.u(n), ipd.o(org), date '2026-01-05', 'active', ipd.x(1),
       case when n = 10 then ipd.u(9) end, 'Full-time', onboarding,
       case when onboarding = 'pending' then null else 'hr_onboarding' end,
       case when onboarding = 'pending' then null else now() - interval '5 days' end,
       case when onboarding = 'pending' or n = 1 then null else ipd.u(1) end, onboarding <> 'pending'
from ipd_people where onboarding is not null;

insert into public.sa_organization_memberships(id, user_id, organization_id, membership_type, is_primary, status, source)
select ipd.x(200 + n), ipd.u(n), ipd.o(org), 'employee', true, 'active', 'manual' from ipd_people;
insert into public.sa_scope_definitions(id, organization_id, scope_type, scope_value, display_name, status)
select ipd.x(300 + n), ipd.o(n), 'organization', ipd.o(n)::text, 'IPD scope ' || n, 'active' from generate_series(1, 2) n;

do $assign$
declare r record; v_id uuid;
begin
  for r in select * from (values
      (1, 'platform-data-maintenance-administrator', 1), (1, 'hr-employee-record-administrator', 1),
      (5, 'hr-records-officer', 1), (13, 'hr-records-officer', 1), (14, 'hr-employee-record-administrator', 1),
      (17, 'hr-records-officer', 1)) t(n, role_key, scope_org)
  loop
    insert into public.sa_role_assignments(id, user_id, role_id, membership_id, status, source, assignment_reason)
    values (ipd.x(500 + r.n * 2 + (case when r.role_key = 'hr-employee-record-administrator' then 1 else 0 end)), ipd.u(r.n),
            (select id from public.sa_business_roles where role_key = r.role_key), ipd.x(200 + r.n), 'active', 'manual', 'ipd test')
    returning id into v_id;
    insert into public.sa_assignment_scopes(assignment_id, scope_id) values (v_id, ipd.x(300 + r.scope_org));
  end loop;
end $assign$;

-- Business / audit history
insert into public.orders(id, order_no, order_type, company_id, buyer_org_id, seller_org_id, created_by)
values (ipd.x(400), 'IPD-ORD-1', 'H2M', ipd.o(1), ipd.o(1), ipd.o(1), ipd.u(6));
insert into public.hr_payroll_runs(id, organization_id, period_start, period_end) values (ipd.x(404), ipd.o(1), date '2026-09-01', date '2026-09-30');
insert into public.hr_payroll_run_items(id, organization_id, payroll_run_id, employee_user_id) values (ipd.x(405), ipd.o(1), ipd.x(404), ipd.u(7));
insert into public.audit_logs(user_id, action, entity_type) values (ipd.u(8), 'UPDATE', 'products');
insert into public.sa_root_access_grants(user_id, grant_method, reason, status) values
  (ipd.u(12), 'grant', 'Root access for a second administrator', 'active'),
  (ipd.u(28), 'bootstrap', 'Root access for the platform owner', 'active');
insert into public.sa_access_review_campaigns(id, name, reviewer_id, created_by, status) values (ipd.x(600), 'IPD review', ipd.u(2), ipd.u(2), 'active');
insert into public.sa_access_review_items(campaign_id, user_id, role_id, snapshot, assignment_id)
values (ipd.x(600), ipd.u(17), (select id from public.sa_business_roles where role_key = 'hr-records-officer'), '{}'::jsonb, ipd.x(534));
-- 22: an unrestored HR reset run snapshotted an attendance row of this person
insert into public.hr_reset_runs(id, request_id, organization_id, kind, status, actor_id, reason, confirmation, preview_token)
values (ipd.x(700), ipd.x(701), ipd.o(1), 'full', 'completed', ipd.u(2), 'reset for test', 'RESET', 't');
insert into public.hr_reset_snapshots(run_id, table_name, row_id, row_data)
values (ipd.x(700), 'hr_attendance_entries', ipd.x(702)::text, jsonb_build_object('id', ipd.x(702), 'user_id', ipd.u(22), 'organization_id', ipd.o(1)));
-- 24: logged in once (append-only decision log, no foreign key) — retained, not a blocker
insert into public.sa_authorization_decisions(id, actor_id, permission_key, resource_type, decision, reason_code, migration_mode,
  new_decision, comparison, policy_version, audit_class)
values (gen_random_uuid(), ipd.u(24), 'platform.user.view', 'user', 'ALLOW', 'ASSIGNMENT', 'LEGACY_RETIRED', 'ALLOW', 'MATCH_ALLOW', 'v1', 'ENFORCED_DECISION');
insert into public.stock_count_sessions(id, warehouse_organization_id, created_by) values (ipd.x(800), ipd.o(1), ipd.u(27));

set session_replication_role = origin;
select ipd.expect(true, 'fixtures loaded');
