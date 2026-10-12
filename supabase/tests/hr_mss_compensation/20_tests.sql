-- Manager Self-Service / Compensation Viewer scenarios. Each block raises 'ASSERTION FAILED: …' on the first wrong result.
\set ON_ERROR_STOP 1

-- ── 1. Permissions: exactly the 8 keys, sensitive, no legacy audience ─────────────────────────
do $t$
declare a text[];
begin
  select array_agg(permission_key order by permission_key) into a from public.sa_permissions
    where permission_key like 'hr.mss.%' or permission_key in ('hr.compensation.salary_view','hr.compensation.allowance_view');
  perform hmt.expect(a = array['hr.compensation.allowance_view','hr.compensation.salary_view','hr.mss.attendance_view','hr.mss.leave_approve','hr.mss.leave_view','hr.mss.performance_view','hr.mss.requests_view','hr.mss.team_view'], 'the 8 permissions are seeded: ' || coalesce(a::text, '{}'));
  perform hmt.expect(not exists (select 1 from public.sa_permissions p where (p.permission_key like 'hr.mss.%' or p.permission_key in ('hr.compensation.salary_view','hr.compensation.allowance_view')) and p.audit_sensitivity <> 'security_sensitive'), 'all security-sensitive');
  perform hmt.expect(not exists (select 1 from public.sa_legacy_compat_rules c where (c.permission_key like 'hr.mss.%' or c.permission_key in ('hr.compensation.salary_view','hr.compensation.allowance_view')) and (c.max_role_level is not null or c.role_codes <> '{}' or c.legacy_permissions <> '{}' or c.employee_baseline)), 'compat rule = nobody');
  raise notice 'PASS 1 permissions seeded, sensitive, no legacy audience';
end $t$;

-- ── 2. Standard policies: seeded once, correct permissions, assigned to NO ONE ────────────────
do $t$
begin
  perform hmt.expect((select count(*) from public.sa_business_roles where role_key in ('manager-self-service','manager-compensation-viewer') and source = 'template' and status = 'active') = 2, 'two standard policies');
  perform hmt.expect((select count(*) from public.sa_role_assignments a join public.sa_business_roles b on b.id = a.role_id where b.role_key in ('manager-self-service','manager-compensation-viewer')) = 0, 'assigned to no one');
  perform hmt.expect((select permission_keys from public.sa_standard_policy_coverage where role_key = 'manager-self-service')
                     = array['hr.mss.attendance_view','hr.mss.leave_approve','hr.mss.leave_view','hr.mss.performance_view','hr.mss.requests_view','hr.mss.team_view'], 'MSS coverage');
  perform hmt.expect((select permission_keys from public.sa_standard_policy_coverage where role_key = 'manager-compensation-viewer')
                     = array['hr.compensation.allowance_view','hr.compensation.salary_view'], 'viewer coverage');
  raise notice 'PASS 2 standard policies seeded and unassigned';
end $t$;

-- ── 3. Permission-key helpers ────────────────────────────────────────────────────────────────
do $t$
begin
  perform hmt.expect(public.hr_mss_permission_keys() = array['hr.mss.team_view','hr.mss.attendance_view','hr.mss.leave_view','hr.mss.leave_approve','hr.mss.performance_view','hr.mss.requests_view'], 'hr_mss_permission_keys');
  perform hmt.expect(public.hr_compensation_viewer_permission_keys() = array['hr.compensation.salary_view','hr.compensation.allowance_view'], 'hr_compensation_viewer_permission_keys');
  raise notice 'PASS 3 permission-key helpers';
end $t$;

