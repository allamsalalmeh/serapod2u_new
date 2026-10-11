-- Isolated inventory fixtures (never real data). Builds on the sa_group_policies / sa_root_access fixtures:
--   o1 HQ, o2 Balakong WH and o3 Alma WH under HQ, o4 manufacturer, o5 North Distributor (own tree), o6 shop under o5.
--   u1 legacy Super Admin with S&A authority | u3 plain HQ level-10 member | u8 manufacturer user | u9 Supply Chain Full
--   Access (HQ scope) | u12 shop staff (o6).
-- New: o11 South Distributor under HQ.
--   u30 HQ level 50, no grant (the orderapp@dev.com situation) | u31 HQ level 50 (Inventory Viewer, Balakong only)
--   u32 HQ level 50, Order Approver only | u33 HQ level 50, Order Creator | u34 distributor (o11) level 50, Order Creator
--   u35 HQ level 50, Root Administrator | u36 HQ level 50 (Warehouse Operator, Alma only)
do $g$ begin if current_database() !~ '^sa_prof_test' then raise exception 'Refusing: not a disposable sa_prof_test* database'; end if; end $g$;
insert into public.roles(role_code, role_name, role_level) values ('GUEST', 'Guest', 50), ('DIST_USER', 'Distributor User', 50)
  on conflict (role_code) do nothing;
insert into public.organizations(id, org_name, org_type_code, parent_org_id) values (saf.o(11), 'South Distributor', 'DIST', saf.o(1));
insert into public.sa_scope_definitions(id, organization_id, scope_type, scope_value, display_name) values
  (saf.s(11), saf.o(11), 'organization', saf.o(11)::text, 'South Distributor');
insert into auth.users(id, email) select saf.u(n), 'u' || n || '@dev.com' from generate_series(30, 36) n;
insert into public.users(id, email, full_name, role_code, organization_id, is_active) values
  (saf.u(30), 'u30@dev.com', 'No Supply Chain', 'GUEST', saf.o(1), true),
  (saf.u(31), 'u31@dev.com', 'Inventory Viewer Balakong', 'GUEST', saf.o(1), true),
  (saf.u(32), 'u32@dev.com', 'Order Approver Only', 'GUEST', saf.o(1), true),
  (saf.u(33), 'u33@dev.com', 'Order Creator HQ', 'GUEST', saf.o(1), true),
  (saf.u(34), 'u34@dev.com', 'Order Creator Distributor', 'DIST_USER', saf.o(11), true),
  (saf.u(35), 'u35@dev.com', 'Root HQ', 'GUEST', saf.o(1), true),
  (saf.u(36), 'u36@dev.com', 'Warehouse Operator Alma', 'GUEST', saf.o(1), true);
insert into public.sa_organization_memberships(user_id, organization_id, membership_type, is_primary, status)
select saf.u(n), saf.o(1), 'employee', true, 'active' from unnest(array[30, 31, 32, 33, 35, 36]) n;
insert into public.sa_organization_memberships(user_id, organization_id, membership_type, is_primary, status) values
  (saf.u(34), saf.o(11), 'partner', true, 'active');

-- The whole Inventory module is S&A-authoritative (staging), so the migration seeds inventory.stock.view NEW_ENFORCED.
insert into public.sa_migration_modes(permission_key, mode)
select k, 'LEGACY_RETIRED' from unnest(array['inventory.report.view', 'inventory.adjustment.post', 'supply_chain.order.create',
  'supply_chain.order.approve', 'inventory.transfer.request', 'inventory.transfer.dispatch', 'inventory.transfer.receive',
  'inventory.stock_count.view', 'inventory.stock_count.create']) k
where exists (select 1 from public.sa_permissions p where p.permission_key = k)
on conflict (permission_key) do update set mode = excluded.mode;

-- Catalogue rows and balances.
insert into public.brands(id, brand_name) values ('00000000-0000-0000-000b-000000000001', 'Brand');
insert into public.products(id, product_name, product_code, brand_id) values ('00000000-0000-0000-0008-000000000001', 'Pod', 'P1', '00000000-0000-0000-000b-000000000001');
insert into public.product_variants(id, product_id, variant_code, variant_name) values ('00000000-0000-0000-0009-000000000001', '00000000-0000-0000-0008-000000000001', 'V1', 'Pod Mint');
insert into public.inventory_stock_configurations(id, variant_id, config_code, status) values
  ('00000000-0000-0000-000c-000000000001', '00000000-0000-0000-0009-000000000001', 'STD', 'active');
insert into public.product_inventory(variant_id, organization_id, quantity_on_hand, quantity_allocated, reorder_point, stock_config_id)
select '00000000-0000-0000-0009-000000000001', o, q, 5, 1000, '00000000-0000-0000-000c-000000000001'
from (values (saf.o(1), 10), (saf.o(2), 100), (saf.o(3), 200), (saf.o(5), 300)) v(o, q);
insert into public.stock_movements(movement_type, variant_id, to_organization_id, quantity_change, stock_config_id)
select 'manual_in', '00000000-0000-0000-0009-000000000001', o, 50, '00000000-0000-0000-000c-000000000001'
from unnest(array[saf.o(2), saf.o(3), saf.o(5)]) o;

-- Grants that do not depend on the new migration.
select public.sa_assign_role(saf.u(1), saf.u(32), saf.role('order-approver'), saf.o(1), array[saf.s(1)], now(), null, 'Approves HQ orders (fixture)');
select public.sa_assign_role(saf.u(1), saf.u(36), saf.role('warehouse-operator'), saf.o(1), array[saf.s(3)], now(), null, 'Alma operator (fixture)');

-- Organizations whose rows the current caller reads, through a relation (sorted, '' when none).
create function saf.orgs(p_rel text, p_col text default 'organization_id') returns text language plpgsql as $$
declare v text;
begin
  execute format('select coalesce(string_agg(distinct x::text, %L order by x::text), %L) from (select %I as x from public.%I) t', ',', '', p_col, p_rel) into v;
  return v;
end $$;
-- The same list of organizations, by fixture number, for readable assertions.
create function saf.on(variadic p_n int[]) returns text language sql immutable as $$
  select coalesce(string_agg(saf.o(n)::text, ',' order by saf.o(n)::text), '') from unnest(p_n) n $$;
create function saf.assignment(p_user uuid, p_role text) returns uuid language sql stable as $$
  select a.id from public.sa_role_assignments a where a.user_id = p_user and a.role_id = saf.role(p_role) and a.status = 'active' $$;
grant usage on schema saf to public;
grant execute on all functions in schema saf to public;
