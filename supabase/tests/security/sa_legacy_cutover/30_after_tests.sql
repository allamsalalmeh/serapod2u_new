-- After 20261215100000 / 110000 / 120000.

-- 20261215100000: Payment Gateway administration
select pht.expect(not pht.has(5, 'ecommerce.channel.manage'), 'C&G Full Access no longer grants ecommerce.channel.manage');
select pht.expect(pht.has(5, 'ecommerce.store.manage') and pht.has(5, 'ecommerce.order.manage') and pht.has(5, 'ecommerce.module.view'),
  'C&G Full Access keeps ordinary E-Commerce operations');
select pht.expect(pht.has(3, 'ecommerce.channel.manage'), 'Root Administrator keeps Payment Gateway administration');
select pht.expect(pht.perms('ecommerce-payment-gateway-administrator') = array['ecommerce.channel.manage'], 'new policy holds exactly ecommerce.channel.manage');
select pht.expect(not exists (select 1 from public.sa_role_assignments a join public.sa_business_roles b on b.id = a.role_id
                              where b.role_key = 'ecommerce-payment-gateway-administrator'), 'new policy is assigned to nobody');
select pht.expect(not ('ecommerce.channel.manage' = any(pht.perms('customer-growth-full-access'))), 'C&G Full Access mapping excludes the key');
select pht.expect((select count(*) from public.sa_access_change_log where action = 'assignment.profile_changed'
                   and details->'removed' ? 'ecommerce.channel.manage') = 3, 'each C&G holder (3 assignments) has an audited removal');
select pht.expect((select 'ecommerce.channel.manage' = any(excluded_keys) from public.sa_standard_policy_coverage where role_key = 'customer-growth-full-access'),
  'reviewed exclusion recorded');

-- 20261215110000: legacy cutover controls — applying changes nothing
select pht.expect(pht.has(2, 'customer.loyalty.adjust'), 'after apply: Legacy USER still authorizes until the owner retires it');
select pht.expect((select count(*) from public.sa_legacy_compat_overview() where authorizes) =
                  (select count(*) from public.sa_business_roles where source = 'legacy'), 'overview: every compatibility policy still authorizes');
select pht.expect((select permission_count from public.sa_legacy_compat_overview() where role_key = 'legacy-user') = 30, 'overview: Legacy USER = 30 permissions');
select pht.expect((select permission_count from public.sa_legacy_compat_overview() where role_key = 'legacy-sa') = 100, 'overview: Legacy SA = 100 permissions');

-- Impact report (Alif-like user 1): overlap with C&G Full Access, loss where only Legacy USER grants it.
select pht.expect((select 'customer-growth-full-access' = any(covered_by) and not would_lose from public.sa_legacy_cutover_impact('legacy-user')
                   where user_id = pht.u(1) and permission_key = 'customer.loyalty.adjust'), 'impact: loyalty.adjust is covered by C&G Full Access for user 1');
select pht.expect((select would_lose from public.sa_legacy_cutover_impact('legacy-user')
                   where user_id = pht.u(1) and permission_key = 'finance.ledger.view'), 'impact: finance.ledger.view comes only from Legacy USER for user 1');
select pht.expect((select bool_and(would_lose) from public.sa_legacy_cutover_impact('legacy-user') where user_id = pht.u(2)), 'impact: user 2 would lose all 30');
select pht.expect((select count(*) from public.sa_legacy_cutover_impact('legacy-user') where user_id = pht.u(2)) = 30, 'impact: user 2 has 30 rows');
select pht.expect((select bool_and(root_access and not would_lose) from public.sa_legacy_cutover_impact('legacy-sa') where user_id = pht.u(3)),
  'impact: Root Administrator loses nothing with Legacy SA retired');

-- Owner-only switches
select pht.expect(not has_function_privilege('authenticated', 'public.sa_retire_legacy_compat_role(text,text,boolean)', 'execute')
  and not has_function_privilege('service_role', 'public.sa_retire_legacy_compat_role(text,text,boolean)', 'execute'), 'retire switch is owner-only');
select pht.expect(pht.try($$select public.sa_retire_legacy_compat_role('legacy-user', 'cutover test', false)$$) like '%sa_legacy_cutover_would_remove_access%',
  'retire refuses while people would lose access (no accept_loss)');
