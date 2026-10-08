-- DISPOSABLE sa_prof_test* DATABASES ONLY. What identity_set_account_status / identity_admin_update_access need besides
-- S&A (20260929110000 is not replayed here): the legacy helpers (deliberately refusing, so only S&A or Root can allow),
-- the lifecycle projection (is_active follows account_status), and the identity permissions in Legacy Retired.
do $g$ begin if current_database() !~ '^sa_prof_test' then raise exception 'Refusing: not a disposable sa_prof_test* database'; end if; end $g$;
create or replace function public.identity_legacy_role_grant_allowed(p_actor uuid, p_role_code text) returns boolean language sql stable as $$ select false $$;
create or replace function public.identity_legacy_access_admin(p_actor uuid) returns boolean language sql stable as $$ select false $$;
create or replace function public.identity_legacy_user_admin(p_actor uuid) returns boolean language sql stable as $$ select false $$;
create or replace function public.saf_status_projection() returns trigger language plpgsql as $$
begin
  if new.account_status is distinct from old.account_status then new.is_active := new.account_status in ('ACTIVE','INVITED'); end if;
  return new;
end $$;
drop trigger if exists saf_status_projection on public.users;
create trigger saf_status_projection before update on public.users for each row execute function public.saf_status_projection();

insert into public.sa_permissions(permission_key, module, resource, action, description, source, audit_sensitivity) values
 ('platform.identity.disable','platform','identity','disable','Suspend, disable or reactivate an identity','new','security_sensitive'),
 ('platform.identity_access.manage','platform','identity_access','manage','Change enterprise access fields of an identity','new','security_sensitive')
on conflict (permission_key) do nothing;
insert into public.sa_migration_modes(permission_key, mode, notes)
  select k, 'LEGACY_RETIRED', 'Root identity target protection harness'
  from unnest(array['platform.identity.disable','platform.identity_access.manage','platform.identity.delete']) k
on conflict (permission_key) do update set mode = 'LEGACY_RETIRED';
-- u2 (HQ administrator, no Root Access any more) holds every identity permission for HQ: the strongest non-Root actor.
insert into public.sa_business_roles(id, role_key, name, source, status) values
  ('00000000-0000-0000-0005-000000000040', 'saf-identity-admin', 'Identity Administrator', 'new', 'active');
insert into public.sa_business_role_permissions(role_id, permission_id)
  select '00000000-0000-0000-0005-000000000040', id from public.sa_permissions
  where permission_key in ('platform.identity.disable','platform.identity_access.manage','platform.identity.delete');
select public.sa_create_assignment_internal(null, saf.u(2), '00000000-0000-0000-0005-000000000040', saf.o(1), array[saf.s(1)], now(), null, 'fixture', 'manual');
create function saf.set_status(p_actor uuid, p_user uuid, p_status text) returns text language sql as $$
  select saf.try(format($q$select public.identity_set_account_status(%L, %L, %L, 'identity lifecycle test')$q$, p_actor, p_user, p_status)) $$;
create function saf.set_access(p_actor uuid, p_user uuid, p_role text, p_org uuid, p_change_org boolean) returns text language sql as $$
  select saf.try(format($q$select public.identity_admin_update_access(%L, %L, %L, %L, %L, 'identity access test')$q$, p_actor, p_user, p_role, p_org, p_change_org)) $$;
grant execute on all functions in schema saf to public;
