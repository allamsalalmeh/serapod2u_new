#!/usr/bin/env bash
# Builds the template database sm_tmpl on a throwaway local PostgreSQL 17 (Homebrew postgresql@17) from a READ-ONLY
# schema dump of staging plus the S&A configuration rows (no personal data). Usage:
#   build_replica.sh <dir for dumps> <local port>
# Then: createdb -T sm_tmpl sm_test1 && run.sh postgresql://supabase_admin@127.0.0.1:<port>/sm_test1
# Staging access (read-only): ssh -i ~/.ssh/serapod_migration root@72.62.253.182 (KVM2). Never production.
set -euo pipefail
D="${1:?dump dir}"; PORT="${2:?port}"; mkdir -p "$D"
SSH=(ssh -i "$HOME/.ssh/serapod_migration" -o BatchMode=yes root@72.62.253.182)
DUMP='PGPASSWORD=$POSTGRES_PASSWORD pg_dump -U supabase_admin -h 127.0.0.1 -d supabase'
"${SSH[@]}" "docker exec serapod-stg-db sh -c '$DUMP -s -n public -n storage -n auth | gzip -c'" | gunzip -c > "$D/stg_schema.sql"  # gzip: a plain stream was truncated once
grep -q 'dump complete' "$D/stg_schema.sql" || { echo 'schema dump incomplete' >&2; exit 1; }
"${SSH[@]}" "docker exec serapod-stg-db sh -c '$DUMP -a --disable-triggers -t public.roles -t public.sa_permissions -t public.sa_migration_modes -t public.sa_legacy_compat_rules -t public.sa_business_roles -t public.sa_business_role_permissions -t public.sa_standard_policy_coverage -t public.sa_enforcement_readiness -t public.sa_org_type_eligibility -t public.sa_inventory_view_originals'" > "$D/stg_config.sql"
sed -i '' '/^\\restrict/d;/^\\unrestrict/d' "$D/stg_schema.sql" "$D/stg_config.sql"
P=(psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT")
"${P[@]}" -U postgres -d postgres <<'SQL'
do $r$ begin
  if not exists (select 1 from pg_roles where rolname = 'supabase_admin') then create role supabase_admin superuser login; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; grant anon, authenticated, service_role to authenticator; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin login createrole; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_storage_admin') then create role supabase_storage_admin login createrole; end if;
  if not exists (select 1 from pg_roles where rolname = 'dashboard_user') then create role dashboard_user nologin; end if;
end $r$;
SQL
createdb -h 127.0.0.1 -p "$PORT" -U postgres -O supabase_admin sm_tmpl
"${P[@]}" -U supabase_admin -d sm_tmpl -c 'create schema extensions; create extension pgcrypto schema extensions; create extension "uuid-ossp" schema extensions; create extension btree_gist schema extensions; drop schema public;'
"${P[@]}" -U supabase_admin -d sm_tmpl -f "$D/stg_schema.sql"
"${P[@]}" -U supabase_admin -d sm_tmpl -f "$D/stg_config.sql"
echo "sm_tmpl ready"
