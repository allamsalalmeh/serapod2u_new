#!/usr/bin/env bash
# Usage: run.sh <connection string of a DISPOSABLE database named sa_prof_test*>
# REAL S&A migrations on stand-in platform tables (same base as sa_password_reset), the REAL identity lifecycle function
# (identity_set_account_status), API-role/history guards and sa_actor_dominates, the REAL mode-change functions
# (20261019110000), then 20261023100000_sa_identity_delete_enforcement_ready (applied twice). Never run against Supabase.
set -euo pipefail
URL="${1:?connection string of a disposable sa_prof_test* database}"
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
M="$ROOT/supabase/migrations"
SP="$ROOT/supabase/tests/security/sa_profiles"
GP="$ROOT/supabase/tests/security/sa_group_policies"
H="$ROOT/supabase/tests/security/sa_identity_delete"
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
apply 20261019110000_sa_mode_change_note_and_keep_retired
# Identity stand-ins (lifecycle columns + Phase 0A trigger the guard migration requires), then the REAL identity pieces.
"${P[@]}" -f "$H/05_identity_standins.sql"
apply 20260929120000_identity_protected_fields_guard
block 20260929110000_identity_foundation 'create or replace function public.identity_legacy_user_admin' 'revoke all on function public.identity_legacy_user_admin'
block 20260929160000_identity_stage2_archive_keeps_identifiers 'create or replace function public.identity_set_account_status' 'grant execute on function public.identity_set_account_status'
block 20260930100000_sa_stage2d_deferred_closure 'create or replace function public.sa_actor_dominates' 'grant execute on function public.sa_actor_dominates'
"${P[@]}" -f "$H/10_fixtures.sql"
# Negative control: before the migration the permission is blocked in preview AND execution.
"${P[@]}" -o /dev/null -f "$H/20_before_tests.sql"
apply 20261023100000_sa_identity_delete_enforcement_ready
echo "-- re-applying (idempotency)"; "${P[@]}" -f "$M/20261023100000_sa_identity_delete_enforcement_ready.sql"
for f in "$H"/3*.sql; do echo "== $(basename "$f")"; "${P[@]}" -o /dev/null -f "$f"; done
echo "ALL SA IDENTITY DELETE TESTS PASSED"
