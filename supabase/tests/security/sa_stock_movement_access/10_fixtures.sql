-- Synthetic organizations, users, S&A assignments, products, movements and balances. No real data.
-- Loaded as the database owner with triggers off (fixtures only; the tests run with triggers on).
do $guard$
begin
  if exists (select 1 from public.users where id not between smt.u(0) and smt.u(999)) then
    raise exception 'refusing to run: this database contains real users (use a disposable replica)';
  end if;
end $guard$;

set session_replication_role = replica;

-- Company A: HQ(1) → WH1(2), WH2(3), DIST1(4) → SHOP1(6), DIST2(5), MFG1(7). Unrelated company X: XHQ(8) → XWH(9).
insert into public.organizations(id, org_type_code, parent_org_id, org_code, org_name, is_active) values
 (smt.o(1), 'HQ',   null,      'T-HQ',    'Test HQ',            true),
 (smt.o(2), 'WH',   smt.o(1),  'T-WH1',   'Test Warehouse 1',   true),
 (smt.o(3), 'WH',   smt.o(1),  'T-WH2',   'Test Warehouse 2',   true),
 (smt.o(4), 'DIST', smt.o(1),  'T-DIST1', 'Test Distributor 1', true),
 (smt.o(5), 'DIST', smt.o(1),  'T-DIST2', 'Test Distributor 2', true),
 (smt.o(6), 'SHOP', smt.o(4),  'T-SHOP1', 'Test Shop 1',        true),
 (smt.o(7), 'MFG',  smt.o(1),  'T-MFG1',  'Test Manufacturer',  true),
 (smt.o(8), 'HQ',   null,      'X-HQ',    'Unrelated HQ',       true),
 (smt.o(9), 'WH',   smt.o(8),  'X-WH',    'Unrelated Warehouse',true);

-- n, org, legacy role, principal
insert into auth.users(id, email, aud, role)
select smt.u(n), 'sm-test-' || n || '@example.test', 'authenticated', 'authenticated' from generate_series(1, 10) n;
insert into public.users(id, email, full_name, role_code, organization_id, is_active, principal_type, account_status, account_scope)
select smt.u(n), 'sm-test-' || n || '@example.test', label, role_code, smt.o(org), true, principal, 'ACTIVE', 'portal'
from (values
  (1,  1, 'USER', 'INTERNAL_EMPLOYEE', 'HQ inventory user'),
  (2,  2, 'USER', 'INTERNAL_EMPLOYEE', 'Warehouse 1 operator'),
  (3,  1, 'HQ',   'INTERNAL_EMPLOYEE', 'HQ Order Creator (level 10, no inventory permission)'),
  (4,  4, 'DIST', 'DISTRIBUTOR_USER',  'Distributor 1 user'),
  (5,  6, 'SHOP', 'SHOP_STAFF',        'Shop 1 user'),
  (6,  7, 'HQ',   'MANUFACTURER_USER', 'Manufacturer user holding the HQ role (level 10)'),
  (7,  1, 'HQ',   'INTERNAL_EMPLOYEE', 'HQ admin (level 10) with Supply Chain Full Access'),
  (8,  1, 'SA',   'INTERNAL_EMPLOYEE', 'Root Access holder'),
  (9,  8, 'USER', 'INTERNAL_EMPLOYEE', 'Unrelated company inventory user'),
  (10, 1, 'USER', 'INTERNAL_EMPLOYEE', 'HQ employee, self-service only')
) t(n, org, role_code, principal, label);

insert into public.sa_organization_memberships(id, user_id, organization_id, membership_type, is_primary, status, source)
select smt.u(100 + n), smt.u(n), u.organization_id, 'employee', true, 'active', 'manual'
from generate_series(1, 10) n join public.users u on u.id = smt.u(n);

insert into public.sa_scope_definitions(id, organization_id, scope_type, scope_value, display_name, status)
select smt.o(100 + n), smt.o(n), 'organization', smt.o(n)::text, 'Test scope ' || n, 'active' from generate_series(1, 9) n;

