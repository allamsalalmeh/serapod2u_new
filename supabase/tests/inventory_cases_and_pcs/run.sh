#!/usr/bin/env bash
# ============================================================================
# Isolated integration test: inventory cases + loose pieces
# ----------------------------------------------------------------------------
# Builds a THROWAWAY local PostgreSQL cluster (port 55432, /tmp) and runs a real
# UPGRADE, not a greenfield create:
#
#   [0] load the PRE-MIGRATION harness: real table DDL + the LIVE definitions of
#       every function and view the migration replaces, extracted verbatim from
#       supabase/schemas/current_schema.sql
#   [1] preflight: assert that pre-migration state and reproduce the staging
#       failure (42P13) with the statement the first version of the migration
#       used
#   [2] apply the migration on top of that state
#   [3] assert the upgrade preserved callers, security, grants, totals math and
#       read-model column order
#   [4] apply the migration a SECOND time (rerun after a partial failure)
#   [5] inject a failure before COMMIT and assert a complete rollback
#   [6] run the business scenarios
#   [7] prove PUBLIC/anon drift blocks readiness, then test the scoped correction
#
# It never connects to staging or production: every connection is a unix socket
# in /tmp against databases created and dropped by this script.
#
#   ./run.sh            # run
#   KEEP_DB=1 ./run.sh  # keep the cluster for inspection
# ============================================================================
set -euo pipefail

PGBIN="${PGBIN:-/opt/homebrew/bin}"
PORT="${PORT:-55432}"
SOCKDIR="${SOCKDIR:-/tmp}"
DATADIR="${DATADIR:-/tmp/pcs-test-cluster}"
DB="${DB:-pcs_test}"
ROLLBACK_DB="${ROLLBACK_DB:-pcs_rollback}"
EMPTY_DB="${EMPTY_DB:-pcs_readiness_empty}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HERE="$ROOT/supabase/tests/inventory_cases_and_pcs"
MIGRATION="$ROOT/supabase/migrations/20261220100000_inventory_cases_and_pcs.sql"
CORRECTIVE="$ROOT/supabase/migrations/20261220110000_inventory_cases_pcs_restore_totals_acl.sql"
READINESS="$ROOT/supabase/diagnostics/20261025_inventory_cases_pcs_readiness_sql_editor.sql"
ACL_READINESS_TEST="$HERE/check_readiness_acl.py"
HARNESS=/tmp/pcs-harness.sql
INJECTED=/tmp/pcs-migration-injected.sql

export PATH="$PGBIN:$PATH"

