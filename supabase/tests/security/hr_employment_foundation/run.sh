#!/usr/bin/env bash
# HR employment foundation (Wave 2, 20261221100000) replica harness. DISPOSABLE replica only — never staging/production.
# Usage: run.sh <connection string of a FRESH disposable replica whose db name contains "test"> [--w2-first]
#   Build:  ../hr_leave_containment/build_replica_from_snapshot.sh <port> stg <db name containing test>
#   default order : lifecycle 20261214…20261218 → B2A 20261219100000 → Wave 2 20261221100000
#   --w2-first    : Wave 2 → lifecycle → B2A   (the other supported order)
#   --negative-control: lifecycle → B2A → fixtures → 05_negative_control.sql (gaps must exist WITHOUT Wave 2), then stop
#   --no-lifecycle: B2A → Wave 2 only (production snapshot 2026-10-16, which predates the lifecycle prerequisites);
#                   the lifecycle compatibility files are skipped
# Then: fixtures → Wave 2 re-applied (baseline + idempotency) → B2A after-tests → Wave 2 behaviour → B2A lifecycle
# compatibility (must still pass with Wave 2) → Wave 2 lifecycle compatibility → safe rollback → re-apply → after.
set -euo pipefail
URL="${1:?connection string of a disposable *test* database}"; MODE="${2:-}"
case "$URL" in *test*) ;; *) echo "refusing: database name must contain 'test'" >&2; exit 2;; esac
case "$URL" in *supabase.co*|*getouch*|*pooler*|*72.62.253.182*) echo "refusing: looks like a shared host" >&2; exit 2;; esac
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
MIG="$ROOT/supabase/migrations"; W2="$MIG/20261221100000_hr_employment_foundation.sql"; B2A="$MIG/20261219100000_hr_leave_containment_guard.sql"
H="$ROOT/supabase/tests/security/hr_employment_foundation"; L="$ROOT/supabase/tests/security/hr_leave_containment"
P=(psql -X -q -v ON_ERROR_STOP=1 "$URL")
LOG="$(mktemp)"; TOTAL=0
run() {
  echo "== $2"
  if "${P[@]}" ${3:-} -f "$1" >"$LOG" 2>&1; then
    local c; c=$(grep -c 'ok - ' "$LOG" || true); TOTAL=$((TOTAL + c)); grep -E 'ok - ' "$LOG" | sed -E 's/^.*NOTICE: +//' || true
  else cat "$LOG"; echo "FAILED: $2"; exit 1; fi
}
lifecycle() {
  for f in 20261214100000_hr_employee_controlled_delete 20261216100000_identity_permanent_deletion \
           20261217100000_identity_archive_identifier_release 20261218100000_identity_archive_optional_reason; do
    run "$MIG/$f.sql" "lifecycle $f" -1
  done
}
[ "$MODE" != "--no-lifecycle" ] && run "$L/05_lifecycle_catalogue_seed.sql" 'synthetic S&A catalogue (lifecycle)'
if [ "$MODE" = "--negative-control" ]; then
  lifecycle; run "$B2A" 'B2A 20261219100000' -1
  run "$L/10_fixtures.sql" 'base synthetic fixtures (hlc)'
  run "$H/05_negative_control.sql" 'negative control (no Wave 2: gaps must exist)'
  rm -f "$LOG"; echo "NEGATIVE CONTROL PASSED ($TOTAL checks)"; exit 0
elif [ "$MODE" = "--no-lifecycle" ]; then
  run "$B2A" 'B2A 20261219100000' -1; run "$W2" 'Wave 2 20261221100000' -1
elif [ "$MODE" = "--w2-first" ]; then
  run "$W2" 'Wave 2 20261221100000 (first)' -1; lifecycle; run "$B2A" 'B2A 20261219100000' -1
else
  lifecycle; run "$B2A" 'B2A 20261219100000' -1; run "$W2" 'Wave 2 20261221100000' -1
fi
run "$L/10_fixtures.sql" 'base synthetic fixtures (hlc)'
run "$H/15_w2_fixtures.sql" 'Wave 2 synthetic fixtures'
run "$W2" 'Wave 2 re-applied (baseline for fixtures; idempotency)' -1
run "$L/30_after_tests.sql" 'B2A after-tests with Wave 2 installed (before Wave 2 changes the fixtures)'
run "$H/20_tests.sql" 'Wave 2 behaviour'
if [ "$MODE" != "--no-lifecycle" ]; then
  run "$L/40_lifecycle_compat.sql" 'B2A lifecycle compatibility with Wave 2 installed'
  run "$H/30_lifecycle_compat.sql" 'Wave 2 lifecycle compatibility'
fi
run "$H/40_safe_rollback.sql" 'Wave 2 safe rollback rehearsal'
run "$W2" 'Wave 2 re-applied after rollback' -1
run "$H/50_after_reapply.sql" 'after re-apply'
rm -f "$LOG"
echo "ALL HR EMPLOYMENT FOUNDATION TESTS PASSED ($TOTAL checks)"
