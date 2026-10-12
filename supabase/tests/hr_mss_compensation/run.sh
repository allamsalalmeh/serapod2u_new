#!/usr/bin/env bash
# Usage: run.sh <connection string of a DISPOSABLE database named mss_test*>
# The database must be a copy of a local replica restored from a schema-only staging dump plus the S&A catalogue tables
# (sa_permissions, sa_migration_modes, sa_legacy_compat_rules, sa_enforcement_readiness, sa_business_roles,
# sa_business_role_permissions, sa_standard_policy_coverage, sa_settings, sa_sod_rules, sa_authority_policies, roles,
# organization_types) — configuration only, no personal data. Applies the MSS/Compensation migration twice (idempotency),
# loads synthetic fixtures and runs the scenarios. Never run against Supabase: localhost shares staging.
set -euo pipefail
URL="${1:?connection string of a disposable mss_test* database}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
M="$ROOT/supabase/migrations"
H="$ROOT/supabase/tests/hr_mss_compensation"
P=(psql -X -q -v ON_ERROR_STOP=1 "$URL")
"${P[@]}" -c "do \$g\$ begin if current_database() !~ '^mss_test' then raise exception 'Refusing: not a disposable mss_test* database'; end if; end \$g\$;"
for pass in 1 2; do
  echo "-- pass $pass: 20261103100000_hr_mss_compensation_viewer"
  "${P[@]}" -f "$M/20261103100000_hr_mss_compensation_viewer.sql" >/dev/null
done
"${P[@]}" -f "$H/10_fixtures.sql" >/dev/null
"${P[@]}" -f "$H/20_tests.sql"
