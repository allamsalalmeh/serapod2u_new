#!/usr/bin/env bash
# HR leave containment (B2A, 20261219100000) replica harness.
# Usage: run.sh <connection string of a DISPOSABLE replica database whose name contains "test"> [--lifecycle]
#   Build a replica WITHOUT contacting staging/production: ./build_replica_from_snapshot.sh <port> [prod|stg] <db name>
#   --lifecycle:       apply 20261214…20261218 (identity / HR lifecycle, B1) BEFORE B2A, then the compatibility checks.
#   --lifecycle-after: apply B2A first, then 20261214…20261218, then the compatibility checks (the other B1/B2A order).
#   Without --lifecycle the replica must be FRESH (fixtures + negative control + migration + after + rollback).
# NEVER point this at Supabase: app/.env.local is shared staging.
set -euo pipefail
URL="${1:?connection string of a disposable *test* database}"; MODE="${2:-}"
case "$URL" in *test*) ;; *) echo "refusing: database name must contain 'test'" >&2; exit 2;; esac
case "$URL" in *supabase.co*|*getouch*|*pooler*) echo "refusing: looks like a shared Supabase host" >&2; exit 2;; esac
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
M="$ROOT/supabase/migrations/20261219100000_hr_leave_containment_guard.sql"
H="$ROOT/supabase/tests/security/hr_leave_containment"
P=(psql -X -q -v ON_ERROR_STOP=1 "$URL")
LOG="$(mktemp)"
run() {  # run <file> <label> [-1]: print the ok lines, or the whole log and stop on failure
  echo "== $2"
  if "${P[@]}" ${3:-} -f "$1" >"$LOG" 2>&1; then grep -E 'ok - ' "$LOG" | sed -E 's/^.*NOTICE: +//' || true
  else cat "$LOG"; echo "FAILED: $2"; exit 1; fi
}
lifecycle() {
  for f in 20261214100000_hr_employee_controlled_delete 20261216100000_identity_permanent_deletion \
           20261217100000_identity_archive_identifier_release 20261218100000_identity_archive_optional_reason; do
    run "$ROOT/supabase/migrations/$f.sql" "lifecycle $f" -1
  done
}
case "$MODE" in --lifecycle|--lifecycle-after) run "$H/05_lifecycle_catalogue_seed.sql" 'synthetic catalogue for lifecycle migrations';; esac
[ "$MODE" = "--lifecycle" ] && lifecycle
run "$H/10_fixtures.sql" 'synthetic fixtures'
run "$H/20_before_tests.sql" 'negative control (unpatched schema: holes must exist)'
run "$M" 'migration 20261219100000' -1
run "$M" 'migration 20261219100000 again (idempotency)' -1
run "$H/30_after_tests.sql" 'after'
run "$H/50_safe_rollback.sql" 'safe rollback posture'
run "$H/30_after_tests.sql" 'after (strict rule intact after the rollback rehearsal)'
[ "$MODE" = "--lifecycle-after" ] && lifecycle
if [ "$MODE" = "--lifecycle" ] || [ "$MODE" = "--lifecycle-after" ]; then
  run "$H/40_lifecycle_compat.sql" 'lifecycle compatibility (reset/restore, employee delete/reset, identity deletion, archive)'
fi
rm -f "$LOG"
echo "ALL HR LEAVE CONTAINMENT TESTS PASSED"
