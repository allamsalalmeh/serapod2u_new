-- Isolated fixtures (never real data). Ids: 00000000-0000-0000-00xx-...
create schema if not exists saf;
create function saf.expect(p_ok boolean, p_msg text) returns void language plpgsql as $$ begin if not coalesce(p_ok, false) then raise exception 'ASSERTION FAILED: %', p_msg; end if; end $$;
create function saf.try(p_sql text) returns text language plpgsql as $$ begin execute p_sql; return 'OK'; exception when others then return sqlerrm; end $$;
create function saf.u(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0001-' || lpad(n::text, 12, '0'))::uuid $$;
create function saf.o(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0002-' || lpad(n::text, 12, '0'))::uuid $$;

insert into public.roles(role_code, role_name, role_level) values ('SA', 'Super Admin', 1), ('HQ_MGR', 'HQ Manager', 10), ('WH_MGR', 'Warehouse Manager', 20), ('MFG_USER', 'Manufacturer User', 40), ('GUEST', 'Guest', 50);
insert into public.organizations(id, org_name, org_type_code, parent_org_id) values
  (saf.o(1), 'HQ', 'HQ', null), (saf.o(2), 'Balakong WH', 'WH', saf.o(1)), (saf.o(3), 'Alma WH', 'WH', saf.o(1)),
  (saf.o(4), 'Manu Manufacturing', 'MFG', null), (saf.o(5), 'Other Manufacturer', 'MFG', null);
-- 1 super admin (HQ), 2 org-scoped admin (Balakong), 3 warehouse user (Balakong), 4 manu@dev.com (manufacturer),
-- 5 no-membership partner user (manufacturer), 6 inactive user (HQ), 7 other manufacturer's user, 8 HQ-only member (no assignments)
insert into auth.users(id, email) select saf.u(n), e from (values (1,'super@dev.com'),(2,'orgadmin@dev.com'),(3,'wh@dev.com'),(4,'manu@dev.com'),(5,'nomem@dev.com'),(6,'gone@dev.com'),(7,'other@dev.com'),(8,'hqonly@dev.com')) v(n, e);
insert into public.users(id, email, full_name, role_code, organization_id, is_active) values
  (saf.u(1),'super@dev.com','Super Admin','SA',saf.o(1),true), (saf.u(2),'orgadmin@dev.com','Org Admin','HQ_MGR',saf.o(2),true),
  (saf.u(3),'wh@dev.com','Warehouse User','WH_MGR',saf.o(2),true), (saf.u(4),'manu@dev.com','Manu Operator','MFG_USER',saf.o(4),true),
  (saf.u(5),'nomem@dev.com','No Membership','MFG_USER',saf.o(4),true), (saf.u(6),'gone@dev.com','Gone Person','WH_MGR',saf.o(1),false),
  (saf.u(7),'other@dev.com','Other Mfg User','MFG_USER',saf.o(5),true), (saf.u(8),'hqonly@dev.com','HQ Only','HQ_MGR',saf.o(1),true);
-- 700 filler HQ users: the target user must be found beyond any first page / 500 cap.
insert into auth.users(id, email) select ('00000000-0000-0000-0003-' || lpad(n::text, 12, '0'))::uuid, 'bulk' || n || '@dev.com' from generate_series(1, 700) n;
insert into public.users(id, email, full_name, role_code, organization_id, is_active)
  select ('00000000-0000-0000-0003-' || lpad(n::text, 12, '0'))::uuid, 'bulk' || n || '@dev.com', 'Bulk Person ' || lpad(n::text, 4, '0'), 'HQ_MGR', saf.o(1), true from generate_series(1, 700) n;

insert into public.sa_organization_memberships(user_id, organization_id, membership_type, is_primary, status) values
  (saf.u(1), saf.o(1), 'employee', true, 'active'), (saf.u(2), saf.o(2), 'employee', true, 'active'), (saf.u(3), saf.o(2), 'employee', true, 'active'),
  (saf.u(4), saf.o(4), 'partner', true, 'active'), (saf.u(7), saf.o(5), 'partner', true, 'active'), (saf.u(8), saf.o(1), 'employee', true, 'active');
insert into public.sa_organization_memberships(user_id, organization_id, membership_type, is_primary, status)
  select ('00000000-0000-0000-0003-' || lpad(n::text, 12, '0'))::uuid, saf.o(1), 'employee', true, 'active' from generate_series(1, 700) n;

-- Scopes + a custom business role with the two administrator permissions.
insert into public.sa_scope_definitions(id, organization_id, scope_type, scope_value, display_name) values
  ('00000000-0000-0000-0004-000000000001', saf.o(2), 'organization', saf.o(2)::text, 'Balakong WH'),
  ('00000000-0000-0000-0004-000000000002', saf.o(4), 'organization', saf.o(4)::text, 'Manu Manufacturing'),
  ('00000000-0000-0000-0004-000000000003', saf.o(1), 'organization', saf.o(1)::text, 'HQ');
insert into public.sa_business_roles(id, role_key, name, source, status) values
  ('00000000-0000-0000-0005-000000000001', 'saf-people-admin', 'People Admin', 'new', 'active'),
  ('00000000-0000-0000-0005-000000000002', 'saf-operator', 'Operator', 'new', 'active');
insert into public.sa_business_role_permissions(role_id, permission_id)
  select '00000000-0000-0000-0005-000000000001', id from public.sa_permissions where permission_key in ('security.access.view', 'security.role.assign');
insert into public.sa_business_role_permissions(role_id, permission_id)
  select '00000000-0000-0000-0005-000000000002', id from public.sa_permissions where permission_key = 'inventory.stock_count.view';

create function saf.snapshot() returns text language sql stable as $$
  select md5((select coalesce(string_agg(id::text || is_active::text || coalesce(organization_id::text,'') || coalesce(role_code,''), ',' order by id), '') from public.users)
    || (select coalesce(string_agg(id::text || status, ',' order by id), '') from public.sa_organization_memberships)
    || (select coalesce(string_agg(id::text || status, ',' order by id), '') from public.sa_role_assignments)
    || (select count(*)::text from public.sa_access_change_log)) $$;
