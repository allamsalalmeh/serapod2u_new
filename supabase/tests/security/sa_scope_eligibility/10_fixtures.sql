-- Isolated fixtures (never real data).
do $g$ begin if current_database() !~ '^sa_prof_test' then raise exception 'Refusing: not a disposable sa_prof_test* database'; end if; end $g$;
create schema if not exists sse;
create function sse.expect(p_ok boolean, p_msg text) returns void language plpgsql as $$ begin if not coalesce(p_ok, false) then raise exception 'ASSERTION FAILED: %', p_msg; end if; end $$;
create function sse.try(p_sql text) returns text language plpgsql as $$ begin execute p_sql; return 'OK'; exception when others then return sqlerrm; end $$;
create function sse.u(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0001-' || lpad(n::text, 12, '0'))::uuid $$;
create function sse.o(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0002-' || lpad(n::text, 12, '0'))::uuid $$;
create function sse.s(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0004-' || lpad(n::text, 12, '0'))::uuid $$;
create function sse.r(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0005-' || lpad(n::text, 12, '0'))::uuid $$;

insert into public.roles(role_code, role_name, role_level) values ('SA', 'Super Admin', 1), ('HQ_MGR', 'HQ Manager', 10), ('WH_MGR', 'Warehouse Manager', 20), ('DIST_USER', 'Distributor', 40);
-- orgs: 1 HQ | 2 Balakong WH | 3 Alma WH | 4 Distributor (under HQ) | 5 Shop (under Distributor) | 6 Manufacturer (under HQ)
--       7 other HQ | 8 other HQ's warehouse Zeta | 9 Newco (starts unattached; attached to HQ later by the tests)
insert into public.organizations(id, org_name, org_type_code, parent_org_id) values
  (sse.o(1), 'Serapod HQ', 'HQ', null), (sse.o(2), 'Balakong', 'WH', sse.o(1)), (sse.o(3), 'Alma', 'WH', sse.o(1)),
  (sse.o(4), 'North Distributor', 'DIST', sse.o(1)), (sse.o(5), 'Corner Shop', 'SHOP', sse.o(4)), (sse.o(6), 'Manu Manufacturing', 'MFG', sse.o(1)),
  (sse.o(7), 'Other HQ', 'HQ', null), (sse.o(8), 'Zeta', 'WH', sse.o(7)), (sse.o(9), 'Newco', 'WH', null);
-- users: 1 admin | 2 HQ recipient | 3 Balakong employee | 4 distributor user | 5 other HQ user
insert into auth.users(id, email) select sse.u(n), 'u' || n || '@dev.com' from generate_series(1, 5) n;
insert into public.users(id, email, full_name, role_code, organization_id, is_active) values
  (sse.u(1),'u1@dev.com','Admin','SA',sse.o(1),true), (sse.u(2),'u2@dev.com','HQ Recipient','HQ_MGR',sse.o(1),true),
  (sse.u(3),'u3@dev.com','Balakong Employee','WH_MGR',sse.o(2),true), (sse.u(4),'u4@dev.com','Distributor User','DIST_USER',sse.o(4),true),
  (sse.u(5),'u5@dev.com','Other HQ User','HQ_MGR',sse.o(7),true);
insert into public.sa_organization_memberships(user_id, organization_id, membership_type, is_primary, status) values
  (sse.u(1), sse.o(1), 'employee', true, 'active'), (sse.u(2), sse.o(1), 'employee', true, 'active'), (sse.u(3), sse.o(2), 'employee', true, 'active'),
  (sse.u(4), sse.o(4), 'partner', true, 'active'), (sse.u(5), sse.o(7), 'employee', true, 'active');
-- scope definitions. Balakong carries BOTH a warehouse and a legacy organization definition (the duplicate the picker collapses).
insert into public.sa_scope_definitions(id, organization_id, scope_type, scope_value, display_name) values
  (sse.s(1), sse.o(1), 'organization', sse.o(1)::text, 'Serapod HQ'),
  (sse.s(2), sse.o(2), 'warehouse', sse.o(2)::text, 'Balakong'), (sse.s(12), sse.o(2), 'organization', sse.o(2)::text, 'Balakong'),
  (sse.s(3), sse.o(3), 'warehouse', sse.o(3)::text, 'Alma'),
  (sse.s(4), sse.o(4), 'organization', sse.o(4)::text, 'North Distributor'), (sse.s(5), sse.o(5), 'organization', sse.o(5)::text, 'Corner Shop'),
  (sse.s(6), sse.o(6), 'organization', sse.o(6)::text, 'Manu Manufacturing'),
  (sse.s(7), sse.o(7), 'organization', sse.o(7)::text, 'Other HQ'), (sse.s(8), sse.o(8), 'warehouse', sse.o(8)::text, 'Zeta'),
  (sse.s(9), sse.o(9), 'warehouse', sse.o(9)::text, 'Newco'),
  (sse.s(10), null, 'territory', 'north', 'North territory');
-- a policy whose single permission a warehouse can limit
insert into public.sa_permissions(permission_key, module, resource, action, description, source) values
  ('inventory.stock_count.verify', 'inventory', 'stock_count', 'verify', 'test', 'new'), ('inventory.stock_count.post', 'inventory', 'stock_count', 'post', 'test', 'new')
  on conflict (permission_key) do nothing;
insert into public.sa_business_roles(id, role_key, name, source, status) values (sse.r(1), 'sse-stock', 'Stock policy', 'new', 'active');
insert into public.sa_business_role_permissions(role_id, permission_id) select sse.r(1), id from public.sa_permissions where permission_key = 'inventory.stock_count.verify';
insert into public.sa_business_roles(id, role_key, name, source, status) values (sse.r(2), 'sse-stock-post', 'Stock post policy', 'new', 'active');
insert into public.sa_business_role_permissions(role_id, permission_id) select sse.r(2), id from public.sa_permissions where permission_key = 'inventory.stock_count.post';

-- NEGATIVE CONTROL: a grant that exists BEFORE the eligibility migration (HQ recipient holding a Distributor scope).
-- The migration must neither remove nor re-evaluate it.
insert into public.sa_role_assignments(id, user_id, role_id, membership_id, status, source, created_by)
  select sse.r(100), sse.u(2), sse.r(2), m.id, 'active', 'manual', sse.u(1) from public.sa_organization_memberships m where m.user_id = sse.u(2);
insert into public.sa_assignment_scopes(assignment_id, scope_id) values (sse.r(100), sse.s(4));
create table sse.before_counts as select (select count(*) from public.sa_role_assignments) as assignments, (select count(*) from public.sa_assignment_scopes) as links, (select count(*) from public.sa_scope_definitions) as defs;
grant usage on schema sse to public;
grant execute on all functions in schema sse to public;
