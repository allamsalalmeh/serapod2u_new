-- A custom policy eligible for HQ and Distributors, with no holder, for the two races in run.sh.
insert into public.sa_business_roles(id, role_key, name, source, status, applicable_org_types)
  values ('00000000-0000-0000-0015-000000000040', 'saf-race', 'Race policy', 'new', 'active', array['HQ','DIST']);
insert into public.sa_business_role_permissions(role_id, permission_id)
  select '00000000-0000-0000-0015-000000000040', id from public.sa_permissions where permission_key = 'supply_chain.order.create';
