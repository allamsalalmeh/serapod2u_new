-- HR onboarding state + HR Data Management — read-only readiness check.
-- Run BEFORE (and again after) 20261003100000_hr_onboarding_state_and_data_reset.sql.
-- Changes nothing: one READ ONLY transaction, rolled back. No personal data
-- is returned (counts per organization only).
begin transaction read only;

-- 1. Employment anchors per organization (all become onboarding 'completed'
--    / 'legacy_backfill' when the migration runs; HR lists do not change).
select o.org_code, o.org_type_code,
       count(e.id) as employment_records,
       count(*) filter (where u.principal_type = 'INTERNAL_EMPLOYEE' and u.organization_id = e.organization_id) as current_internal_staff,
       count(*) filter (where u.organization_id is distinct from e.organization_id or u.principal_type <> 'INTERNAL_EMPLOYEE') as history_only
from public.hr_employees e
join public.organizations o on o.id = e.organization_id
join public.users u on u.id = e.user_id
group by o.org_code, o.org_type_code
order by o.org_code;

-- 2. Internal staff without an employment record (expected 0; Stage 2 invariant).
select count(*) as internal_staff_without_employment_record
from public.users u
where u.principal_type = 'INTERNAL_EMPLOYEE' and u.organization_id is not null
  and not exists (select 1 from public.hr_employees e where e.user_id = u.id and e.organization_id = u.organization_id);

-- 3. HR operational rows a full reset would remove, per organization (tables
--    that do not exist are skipped).
do $$
declare
  t text;
  r record;
begin
  foreach t in array array['hr_attendance_corrections','hr_overtime_calculations','hr_overtime_requests','hr_timesheet_entries',
    'hr_timesheets','hr_attendance_entries','hr_attendance_audit','hr_leave_approvals','hr_leave_requests','hr_leave_balances',
    'hr_payslip_access_logs','hr_payroll_audit','hr_payroll_run_items','hr_payroll_runs','hr_employee_compensation',
    'hr_employee_allowances','hr_employee_deductions','hr_kpi_evidence','hr_kpi_adjustments','hr_kpi_reviews',
    'hr_kpi_scorecard_items','hr_kpi_scorecards','hr_kpi_actuals','hr_kpi_targets','hr_kpi_assignments','hr_performance_reviews']
  loop
    if to_regclass('public.' || t) is null then
      raise notice '% : not present', t;
      continue;
    end if;
    if not exists (select 1 from pg_attribute where attrelid = to_regclass('public.' || t) and attname = 'organization_id' and not attisdropped) then
      raise notice '% : NO organization_id column (would block a full reset)', t;
      continue;
    end if;
    for r in execute format('select o.org_code, count(*) n from public.%I x left join public.organizations o on o.id = x.organization_id group by o.org_code order by 1', t) loop
      raise notice '% : % = %', t, coalesce(r.org_code, '(none)'), r.n;
    end loop;
  end loop;
end $$;

-- 4. Finance signals that would block a full reset.
select count(*) filter (where gl_journal_id is not null or gl_reversal_journal_id is not null or gl_posted_at is not null) as payroll_runs_posted_to_gl,
       (select count(*) from public.hr_gl_postings) as hr_gl_postings,
       (select count(*) from public.payroll_journals) as payroll_journals,
       (select count(*) from public.payroll_payment_batches) as payroll_payment_batches
from public.hr_payroll_runs;

-- 5. After the migration: onboarding state and go-live phase per organization.
select o.org_code, g.phase,
       count(e.id) filter (where e.onboarding_status = 'completed') as onboarded,
       count(e.id) filter (where e.onboarding_status in ('pending','reset')) as awaiting
from public.hr_go_live_state g
join public.organizations o on o.id = g.organization_id
left join public.hr_employees e on e.organization_id = g.organization_id
group by o.org_code, g.phase
order by o.org_code;   -- fails harmlessly before the migration (table absent)

rollback;
