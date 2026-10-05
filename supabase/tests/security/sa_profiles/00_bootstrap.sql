-- DISPOSABLE sa_prof_test* DATABASES ONLY. Minimal stand-ins for the platform tables the
-- real Security & Access migrations reference; the S&A functions themselves are the REAL
-- migration files (loaded by run.sh), so authorization behaviour under test is genuine.
do $g$ begin if current_database() !~ '^sa_prof_test' then raise exception 'Refusing: not a disposable sa_prof_test* database'; end if; end $g$;
do $r$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $r$;
create schema if not exists auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid $$;
create table public.organizations (id uuid primary key default gen_random_uuid(), org_name text not null, org_type_code text not null, parent_org_id uuid references public.organizations(id), is_active boolean not null default true);
create table public.roles (role_code text primary key, role_name text, role_level integer, is_active boolean default true, permissions jsonb);
create table public.departments (id uuid primary key default gen_random_uuid(), organization_id uuid references public.organizations(id), dept_name text);
create table public.users (id uuid primary key references auth.users(id), email text, full_name text, role_code text references public.roles(role_code), organization_id uuid references public.organizations(id),
  is_active boolean not null default true, manager_user_id uuid, department_id uuid, phone text, account_scope text);
