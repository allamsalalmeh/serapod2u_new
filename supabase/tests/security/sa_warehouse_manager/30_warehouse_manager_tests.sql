-- After 20261109100000 (applied twice) and the unchanged inventory suite.
-- Balances: o1 (HQ) 10, o2 (Balakong) 100, o3 (Alma) 200, o5 (North Distributor, other tree) 300.

-- ── Policy definition ────────────────────────────────────────────────────────────────────────────────────────────
select saf.expect(cardinality(saf.wm_keys()) = 19 and saf.wm_keys() @> array[
  'inventory.adjustment.post', 'inventory.opening_balance.manage', 'inventory.report.view', 'inventory.return.manage',
  'inventory.return.request', 'inventory.stock.view', 'inventory.stock_config.manage', 'inventory.stock_count.create',
  'inventory.stock_count.post', 'inventory.stock_count.verify', 'inventory.stock_count.view', 'inventory.transfer.approve',
  'inventory.transfer.cancel', 'inventory.transfer.dispatch', 'inventory.transfer.receive', 'inventory.transfer.request',
  'inventory.transfer.view', 'product.catalog.manage', 'product.catalog.view'], 'Warehouse Manager = exactly the 19 Products/Inventory/Returns keys');
select saf.expect(not exists (select 1 from unnest(saf.wm_keys()) k where k like 'supply_chain.%' or k like 'qr.%' or k like 'warehouse.%'
  or k like 'manufacturing.%' or k like 'platform.%'), 'no Order Management, QR Tracking or Organizations key');
select saf.expect((select permission_keys from public.sa_standard_policy_coverage where role_key = 'warehouse-manager') = saf.wm_keys(),
  'coverage row = live set (drift report stays clean)');
select saf.expect((select count(*) from public.sa_business_roles where role_key = 'warehouse-manager') = 1, 'the same policy was updated (no duplicate)');
select saf.expect((select count(*) from public.sa_access_change_log where action = 'access_profile.standard_extended' and details->>'role_key' = 'warehouse-manager') = 1,
  'extension audited once (second application unchanged)');
select saf.expect((select count(*) from public.sa_access_change_log where action = 'assignment.profile_changed'
  and target_user_id in (saf.u(40), saf.u(41), saf.u(43), saf.u(44))) = 4, 'every active holder audited once');
select saf.expect((select count(*) from public.sa_role_assignments a where a.role_id = saf.role('warehouse-manager')) = 4
  and (select count(*) from public.sa_role_assignments a where a.role_id = saf.role('warehouse-manager') and a.status = 'active') = 4,
  'existing grants kept as they were (no re-grant, no new rows)');
select saf.expect((select array_agg(x.scope_id) from public.sa_assignment_scopes x where x.assignment_id = saf.assignment(saf.u(40), 'warehouse-manager')) = array[saf.s(21)],
  'Balakong grant keeps its warehouse scope');

-- ── Warehouse scope (u40, Balakong only) ─────────────────────────────────────────────────────────────────────────
select saf.expect(bool_and(saf.org_allows(saf.u(40), k, saf.o(2))), 'every key ALLOWED on the Balakong organization (warehouse is its own org)')
from unnest(saf.wm_keys()) k;
select saf.expect(bool_and(saf.wh_allows(saf.u(40), k, saf.o(2))), 'every key ALLOWED with Balakong warehouse context') from unnest(saf.wm_keys()) k;
select saf.expect(not bool_or(saf.org_allows(saf.u(40), k, saf.o(3)) or saf.wh_allows(saf.u(40), k, saf.o(3))), 'nothing in Alma (sibling warehouse)')
from unnest(saf.wm_keys()) k;
select saf.expect(not bool_or(saf.org_allows(saf.u(40), k, saf.o(1))), 'nothing on the HQ organization (no upward reach)') from unnest(saf.wm_keys()) k;
select saf.expect((public.sa_evaluate_permission(saf.u(40), 'product.catalog.manage', jsonb_build_object('organization_id', saf.o(1)))->>'reason_code') = 'MISSING_CONTEXT',
  'scope conflict: HQ product master data stays out of reach of a warehouse-only grant');
select saf.expect(not bool_or(saf.org_allows(saf.u(40), k, saf.o(5)) or saf.org_allows(saf.u(40), k, saf.o(11))), 'nothing in distributors')
from unnest(saf.wm_keys()) k;
select saf.expect(not bool_or(saf.org_allows(saf.u(40), k, saf.o(2))), 'excluded areas stay denied in Balakong')
from unnest(array['supply_chain.order.create', 'supply_chain.order.approve', 'qr.batch.manage', 'warehouse.receipt.post', 'platform.organization.manage']) k;
select saf.expect(saf.readable(saf.u(40), 'inventory.stock_count.view') = saf.on(2), 'list scope: exactly Balakong');
select saf.expect(saf.readable(saf.u(40), 'inventory.stock.view') = saf.on(2), 'View Inventory list scope: exactly Balakong');
select saf.expect(saf.readable(saf.u(40), 'supply_chain.order.create') = '', 'list scope of a key the policy lacks: nothing');
select saf.expect(saf.readable(saf.u(44), 'inventory.stock.view') = saf.on(3), 'Alma manager: exactly Alma');

