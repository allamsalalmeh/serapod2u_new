-- After 20261107100000 (applied twice), staging modes: inventory S&A-authoritative.
-- Movements: 1 +100→WH1 | 2 WH1→DIST1 alloc | 3 WH1→DIST1 transfer | 4 DIST1 adj | 5 WH1→WH2 | 6 →HQ
--            7 →XWH (unrelated company) | 8 DIST1→SHOP1 | 9 WH2→DIST2 fulfilment | 10 DIST2 adj
-- v_stock_movements_display additionally hides nothing here (no empty fulfilment rows, every row has an org).

-- ── Definition ──────────────────────────────────────────────────────────────────────────────────────────────────
select smt.expect(not has_table_privilege('authenticated', 'public.stock_movements', 'SELECT'), 'def: no table-level SELECT on stock_movements');
select smt.expect(not has_column_privilege('authenticated', 'public.stock_movements', 'unit_cost', 'SELECT')
  and not has_column_privilege('authenticated', 'public.stock_movements', 'total_cost', 'SELECT')
  and not has_column_privilege('authenticated', 'public.stock_movements', 'quantity_before', 'SELECT')
  and not has_column_privilege('authenticated', 'public.stock_movements', 'quantity_after', 'SELECT'), 'def: cost/balance columns revoked');
select smt.expect(has_table_privilege('authenticated', 'public.vw_stock_movements_ordered', 'SELECT')
  and not has_table_privilege('anon', 'public.vw_stock_movements_ordered', 'SELECT'), 'def: report view granted to authenticated only');
select smt.expect((select count(*) from pg_policy where polrelid = 'public.stock_movements'::regclass and polcmd = 'r') = 1, 'def: one SELECT policy on stock_movements');
select smt.expect((select count(*) from public.sa_inventory_view_originals where view_name like '%.20261107' or view_name = 'stock_movements.stock_movements_view_all') = 3,
  'def: originals recorded once for rollback');

-- ── 1/12. HQ inventory user (Supply Chain Full Access, HQ scope) ──────────────────────────────────────────────────
begin; select smt.as_user(1); set local role authenticated;
select smt.expect(smt.try('select * from public.vw_stock_movements_ordered') is null, 'S1: report view loads (no 403)');
select smt.expect(smt.ids('select id from public.vw_stock_movements_ordered') = '1,2,3,4,5,6,8,9,10', 'S1: every company-A movement, not the unrelated company');
select smt.expect((select unit_cost from public.vw_stock_movements_ordered where id = smt.m(2)) = 10.00
  and (select total_cost from public.vw_stock_movements_ordered where id = smt.m(2)) = 200.00, 'S1: HQ sees unit and total cost');
select smt.expect((select quantity_before from public.vw_stock_movements_ordered where id = smt.m(2)) = 100
  and (select quantity_after from public.vw_stock_movements_ordered where id = smt.m(2)) = 120, 'S1: HQ sees balances');
select smt.expect((select organization_name from public.vw_stock_movements_ordered where id = smt.m(2)) = 'Test Distributor 1'
  and (select product_name from public.vw_stock_movements_ordered where id = smt.m(2)) = 'Test Product', 'S1: joined labels present');
select smt.expect(smt.ids('select id from public.v_stock_movements_display') = '1,2,3,4,5,6,8,9,10', 'S1/10: display view = same rows');
select smt.expect(smt.ids('select id from public.stock_movements') = '1,2,3,4,5,6,8,9,10', 'S1/10: base table = same rows');
-- 14. Filters, pagination, sorting (the report''s PostgREST query shape)
select smt.expect(smt.ids(format('select id from public.vw_stock_movements_ordered where from_organization_id = %L or to_organization_id = %L', smt.o(2), smt.o(2))) = '1,2,3,5',
  'S14: location filter (Warehouse 1)');
select smt.expect(smt.ids($q$select id from public.vw_stock_movements_ordered where movement_type = 'adjustment'$q$) = '4,5,10', 'S14: movement type filter');
select smt.expect(smt.ids($q$select id from public.vw_stock_movements_ordered where reference_type = 'transfer'$q$) = '3,6,8', 'S14: reference type filter');
select smt.expect(smt.ids($q$select id from public.vw_stock_movements_ordered where created_at >= '2026-10-01T05:00:00Z' and created_at <= '2026-10-01T08:59:59Z'$q$) = '5,6,8', 'S14: date range');
select smt.expect((select string_agg(right(id::text, 2), ',') from (select id from public.vw_stock_movements_ordered order by created_at desc nulls last, id desc limit 3 offset 3) q) = '06,05,04',
  'S14: page 2 (size 3) newest first');
select smt.expect((select sum(quantity_change) from public.vw_stock_movements_ordered where quantity_change > 0) = 150
  and (select sum(quantity_change) from public.vw_stock_movements_ordered where quantity_change < 0) = -18, 'S14: increase/decrease totals');
select smt.expect((select count(*) from public.vw_stock_movements_ordered) = 9, 'S14: total count for the summary card');
select smt.expect(smt.try('select count(*) from public.stock_movements') is null, 'S11: count(*) on the table still works (Orders delete preview)');
rollback;

