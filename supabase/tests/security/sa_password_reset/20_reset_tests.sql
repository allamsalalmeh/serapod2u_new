-- platform.user.password_reset: catalogue, rollout contract, standard policy, sensitivity, scope behaviour, idempotency.
select saf.expect((select audit_sensitivity = 'security_sensitive' and module = 'platform' and resource = 'user' and action = 'password_reset' from public.sa_permissions where permission_key = 'platform.user.password_reset'), 'permission registered under platform / user');
select saf.expect((select max_role_level = 10 and employee_baseline is false and legacy_permissions = '{}' from public.sa_legacy_compat_rules where permission_key = 'platform.user.password_reset'), 'compat rule: level <= 10 only (not edit_users / level 30)');
select saf.expect((select mode = 'SHADOW' from public.sa_migration_modes where permission_key = 'platform.user.password_reset'), 'mode is SHADOW (nothing enforced by the migration)');
select saf.expect(not exists (select 1 from public.sa_migration_modes m join saf.pw_before b using (permission_key) where m.mode <> b.mode), 'no existing migration mode changed');
select saf.expect((select route_wiring and database_backstop = 'decision_backstop' from public.sa_enforcement_readiness where permission_key = 'platform.user.password_reset'), 'readiness registered with the wired route');

-- Standard policy: exactly one permission, internal, published, unassigned, covered explicitly.
select saf.expect(saf.keys(saf.role('user-password-administrator')) = array['platform.user.password_reset'], 'User Password Administrator holds exactly the reset permission');
select saf.expect((select source = 'template' and status = 'active' and applicable_account_types = array['internal'] and applicable_org_types = '{}' and name = 'User Password Administrator' from public.sa_business_roles where role_key = 'user-password-administrator'), 'standard, published, internal-only');
select saf.expect((select permission_keys = array['platform.user.password_reset'] and module_id = 'platform_settings' from public.sa_standard_policy_coverage where role_key = 'user-password-administrator'), 'coverage recorded');
select saf.expect((select count(*) from public.sa_role_assignments a join public.sa_business_roles r on r.id = a.role_id where r.role_key = 'user-password-administrator') = 0, 'assigned to no one');
select saf.expect((select n from saf.pw_assign_before) = (select count(*) from public.sa_role_assignments), 'the migration created or removed no assignment');

-- Only the two intended policies hold it; profile administration policies do not.
select saf.expect((select array_agg(r.role_key order by r.role_key) from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id join public.sa_business_roles r on r.id = rp.role_id where p.permission_key = 'platform.user.password_reset' and r.source <> 'legacy')
  = array['platform-settings-full-access','user-password-administrator'], 'only Platform & Settings Full Access and User Password Administrator (non-compat) hold reset');
select saf.expect(not exists (select 1 from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id join public.sa_business_roles r on r.id = rp.role_id
  where p.permission_key = 'platform.user.password_reset' and r.role_key in ('identity-administrator','profile-administrator','security-administrator')), 'identity / profile / security administrators do not hold reset');
select saf.expect('platform.user.password_reset' = any(saf.keys(saf.role('platform-settings-full-access'))) and 'platform.user.manage' = any(saf.keys(saf.role('platform-settings-full-access'))), 'Platform Full Access holds both (it already held platform.user.manage)');
select saf.expect((select permission_keys = saf.keys(role_id) from public.sa_standard_policy_coverage where role_key = 'platform-settings-full-access'), 'Platform Full Access coverage matches its live permissions (no drift)');
select saf.expect(not exists (select 1 from public.sa_standard_policy_drift() d where d.role_key in ('platform-settings-full-access','user-password-administrator') and (cardinality(d.live_not_recorded) > 0 or cardinality(d.recorded_not_live) > 0)), 'standard policy drift report is clean');

-- Sensitivity / partner rules.
select saf.expect(public.sa_permission_is_sensitive('platform.user.password_reset') and not public.sa_permission_is_sensitive('platform.user.manage') and not public.sa_permission_is_sensitive('platform.user.profile_edit') and public.sa_permission_is_sensitive('security.role.assign'), 'sensitive classification: reset yes, profile edit no');
select saf.expect(public.sa_permission_forbidden_for_partner('platform.user.password_reset'), 'forbidden for partner policies');

