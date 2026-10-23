#!/usr/bin/env bash
# Archive & Revoke Access / identifier release harness (20261217100000).
# Usage: run.sh <connection string of a DISPOSABLE copy of the staging-schema replica (database name ph_test*)>
# Replica recipe: ../sa_policy_hardening/build_replica.sh. Never point this at Supabase: localhost shares the staging database.
set -euo pipefail
URL="${1:?connection string of a disposable ph_test* database}"
case "$URL" in *ph_test*) ;; *) echo "refusing: database name must contain ph_test" >&2; exit 2;; esac
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
MIG="$ROOT/supabase/migrations"
M="$MIG/20261217100000_identity_archive_identifier_release.sql"
H="$ROOT/supabase/tests/security/identity_archive_release"
P=(psql -X -q -t -A -v ON_ERROR_STOP=1 "$URL")
LOG="$(mktemp)"
run() {
  echo "== $2"
  if "${P[@]}" -f "$1" >"$LOG" 2>&1; then grep -E 'ok - ' "$LOG" | sed -E 's/^.*NOTICE: +//' || true
  else cat "$LOG"; echo "FAILED: $2"; exit 1; fi
}
expect() { if [ "$1" = "$2" ]; then echo "ok - $3"; else echo "FAILED: $3 (got '$1', expected '$2')"; exit 1; fi; }

run "$MIG/20261214100000_hr_employee_controlled_delete.sql" 'prerequisite 20261214100000'
run "$MIG/20261216100000_identity_permanent_deletion.sql" 'prerequisite 20261216100000'
run "$ROOT/supabase/tests/security/identity_permanent_delete/10_fixtures.sql" 'fixtures (people 1-28)'
run "$H/10_fixtures.sql" 'fixtures (archive history 30-33)'
run "$H/20_before_tests.sql" 'negative control (unpatched)'
run "$M" 'migration 20261217100000'
run "$M" 'migration 20261217100000 again (idempotency)'
run "$H/30_after_tests.sql" 'after'

echo "== concurrency: two archive requests for one person"
TOKEN="$("${P[@]}" -c "select public.identity_archive_preview(ipd.u(28), ipd.u(33), 'user_management')->>'preview_token'")"
"${P[@]}" -c "begin; select (public.identity_archive_execute(ipd.u(28), ipd.u(33), 'user_management', ipd.x(8100), '$TOKEN', 'Employee left the company', 'ipd-33@example.test', false, 'resigned'))->>'status'; select pg_sleep(2); commit;" >"$LOG.a" 2>&1 &
A=$!; sleep 0.7
B="$("${P[@]}" -c "select (public.identity_archive_execute(ipd.u(28), ipd.u(33), 'user_management', ipd.x(8101), '$TOKEN', 'Employee left the company', 'ipd-33@example.test', false, 'resigned'))->>'status'" 2>&1 || true)"
wait $A
expect "$(head -1 "$LOG.a")" "completed" 'concurrency: first archive completed'
expect "$B" "stale" 'concurrency: second waited, then refused as stale'
expect "$("${P[@]}" -c "select count(*) from public.identity_lifecycle_actions where target_user_id = ipd.u(33) and status = 'completed'")" "1" 'concurrency: one archive record'

echo "== concurrency: release in flight vs a new registration with the same email"
"${P[@]}" -c "begin; select (ipd.release(28, 33, 110))->>'status'; select pg_sleep(2); commit;" >"$LOG.a" 2>&1 &
A=$!; sleep 0.7
B="$("${P[@]}" -c "insert into auth.users(id, email, aud, role) values (ipd.u(42), 'ipd-33@example.test', 'authenticated', 'authenticated') returning 'inserted'" 2>&1 || true)"
wait $A
expect "$(head -1 "$LOG.a")" "completed" 'concurrency: release completed'
case "$B" in *inserted*) echo "ok - concurrency: the registration waited for the release, then got its own login";; *) echo "FAILED: concurrent registration: $B"; exit 1;; esac
expect "$("${P[@]}" -c "select count(*) from auth.users where lower(email) = 'ipd-33@example.test'")" "1" 'concurrency: exactly one login owns the email'
expect "$("${P[@]}" -c "select id = ipd.u(42) from auth.users where lower(email) = 'ipd-33@example.test'")" "t" 'concurrency: and it is the new UUID'

echo "== PostgREST path (authenticator → service_role)"
AUTHURL="${URL/supabase_admin@/authenticator@}"
U() { printf '0000001d-0000-0000-0000-%012d' "$1"; }
X() { printf '0000001e-0000-0000-0000-%012d' "$1"; }
TOKEN="$("${P[@]}" -c "select public.identity_archive_preview(ipd.u(28), ipd.u(6), 'user_management')->>'preview_token'")"
R="$(psql -X -q -t -A -v ON_ERROR_STOP=1 "$AUTHURL" -c "set role service_role; select (public.identity_archive_execute('$(U 28)', '$(U 6)', 'user_management', '$(X 8200)', '$TOKEN', 'Employee left the company', 'ipd-6@example.test', true, 'terminated'))->>'status'" 2>&1 | tail -1)"
expect "$R" "completed" 'postgrest: archive + release of an identity with Supply Chain history through the API role'
expect "$("${P[@]}" -c "select created_by = ipd.u(6) from public.orders where id = ipd.x(400)")" "t" 'postgrest: its order still points to the archived UUID'

rm -f "$LOG" "$LOG.a"
echo "ALL IDENTITY ARCHIVE / RELEASE TESTS PASSED"
