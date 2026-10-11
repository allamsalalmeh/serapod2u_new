-- ============================================================================
-- HR — Manager Self-Service (MSS) and the restricted Manager Compensation Viewer
-- ----------------------------------------------------------------------------
-- NOT APPLIED. Review, then apply by hand per environment (staging first), after 20261102120000_hr_commission_policies.
-- Validated only on a throwaway PostgreSQL 17 (supabase/tests/hr_mss_compensation/run.sh). Creates NO business data and
-- assigns NO role to anyone. Reuses the existing Attendance, Leave, Payroll and employee master tables: nothing here
-- duplicates them.
--
-- Two new Security & Access permission families, all security_sensitive, with NO legacy audience (compatibility rule =
-- nobody). They are granted only through the two standard policies below, Root Access, or a custom policy.
--
--   Manager Self-Service (manager-self-service) — explicit grant, authorized direct reports:
--     hr.mss.team.view, hr.mss.attendance.view, hr.mss.leave.view, hr.mss.leave.approve,
--     hr.mss.performance.view, hr.mss.requests.view
--   Manager Compensation Viewer (manager-compensation-viewer) — restricted, HR/Security grant, authorized direct reports:
--     hr.compensation.salary.view, hr.compensation.allowance.view
--
-- MSS is NOT derived from a job title (Manager / Head / Supervisor): it must be granted through the existing S&A
-- assignment framework, exactly like the Commission policies. Approving leave still requires BOTH the permission and a
-- valid workflow assignment (the leave approval flow checks that independently of this migration).
--
-- Data scope is enforced separately from the action permission: a manager holding the permission can only reach their
-- CURRENT, active direct reports (hr_employees.manager_user_id = the manager). A reporting-line change or an
-- organization transfer removes the relationship and therefore the data. No compensation viewer permission reads
-- payslips, net salary, bank details, EPF/SOCSO/PCB, payroll runs, salary history, or allows any write.
--
-- Mode: NEW_ENFORCED wherever the corresponding administrative HR permission is already S&A-authoritative, otherwise
-- SHADOW (fallback = Super Admin of the company only), the same rule the Commission permissions use. No Full Access
-- policy is extended: being an HR employee alone must not imply manager or compensation access (least privilege).
--
-- Repeat-safe. Rollback (only while unassigned): delete the two roles' coverage, permission rows and the roles, then the
-- eight permissions' readiness / mode / compat rows.
-- ============================================================================

do $pre$
begin
  if to_regclass('public.sa_standard_policy_coverage') is null then
    raise exception 'sa_prerequisite_missing: apply 20261009100000_sa_group_policies_full_access.sql first';
  end if;
  if to_regprocedure('public.sa_actor_has_permission(uuid,text,jsonb)') is null
     or to_regprocedure('public.sa_is_new_authoritative(text)') is null then
    raise exception 'hr_mss_prerequisite_missing: Security & Access evaluator';
  end if;
  if to_regclass('public.hr_employees') is null or to_regclass('public.users') is null then
    raise exception 'hr_mss_prerequisite_missing: hr_employees / users';
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- 1. Permissions (lock-step with app/src/lib/security-access/mss.ts and compensation-viewer.ts)
-- ---------------------------------------------------------------------------
insert into public.sa_permissions(permission_key, module, resource, action, description, source, audit_sensitivity) values
 ('hr.mss.team.view','hr','mss','team.view','View the directory of the manager''s current, active direct reports','new','security_sensitive'),
 ('hr.mss.attendance.view','hr','mss','attendance.view','View attendance records of the manager''s authorized direct reports','new','security_sensitive'),
 ('hr.mss.leave.view','hr','mss','leave.view','View leave balance and history of the manager''s authorized direct reports','new','security_sensitive'),
 ('hr.mss.leave.approve','hr','mss','leave.approve','Approve or reject leave requests when assigned as the valid workflow approver','new','security_sensitive'),
 ('hr.mss.performance.view','hr','mss','performance.view','View performance and permitted appraisals of the manager''s authorized direct reports','new','security_sensitive'),
 ('hr.mss.requests.view','hr','mss','requests.view','View and manage team requests (attendance corrections, profile changes, documents) for authorized direct reports','new','security_sensitive'),
 ('hr.compensation.salary.view','hr','compensation','salary.view','View the basic salary of the manager''s authorized direct reports (read only)','new','security_sensitive'),
 ('hr.compensation.allowance.view','hr','compensation','allowance.view','View the authorized fixed allowances of the manager''s authorized direct reports (read only)','new','security_sensitive')
