#!/usr/bin/env bash
# Usage: run.sh <connection string of a DISPOSABLE database named sa_prof_test*>
# REAL S&A migrations on stand-in platform tables (same base as sa_emergency_access), the REAL emergency-access grant
# flow (20261024100000, prerequisite), a negative control, then 20261026100000_sa_root_access (applied twice) and
# the Root Access tests, including two concurrent sessions revoking each other. Never run against Supabase.
set -euo pipefail
URL="${1:?connection string of a disposable sa_prof_test* database}"
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
M="$ROOT/supabase/migrations"
SP="$ROOT/supabase/tests/security/sa_profiles"
GP="$ROOT/supabase/tests/security/sa_group_policies"
ID="$ROOT/supabase/tests/security/sa_identity_delete"
EA="$ROOT/supabase/tests/security/sa_emergency_access"
H="$ROOT/supabase/tests/security/sa_root_access"
P=(psql -X -q -v ON_ERROR_STOP=1 "$URL")
block() { awk -v s="$2" -v e="$3" 'index($0, s) == 1 {p=1} p {print} p && index($0, e) == 1 {p=0}' "$M/$1.sql" | "${P[@]}"; }
"${P[@]}" -f "$SP/00_bootstrap.sql"
# Supabase default privileges: every new public function/table/sequence is granted to anon, authenticated AND
# service_role. Without this a migration that forgets to revoke service_role passes here and fails on staging.
"${P[@]}" -c "alter default privileges in schema public grant all on functions to anon, authenticated, service_role; alter default privileges in schema public grant all on tables to anon, authenticated, service_role; alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;"
echo "-- migration 20260927140000_sa_wave1_foundation"; "${P[@]}" -f "$M/20260927140000_sa_wave1_foundation.sql"
"${P[@]}" -c "alter table public.sa_permissions add column if not exists audit_sensitivity text not null default 'security_sensitive'; alter table public.sa_permissions add constraint sa_permissions_audit_sensitivity_valid check (audit_sensitivity in ('ordinary','security_sensitive')); alter function public.sa_save_business_role(uuid,uuid,text,text,text,text[]) set search_path = pg_catalog, pg_temp; alter function public.sa_reject_decision_mutation() set search_path = pg_catalog, pg_temp;"
apply() { echo "-- migration $1"; "${P[@]}" -f "$M/$1.sql"; }
apply 20260928100000_sa_final_governance_foundation
apply 20261001130000_sa_grant_keeps_automatic_access
block 20260928110000_sa_final_finance_hr_lifecycle 'create table if not exists public.sa_function_guard_injections' 'comment on table public.sa_function_guard_injections'
block 20260928110000_sa_final_finance_hr_lifecycle 'create or replace function public.sa_inject_operation_guard' 'revoke all on function public.sa_inject_operation_guard'
block 20260928110000_sa_final_finance_hr_lifecycle 'create or replace function public.sa_cached_mode_is_new' 'revoke all on function public.sa_cached_mode_is_new'
block 20260928110000_sa_final_finance_hr_lifecycle 'create or replace function public.sa_cached_actor_allows' 'revoke all on function public.sa_cached_actor_allows'
block 20260928110000_sa_final_finance_hr_lifecycle 'create or replace function public.sa_rls_gate(' 'revoke all on function public.sa_rls_gate('
"${P[@]}" -f "$SP/05_qr_standins.sql"
block 20260928130000_sa_final_legacy_retirement_support 'create table if not exists public.sa_enforcement_readiness' 'grant select on table public.sa_enforcement_readiness'
apply 20261004100000_sa_bulk_migration_mode
apply 20261005100000_sa_directory_visibility
apply 20261005110000_sa_access_profiles
apply 20261006100000_sa_qr_batch_operator_profile
apply 20261007100000_sa_directory_filters
apply 20261008100000_sa_mode_governance_actor_context
"${P[@]}" -f "$GP/05_catalogue_standins.sql"
"${P[@]}" -f "$GP/10_fixtures.sql"
apply 20261009100000_sa_group_policies_full_access
apply 20261011100000_sa_scope_eligibility_for_grants
apply 20261019110000_sa_mode_change_note_and_keep_retired
"${P[@]}" -f "$ID/05_identity_standins.sql"
block 20260930100000_sa_stage2d_deferred_closure 'create or replace function public.sa_readable_organizations' 'grant execute on function public.sa_readable_organizations'
block 20260930100000_sa_stage2d_deferred_closure 'create or replace function public.sa_actor_dominates' 'grant execute on function public.sa_actor_dominates'
"${P[@]}" -f "$EA/05_auth_mfa_standins.sql"
"${P[@]}" -f "$EA/10_fixtures.sql"
if [ -n "${EMERGENCY_SQL:-}" ]; then echo "-- migration (override) $EMERGENCY_SQL"; "${P[@]}" -f "$EMERGENCY_SQL"; else apply 20261024100000_sa_emergency_access_grant_flow; fi
"${P[@]}" -f "$H/10_fixtures.sql"
# Negative control + baseline decisions of every person before Root Access exists.
echo "== 20_before_tests.sql"; "${P[@]}" -o /dev/null -f "$H/20_before_tests.sql"
apply 20261026100000_sa_root_access
echo "-- re-applying (idempotency)"; "${P[@]}" -f "$M/20261026100000_sa_root_access.sql"
echo "== 30_root_tests.sql"; "${P[@]}" -o /dev/null -f "$H/30_root_tests.sql"

# Two Root Administrators revoke each other at the same moment: the advisory lock serializes them, so exactly one
# revocation succeeds and one Root Administrator remains.
echo "== concurrency: mutual revocation"
"${P[@]}" -o /dev/null -f "$H/40_concurrency_setup.sql"
A=$(mktemp); B=$(mktemp)
psql -X -q -tA "$URL" -c "begin; select (public.sa_revoke_root_access(saf.u(10), saf.u(6), 'concurrent revoke from session A')->>'ok'); select pg_sleep(2); commit;" >"$A" &
sleep 0.5
psql -X -q -tA "$URL" -c "select (public.sa_revoke_root_access(saf.u(6), saf.u(10), 'concurrent revoke from session B')->>'ok')" >"$B" &
wait
echo "   session A ok=$(head -1 "$A")  session B ok=$(head -1 "$B")"
[ "$(head -1 "$A")" = "true" ] && [ "$(head -1 "$B")" = "false" ] || { echo "ASSERTION FAILED: exactly session A must win"; exit 1; }
"${P[@]}" -o /dev/null -f "$H/45_final_checks.sql"
rm -f "$A" "$B"
echo "ALL SA ROOT ACCESS TESTS PASSED"
