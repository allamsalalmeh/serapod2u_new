-- ============================================================================
-- Security & Access — standard Group Policies for Staff Sales Commission
--
-- NOT APPLIED. Apply after 20261102110000_hr_commission_core.sql. Validated only on a throwaway PostgreSQL 17.
--
-- Three standard policies, published and assigned to NO ONE (an administrator grants them explicitly):
--   commission-administrator  "Commission Administrator"  hr.commission.view + hr.commission.manage
--       HR maintains Business Units, settings and employee rates (as pending requests), calculates cycles and requests
--       adjustments. Cannot approve anything.
--   commission-approver       "Commission Approver"       hr.commission.view + hr.commission.approve
--       Management/Finance approve rate changes, adjustments and cycles; lock; mark Payroll Ready. Maker-checker is
--       also enforced per document by the database (the requester, calculator or submitter never approves, and nobody
--       approves their own rate or adjustment), so even a holder of both policies cannot approve their own work.
--   commission-report-viewer  "Commission Report Viewer"  reporting.commission.view + reporting.commission.export
--
-- HR & Payroll Full Access is NOT extended. Its holders already see salaries, but commission is new compensation data
-- and the brief requires explicit evaluation before any administrator gains it. To extend it deliberately, run:
--   select public.sa_extend_standard_policy('hr-payroll-full-access',
--     array['hr.commission.view','hr.commission.manage','hr.commission.approve'],
--     'HR & Payroll Full Access covers Staff Sales Commission (approved by <name>, <date>)');
-- (the function audits the change for every current holder and refuses SoD conflicts).
-- Root Access (owner-only Full System Admin) holds every active permission by design, including these.
--
-- Repeat-safe. Rollback (only while unassigned): delete the three roles' coverage, permission rows and the roles.
-- ============================================================================

do $pre$
begin
  if (select count(*) from public.sa_permissions where permission_key = any(public.hr_commission_permission_keys()) and status = 'active') <> 5 then
    raise exception 'hr_commission_prerequisite_missing: apply 20261102110000_hr_commission_core.sql first';
  end if;
  if to_regclass('public.sa_standard_policy_coverage') is null then
    raise exception 'sa_prerequisite_missing: apply 20261009100000_sa_group_policies_full_access.sql first';
  end if;
end $pre$;

do $seed$
declare
  v_defs constant jsonb := jsonb_build_array(
    jsonb_build_object('key', 'commission-administrator', 'name', 'Commission Administrator', 'module', 'hr_payroll', 'prefixes', jsonb_build_array('hr'),
      'perms', jsonb_build_array('hr.commission.manage', 'hr.commission.view'),
      'description', 'Maintain commission Business Units, cycle settings and employee commission rates (submitted for approval), calculate commission cycles and request adjustments. Cannot approve rates, adjustments or cycles.'),
    jsonb_build_object('key', 'commission-approver', 'name', 'Commission Approver', 'module', 'hr_payroll', 'prefixes', jsonb_build_array('hr'),
      'perms', jsonb_build_array('hr.commission.approve', 'hr.commission.view'),
      'description', 'Approve or reject employee commission rate changes and adjustments, approve, return and lock commission cycles and mark them Payroll Ready. Never approves work they requested, calculated or submitted, or their own commission.'),
    jsonb_build_object('key', 'commission-report-viewer', 'name', 'Commission Report Viewer', 'module', 'reporting', 'prefixes', jsonb_build_array('reporting'),
      'perms', jsonb_build_array('reporting.commission.export', 'reporting.commission.view'),
      'description', 'View Commission Reporting (eligible sales, employee commission, adjustments and source orders) and export it to PDF and Excel. Read only.'));
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
             where b.role_key in ('commission-administrator','commission-approver','commission-report-viewer')) then
    raise exception 'postcondition: commission policies must not be assigned by a migration';
  end if;
  if exists (select 1 from public.sa_business_role_permissions rp join public.sa_business_roles b on b.id = rp.role_id
             join public.sa_permissions p on p.id = rp.permission_id
             where b.role_key = 'commission-administrator' and p.permission_key = 'hr.commission.approve') then
    raise exception 'postcondition: Commission Administrator must not approve';
  end if;
  if exists (select 1 from public.sa_business_role_permissions rp join public.sa_business_roles b on b.id = rp.role_id
             join public.sa_permissions p on p.id = rp.permission_id
             where b.role_key = 'commission-approver' and p.permission_key = 'hr.commission.manage') then
    raise exception 'postcondition: Commission Approver must not manage';
  end if;
end $post$;