-- (user, role_key, scope org)
do $assign$
declare r record; v_id uuid;
begin
  for r in select * from (values
    (1, 'supply-chain-full-access', 1),
    (2, 'warehouse-operator', 2),
    (3, 'order-creator', 1),
    (4, 'inventory-viewer', 4), (4, 'order-creator', 4),
    (5, 'order-creator', 6),
    (6, 'manufacturing-production-operator', 7), (6, 'inventory-viewer', 7),
    (7, 'supply-chain-full-access', 1),
    (8, 'employee-self-service', 1),
    (9, 'supply-chain-full-access', 8),
    (10, 'employee-self-service', 1)) t(n, role_key, scope_org)
  loop
    insert into public.sa_role_assignments(user_id, role_id, membership_id, status, source, assignment_reason)
    values (smt.u(r.n), (select id from public.sa_business_roles where role_key = r.role_key), smt.u(100 + r.n), 'active', 'manual', 'sm test')
    returning id into v_id;
    insert into public.sa_assignment_scopes(assignment_id, scope_id) values (v_id, smt.o(100 + r.scope_org));
  end loop;
end $assign$;

insert into public.sa_root_access_grants(user_id, status, grant_method, reason, granted_at)
values (smt.u(8), 'active', 'bootstrap', 'stock movement access test fixture', now());

insert into public.products(id, category_id, product_code, product_name, is_active)
values (smt.o(500), smt.o(501), 'T-P1', 'Test Product', true);
insert into public.product_variants(id, product_id, variant_code, variant_name, base_cost, is_active)
values (smt.o(510), smt.o(500), 'T-V1', 'Test Variant', 10, true);
insert into public.inventory_stock_configurations(id, variant_id, config_code, config_label, stock_sku, status, is_variant_default,
  default_for_ord, allow_ord)
values (smt.o(520), smt.o(510), 'T_STD', 'Standard', 'T-SKU-1', 'active', true, true, true);

-- id, type, from, to, before, change, unit cost, company, ref
insert into public.stock_movements(id, movement_type, from_organization_id, to_organization_id, quantity_before, quantity_change,
  quantity_after, unit_cost, company_id, created_by, variant_id, reference_type, reference_no, created_at)
select smt.m(n), t, case when f is null then null else smt.o(f) end, case when tt is null then null else smt.o(tt) end,
       b, c, b + c, cost, smt.o(co), smt.u(1), smt.o(510), ref, 'REF-' || n, timestamptz '2026-10-01 00:00+00' + n * interval '1 hour'
from (values
  (1,  'addition',          null, 2,    0,   100, 10.00, 1, null),
  (2,  'allocation',        2,    4,    100, 20,  10.00, 1, 'order'),
  (3,  'transfer_in',       2,    4,    0,   20,  10.00, 1, 'transfer'),
  (4,  'adjustment',        4,    null, 20,  -2,  10.00, 1, null),
  (5,  'adjustment',        2,    3,    80,  -5,  10.00, 1, null),
  (6,  'transfer_in',       null, 1,    0,   7,   12.00, 1, 'transfer'),
  (7,  'addition',          null, 9,    0,   50,  99.00, 8, null),
  (8,  'transfer_in',       4,    6,    0,   3,   10.00, 1, 'transfer'),
  (9,  'order_fulfillment', 3,    5,    30,  -10, 11.00, 1, 'order'),
  (10, 'adjustment',        5,    null, 5,   -1,  10.00, 1, null)
) v(n, t, f, tt, b, c, cost, co, ref);

insert into public.product_inventory(id, variant_id, organization_id, quantity_on_hand, quantity_allocated, average_cost,
  is_active, stock_config_id)
select smt.o(600 + n), smt.o(510), smt.o(org), q, 0, cost, true, smt.o(700 + n)
from (values (1, 2, 75, 10.00), (2, 1, 7, 12.00), (3, 4, 18, null), (4, 5, 9, null), (5, 9, 50, 99.00)) v(n, org, q, cost);

set session_replication_role = origin;
