-- After 20261031100000 (applied twice). Inventory permissions are LEGACY_RETIRED (staging), so inventory.stock.view is
-- seeded NEW_ENFORCED. Balances: o1 (HQ) 10, o2 (Balakong) 100, o3 (Alma) 200, o5 (North Distributor, other tree) 300.
-- ── Definition ───────────────────────────────────────────────────────────────────────────────────────────────────
select saf.expect((select mode from public.sa_migration_modes where permission_key = 'inventory.stock.view') = 'NEW_ENFORCED',
  'stock.view seeded NEW_ENFORCED because the Inventory module is S&A-authoritative');
select saf.expect(saf.keys(saf.role('inventory-viewer')) = array['inventory.stock.view'], 'Inventory Viewer holds exactly View Inventory');
select saf.expect((select source = 'template' and status = 'active' and applicable_org_types = array['HQ','DIST','WH']
  from public.sa_business_roles where role_key = 'inventory-viewer'), 'standard, published, HQ/distributor/warehouse');
select saf.expect((select count(*) from public.sa_business_roles where role_key = 'inventory-viewer') = 1, 'one Inventory Viewer after two applications');
select saf.expect((select count(*) from public.sa_role_assignments where role_id = saf.role('inventory-viewer')) = 0, 'the migration assigns nobody');
select saf.expect('inventory.stock.view' = any(saf.keys(saf.role('supply-chain-full-access'))), 'Supply Chain Full Access covers View Inventory');
select saf.expect(not ('inventory.stock.view' = any(saf.keys(saf.role('warehouse-operator')))), 'Warehouse Operator not extended');
select saf.expect(not ('inventory.stock.view' = any(saf.keys(saf.role('order-approver')))), 'Order Approver not extended');
select saf.expect(saf.audit('access_profile.standard_extended') = 1, 'Full Access extension audited once (second run unchanged)');
select saf.expect((select count(*) from pg_policy where polrelid = 'public.product_inventory'::regclass and polname = 'inventory_org_manage') = 0
  and (select string_agg(polcmd::text, '' order by polcmd) from pg_policy where polrelid = 'public.product_inventory'::regclass and polname like 'inventory_org_manage_%') = 'adw',
  'FOR ALL write policy split into insert/update/delete');
select saf.expect((select pg_get_expr(polqual, polrelid) from pg_policy where polrelid = 'public.product_inventory'::regclass and polname = 'inventory_org_manage_update')
  = (select (definition::jsonb)->>'using' from public.sa_inventory_view_originals where view_name = 'product_inventory.inventory_org_manage'),
  'write expression unchanged');
select saf.expect(not has_table_privilege('authenticated', 'public.sa_inventory_view_originals', 'SELECT'), 'originals are not API-readable');
select saf.expect(has_table_privilege('authenticated', 'public.vw_inventory_on_hand', 'SELECT'), 'view grants kept');
select saf.expect((select reloptions from pg_class where oid = 'public.vw_inventory_on_hand'::regclass) @> array['security_barrier=true'], 'views are security barriers');

-- ── Scenario 1: no Supply Chain access (orderapp@dev.com) ──────────────────────────────────────────────────────────
select saf.as_api_user(saf.u(30)); set role authenticated;
select saf.expect(saf.orgs('product_inventory') = '', 'S1: no grant → no product_inventory rows');
select saf.expect(saf.orgs('vw_inventory_on_hand') = '', 'S1: no grant → Inventory view empty');
select saf.expect(saf.orgs('v_low_stock_alerts') = '', 'S1: no grant → low stock empty');
select saf.expect(saf.orgs('vw_manual_stock_balance', 'warehouse_id') = '', 'S1: no grant → manual balances empty');
select saf.expect(saf.orgs('v_stock_movements_display', 'to_organization_id') = '', 'S1: no grant → movements empty');
select saf.expect((select count(*) from public.product_inventory where organization_id = saf.o(2)) = 0, 'S1: a chosen warehouse id does not help');
reset role; select saf.as_owner();
-- Automatic access (Employee Self-Service baseline) contributes nothing.
select saf.expect((saf.decide(saf.u(30), 'inventory.stock.view', saf.o(1))->>'decision') = 'DENY', 'S1: S&A denies View Inventory');

-- ── Scenario 2: Inventory Viewer only (scoped to Balakong) ─────────────────────────────────────────────────────────
select public.sa_assign_role(saf.u(1), saf.u(31), saf.role('inventory-viewer'), saf.o(1), array[saf.s(2)], now(), null, 'Balakong stock view');
select saf.as_api_user(saf.u(31)); set role authenticated;
select saf.expect(saf.orgs('product_inventory') = saf.on(2), 'S2: Balakong only (not HQ, Alma or another tree)');
select saf.expect(saf.orgs('vw_inventory_on_hand') = saf.on(2), 'S2: Inventory page rows in scope only');
select saf.expect(saf.orgs('v_low_stock_alerts') = saf.on(2), 'S2: low stock in scope only');
select saf.expect(saf.orgs('vw_manual_stock_balance', 'warehouse_id') = saf.on(2), 'S2: manual balances in scope only');
select saf.expect((select count(*) from public.vw_inventory_on_hand where organization_id = saf.o(3)) = 0, 'S2: manipulated warehouse id → nothing');
select saf.expect((select quantity_on_hand from public.vw_inventory_on_hand where organization_id = saf.o(2)) = 100, 'S2: real quantity visible');
-- Read only: quantity changes refused (RLS / write guard), configuration columns are legacy RLS as before.
select saf.expect(saf.try(format($q$update public.product_inventory set quantity_on_hand = 999 where organization_id = %L$q$, saf.o(2))) like 'sa_authorization_required%',
  'S2: stock modification refused');
