#!/usr/bin/env bash
# Usage: run.sh <connection string of a DISPOSABLE database named commission_test*>
# The database must be a copy of a local replica restored from a schema-only staging dump plus the S&A catalogue
# tables (sa_permissions, sa_migration_modes, sa_legacy_compat_rules, sa_enforcement_readiness, sa_business_roles,
# sa_business_role_permissions, sa_standard_policy_coverage, sa_settings, sa_sod_rules, sa_authority_policies, roles,
# organization_types) — configuration only, no personal data. Applies the three commission migrations twice
# (idempotency), loads synthetic fixtures and runs the scenarios. Never run against Supabase: localhost shares staging.
set -euo pipefail
URL="${1:?connection string of a disposable commission_test* database}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
M="$ROOT/supabase/migrations"
H="$ROOT/supabase/tests/hr_commission"
P=(psql -X -q -v ON_ERROR_STOP=1 "$URL")
"${P[@]}" -c "do \$g\$ begin if current_database() !~ '^commission_test' then raise exception 'Refusing: not a disposable commission_test* database'; end if; end \$g\$;"
for pass in 1 2; do
  for f in 20261102100000_order_status_events 20261102110000_hr_commission_core 20261102120000_hr_commission_policies; do
    echo "-- pass $pass: $f"; "${P[@]}" -f "$M/$f.sql" >/dev/null
  done
done
"${P[@]}" -f "$H/10_fixtures.sql" >/dev/null
"${P[@]}" -f "$H/20_tests.sql"
