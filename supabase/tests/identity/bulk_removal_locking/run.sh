#!/usr/bin/env bash
# Isolated lock-mechanism regression test for bulk employee removal.
#
# Creates a disposable PostgreSQL cluster in a temp directory (no project or
# shared data), mirrors the lock-relevant canonical statements, and asserts:
#   1. two concurrent permanent deletions deadlock (40P01) - the reported bug;
#   2. a deletion next to an archive hits the 5s lock timeout (55P03);
#   3. serial execution (the fix) completes both deletions.
#
# Requires PostgreSQL server binaries (initdb, pg_ctl) on PATH.
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d /tmp/serapod-bulk-lock.XXXXXX)"
DATA="$WORK/data"
SOCK="$WORK/sock"
LOG="$WORK/postgres.log"
PORT="$(python3 - <<'PY'
import socket
s = socket.socket(); s.bind(('127.0.0.1', 0)); print(s.getsockname()[1]); s.close()
PY
)"
FAILED=0

cleanup() {
  pg_ctl -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

psqlq() { psql -X -q -h "$SOCK" -p "$PORT" -d spectest "$@"; }

mkdir -p "$SOCK"
initdb -D "$DATA" -A trust >/dev/null 2>&1 || { echo "FAIL: initdb"; exit 1; }
pg_ctl -D "$DATA" -o "-p $PORT -k $SOCK" -l "$LOG" start >/dev/null 2>&1 || { echo "FAIL: pg_ctl start"; cat "$LOG"; exit 1; }
for _ in $(seq 1 50); do pg_isready -h "$SOCK" -p "$PORT" >/dev/null 2>&1 && break; sleep 0.1; done
createdb -h "$SOCK" -p "$PORT" spectest || { echo "FAIL: createdb"; exit 1; }
psqlq -v ON_ERROR_STOP=1 -f "$ROOT/schema.sql" >/dev/null || { echo "FAIL: schema"; exit 1; }

check() { # name condition
  if [ "$2" -eq 0 ]; then echo "PASS: $1"; else echo "FAIL: $1"; FAILED=1; fi
}

# 1. Two concurrent permanent deletions (deterministic overlap).
psqlq -v ON_ERROR_STOP=1 -f "$ROOT/reset_data.sql" >/dev/null
psqlq -v ON_ERROR_STOP=1 -v uid=00000000-0000-0000-0000-00000000000a -v reqid=00000000-0000-0000-0000-00000000d101 -f "$ROOT/delete_tx_hold.sql" >"$WORK/d1.out" 2>&1 &
P1=$!
psqlq -v ON_ERROR_STOP=1 -v uid=00000000-0000-0000-0000-00000000000b -v reqid=00000000-0000-0000-0000-00000000d102 -f "$ROOT/delete_tx_hold.sql" >"$WORK/d2.out" 2>&1 &
P2=$!
wait $P1; E1=$?
wait $P2; E2=$?
grep -q '40P01' "$WORK/d1.out" "$WORK/d2.out"; DEADLOCK=$?
[ $((E1 + E2)) -ne 0 ]; ONE_FAILED=$?
COUNT="$(psqlq -Atc 'select count(*) from users')"
[ "$COUNT" = "3" ]; ROLLBACK_SAFE=$?
check "two concurrent deletions deadlock (40P01) and exactly one transaction is rolled back" "$((DEADLOCK + ONE_FAILED + ROLLBACK_SAFE))"

# 2. Deletion running next to an archive.
psqlq -v ON_ERROR_STOP=1 -f "$ROOT/reset_data.sql" >/dev/null
psqlq -v ON_ERROR_STOP=1 -v uid=00000000-0000-0000-0000-00000000000c -v reqid=00000000-0000-0000-0000-00000000a101 -v sleep=6 -f "$ROOT/archive_tx.sql" >"$WORK/a1.out" 2>&1 &
PA=$!
sleep 0.5
psqlq -v ON_ERROR_STOP=1 -v uid=00000000-0000-0000-0000-00000000000d -v reqid=00000000-0000-0000-0000-00000000d103 -f "$ROOT/delete_tx.sql" >"$WORK/d3.out" 2>&1
ED=$?
wait $PA; EA=$?
grep -q '55P03' "$WORK/d3.out"; TIMEOUT=$?
[ "$EA" -eq 0 ]; ARCHIVE_OK=$?
[ "$ED" -ne 0 ]; DELETE_FAILED=$?
check "deletion beside an archive hits lock timeout (55P03); archive succeeds" "$((TIMEOUT + ARCHIVE_OK + DELETE_FAILED))"

# 3. Two overlapping requests for the SAME identity: the advisory lock serializes
#    them and the second must find the target gone, not act twice.
psqlq -v ON_ERROR_STOP=1 -f "$ROOT/reset_data.sql" >/dev/null
psqlq -v ON_ERROR_STOP=1 -v uid=00000000-0000-0000-0000-00000000000a -v reqid=00000000-0000-0000-0000-00000000d201 -f "$ROOT/delete_tx_hold.sql" >"$WORK/same1.out" 2>&1 &
PS=$!
sleep 0.2
psqlq -v ON_ERROR_STOP=1 -v uid=00000000-0000-0000-0000-00000000000a -v reqid=00000000-0000-0000-0000-00000000d202 -f "$ROOT/delete_tx_recheck.sql" >"$WORK/same2.out" 2>&1
ES=$?
wait $PS; EF=$?
grep -q 'identity_deletion_target_not_found' "$WORK/same2.out"; NOT_FOUND=$?
! grep -q 'COMMIT' "$WORK/same2.out"; NO_COMMIT=$?
[ "$EF" -eq 0 ]; ONE_WON=$?
REQUESTS="$(psqlq -Atc "select count(*) from identity_deletion_requests where target_user_id = '00000000-0000-0000-0000-00000000000a'")"
[ "$REQUESTS" = "1" ]; ONE_RECORD=$?
check "overlapping requests for one identity: one acts, the other finds it gone (no duplicate record)" "$((NOT_FOUND + NO_COMMIT + ONE_WON + ONE_RECORD))"

# 4. Serial execution (the fix) completes both deletions.
psqlq -v ON_ERROR_STOP=1 -f "$ROOT/reset_data.sql" >/dev/null
psqlq -v ON_ERROR_STOP=1 -v uid=00000000-0000-0000-0000-00000000000a -v reqid=00000000-0000-0000-0000-00000000d104 -f "$ROOT/delete_tx.sql" >"$WORK/s1.out" 2>&1; S1=$?
psqlq -v ON_ERROR_STOP=1 -v uid=00000000-0000-0000-0000-00000000000b -v reqid=00000000-0000-0000-0000-00000000d105 -f "$ROOT/delete_tx.sql" >"$WORK/s2.out" 2>&1; S2=$?
COUNT="$(psqlq -Atc 'select count(*) from users')"
REQUESTS="$(psqlq -Atc 'select count(*) from identity_deletion_requests')"
[ "$S1" -eq 0 ] && [ "$S2" -eq 0 ] && [ "$COUNT" = "2" ] && [ "$REQUESTS" = "2" ]; SERIAL_OK=$?
check "serialized deletions both succeed with no orphan rows" "$SERIAL_OK"

echo "RESULT: $([ "$FAILED" -eq 0 ] && echo PASS || echo FAIL)"
exit "$FAILED"