reset role; select saf.as_owner();
select saf.expect((select quantity_on_hand from public.product_inventory where organization_id = saf.o(2)) = 100, 'S2: quantity unchanged');
select saf.expect((saf.decide(saf.u(31), 'inventory.adjustment.post', saf.o(2))->>'decision') = 'DENY', 'S2: no adjustment');
select saf.expect((saf.decide(saf.u(31), 'inventory.transfer.request', saf.o(2))->>'decision') = 'DENY', 'S2: no transfer');
select saf.expect((saf.decide(saf.u(31), 'inventory.opening_balance.manage', saf.o(2))->>'decision') = 'DENY', 'S2: no opening balance');
select saf.expect((saf.decide(saf.u(31), 'inventory.stock_config.manage', saf.o(2))->>'decision') = 'DENY', 'S2: no inventory administration');

-- ── Scenario 3: Order Approver only ────────────────────────────────────────────────────────────────────────────────
select saf.as_api_user(saf.u(32)); set role authenticated;
select saf.expect(saf.orgs('product_inventory') = '' and saf.orgs('vw_inventory_on_hand') = '', 'S3: approval does not expose inventory');
reset role; select saf.as_owner();
select saf.expect((saf.decide(saf.u(32), 'supply_chain.order.create', saf.o(1))->>'decision') = 'DENY', 'S3: approval does not imply creation');
-- Order Creator: availability on the table (tenant rule), never the Inventory page views.
select public.sa_assign_role(saf.u(1), saf.u(33), saf.role('order-creator'), saf.o(1), array[saf.s(1)], now(), null, 'HQ orders');
select public.sa_assign_role(saf.u(1), saf.u(34), saf.role('order-creator'), saf.o(11), array[saf.s(11)], now(), null, 'Distributor orders');
select saf.as_api_user(saf.u(33)); set role authenticated;
select saf.expect(saf.orgs('product_inventory') = saf.on(1, 2, 3), 'Order Creator: availability in the HQ tree (tenant rule unchanged)');
select saf.expect(saf.orgs('vw_inventory_on_hand') = '' and saf.orgs('v_low_stock_alerts') = '', 'Order Creator: no Inventory page data');
reset role; select saf.as_owner();
select saf.as_api_user(saf.u(34)); set role authenticated;
select saf.expect(saf.orgs('product_inventory') = saf.on(1), 'distributor Order Creator: parent HQ availability as before, no sibling warehouses');
reset role; select saf.as_owner();

-- ── Scenario 4: Supply Chain Full Access (u9, HQ scope, level 10: is_hq_admin, so the tenant rule alone reaches o5) ─
select public.sa_assign_role(saf.u(1), saf.u(9), saf.role('supply-chain-full-access'), saf.o(1), array[saf.s(1)], now(), null, 'HQ supply chain');
select saf.as_api_user(saf.u(9)); set role authenticated;
-- Full Access includes order creation: table availability follows the (unchanged) tenant rule, which for an
-- is_hq_admin account was already every organization. The Inventory page views stay within the S&A scope.
select saf.expect(saf.orgs('product_inventory') = saf.on(1, 2, 3, 5), 'S4: table availability = unchanged tenant rule');
select saf.expect(saf.orgs('vw_inventory_on_hand') = saf.on(1, 2, 3), 'S4: Inventory page: HQ tree, not the other distributor tree');
select saf.expect(saf.orgs('v_stock_movements_display', 'to_organization_id') = saf.on(2, 3), 'S4: movements of the HQ tree only');
reset role; select saf.as_owner();

-- ── Scenario 5: revocation and expiry ──────────────────────────────────────────────────────────────────────────────
select public.sa_assign_role(saf.u(1), saf.u(30), saf.role('supply-chain-full-access'), saf.o(1), array[saf.s(1)], now(), null, 'Grant then revoke');
select saf.as_api_user(saf.u(30)); set role authenticated;
select saf.expect(saf.orgs('vw_inventory_on_hand') = saf.on(1, 2, 3), 'S5: granted → visible');
reset role; select saf.as_owner();
select public.sa_revoke_assignment(saf.u(1), saf.assignment(saf.u(30), 'supply-chain-full-access'), 'REmove Supply Chain Full Access');
select saf.as_api_user(saf.u(30)); set role authenticated;
select saf.expect(saf.orgs('vw_inventory_on_hand') = '' and saf.orgs('product_inventory') = '', 'S5: revoked → nothing, on the next statement');
reset role; select saf.as_owner();
select public.sa_assign_role(saf.u(1), saf.u(30), saf.role('inventory-viewer'), saf.o(1), array[saf.s(1)], now(), null, 'Temporary stock view');
update public.sa_role_assignments set effective_from = now() - interval '2 days', effective_until = now() - interval '1 day'
  where id = saf.assignment(saf.u(30), 'inventory-viewer');
