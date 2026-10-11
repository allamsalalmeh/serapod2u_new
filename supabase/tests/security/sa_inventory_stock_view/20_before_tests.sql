-- Negative control on the UNPATCHED schema: reproduces the reported exposure. Every assertion here describes the bug.
-- u30 = HQ level 50 with no Supply Chain grant (orderapp@dev.com after revocation); u12 = shop staff of another tree.
select saf.as_api_user(saf.u(30)); set role authenticated;
select saf.expect(saf.orgs('product_inventory') = saf.on(1, 2, 3), 'before: no grant, HQ tenant rule alone exposes every HQ warehouse balance');
select saf.expect(saf.orgs('vw_inventory_on_hand') = saf.on(1, 2, 3, 5), 'before: vw_inventory_on_hand exposes every organization, even outside the tenant');
select saf.expect(saf.orgs('v_low_stock_alerts') = saf.on(1, 2, 3, 5), 'before: v_low_stock_alerts exposes every organization');
select saf.expect(saf.orgs('vw_manual_stock_balance', 'warehouse_id') = saf.on(2, 3, 5), 'before: manual balances of every warehouse');
reset role; select saf.as_owner();
select saf.as_api_user(saf.u(12)); set role authenticated;
select saf.expect(saf.orgs('vw_inventory_on_hand') = saf.on(1, 2, 3, 5), 'before: a shop account reads HQ inventory through the view');
select saf.expect(saf.orgs('v_stock_movements_display', 'to_organization_id') = saf.on(2, 3, 5), 'before: a shop account reads every movement');
reset role; select saf.as_owner();
