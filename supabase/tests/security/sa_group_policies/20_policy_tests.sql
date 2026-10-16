-- Standard Full Access policies: coverage, module boundaries, protection, scoped assignment, Copy & Customize, idempotency, future additions.
-- 1. Coverage and module boundaries (explicit keys only; counts match the reviewed lists)
create temp table saf_expected(role_key text, module text, n int, prefixes text[]);
insert into saf_expected values
  ('supply-chain-full-access','Supply Chain',30,array['supply_chain','inventory','warehouse','manufacturing','product','qr']),
  ('customer-growth-full-access','Customer & Growth',23,array['customer','roadtour','ecommerce','marketing']),
  ('hr-payroll-full-access','HR & Payroll',26,array['hr']),
  ('finance-full-access','Finance',13,array['finance']),
  ('security-access-full-access','Security & Access',12,array['security']),
  ('platform-settings-full-access','Platform & Settings',10,array['platform']);
do $t$ declare e record; v_keys text[]; v_catalogue text[]; begin
  for e in select * from saf_expected loop
    v_keys := saf.keys(saf.role(e.role_key));
    perform saf.expect(cardinality(v_keys) = e.n, format('%s holds %s permissions (got %s)', e.role_key, e.n, cardinality(v_keys)));
    select coalesce(array_agg(permission_key order by permission_key), '{}') into v_catalogue from public.sa_permissions where status = 'active' and module = any(e.prefixes);
    perform saf.expect(v_keys = v_catalogue, format('%s equals every active catalogue permission of its module, nothing more, nothing less', e.role_key));
    perform saf.expect((select source = 'template' and status = 'active' and applicable_account_types = array['internal'] from public.sa_business_roles where role_key = e.role_key), e.role_key || ' is a protected internal standard policy');
    perform saf.expect((select permission_keys = v_keys from public.sa_standard_policy_coverage where role_key = e.role_key), e.role_key || ' coverage is recorded explicitly');
  end loop;
end $t$;
select saf.expect((select count(*) from (select permission_id from public.sa_business_role_permissions rp join public.sa_business_roles r on r.id = rp.role_id where r.role_key like '%-full-access' group by permission_id having count(*) > 1) q) = 0, 'no permission belongs to two module policies (module boundaries)');
select saf.expect(not exists (select 1 from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id join public.sa_business_roles r on r.id = rp.role_id where r.role_key like '%-full-access' and p.permission_key = 'reporting.analytics.view'), 'Reporting is not a module policy');
-- Delete / reset / override / emergency permissions are retained in their module policy.
select saf.expect('hr.data.reset' = any(saf.keys(saf.role('hr-payroll-full-access'))), 'HR Full Access contains hr.data.reset');
select saf.expect('finance.data.reset' = any(saf.keys(saf.role('finance-full-access'))) and 'finance.payment.approve' = any(saf.keys(saf.role('finance-full-access'))), 'Finance Full Access contains reset and approval');
select saf.expect('platform.data.destructive' = any(saf.keys(saf.role('platform-settings-full-access'))) and 'platform.identity.delete' = any(saf.keys(saf.role('platform-settings-full-access'))), 'Platform Full Access contains destructive and delete');
select saf.expect(saf.keys(saf.role('security-access-full-access')) @> array['security.role.manage','security.role.assign','security.permission.manage','security.policy.manage','security.audit.view','security.access.view','security.emergency_access.grant'], 'Security & Access Full Access holds view, policy, assignment, governance and mode management');
select saf.expect(saf.keys(saf.role('supply-chain-full-access')) @> array['supply_chain.order.cancel','manufacturing.scan.reverse','inventory.adjustment.post','qr.batch.manage'], 'Supply Chain Full Access holds cancel / reverse / adjustment');
-- Narrower existing policies are preserved.
select saf.expect(cardinality(saf.keys(saf.role('security-administrator'))) between 10 and 14 and not ('security.access_review.manage' = any(saf.keys(saf.role('security-administrator')))), 'narrower Security Administrator unchanged');
-- Seeding assigned nobody and changed no mode.
select saf.expect((select count(*) from public.sa_role_assignments a join public.sa_business_roles r on r.id = a.role_id where r.role_key like '%-full-access') = 0, 'nothing is assigned by the seed');
select saf.expect(not exists (select 1 from public.sa_migration_modes m join saf.modes_before b using (permission_key) where m.mode <> b.mode), 'no migration mode changed');
select saf.expect(saf.audit('access_profile.standard_seeded') = 6, 'one audit row per seeded policy (and none from the second run)');

