#!/usr/bin/env bash
# Usage: run.sh <connection string of a DISPOSABLE database named sa_prof_test*>
# REAL S&A migrations on stand-in platform tables (same base as sa_identity_delete), stand-ins for the three GoTrue
# MFA tables the step-up check reads (auth.sessions / auth.mfa_factors / auth.mfa_amr_claims, staging column names and
# enum types), the REAL mode-change functions, then 20261024100000_sa_emergency_access_grant_flow (applied twice) and
# 20261024110000_sa_emergency_access_enable. Never run against Supabase.
# NOTE: the MFA rows here are fixtures written directly into stand-in tables. This proves the DATABASE decision logic,
# not GoTrue itself; real TOTP enrollment/verification is covered by the manual test guide.
set -euo pipefail
URL="${1:?connection string of a disposable sa_prof_test* database}"
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
M="$ROOT/supabase/migrations"
SP="$ROOT/supabase/tests/security/sa_profiles"
GP="$ROOT/supabase/tests/security/sa_group_policies"
ID="$ROOT/supabase/tests/security/sa_identity_delete"
H="$ROOT/supabase/tests/security/sa_emergency_access"
P=(psql -X -q -v ON_ERROR_STOP=1 "$URL")
block() { awk -v s="$2" -v e="$3" 'index($0, s) == 1 {p=1} p {print} p && index($0, e) == 1 {p=0}' "$M/$1.sql" | "${P[@]}"; }
"${P[@]}" -f "$SP/00_bootstrap.sql"
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
block 20260930100000_sa_stage2d_deferred_closure 'create or replace function public.sa_actor_dominates' 'grant execute on function public.sa_actor_dominates'
"${P[@]}" -f "$H/05_auth_mfa_standins.sql"
"${P[@]}" -f "$H/10_fixtures.sql"
# Negative control: before the migration the permission is blocked everywhere and nothing can grant.
"${P[@]}" -o /dev/null -f "$H/20_before_tests.sql"
apply 20261024100000_sa_emergency_access_grant_flow
echo "-- re-applying (idempotency)"; "${P[@]}" -f "$M/20261024100000_sa_emergency_access_grant_flow.sql"
echo "== 30_disabled_tests.sql"; "${P[@]}" -o /dev/null -f "$H/30_disabled_tests.sql"
apply 20261024110000_sa_emergency_access_enable
echo "-- re-applying (idempotency)"; "${P[@]}" -f "$M/20261024110000_sa_emergency_access_enable.sql"
for f in "$H"/[4-9]*.sql; do echo "== $(basename "$f")"; "${P[@]}" -o /dev/null -f "$f"; done
echo "ALL SA EMERGENCY ACCESS TESTS PASSED"
