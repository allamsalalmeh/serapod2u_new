#!/usr/bin/env bash
# Builds a DISPOSABLE replica database on a LOCAL PostgreSQL (16 or 17) from the committed schema snapshots
# supabase/schemas/audit/{production,staging}_schema_20261016.sql — no connection to staging or production.
# Usage: build_replica_from_snapshot.sh <local port> <prod|stg> <db name containing "test">
# Limitations: structure only (no configuration rows: fixtures create synthetic ones); Supabase default grants are
# emulated (explicit REVOKEs of individual migrations are not reproduced); auth schema is a minimal stub.
# The production snapshot predates the owner's 2026-10-16 evening corrective pack (20261110100000): use stg for
# the --lifecycle scenarios.
set -euo pipefail
PORT="${1:?port}"; SRC="${2:?prod|stg}"; DB="${3:?db name}"
case "$DB" in *test*) ;; *) echo "refusing: db name must contain 'test'" >&2; exit 2;; esac
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
case "$SRC" in prod) S="$ROOT/supabase/schemas/audit/production_schema_20261016.sql";; stg) S="$ROOT/supabase/schemas/audit/staging_schema_20261016.sql";; *) exit 2;; esac
P=(psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT")
"${P[@]}" -U postgres -d postgres <<'SQL'
do $r$ begin
  if not exists (select 1 from pg_roles where rolname = 'supabase_admin') then create role supabase_admin superuser login; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; grant anon, authenticated, service_role to authenticator; end if;
end $r$;
SQL
createdb -h 127.0.0.1 -p "$PORT" -U postgres -O supabase_admin "$DB"
"${P[@]}" -U supabase_admin -d "$DB" <<'SQL'
create schema extensions;
create extension pgcrypto schema extensions; create extension "uuid-ossp" schema extensions;
create extension btree_gist schema extensions; create extension pg_trgm schema extensions;
create schema auth;
create table auth.users (instance_id uuid, id uuid primary key, aud varchar(255), role varchar(255), email varchar(255), encrypted_password varchar(255),
  email_confirmed_at timestamptz, invited_at timestamptz, confirmation_token varchar(255), confirmation_sent_at timestamptz, recovery_token varchar(255),
  recovery_sent_at timestamptz, email_change_token_new varchar(255), email_change varchar(255), email_change_sent_at timestamptz, last_sign_in_at timestamptz,
  raw_app_meta_data jsonb, raw_user_meta_data jsonb, is_super_admin boolean, created_at timestamptz default now(), updated_at timestamptz default now(),
  phone text unique, phone_confirmed_at timestamptz, phone_change text default '', phone_change_token varchar(255) default '', phone_change_sent_at timestamptz,
  confirmed_at timestamptz, email_change_token_current varchar(255) default '', email_change_confirm_status smallint default 0, banned_until timestamptz,
  reauthentication_token varchar(255) default '', reauthentication_sent_at timestamptz, is_sso_user boolean not null default false, deleted_at timestamptz,
  is_anonymous boolean not null default false);
create table auth.sessions (id uuid primary key, user_id uuid references auth.users(id) on delete cascade, created_at timestamptz default now(), updated_at timestamptz, not_after timestamptz);
create table auth.identities (id uuid primary key default gen_random_uuid(), provider_id text, user_id uuid references auth.users(id) on delete cascade, identity_data jsonb, provider text, email text, created_at timestamptz default now(), updated_at timestamptz);
create table auth.refresh_tokens (id bigserial primary key, token varchar(255), user_id varchar(255), revoked boolean, session_id uuid references auth.sessions(id) on delete cascade, created_at timestamptz default now(), updated_at timestamptz);
create table auth.one_time_tokens (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade, token_type text, token_hash text, relates_to text, created_at timestamptz default now(), updated_at timestamptz default now());
create table auth.mfa_factors (id uuid primary key, user_id uuid references auth.users(id) on delete cascade, friendly_name text, factor_type text, status text, created_at timestamptz default now(), updated_at timestamptz);
create table auth.mfa_amr_claims (id uuid primary key, session_id uuid references auth.sessions(id) on delete cascade, created_at timestamptz default now(), updated_at timestamptz, authentication_method text);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''), nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
grant usage on schema auth, extensions to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
drop schema public;
SQL
sed '/^\\restrict/d;/^\\unrestrict/d;/^SET transaction_timeout/d' "$S" | "${P[@]}" -U supabase_admin -d "$DB" -f - >/dev/null
"${P[@]}" -U supabase_admin -d "$DB" <<'SQL'
grant usage on schema public, storage to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;
SQL
echo "replica $DB ready (from $SRC snapshot)"