psqlq() { psql -h "$SOCKDIR" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

cleanup() {
  if [ "${KEEP_DB:-0}" != "1" ]; then
    pg_ctl -D "$DATADIR" -m immediate stop >/dev/null 2>&1 || true
    rm -rf "$DATADIR"
  fi
}
trap cleanup EXIT

rm -rf "$DATADIR"
initdb -D "$DATADIR" -U postgres -A trust >/dev/null
pg_ctl -D "$DATADIR" -o "-p $PORT -k $SOCKDIR" -l "$DATADIR/server.log" start >/dev/null
sleep 1

psqlq -c "CREATE DATABASE $DB;"
psqlq -c "CREATE DATABASE $ROLLBACK_DB;"
psqlq -c "CREATE DATABASE $EMPTY_DB;"

echo "== [0] building the PRE-MIGRATION harness from the live dump =="
python3 "$HERE/build_harness.py" --dump "$ROOT/supabase/schemas/current_schema.sql" --out "$HARNESS"
psqlq -d "$DB" -f "$HARNESS"
psqlq -d "$ROLLBACK_DB" -f "$HARNESS"
# Positive canary for the main migration's live ACL capture/replay. The captured
# staging denial baseline is still PUBLIC/anon = denied; other grants must survive.
psqlq -d "$DB" -c "GRANT EXECUTE ON FUNCTION public._stock_transfer_totals(jsonb) TO authenticated;"

echo "== [1] preflight: pre-migration state + reproduction of the staging 42P13 =="
psqlq -d "$DB" -f "$HERE/10_preflight_upgrade.sql"
python3 "$ACL_READINESS_TEST" --psql "$(command -v psql)" --host "$SOCKDIR" --port "$PORT" \
  --user postgres --dbname "$DB" --report "$READINESS" --expect PRE_MIGRATION_READY
python3 "$ACL_READINESS_TEST" --psql "$(command -v psql)" --host "$SOCKDIR" --port "$PORT" \
  --user postgres --dbname "$EMPTY_DB" --report "$READINESS" --expect INSUFFICIENT_EVIDENCE
if psqlq -d "$EMPTY_DB" -f "$CORRECTIVE" 2>/tmp/pcs-corrective-missing-guard.log; then
  echo "FAIL: corrective ACL migration unexpectedly ran without the totals function"; exit 1
fi
grep -q 'ACL correction requires public._stock_transfer_totals(jsonb); function not found' /tmp/pcs-corrective-missing-guard.log
echo "   (empty catalog is insufficient evidence; corrective migration rejected a missing function)"

echo "== [2] upgrade: apply 20261220100000_inventory_cases_and_pcs.sql =="
psql -h "$SOCKDIR" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q -d "$DB" -f "$MIGRATION"

echo "== [3] post-upgrade contract assertions =="
psqlq -d "$DB" -f "$HERE/30_upgrade_checks.sql"

echo "== [4] rerun: apply the same migration again (failed-then-fixed retry) =="
psql -h "$SOCKDIR" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q -d "$DB" -f "$MIGRATION"
psqlq -d "$DB" -f "$HERE/30_upgrade_checks.sql"

echo "== [5] rollback on failure: same migration with COMMIT replaced by SELECT 1/0 =="
sed 's/^COMMIT;$/SELECT 1\/0;/' "$MIGRATION" > "$INJECTED"
if grep -q '^COMMIT;$' "$INJECTED"; then
  echo "FAIL: could not inject the failure (no COMMIT line replaced)"; exit 1
fi
if psql -h "$SOCKDIR" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q -d "$ROLLBACK_DB" -f "$INJECTED" 2>/tmp/pcs-injected.log; then
  echo "FAIL: the injected migration unexpectedly succeeded"; exit 1
fi
echo "   (expected failure captured: $(tail -3 /tmp/pcs-injected.log | tr '\n' ' '))"
psqlq -d "$ROLLBACK_DB" -f "$HERE/40_rollback_assert.sql"
if psql -h "$SOCKDIR" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q -d "$ROLLBACK_DB" -f "$CORRECTIVE" 2>/tmp/pcs-corrective-pre-guard.log; then
  echo "FAIL: corrective ACL migration unexpectedly ran against the pre-migration function"; exit 1
fi
grep -q 'requires the migrated 3-column totals function' /tmp/pcs-corrective-pre-guard.log
echo "   (corrective migration rejected the pre-migration shape without changing it)"
psqlq -d "$ROLLBACK_DB" -f "$HERE/10_preflight_upgrade.sql"

echo "== [6] business scenarios =="
psqlq -d "$DB" -f "$HERE/20_tests.sql"

echo "== [7] ACL-aware readiness and scoped corrective migration =="
# Clean migrated state passes. Each injected grant is rolled back by the test
# client and must prevent POST_MIGRATION_VERIFIED.
python3 "$ACL_READINESS_TEST" --psql "$(command -v psql)" --host "$SOCKDIR" --port "$PORT" \
  --user postgres --dbname "$DB" --report "$READINESS"

# Reproduce the reported drift on this disposable database. authenticated is a
# canary grant that the corrective file must preserve.
psqlq -d "$DB" -c "GRANT EXECUTE ON FUNCTION public._stock_transfer_totals(jsonb) TO authenticated;"
psqlq -d "$DB" -c "GRANT EXECUTE ON FUNCTION public._stock_transfer_totals(jsonb) TO PUBLIC;"
psqlq -d "$DB" -c "GRANT EXECUTE ON FUNCTION public._stock_transfer_totals(jsonb) TO anon;"
python3 "$ACL_READINESS_TEST" --psql "$(command -v psql)" --host "$SOCKDIR" --port "$PORT" \
  --user postgres --dbname "$DB" --report "$READINESS" --expect PARTIAL_OR_UNEXPECTED_STATE

psqlq -d "$DB" -f "$CORRECTIVE"
psqlq -d "$DB" -f "$HERE/50_corrective_acl_assert.sql"
python3 "$ACL_READINESS_TEST" --psql "$(command -v psql)" --host "$SOCKDIR" --port "$PORT" \
  --user postgres --dbname "$DB" --report "$READINESS" --expect POST_MIGRATION_VERIFIED

# Idempotence: a second application neither adds grants nor changes the function.
psqlq -d "$DB" -f "$CORRECTIVE"
psqlq -d "$DB" -f "$HERE/50_corrective_acl_assert.sql"
python3 "$ACL_READINESS_TEST" --psql "$(command -v psql)" --host "$SOCKDIR" --port "$PORT" \
  --user postgres --dbname "$DB" --report "$READINESS" --expect POST_MIGRATION_VERIFIED
