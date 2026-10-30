-- ============================================================================
-- Serapod2U HR — Batch B0 environment verification, v2 (READ-ONLY, owner-run)
-- Prepared 2026-10-24 · branch Enhancement03 @ 1e0830c6 · supersedes v1.
--
-- HOW TO RUN (psql only — uses psql meta-commands; not for a web SQL editor):
--   psql "<connection to the APPLICATION database 'supabase'>" \
--        -v env=staging -v ON_ERROR_STOP=0 -f hr_b0_environment_readonly_v2.sql > b0_staging.txt 2>&1
--   psql "<production connection>" -v env=production ... > b0_production.txt 2>&1
--
-- SAFETY
--   * One READ ONLY transaction, ended with ROLLBACK. No CREATE/ALTER/INSERT/UPDATE/DELETE,
--     no function creation, no temp tables. Called functions: catalog/system functions only
--     (to_regclass, pg_get_functiondef, current_setting, inet_server_*, pg_control_system,
--     pg_postmaster_start_time, version) — all read-only. No application function is executed.
--   * ON_ERROR_ROLLBACK=on gives each statement an implicit savepoint: a missing object or a
--     missing privilege fails only that statement; the rest of the script still runs.
--   * lock_timeout 3 s / statement_timeout 60 s: never waits behind application locks.
--   * Output: catalog facts and aggregate counts only. No names, emails, phones, IC numbers,
--     salaries or free-text reasons are selected.
--
-- INTERPRETATION
--   * "effect_present" means the migration's characteristic objects/markers exist. It is NOT
--     proof that the whole file was applied, nor that bodies are identical to the repository.
--   * Section R prints whether the current role can see all rows. If role_sees_all = false,
--     RLS-protected counts may read 0 and the run must be repeated as the owner/bypass role.
-- ============================================================================
\set QUIET on
\set ON_ERROR_ROLLBACK on
\pset footer off
\if :{?env}
\else
  \echo 'ABORT: pass -v env=staging or -v env=production'
  \quit
\endif

begin transaction read only;
set local statement_timeout = '60s';
set local lock_timeout = '3s';

\echo '=== I. ENVIRONMENT IDENTITY (compare with PRODUCTION_MIGRATION_STATUS.md identity table) ==='
select :'env' as declared_env, current_database() as database, now() as checked_at,
       inet_server_addr() as server_addr, inet_server_port() as server_port,
       nullif(current_setting('cluster_name', true), '') as cluster_name,
       pg_postmaster_start_time() as postmaster_started, split_part(version(), ' on ', 1) as server_version;
-- Strongest fingerprint (may fail without pg_monitor/superuser; failure is harmless):
select system_identifier from pg_control_system();
-- Non-sensitive data fingerprint (should differ between staging and production):
select (select count(*) from public.organizations) as organizations,
       (select count(*) from public.users)         as users,
       (select max(created_at)::date from public.users) as newest_user_date;

\echo '=== R. ROLE AND VISIBILITY ==='
select current_user as role, r.rolsuper, r.rolbypassrls,
       (r.rolsuper or r.rolbypassrls
        or current_user = (select pg_get_userbyid(c.relowner) from pg_class c where c.oid = 'public.hr_leave_requests'::regclass)) as role_sees_all
from pg_roles r where r.rolname = current_user;
select current_setting('transaction_read_only') as transaction_read_only;   -- must be 'on'

\echo '=== A. MIGRATION EFFECT MARKERS (not complete proof) ==='
with fn as (
  select p.proname, pg_get_functiondef(p.oid) as def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
    and p.proname in ('hr_employee_registration_execute', 'identity_deletion_execute', 'identity_archive_execute',
                      'identity_resolve', 'identity_release_identifiers', 'sa_legacy_compat_overview',
                      'sa_retire_legacy_compat_role', 'sa_legacy_preview_version', 'sa_org_create_context')
)
select m.migration, m.marker,
       case m.kind
         when 'table' then to_regclass(m.object) is not null
         when 'fn'    then exists (select 1 from fn where fn.proname = m.object)
         when 'body'  then exists (select 1 from fn where fn.proname = m.object and fn.def like '%' || m.needle || '%')
       end as effect_present
