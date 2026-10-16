-- ============================================================================
-- S&A bulk migration-mode change — harness (DISPOSABLE DATABASES ONLY)
-- ----------------------------------------------------------------------------
-- Run via run.sh against a throwaway local PostgreSQL (never Supabase, never
-- the shared staging database). It creates MINIMAL stand-ins for the S&A tables
-- the migration depends on, loads the REAL sa_log_access_change and the
-- ORIGINAL sa_set_migration_mode (20260928130000) from the repository, then the
-- new migration. The only stand-ins are the actor-authority check and the
-- tables, so the tests exercise the new SQL against the genuine mode rules.
-- ============================================================================
do $guard$ begin
  if current_database() !~ '^sa_bulk_test' then raise exception 'Refusing to run: database % is not a disposable sa_bulk_test* database', current_database(); end if;
end $guard$;

do $roles$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $roles$;

create table public.users (id uuid primary key, is_active boolean not null default true);
create table public.sa_permissions (permission_key text primary key);
create table public.sa_migration_modes (
  permission_key text primary key references public.sa_permissions(permission_key) on update cascade on delete restrict,
  mode text not null check (mode in ('LEGACY_ENFORCED','SHADOW','NEW_ENFORCED','LEGACY_RETIRED')),
  legacy_permission_key text, notes text,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id)
);
create table public.sa_enforcement_readiness (permission_key text primary key references public.sa_permissions(permission_key) on update cascade);
create table public.sa_access_change_log (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  actor_id uuid references public.users(id) on delete set null,
  actor_kind text not null default 'user' check (actor_kind in ('user','system','service')),
  action text not null check (action ~ '^[a-z][a-z0-9_.]*$'),
  target_user_id uuid references public.users(id) on delete set null,
  entity_type text not null, entity_id text,
  details jsonb not null default '{}'::jsonb, reason text, correlation_id text
);
create function public.sa_reject_append_only_mutation() returns trigger language plpgsql as $$ begin raise exception '%_is_append_only', tg_table_name; end $$;
create trigger sa_access_change_log_append_only before update or delete on public.sa_access_change_log for each row execute function public.sa_reject_append_only_mutation();

-- Stand-in for the actor-authority check (the real one needs the full S&A role schema).
-- Mirrors its contract: inactive/unknown actors fail; once the permission is
-- NEW_ENFORCED/LEGACY_RETIRED only a new-model grant counts, otherwise the legacy flag.
create table public.saf_legacy_admins (user_id uuid primary key);
create table public.saf_new_grants (user_id uuid, permission_key text, primary key (user_id, permission_key));
create function public.sa_legacy_is_super_admin(p_actor uuid) returns boolean language sql stable as $$
  select exists (select 1 from public.saf_legacy_admins where user_id = p_actor) $$;
create function public.sa_assert_actor_permission(p_actor uuid, p_permission text, p_context jsonb, p_legacy boolean)
returns void language plpgsql stable as $$
begin
  if p_actor is null then raise exception 'sa_actor_required' using errcode = '42501'; end if;
  if not exists (select 1 from public.users u where u.id = p_actor and u.is_active is true) then raise exception 'sa_actor_inactive' using errcode = '42501'; end if;
  if (select mode from public.sa_migration_modes where permission_key = p_permission) in ('NEW_ENFORCED','LEGACY_RETIRED') then
    if not exists (select 1 from public.saf_new_grants where user_id = p_actor and permission_key = p_permission) then raise exception 'sa_authorization_required' using errcode = '42501'; end if;
  elsif not coalesce(p_legacy, false) then raise exception 'sa_authorization_required' using errcode = '42501'; end if;
end $$;

-- Test helpers
create schema saf;
create function saf.expect(p_ok boolean, p_msg text) returns void language plpgsql as $$ begin if not coalesce(p_ok, false) then raise exception 'ASSERTION FAILED: %', p_msg; end if; end $$;
-- Runs SQL, returns the error message (or 'OK'); the statement's effects are rolled back on error.
create function saf.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'OK'; exception when others then return sqlerrm; end $$;
