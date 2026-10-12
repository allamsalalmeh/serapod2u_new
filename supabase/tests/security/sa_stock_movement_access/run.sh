#!/usr/bin/env bash
# Usage: run.sh <connection string of a DISPOSABLE copy of the staging-schema replica (database name sm_test*)>
# Never point this at Supabase: localhost shares the staging database. Replica recipe: build_replica.sh.
set -euo pipefail
URL="${1:?connection string of a disposable sm_test* database}"
case "$URL" in *sm_test*) ;; *) echo "refusing: database name must contain sm_test" >&2; exit 2;; esac
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
M="$ROOT/supabase/migrations"
H="$ROOT/supabase/tests/security/sa_stock_movement_access"
P=(psql -X -q -t -v ON_ERROR_STOP=1 "$URL")
LOG="$(mktemp)"
run() {  # run <file> <label>: print the ok lines, or the whole log and stop on failure
  echo "== $2"
  if "${P[@]}" -f "$1" >"$LOG" 2>&1; then grep -E 'ok - ' "$LOG" | sed -E 's/^.*NOTICE: +//' || true
  else cat "$LOG"; echo "FAILED: $2"; exit 1; fi
}
run "$H/00_helpers.sql" 'helpers'
run "$H/10_fixtures.sql" 'synthetic fixtures'
run "$H/20_before_tests.sql" 'negative control (staging schema, unpatched)'
run "$M/20261029100000_stock_movements_ordered_view_invoker.sql" 'migration 20261029100000 (superseded no-op)'
run "$M/20261107100000_sa_stock_movement_access.sql" 'migration 20261107100000 (autocommit)'
run "$M/20261107100000_sa_stock_movement_access.sql" 'migration 20261107100000 again (idempotency)'
run "$H/30_after_tests.sql" 'after: S&A mode (staging modes)'
run "$H/40_legacy_mode_tests.sql" 'after: legacy mode (environments not yet on S&A inventory)'
rm -f "$LOG"
echo "ALL SA STOCK MOVEMENT ACCESS TESTS PASSED"
