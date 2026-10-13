-- After 20261110100000 (applied twice). Triggers on.

-- 1. Full Access no longer holds destructive operations; nothing else removed
select pht.expect(not ('finance.data.reset' = any(pht.perms('finance-full-access'))), 'Finance Full Access: finance.data.reset removed');
select pht.expect(cardinality(pht.perms('finance-full-access')) = 12 and 'finance.payment.approve' = any(pht.perms('finance-full-access')), 'Finance Full Access keeps its other 12 permissions');
select pht.expect(not (pht.perms('platform-settings-full-access') && array['platform.data.destructive','platform.identity.delete']), 'Platform Full Access: destructive + identity delete removed');
select pht.expect(cardinality(pht.perms('platform-settings-full-access')) = 9, 'Platform Full Access keeps its other 9 permissions');
select pht.expect(not ('hr.data.reset' = any(pht.perms('hr-payroll-full-access'))) and cardinality(pht.perms('hr-payroll-full-access')) = 25, 'HR Full Access: only hr.data.reset removed (25 left)');
select pht.expect((select excluded_keys from public.sa_standard_policy_coverage where role_key = 'platform-settings-full-access')
  = array['platform.data.destructive','platform.identity.delete'], 'coverage records the reviewed exclusion');
select pht.expect(not exists (select 1 from public.sa_standard_policy_drift() d
  where d.catalogue_not_covered && array['hr.data.reset','finance.data.reset','platform.data.destructive','platform.identity.delete']
    and d.role_key like '%-full-access'), 'drift no longer reports the excluded keys');
select pht.expect((select live_not_recorded = '{}' and recorded_not_live = '{}' from public.sa_standard_policy_drift() where role_key = 'finance-full-access'),
  'Finance Full Access: live mapping equals the coverage record');

-- 2. Existing holders keep the destructive permission through the break-glass policy
select pht.expect((pht.assignment(1, 'finance-data-reset-administrator')).id is not null, 'user 1 received Finance Data Reset Administrator');
select pht.expect((pht.assignment(1, 'finance-data-reset-administrator')).effective_until = (pht.assignment(1, 'finance-full-access')).effective_until
  and (pht.assignment(1, 'finance-data-reset-administrator')).membership_id = (pht.assignment(1, 'finance-full-access')).membership_id,
  'user 1: same membership and same end date as the Full Access grant');
select pht.expect((select array_agg(scope_id) from public.sa_assignment_scopes where assignment_id = (pht.assignment(1, 'finance-data-reset-administrator')).id)
  = (select array_agg(scope_id) from public.sa_assignment_scopes where assignment_id = (pht.assignment(1, 'finance-full-access')).id), 'user 1: same scopes');
select pht.expect(pht.has(1, 'finance.data.reset') and pht.has(1, 'finance.payment.approve'), 'user 1 still resets finance and still approves payments');
select pht.expect(pht.has(2, 'platform.data.destructive') and pht.has(2, 'platform.identity.delete') and pht.has(2, 'platform.user.manage'),
  'user 2 keeps destructive maintenance, identity archiving and the rest of Platform Full Access');
select pht.expect((select count(*) from public.sa_role_assignments a join public.sa_business_roles b on b.id = a.role_id
  where a.user_id = pht.u(2) and b.role_key = 'platform-data-maintenance-administrator') = 1, 'user 2: one break-glass assignment for two keys');
select pht.expect(pht.has(3, 'hr.data.reset') and (pht.assignment(3, 'hr-data-reset-administrator')).id is not null, 'user 3 keeps hr.data.reset through HR Data Reset Administrator');
select pht.expect((pht.assignment(4, 'platform-data-maintenance-administrator')).id is null, 'revoked Full Access grant (user 4) receives nothing');
select pht.expect((select count(*) from public.sa_role_assignments a join public.sa_business_roles b on b.id = a.role_id
  where a.user_id = pht.u(5) and b.role_key = 'finance-data-reset-administrator') = 0, 'expired Full Access grant (user 5) receives nothing');
select pht.expect(pht.has(10, 'finance.data.reset'), 'user 10 (second Finance Full Access holder) keeps finance.data.reset');
select pht.expect((select count(*) from public.sa_access_change_log where action = 'assignment.granted' and details ? 'transferred_from') = 4,
  'four transfers audited (users 1, 2, 3, 10), each with transferred_from');

-- 3. Narrowing is audited; a Full Access grant made now has no destructive permission
select pht.expect(pht.audit('access_profile.standard_narrowed') = 3, 'three standard_narrowed audit rows');
select pht.expect((select count(*) from public.sa_access_change_log where action = 'assignment.profile_changed' and details -> 'removed' ? 'finance.data.reset') = 2,
  'per-holder profile_changed rows for both Finance Full Access holders');
insert into public.sa_role_assignments(user_id, role_id, membership_id, status, source, assignment_reason)
values (pht.u(9), (select id from public.sa_business_roles where role_key = 'finance-full-access'), pht.u(109), 'active', 'manual', 'ph test after');
insert into public.sa_assignment_scopes(assignment_id, scope_id) values ((pht.assignment(9, 'finance-full-access')).id, pht.o(101));
select pht.expect(pht.has(9, 'finance.payment.approve') and not pht.has(9, 'finance.data.reset'), 'new Finance Full Access holder approves payments but cannot reset');

-- 4. New Standard Policies
select pht.expect((select string_agg(role_key || '=' || array_to_string(applicable_org_types, '+'), ',' order by role_key) from public.sa_business_roles
  where role_key in ('finance-data-reset-administrator','platform-data-maintenance-administrator','warehouse-receiving-dispatch',
                     'hr-leave-attendance-administrator','hr-records-officer','reporting-viewer') and source = 'template' and status = 'active')
  = 'finance-data-reset-administrator=HQ,hr-leave-attendance-administrator=HQ,hr-records-officer=HQ,platform-data-maintenance-administrator=HQ,reporting-viewer=HQ,warehouse-receiving-dispatch=HQ+WH',
  'six active standard policies with their organization types');
