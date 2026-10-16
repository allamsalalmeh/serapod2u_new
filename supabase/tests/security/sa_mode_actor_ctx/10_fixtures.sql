-- Isolated fixtures (never real data).
do $g$ begin if current_database() !~ '^sa_prof_test' then raise exception 'Refusing: not a disposable sa_prof_test* database'; end if; end $g$;
create schema if not exists saf;
create function saf.expect(p_ok boolean, p_msg text) returns void language plpgsql as $$ begin if not coalesce(p_ok, false) then raise exception 'ASSERTION FAILED: %', p_msg; end if; end $$;
create function saf.try(p_sql text) returns text language plpgsql as $$ begin execute p_sql; return 'OK'; exception when others then return sqlerrm; end $$;
create function saf.u(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0001-' || lpad(n::text, 12, '0'))::uuid $$;
create function saf.o(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0002-' || lpad(n::text, 12, '0'))::uuid $$;

insert into public.roles(role_code, role_name, role_level) values ('SA', 'Super Admin', 1), ('HQ_MGR', 'HQ Manager', 10), ('MFG_USER', 'Manufacturer User', 40);
insert into public.organizations(id, org_name, org_type_code, parent_org_id) values (saf.o(1), 'HQ', 'HQ', null), (saf.o(4), 'Manu Manufacturing', 'MFG', null);
-- 1 organization-scoped security admin (HQ_MGR, NOT a legacy super admin), 2 HQ member with no admin permission,
-- 3 manu@dev.com (manufacturer), 4 same grant as 1 but the account has no organization on file.
insert into auth.users(id, email) select saf.u(n), e from (values (1,'ctxadmin@dev.com'),(2,'plain@dev.com'),(3,'manu@dev.com'),(4,'noorg@dev.com')) v(n, e);
insert into public.users(id, email, full_name, role_code, organization_id, is_active) values
  (saf.u(1),'ctxadmin@dev.com','Ctx Admin','HQ_MGR',saf.o(1),true), (saf.u(2),'plain@dev.com','Plain','HQ_MGR',saf.o(1),true),
  (saf.u(3),'manu@dev.com','Manu','MFG_USER',saf.o(4),true), (saf.u(4),'noorg@dev.com','No Org','HQ_MGR',null,true);
insert into public.sa_organization_memberships(user_id, organization_id, membership_type, is_primary, status) values
  (saf.u(1), saf.o(1), 'employee', true, 'active'), (saf.u(2), saf.o(1), 'employee', true, 'active'),
  (saf.u(3), saf.o(4), 'partner', true, 'active'), (saf.u(4), saf.o(1), 'employee', true, 'active');
insert into public.sa_scope_definitions(id, organization_id, scope_type, scope_value, display_name) values
  ('00000000-0000-0000-0004-000000000003', saf.o(1), 'organization', saf.o(1)::text, 'HQ');
insert into public.sa_business_roles(id, role_key, name, source, status) values
  ('00000000-0000-0000-0005-000000000001', 'saf-mode-admin', 'Mode Admin', 'new', 'active'),
  ('00000000-0000-0000-0005-000000000002', 'saf-operator', 'Operator', 'new', 'active');
insert into public.sa_business_role_permissions(role_id, permission_id)
  select '00000000-0000-0000-0005-000000000001', id from public.sa_permissions where permission_key in ('security.access.view', 'security.permission.manage');
insert into public.sa_role_assignments(user_id, membership_id, role_id, status, source)
  select m.user_id, m.id, '00000000-0000-0000-0005-000000000001', 'active', 'manual' from public.sa_organization_memberships m where m.user_id in (saf.u(1), saf.u(4));
insert into public.sa_assignment_scopes(assignment_id, scope_id)
  select a.id, '00000000-0000-0000-0004-000000000003' from public.sa_role_assignments a;

-- permission.manage is decided by the new model (as on staging); two stock-count permissions are enforcement-ready.
update public.sa_migration_modes set mode = 'LEGACY_RETIRED' where permission_key = 'security.permission.manage';
update public.sa_migration_modes set mode = 'NEW_ENFORCED' where permission_key = 'inventory.stock_count.view';
insert into public.sa_enforcement_readiness(permission_key, route_wiring, database_backstop, notes) values
  ('inventory.stock_count.view', true, 'governance_function', 'fixture'), ('inventory.stock_count.create', true, 'governance_function', 'fixture');
