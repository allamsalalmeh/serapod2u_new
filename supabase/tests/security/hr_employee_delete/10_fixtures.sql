-- HR employee controlled delete (20261214100000). Synthetic fixtures; DISPOSABLE replica only.
-- Loaded as the database owner with triggers off; every test runs with triggers on.
set check_function_bodies = off;
create schema if not exists hed;
create or replace function hed.o(n int) returns uuid language sql immutable as $$ select ('0000000c-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function hed.u(n int) returns uuid language sql immutable as $$ select ('0000000d-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function hed.x(n int) returns uuid language sql immutable as $$ select ('0000000e-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function hed.expect(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAILED: %', p_msg; end if;
  raise notice 'ok - %', p_msg;
end $$;
create or replace function hed.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return null;
exception when others then return sqlstate || ' ' || sqlerrm; end $$;
create or replace function hed.preview(a int, t int, org int default 1) returns jsonb language sql as $$
  select public.hr_employee_registration_preview(hed.u(a), hed.o(org), hed.u(t)) $$;
create or replace function hed.exec(a int, t int, act text, req int, org int default 1, token text default null,
                                    reason text default 'Incorrectly onboarded test record') returns jsonb language sql as $$
  select public.hr_employee_registration_execute(hed.u(a), hed.o(org), hed.u(t), act, hed.x(9000 + req),
    coalesce(token, public.hr_employee_registration_preview(hed.u(a), hed.o(org), hed.u(t))->>'preview_token'), reason) $$;
create or replace function hed.state(t int, org int default 1) returns text language sql stable as $$
  select onboarding_status from public.hr_employees where user_id = hed.u(t) and organization_id = hed.o(org) $$;
create or replace function hed.codes(p jsonb, act text) returns text[] language sql immutable as $$
  select coalesce(array_agg(distinct b->>'code' order by b->>'code'), '{}') from jsonb_array_elements(p->'blockers'->act) b $$;
-- Fingerprint of everything the actions must never change for a person (identity, login, access, employment facts, history).
create or replace function hed.untouched(t int) returns text language sql stable as $$
  select md5(concat_ws('|',
    (select to_jsonb(u)::text from public.users u where u.id = hed.u(t)),
    (select to_jsonb(au)::text from auth.users au where au.id = hed.u(t)),
    (select jsonb_agg(to_jsonb(m) order by m.id)::text from public.sa_organization_memberships m where m.user_id = hed.u(t)),
    (select jsonb_agg(to_jsonb(a) order by a.id)::text from public.sa_role_assignments a where a.user_id = hed.u(t)),
    (select jsonb_build_object('no', e.employee_no, 'dept', e.department_id, 'pos', e.position_id, 'mgr', e.manager_user_id,
            'type', e.employment_type, 'hire', e.hire_date, 'status', e.status, 'id', e.id)::text
       from public.hr_employees e where e.user_id = hed.u(t) and e.organization_id = hed.o(1)),
    (select jsonb_agg(to_jsonb(o) order by o.id)::text from public.orders o where o.created_by = hed.u(t)),
    (select jsonb_agg(to_jsonb(a) order by a.id)::text from public.hr_attendance_entries a where a.user_id = hed.u(t)),
    (select jsonb_agg(to_jsonb(l) order by l.id)::text from public.hr_leave_requests l where l.employee_id = hed.u(t)),
    (select jsonb_agg(to_jsonb(p) order by p.id)::text from public.hr_payroll_run_items p where p.employee_user_id = hed.u(t)))) $$;

do $guard$
begin
  if exists (select 1 from public.users where id not between hed.u(0) and hed.u(999)) then
    raise exception 'refusing to run: this database contains real users (use a disposable replica)';
  end if;
end $guard$;

set session_replication_role = replica;

insert into public.organizations(id, org_type_code, parent_org_id, org_code, org_name, is_active) values
 (hed.o(1), 'HQ', null, 'HED-A', 'HED HQ Alpha', true),
 (hed.o(2), 'HQ', null, 'HED-B', 'HED HQ Beta', true);
insert into public.hr_go_live_state(organization_id, phase, note) values (hed.o(1), 'pre_go_live', 'test'), (hed.o(2), 'pre_go_live', 'test');
insert into public.departments(id, organization_id, dept_name, dept_code, is_active) values (hed.x(1), hed.o(1), 'Ops', 'OPS', true), (hed.x(2), hed.o(1), 'Fin', 'FIN', true);

insert into auth.users(id, email, aud, role)
select hed.u(n), 'hed-' || n || '@example.test', 'authenticated', 'authenticated' from generate_series(1, 14) n;
insert into public.users(id, email, full_name, role_code, organization_id, is_active, principal_type, account_status, account_scope,
                         department_id, manager_user_id, employee_no)
select hed.u(n), 'hed-' || n || '@example.test', label, role_code, hed.o(org), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal',
       hed.x(1), case when n = 6 then hed.u(5) end, 900000 + n
from (values
  (1, 1, 'USER', 'HR record administrator (granted, o1)'),
  (2, 1, 'SA',   'Legacy Super Admin without the grant'),
  (3, 1, 'USER', 'Eligible test employee'),
  (4, 1, 'USER', 'System user with S&A access and Supply Chain history'),
  (5, 1, 'USER', 'Manager of 6'),
  (6, 1, 'USER', 'Attendance + leave history'),
  (7, 1, 'USER', 'Payroll + commission history'),
  (8, 2, 'USER', 'Employee of organization B'),
  (9, 2, 'USER', 'HR record administrator (granted, o2)'),
  (10, 1, 'USER', 'Automatic anchor, never registered'),
  (11, 1, 'USER', 'Registration reset, no HR records'),
  (12, 1, 'USER', 'Concurrency target'),
  (13, 1, 'USER', 'Race fence target'),
  (14, 1, 'USER', 'Rollback target')
) t(n, org, role_code, label);

insert into public.hr_employees(id, employee_no, user_id, organization_id, hire_date, status, department_id, manager_user_id, employment_type,
                                onboarding_status, onboarding_source, onboarded_at, onboarded_by, hire_date_confirmed)
select hed.x(100 + n), 900000 + n, hed.u(n), hed.o(case when n in (8, 9) then 2 else 1 end), date '2026-01-05', 'active', hed.x(1),
       case when n = 6 then hed.u(5) end, 'Full-time',
       case n when 10 then 'pending' when 11 then 'reset' else 'completed' end,
       case when n = 10 then null else 'hr_onboarding' end, case when n = 10 then null else now() - interval '5 days' end,
       case when n = 10 then null else hed.u(1) end, n <> 10
from generate_series(1, 14) n;

insert into public.sa_organization_memberships(id, user_id, organization_id, membership_type, is_primary, status, source)
select hed.x(200 + n), hed.u(n), u.organization_id, 'employee', true, 'active', 'manual'
from generate_series(1, 14) n join public.users u on u.id = hed.u(n);
insert into public.sa_scope_definitions(id, organization_id, scope_type, scope_value, display_name, status)
select hed.x(300 + n), hed.o(n), 'organization', hed.o(n)::text, 'HED scope ' || n, 'active' from generate_series(1, 2) n;

do $assign$
declare r record; v_id uuid;
begin
  for r in select * from (values (4, 'hr-records-officer', 1)) t(n, role_key, scope_org)
  loop
    insert into public.sa_role_assignments(user_id, role_id, membership_id, status, source, assignment_reason)
    values (hed.u(r.n), (select id from public.sa_business_roles where role_key = r.role_key), hed.x(200 + r.n), 'active', 'manual', 'hed test')
    returning id into v_id;
    insert into public.sa_assignment_scopes(assignment_id, scope_id) values (v_id, hed.x(300 + r.scope_org));
  end loop;
end $assign$;

-- History
insert into public.orders(id, order_no, order_type, company_id, buyer_org_id, seller_org_id, created_by)
values (hed.x(400), 'HED-ORD-1', 'H2M', hed.o(1), hed.o(1), hed.o(1), hed.u(4));
insert into public.hr_leave_types(id, organization_id, code, name) values (hed.x(401), hed.o(1), 'AL', 'Annual');
insert into public.hr_attendance_entries(id, organization_id, user_id, clock_in_at) values (hed.x(402), hed.o(1), hed.u(6), now() - interval '2 days');
insert into public.hr_leave_requests(id, organization_id, employee_id, leave_type_id, start_date, end_date) values (hed.x(403), hed.o(1), hed.u(6), hed.x(401), current_date, current_date);
insert into public.hr_payroll_runs(id, organization_id, period_start, period_end) values (hed.x(404), hed.o(1), date '2026-09-01', date '2026-09-30');
insert into public.hr_payroll_run_items(id, organization_id, payroll_run_id, employee_user_id) values (hed.x(405), hed.o(1), hed.x(404), hed.u(7));
insert into public.hr_employee_commission_profiles(employee_id, company_id) values (hed.x(107), hed.o(1));

set session_replication_role = origin;
select hed.expect(true, 'fixtures loaded');