select pht.expect(pht.try($$select public.sa_retire_legacy_compat_role('customer-growth-full-access', 'cutover test', true)$$) like '%sa_not_compat_role%',
  'retire refuses a non-compatibility policy');
select pht.expect(pht.try($$select public.sa_retire_legacy_compat_role('legacy-user', 'short', true)$$) like '%sa_reason_required%', 'retire needs a reason');

update public.sa_settings set setting_value = 'false'::jsonb where setting_key = 'legacy_authorization.read_only';
select pht.expect(pht.try($$select public.sa_retire_legacy_compat_role('legacy-user', 'cutover test', true)$$) like '%sa_legacy_store_writable%',
  'retire refuses while the legacy store is writable');
update public.sa_settings set setting_value = 'true'::jsonb where setting_key = 'legacy_authorization.read_only';

-- Root continuity
begin;  -- rolled back: a revoked Root grant can never be re-activated (sa_root_grant_guard)
update public.sa_root_access_grants set status = 'revoked', revoked_at = now(), revoke_reason = 'lc test continuity' where id = pht.o(900);
select pht.expect(pht.try($$select public.sa_retire_legacy_compat_role('legacy-user', 'cutover test', true)$$) like '%sa_root_continuity%',
  'retire refuses without an active Root Administrator');
rollback;
select pht.expect(public.sa_actor_is_root(pht.u(3)), 'Root grant intact after the continuity check');

-- Retire Legacy USER (accepting the reviewed loss)
select pht.expect((public.sa_retire_legacy_compat_role('legacy-user', 'Legacy USER cutover test', true)->>'status') = 'deprecated', 'Legacy USER retired');
select pht.expect(not pht.has(2, 'customer.loyalty.adjust') and not pht.has(2, 'finance.report.view_sensitive'), 'user 2 (Legacy USER only) now holds nothing from it');
select pht.expect(pht.has(1, 'customer.loyalty.adjust'), 'revocation with overlap: user 1 keeps loyalty.adjust through C&G Full Access');
select pht.expect(not pht.has(1, 'finance.ledger.view'), 'user 1 loses finance.ledger.view (only Legacy USER granted it)');
select pht.expect(pht.has(1, 'reporting.analytics.view'), 'user 1 keeps Reporting Viewer');
select pht.expect(not pht.has(8, 'warehouse.receipt.post', 2), 'warehouse user loses warehouse.receipt.post from Legacy USER');
select pht.expect(cardinality(public.sa_readable_organizations(pht.u(2), 'customer.loyalty.adjust', true)) = 0, 'RLS readable organizations follow the evaluator');
select pht.expect((public.sa_evaluate_permission(pht.u(2), 'customer.loyalty.adjust', jsonb_build_object('organization_id', pht.o(1)), true)->>'reason_code') in ('MISSING_PERMISSION','MISSING_ASSIGNMENT'),
  'denial reason is a missing permission');
select pht.expect((select count(*) from public.sa_role_assignments a join public.sa_business_roles b on b.id = a.role_id
                   where b.role_key = 'legacy-user' and a.status = 'active') = 4, 'assignments are kept (metadata), not revoked');
select pht.expect((select role_code from public.users where id = pht.u(2)) = 'USER', 'legacy role code is untouched');
select pht.expect(pht.audit('access_profile.legacy_retired') = 1, 'retirement audited');
select pht.expect((select count(*) from public.sa_access_change_log where action = 'assignment.profile_changed' and (details->>'legacy_retired')::boolean) = 4,
  'each holder audited');
select pht.expect(pht.try($$update public.sa_settings set setting_value = 'false'::jsonb where setting_key = 'legacy_authorization.read_only'$$) like '%sa_legacy_compat_retired%',
  'legacy store cannot become writable while a compatibility policy is retired');
select pht.expect((public.sa_retire_legacy_compat_role('legacy-user', 'Legacy USER cutover test', true)->>'unchanged')::boolean, 'retire is repeat-safe');

-- Expired / inactive scope / cross-organization stay denied
select pht.expect(not pht.has(6, 'finance.ledger.view'), 'expired explicit grant authorizes nothing (and Legacy USER is retired)');
select pht.expect(not pht.has(7, 'customer.crm.view'), 'inactive data scope still authorizes nothing');
select pht.expect(not pht.has(5, 'customer.crm.view', 3) and pht.has(5, 'customer.crm.view', 1), 'cross-organization still denied; own organization allowed');

