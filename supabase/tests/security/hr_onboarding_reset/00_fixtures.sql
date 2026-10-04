-- ============================================================================
-- HR onboarding / reset fixtures. DISPOSABLE ISOLATED DATABASES ONLY.
-- Run BEFORE 20261003100000_hr_onboarding_state_and_data_reset.sql so the
-- legacy backfill rule is exercised, then 10_onboarding_and_reset.sql.
-- ============================================================================
\set ON_ERROR_STOP 1
do $pre$ begin
  if exists (select 1 from public.users) then raise exception 'Refusing to load fixtures: users table is not empty'; end if;
end $pre$;
-- Fixture data present BEFORE the migration (exercises the legacy backfill rule)
create or replace function u(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid $$;
create or replace function o(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-00000000a0' || lpad(n::text, 2, '0'))::uuid $$;
create or replace function x(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000f' || lpad(n::text, 4, '0'))::uuid $$;

insert into organization_types(type_code) values ('HQ'),('DIST'),('SHOP'),('WH');
insert into organizations(id, org_name, org_code, org_type_code, is_active) values
 (o(1),'HQ Alpha','HQA','HQ',true),(o(2),'HQ Beta','HQB','HQ',true),(o(3),'Dist One','DST1','DIST',true);
insert into roles(id, role_code, role_name, role_level, is_active) values
 (gen_random_uuid(),'SA','Super Admin',1,true),(gen_random_uuid(),'HQ_ADMIN','HQ Admin',10,true),
 (gen_random_uuid(),'HR_MANAGER','HR Manager',30,true),(gen_random_uuid(),'WH_STAFF','Warehouse Staff',40,true),
 (gen_random_uuid(),'USER','User',50,true),(gen_random_uuid(),'GUEST','Guest',99,true);

create or replace function mkuser(n int, p_email text, p_phone text, p_name text, p_role text, p_org uuid, p_scope text default 'portal')
returns uuid language plpgsql as $$
begin
  insert into auth.users(id, email, phone) values (u(n), p_email, p_phone);
  insert into public.users(id, email, phone, full_name, role_code, organization_id, account_scope, phone_verified_at, created_at)
  values (u(n), p_email, p_phone, p_name, p_role, p_org, p_scope, case when p_phone is not null then now() end, now() - interval '400 days');
  return u(n);
end $$;
select mkuser(1,'sa@hqa.test','+60120000001','Super Admin','SA',o(1));
select mkuser(2,'hr@hqa.test','+60120000002','Hana HR','HR_MANAGER',o(1));
select mkuser(3,'sc@hqa.test','+60120000003','Sam Supply','WH_STAFF',o(1));
select mkuser(4,'staff@hqa.test','+60120000004','Siti Staff','USER',o(1));
select mkuser(5,'beta@hqb.test','+60120000005','Ben Beta','USER',o(2));
select mkuser(6,'dist@dst.test','+60120000006','Dina Dist','USER',o(3));
select mkuser(7,'consumer@x.test','+60120000007','Carl Consumer','GUEST',null,'store');
select mkuser(8,'sa2@hqa.test','+60120000008','Second SA','SA',o(1));
select mkuser(9,'admin@hqa.test','+60120000009','Hq Admin','HQ_ADMIN',o(1));

-- HR configuration (must survive every reset)
insert into departments(id, organization_id, dept_name, dept_code, is_active) values (x(1), o(1), 'Operations','OPS',true), (x(2), o(1), 'Finance','FIN',true);
insert into hr_positions(id, organization_id, code, name, is_active) values (x(3), o(1),'WH','Warehouse Lead',true);
insert into hr_leave_types(id, organization_id, code, name) values (x(4), o(1),'AL','Annual'), (x(5), o(2),'AL','Annual');
insert into hr_public_holidays(id, organization_id, name, date) values (x(6), o(1),'Merdeka','2026-08-31');
insert into hr_allowance_types(id, organization_id, code, name) values (x(7), o(1),'TRN','Transport');
insert into hr_salary_bands(id, organization_id, code, name) values (x(8), o(1),'B1','Band 1');
insert into hr_approval_chains(id, organization_id, name) values (x(9), o(1),'Default');
insert into hr_kpi_metrics(id, organization_id, kpi_code, name) values (x(10), o(1),'SALES','Sales');
insert into hr_kpi_periods(id, organization_id, name) values (x(11), o(1),'2026');

-- Supply Chain history and a projection used elsewhere
update users set department_id = x(1), position_id = x(3) where id = u(3);
insert into orders(id, created_by) values (x(20), u(3));

-- HR operational history (pre-existing)
insert into hr_leave_requests(id, organization_id, employee_id, leave_type_id, status) values (x(30), o(1), u(3), x(4), 'approved'), (x(31), o(2), u(5), x(5), 'pending');
insert into hr_leave_balances(id, organization_id, employee_id, leave_type_id, year) values (x(32), o(1), u(3), x(4), 2026);
insert into hr_attendance_entries(id, organization_id, user_id, status) values (x(33), o(1), u(4), 'closed');
insert into hr_attendance_corrections(id, organization_id, entry_id, requested_by, status) values (x(34), o(1), x(33), u(4), 'pending');
insert into hr_payroll_runs(id, organization_id, status) values (x(35), o(1), 'draft');
insert into hr_payroll_run_items(id, organization_id, payroll_run_id, employee_user_id) values (x(36), o(1), x(35), u(3));
insert into hr_employee_compensation(id, organization_id, employee_id, salary_band_id, status) values (x(37), o(1), u(3), x(8), 'active');
insert into hr_employee_allowances(id, organization_id, employee_id, allowance_type_id, amount) values (x(38), o(1), u(3), x(7), 100);
insert into hr_kpi_assignments(id, organization_id, metric_id, period_id, employee_user_id) values (x(39), o(1), x(10), x(11), u(3));
insert into hr_kpi_scorecards(id, organization_id, period_id, employee_user_id) values (x(40), o(1), x(11), u(3));
insert into hr_kpi_scorecard_items(id, organization_id, scorecard_id, assignment_id, metric_id) values (x(41), o(1), x(40), x(39), x(10));
insert into hr_employee_profiles(user_id, organization_id, ic_number) values (u(3), o(1), '900101-01-0001');