select saf.as_api_user(saf.u(30)); set role authenticated;
select saf.expect(saf.orgs('vw_inventory_on_hand') = '', 'S5: expired → nothing');
reset role; select saf.as_owner();

-- ── Scenario 6: other sources ──────────────────────────────────────────────────────────────────────────────────────
-- Warehouse Operator (Alma) reads its own warehouse through its workflow permissions.
select saf.as_api_user(saf.u(36)); set role authenticated;
select saf.expect(saf.orgs('vw_inventory_on_hand') = saf.on(3), 'S6: Warehouse Operator reads Alma only');
reset role; select saf.as_owner();
-- Two grants: revoking one keeps the other's contribution.
select public.sa_assign_role(saf.u(1), saf.u(36), saf.role('inventory-viewer'), saf.o(1), array[saf.s(2)], now(), null, 'Also Balakong');
select saf.as_api_user(saf.u(36)); set role authenticated;
select saf.expect(saf.orgs('vw_inventory_on_hand') = saf.on(2, 3), 'S6: viewer + operator → both warehouses');
reset role; select saf.as_owner();
select public.sa_revoke_assignment(saf.u(1), saf.assignment(saf.u(36), 'warehouse-operator'), 'operator duty ended');
select saf.as_api_user(saf.u(36)); set role authenticated;
select saf.expect(saf.orgs('vw_inventory_on_hand') = saf.on(2), 'S6: operator revoked → viewer contribution remains');
reset role; select saf.as_owner();
-- Root Access: every organization in S&A, still inside the tenant rule.
select saf.expect(public.sa_bootstrap_root_access(saf.u(35), 'Initial Root Administrator for inventory tests (SEC-300)') is not null, 'Root bootstrapped');
select saf.as_api_user(saf.u(35)); set role authenticated;
select saf.expect(saf.orgs('vw_inventory_on_hand') = saf.on(1, 2, 3), 'S6: Root Administrator reads inventory (tenant boundary kept)');
reset role; select saf.as_owner();
-- Legacy level does not count once S&A decides: u3 (HQ level 10, no grant).
select saf.as_api_user(saf.u(3)); set role authenticated;
select saf.expect(saf.orgs('vw_inventory_on_hand') = '', 'S6: legacy role level alone is not inventory authority');
reset role; select saf.as_owner();
-- Service role (server routes) is not filtered.
select set_config('request.jwt.claims', '{"role":"service_role"}', false); set role service_role;
select saf.expect(saf.orgs('vw_inventory_on_hand') = saf.on(1, 2, 3, 5), 'service role unaffected');
reset role; select saf.as_owner();

-- ── Scenario 7: multi-organization ─────────────────────────────────────────────────────────────────────────────────
select saf.as_api_user(saf.u(12)); set role authenticated;
select saf.expect(saf.orgs('vw_inventory_on_hand') = '' and saf.orgs('v_stock_movements_display', 'to_organization_id') = '', 'S7: shop account reads no inventory');
reset role; select saf.as_owner();
select saf.as_api_user(saf.u(8)); set role authenticated;
select saf.expect(saf.orgs('vw_inventory_on_hand') = '' and saf.orgs('product_inventory') = '', 'S7: manufacturer account reads no inventory');
reset role; select saf.as_owner();
select saf.expect(saf.try(format($q$select public.sa_assign_role(%L, %L, %L, %L, array[%L]::uuid[], now(), null, 'shop attempt')$q$,
  saf.u(35), saf.u(12), saf.role('inventory-viewer'), saf.o(6), saf.s(7))) like 'sa_profile_not_applicable%', 'S7: Inventory Viewer not grantable to a shop, even by Root');

-- ── Legacy mode: tenant rule exactly as before for the table; the views lose only their cross-tenant leak ───────────
update public.sa_migration_modes set mode = 'SHADOW' where permission_key = 'inventory.stock.view';
select saf.as_api_user(saf.u(30)); set role authenticated;
select saf.expect(saf.orgs('product_inventory') = saf.on(1, 2, 3), 'legacy: table read unchanged (tenant rule)');
select saf.expect(saf.orgs('vw_inventory_on_hand') = saf.on(1, 2, 3), 'legacy: view limited to the tenant (no other tree)');
reset role; select saf.as_owner();
select saf.as_api_user(saf.u(12)); set role authenticated;
select saf.expect(saf.orgs('vw_inventory_on_hand') = saf.on(5), 'legacy: shop reads its own tree only (parent distributor)');
reset role; select saf.as_owner();
update public.sa_migration_modes set mode = 'NEW_ENFORCED' where permission_key = 'inventory.stock.view';
