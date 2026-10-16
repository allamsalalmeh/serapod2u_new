-- Warehouse Manager fixtures (never real data). Builds on sa_inventory_stock_view's fixtures:
--   o1 HQ, o2 Balakong WH and o3 Alma WH under HQ, o5 North Distributor (other tree), o11 South Distributor under HQ.
-- New `warehouse` scope definitions (the canonical type the Grant Policy picker offers for a warehouse):
--   s(21) warehouse Balakong, s(22) warehouse Alma.
-- People (all HQ members, level 50), granted BEFORE 20261109100000 so they are existing holders:
--   u40 Warehouse Manager on warehouse Balakong (the orderapp@dev.com situation)
--   u41 Warehouse Manager on the HQ organization scope
--   u43 Warehouse Manager on warehouse Balakong + Order Approver on HQ
--   u44 Warehouse Manager on warehouse Alma
do $g$ begin if current_database() !~ '^sa_prof_test' then raise exception 'Refusing: not a disposable sa_prof_test* database'; end if; end $g$;
insert into public.sa_scope_definitions(id, organization_id, scope_type, scope_value, display_name) values
  (saf.s(21), saf.o(2), 'warehouse', saf.o(2)::text, 'Serapod Warehouse Balakong'),
  (saf.s(22), saf.o(3), 'warehouse', saf.o(3)::text, 'Alma WH');
insert into auth.users(id, email) select saf.u(n), 'u' || n || '@dev.com' from unnest(array[40, 41, 43, 44]) n;
insert into public.users(id, email, full_name, role_code, organization_id, is_active) values
  (saf.u(40), 'u40@dev.com', 'Warehouse Manager Balakong', 'GUEST', saf.o(1), true),
  (saf.u(41), 'u41@dev.com', 'Warehouse Manager HQ', 'GUEST', saf.o(1), true),
  (saf.u(43), 'u43@dev.com', 'Warehouse Manager + Approver', 'GUEST', saf.o(1), true),
  (saf.u(44), 'u44@dev.com', 'Warehouse Manager Alma', 'GUEST', saf.o(1), true);
insert into public.sa_organization_memberships(user_id, organization_id, membership_type, is_primary, status)
select saf.u(n), saf.o(1), 'employee', true, 'active' from unnest(array[40, 41, 43, 44]) n;

-- Staging modes: the whole Inventory module and the catalogue are S&A-authoritative.
insert into public.sa_migration_modes(permission_key, mode)
select p.permission_key, 'LEGACY_RETIRED' from public.sa_permissions p
where p.permission_key like 'inventory.%' and p.permission_key <> 'inventory.stock.view'
   or p.permission_key like 'product.%' or p.permission_key in ('qr.batch.manage', 'warehouse.receipt.post', 'platform.organization.manage')
on conflict (permission_key) do update set mode = excluded.mode;

select public.sa_assign_role(saf.u(1), saf.u(40), saf.role('warehouse-manager'), saf.o(1), array[saf.s(21)], now(), null, 'Balakong warehouse manager (fixture)');
select public.sa_assign_role(saf.u(1), saf.u(41), saf.role('warehouse-manager'), saf.o(1), array[saf.s(1)], now(), null, 'HQ warehouse manager (fixture)');
select public.sa_assign_role(saf.u(1), saf.u(43), saf.role('warehouse-manager'), saf.o(1), array[saf.s(21)], now(), null, 'Balakong warehouse manager (fixture)');
select public.sa_assign_role(saf.u(1), saf.u(43), saf.role('order-approver'), saf.o(1), array[saf.s(1)], now(), null, 'Approves HQ orders (fixture)');
select public.sa_assign_role(saf.u(1), saf.u(44), saf.role('warehouse-manager'), saf.o(1), array[saf.s(22)], now(), null, 'Alma warehouse manager (fixture)');

-- Decision on an organization only / on a warehouse (organization + warehouse_id), as the application sends them.
create function saf.org_allows(p_user uuid, p_key text, p_org uuid) returns boolean language sql as $$
  select (public.sa_evaluate_permission(p_user, p_key, jsonb_build_object('organization_id', p_org))->>'decision') = 'ALLOW' $$;
create function saf.wh_allows(p_user uuid, p_key text, p_wh uuid) returns boolean language sql as $$
  select (public.sa_evaluate_permission(p_user, p_key, jsonb_build_object('organization_id', p_wh, 'warehouse_id', p_wh))->>'decision') = 'ALLOW' $$;
create function saf.readable(p_user uuid, p_key text) returns text language sql as $$
  select coalesce(string_agg(x::text, ',' order by x::text), '') from unnest(public.sa_readable_organizations(p_user, p_key)) x $$;
create function saf.wm_keys() returns text[] language sql stable as $$ select saf.keys(saf.role('warehouse-manager')) $$;
grant execute on all functions in schema saf to public;