from (values
  ('20261214100000 hr_employee_controlled_delete', 'fn hr_employee_registration_execute',  'fn',    'hr_employee_registration_execute', null),
  ('20261214100000 hr_employee_controlled_delete', 'table hr_employee_registration_actions','table', 'public.hr_employee_registration_actions', null),
  ('20261216100000 identity_permanent_deletion',   'fn identity_deletion_execute',          'fn',    'identity_deletion_execute', null),
  ('20261216100000 identity_permanent_deletion',   'table identity_deletion_requests',      'table', 'public.identity_deletion_requests', null),
  ('20261217100000 identity_archive_release',      'table identity_lifecycle_actions',      'table', 'public.identity_lifecycle_actions', null),
  ('20261217100000 identity_archive_release',      'table identity_identifier_releases',    'table', 'public.identity_identifier_releases', null),
  ('20261217100000 identity_archive_release',      'fn identity_release_identifiers',       'fn',    'identity_release_identifiers', null),
  ('20261217100000 identity_archive_release',      'body identity_resolve: PREVIOUSLY_RELEASED', 'body', 'identity_resolve', 'IDENTITY_PREVIOUSLY_RELEASED'),
  ('20261218100000 identity_archive_optional_reason','body archive: optional-reason note', 'body', 'identity_archive_execute', 'no administrator reason recorded'),
  ('20261215110000 sa_legacy_compat_cutover',      'fn sa_retire_legacy_compat_role',       'fn',    'sa_retire_legacy_compat_role', null),
  ('20261216100000 sa_legacy_preview_scope (untracked)', 'fn sa_legacy_preview_version',    'fn',    'sa_legacy_preview_version', null),
  ('20261213100000 sa_organization_insert_gate',   'fn sa_org_create_context',              'fn',    'sa_org_create_context', null),
  ('20261022100000 core_system_preferences (untracked)', 'table core.system_preferences',  'table', 'core.system_preferences', null)
) as m(migration, marker, kind, object, needle)
order by 1, 2;

select permission_key, mode from public.sa_migration_modes
where permission_key in ('hr.employee.delete', 'security.emergency_access.grant')    -- 20261215120000 / 20261024110000 (must stay off)
order by 1;
select exists (select 1 from public.sa_enforcement_readiness where permission_key = 'hr.employee.delete') as hr_employee_delete_readiness_row;  -- 20261214100000

\echo '=== D. S&A — HR MODES, LEGACY SWITCH, SOD, COMPATIBILITY POLICIES, PARITY ==='
select mode, count(*) as hr_keys, string_agg(permission_key, ', ' order by permission_key) as keys
from public.sa_migration_modes where permission_key like 'hr.%' group by mode order by mode;

select setting_key, setting_value from public.sa_settings
where setting_key like 'legacy_authorization%' or setting_key like 'emergency_access%' order by 1;

select rule_key, enforcement, status from public.sa_sod_rules
where rule_key in ('payroll-prepare-approve', 'payroll-prepare-release', 'payment-request-maker-checker') order by 1;

select b.role_key, b.status,
       count(distinct p.permission_key) filter (where p.permission_key like 'hr.%') as hr_permissions,
       bool_or(p.permission_key = 'hr.leave.approve') as grants_leave_approve,
       (select count(*) from public.sa_role_assignments a where a.role_id = b.id and a.status = 'active') as active_assignments
from public.sa_business_roles b
left join public.sa_business_role_permissions rp on rp.role_id = b.id
left join public.sa_permissions p on p.id = rp.permission_id and p.status = 'active'
where b.source = 'legacy'
group by b.id, b.role_key, b.status order by b.role_key;