select saf.as_api_user(saf.u(40)); set role authenticated;
select saf.expect(saf.orgs('product_inventory') = saf.on(2), 'reads: Balakong stock only (not HQ, Alma, distributors)');
select saf.expect(saf.orgs('vw_inventory_on_hand') = saf.on(2), 'Inventory view: Balakong only');
select saf.expect(saf.orgs('v_stock_movements_display', 'to_organization_id') = saf.on(2), 'movements: Balakong only');
select saf.expect((select count(*) from public.product_inventory where organization_id = saf.o(3)) = 0, 'a chosen Alma id returns nothing');
select saf.expect(saf.try(format($q$update public.product_inventory set quantity_on_hand = 1 where organization_id = %L$q$, saf.o(2))) not like 'sa_authorization_required%',
  'stock write guard lets the Balakong manager write Balakong');
select saf.expect(saf.try(format($q$select public.sa_api_require_any_org('inventory.adjustment.post', array[%L::uuid])$q$, saf.o(3))) like 'sa_authorization_required%',
  'write gate refuses Alma');
select saf.expect(saf.try(format($q$select public.sa_api_require_any_org('inventory.adjustment.post', array[%L::uuid])$q$, saf.o(1))) like 'sa_authorization_required%',
  'write gate refuses HQ');
reset role; select saf.as_owner();
update public.product_inventory set quantity_on_hand = 100 where organization_id = saf.o(2);

-- ── Organization scope (u41, HQ): the whole policy works, and reaches every HQ warehouse ──────────────────────────
select saf.expect(bool_and(saf.org_allows(saf.u(41), k, saf.o(1))), 'HQ-scoped manager: every key on HQ (catalogue, settings, returns)')
from unnest(saf.wm_keys()) k;
select saf.expect(saf.readable(saf.u(41), 'inventory.stock.view') = saf.on(1, 2, 3, 11), 'HQ scope reaches HQ and everything below it, not another tree');

-- ── Multiple policies (u43: Warehouse Manager Balakong + Order Approver HQ) ──────────────────────────────────────
select saf.expect(saf.org_allows(saf.u(43), 'supply_chain.order.approve', saf.o(1)), 'approver keeps approving on HQ');
select saf.expect(saf.org_allows(saf.u(43), 'inventory.stock.view', saf.o(2)) and not saf.org_allows(saf.u(43), 'inventory.stock.view', saf.o(3)),
  'inventory still limited to Balakong');
select saf.expect(not saf.org_allows(saf.u(43), 'supply_chain.order.approve', saf.o(5)), 'approval does not leak to another tree');

-- ── Revoke, re-grant ─────────────────────────────────────────────────────────────────────────────────────────────
select public.sa_revoke_assignment(saf.u(1), saf.assignment(saf.u(40), 'warehouse-manager'), 'Revoked for the test');
select saf.expect(not bool_or(saf.org_allows(saf.u(40), k, saf.o(2))), 'revoked: nothing in Balakong') from unnest(saf.wm_keys()) k;
select saf.expect(saf.readable(saf.u(40), 'inventory.stock.view') = '', 'revoked: list scope empty');
select saf.as_api_user(saf.u(40)); set role authenticated;
select saf.expect(saf.orgs('product_inventory') = '', 'revoked: no stock rows');
reset role; select saf.as_owner();
select public.sa_assign_role(saf.u(1), saf.u(40), saf.role('warehouse-manager'), saf.o(1), array[saf.s(21)], now(), null, 'Granted again for the test');
select saf.expect(bool_and(saf.org_allows(saf.u(40), k, saf.o(2))), 'granted again: current definition applies at once') from unnest(saf.wm_keys()) k;
-- Expired grant.
update public.sa_role_assignments set effective_from = now() - interval '2 days', effective_until = now() - interval '1 minute' where id = saf.assignment(saf.u(44), 'warehouse-manager');
select saf.expect(not saf.org_allows(saf.u(44), 'inventory.stock.view', saf.o(3)) and saf.readable(saf.u(44), 'inventory.stock.view') = '',
  'expired: nothing');

-- ── Other scope types are unchanged ──────────────────────────────────────────────────────────────────────────────
select saf.expect(public.sa_scope_matches(saf.u(40), 'warehouse', saf.o(2)::text, jsonb_build_object('organization_id', saf.o(1)), array[saf.o(1)]) is null,
  'warehouse scope vs the parent HQ: still missing context');
select saf.expect(public.sa_scope_matches(saf.u(40), 'warehouse', saf.o(2)::text, jsonb_build_object('organization_id', saf.o(2), 'warehouse_id', saf.o(3)), array[saf.o(2), saf.o(1)]) = false,
  'explicit warehouse_id still decides');
select saf.expect(public.sa_scope_matches(saf.u(40), 'organization', saf.o(2)::text, jsonb_build_object('organization_id', saf.o(1)), array[saf.o(1)]) = false,
  'organization scope unchanged');
select saf.expect(public.sa_scope_matches(saf.u(40), 'territory', 'north', jsonb_build_object('organization_id', saf.o(1)), array[saf.o(1)]) is null,
  'typed scopes unchanged');
