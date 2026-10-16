-- DISPOSABLE sa_prof_test* DATABASES ONLY. Lifecycle columns of public.users and the Phase 0A trigger the identity guard
-- migration (20260929120000) requires; the identity permissions and modes exactly as 20260929110000 seeds them.
do $g$ begin if current_database() !~ '^sa_prof_test' then raise exception 'Refusing: not a disposable sa_prof_test* database'; end if; end $g$;
alter table public.users add column if not exists account_status text not null default 'ACTIVE',
  add column if not exists account_status_reason text, add column if not exists account_status_changed_at timestamptz,
  add column if not exists email_verified_at timestamptz, add column if not exists phone_verified_at timestamptz,
  add column if not exists is_verified boolean, add column if not exists auth_provider text, add column if not exists principal_type text;
create or replace function public.saf_noop_trigger() returns trigger language plpgsql as $$ begin return coalesce(new, old); end $$;
drop trigger if exists users_prevent_self_service_access_field_update on public.users;
create trigger users_prevent_self_service_access_field_update before update on public.users for each row execute function public.saf_noop_trigger();
-- A business-history reference (stand-in for orders.created_by etc.).
create table if not exists public.saf_orders (id serial primary key, created_by uuid references public.users(id));
grant select, insert, update, delete on public.users to authenticated, anon, service_role;

insert into public.sa_permissions(permission_key, module, resource, action, description, source, audit_sensitivity) values
 ('platform.identity.delete','platform','identity','delete','Archive an identity (terminal; history is preserved)','new','security_sensitive')
on conflict (permission_key) do nothing;
insert into public.sa_legacy_compat_rules(permission_key, max_role_level, role_codes, legacy_permissions, employee_baseline, notes) values
 ('platform.identity.delete', 1, '{}', '{}', false, 'Identity Foundation Stage 1 compatibility mapping (identity-catalog.ts)')
on conflict (permission_key) do nothing;
insert into public.sa_migration_modes(permission_key, mode, legacy_permission_key, notes)
values ('platform.identity.delete', 'SHADOW', null, 'Identity Foundation Stage 1: legacy decides while the new model is evaluated and logged.')
on conflict (permission_key) do update set mode = 'SHADOW';