-- Holders of hr.leave.approve / hr.mss.leave_approve by source (counts of distinct users; no identities)
select p.permission_key,
       count(distinct a.user_id) filter (where b.source = 'legacy')  as holders_via_legacy_compat,
       count(distinct a.user_id) filter (where b.source <> 'legacy') as holders_via_explicit_policy
from public.sa_role_assignments a
join public.sa_business_roles b on b.id = a.role_id and b.status = 'active'
join public.sa_business_role_permissions rp on rp.role_id = b.id
join public.sa_permissions p on p.id = rp.permission_id and p.status = 'active'
where a.status = 'active' and p.permission_key in ('hr.leave.approve', 'hr.mss.leave_approve', 'hr.mss.leave_view')
  and (a.effective_until is null or a.effective_until > now())
group by p.permission_key order by 1;

-- Shadow parity for HR keys, last 30 days (direct aggregate; avoids the service-role-only helper)
select d.permission_key, max(d.migration_mode) as mode, count(*) as decisions,
       count(*) filter (where d.comparison = 'LEGACY_ALLOW_NEW_DENY') as legacy_allow_new_deny,
       count(*) filter (where d.comparison = 'LEGACY_DENY_NEW_ALLOW') as legacy_deny_new_allow,
       max(d.occurred_at) as last_seen
from public.sa_authorization_decisions d
where d.occurred_at >= now() - interval '30 days' and d.permission_key like 'hr.%'
group by d.permission_key order by 1;

\echo '=== B. LEAVE SECURITY ==='
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies where schemaname = 'public'
  and tablename in ('hr_leave_requests', 'hr_leave_balances', 'hr_leave_approvals', 'hr_leave_types')
order by tablename, cmd, policyname;

select tgrelid::regclass as table_name, tgname, tgenabled from pg_trigger
where not tgisinternal and tgrelid in (select oid from pg_class where relname in
  ('hr_leave_requests', 'hr_leave_balances', 'hr_leave_approvals', 'hr_leave_types')
  and relnamespace = 'public'::regnamespace)
order by 1, 2;

select conname, pg_get_constraintdef(oid) as definition from pg_constraint
where conrelid = 'public.hr_leave_requests'::regclass and contype = 'c' order by 1;

select status, count(*) as requests,
       count(*) filter (where approved_by = employee_id)                    as self_approved,
       count(*) filter (where status in ('approved','rejected') and approved_by is null) as decided_without_approver,
       min(created_at)::date as first_created, max(created_at)::date as last_created
from public.hr_leave_requests group by status order by status;

-- Who approved in the last 180 days, by authority category (counts only) — informs the B2A approver decision
select category, count(*) as decisions from (
  select case
    when r.approved_by = r.employee_id then 'self'
    when exists (select 1 from public.hr_employees e where e.user_id = r.employee_id
                 and e.organization_id = r.organization_id and e.manager_user_id = r.approved_by) then 'direct_manager'
    when exists (select 1 from public.sa_role_assignments a
                 join public.sa_business_roles b on b.id = a.role_id and b.status = 'active' and b.source <> 'legacy'
                 join public.sa_business_role_permissions rp on rp.role_id = b.id
                 join public.sa_permissions p on p.id = rp.permission_id and p.permission_key = 'hr.leave.approve'
                 where a.user_id = r.approved_by and a.status = 'active') then 'explicit_hr_policy'
    when exists (select 1 from public.sa_role_assignments a
                 join public.sa_business_roles b on b.id = a.role_id and b.status = 'active' and b.source = 'legacy'
                 where a.user_id = r.approved_by and a.status = 'active') then 'legacy_compat_only'
    else 'other_or_unknown' end as category
  from public.hr_leave_requests r
  where r.status in ('approved', 'rejected') and coalesce(r.approved_at, r.updated_at) >= now() - interval '180 days'
) x group by category order by category;

