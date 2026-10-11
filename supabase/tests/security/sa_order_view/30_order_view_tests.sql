-- After 20261101100000 (applied twice). Order approval/creation/cancel are LEGACY_RETIRED (staging), so
-- supply_chain.order.view is seeded NEW_ENFORCED.
-- ── Definition ───────────────────────────────────────────────────────────────────────────────────────────────────
select saf.expect((select mode from public.sa_migration_modes where permission_key = 'supply_chain.order.view') = 'NEW_ENFORCED',
  'view seeded NEW_ENFORCED because order approval is S&A-authoritative');
select saf.expect((select mode from public.sa_migration_modes where permission_key = 'supply_chain.order.approve') = 'LEGACY_RETIRED', 'approve mode unchanged');
select saf.expect((select audit_sensitivity = 'ordinary' and module = 'supply_chain' from public.sa_permissions where permission_key = 'supply_chain.order.view'),
  'ordinary Supply Chain permission');
select saf.expect((select max_role_level = 40 and cardinality(legacy_permissions) = 0 and not employee_baseline
  from public.sa_legacy_compat_rules where permission_key = 'supply_chain.order.view'), 'compatibility rule = level 40, no legacy permission');
select saf.expect((select database_backstop = 'decision_backstop' and route_wiring from public.sa_enforcement_readiness
  where permission_key = 'supply_chain.order.view'), 'readiness registered honestly (not an RLS gate)');
select saf.expect(saf.keys(saf.role('order-approver')) = array['supply_chain.order.approve', 'supply_chain.order.view'],
  'Order Approver = approve + view, nothing else');
select saf.expect(saf.keys(saf.role('order-creator')) = array['supply_chain.order.create', 'supply_chain.order.view'],
  'Order Creator = create + view, nothing else');
select saf.expect('supply_chain.order.view' = any(saf.keys(saf.role('supply-chain-full-access'))), 'Supply Chain Full Access covers View Orders');
select saf.expect((select 'supply_chain.order.view' = any(permission_keys) from public.sa_standard_policy_coverage where role_key = 'supply-chain-full-access'),
  'Full Access coverage row updated');
select saf.expect(saf.keys(saf.role('custom-approve-only')) = array['supply_chain.order.approve'], 'custom policies are NOT broadened');
select saf.expect(not ('supply_chain.order.view' = any(saf.keys(saf.role('warehouse-operator')))), 'Warehouse Operator not changed');
select saf.expect(not ('supply_chain.order.view' = any(saf.keys(saf.role('qr-batch-operator')))), 'QR Batch Operator not changed');
select saf.expect((select count(*) from public.sa_permissions where permission_key = 'supply_chain.order.view') = 1, 'one permission after two runs');
select saf.expect(saf.audit('access_profile.standard_extended') = 3, 'approver, creator and Full Access extended once each (second run unchanged)');
select saf.expect((select count(*) from public.sa_access_change_log where action = 'assignment.profile_changed'
  and details->'added' ? 'supply_chain.order.view') = 4, 'each holder of Order Approver / Creator audited once (u40, u46, u42, u43)');
select saf.expect((select version from public.sa_business_roles where role_key = 'order-approver') = 2, 'Order Approver version bumped once');
-- Compatibility roles: exactly the level <= 40 audience, never GUEST or level 50.
select saf.expect((select string_agg(b.role_key, ',' order by b.role_key) from public.sa_business_role_permissions rp
  join public.sa_business_roles b on b.id = rp.role_id and b.source = 'legacy'
  join public.sa_permissions p on p.id = rp.permission_id and p.permission_key = 'supply_chain.order.view')
  = 'legacy-hq-mgr,legacy-hq-staff,legacy-mfg-user,legacy-sa,legacy-wh-mgr', 'compatibility roles at level <= 40 only');
select saf.expect(saf.audit('compat_role.permission_materialized') = 5, 'compatibility materialization audited once per role');
-- Dependency convention.
select saf.expect((select count(*) from public.sa_permission_dependencies where requires_key = 'supply_chain.order.view') = 3, 'approve/create/cancel declare View Orders');
select saf.expect(not exists (select 1 from public.sa_standard_policy_dependency_gaps()
  where role_key in ('order-approver', 'order-creator', 'supply-chain-full-access')), 'no supporting-read gap in the order policies');
select saf.expect(not has_table_privilege('authenticated', 'public.sa_permission_dependencies', 'SELECT'), 'dependency table not API-readable');
select saf.expect(not has_function_privilege('authenticated', 'public.sa_standard_policy_dependency_gaps()', 'EXECUTE'), 'gap report not API-callable');
select saf.expect(not exists (select 1 from public.sa_sod_rules where 'supply_chain.order.view' in (left_key, right_key)), 'no SoD rule on View Orders');
select saf.expect((select left_key || '/' || right_key || '/' || enforcement from public.sa_sod_rules where rule_key = 'order-maker-checker')
  = 'supply_chain.order.create/supply_chain.order.approve/enforce', 'maker/checker unchanged');

