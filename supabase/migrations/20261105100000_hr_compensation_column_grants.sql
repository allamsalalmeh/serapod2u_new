-- ============================================================================
-- HR — Compensation column-level privileges (Manager Compensation Viewer hardening)
-- ----------------------------------------------------------------------------
-- NOT APPLIED. Apply by hand per environment (staging first), after 20261104100000_hr_mss_compensation_rls.sql.
-- Validated only on a throwaway PostgreSQL 17. Adds NO business data and NO assignments.
--
-- The viewer RLS policies restrict ROWS, but a direct PostgREST call could still read every COLUMN of a permitted row
-- (hourly_rate, salary_band_id, pay_type, ot_eligible, notes). This migration restricts what the API role
-- (`authenticated`) can SELECT at the column level, so a direct PostgREST request by a manager holding only
-- hr.compensation.salary_view / hr.compensation.allowance_view cannot read the prohibited columns either:
--
--   hr_employee_compensation  authenticated may SELECT: id, organization_id, employee_id, basic_salary,
--                             currency, effective_date, end_date, status
--                             (never hourly_rate, salary_band_id, pay_type, ot_eligible, notes, created_by, timestamps)
--   hr_employee_allowances    authenticated may SELECT: id, organization_id, employee_id, allowance_type_id,
--                             amount, currency, effective_date, end_date, is_active
--                             (never notes, timestamps)
--
-- Legitimate HR/Payroll privileged reads move to service_role: the payroll routes already authorize the caller with
-- hrCan('hr.compensation.view' / 'hr.compensation.manage') before touching data, and now use the admin client for the
-- full-row read. service_role retains GRANT ALL on both tables (unchanged).
--
-- Idempotent. Rollback: re-issue the previous whole-table grants
--   grant select on public.hr_employee_compensation to authenticated;
--   grant select on public.hr_employee_allowances to authenticated;
-- ============================================================================

do $pre$
begin
  if to_regclass('public.hr_employee_compensation') is null or to_regclass('public.hr_employee_allowances') is null then
    raise exception 'hr_compensation_columns_prerequisite_missing: hr_employee_compensation / hr_employee_allowances';
  end if;
end $pre$;

-- The Compensation Viewer (and every other API caller) may read only the permitted fields.
revoke select on public.hr_employee_compensation from authenticated;
grant select (id, organization_id, employee_id, basic_salary, currency, effective_date, end_date, status)
  on public.hr_employee_compensation to authenticated;

revoke select on public.hr_employee_allowances from authenticated;
grant select (id, organization_id, employee_id, allowance_type_id, amount, currency, effective_date, end_date, is_active)
  on public.hr_employee_allowances to authenticated;

do $post$
begin
  -- The prohibited columns must NOT be readable by the API role.
  if has_column_privilege('authenticated', 'public.hr_employee_compensation', 'hourly_rate', 'SELECT')
     or has_column_privilege('authenticated', 'public.hr_employee_compensation', 'salary_band_id', 'SELECT')
     or has_column_privilege('authenticated', 'public.hr_employee_compensation', 'notes', 'SELECT') then
    raise exception 'postcondition: authenticated must not select hourly_rate / salary_band_id / notes on hr_employee_compensation';
  end if;
  if has_column_privilege('authenticated', 'public.hr_employee_allowances', 'notes', 'SELECT') then
    raise exception 'postcondition: authenticated must not select notes on hr_employee_allowances';
  end if;
  -- The permitted columns must be readable.
  if not has_column_privilege('authenticated', 'public.hr_employee_compensation', 'basic_salary', 'SELECT')
     or not has_column_privilege('authenticated', 'public.hr_employee_allowances', 'amount', 'SELECT') then
    raise exception 'postcondition: authenticated must select basic_salary / amount';
  end if;
  -- The service role keeps full access for the authorized payroll routes.
  if not has_table_privilege('service_role', 'public.hr_employee_compensation', 'SELECT')
     or not has_table_privilege('service_role', 'public.hr_employee_allowances', 'SELECT') then
    raise exception 'postcondition: service_role must keep full SELECT';
  end if;
end $post$;