on conflict (permission_key) do nothing;


insert into public.sa_legacy_compat_rules(permission_key, max_role_level, role_codes, legacy_permissions, employee_baseline, notes)
select k, null, '{}', '{}', false, 'Manager self-service / compensation viewer: no legacy role reproduces this access; grant explicitly.'
from unnest(array['hr.mss.team.view','hr.mss.attendance.view','hr.mss.leave.view','hr.mss.leave.approve','hr.mss.performance.view','hr.mss.requests.view','hr.compensation.salary.view','hr.compensation.allowance.view']) k
on conflict (permission_key) do nothing;

insert into public.sa_migration_modes(permission_key, mode, legacy_permission_key, notes)
select k,
       case when public.sa_is_new_authoritative('hr.employee.view') then 'NEW_ENFORCED' else 'SHADOW' end,
       null,
       'Manager self-service: S&A decides wherever the employee directory is already S&A-authoritative; elsewhere Super Admin of the company only.'
from unnest(array['hr.mss.team.view','hr.mss.attendance.view','hr.mss.leave.view','hr.mss.leave.approve','hr.mss.performance.view','hr.mss.requests.view']) k
on conflict (permission_key) do nothing;

insert into public.sa_migration_modes(permission_key, mode, legacy_permission_key, notes)
select k,
       case when public.sa_is_new_authoritative('hr.compensation.view') then 'NEW_ENFORCED' else 'SHADOW' end,
       null,
       'Manager Compensation Viewer: S&A decides wherever HR compensation is already S&A-authoritative; elsewhere Super Admin of the company only.'
from unnest(array['hr.compensation.salary.view','hr.compensation.allowance.view']) k
on conflict (permission_key) do nothing;

insert into public.sa_enforcement_readiness(permission_key, route_wiring, database_backstop, intentional_tightening, notes)
select k, true, case when k like '%.view' then 'rls_gate' else 'rpc_guard' end, null,
       'MSS routes authorize through S&A and restrict reads to the caller''s current, active direct reports; leave approval additionally requires the valid workflow assignment.'
from unnest(array['hr.mss.team.view','hr.mss.attendance.view','hr.mss.leave.view','hr.mss.leave.approve','hr.mss.performance.view','hr.mss.requests.view']) k
on conflict (permission_key) do update set route_wiring = excluded.route_wiring, database_backstop = excluded.database_backstop,
  notes = excluded.notes;

insert into public.sa_enforcement_readiness(permission_key, route_wiring, database_backstop, intentional_tightening, notes)
select k, true, 'rls_gate', null,
       'Manager Compensation Viewer is read-only and restricted to the caller''s direct reports: basic salary and authorized fixed allowances only; never payslips, net salary, banking, EPF/SOCSO/PCB, deductions, runs, history or export.'
from unnest(array['hr.compensation.salary.view','hr.compensation.allowance.view']) k
on conflict (permission_key) do update set route_wiring = excluded.route_wiring, database_backstop = excluded.database_backstop,
  notes = excluded.notes;

-- ---------------------------------------------------------------------------
-- 2. Authorization helpers (SECURITY DEFINER; not callable by API roles)
-- ---------------------------------------------------------------------------
create or replace function public.hr_mss_permission_keys()
returns text[] language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array['hr.mss.team.view','hr.mss.attendance.view','hr.mss.leave.view','hr.mss.leave.approve','hr.mss.performance.view','hr.mss.requests.view']::text[]
$$;
revoke all on function public.hr_mss_permission_keys() from public, anon;
grant execute on function public.hr_mss_permission_keys() to authenticated, service_role;

create or replace function public.hr_compensation_viewer_permission_keys()
returns text[] language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array['hr.compensation.salary.view','hr.compensation.allowance.view']::text[]
$$;
revoke all on function public.hr_compensation_viewer_permission_keys() from public, anon;
grant execute on function public.hr_compensation_viewer_permission_keys() to authenticated, service_role;

-- The company (root HQ organization) of the verified caller.
create or replace function public.hr_manager_actor_company()
returns uuid language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select public.get_company_id(u.organization_id) from public.users u where u.id = auth.uid() and u.is_active is true
$$;
revoke all on function public.hr_manager_actor_company() from public, anon;
grant execute on function public.hr_manager_actor_company() to authenticated, service_role;

-- May the caller exercise an MSS permission for a company? (service role: yes; S&A-authoritative mode: the S&A decision;
-- otherwise Super Admin of that company only — the same rule as Commission).
create or replace function public.hr_mss_allowed(p_permission text, p_company uuid)
returns boolean language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare
  v_claims text := nullif(current_setting('request.jwt.claims', true), '');
  v_role text;
  v_uid uuid := auth.uid();