-- ── 2. Warehouse operator (Warehouse 1 only) ─────────────────────────────────────────────────────────────────────
begin; select smt.as_user(2); set local role authenticated;
select smt.expect(smt.ids('select id from public.vw_stock_movements_ordered') = '1,2,3,5', 'S2: only movements touching Warehouse 1');
select smt.expect(smt.ids('select id from public.v_stock_movements_display') = '1,2,3,5', 'S2/10: display view consistent');
select smt.expect(smt.ids('select id from public.stock_movements') = '1,2,3,5', 'S2/10: base table consistent');
select smt.expect((select unit_cost from public.vw_stock_movements_ordered where id = smt.m(5)) = 10.00
  and (select quantity_before from public.vw_stock_movements_ordered where id = smt.m(2)) = 100, 'S2: warehouse (HQ side) sees cost and balance');
select smt.expect(smt.n(format('select 1 from public.vw_stock_movements_ordered where to_organization_id = %L', smt.o(5))) = 0,
  'S2: Warehouse 2 → Distributor 2 fulfilment not visible');
-- 11. Workflow readers keep working (InventoryView, receipt summary, incoming transfers)
select smt.expect(smt.try('select variant_id, stock_config_id, to_organization_id, from_organization_id, quantity_change, movement_type, reference_id, reference_type, reference_no, created_at from public.stock_movements') is null,
  'S11: operational columns readable from the table');
select smt.expect(smt.try('select * from public.v_incoming_transfers_detail') is null, 'S11: v_incoming_transfers_detail (invoker) still works');
rollback;

-- ── 3/13. Order Creator without an inventory permission (HQ, legacy level 10) ─────────────────────────────────────
begin; select smt.as_user(3); set local role authenticated;
select smt.expect(smt.n('select id from public.vw_stock_movements_ordered') = 0, 'S3: report view returns nothing (no inventory permission)');
select smt.expect(smt.n('select id from public.v_stock_movements_display') = 0, 'S3: display view nothing');
select smt.expect(smt.n('select id from public.stock_movements') = 0, 'S3: base table nothing');
select smt.expect(smt.n(format('select id from public.stock_movements where from_organization_id = %L', smt.o(2))) = 0, 'S3: a chosen warehouse id does not help');
rollback;

-- ── 4/8. Distributor 1 (View Inventory on Distributor 1 + Order Creator) ─────────────────────────────────────────
begin; select smt.as_user(4); set local role authenticated;
select smt.expect(smt.ids('select id from public.vw_stock_movements_ordered') = '2,3,4,8', 'S4: only movements involving Distributor 1 / its shop');
select smt.expect(smt.ids('select id from public.stock_movements') = '2,3,4,8', 'S4/10: base table consistent');
select smt.expect(smt.ids('select id from public.v_stock_movements_display') = '2,3,4,8', 'S4/10: display view consistent');
select smt.expect((select count(*) from public.vw_stock_movements_ordered where unit_cost is not null or total_cost is not null) = 0,
  'S4: no unit or total cost on any row');
select smt.expect((select count(*) from public.v_stock_movements_display where unit_cost is not null) = 0, 'S4: no cost through the display view');
select smt.expect((select quantity_before is null and quantity_after is null and quantity_change = 20 from public.vw_stock_movements_ordered where id = smt.m(2)),
  'S8: WH1→DIST1 allocation: HQ warehouse balance masked, quantity moved shown');
select smt.expect((select quantity_before = 20 and quantity_after = 18 from public.vw_stock_movements_ordered where id = smt.m(4)), 'S8: own adjustment balances shown');
select smt.expect((select quantity_before = 0 and quantity_after = 3 from public.vw_stock_movements_ordered where id = smt.m(8)), 'S8: DIST1→own shop balances shown');
-- 9. Direct PostgREST on the table
select smt.expect(smt.try('select unit_cost from public.stock_movements') like '42501%', 'S9: unit_cost denied on the table');
select smt.expect(smt.try('select total_cost from public.stock_movements') like '42501%', 'S9: total_cost denied');
select smt.expect(smt.try('select quantity_before from public.stock_movements') like '42501%', 'S9: quantity_before denied');
select smt.expect(smt.try('select * from public.stock_movements') like '42501%', 'S9: select=* denied (no cost through wildcard)');
select smt.expect(smt.try(format('select 1 from public.stock_movements where unit_cost > 0 and id = %L', smt.m(2))) like '42501%', 'S9: cannot probe cost through a filter');
-- Stock balances: no HQ/warehouse rows even through the ordering exception
select smt.expect((select string_agg(organization_id::text, ',') from public.product_inventory) = smt.o(4)::text, 'S4: product_inventory = Distributor 1 only (no HQ/WH rows)');
select smt.expect(smt.n('select 1 from public.vw_inventory_on_hand where average_cost is not null') = 0, 'S4: no HQ average cost via vw_inventory_on_hand');
select smt.expect(smt.n(format('select 1 from public.vw_hq_consolidated_warehouse_inventory')) = 0, 'S4: HQ consolidated warehouse inventory empty');
rollback;