-- ── Test 1: Order Approver only ───────────────────────────────────────────────────────────────────────────────────
select saf.expect(saf.d(40, 'supply_chain.order.view', 1) = 'ALLOW', 'T1: approver views HQ orders');
select saf.expect(saf.d(40, 'supply_chain.order.approve', 1) = 'ALLOW', 'T1: approver still approves');
select saf.expect(saf.d(40, 'supply_chain.order.create', 1) = 'DENY', 'T1: approval does not imply creation');
select saf.expect(saf.d(40, 'supply_chain.order.cancel', 1) = 'DENY', 'T1: approval does not imply cancellation');
select saf.expect(saf.d(40, 'inventory.adjustment.post', 1) = 'DENY' and saf.d(40, 'qr.batch.manage', 1) = 'DENY', 'T1: nothing else added');
-- View reach equals approval reach on every organization (same scope, same evaluator).
select saf.expect(not exists (select 1 from public.organizations o
  where (public.sa_evaluate_permission(saf.u(40), 'supply_chain.order.view', jsonb_build_object('organization_id', o.id))->>'decision')
     is distinct from (public.sa_evaluate_permission(saf.u(40), 'supply_chain.order.approve', jsonb_build_object('organization_id', o.id))->>'decision')),
  'T1: view reach == approval reach on every organization');

-- ── Test 2: no order policy ────────────────────────────────────────────────────────────────────────────────────────
select saf.expect(saf.d(41, 'supply_chain.order.view', 1) = 'DENY', 'T2: no policy → no view');
select saf.expect(saf.d(41, 'supply_chain.order.approve', 1) = 'DENY', 'T2: no policy → no approval');

-- ── Test 3: Order Creator only ─────────────────────────────────────────────────────────────────────────────────────
select saf.expect(saf.d(42, 'supply_chain.order.view', 1) = 'ALLOW' and saf.d(42, 'supply_chain.order.create', 1) = 'ALLOW', 'T3: HQ creator views + creates');
select saf.expect(saf.d(42, 'supply_chain.order.approve', 1) = 'DENY', 'T3: creator cannot approve');
select saf.expect(saf.d(43, 'supply_chain.order.view', 11) = 'ALLOW', 'T3: distributor creator views its own orders');
select saf.expect(saf.d(43, 'supply_chain.order.view', 1) = 'DENY', 'T3: distributor creator gets no HQ-wide view');

-- ── Custom policy and compatibility ────────────────────────────────────────────────────────────────────────────────
select saf.expect(saf.d(44, 'supply_chain.order.approve', 1) = 'ALLOW' and saf.d(44, 'supply_chain.order.view', 1) = 'DENY',
  'custom approve-only policy is not broadened (explicit mapping only)');
select saf.expect(saf.d(45, 'supply_chain.order.view', 1) = 'ALLOW', 'level-40 compatibility holder keeps Order Details');

-- ── Test 5: organization isolation ─────────────────────────────────────────────────────────────────────────────────
select saf.expect(saf.d(40, 'supply_chain.order.view', 5) = 'DENY', 'T5: HQ approver cannot view another tree');
select saf.expect(saf.d(43, 'supply_chain.order.view', 5) = 'DENY', 'T5: distributor cannot view another distributor');
select saf.expect(saf.d(43, 'supply_chain.order.view', 4) = 'DENY', 'T5: distributor cannot view the manufacturer');

-- ── Test 4: revocation ─────────────────────────────────────────────────────────────────────────────────────────────
select saf.expect(saf.d(46, 'supply_chain.order.view', 1) = 'ALLOW' and saf.d(46, 'inventory.transfer.view', 1) = 'ALLOW', 'T4: before revoke');
select public.sa_revoke_assignment(saf.u(1), saf.assignment(saf.u(46), 'order-approver'), 'Approver duty ended (fixture)');
select saf.expect(saf.d(46, 'supply_chain.order.view', 1) = 'DENY', 'T4: contributed view removed');
select saf.expect(saf.d(46, 'supply_chain.order.approve', 1) = 'DENY', 'T4: approval removed');
select saf.expect(saf.d(46, 'inventory.transfer.view', 1) = 'ALLOW', 'T4: independent Warehouse Operator grant intact');
select saf.expect(saf.d(40, 'supply_chain.order.view', 1) = 'ALLOW', 'T4: other holders unaffected');
