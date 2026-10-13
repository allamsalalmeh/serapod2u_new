-- platform.system_logs.view: catalogue, rollout contract, narrow standard policy, evaluation and readable scope.
select saf.expect((select audit_sensitivity = 'security_sensitive' and module = 'platform' and resource = 'system_logs' and action = 'view' from public.sa_permissions where permission_key = 'platform.system_logs.view'), 'permission registered under platform / system_logs');
select saf.expect((select max_role_level = 1 and employee_baseline is false and legacy_permissions = '{}' and role_codes = '{}' from public.sa_legacy_compat_rules where permission_key = 'platform.system_logs.view'), 'compat rule: central Super Admin only');
select saf.expect((select mode = 'SHADOW' from public.sa_migration_modes where permission_key = 'platform.system_logs.view'), 'mode is SHADOW (nothing enforced)');
select saf.expect(not exists (select 1 from public.sa_migration_modes m join saf.sl_modes_before b using (permission_key) where m.mode <> b.mode), 'no existing migration mode changed');
select saf.expect((select route_wiring and database_backstop = 'read_only' from public.sa_enforcement_readiness where permission_key = 'platform.system_logs.view'), 'readiness registered');
select saf.expect(saf.keys(saf.role('system-log-viewer')) = array['platform.system_logs.view'], 'System Log Viewer holds exactly one permission');
select saf.expect((select source = 'template' and status = 'active' and applicable_account_types = array['internal'] and name = 'System Log Viewer' from public.sa_business_roles where role_key = 'system-log-viewer'), 'standard, published, internal-only');
select saf.expect((select n from saf.sl_assign_before) + 1 = (select count(*) from public.sa_role_assignments), 'migrations assigned nothing (the one extra assignment is the test grant in 30_)');
select saf.expect(not ('platform.system_logs.view' = any(saf.keys(saf.role('platform-settings-full-access')))), 'Platform & Settings Full Access is NOT extended');
select saf.expect(not exists (select 1 from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id join public.sa_business_roles r on r.id = rp.role_id
  where p.permission_key = 'platform.system_logs.view' and r.role_key not in ('system-log-viewer') and r.source <> 'legacy'), 'no other non-compat policy holds it');
select saf.expect((select 'platform.system_logs.view' = any(d.catalogue_not_covered) from public.sa_standard_policy_drift() d where d.role_key = 'platform-settings-full-access'), 'drift report lists the deliberate gap for Platform & Settings Full Access');
select saf.expect(not public.sa_permission_is_sensitive('platform.system_logs.view'), 'not grant-sensitive (sa_permission_is_sensitive not redefined)');

-- Evaluation (new model): holder sees HQ only; Settings / User Management authority does not imply logs.
select saf.expect((public.sa_evaluate_permission(saf.u(6), 'platform.system_logs.view', jsonb_build_object('organization_id', saf.o(1)))->>'decision') = 'ALLOW', 'System Log Viewer holder allowed in the scoped organization');
select saf.expect((public.sa_evaluate_permission(saf.u(6), 'platform.system_logs.view', jsonb_build_object('organization_id', saf.o(4)))->>'decision') = 'DENY', 'outside scope denied');
select saf.expect((public.sa_evaluate_permission(saf.u(9), 'platform.system_logs.view', jsonb_build_object('organization_id', saf.o(1)))->>'decision') = 'DENY', 'another administrator without the policy is denied');
insert into public.sa_business_roles(id, role_key, name, source, status) values ('00000000-0000-0000-0005-000000000019', 'saf-settings-admin', 'Settings + Users', 'new', 'active');
insert into public.sa_business_role_permissions(role_id, permission_id) select '00000000-0000-0000-0005-000000000019', id from public.sa_permissions where permission_key in ('platform.user.manage','platform.settings.manage');
select public.sa_assign_role(saf.u(1), saf.u(3), '00000000-0000-0000-0005-000000000019', saf.o(1), array[saf.s(1)], now(), null, 'Settings and user administration');
select saf.expect((public.sa_evaluate_permission(saf.u(3), 'platform.system_logs.view', jsonb_build_object('organization_id', saf.o(1)))->>'decision') = 'DENY', 'Settings / User Management authority does not grant System Logs');
-- Readable organizations (what the list API passes to the read functions in a new-model mode).
select saf.expect(public.sa_readable_organizations(saf.u(6), 'platform.system_logs.view') @> array[saf.o(1)] and not (saf.o(4) = any(public.sa_readable_organizations(saf.u(6), 'platform.system_logs.view'))), 'readable scope: HQ (and its descendants), never the manufacturer');
select saf.expect(cardinality(public.sa_readable_organizations(saf.u(3), 'platform.system_logs.view')) = 0, 'non-holder has no readable organization');
