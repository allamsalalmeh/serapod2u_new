#!/usr/bin/env bash
# Usage: run.sh <connection string of a DISPOSABLE database restored from a schema-only staging dump>
#   (pg_dump -s -n public -n storage -n auth; bootstrap roles anon/authenticated/service_role + auth.uid() first —
#    see supabase/tests/security/sa_wave1_readiness/00_harness_and_fixtures.sql). NEVER run against Supabase:
#    localhost shares the staging database, and the harness simulates PostgREST with SET ROLE.
# Order: fixtures → negative control (defects reproduced on the unpatched schema) → 20261019100000 → create/post
#        suites → mode-change negative control → 20261019110000 → mode-change suite. Migrations run in autocommit mode,
#        as management runs them.
set -euo pipefail
URL="${1:?connection string of a disposable database}"
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
H="$ROOT/supabase/tests/security/sa_stock_count_create_post"
P=(psql -X -q -v ON_ERROR_STOP=1 "$URL")
"${P[@]}" -f "$ROOT/supabase/migrations/20260927140000_sa_wave1_foundation.sql" >/dev/null   # catalog seed (schema-only dump has none)
"${P[@]}" -f "$ROOT/supabase/tests/security/sa_wave1_readiness/00_harness_and_fixtures.sql" >/dev/null
"${P[@]}" -f "$H/10_fixtures.sql"
echo "== 20_negative_control.sql (before the fix)"; "${P[@]}" -f "$H/20_negative_control.sql"
echo "-- migration 20261019100000"; "${P[@]}" -f "$ROOT/supabase/migrations/20261019100000_sa_stock_count_create_post_enforcement.sql" >/dev/null
"${P[@]}" -f "$H/30_create.sql"
"${P[@]}" -f "$H/40_post.sql"
echo "== 50_mode_changes.sql (before the fix)"; "${P[@]}" -v before_fix=true -f "$H/50_mode_changes.sql"
echo "-- migration 20261019110000"; "${P[@]}" -f "$ROOT/supabase/migrations/20261019110000_sa_mode_change_note_and_keep_retired.sql" >/dev/null
"${P[@]}" -f "$H/50_mode_changes.sql"
echo "ALL STOCK COUNT CREATE/POST + MODE CHANGE TESTS PASSED"
