#!/usr/bin/env bash
# Permanent identity deletion harness (20261216100000).
# Usage: run.sh <connection string of a DISPOSABLE copy of the staging-schema replica (database name ph_test*)>
# Replica recipe: ../sa_policy_hardening/build_replica.sh (read-only staging schema + S&A configuration rows).
# Never point this at Supabase: localhost shares the staging database.
set -euo pipefail
URL="${1:?connection string of a disposable ph_test* database}"
case "$URL" in *ph_test*) ;; *) echo "refusing: database name must contain ph_test" >&2; exit 2;; esac
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
PRE="$ROOT/supabase/migrations/20261214100000_hr_employee_controlled_delete.sql"
M="$ROOT/supabase/migrations/20261216100000_identity_permanent_deletion.sql"
H="$ROOT/supabase/tests/security/identity_permanent_delete"
P=(psql -X -q -t -A -v ON_ERROR_STOP=1 "$URL")
LOG="$(mktemp)"
run() {  # run <file> <label>: print the ok lines, or the whole log and stop on failure
  echo "== $2"
  if "${P[@]}" -f "$1" >"$LOG" 2>&1; then grep -E 'ok - ' "$LOG" | sed -E 's/^.*NOTICE: +//' || true
  else cat "$LOG"; echo "FAILED: $2"; exit 1; fi
}
expect() { if [ "$1" = "$2" ]; then echo "ok - $3"; else echo "FAILED: $3 (got '$1', expected '$2')"; exit 1; fi; }

run "$PRE" 'prerequisite 20261214100000 (idempotent)'
run "$H/10_fixtures.sql" 'synthetic fixtures'
"${P[@]}" -c "grant usage on schema ipd to service_role; grant execute on all functions in schema ipd to service_role;" >/dev/null
run "$H/20_before_tests.sql" 'negative control (unpatched)'
run "$M" 'migration 20261216100000'
run "$M" 'migration 20261216100000 again (idempotency)'
run "$H/30_after_tests.sql" 'after'

U() { printf '0000001d-0000-0000-0000-%012d' "$1"; }
X() { printf '0000001e-0000-0000-0000-%012d' "$1"; }

echo "== concurrency (two sessions, same identity, same reviewed preview)"
TOKEN="$("${P[@]}" -c "select (ipd.preview(1, 15))->>'preview_token'")"
"${P[@]}" -c "begin; select (public.identity_deletion_execute(ipd.u(1), ipd.u(15), 'user_management', ipd.x(9100), '$TOKEN', 'Pre-go-live test account clean-up', 'ipd-15@example.test'))->>'status'; select pg_sleep(2); commit;" >"$LOG.a" 2>&1 &
A=$!; sleep 0.7
B="$("${P[@]}" -c "select (public.identity_deletion_execute(ipd.u(1), ipd.u(15), 'hr', ipd.x(9101), '$TOKEN', 'Pre-go-live test account clean-up', 'ipd-15@example.test'))->>'status'" 2>&1 || true)"
wait $A
expect "$(head -1 "$LOG.a")" "completed" 'concurrency: first deletion completed'
case "$B" in *identity_deletion_target_not_found*|*sa_authorization_required*|*hr_employee_not_in_organization*|stale) echo "ok - concurrency: second request waited, then found nothing to delete ($(echo "$B" | head -1 | cut -c1-60))";;
  *) echo "FAILED: concurrency second request: $B"; exit 1;; esac
expect "$("${P[@]}" -c "select count(*) from public.identity_deletion_requests where target_user_id = ipd.u(15) and status = 'completed'")" "1" 'concurrency: exactly one completed deletion'

echo "== PostgREST path (session authenticator → service_role): the sanctioned delete passes users_history_delete_guard"
AUTHURL="${URL/supabase_admin@/authenticator@}"
TOKEN="$("${P[@]}" -c "select (ipd.preview(1, 23))->>'preview_token'")"
R="$(psql -X -q -t -A -v ON_ERROR_STOP=1 "$AUTHURL" -c "set role service_role; select (public.identity_deletion_execute('$(U 1)', '$(U 23)', 'user_management', '$(X 9200)', '$TOKEN', 'Pre-go-live test account clean-up', 'ipd-23@example.test'))->>'status'" 2>&1 | tail -1)"
expect "$R" "completed" 'postgrest: deletion through the API role completed'
expect "$("${P[@]}" -c "select ipd.exists_anywhere(23)")" "f" 'postgrest: nothing of the identity left'
R="$(psql -X -q -t -A "$AUTHURL" -c "set role service_role; delete from public.users where id = '$(U 7)'" 2>&1 || true)"
case "$R" in *identity_has_history*|*permission\ denied*) echo "ok - postgrest: a direct API delete of an identity with history is still refused";; *) echo "FAILED: direct API delete: $R"; exit 1;; esac

rm -f "$LOG" "$LOG.a"
echo "ALL IDENTITY PERMANENT DELETE TESTS PASSED"
