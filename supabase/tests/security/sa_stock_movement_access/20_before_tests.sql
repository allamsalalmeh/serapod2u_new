-- Negative control on the UNPATCHED staging schema (20261031 applied, 20261107 not): each check proves a defect exists.
select smt.expect((select mode from public.sa_migration_modes where permission_key = 'inventory.stock.view') = 'NEW_ENFORCED'
  and (select mode from public.sa_migration_modes where permission_key = 'inventory.report.view') = 'LEGACY_RETIRED',
  'before: staging modes (inventory S&A-authoritative)');

-- Issue A: the report view is not granted → HTTP 403 for an authorized HQ inventory user.
begin; select smt.as_user(1); set local role authenticated;
select smt.expect(smt.try('select * from public.vw_stock_movements_ordered') like '42501%permission denied%',
  'before A: HQ inventory user gets permission denied (403) on vw_stock_movements_ordered');
rollback;

-- Issue B: Order Creator (no inventory permission) reads movements through stock_movements_view_all.
begin; select smt.as_user(3); set local role authenticated;
select smt.expect(smt.n('select id from public.stock_movements') > 0, 'before B: Order Creator reads stock_movements');
rollback;

-- Issue C: distributor reads HQ unit cost and the HQ warehouse balance of a WH1→DIST1 allocation.
begin; select smt.as_user(4); set local role authenticated;
select smt.expect((select unit_cost from public.stock_movements where id = smt.m(2)) = 10.00, 'before C: distributor reads HQ unit_cost on the base table');
select smt.expect((select quantity_before from public.stock_movements where id = smt.m(2)) = 100, 'before C: distributor reads the HQ warehouse balance');
select smt.expect((select unit_cost from public.v_stock_movements_display where id = smt.m(2)) = 10.00, 'before C: distributor reads HQ unit_cost through v_stock_movements_display');
rollback;
-- Shop with Order Creator reads its HQ grandparent's inventory row and cost (ordering exception via can_access_org ancestors).
begin; select smt.as_user(5); set local role authenticated;
select smt.expect((select average_cost from public.product_inventory where organization_id = smt.o(1)) = 12.00, 'before C: shop reads HQ average_cost on product_inventory');
rollback;

-- Issue D: a manufacturer account holding the level-10 HQ role reaches an unrelated company (is_hq_admin shortcut).
begin; select smt.as_user(6); set local role authenticated;
select smt.expect(smt.n(format('select id from public.stock_movements where id = %L', smt.m(7))) = 1,
  'before D: level-10 manufacturer reads the unrelated company''s movement');
rollback;
