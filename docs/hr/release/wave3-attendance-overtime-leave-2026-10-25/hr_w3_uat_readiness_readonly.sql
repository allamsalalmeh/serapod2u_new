-- ============================================================================
-- Serapod2U HR — Wave 3 localhost-UAT readiness (READ-ONLY, owner-run, STAGING). Prepared 2026-10-26.
-- Answers: which existing (non-legacy) S&A policies carry the permissions the Wave 3 UAT needs, and which HR
-- configuration exists (leave types, shifts, policy, holidays, onboarded employees). Aggregates and catalogue rows
-- only — no names, e-mails or personal data. One READ ONLY transaction, ROLLBACK. Run via kvm2_hr_w2_w3_readonly.sh
-- (section 9) or: PGOPTIONS='-c default_transaction_read_only=on' psql "<staging>" -X -v env=staging -f <this file>
-- ============================================================================
\set QUIET on
\set ON_ERROR_ROLLBACK on
\pset footer off
\if :{?env}
\else
  \echo 'ABORT: pass -v env=staging'
  \quit
\endif
begin transaction read only;
set local statement_timeout = '120s';

\echo '=== U1. NON-LEGACY ACTIVE POLICIES CARRYING THE WAVE 3 UAT PERMISSIONS (choose grants from this list) ==='
select br.role_key, br.name, br.source,
       string_agg(p.permission_key, ', ' order by p.permission_key) as wave3_permissions,
       (select count(*) from public.sa_role_assignments a where a.role_id = br.id and a.status = 'active') as active_assignments
from public.sa_business_roles br
join public.sa_business_role_permissions bp on bp.role_id = br.id
join public.sa_permissions p on p.id = bp.permission_id
where br.status = 'active' and br.source <> 'legacy'
  and p.permission_key in ('hr.attendance.manage', 'hr.leave.approve', 'hr.module.view', 'hr.self_service.use', 'hr.mss.team_view',
                           'hr.mss.attendance_view', 'hr.mss.leave_view', 'hr.mss.leave_approve', 'hr.employee.view', 'hr.employee.manage',
                           'hr.settings.manage')
group by br.id, br.role_key, br.name, br.source order by br.role_key;

\echo '=== U2. PERMISSIONS WITH NO NON-LEGACY POLICY AT ALL (expected: none of the Wave 3 keys) ==='
select k as permission_key from unnest(array['hr.attendance.manage', 'hr.leave.approve', 'hr.module.view', 'hr.self_service.use',
                                            'hr.mss.attendance_view', 'hr.mss.leave_view', 'hr.mss.leave_approve']) k
where not exists (select 1 from public.sa_permissions p join public.sa_business_role_permissions bp on bp.permission_id = p.id
                  join public.sa_business_roles br on br.id = bp.role_id and br.status = 'active' and br.source <> 'legacy'
                  where p.permission_key = k);

\echo '=== U3. MIGRATION MODES OF THE WAVE 3 KEYS (informational; Wave 3 functions always require explicit authority) ==='
select permission_key, mode from public.sa_migration_modes
where permission_key in ('hr.attendance.manage', 'hr.leave.approve', 'hr.self_service.use', 'hr.mss.attendance_view', 'hr.mss.leave_approve', 'hr.mss.leave_view')
order by 1;

\echo '=== U4. HR CONFIGURATION PER ORGANIZATION WITH ONBOARDED EMPLOYEES (counts) ==='
select o.org_code, o.org_type_code,
       (select count(*) from public.hr_employees e where e.organization_id = o.id and e.onboarding_status = 'completed' and e.status in ('active','probation')) as onboarded_active,
       (select count(*) from public.hr_employees e where e.organization_id = o.id and e.onboarding_status = 'completed' and e.manager_user_id is null) as without_manager,
       (select count(*) from public.hr_attendance_policies p where p.organization_id = o.id) as attendance_policy,
       (select count(*) from public.hr_shifts s where s.organization_id = any(public.sa_org_ancestry(o.id)) and s.is_active) as active_shifts,
       (select count(*) from public.hr_leave_types t where t.organization_id = any(public.sa_org_ancestry(o.id)) and t.status = 'active') as active_leave_types,
       (select count(*) from public.hr_leave_types t where t.organization_id = any(public.sa_org_ancestry(o.id)) and t.status <> 'active') as inactive_leave_types,
       (select count(*) from public.hr_public_holidays h where h.organization_id = any(public.sa_org_ancestry(o.id)) and extract(year from h.date) = extract(year from now())) as holidays_this_year,
       (select count(*) from public.hr_employee_statutory_profiles sp where sp.organization_id = o.id and sp.work_state is not null) as work_states_captured
from public.organizations o
where exists (select 1 from public.hr_employees e where e.organization_id = o.id and e.onboarding_status = 'completed')
order by onboarded_active desc;

\echo '=== U5. ATTENDANCE POLICY VALUES (per organization; drives lateness, open-entry and OT-cap checks) ==='
select o.org_code, p.workdays, p.timezone, p.late_after_minutes, p.early_leave_before_minutes, p.max_open_entry_hours, p.require_shift,
       p.overtime_policy_json->>'maxDailyMinutes' as ot_max_daily_minutes
from public.hr_attendance_policies p join public.organizations o on o.id = p.organization_id order by 1;

\echo '=== U6. LEAVE TYPES BY STATUS (all organizations) ==='
select status, count(*) as types, count(*) filter (where jsonb_array_length(coalesce(entitlement_tiers,'[]'::jsonb)) > 0) as with_tiers
from public.hr_leave_types group by 1 order by 1;

\echo '=== END (rolled back) ==='
rollback;
