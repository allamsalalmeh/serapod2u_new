#!/usr/bin/env bash
# Usage: run.sh <connection string of a DISPOSABLE copy of the staging-schema replica (database name og_test*)>
# Never point this at Supabase: localhost shares the staging database.
# Replica recipe: ../sa_stock_movement_access/build_replica.sh <dump dir> <port>, then createdb -T sm_tmpl og_test1.
set -euo pipefail
URL="${1:?connection string of a disposable og_test* database}"
case "$URL" in *og_test*) ;; *) echo "refusing: database name must contain og_test" >&2; exit 2;; esac
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
M="$ROOT/supabase/migrations"
H="$ROOT/supabase/tests/security/sa_org_insert_gate"
P=(psql -X -q -t -v ON_ERROR_STOP=1 "$URL")
LOG="$(mktemp)"
run() {  # run <file> <label>: print the ok lines, or the whole log and stop on failure
  echo "== $2"
  if "${P[@]}" -f "$1" >"$LOG" 2>&1; then grep -E 'ok - ' "$LOG" | sed -E 's/^.*NOTICE: +//' || true
  else cat "$LOG"; echo "FAILED: $2"; exit 1; fi
}
run "$H/00_helpers.sql" 'helpers'
run "$H/10_fixtures.sql" 'synthetic fixtures'
run "$H/20_negative_control.sql" 'negative control (staging schema, unpatched)'
echo "== fail-safe: unexpected policy text + migration in one transaction (psql -1) must be refused"
if "${P[@]}" -1 -f "$H/25_tamper.sql" -f "$M/20261213100000_sa_organization_insert_gate.sql" >"$LOG" 2>&1; then
  cat "$LOG"; echo "FAILED: migration accepted unexpected policy text"; exit 1
fi
grep -q 'not the expected text; nothing changed' "$LOG" || { cat "$LOG"; echo "FAILED: wrong refusal"; exit 1; }
echo "ok - migration refused unexpected policy text"
run "$H/26_after_failed_apply.sql" 'fail-safe: nothing persisted'
run1() {  # as recommended for staging: one transaction, lock timeout
  echo "== $2"
  if "${P[@]}" -1 -c "set lock_timeout = '5s'" -f "$1" >"$LOG" 2>&1; then grep -E 'ok - |sa_org_insert_gate' "$LOG" | sed -E 's/^.*NOTICE: +//' || true
  else cat "$LOG"; echo "FAILED: $2"; exit 1; fi
}
run1 "$M/20261213100000_sa_organization_insert_gate.sql" 'migration 20261213100000 (psql -1)'
run1 "$M/20261213100000_sa_organization_insert_gate.sql" 'migration 20261213100000 again (idempotency)'
run "$H/30_after_new_mode.sql" 'after: S&A mode (LEGACY_RETIRED, as on staging)'
run "$H/40_legacy_mode.sql" 'after: legacy mode'
rm -f "$LOG"
echo "ALL SA ORGANIZATION INSERT GATE TESTS PASSED"
