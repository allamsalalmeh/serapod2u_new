-- Isolated fixtures (never real data). Ids: 00000000-0000-0000-00xx-...
do $g$ begin if current_database() !~ '^sa_prof_test' then raise exception 'Refusing: not a disposable sa_prof_test* database'; end if; end $g$;
create schema if not exists saf;
create function saf.expect(p_ok boolean, p_msg text) returns void language plpgsql as $$ begin if not coalesce(p_ok, false) then raise exception 'ASSERTION FAILED: %', p_msg; end if; end $$;
create function saf.try(p_sql text) returns text language plpgsql as $$ begin execute p_sql; return 'OK'; exception when others then return sqlerrm; end $$;
create function saf.u(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0001-' || lpad(n::text, 12, '0'))::uuid $$;
create function saf.o(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0002-' || lpad(n::text, 12, '0'))::uuid $$;
create function saf.s(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0004-' || lpad(n::text, 12, '0'))::uuid $$;
create function saf.role(k text) returns uuid language sql stable as $$ select id from public.sa_business_roles where role_key = k $$;
create function saf.keys(p_role uuid) returns text[] language sql stable as $$
  select coalesce(array_agg(p.permission_key order by p.permission_key), '{}') from public.sa_business_role_permissions rp join public.sa_permissions p on p.id = rp.permission_id where rp.role_id = p_role $$;
create function saf.audit(p_action text) returns bigint language sql stable as $$ select count(*) from public.sa_access_change_log where action = p_action $$;

insert into public.roles(role_code, role_name, role_level) values ('SA', 'Super Admin', 1), ('HQ_MGR', 'HQ Manager', 10), ('WH_MGR', 'Warehouse Manager', 20), ('MFG_USER', 'Manufacturer User', 40);
insert into public.organizations(id, org_name, org_type_code, parent_org_id) values
  (saf.o(1), 'HQ', 'HQ', null), (saf.o(2), 'Balakong WH', 'WH', saf.o(1)), (saf.o(3), 'Alma WH', 'WH', saf.o(1)), (saf.o(4), 'Manu Manufacturing', 'MFG', null);
-- 1 legacy super admin (level 1) | 2 delegated S&A admin (level 10, explicit Security & Access Full Access, HQ scope)
-- 3 plain HQ member, no assignment | 4 warehouse employee (Balakong) | 5 narrow admin (view + assign, Balakong scope only)
-- 6 HQ employee | 7 HQ employee holding a payment-approval role | 8 manufacturer user | 9 second delegated admin (Supply Chain Full Access only)
insert into auth.users(id, email) select saf.u(n), 'u' || n || '@dev.com' from generate_series(1, 9) n;
insert into public.users(id, email, full_name, role_code, organization_id, is_active) values
  (saf.u(1),'u1@dev.com','Super Admin','SA',saf.o(1),true), (saf.u(2),'u2@dev.com','Delegated Admin','HQ_MGR',saf.o(1),true),
  (saf.u(3),'u3@dev.com','Plain Member','HQ_MGR',saf.o(1),true), (saf.u(4),'u4@dev.com','Warehouse Employee','WH_MGR',saf.o(2),true),
  (saf.u(5),'u5@dev.com','Narrow Admin','HQ_MGR',saf.o(2),true), (saf.u(6),'u6@dev.com','HQ Employee','HQ_MGR',saf.o(1),true),
  (saf.u(7),'u7@dev.com','Payer','HQ_MGR',saf.o(1),true), (saf.u(8),'u8@dev.com','Manu','MFG_USER',saf.o(4),true),
  (saf.u(9),'u9@dev.com','Supply Admin','HQ_MGR',saf.o(1),true);
insert into public.sa_organization_memberships(user_id, organization_id, membership_type, is_primary, status) values
  (saf.u(1), saf.o(1), 'employee', true, 'active'), (saf.u(2), saf.o(1), 'employee', true, 'active'), (saf.u(3), saf.o(1), 'employee', true, 'active'),
  (saf.u(4), saf.o(2), 'employee', true, 'active'), (saf.u(5), saf.o(2), 'employee', true, 'active'), (saf.u(6), saf.o(1), 'employee', true, 'active'),
  (saf.u(7), saf.o(1), 'employee', true, 'active'), (saf.u(8), saf.o(4), 'partner', true, 'active'), (saf.u(9), saf.o(1), 'employee', true, 'active');
insert into public.sa_scope_definitions(id, organization_id, scope_type, scope_value, display_name) values
  (saf.s(1), saf.o(1), 'organization', saf.o(1)::text, 'HQ'), (saf.s(2), saf.o(2), 'organization', saf.o(2)::text, 'Balakong WH'),
  (saf.s(3), saf.o(3), 'organization', saf.o(3)::text, 'Alma WH'), (saf.s(4), saf.o(4), 'organization', saf.o(4)::text, 'Manu Manufacturing'),
  (saf.s(5), null, 'territory', 'north', 'North territory');
insert into public.sa_business_roles(id, role_key, name, source, status) values
  ('00000000-0000-0000-0005-000000000001', 'saf-assign-only', 'Assign Only', 'new', 'active'),
  ('00000000-0000-0000-0005-000000000002', 'saf-payer', 'Payer', 'new', 'active');
insert into public.sa_business_role_permissions(role_id, permission_id)
  select '00000000-0000-0000-0005-000000000001', id from public.sa_permissions where permission_key in ('security.access.view', 'security.role.assign');
insert into public.sa_business_role_permissions(role_id, permission_id)
  select '00000000-0000-0000-0005-000000000002', id from public.sa_permissions where permission_key = 'finance.payment.approve';

grant usage on schema saf to public;
grant execute on all functions in schema saf to public;

create table saf.modes_before as select permission_key, mode from public.sa_migration_modes;
