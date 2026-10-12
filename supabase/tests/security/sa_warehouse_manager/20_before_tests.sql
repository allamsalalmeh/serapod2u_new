-- Negative control: the schema BEFORE 20261109100000 reproduces the reported state.
select saf.expect(cardinality(saf.wm_keys()) = 9, 'before: Warehouse Manager holds the 9 Wave 1 stock count / transfer keys');
select saf.expect(not ('inventory.stock.view' = any(saf.wm_keys())) and not ('product.catalog.view' = any(saf.wm_keys())),
  'before: no View Inventory, no catalogue');
select saf.expect((public.sa_evaluate_permission(saf.u(40), 'inventory.stock_count.view', jsonb_build_object('organization_id', saf.o(2)))->>'reason_code') = 'MISSING_CONTEXT',
  'before: a warehouse scope cannot match its own warehouse organization (MISSING_CONTEXT)');
select saf.expect(saf.wh_allows(saf.u(40), 'inventory.stock_count.view', saf.o(2)), 'before: only an explicit warehouse_id matched');
select saf.expect(saf.readable(saf.u(40), 'inventory.stock_count.view') = '', 'before: a warehouse-scoped grant reads no organization');
select saf.as_api_user(saf.u(40)); set role authenticated;
select saf.expect(saf.orgs('product_inventory') = '', 'before: the Balakong manager reads no stock at all');
select saf.expect(saf.try(format($q$update public.product_inventory set quantity_on_hand = quantity_on_hand where organization_id = %L and false$q$, saf.o(2))) = 'OK', 'before: harness sanity');
reset role; select saf.as_owner();
