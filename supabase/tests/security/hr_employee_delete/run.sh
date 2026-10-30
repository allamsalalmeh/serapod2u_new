#!/usr/bin/env bash
# HR employee controlled delete harness (20261214100000).
# Usage: run.sh <connection string of a DISPOSABLE copy of the staging-schema replica (database name ph_test*)>
# Replica recipe: ../sa_policy_hardening/build_replica.sh (read-only staging schema + S&A configuration rows).
# Never point this at Supabase: localhost shares the staging database.
set -euo pipefail
URL="${1:?connection string of a disposable ph_test* database}"
case "$URL" in *ph_test*) ;; *) echo "refusing: database name must contain ph_test" >&2; exit 2;; esac
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
M="$ROOT/supabase/migrations/20261214100000_hr_employee_controlled_delete.sql"
H="$ROOT/supabase/tests/security/hr_employee_delete"
P=(psql -X -q -t -A -v ON_ERROR_STOP=1 "$URL")
LOG="$(mktemp)"
run() {  # run <file> <label>: print the ok lines, or the whole log and stop on failure
  echo "== $2"
  if "${P[@]}" -f "$1" >"$LOG" 2>&1; then grep -E 'ok - ' "$LOG" | sed -E 's/^.*NOTICE: +//' || true
  else cat "$LOG"; echo "FAILED: $2"; exit 1; fi
}
expect() { if [ "$1" = "$2" ]; then echo "ok - $3"; else echo "FAILED: $3 (got '$1', expected '$2')"; exit 1; fi; }

run "$H/10_fixtures.sql" 'synthetic fixtures'
run "$H/20_before_tests.sql" 'negative control (staging schema, unpatched)'
run "$M" 'migration 20261214100000'
run "$M" 'migration 20261214100000 again (idempotency)'
run "$H/30_after_tests.sql" 'after'

echo "== concurrency (two sessions)"
# (11) Two different requests for the same employee from the same reviewed preview: the second waits, then is stale.
TOKEN="$("${P[@]}" -c "select (hed.preview(1, 12))->>'preview_token'")"
"${P[@]}" -c "begin; select hed.exec(1, 12, 'delete', 100, 1, '$TOKEN')->>'status'; select pg_sleep(2); commit;" >"$LOG.a" 2>&1 &
A=$!; sleep 0.7
B="$("${P[@]}" -c "select hed.exec(1, 12, 'delete', 101, 1, '$TOKEN')->>'status'" 2>&1)"
wait $A
expect "$(head -1 "$LOG.a")" "completed" '11: first concurrent delete completed'
expect "$B" "stale" '11: second concurrent delete waited and was refused as stale'
expect "$("${P[@]}" -c "select count(*) from public.hr_employee_registration_actions where user_id = hed.u(12) and status = 'completed'")" "1" '11: exactly one completed action'

# Race fence: a clock-in issued while the delete is in flight waits, then is refused (no attendance for a deleted registration).
"${P[@]}" -c "begin; select hed.exec(1, 13, 'delete', 110)->>'status'; select pg_sleep(2); commit;" >"$LOG.a" 2>&1 &
A=$!; sleep 0.7
C="$("${P[@]}" -c "insert into public.hr_attendance_entries(organization_id, user_id, clock_in_at) values (hed.o(1), hed.u(13), now())" 2>&1 || true)"
wait $A
expect "$(head -1 "$LOG.a")" "completed" 'fence: delete completed'
case "$C" in *hr_onboarding_pending*) echo "ok - fence: concurrent clock-in waited and was refused (hr_onboarding_pending)";; *) echo "FAILED: fence: $C"; exit 1;; esac
expect "$("${P[@]}" -c "select count(*) from public.hr_attendance_entries where user_id = hed.u(13)")" "0" 'fence: no attendance row for the deleted registration'

rm -f "$LOG" "$LOG.a"
echo "ALL HR EMPLOYEE DELETE TESTS PASSED"