-- 2. Re-running never expands or overwrites an existing (possibly customized) policy
do $t$ declare r uuid := saf.role('finance-full-access'); begin
  delete from public.sa_business_role_permissions where role_id = r and permission_id = (select id from public.sa_permissions where permission_key = 'finance.cash.view');
  update public.sa_business_roles set name = 'Finance Full Access (renamed by owner)' where id = r;
end $t$;
\i :migration
select saf.expect(not ('finance.cash.view' = any(saf.keys(saf.role('finance-full-access')))), 're-run did not re-add a removed permission');
select saf.expect((select name from public.sa_business_roles where role_key = 'finance-full-access') like '%renamed%', 're-run did not overwrite the role');
select saf.expect((select recorded_not_live = array['finance.cash.view'] from public.sa_standard_policy_drift() where role_key = 'finance-full-access'), 'drift report shows recorded vs live difference');
do $t$ begin
  insert into public.sa_business_role_permissions(role_id, permission_id) select saf.role('finance-full-access'), id from public.sa_permissions where permission_key = 'finance.cash.view';
  update public.sa_business_roles set name = 'Finance Full Access' where role_key = 'finance-full-access';
end $t$;

-- 3. Protection: standard policies cannot be edited, retired or deleted; Copy & Customize makes a separate draft
select saf.expect(saf.try(format($q$select public.sa_save_profile_draft(%L, %L, 'x', null, '{}', '{}', '{finance.cash.view}')$q$, saf.u(1), saf.role('finance-full-access'))) like 'sa_profile_standard_protected%', 'standard policy cannot be drafted in place');
select saf.expect(saf.try(format($q$select public.sa_retire_access_profile(%L, %L, 'retire attempt reason')$q$, saf.u(1), saf.role('finance-full-access'))) like 'sa_profile_standard_protected%', 'standard policy cannot be retired');
select saf.expect(saf.try(format($q$delete from public.sa_business_roles where id = %L$q$, saf.role('finance-full-access'))) like 'sa_profile_standard_protected%', 'standard policy cannot be deleted');
select set_config('saf.copy', public.sa_copy_access_profile(saf.u(1), saf.role('supply-chain-full-access'), 'saf-sc-custom', 'Supply Chain (custom)', 'customizing for the warehouse team')::text, false);
select saf.expect((select source = 'new' and status = 'draft' from public.sa_business_roles where id = current_setting('saf.copy')::uuid), 'copy is a separate custom draft');
select saf.expect(cardinality((select permission_keys from public.sa_access_profile_drafts where role_id = current_setting('saf.copy')::uuid)) = 30, 'copy starts with all 30 permissions');
select public.sa_save_profile_draft(saf.u(1), current_setting('saf.copy')::uuid, 'Supply Chain (custom)', null, array['internal'], '{}',
  (select array_agg(k) from unnest((select permission_keys from public.sa_access_profile_drafts where role_id = current_setting('saf.copy')::uuid)) k where k not in ('supply_chain.order.cancel','manufacturing.scan.reverse')));
select saf.expect(cardinality((select permission_keys from public.sa_access_profile_drafts where role_id = current_setting('saf.copy')::uuid)) = 28, 'permissions can be removed in the draft');
select saf.expect(cardinality(saf.keys(saf.role('supply-chain-full-access'))) = 30, 'the standard original is unchanged');
select saf.expect(saf.try(format($q$select public.sa_assign_role(%L, %L, %L, %L, array[%L]::uuid[], now(), null, 'draft not assignable')$q$, saf.u(1), saf.u(6), current_setting('saf.copy')::uuid, saf.o(1), saf.s(1))) = 'sa_role_not_assignable', 'draft copy is not assignable until published');
select public.sa_submit_profile_draft(saf.u(1), current_setting('saf.copy')::uuid);
select set_config('saf.hash', public.sa_profile_publish_preview(saf.u(1), current_setting('saf.copy')::uuid)->>'impactHash', false);
select saf.expect(public.sa_publish_profile_draft(saf.u(1), current_setting('saf.copy')::uuid, '', current_setting('saf.hash'))->>'published' = 'true', 'customized copy publishes through the existing flow');
select saf.expect(cardinality(saf.keys(current_setting('saf.copy')::uuid)) = 28, 'published copy holds the customized 28');

