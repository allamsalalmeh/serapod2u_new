-- After 20261107100000 in an environment where the Inventory module is still decided by legacy rules (all inventory
-- permissions SHADOW): legacy staff/partner gate, own organization + descendants, no role-level shortcut.
begin;
set local session_replication_role = replica;   -- mode-change governance triggers are not under test here
update public.sa_migration_modes set mode = 'SHADOW' where permission_key like 'inventory.%' or permission_key like 'warehouse.%';
set local session_replication_role = origin;
select smt.expect(public.sa_inventory_stock_scope() is null, 'L0: legacy mode → stock scope NULL');

select smt.as_user(1); set local role authenticated;
select smt.expect(smt.ids('select id from public.vw_stock_movements_ordered') = '1,2,3,4,5,6,8,9,10', 'L1: HQ staff: own company tree');
select smt.expect(smt.ids('select id from public.stock_movements') = smt.ids('select id from public.v_stock_movements_display'), 'L10: table and display view agree');
reset role;

select smt.as_user(3); set local role authenticated;
select smt.expect(smt.n(format('select 1 from public.stock_movements where id = %L', smt.m(7))) = 0, 'L7: level-10 HQ account no longer reaches the unrelated company');
reset role;

select smt.as_user(6); set local role authenticated;
select smt.expect(smt.n('select id from public.stock_movements') = 0 and smt.n('select id from public.vw_stock_movements_ordered') = 0,
  'L6: level-10 manufacturer: no HQ / other-company movements');
select smt.expect(smt.n('select 1 from public.product_inventory') = 0, 'L6: no stock balances');
reset role;

select smt.as_user(4); set local role authenticated;
select smt.expect(smt.ids('select id from public.vw_stock_movements_ordered') = '2,3,4,8', 'L4: distributor: own + shop movements');
select smt.expect((select count(*) from public.vw_stock_movements_ordered where unit_cost is not null) = 0, 'L4: no cost');
select smt.expect((select quantity_before is null from public.vw_stock_movements_ordered where id = smt.m(2)), 'L4: HQ warehouse balance masked');
select smt.expect((select string_agg(organization_id::text, ',') from public.product_inventory) = smt.o(4)::text, 'L4: product_inventory own only (no HQ ancestor row)');
reset role;

select smt.as_user(5); set local role authenticated;
select smt.expect(smt.n('select id from public.stock_movements') = 0, 'L5: shop staff: no movements (not staff/partner)');
select smt.expect((select string_agg(organization_id::text, ',') from public.product_inventory) = smt.o(4)::text, 'L5: availability of the parent distributor only');
reset role;
rollback;
