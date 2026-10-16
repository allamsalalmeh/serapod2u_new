#!/usr/bin/env bash
# Usage: run.sh <connection string of a DISPOSABLE database restored from a schema-only staging dump>
#   (pg_dump -s -n public -n storage -n auth; bootstrap roles anon/authenticated/service_role + auth.uid() first —
#    see supabase/tests/security/sa_wave1_readiness/00_harness_and_fixtures.sql). NEVER run against Supabase:
#    localhost shares the staging database, and the harness simulates PostgREST with SET ROLE.
# Order: fixtures → negative control (the tenant-remainder bypass reproduced on the unpatched schema) →
#        20261021100000 → guard suite. The migration runs in autocommit mode, as management runs it, and twice
#        (repeat-safety).
set -euo pipefail
URL="${1:?connection string of a disposable database}"
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
H="$ROOT/supabase/tests/security/sa_tenant_remainder"
P=(psql -X -q -v ON_ERROR_STOP=1 "$URL")
"${P[@]}" -f "$ROOT/supabase/migrations/20260927140000_sa_wave1_foundation.sql" >/dev/null   # catalog seed (schema-only dump has none)
"${P[@]}" -f "$ROOT/supabase/tests/security/sa_wave1_readiness/00_harness_and_fixtures.sql" >/dev/null
"${P[@]}" -f "$H/10_fixtures.sql"
echo "== 20_negative_control.sql (before the fix)"; "${P[@]}" -f "$H/20_negative_control.sql"
echo "-- migration 20261021100000 (twice)"
"${P[@]}" -f "$ROOT/supabase/migrations/20261021100000_sa_tenant_remainder_write_guards.sql" >/dev/null
"${P[@]}" -f "$ROOT/supabase/migrations/20261021100000_sa_tenant_remainder_write_guards.sql" >/dev/null
"${P[@]}" -f "$H/30_guards.sql"
echo "ALL TENANT-REMAINDER GUARD TESTS PASSED"