-- 4. Explicit scoped assignment (existing flow): scope is required, applicability and sensitivity rules unchanged
select saf.expect(saf.try(format($q$select public.sa_assign_role(%L, %L, %L, %L, '{}'::uuid[], now(), null, 'no scope given')$q$, saf.u(1), saf.u(4), saf.role('supply-chain-full-access'), saf.o(2))) = 'sa_scope_required', 'a valid explicit data scope is required');
select public.sa_assign_role(saf.u(1), saf.u(4), saf.role('supply-chain-full-access'), saf.o(2), array[saf.s(2)], now(), null, 'Warehouse lead needs full supply chain');
select saf.expect((public.sa_evaluate_permission(saf.u(4), 'supply_chain.order.cancel', jsonb_build_object('organization_id', saf.o(2)))->>'decision') = 'ALLOW', 'allowed inside the assigned scope');
select saf.expect((public.sa_evaluate_permission(saf.u(4), 'supply_chain.order.cancel', jsonb_build_object('organization_id', saf.o(3)))->>'decision') = 'DENY', 'denied in a sibling organization outside the scope');
select saf.expect((public.sa_evaluate_permission(saf.u(4), 'finance.payment.approve', jsonb_build_object('organization_id', saf.o(2)))->>'decision') = 'DENY', 'a Supply Chain policy grants nothing in another module');
select saf.expect(saf.try(format($q$select public.sa_assign_role(%L, %L, %L, %L, array[%L]::uuid[], now(), null, 'internal only policy')$q$, saf.u(1), saf.u(8), saf.role('supply-chain-full-access'), saf.o(4), saf.s(4))) = 'sa_profile_not_applicable', 'internal-only policy refuses a manufacturer organization');
select saf.expect(not public.sa_profile_sensitive(saf.role('supply-chain-full-access')) and not public.sa_profile_sensitive(saf.role('customer-growth-full-access')), 'Supply Chain and Customer & Growth are assignable at user creation');
select saf.expect(public.sa_profile_sensitive(saf.role('hr-payroll-full-access')) and public.sa_profile_sensitive(saf.role('finance-full-access')) and public.sa_profile_sensitive(saf.role('security-access-full-access')) and public.sa_profile_sensitive(saf.role('platform-settings-full-access')), 'HR, Finance, Security & Access and Platform policies are sensitive (post-creation assignment only)');
select saf.expect(saf.try(format($q$select public.sa_assign_initial_profiles(%L, %L, %L, jsonb_build_array(jsonb_build_object('role_id', %L, 'scope_ids', jsonb_build_array(%L))), false)$q$, saf.u(1), saf.u(6), saf.o(1), saf.role('finance-full-access'), saf.s(1))) like 'sa_profile_sensitive_not_initial%', 'sensitive Full Access is refused at provisioning');
select saf.expect(cardinality(public.sa_assign_initial_profiles(saf.u(1), saf.u(6), saf.o(1), jsonb_build_array(jsonb_build_object('role_id', saf.role('customer-growth-full-access'), 'scope_ids', jsonb_build_array(saf.s(1)))), false)) = 1, 'a non-sensitive Full Access policy is assignable at provisioning with its own scope');
select saf.expect(saf.try(format($q$select public.sa_assign_initial_profiles(%L, %L, %L, jsonb_build_array(jsonb_build_object('role_id', %L)), false)$q$, saf.u(1), saf.u(3), saf.o(1), saf.role('supply-chain-full-access'))) = 'sa_scope_required', 'provisioning also requires an explicit scope');
select saf.expect(saf.try(format($q$select public.sa_assign_role(%L, %L, %L, %L, array[%L]::uuid[], now(), null, 'self grant attempt')$q$, saf.u(1), saf.u(1), saf.role('supply-chain-full-access'), saf.o(1), saf.s(1))) = 'sa_self_assignment_prohibited', 'self-assignment of a Full Access policy stays prohibited');
select saf.expect((select count(*) from public.users where organization_id = saf.o(1)) >= 6 and (select count(*) from public.sa_role_assignments a join public.sa_business_roles r on r.id = a.role_id where r.role_key like '%-full-access') = 2, 'only the two explicit assignments exist; no user or membership was created');

