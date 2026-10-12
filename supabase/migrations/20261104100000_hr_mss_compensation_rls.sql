-- ============================================================================
-- HR — Manager Compensation Viewer: row-level security backstop
-- ----------------------------------------------------------------------------
-- NOT APPLIED. Apply by hand per environment (staging first), after 20261103100000_hr_mss_compensation_viewer.sql.
-- Validated only on a throwaway PostgreSQL 17. Adds NO business data and NO assignments.
--
-- The Compensation Viewer API no longer reads salary/allowances through the service role. This migration makes the
-- database itself enforce the viewer's data scope on the two sensitive tables, so a direct PostgREST read is also
-- restricted to the caller's CURRENT, active direct reports (never "any employee in the organization"):
--
--   hr_employee_compensation   SELECT for a holder of hr.compensation.salary.view, direct reports only
--   hr_employee_allowances     SELECT for a holder of hr.compensation.allowance.view, direct reports only
--
-- The predicates are SECURITY DEFINER (so they can call the service-role-only hr_manager_is_direct_report) but are
-- granted to `authenticated` so RLS can evaluate them for an API call. They are read-only and leak nothing beyond the
-- reporting relationship the staff organization chart already exposes. Column projection (basic_salary only, no
-- hourly_rate/salary_band/notes) remains the API route's responsibility, exactly as every other HR read does.
--
-- Repeat-safe (create or replace; drop policy if exists). Rollback: drop the two policies and two predicates.
-- ============================================================================

do $pre$
begin
  if to_regprocedure('public.hr_compensation_viewer_allowed(text,uuid)') is null
     or to_regprocedure('public.hr_manager_is_direct_report(uuid,uuid)') is null
     or to_regprocedure('public.hr_manager_actor_company()') is null then
    raise exception 'hr_mss_rls_prerequisite_missing: apply 20261103100000_hr_mss_compensation_viewer.sql first';
  end if;
  if to_regclass('public.hr_employee_compensation') is null or to_regclass('public.hr_employee_allowances') is null then
    raise exception 'hr_mss_rls_prerequisite_missing: hr_employee_compensation / hr_employee_allowances';
  end if;
end $pre$;

-- May the caller read this employee's basic salary? Permission + company + CURRENT direct-report relationship.
create or replace function public.hr_mss_salary_viewer_can_read(p_employee_user_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select auth.uid() is not null
    and public.hr_compensation_viewer_allowed('hr.compensation.salary.view', public.hr_manager_actor_company())
    and public.hr_manager_is_direct_report(auth.uid(), p_employee_user_id)
$$;
revoke all on function public.hr_mss_salary_viewer_can_read(uuid) from public, anon;
grant execute on function public.hr_mss_salary_viewer_can_read(uuid) to authenticated;

-- May the caller read this employee's fixed allowances? Permission + company + CURRENT direct-report relationship.
create or replace function public.hr_mss_allowance_viewer_can_read(p_employee_user_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select auth.uid() is not null
    and public.hr_compensation_viewer_allowed('hr.compensation.allowance.view', public.hr_manager_actor_company())
    and public.hr_manager_is_direct_report(auth.uid(), p_employee_user_id)
$$;
revoke all on function public.hr_mss_allowance_viewer_can_read(uuid) from public, anon;
grant execute on function public.hr_mss_allowance_viewer_can_read(uuid) to authenticated;

drop policy if exists hr_mss_compensation_salary_view on public.hr_employee_compensation;
create policy hr_mss_compensation_salary_view on public.hr_employee_compensation
for select to authenticated
using (public.hr_mss_salary_viewer_can_read(employee_id));

drop policy if exists hr_mss_compensation_allowance_view on public.hr_employee_allowances;
create policy hr_mss_compensation_allowance_view on public.hr_employee_allowances
for select to authenticated
using (public.hr_mss_allowance_viewer_can_read(employee_id));

do $post$
begin
  if not has_function_privilege('authenticated', 'public.hr_mss_salary_viewer_can_read(uuid)', 'EXECUTE') then
    raise exception 'postcondition: salary predicate must be callable by authenticated (RLS)';
  end if;
  if not has_function_privilege('authenticated', 'public.hr_mss_allowance_viewer_can_read(uuid)', 'EXECUTE') then
    raise exception 'postcondition: allowance predicate must be callable by authenticated (RLS)';
  end if;
  if has_function_privilege('authenticated', 'public.hr_manager_is_direct_report(uuid,uuid)', 'EXECUTE') then
    raise exception 'postcondition: the direct-report helper must stay service-role only';
  end if;
end $post$;