-- Evaluation: a profile editor (platform.user.manage only) cannot reset; the reset holder can, only inside the scope.
insert into public.sa_business_roles(id, role_key, name, source, status) values ('00000000-0000-0000-0005-000000000009', 'saf-profile-editor', 'Profile Editor', 'new', 'active');
insert into public.sa_business_role_permissions(role_id, permission_id) select '00000000-0000-0000-0005-000000000009', id from public.sa_permissions where permission_key in ('platform.user.manage', 'platform.user.profile_edit');
select public.sa_assign_role(saf.u(1), saf.u(3), '00000000-0000-0000-0005-000000000009', saf.o(1), array[saf.s(1)], now(), null, 'Profile editor, no reset');
select saf.expect((public.sa_evaluate_permission(saf.u(3), 'platform.user.manage', jsonb_build_object('organization_id', saf.o(1)))->>'decision') = 'ALLOW', 'profile editor holds platform.user.manage');
select saf.expect((public.sa_evaluate_permission(saf.u(3), 'platform.user.password_reset', jsonb_build_object('organization_id', saf.o(1)))->>'decision') = 'DENY', 'profile editing does not authorize a password reset');
select public.sa_assign_role(saf.u(1), saf.u(4), saf.role('user-password-administrator'), saf.o(2), array[saf.s(2)], now(), null, 'Warehouse password administrator');
select saf.expect((public.sa_evaluate_permission(saf.u(4), 'platform.user.password_reset', jsonb_build_object('organization_id', saf.o(2)))->>'decision') = 'ALLOW', 'reset holder may reset inside the assigned scope');
select saf.expect((public.sa_evaluate_permission(saf.u(4), 'platform.user.password_reset', jsonb_build_object('organization_id', saf.o(3)))->>'decision') = 'DENY', 'cross-organization reset is denied');
select saf.expect((public.sa_evaluate_permission(saf.u(4), 'platform.user.password_reset', jsonb_build_object('organization_id', saf.o(1)))->>'decision') = 'DENY', 'a warehouse-scoped holder cannot reset in HQ');
select saf.expect((public.sa_evaluate_permission(saf.u(4), 'platform.user.manage', jsonb_build_object('organization_id', saf.o(2)))->>'decision') = 'DENY', 'the reset policy does not open User Management');

-- Granting it requires holding it (sensitive): a delegated security administrator who lacks it cannot hand it out.
update public.sa_settings set setting_value = 'true'::jsonb where setting_key = 'security_access.delegated_administration';
select public.sa_assign_role(saf.u(1), saf.u(2), saf.role('security-access-full-access'), saf.o(1), array[saf.s(1)], now(), null, 'Delegated security administrator');
select saf.expect(saf.try(format($q$select public.sa_assign_role(%L, %L, %L, %L, array[%L]::uuid[], now(), null, 'cannot grant reset')$q$, saf.u(2), saf.u(6), saf.role('user-password-administrator'), saf.o(1), saf.s(1))) like 'sa_grant_beyond_authority%', 'an administrator without reset cannot grant User Password Administrator');
select saf.expect(saf.try(format($q$select public.sa_assign_role(%L, %L, %L, %L, array[%L]::uuid[], now(), null, 'level 1 may grant')$q$, saf.u(1), saf.u(6), saf.role('user-password-administrator'), saf.o(1), saf.s(1))) = 'OK', 'a central Super Admin may grant it');

-- Idempotency: the second run changed nothing and audited once.
select saf.expect(saf.audit('access_profile.standard_seeded') >= 1 and (select count(*) from public.sa_access_change_log where action = 'access_profile.standard_seeded' and details::text like '%user-password-administrator%') = 1, 'standard policy seeded (and audited) once');
select saf.expect((select count(*) from public.sa_access_change_log where action = 'access_profile.standard_extended' and details::text like '%platform.user.password_reset%') = 1, 'Platform Full Access extended (and audited) once');
select saf.expect((select count(*) from public.sa_business_roles where role_key = 'user-password-administrator') = 1 and (select count(*) from public.sa_permissions where permission_key = 'platform.user.password_reset') = 1, 'no duplicates');
