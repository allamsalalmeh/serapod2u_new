#!/usr/bin/env bash
# Usage: run.sh <connection string of a DISPOSABLE database named sa_prof_test*>
# REAL S&A migrations on stand-in platform tables (same base as sa_group_policies), then the Group Policies migration, then
# the password-reset migration (applied twice for idempotency), then the suite. Never run against Supabase.
set -euo pipefail
URL="${1:?connection string of a disposable sa_prof_test* database}"
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
SP="$ROOT/supabase/tests/security/sa_profiles"
GP="$ROOT/supabase/tests/security/sa_group_policies"
H="$ROOT/supabase/tests/security/sa_password_reset"
P=(psql -X -q -v ON_ERROR_STOP=1 "$URL")
"${P[@]}" -f "$SP/00_bootstrap.sql"
echo "-- migration 20260927140000_sa_wave1_foundation"; "${P[@]}" -f "$ROOT/supabase/migrations/20260927140000_sa_wave1_foundation.sql"
"${P[@]}" -c "alter table public.sa_permissions add column if not exists audit_sensitivity text not null default 'security_sensitive'; alter table public.sa_permissions add constraint sa_permissions_audit_sensitivity_valid check (audit_sensitivity in ('ordinary','security_sensitive')); alter function public.sa_save_business_role(uuid,uuid,text,text,text,text[]) set search_path = pg_catalog, pg_temp; alter function public.sa_reject_decision_mutation() set search_path = pg_catalog, pg_temp;"
apply() { echo "-- migration $1"; "${P[@]}" -f "$ROOT/supabase/migrations/$1.sql"; }
apply 20260928100000_sa_final_governance_foundation
apply 20261001130000_sa_grant_keeps_automatic_access
awk '/^create table if not exists public.sa_function_guard_injections/{p=1} p{print} /^comment on table public.sa_function_guard_injections/{p=0}' "$ROOT/supabase/migrations/20260928110000_sa_final_finance_hr_lifecycle.sql" | "${P[@]}"
awk '/^create or replace function public.sa_inject_operation_guard/{p=1} p{print} /^revoke all on function public.sa_inject_operation_guard/{p=0}' "$ROOT/supabase/migrations/20260928110000_sa_final_finance_hr_lifecycle.sql" | "${P[@]}"
"${P[@]}" -f "$SP/05_qr_standins.sql"
O="$ROOT/supabase/migrations/20260928130000_sa_final_legacy_retirement_support.sql"
awk '/^create table if not exists public.sa_enforcement_readiness/{p=1} p{print} /^grant select on table public.sa_enforcement_readiness/{p=0}' "$O" | "${P[@]}"
apply 20261004100000_sa_bulk_migration_mode
apply 20261005100000_sa_directory_visibility
apply 20261005110000_sa_access_profiles
apply 20261006100000_sa_qr_batch_operator_profile
apply 20261007100000_sa_directory_filters
apply 20261008100000_sa_mode_governance_actor_context
"${P[@]}" -f "$GP/05_catalogue_standins.sql"
"${P[@]}" -f "$GP/10_fixtures.sql"
# Before the migration: the permission and policy do not exist (negative control).
"${P[@]}" -c "do \$\$ begin if exists (select 1 from public.sa_permissions where permission_key = 'platform.user.password_reset') then raise exception 'unexpected permission before migration'; end if; end \$\$;"
apply 20261009100000_sa_group_policies_full_access
# The password-reset migration refuses to run without its prerequisites (checked on a bare database elsewhere); here they exist.
"${P[@]}" -c "create table saf.pw_before as select permission_key, mode from public.sa_migration_modes; create table saf.pw_assign_before as select count(*) n from public.sa_role_assignments;"
apply 20261016100000_sa_user_password_reset_permission
echo "-- re-applying the password-reset migration (idempotency)"; "${P[@]}" -f "$ROOT/supabase/migrations/20261016100000_sa_user_password_reset_permission.sql"
echo "== 20_reset_tests.sql"; "${P[@]}" -o /dev/null -f "$H/20_reset_tests.sql"
# Staging incident of 2026-10-08: read-only legacy authorization left the compatibility roles without the key.
echo "== 25_compat_setup.sql"; "${P[@]}" -o /dev/null -f "$H/25_compat_setup.sql"
apply 20261025100000_sa_password_reset_compat_roles
echo "-- re-applying the compat-role migration (idempotency)"; "${P[@]}" -f "$ROOT/supabase/migrations/20261025100000_sa_password_reset_compat_roles.sql"
echo "== 30_compat_tests.sql"; "${P[@]}" -o /dev/null -f "$H/30_compat_tests.sql"
echo "ALL SA PASSWORD RESET TESTS PASSED"