-- ── 4. Direct-report scope (the data scope, independent of the permission) ───────────────────
do $t$
begin
  perform hmt.expect(public.hr_manager_is_direct_report(hmt.u(1), hmt.u(2)), 'u2 reports to u1');
  perform hmt.expect(public.hr_manager_is_direct_report(hmt.u(1), hmt.u(3)), 'u3 reports to u1');
  perform hmt.expect(not public.hr_manager_is_direct_report(hmt.u(1), hmt.u(4)), 'u4 does not report to u1');
  perform hmt.expect(not public.hr_manager_is_direct_report(hmt.u(1), hmt.u(6)), 'a resigned employee is not an active direct report');
  perform hmt.expect(not public.hr_manager_is_direct_report(hmt.u(1), hmt.u(1)), 'a manager is never their own direct report');
  perform hmt.expect(not public.hr_manager_is_direct_report(hmt.u(1), hmt.u(8)), 'cross-company: u8 is in another company');
  perform hmt.expect(public.hr_manager_is_direct_report(hmt.u(7), hmt.u(8)), 'u8 reports to u7 in its own company');
  raise notice 'PASS 4 direct-report scope';
end $t$;

-- ── 5. Helper functions are not callable by API roles ───────────────────────────────────────
do $t$
begin
  perform hmt.expect(not has_function_privilege('authenticated', 'public.hr_manager_is_direct_report(uuid,uuid)', 'EXECUTE'), 'direct-report helper not authenticated-callable');
  perform hmt.expect(not has_function_privilege('authenticated', 'public.hr_mss_require(text,uuid,text)', 'EXECUTE'), 'hr_mss_require not authenticated-callable');
  perform hmt.expect(not has_function_privilege('authenticated', 'public.hr_compensation_viewer_require(text,uuid,text)', 'EXECUTE'), 'hr_compensation_viewer_require not authenticated-callable');
  raise notice 'PASS 5 helpers service-role only';
end $t$;

-- ── 6. Unknown permission keys are refused by the allowed() helpers ─────────────────────────
do $t$
begin
  perform hmt.expect(not public.hr_mss_allowed('hr.compensation.salary_view', hmt.o(1)), 'an MSS helper refuses a compensation-viewer key');
  perform hmt.expect(not public.hr_compensation_viewer_allowed('hr.mss.team_view', hmt.o(1)), 'a viewer helper refuses an MSS key');
  perform hmt.expect(not public.hr_mss_allowed('hr.mss.nope', hmt.o(1)), 'unknown key refused');
  raise notice 'PASS 6 allowed() key boundaries';
end $t$;

-- ── 7. Column-level field restrictions: direct PostgREST cannot read prohibited columns ──────
do $t$
begin
  perform hmt.expect(not has_column_privilege('authenticated', 'public.hr_employee_compensation', 'hourly_rate', 'SELECT'), 'hourly_rate revoked from authenticated');
  perform hmt.expect(not has_column_privilege('authenticated', 'public.hr_employee_compensation', 'salary_band_id', 'SELECT'), 'salary_band_id revoked');
  perform hmt.expect(not has_column_privilege('authenticated', 'public.hr_employee_compensation', 'pay_type', 'SELECT'), 'pay_type revoked');
  perform hmt.expect(not has_column_privilege('authenticated', 'public.hr_employee_compensation', 'ot_eligible', 'SELECT'), 'ot_eligible revoked');
  perform hmt.expect(not has_column_privilege('authenticated', 'public.hr_employee_compensation', 'notes', 'SELECT'), 'compensation notes revoked');
  perform hmt.expect(not has_column_privilege('authenticated', 'public.hr_employee_allowances', 'notes', 'SELECT'), 'allowance notes revoked');
  perform hmt.expect(has_column_privilege('authenticated', 'public.hr_employee_compensation', 'basic_salary', 'SELECT'), 'basic_salary still readable');
  perform hmt.expect(has_column_privilege('authenticated', 'public.hr_employee_allowances', 'amount', 'SELECT'), 'amount still readable');
  perform hmt.expect(has_table_privilege('service_role', 'public.hr_employee_compensation', 'SELECT'), 'service_role keeps full SELECT');
  raise notice 'PASS 7 column-level field restrictions';
end $t$;
