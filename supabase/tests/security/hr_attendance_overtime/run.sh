#!/usr/bin/env bash
# HR Wave 3 replica harness: 20261222100000 (hybrid attendance & overtime) + 20261223100000 (leave ledger).
# DISPOSABLE replica only — never staging/production.
# Usage: run.sh <connection string of a FRESH disposable replica whose db name contains "test"> [--no-lifecycle]
#   --no-lifecycle: production snapshot 2026-10-16 (predates 20261214…20261218): lifecycle files and their
#                   compatibility suites are skipped; everything else runs.
#   Build: ../hr_leave_containment/build_replica_from_snapshot.sh <port> stg <db name containing test>
# Order: lifecycle 20261214…20261218 → B2A → Wave 2 → base + W2 fixtures → W2 baseline re-apply → B2A after-tests
#   (reference; their fixture dates deliberately overlap, which Wave 3's duplicate-leave rule now refuses) → Wave 3A → Wave 3B
#   (opening balance over the fixtures) → idempotent re-apply of 3A/3B → Wave 2 behaviour tests WITH Wave 3 →
#   W3 fixtures → W3 behaviour (incl. B2A authority regression with Wave 3) → B2A + W2 lifecycle compatibility (HR reset /
#   restore, identity archive/delete) WITH Wave 3 → W3 safe rollback → re-apply → after.
set -euo pipefail
URL="${1:?connection string of a disposable *test* database}"; MODE="${2:-}"
case "$URL" in *test*) ;; *) echo "refusing: database name must contain 'test'" >&2; exit 2;; esac
case "$URL" in *supabase.co*|*getouch*|*pooler*|*72.62.253.182*) echo "refusing: looks like a shared host" >&2; exit 2;; esac
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
MIG="$ROOT/supabase/migrations"; B2A="$MIG/20261219100000_hr_leave_containment_guard.sql"; W2="$MIG/20261221100000_hr_employment_foundation.sql"
W3A="$MIG/20261222100000_hr_hybrid_attendance_overtime.sql"; W3B="$MIG/20261223100000_hr_leave_ledger.sql"
H="$ROOT/supabase/tests/security/hr_attendance_overtime"; L="$ROOT/supabase/tests/security/hr_leave_containment"
F="$ROOT/supabase/tests/security/hr_employment_foundation"
P=(psql -X -q -v ON_ERROR_STOP=1 "$URL")
LOG="$(mktemp)"; TOTAL=0
run() {
  echo "== $2"
  if "${P[@]}" ${3:-} -f "$1" >"$LOG" 2>&1; then
    local c; c=$(grep -c 'ok - ' "$LOG" || true); TOTAL=$((TOTAL + c)); grep -E 'ok - ' "$LOG" | sed -E 's/^.*NOTICE: +//' || true
  else cat "$LOG"; echo "FAILED: $2"; exit 1; fi
}
if [ "$MODE" != "--no-lifecycle" ]; then
  run "$L/05_lifecycle_catalogue_seed.sql" 'synthetic S&A catalogue (lifecycle)'
  for f in 20261214100000_hr_employee_controlled_delete 20261216100000_identity_permanent_deletion \
           20261217100000_identity_archive_identifier_release 20261218100000_identity_archive_optional_reason; do
    run "$MIG/$f.sql" "lifecycle $f" -1
  done
fi
run "$B2A" 'B2A 20261219100000' -1
run "$W2" 'Wave 2 20261221100000' -1
run "$L/10_fixtures.sql" 'base synthetic fixtures (hlc)'
run "$F/15_w2_fixtures.sql" 'Wave 2 synthetic fixtures'
run "$W2" 'Wave 2 re-applied (baseline)' -1
run "$L/30_after_tests.sql" 'B2A after-tests (reference, before Wave 3; rolled back)'
run "$H/05_negative_control.sql" 'negative control (no Wave 3: the gaps must exist; rolled back)'
run "$W3A" 'Wave 3A 20261222100000' -1
run "$W3B" 'Wave 3B 20261223100000 (opening balance over existing balances)' -1
run "$W3A" 'Wave 3A re-applied (idempotency)' -1
run "$W3B" 'Wave 3B re-applied (idempotency; opening not repeated)' -1
run "$H/10_opening_checks.sql" 'opening balance checks'
run "$F/20_tests.sql" 'Wave 2 behaviour WITH Wave 3 installed'
run "$H/15_w3_fixtures.sql" 'Wave 3 synthetic fixtures'
run "$H/20_w3_tests.sql" 'Wave 3 behaviour'
if [ "$MODE" != "--no-lifecycle" ]; then
  run "$L/40_lifecycle_compat.sql" 'B2A lifecycle compatibility WITH Wave 3'
  run "$F/30_lifecycle_compat.sql" 'Wave 2 lifecycle compatibility WITH Wave 3'
fi
run "$H/30_reset_compat.sql" 'Wave 3 HR reset / restore compatibility'
run "$H/40_safe_rollback.sql" 'Wave 3 safe rollback rehearsal'
run "$W3A" 'Wave 3A re-applied after rollback' -1
run "$W3B" 'Wave 3B re-applied after rollback' -1
run "$H/50_after_reapply.sql" 'after re-apply'
run "$MIG/20261224100000_hr_w3_wp_holiday_alias.sql" 'optional correction 20261224100000 (WP holiday alias)' -1
run "$MIG/20261224100000_hr_w3_wp_holiday_alias.sql" 'optional correction re-applied (idempotency)' -1
run "$H/60_wp_alias.sql" 'WP holiday alias'
rm -f "$LOG"
echo "ALL HR WAVE 3 TESTS PASSED ($TOTAL checks)"