select pht.expect(pht.perms('warehouse-receiving-dispatch') = array['inventory.stock.view','supply_chain.document.acknowledge','supply_chain.order.view','warehouse.receipt.post','warehouse.shipment.manage'], 'Warehouse Receiving & Dispatch permissions');
select pht.expect(pht.perms('hr-leave-attendance-administrator') = array['hr.attendance.manage','hr.employee.view','hr.expense.manage','hr.leave.approve','hr.module.view'], 'Leave & Attendance Administrator permissions');
select pht.expect(pht.perms('hr-records-officer') = array['hr.contract.manage','hr.contract.view','hr.employee.manage','hr.employee.view','hr.module.view','hr.onboarding.manage','hr.recruitment.manage'], 'Records Officer permissions');
select pht.expect(pht.perms('reporting-viewer') = array['reporting.analytics.view'], 'Reporting Viewer permission');
select pht.expect((select count(*) from public.sa_standard_policy_coverage where role_key in ('finance-data-reset-administrator','platform-data-maintenance-administrator',
  'warehouse-receiving-dispatch','hr-leave-attendance-administrator','hr-records-officer','reporting-viewer','hr-data-reset-administrator')) = 7, 'coverage recorded for the new policies and HR Data Reset Administrator');
select pht.expect(pht.try($$insert into public.sa_role_assignments(user_id, role_id, membership_id, status, source, assignment_reason)
  values (pht.u(8), (select id from public.sa_business_roles where role_key = 'warehouse-receiving-dispatch'), pht.u(108), 'active', 'manual', 'ph wh')$$) is null,
  'Warehouse Receiving & Dispatch is grantable to a warehouse membership');
select pht.expect(pht.try($$insert into public.sa_role_assignments(user_id, role_id, membership_id, status, source, assignment_reason)
  values (pht.u(8), (select id from public.sa_business_roles where role_key = 'hr-records-officer'), pht.u(108), 'active', 'manual', 'ph wh')$$) like '%eligib%',
  'HR Records Officer is refused for a warehouse membership (eligibility guard)');
insert into public.sa_assignment_scopes(assignment_id, scope_id) values ((pht.assignment(8, 'warehouse-receiving-dispatch')).id, pht.o(102));
select pht.expect(pht.has(8, 'warehouse.receipt.post', 2) and pht.has(8, 'warehouse.shipment.manage', 2) and not pht.has(8, 'inventory.adjustment.post', 2),
  'warehouse staff receive and ship in their warehouse, and cannot adjust stock');
insert into public.sa_role_assignments(user_id, role_id, membership_id, status, source, assignment_reason)
values (pht.u(9), (select id from public.sa_business_roles where role_key = 'hr-leave-attendance-administrator'), pht.u(109), 'active', 'manual', 'ph hr');
insert into public.sa_assignment_scopes(assignment_id, scope_id) values ((pht.assignment(9, 'hr-leave-attendance-administrator')).id, pht.o(101));
select pht.expect(pht.has(9, 'hr.leave.approve') and pht.has(9, 'hr.attendance.manage') and not pht.has(9, 'hr.payroll.view') and not pht.has(9, 'hr.employee.manage'),
  'Leave & Attendance Administrator: leave and attendance only');

-- 5. Maker/checker now enforces (approve own run / own request refused; another person allowed)
select pht.expect(pht.try($$select public.sa_enforce_same_document_sod('payroll-prepare-approve', 'run-1', pht.u(6), array[pht.u(6)])$$) like '42501 sod_violation%',
  'approving one''s own payroll run is refused');
select pht.expect(pht.try($$select public.sa_enforce_same_document_sod('payroll-prepare-approve', 'run-2', pht.u(6), array[pht.u(3)])$$) is null,
  'approving someone else''s payroll run is allowed');
select pht.expect(pht.try($$select public.sa_enforce_same_document_sod('payment-request-maker-checker', 'pr-1', pht.u(7), array[pht.u(7)])$$) like '42501 sod_violation%',
  'approving one''s own payment request is refused');
select pht.expect(pht.audit('sod.rule_enforcement_changed') = 2, 'two SoD enforcement changes audited once (not again on re-run)');
select pht.expect(pht.has(6, 'hr.payroll.prepare') and pht.has(6, 'hr.payroll.approve'), 'holding both payroll permissions is still allowed');

-- 6. Supporting reads and safety
select pht.expect((select count(*) from public.sa_permission_dependencies) = 14, 'declared supporting reads: 3 order + 11 new');
select pht.expect((select count(*) from public.sa_standard_policy_dependency_gaps()) = 0, 'no standard policy lacks a declared supporting read');
select pht.expect(not has_function_privilege('authenticated', 'public.sa_narrow_standard_policy(text,text[],text)', 'execute')
  and not has_function_privilege('service_role', 'public.sa_narrow_standard_policy(text,text[],text)', 'execute'), 'narrowing is owner-only');
select pht.expect(pht.try($$select public.sa_narrow_standard_policy('finance-full-access', array['finance.ledger.view'], 'short')$$) like '%sa_reason_required%', 'narrowing requires a reason');
select pht.expect((select count(*) from public.sa_migration_modes where permission_key in ('hr.data.reset','finance.data.reset','platform.data.destructive','platform.identity.delete') and mode = 'LEGACY_RETIRED') = 4,
  'migration modes unchanged (destructive keys stay Legacy Retired)');
select pht.expect(pht.perms('legacy-sa') @> array['finance.data.reset'], 'compatibility roles untouched (reported separately)');