-- ── 5. Shop user (Order Creator only) ────────────────────────────────────────────────────────────────────────────
begin; select smt.as_user(5); set local role authenticated;
select smt.expect(smt.n('select id from public.vw_stock_movements_ordered') = 0 and smt.n('select id from public.stock_movements') = 0, 'S5: shop reads no movements');
select smt.expect((select string_agg(organization_id::text, ',') from public.product_inventory) = smt.o(4)::text,
  'S5/11: ordering availability: parent distributor only, never the HQ row or cost');
rollback;

-- ── 6. Manufacturer holding the HQ role (level 10) + View Inventory on its own MFG org ─────────────────────────────
begin; select smt.as_user(6); set local role authenticated;
select smt.expect(smt.n('select id from public.vw_stock_movements_ordered') = 0 and smt.n('select id from public.stock_movements') = 0
  and smt.n('select id from public.v_stock_movements_display') = 0, 'S6: no HQ / other-company movements despite level 10');
select smt.expect(smt.n('select 1 from public.product_inventory') = 0, 'S6: no stock balances outside its own organization');
select smt.expect(smt.try('select unit_cost from public.stock_movements') like '42501%', 'S6: cost column denied');
rollback;

-- ── 7. HQ admin (level 10, Supply Chain Full Access on company A) vs the unrelated company ─────────────────────────
begin; select smt.as_user(7); set local role authenticated;
select smt.expect(smt.ids('select id from public.vw_stock_movements_ordered') = '1,2,3,4,5,6,8,9,10', 'S7: own company in full');
select smt.expect(smt.n(format('select 1 from public.vw_stock_movements_ordered where to_organization_id = %L', smt.o(9))) = 0
  and smt.n(format('select 1 from public.stock_movements where to_organization_id = %L', smt.o(9))) = 0
  and smt.n(format('select 1 from public.product_inventory where organization_id = %L', smt.o(9))) = 0, 'S7: unrelated company invisible');
rollback;

-- ── Root Access (explicit, every organization) and the unrelated company's own user ────────────────────────────────
begin; select smt.as_user(8); set local role authenticated;
select smt.expect(smt.ids('select id from public.vw_stock_movements_ordered') = '1,2,3,4,5,6,7,8,9,10', 'S7: Root Access keeps every organization');
select smt.expect((select unit_cost from public.vw_stock_movements_ordered where id = smt.m(7)) = 99.00, 'S7: Root Access sees costs');
rollback;
begin; select smt.as_user(9); set local role authenticated;
select smt.expect(smt.ids('select id from public.vw_stock_movements_ordered') = '7', 'S7: unrelated company sees only its own movement');
rollback;

-- ── 13. Self-service-only employee, anonymous, service role ──────────────────────────────────────────────────────
begin; select smt.as_user(10); set local role authenticated;
select smt.expect(smt.n('select id from public.vw_stock_movements_ordered') = 0 and smt.n('select id from public.stock_movements') = 0, 'S13: ESS-only employee blocked');
rollback;
begin; set local role anon;
select smt.expect(smt.try('select id from public.vw_stock_movements_ordered') like '42501%' and smt.try('select id from public.stock_movements') like '42501%', 'S13: anon blocked');
rollback;
begin; select smt.as_service(); set local role service_role;
select smt.expect(smt.n('select id from public.vw_stock_movements_ordered') = 10 and (select unit_cost from public.vw_stock_movements_ordered where id = smt.m(2)) = 10.00,
  'S11: service role (server routes after their own guard) unfiltered');
select smt.expect(smt.try('select unit_cost, quantity_before from public.stock_movements') is null, 'S11: service role reads every column');
rollback;

-- ── 11. Writes still work (trigger fills cost/balance; insert as the service role, as server routes / definer RPCs do) ──
begin; select smt.as_service(); set local role service_role;
select smt.expect(smt.try(format($q$insert into public.stock_movements(movement_type, to_organization_id, quantity_change, quantity_before, quantity_after,
  unit_cost, company_id, created_by, variant_id, stock_config_id) values ('addition', %L, 5, 0, 5, 10, %L, %L, %L, %L)$q$, smt.o(2), smt.o(1), smt.u(1), smt.o(510), smt.o(520))) is null,
  'S11: stock movement insert (service role, all triggers on)');
rollback;

-- ── 15. Invoker functions over stock_movements reference no revoked column ───────────────────────────────────────
select smt.expect(coalesce((select string_agg(p.proname, ', ') from pg_proc p
  where p.pronamespace = 'public'::regnamespace and not p.prosecdef and p.prokind = 'f'
    and p.prorettype <> 'trigger'::regtype and p.proname <> 'fn_test_balance_request_flow'
    and p.prosrc ~* 'stock_movements' and p.prosrc ~* '\m(unit_cost|total_cost|quantity_before|quantity_after)\M'), '') = '',
  'S15: no API-callable invoker function reads a revoked stock_movements column');
