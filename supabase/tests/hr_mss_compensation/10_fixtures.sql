-- Manager Self-Service / Compensation Viewer fixtures (synthetic, never real data). Runs on a disposable mss_test*
-- database restored from a schema-only staging dump + the S&A catalogue (see run.sh), with the REAL user lifecycle,
-- S&A evaluator and hr_employees triggers. Ids: 00000000-0000-0000-00mN-...
do $g$ begin if current_database() !~ '^mss_test' then raise exception 'Refusing: not a disposable mss_test* database'; end if; end $g$;

create schema if not exists hmt;
create or replace function hmt.u(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-00d1-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function hmt.o(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-00d2-' || lpad(n::text, 12, '0'))::uuid $$;
create or replace function hmt.expect(p_ok boolean, p_msg text) returns void language plpgsql as $$
begin if not coalesce(p_ok, false) then raise exception 'ASSERTION FAILED: %', p_msg; end if; end $$;
-- Run SQL as a PostgREST caller (role authenticated + JWT claims). Returns 'OK' or the error message.
create or replace function hmt.as_user(p_uid uuid, p_sql text) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', p_uid)::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    execute p_sql;
    perform set_config('role', 'none', true); perform set_config('request.jwt.claims', '', true);
    return 'OK';
  exception when others then
    perform set_config('role', 'none', true); perform set_config('request.jwt.claims', '', true);
    return sqlerrm;
  end;
end $$;
create or replace function hmt.val_as(p_uid uuid, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', p_uid)::text, true);
  perform set_config('role', 'authenticated', true);
  begin execute p_sql into v; exception when others then v := 'ERROR: ' || sqlerrm; end;
  perform set_config('role', 'none', true); perform set_config('request.jwt.claims', '', true);
  return v;
end $$;
grant usage on schema hmt to public;
grant execute on all functions in schema hmt to public;

-- One company. o1 HQ (Serapod). o9 another company's HQ.
insert into public.organizations(id, org_type_code, org_code, org_name) values (hmt.o(1), 'HQ', 'MTSTHQ', 'MSS Test HQ');
insert into public.organizations(id, org_type_code, org_code, org_name) values (hmt.o(9), 'HQ', 'MTSTHQ9', 'Other Company HQ');

-- People (internal employees of o1 unless noted):
--   1 manager (holds manager-self-service + manager-compensation-viewer via S&A)
--   2 direct report A (reports to 1)
--   3 direct report B (reports to 1)
--   4 non-report employee (does NOT report to 1)
--   5 manager with manager-self-service ONLY (no compensation viewer)
--   6 direct report of 5 (resigned — must NOT appear)
--   7 another company's manager (holds manager-self-service in o9)
--   8 employee in o9 (reports to 7)
insert into auth.users(id, email) select hmt.u(n), 'mss' || n || '@dev.com' from generate_series(1, 8) n;
insert into public.users(id, email, full_name, role_code, organization_id, is_active, principal_type, account_status, account_scope) values
  (hmt.u(1), 'mss1@dev.com', 'Mira Manager', 'GUEST', hmt.o(1), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal'),
  (hmt.u(2), 'mss2@dev.com', 'Aina Analyst', 'GUEST', hmt.o(1), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal'),
  (hmt.u(3), 'mss3@dev.com', 'Budi Builder', 'GUEST', hmt.o(1), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal'),
  (hmt.u(4), 'mss4@dev.com', 'Chun Unrelated', 'GUEST', hmt.o(1), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal'),
  (hmt.u(5), 'mss5@dev.com', 'Dara Director', 'GUEST', hmt.o(1), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal'),
  (hmt.u(6), 'mss6@dev.com', 'Emi Ex', 'GUEST', hmt.o(1), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal'),
  (hmt.u(7), 'mss7@dev.com', 'Other Manager', 'GUEST', hmt.o(9), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal'),
  (hmt.u(8), 'mss8@dev.com', 'Other Emp', 'GUEST', hmt.o(9), true, 'INTERNAL_EMPLOYEE', 'ACTIVE', 'portal');

-- Departments (grouping comes from HR data).
insert into public.departments(id, organization_id, dept_code, dept_name) values
  ('00000000-0000-0000-00d3-000000000001', hmt.o(1), 'MSS-OPS', 'Operations');

-- Reporting relationships and onboarding via hr_employees (the source of truth). Bypass the onboarding guard for the fixture.
alter table public.hr_employees disable trigger hr_employees_onboarding_guard;
update public.hr_employees set onboarding_status = 'completed', manager_user_id = hmt.u(1), status = 'active', hire_date = '2024-01-01', department_id = '00000000-0000-0000-00d3-000000000001' where user_id in (hmt.u(2), hmt.u(3));
update public.hr_employees set onboarding_status = 'completed', manager_user_id = hmt.u(1), status = 'active', hire_date = '2024-01-01' where user_id = hmt.u(4);
-- u4 does NOT report to the manager: fix its manager to nobody (null) so it is not a direct report.
update public.hr_employees set manager_user_id = null where user_id = hmt.u(4);
update public.hr_employees set onboarding_status = 'completed', manager_user_id = hmt.u(5), status = 'resigned', hire_date = '2024-01-01' where user_id = hmt.u(6);
update public.hr_employees set onboarding_status = 'completed', manager_user_id = hmt.u(7), status = 'active', hire_date = '2024-01-01' where user_id = hmt.u(8);
alter table public.hr_employees enable trigger hr_employees_onboarding_guard;

-- Compensation for the direct reports (u2, u3) and the unrelated u4.
insert into public.hr_employee_compensation(organization_id, employee_id, basic_salary, status, effective_date) values
  (hmt.o(1), hmt.u(2), 4500.00, 'active', '2026-01-01'),
  (hmt.o(1), hmt.u(3), 5200.00, 'active', '2026-01-01'),
  (hmt.o(1), hmt.u(4), 9999.00, 'active', '2026-01-01');
