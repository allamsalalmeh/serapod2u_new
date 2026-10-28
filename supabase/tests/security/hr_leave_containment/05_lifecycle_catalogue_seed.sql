-- HR leave containment — synthetic S&A catalogue rows for the LIFECYCLE COMPATIBILITY scenario only (DISPOSABLE replica).
-- The schema snapshots carry no configuration rows; these stand in for the staging config dump so that
-- 20261214…20261218 (identity / HR lifecycle) can be applied next to B2A without contacting staging.
insert into public.sa_permissions(permission_key, module, resource, action, status, source) values
 ('hr.employee.manage','hr','employee','manage','active','new'), ('hr.employee.view','hr','employee','view','active','new'),
 ('platform.user.view','platform','user','view','active','new'), ('platform.identity.delete','platform','identity','delete','active','new'),
 ('hr.data.reset','hr','data','reset','active','new'), ('hr.leave.approve','hr','leave','approve','active','new'),
 ('hr.mss.leave_approve','hr','mss','leave_approve','active','new'), ('hr.mss.leave_view','hr','mss','leave_view','active','new')
on conflict (permission_key) do nothing;
insert into public.sa_business_roles(role_key, name, source, status) values
 ('hr-records-officer','HR Records Officer','template','active'), ('hr-payroll-full-access','HR & Payroll Full Access','template','active'),
 ('platform-data-maintenance-administrator','Platform Data Maintenance Administrator','template','active'),
 ('hr-leave-attendance-administrator','Leave & Attendance Administrator','template','active'), ('manager-self-service','Manager Self-Service','template','active'),
 ('legacy-hq','Legacy HQ compatibility','legacy','active'), ('hr-data-reset-administrator','HR Data Reset Administrator','template','active')
on conflict (role_key) do nothing;
insert into public.sa_business_role_permissions(role_id, permission_id)
select r.id, p.id from (values
  ('hr-records-officer','hr.employee.manage'), ('hr-records-officer','hr.employee.view'), ('hr-records-officer','platform.user.view'),
  ('hr-payroll-full-access','hr.employee.manage'), ('hr-payroll-full-access','hr.employee.view'), ('hr-payroll-full-access','hr.leave.approve'),
  ('platform-data-maintenance-administrator','platform.identity.delete'), ('platform-data-maintenance-administrator','platform.user.view'),
  ('hr-leave-attendance-administrator','hr.leave.approve'), ('manager-self-service','hr.mss.leave_approve'), ('manager-self-service','hr.mss.leave_view'),
  ('legacy-hq','hr.leave.approve'), ('legacy-hq','hr.mss.leave_approve'), ('legacy-hq','hr.mss.leave_view'), ('hr-data-reset-administrator','hr.data.reset')) v(rk, pk)
join public.sa_business_roles r on r.role_key = v.rk join public.sa_permissions p on p.permission_key = v.pk on conflict do nothing;
insert into public.sa_standard_policy_coverage(role_id, role_key, module_id, module_prefixes, permission_keys)
select id, role_key, 'hr_payroll', array['hr'], array['hr.employee.manage','hr.employee.view','hr.leave.approve'] from public.sa_business_roles
where role_key = 'hr-payroll-full-access' and not exists (select 1 from public.sa_standard_policy_coverage c where c.role_key = 'hr-payroll-full-access');
