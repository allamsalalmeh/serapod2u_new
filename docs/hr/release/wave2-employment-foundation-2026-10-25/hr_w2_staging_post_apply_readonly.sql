-- Serapod2U HR Wave 2 — post-apply verification of 20261221100000_hr_employment_foundation.sql (READ ONLY).
-- psql only. Run on STAGING after the owner applied the migration:
--   PGOPTIONS='-c default_transaction_read_only=on' psql "<staging>" -X -v ON_ERROR_STOP=0 -f hr_w2_staging_post_apply_readonly.sql > w2_post_apply_<date>.txt 2>&1
-- Aggregates only (no names, no statutory values, no salary amounts). Ends with ROLLBACK.
\set ON_ERROR_ROLLBACK on
begin transaction read only;
set local statement_timeout = '60s';
set local lock_timeout = '3s';

\echo === 0. ENVIRONMENT
select current_database() as db, now() as checked_at, current_setting('server_version') as server_version,
       current_setting('transaction_read_only') as read_only, current_user as role;

\echo === 1. FUNCTIONS (expected: all present; definer = t except the append-only trigger function)
select f.fn, p.oid is not null as present, coalesce(p.prosecdef, false) as security_definer,
       coalesce(has_function_privilege('authenticated', p.oid, 'execute'), false) as authenticated_exec,
       coalesce(has_function_privilege('service_role', p.oid, 'execute'), false) as service_role_exec
from (values ('hr_employees_record_version()'), ('hr_employees_lifecycle_guard()'), ('hr_employees_end_effects()'),
             ('hr_employees_purge_versions()'), ('hr_history_append_only()'), ('hr_manager_assignment_error(uuid,uuid,uuid)'),
             ('hr_actor_has_explicit(uuid,text,jsonb)'), ('hr_assert_hr_manage(uuid,uuid)'), ('hr_reporting_line_review(uuid)'),
             ('hr_reporting_line_review_for(uuid,uuid)'), ('hr_set_reporting_line(uuid,uuid,uuid,text)'),
             ('hr_reassign_direct_reports(uuid,uuid,uuid,text,uuid[])'), ('hr_employment_change(uuid,uuid,jsonb,date,text)'),
             ('hr_employee_history(uuid,uuid)'), ('hr_employee_as_of(uuid,date)'), ('hr_statutory_profile_get(uuid,uuid)'),
             ('hr_statutory_profile_save(uuid,uuid,jsonb,text)'), ('hr_employee_profile_get(uuid,uuid)'),
             ('hr_employee_profile_save(uuid,uuid,jsonb,jsonb,text)'), ('hr_employee_compensation_no_overlap()'),
             ('hr_employee_compensation_log()'), ('hr_statutory_profiles_log()'), ('hr_employee_profiles_log()')) f(fn)
left join pg_proc p on p.oid = to_regprocedure('public.' || f.fn);

\echo === 2. TRIGGERS (expected: enabled O)
select c.relname as tbl, t.tgname, t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid
where not t.tgisinternal and t.tgname in ('hr_employees_lifecycle_guard','hr_employees_record_version','hr_employees_end_effects',
  'hr_employees_purge_versions','hr_employee_compensation_no_overlap','hr_employee_compensation_log','hr_statutory_profiles_log',
  'hr_employee_profiles_log','hr_employee_versions_append_only','hr_employee_versions_no_truncate','hr_reporting_line_changes_append_only',
  'hr_compensation_change_log_append_only','hr_statutory_profile_changes_append_only')
order by 1, 2;

\echo === 3. SEALED TABLES (expected: rls on + forced; anon/authenticated no privileges)
select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
       has_table_privilege('anon', c.oid, 'select') as anon_select, has_table_privilege('authenticated', c.oid, 'select') as auth_select,
       has_table_privilege('authenticated', c.oid, 'insert') as auth_insert, has_table_privilege('service_role', c.oid, 'select') as svc_select
from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
where c.relname in ('hr_employee_versions','hr_reporting_line_changes','hr_compensation_change_log','hr_employee_statutory_profiles',
                    'hr_statutory_profile_changes','hr_employee_profiles','hr_employment_finance_contract_v1')
order by 1;

\echo === 4. HISTORY BASELINE (expected: employments_without_version = 0)
select (select count(*) from public.hr_employees) as employments,
       (select count(*) from public.hr_employees e where not exists (select 1 from public.hr_employee_versions v where v.employment_ref = e.id)) as employments_without_version,
       (select count(*) from public.hr_employee_versions) as versions,
       (select count(*) from public.hr_employee_versions where change_kind = 'baseline') as baselines;
select change_kind, count(*) from public.hr_employee_versions group by 1 order by 1;

\echo === 5. RESET SCOPE (expected: 6 rows, action keep)
select table_name, category, action from public.hr_reset_scope
where table_name in ('hr_employee_versions','hr_reporting_line_changes','hr_compensation_change_log','hr_employee_statutory_profiles',
                     'hr_statutory_profile_changes','hr_employee_profiles') order by 1;

\echo === 6. COMPENSATION INTEGRITY (expected: overlapping = 0; constraint validated = t)
select count(*) as employees_with_overlapping_active_compensation from (
  select a.employee_id from public.hr_employee_compensation a join public.hr_employee_compensation b
    on b.employee_id = a.employee_id and b.id > a.id and a.status = 'active' and b.status = 'active'
   and a.effective_date <= coalesce(b.end_date, 'infinity'::date) and b.effective_date <= coalesce(a.end_date, 'infinity'::date)
  group by a.employee_id) x;
select conname, convalidated from pg_constraint where conname = 'hr_emp_comp_dates_chk';

\echo === 7. REPORTING-LINE FINDINGS per organization (aggregate; names not printed)
select o.org_code, r.issue_code, count(*) as employees
from public.organizations o cross join lateral public.hr_reporting_line_review(o.id) r
where exists (select 1 from public.hr_employees e where e.organization_id = o.id and e.onboarding_status = 'completed')
group by 1, 2 order by 1, 2;

\echo === 8. EXPLICIT HR AUTHORITY COVERAGE for the new entry points (hr.employee.manage / view) — counts only
select p.permission_key,
       count(distinct a.user_id) filter (where br.source <> 'legacy') as holders_explicit,
       count(distinct a.user_id) filter (where br.source = 'legacy') as holders_legacy_compat
from public.sa_permissions p
join public.sa_business_role_permissions bp on bp.permission_id = p.id
join public.sa_business_roles br on br.id = bp.role_id and br.status = 'active'
join public.sa_role_assignments a on a.role_id = br.id and a.status = 'active'
where p.permission_key in ('hr.employee.manage','hr.employee.view')
group by 1 order by 1;
select count(*) as active_root_access_grants from public.sa_root_access_grants where status = 'active';

\echo === 9. B2A STILL INTACT (expected: 6 b2a policies, guard enabled)
select count(*) filter (where policyname like '%\_b2a\_%') as b2a_policies, count(*) filter (where policyname not like '%\_b2a\_%') as other
from pg_policies where tablename in ('hr_leave_requests','hr_leave_approvals','hr_leave_balances');
select tgname, tgenabled from pg_trigger where tgname in ('hr_leave_requests_guard','hr_leave_requests_record_event');

\echo === END (rolled back)
rollback;