begin
  if not (p_permission = any(public.hr_mss_permission_keys())) then return false; end if;
  if v_claims is null then return current_user not in ('anon', 'authenticated'); end if;
  v_role := v_claims::jsonb->>'role';
  if v_role = 'service_role' then return true; end if;
  if v_uid is null or p_company is null then return false; end if;
  if public.sa_is_new_authoritative(p_permission) then
    return public.sa_actor_has_permission(v_uid, p_permission, jsonb_build_object('organization_id', p_company));
  end if;
  return exists (
    select 1 from public.users u join public.roles r on r.role_code = u.role_code
    where u.id = v_uid and u.is_active is true and r.role_level = 1 and public.get_company_id(u.organization_id) = p_company);
end
$fn$;
revoke all on function public.hr_mss_allowed(text, uuid) from public, anon;
grant execute on function public.hr_mss_allowed(text, uuid) to authenticated, service_role;

create or replace function public.hr_mss_require(p_permission text, p_company uuid, p_resource text default null)
returns void language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $fn$
begin
  if not public.hr_mss_allowed(p_permission, p_company) then
    raise exception 'sa_authorization_required' using errcode = '42501',
      detail = format('permission=%s resource=%s', p_permission, coalesce(p_resource, '-'));
  end if;
end
$fn$;
revoke all on function public.hr_mss_require(text, uuid, text) from public, anon, authenticated;


-- May the caller exercise a Manager Compensation Viewer permission for a company? Same rule as MSS.
create or replace function public.hr_compensation_viewer_allowed(p_permission text, p_company uuid)
returns boolean language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $fn$
declare
  v_claims text := nullif(current_setting('request.jwt.claims', true), '');
  v_role text;
  v_uid uuid := auth.uid();
begin
  if not (p_permission = any(public.hr_compensation_viewer_permission_keys())) then return false; end if;
  if v_claims is null then return current_user not in ('anon', 'authenticated'); end if;
  v_role := v_claims::jsonb->>'role';
  if v_role = 'service_role' then return true; end if;
  if v_uid is null or p_company is null then return false; end if;
  if public.sa_is_new_authoritative(p_permission) then
    return public.sa_actor_has_permission(v_uid, p_permission, jsonb_build_object('organization_id', p_company));
  end if;
  return exists (
    select 1 from public.users u join public.roles r on r.role_code = u.role_code
    where u.id = v_uid and u.is_active is true and r.role_level = 1 and public.get_company_id(u.organization_id) = p_company);
end
$fn$;
revoke all on function public.hr_compensation_viewer_allowed(text, uuid) from public, anon;
grant execute on function public.hr_compensation_viewer_allowed(text, uuid) to authenticated, service_role;

create or replace function public.hr_compensation_viewer_require(p_permission text, p_company uuid, p_resource text default null)
returns void language plpgsql stable security definer set search_path = pg_catalog, public, pg_temp as $fn$
begin
  if not public.hr_compensation_viewer_allowed(p_permission, p_company) then
    raise exception 'sa_authorization_required' using errcode = '42501',
      detail = format('permission=%s resource=%s', p_permission, coalesce(p_resource, '-'));
  end if;
end
$fn$;
revoke all on function public.hr_compensation_viewer_require(text, uuid, text) from public, anon, authenticated;

