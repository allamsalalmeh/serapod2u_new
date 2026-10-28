#!/usr/bin/env bash
# S&A finalization harness: 20261215100000 (payment gateway), 20261215110000 (legacy cutover controls),
# 20261215120000 (hr.employee.delete mode). Prerequisite 20261214100000 is applied first (it is on staging).
# Usage: run.sh <connection string of a DISPOSABLE copy of the staging-schema replica (database name ph_test*)>
# Replica recipe: ../sa_policy_hardening/build_replica.sh (read-only staging schema + S&A configuration rows).
# Never point this at Supabase: localhost shares the staging database.
set -euo pipefail
URL="${1:?connection string of a disposable ph_test* database}"
case "$URL" in *ph_test*) ;; *) echo "refusing: database name must contain ph_test" >&2; exit 2;; esac
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
MIG="$ROOT/supabase/migrations"
H="$ROOT/supabase/tests/security/sa_legacy_cutover"
P=(psql -X -q -t -v ON_ERROR_STOP=1 "$URL")
LOG="$(mktemp)"
run() {  # run <file> <label>: print the ok/notice lines, or the whole log and stop on failure
  echo "== $2"
  if "${P[@]}" -f "$1" >"$LOG" 2>&1; then grep -E 'ok - |NOTICE: ' "$LOG" | sed -E 's/^.*NOTICE: +//' || true
  else cat "$LOG"; echo "FAILED: $2"; exit 1; fi
}
run "$H/00_helpers.sql" 'helpers'
run "$MIG/20261214100000_hr_employee_controlled_delete.sql" 'prerequisite 20261214100000 (applied on staging)'
run "$H/10_fixtures.sql" 'synthetic fixtures'
run "$H/20_before_tests.sql" 'negative control (unpatched)'
for m in 20261215100000_sa_payment_gateway_restriction 20261215110000_sa_legacy_compat_cutover_controls 20261215120000_sa_hr_employee_delete_mode_retired; do
  run "$MIG/$m.sql" "migration $m"
  run "$MIG/$m.sql" "migration $m again (idempotency)"
done
run "$H/30_after_tests.sql" 'after'
rm -f "$LOG"
echo "ALL SA LEGACY CUTOVER TESTS PASSED"
