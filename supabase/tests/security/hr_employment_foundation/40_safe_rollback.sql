-- HR employment foundation (Wave 2) — SAFE rollback rehearsal (header of 20261221100000), then re-apply by the runner.
-- Rollback stops enforcement and history writes; it never deletes history.
do $t$
declare n_before bigint;
begin
  select count(*) into n_before from public.hr_employee_versions;
  drop trigger if exists hr_employees_lifecycle_guard on public.hr_employees;
  drop trigger if exists hr_employees_record_version on public.hr_employees;
  drop trigger if exists hr_employees_end_effects on public.hr_employees;
  drop trigger if exists hr_employees_purge_versions on public.hr_employees;
  drop trigger if exists hr_employee_compensation_no_overlap on public.hr_employee_compensation;
  drop trigger if exists hr_employee_compensation_log on public.hr_employee_compensation;
  drop trigger if exists hr_statutory_profiles_log on public.hr_employee_statutory_profiles;
  drop function if exists public.hr_set_reporting_line(uuid,uuid,uuid,text), public.hr_reassign_direct_reports(uuid,uuid,uuid,text,uuid[]),
    public.hr_employment_change(uuid,uuid,jsonb,date,text);
  alter table public.hr_employee_compensation drop constraint if exists hr_emp_comp_dates_chk;
  perform hlc.expect((select count(*) from public.hr_employee_versions) = n_before, 'RB1 rollback keeps every history row');
  perform hlc.expect(not exists (select 1 from pg_trigger where tgname in ('hr_employees_lifecycle_guard','hr_employees_record_version')),
                     'RB2 enforcement and history triggers are removed');
  update public.hr_employees set probation_end = date '2027-01-31' where user_id = hlc.u(5);
  perform hlc.expect((select count(*) from public.hr_employee_versions) = n_before, 'RB3 with the rollback in place no version is written');
  perform hlc.expect(exists (select 1 from pg_trigger where tgname = 'hr_leave_requests_guard'), 'RB4 the B2A leave guard is untouched by this rollback');
end $t$;
