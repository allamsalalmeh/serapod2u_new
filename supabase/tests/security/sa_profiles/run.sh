#!/usr/bin/env bash
# Usage: run.sh <connection-string of a DISPOSABLE database named sa_prof_test*>
# Loads minimal platform stand-ins, then the REAL S&A migrations the features depend on,
# then the new migrations, then every test file. Never run against Supabase.
set -euo pipefail
URL="${1:?connection string of a disposable sa_prof_test* database}"
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
H="$ROOT/supabase/tests/security/sa_profiles"
P=(psql -X -q -v ON_ERROR_STOP=1 "$URL")
"${P[@]}" -f "$H/00_bootstrap.sql"
echo "-- migration 20260927140000_sa_wave1_foundation"; "${P[@]}" -f "$ROOT/supabase/migrations/20260927140000_sa_wave1_foundation.sql"
# Only the catalog column of the readiness migration is needed (the rest depends on stock-count tables).
"${P[@]}" -c "alter table public.sa_permissions add column if not exists audit_sensitivity text not null default 'security_sensitive'; alter table public.sa_permissions add constraint sa_permissions_audit_sensitivity_valid check (audit_sensitivity in ('ordinary','security_sensitive')); alter function public.sa_save_business_role(uuid,uuid,text,text,text,text[]) set search_path = pg_catalog, pg_temp; alter function public.sa_reject_decision_mutation() set search_path = pg_catalog, pg_temp;"
apply() { echo "-- migration $1"; "${P[@]}" -f "$ROOT/supabase/migrations/$1.sql"; }
apply 20260928100000_sa_final_governance_foundation
apply 20261001130000_sa_grant_keeps_automatic_access
# The real guard injector (and its record table) from the Final Wave lifecycle migration; the rest of that file needs finance/HR tables.
awk '/^create table if not exists public.sa_function_guard_injections/{p=1} p{print} /^comment on table public.sa_function_guard_injections/{p=0}' "$ROOT/supabase/migrations/20260928110000_sa_final_finance_hr_lifecycle.sql" | "${P[@]}"
awk '/^create or replace function public.sa_inject_operation_guard/{p=1} p{print} /^revoke all on function public.sa_inject_operation_guard/{p=0}' "$ROOT/supabase/migrations/20260928110000_sa_final_finance_hr_lifecycle.sql" | "${P[@]}"
"${P[@]}" -f "$H/05_qr_standins.sql"
apply 20261005100000_sa_directory_visibility
apply 20261005110000_sa_access_profiles
apply 20261006100000_sa_qr_batch_operator_profile
apply 20261007100000_sa_directory_filters
echo "-- re-applying the QR migration (idempotency)"; "${P[@]}" -f "$ROOT/supabase/migrations/20261006100000_sa_qr_batch_operator_profile.sql"
for f in "$H"/[1-9]*.sql; do echo "== $(basename "$f")"; "${P[@]}" -f "$f"; done
echo "ALL SA PROFILE/DIRECTORY TESTS PASSED"