select count(*) as balance_rows, count(distinct employee_id) as employees_with_balances from public.hr_leave_balances;
select count(*) as approval_rows, count(*) filter (where action is null) as pending_steps,
       count(*) filter (where approver_id = (select employee_id from public.hr_leave_requests q where q.id = request_id)) as self_approval_rows
from public.hr_leave_approvals;
select status, count(*) as leave_types from public.hr_leave_types group by status order by 1;

\echo '=== C. PAYROLL SAFETY ==='
select r.status, coalesce(r.gl_status, '-') as gl_status, count(*) as runs,
       count(*) filter (where not exists (select 1 from public.hr_payroll_run_items i where i.payroll_run_id = r.id)) as runs_without_lines,
       count(*) filter (where r.approved_by is not null and r.approved_by = r.calculated_by) as approved_by_preparer
from public.hr_payroll_runs r group by 1, 2 order by 1, 2;
select count(*) as run_items from public.hr_payroll_run_items;
select count(*) as payroll_audit_rows from public.hr_payroll_audit;

select tgname, tgrelid::regclass as table_name, tgenabled from pg_trigger
where not tgisinternal and tgname in ('sa_payroll_run_transition_guard') order by 1;

select 'gl_document_postings PAYROLL_*' as path, count(*) as postings from public.gl_document_postings where document_type like 'PAYROLL%';
select 'hr_gl_postings PAYROLL_RUN' as path, count(*) as postings from public.hr_gl_postings where document_type = 'PAYROLL_RUN';
select count(*) as runs_posted_by_both_paths
from public.hr_gl_postings h join public.gl_document_postings g on g.document_id = h.document_id and g.document_type = 'PAYROLL_RUN'
where h.document_type = 'PAYROLL_RUN';

select string_agg(column_name, ', ' order by ordinal_position) as hr_settings_columns
from information_schema.columns where table_schema = 'public' and table_name = 'hr_settings';
select count(*) as hr_settings_rows from public.hr_settings;

\echo '=== E. HR DATA INTEGRITY AND VOLUMES ==='
select onboarding_status, status, count(*) as employment_records
from public.hr_employees group by 1, 2 order by 1, 2;
select phase, count(*) as organizations from public.hr_go_live_state group by phase order by 1;

select count(*) filter (where u.account_status = 'ARCHIVED' and e.status not in ('resigned','terminated')) as archived_but_employment_active,
       count(*) filter (where u.account_status = 'ARCHIVED' and e.onboarding_status = 'completed')       as archived_but_onboarded
from public.hr_employees e join public.users u on u.id = e.user_id;

select count(*) as reports_to_inactive_or_archived_manager
from public.hr_employees e join public.users m on m.id = e.manager_user_id
where m.account_status = 'ARCHIVED' or m.is_active is not true;

select count(*) as employees_without_manager_in_completed_state
from public.hr_employees where onboarding_status = 'completed' and manager_user_id is null;

select count(*) as active_primary_position_assignments
from public.hr_position_assignments where status = 'active' and assignment_type = 'PRIMARY';

select 'attendance entries' as item, count(*) as n from public.hr_attendance_entries
union all select 'timesheets', count(*) from public.hr_timesheets
union all select 'corrections pending', count(*) from public.hr_attendance_corrections where status = 'pending'
union all select 'corrections reviewed', count(*) from public.hr_attendance_corrections where status <> 'pending'
union all select 'OT requests', count(*) from public.hr_overtime_requests
union all select 'public holidays', count(*) from public.hr_public_holidays
union all select 'active compensation rows', count(*) from public.hr_employee_compensation where status = 'active'
order by 1;

select count(*) as employees_with_overlapping_active_compensation from (
  select 1 from public.hr_employee_compensation where status = 'active'
  group by organization_id, employee_id having count(*) > 1) x;

\echo '=== END (transaction will be rolled back) ==='
rollback;