-- 4b. Separation of duties is evaluated at assignment time for a whole-module policy (reported conflicts, exact rule)
select public.sa_assign_role(saf.u(1), saf.u(3), saf.role('hr-payroll-full-access'), saf.o(1), array[saf.s(1)], now(), null, 'HR lead holds the full HR policy');
select saf.expect((select count(*) from public.sa_sod_violations v join public.sa_sod_rules r on r.id = v.rule_id where v.user_id = saf.u(3) and r.rule_key = 'payroll-prepare-release' and v.outcome = 'allowed_monitor') = 1,
  'HR Full Access is assignable today; its payroll prepare+release overlap is recorded as a monitored SoD conflict');
update public.sa_sod_rules set enforcement = 'enforce' where rule_key = 'payroll-prepare-release';
select saf.expect(saf.try(format($q$select public.sa_assign_role(%L, %L, %L, %L, array[%L]::uuid[], now(), null, 'enforced rule blocks the policy')$q$, saf.u(1), saf.u(7), saf.role('hr-payroll-full-access'), saf.o(1), saf.s(1))) like 'sod_violation: payroll-prepare-release%',
  'if the rule is switched to enforce, HR Full Access is blocked by exactly that rule (never silently weakened)');
update public.sa_sod_rules set enforcement = 'monitor' where rule_key = 'payroll-prepare-release';
delete from public.sa_role_assignments where user_id = saf.u(3) and role_id = saf.role('hr-payroll-full-access');

-- 5. Future catalogue additions never grant access automatically; extension is explicit, reasoned and audited
insert into public.sa_permissions(permission_key, module, resource, action, description, source) values ('supply_chain.order.expedite', 'supply_chain', 'order', 'expedite', 'future permission', 'new');
select saf.expect(not ('supply_chain.order.expedite' = any(saf.keys(saf.role('supply-chain-full-access')))), 'a new catalogue permission is not added to the policy');
select saf.expect((public.sa_evaluate_permission(saf.u(4), 'supply_chain.order.expedite', jsonb_build_object('organization_id', saf.o(2)))->>'decision') = 'DENY', 'existing holders are not silently expanded');
select saf.expect((select catalogue_not_covered = array['supply_chain.order.expedite'] from public.sa_standard_policy_drift() where role_key = 'supply-chain-full-access'), 'the drift report lists it for review');
select saf.expect(saf.try($q$select public.sa_extend_standard_policy('supply-chain-full-access', array['supply_chain.order.expedite'], 'short')$q$) = 'sa_reason_required', 'extension needs a reason');
select saf.expect(saf.try($q$select public.sa_extend_standard_policy('supply-chain-full-access', array['finance.cash.view'], 'adding outside the module')$q$) like 'sa_group_policy_outside_module%', 'extension refuses a key outside the module');
set role service_role;
select saf.expect(saf.try($q$select public.sa_extend_standard_policy('supply-chain-full-access', array['supply_chain.order.expedite'], 'reviewed addition for holders')$q$) like 'permission denied for function sa_extend_standard_policy%', 'the extension function is not callable by the API role');
reset role;
select public.sa_extend_standard_policy('supply-chain-full-access', array['supply_chain.order.expedite'], 'reviewed addition for holders');
select saf.expect(cardinality(saf.keys(saf.role('supply-chain-full-access'))) = 31 and (select coverage_version = 2 from public.sa_standard_policy_coverage where role_key = 'supply-chain-full-access'), 'explicit extension adds exactly the reviewed key and records coverage');
select saf.expect(saf.audit('access_profile.standard_extended') = 1 and (select count(*) from public.sa_access_change_log where action = 'assignment.profile_changed' and target_user_id = saf.u(4)) = 1, 'extension audited once and once per holder');
delete from public.sa_business_role_permissions where permission_id = (select id from public.sa_permissions where permission_key = 'supply_chain.order.expedite');
delete from public.sa_permissions where permission_key = 'supply_chain.order.expedite';
update public.sa_standard_policy_coverage set permission_keys = array_remove(permission_keys, 'supply_chain.order.expedite'), coverage_version = 1 where role_key = 'supply-chain-full-access';
