#!/usr/bin/env bash
# Usage: run.sh <connection string of a DISPOSABLE database named sa_prof_test*>
# REAL S&A migrations (wave1 … actor context) on stand-in platform tables, fixtures with a PRE-EXISTING grant to a
# Distributor scope (negative control: the new migration must not touch it), then the scope-eligibility migration (applied twice
# for idempotency) and the suites. Never run against Supabase.
set -euo pipefail
URL="${1:?connection string of a disposable sa_prof_test* database}"
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
SP="$ROOT/supabase/tests/security/sa_profiles"
H="$ROOT/supabase/tests/security/sa_scope_eligibility"
P=(psql -X -q -v ON_ERROR_STOP=1 "$URL")
"${P[@]}" -f "$SP/00_bootstrap.sql"
"${P[@]}" -f "$ROOT/supabase/migrations/20260927140000_sa_wave1_foundation.sql"
"${P[@]}" -c "alter table public.sa_permissions add column if not exists audit_sensitivity text not null default 'security_sensitive'; alter table public.sa_permissions add constraint sa_permissions_audit_sensitivity_valid check (audit_sensitivity in ('ordinary','security_sensitive')); alter function public.sa_save_business_role(uuid,uuid,text,text,text,text[]) set search_path = pg_catalog, pg_temp; alter function public.sa_reject_decision_mutation() set search_path = pg_catalog, pg_temp;"
apply() { echo "-- migration $1"; "${P[@]}" -f "$ROOT/supabase/migrations/$1.sql"; }
apply 20260928100000_sa_final_governance_foundation
apply 20261001130000_sa_grant_keeps_automatic_access
"${P[@]}" -f "$H/10_fixtures.sql"
apply 20261011100000_sa_scope_eligibility_for_grants
echo "-- re-applying (idempotency)"; "${P[@]}" -f "$ROOT/supabase/migrations/20261011100000_sa_scope_eligibility_for_grants.sql"
for f in "$H"/[2-9]*.sql; do echo "== $(basename "$f")"; "${P[@]}" -o /dev/null -f "$f"; done
echo "ALL SA SCOPE ELIGIBILITY TESTS PASSED"
