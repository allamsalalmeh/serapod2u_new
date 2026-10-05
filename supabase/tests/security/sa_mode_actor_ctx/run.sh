#!/usr/bin/env bash
# Usage: run.sh <connection string of a DISPOSABLE database named sa_prof_test*>
# Real S&A functions (wave1 foundation, final governance, bulk-mode migration) on stand-in platform
# tables. Runs the defect reproduction BEFORE the fix migration (negative control), then the fix, then
# the behaviour tests. Never run against Supabase.
set -euo pipefail
URL="${1:?connection string of a disposable sa_prof_test* database}"
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
H="$ROOT/supabase/tests/security/sa_mode_actor_ctx"
P=(psql -X -q -v ON_ERROR_STOP=1 "$URL")
"${P[@]}" -f "$ROOT/supabase/tests/security/sa_profiles/00_bootstrap.sql"
"${P[@]}" -f "$ROOT/supabase/migrations/20260927140000_sa_wave1_foundation.sql"
"${P[@]}" -c "alter table public.sa_permissions add column if not exists audit_sensitivity text not null default 'security_sensitive'; alter function public.sa_save_business_role(uuid,uuid,text,text,text,text[]) set search_path = pg_catalog, pg_temp; alter function public.sa_reject_decision_mutation() set search_path = pg_catalog, pg_temp;"
apply() { echo "-- migration $1"; "${P[@]}" -f "$ROOT/supabase/migrations/$1.sql"; }
apply 20260928100000_sa_final_governance_foundation
# Readiness registry table (definition only) and the original single-change function come from the retirement-support migration.
O="$ROOT/supabase/migrations/20260928130000_sa_final_legacy_retirement_support.sql"
awk '/^create table if not exists public.sa_enforcement_readiness/{p=1} p{print} /^grant select on table public.sa_enforcement_readiness/{p=0}' "$O" | "${P[@]}"
apply 20261004100000_sa_bulk_migration_mode
"${P[@]}" -f "$H/10_fixtures.sql"
echo "== 20_defect_reproduction.sql (before the fix)"; "${P[@]}" -f "$H/20_defect_reproduction.sql"
apply 20261008100000_sa_mode_governance_actor_context
"${P[@]}" -f "$H/30_tests.sql"
echo "ALL SA MODE ACTOR-CONTEXT TESTS PASSED"
