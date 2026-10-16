#!/usr/bin/env bash
# Usage: run.sh <connection string of a DISPOSABLE database restored from a schema-only staging dump>
#   (see supabase/tests/security/sa_tenant_remainder/run.sh for the bootstrap). NEVER run against Supabase:
#   localhost shares the staging database, and the harness simulates PostgREST with SET ROLE.
# Order: harness → tenant-remainder fixtures (people, orgs, grants) → own fixtures → negative control on the unpatched
#        schema → 20261022100000 (twice, repeat-safety) → suite.
set -euo pipefail
URL="${1:?connection string of a disposable database}"
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
H="$ROOT/supabase/tests/security/sa_actor_org_gates"
P=(psql -X -q -v ON_ERROR_STOP=1 "$URL")
"${P[@]}" -f "$ROOT/supabase/migrations/20260927140000_sa_wave1_foundation.sql" >/dev/null
"${P[@]}" -f "$ROOT/supabase/tests/security/sa_wave1_readiness/00_harness_and_fixtures.sql" >/dev/null
"${P[@]}" -f "$ROOT/supabase/tests/security/sa_tenant_remainder/10_fixtures.sql" >/dev/null
"${P[@]}" -f "$H/10_fixtures.sql"
echo "== 20_negative_control.sql (before the fix)"; "${P[@]}" -f "$H/20_negative_control.sql"
echo "-- migration 20261022100000 (twice)"
"${P[@]}" -f "$ROOT/supabase/migrations/20261022100000_sa_actor_org_gates_row_context.sql" >/dev/null
"${P[@]}" -f "$ROOT/supabase/migrations/20261022100000_sa_actor_org_gates_row_context.sql" >/dev/null
"${P[@]}" -f "$H/30_gates.sql"
echo "ALL ACTOR-ORG GATE TESTS PASSED"
