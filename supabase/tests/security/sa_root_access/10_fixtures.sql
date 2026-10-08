-- Isolated Root Access fixtures (never real data). Builds on sa_group_policies + sa_emergency_access fixtures:
-- u1 legacy Super Admin (level 1, HQ, explicit Security & Access Full Access) | u2 HQ administrator (level 10, S&A Full Access)
-- u3 plain HQ member | u4 Balakong employee (+HQ journal poster) | u5 Balakong emergency admin | u6 HQ employee
-- u7 HQ payer | u8 manufacturer user | u9 Supply admin
-- New here: u10 HQ employee (second Root Administrator) | u11 inactive HQ employee | u12 shop staff
--           o5 distributor, o6 shop under it (partner organizations outside the HQ tree)
do $g$ begin if current_database() !~ '^sa_prof_test' then raise exception 'Refusing: not a disposable sa_prof_test* database'; end if; end $g$;

insert into public.organizations(id, org_name, org_type_code, parent_org_id) values
  (saf.o(5), 'North Distributor', 'DIST', null), (saf.o(6), 'Corner Shop', 'SHOP', saf.o(5));
insert into auth.users(id, email) select saf.u(n), 'u' || n || '@dev.com' from generate_series(10, 12) n;
insert into public.users(id, email, full_name, role_code, organization_id, is_active) values
  (saf.u(10), 'u10@dev.com', 'Second Root', 'HQ_MGR', saf.o(1), true),
  (saf.u(11), 'u11@dev.com', 'Inactive HQ', 'HQ_MGR', saf.o(1), false),
  (saf.u(12), 'u12@dev.com', 'Shop Staff', 'MFG_USER', saf.o(6), true);
insert into public.sa_organization_memberships(user_id, organization_id, membership_type, is_primary, status) values
  (saf.u(10), saf.o(1), 'employee', true, 'active'), (saf.u(11), saf.o(1), 'employee', true, 'active'),
  (saf.u(12), saf.o(6), 'partner', true, 'active');
insert into public.sa_scope_definitions(id, organization_id, scope_type, scope_value, display_name) values
  (saf.s(6), saf.o(5), 'organization', saf.o(5)::text, 'North Distributor'), (saf.s(7), saf.o(6), 'organization', saf.o(6)::text, 'Corner Shop');

-- hr.employee.view stays in Monitoring (SHADOW): the legacy rule decides, Root Access must not widen it.
update public.sa_migration_modes set mode = 'SHADOW' where permission_key = 'hr.employee.view';

set check_function_bodies = off;
-- The decision grid compared before/after the migration (regression check for everyone who is not Root).
create table saf.grid_permissions(permission_key text primary key);
insert into saf.grid_permissions values ('finance.payment.approve'), ('finance.journal.post'), ('security.role.assign'),
  ('security.access.view'), ('security.emergency_access.grant'), ('hr.employee.view'), ('nonexistent.module.use');
create function saf.grid() returns table(user_id uuid, permission_key text, org uuid, decision text, reason text, holds boolean, dominated_by_u1 boolean)
language sql as $$
  select u.id, g.permission_key, o.id,
         public.sa_evaluate_permission(u.id, g.permission_key, case when o.id is null then '{}'::jsonb else jsonb_build_object('organization_id', o.id) end)->>'decision',
         public.sa_evaluate_permission(u.id, g.permission_key, case when o.id is null then '{}'::jsonb else jsonb_build_object('organization_id', o.id) end)->>'reason_code',
         public.sa_actor_holds_permission(u.id, g.permission_key, o.id),
         public.sa_actor_dominates(saf.u(1), u.id)
  from public.users u cross join saf.grid_permissions g
  cross join (select id from public.organizations union all select null::uuid) o $$;
create function saf.root_grant(p_actor uuid, p_target uuid, p_reason text default 'Root Access for platform administration (ticket OPS-1)',
  p_until timestamptz default null, p_key uuid default gen_random_uuid()) returns jsonb language sql as $$
  select public.sa_grant_root_access(p_actor, p_target, p_reason, p_until, p_key) $$;
create function saf.root_revoke(p_actor uuid, p_target uuid, p_reason text default 'Root Access no longer needed (ticket OPS-2)')
  returns jsonb language sql as $$ select public.sa_revoke_root_access(p_actor, p_target, p_reason) $$;
create function saf.as_api_user(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, false) $$;
create function saf.as_owner() returns void language sql as $$ select set_config('request.jwt.claims', '', false) $$;
grant execute on all functions in schema saf to public;
