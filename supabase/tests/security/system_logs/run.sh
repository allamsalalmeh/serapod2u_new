#!/usr/bin/env bash
# Usage: run.sh <connection string of a DISPOSABLE database named sa_prof_test*>
# REAL S&A migrations on stand-in platform tables (same base as sa_password_reset), stand-ins for orders/audit_logs,
# then the System Logs foundation + permission migrations (each applied twice for idempotency), then the suite.
# Never run against Supabase (localhost shares the staging database).
set -euo pipefail
URL="${1:?connection string of a disposable sa_prof_test* database}"
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
SP="$ROOT/supabase/tests/security/sa_profiles"
GP="$ROOT/supabase/tests/security/sa_group_policies"
H="$ROOT/supabase/tests/security/system_logs"
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
apply 20261009100000_sa_group_policies_full_access
apply 20261016100000_sa_user_password_reset_permission
# Readable-organization scope used by the System Logs list API (real function, extracted).
awk '/^create or replace function public.sa_readable_organizations/{p=1} p{print} /^revoke all on function public.sa_readable_organizations/{p=0}' "$ROOT/supabase/migrations/20260930100000_sa_stage2d_deferred_closure.sql" | "${P[@]}"
"${P[@]}" -f "$H/05_platform_standins.sql"
"${P[@]}" -c "create table saf.sl_modes_before as select permission_key, mode from public.sa_migration_modes; create table saf.sl_assign_before as select count(*) n from public.sa_role_assignments;"
apply 20261017100000_system_logs_foundation
echo "-- re-applying the foundation migration (idempotency)"; "${P[@]}" -f "$ROOT/supabase/migrations/20261017100000_system_logs_foundation.sql"
apply 20261017110000_sa_system_logs_view_permission
echo "-- re-applying the permission migration (idempotency)"; "${P[@]}" -f "$ROOT/supabase/migrations/20261017110000_sa_system_logs_view_permission.sql"
for f in "$H"/[2-9]*.sql; do echo "== $(basename "$f")"; "${P[@]}" -o /dev/null -f "$f"; done
echo "ALL SYSTEM LOGS TESTS PASSED"
