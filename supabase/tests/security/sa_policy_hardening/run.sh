#!/usr/bin/env bash
# Usage: run.sh <connection string of a DISPOSABLE copy of the staging-schema replica (database name ph_test*)>
# Never point this at Supabase: localhost shares the staging database. Replica recipe: build_replica.sh.
set -euo pipefail
URL="${1:?connection string of a disposable ph_test* database}"
case "$URL" in *ph_test*) ;; *) echo "refusing: database name must contain ph_test" >&2; exit 2;; esac
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
M="$ROOT/supabase/migrations/20261110100000_sa_policy_hardening_and_new_standard_policies.sql"
H="$ROOT/supabase/tests/security/sa_policy_hardening"
P=(psql -X -q -t -v ON_ERROR_STOP=1 "$URL")
LOG="$(mktemp)"
run() {  # run <file> <label>: print the ok lines, or the whole log and stop on failure
  echo "== $2"
  if "${P[@]}" -f "$1" >"$LOG" 2>&1; then grep -E 'ok - |kept: ' "$LOG" | sed -E 's/^.*NOTICE: +//' || true
  else cat "$LOG"; echo "FAILED: $2"; exit 1; fi
}
run "$H/00_helpers.sql" 'helpers'
run "$H/10_fixtures.sql" 'synthetic fixtures'
run "$H/20_before_tests.sql" 'negative control (staging schema + configuration, unpatched)'
run "$M" 'migration 20261110100000 (autocommit)'
run "$M" 'migration 20261110100000 again (idempotency)'
run "$H/30_after_tests.sql" 'after'
rm -f "$LOG"
echo "ALL SA POLICY HARDENING TESTS PASSED"
