#!/usr/bin/env bash
# Usage: run.sh <psql-connection-string-to-a-DISPOSABLE-database-named-sa_bulk_test*>
# Builds the harness, loads the real sa_log_access_change + original
# sa_set_migration_mode, applies the new migration, runs every test file.
set -euo pipefail
URL="${1:?connection string of a disposable sa_bulk_test* database}"
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
HERE="$ROOT/supabase/tests/security/sa_bulk_modes"
P=(psql -X -q -v ON_ERROR_STOP=1 "$URL")
"${P[@]}" -f "$HERE/00_harness.sql"
F="$ROOT/supabase/migrations/20260928100000_sa_final_governance_foundation.sql"
awk '/^create or replace function public.sa_log_access_change\(/{p=1} p{print} /^grant execute on function public.sa_log_access_change/{p=0}' "$F" | "${P[@]}"
O="$ROOT/supabase/migrations/20260928130000_sa_final_legacy_retirement_support.sql"
awk '/^create or replace function public.sa_set_migration_mode\(/{p=1} p{print} /^grant execute on function public.sa_set_migration_mode/{p=0}' "$O" | "${P[@]}"
"${P[@]}" -1 -f "$ROOT/supabase/migrations/20261004100000_sa_bulk_migration_mode.sql"
for f in "$HERE"/[1-9]*.sql; do echo "== $(basename "$f")"; "${P[@]}" -f "$f"; done
echo "ALL SA BULK MODE TESTS PASSED"