-- Is p_employee_user_id a CURRENT, active direct report of p_manager in the same company?
-- The effective-dated reporting relationship is the single current hr_employees.manager_user_id (the source of truth
-- projected onto users); no historical manager chain is consulted, so a reporting-line change or an organization
-- transfer removes the relationship immediately. "Active" = employment status active/probation, account active, and
-- onboarding complete.
create or replace function public.hr_manager_is_direct_report(p_manager uuid, p_employee_user_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select exists (
    select 1
    from public.hr_employees e
    join public.users m on m.id = p_manager and m.is_active is true
    join public.users t on t.id = e.user_id and t.is_active is true
    where e.manager_user_id = p_manager
      and e.user_id = p_employee_user_id
      and e.user_id is distinct from p_manager
      and e.status in ('active', 'probation')
      and coalesce(e.onboarding_status, 'completed') = 'completed'
      and e.organization_id = m.organization_id
  )
$$;
revoke all on function public.hr_manager_is_direct_report(uuid, uuid) from public, anon, authenticated;
grant execute on function public.hr_manager_is_direct_report(uuid, uuid) to service_role;


-- ---------------------------------------------------------------------------
-- 3. Standard Group Policies (assigned to NO ONE — an administrator grants them explicitly)
-- ---------------------------------------------------------------------------
do $seed$
declare
  v_defs constant jsonb := jsonb_build_array(
    jsonb_build_object('key', 'manager-self-service', 'name', 'Manager Self-Service', 'module', 'hr_payroll', 'prefixes', jsonb_build_array('hr'),
      'perms', jsonb_build_array('hr.mss.team.view', 'hr.mss.attendance.view', 'hr.mss.leave.view', 'hr.mss.leave.approve', 'hr.mss.performance.view', 'hr.mss.requests.view'),
      'description', 'View the directory, attendance, leave, performance and requests of the manager''s own, current, active direct reports, and approve or reject their leave when assigned as the valid workflow approver. Never grants access to other employees, payslips, bank details or payroll.'),
    jsonb_build_object('key', 'manager-compensation-viewer', 'name', 'Manager Compensation Viewer', 'module', 'hr_payroll', 'prefixes', jsonb_build_array('hr'),
      'perms', jsonb_build_array('hr.compensation.salary.view', 'hr.compensation.allowance.view'),
      'description', 'Read the basic salary and authorized fixed allowances of the manager''s own, current, active direct reports. Restricted, read-only, granted by HR or Security administrators only; never payslips, net salary, banking, EPF/SOCSO/PCB, deductions, payroll runs, salary history or export.'));
  d jsonb;
  v_perms text[];
  v_role uuid;
  v_existing text;
begin
  for d in select * from jsonb_array_elements(v_defs) loop
    select array_agg(x order by x) into v_perms from jsonb_array_elements_text(d->'perms') x;
    select b.source into v_existing from public.sa_business_roles b where b.role_key = d->>'key';
    if v_existing is not null and v_existing <> 'template' then
      raise exception 'sa_group_policy_key_conflict: % already exists as a non-standard role', d->>'key';
    end if;
    v_role := null;
    insert into public.sa_business_roles(role_key, name, description, source, status, applicable_account_types, applicable_org_types)
    values (d->>'key', d->>'name', d->>'description', 'template', 'active', array['internal'], array['HQ'])
    on conflict (role_key) do nothing
    returning id into v_role;
    continue when v_role is null;

    insert into public.sa_business_role_permissions(role_id, permission_id)
    select v_role, p.id from public.sa_permissions p where p.permission_key = any(v_perms) and p.status = 'active';
    if (select count(*) from public.sa_business_role_permissions where role_id = v_role) <> cardinality(v_perms) then
      raise exception 'sa_group_policy_permission_missing: % (%)', d->>'key', array_to_string(v_perms, ', ');
    end if;
    insert into public.sa_standard_policy_coverage(role_id, role_key, module_id, module_prefixes, permission_keys)
    values (v_role, d->>'key', d->>'module', array(select jsonb_array_elements_text(d->'prefixes')), v_perms);
    perform public.sa_log_access_change(null, 'access_profile.standard_seeded', null, 'sa_business_role', v_role::text,
      jsonb_build_object('role_key', d->>'key', 'module', d->>'module', 'permission_count', cardinality(v_perms)),
      'Standard ' || (d->>'name') || ' group policy seeded (not assigned to anyone)', 'system');
  end loop;
end $seed$;

do $post$
begin
  if exists (select 1 from public.sa_role_assignments a join public.sa_business_roles b on b.id = a.role_id
             where b.role_key in ('manager-self-service', 'manager-compensation-viewer')) then
    raise exception 'postcondition: MSS / Compensation Viewer policies must not be assigned by a migration';
  end if;
  if exists (select 1 from public.sa_business_role_permissions rp join public.sa_business_roles b on b.id = rp.role_id
             join public.sa_permissions p on p.id = rp.permission_id
             where b.role_key = 'manager-self-service' and p.permission_key like 'hr.compensation.%') then
    raise exception 'postcondition: Manager Self-Service must not include compensation permissions';
  end if;
  if exists (select 1 from public.sa_business_role_permissions rp join public.sa_business_roles b on b.id = rp.role_id
             join public.sa_permissions p on p.id = rp.permission_id
             where b.role_key = 'manager-compensation-viewer' and p.permission_key like 'hr.mss.%') then
    raise exception 'postcondition: Manager Compensation Viewer must not include MSS permissions';
  end if;
  if has_function_privilege('authenticated', 'public.hr_manager_is_direct_report(uuid,uuid)', 'EXECUTE') then
    raise exception 'postcondition: direct-report helper must stay service-role only';
  end if;
end $post$;