-- Retire Legacy SA: Root keeps everything; a non-root SA loses security administration
select pht.expect((public.sa_retire_legacy_compat_role('legacy-sa', 'Legacy SA cutover test', true)->>'status') = 'deprecated', 'Legacy SA retired');
select pht.expect(pht.has(3, 'security.role.assign') and pht.has(3, 'platform.data.destructive'), 'Root Administrator unaffected (separately governed)');
select pht.expect(not pht.has(4, 'security.role.assign') and not pht.has(4, 'platform.data.destructive'), 'Legacy SA without Root loses security and destructive keys');

-- Rollback
select pht.expect((public.sa_restore_legacy_compat_role('legacy-user', 'Rollback test of the cutover')->>'status') = 'active', 'Legacy USER restored');
select pht.expect(pht.has(2, 'customer.loyalty.adjust') and pht.has(1, 'finance.ledger.view'), 'restore brings the compatibility access back immediately');
select pht.expect(pht.try($$update public.sa_settings set setting_value = 'false'::jsonb where setting_key = 'legacy_authorization.read_only'$$) like '%sa_legacy_compat_retired%',
  'still guarded while Legacy SA is retired');
select pht.expect((public.sa_restore_legacy_compat_role('legacy-sa', 'Rollback test of the cutover')->>'status') = 'active', 'Legacy SA restored');
select pht.expect(pht.try($$update public.sa_settings set setting_value = 'true'::jsonb where setting_key = 'legacy_authorization.read_only'$$) is null, 'settings guard allows ordinary updates');
select pht.expect(pht.try($$update public.sa_settings set setting_value = 'true'::jsonb where setting_key = 'emergency_access.enabled'$$) is null
  or pht.try($$update public.sa_settings set setting_value = 'true'::jsonb where setting_key = 'emergency_access.enabled'$$) like '%emergency_access_prerequisite_unmet%',
  'emergency-access guard rule preserved');
update public.sa_settings set setting_value = 'false'::jsonb where setting_key = 'emergency_access.enabled';

-- 20261215120000: hr.employee.delete mode
select pht.expect((select mode from public.sa_migration_modes where permission_key = 'hr.employee.delete') = 'LEGACY_RETIRED', 'hr.employee.delete is LEGACY_RETIRED');
select pht.expect((select mode from public.sa_migration_modes where permission_key = 'security.emergency_access.grant') = 'SHADOW', 'emergency access grant stays SHADOW');
select pht.expect((select count(*) from public.sa_access_change_log where action = 'migration_mode.changed' and entity_id = 'hr.employee.delete') = 2,
  'mode change audited (SHADOW → NEW_ENFORCED → LEGACY_RETIRED), once');
select pht.expect(not pht.has(1, 'hr.employee.delete') and not pht.has(4, 'hr.employee.delete') and pht.has(3, 'hr.employee.delete'),
  'hr.employee.delete: nobody but Root and an explicit holder');

-- Lifecycle keeps working with a retired compatibility policy (profile updates run sa_sync_user_lifecycle)
select pht.expect((public.sa_retire_legacy_compat_role('legacy-user', 'Lifecycle compatibility check', true)->>'status') = 'deprecated', 'Legacy USER retired again');
select pht.expect(pht.try($$select public.sa_sync_user_lifecycle(pht.u(2), 'manual')$$) is null, 'lifecycle sync succeeds for a holder of a retired compatibility policy');
update public.users set role_code = 'HQ' where id = pht.u(8);
select pht.expect(pht.try($$select public.sa_sync_user_lifecycle(pht.u(8), 'manual')$$) is null, 'lifecycle sync succeeds after a role-code change');
select pht.expect((select a.status from public.sa_role_assignments a join public.sa_business_roles b on b.id = a.role_id
                   where a.user_id = pht.u(8) and b.role_key = 'legacy-user') = 'revoked', 'a role-code change still ends the compatibility assignment (no new one is derived)');
select pht.expect(not exists (select 1 from public.sa_role_assignments a join public.sa_business_roles b on b.id = a.role_id
                   where a.user_id = pht.u(8) and b.role_key = 'legacy-hq'), 'no Legacy HQ is derived from the new role code (read-only legacy store)');
select pht.expect((public.sa_restore_legacy_compat_role('legacy-user', 'Rollback after lifecycle check')->>'status') = 'active', 'Legacy USER restored again');
