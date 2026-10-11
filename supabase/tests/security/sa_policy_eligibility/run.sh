#!/usr/bin/env bash
# Usage: run.sh <connection string of a DISPOSABLE database named sa_prof_test*>
# REAL S&A migrations on stand-in platform tables (same base as sa_order_creator: Root Access, the initial-authority and
# optional-note grant functions, the Order Creator policy), a negative control on the unpatched schema, then
# 20261030100000_sa_policy_org_type_eligibility (applied twice) and the eligibility suite.
# Never run against Supabase: localhost shares the staging database.
set -euo pipefail
URL="${1:?connection string of a disposable sa_prof_test* database}"
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
M="$ROOT/supabase/migrations"
SP="$ROOT/supabase/tests/security/sa_profiles"
GP="$ROOT/supabase/tests/security/sa_group_policies"
ID="$ROOT/supabase/tests/security/sa_identity_delete"
EA="$ROOT/supabase/tests/security/sa_emergency_access"
RA="$ROOT/supabase/tests/security/sa_root_access"
H="$ROOT/supabase/tests/security/sa_order_creator"
E="$ROOT/supabase/tests/security/sa_policy_eligibility"
P=(psql -X -q -v ON_ERROR_STOP=1 "$URL")
block() { awk -v s="$2" -v e="$3" 'index($0, s) == 1 {p=1} p {print} p && index($0, e) == 1 {p=0}' "$M/$1.sql" | "${P[@]}"; }
apply() { echo "-- migration $1"; "${P[@]}" -f "$M/$1.sql"; }
"${P[@]}" -f "$SP/00_bootstrap.sql"
"${P[@]}" -c "alter default privileges in schema public grant all on functions to anon, authenticated, service_role; alter default privileges in schema public grant all on tables to anon, authenticated, service_role; alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;"
apply 20260927140000_sa_wave1_foundation
"${P[@]}" -c "alter table public.sa_permissions add column if not exists audit_sensitivity text not null default 'security_sensitive'; alter table public.sa_permissions add constraint sa_permissions_audit_sensitivity_valid check (audit_sensitivity in ('ordinary','security_sensitive')); alter function public.sa_save_business_role(uuid,uuid,text,text,text,text[]) set search_path = pg_catalog, pg_temp; alter function public.sa_reject_decision_mutation() set search_path = pg_catalog, pg_temp;"
apply 20260928100000_sa_final_governance_foundation
apply 20261001130000_sa_grant_keeps_automatic_access
block 20260928110000_sa_final_finance_hr_lifecycle 'create table if not exists public.sa_function_guard_injections' 'comment on table public.sa_function_guard_injections'
block 20260928110000_sa_final_finance_hr_lifecycle 'create or replace function public.sa_inject_operation_guard' 'revoke all on function public.sa_inject_operation_guard'
block 20260928110000_sa_final_finance_hr_lifecycle 'create or replace function public.sa_cached_mode_is_new' 'revoke all on function public.sa_cached_mode_is_new'
block 20260928110000_sa_final_finance_hr_lifecycle 'create or replace function public.sa_cached_actor_allows' 'revoke all on function public.sa_cached_actor_allows'
block 20260928110000_sa_final_finance_hr_lifecycle 'create or replace function public.sa_rls_gate(' 'revoke all on function public.sa_rls_gate('
block 20260928110000_sa_final_finance_hr_lifecycle 'create or replace function public.sa_legacy_guard_unless_new' 'grant execute on function public.sa_legacy_guard_unless_new'
block 20260928110000_sa_final_finance_hr_lifecycle 'create or replace function public.sa_api_require_any_org' 'grant execute on function public.sa_api_require_any_org'
"${P[@]}" -f "$SP/05_qr_standins.sql"
block 20260928130000_sa_final_legacy_retirement_support 'create table if not exists public.sa_enforcement_readiness' 'grant select on table public.sa_enforcement_readiness'
apply 20261004100000_sa_bulk_migration_mode
apply 20261005100000_sa_directory_visibility
apply 20261005110000_sa_access_profiles
apply 20261006100000_sa_qr_batch_operator_profile
apply 20261007100000_sa_directory_filters
apply 20261008100000_sa_mode_governance_actor_context
"${P[@]}" -f "$GP/05_catalogue_standins.sql"
"${P[@]}" -f "$GP/10_fixtures.sql"
apply 20261009100000_sa_group_policies_full_access
apply 20261011100000_sa_scope_eligibility_for_grants
apply 20261019110000_sa_mode_change_note_and_keep_retired
"${P[@]}" -f "$ID/05_identity_standins.sql"
block 20260930100000_sa_stage2d_deferred_closure 'create or replace function public.sa_readable_organizations' 'grant execute on function public.sa_readable_organizations'
block 20260930100000_sa_stage2d_deferred_closure 'create or replace function public.sa_actor_dominates' 'grant execute on function public.sa_actor_dominates'
"${P[@]}" -f "$EA/05_auth_mfa_standins.sql"
"${P[@]}" -f "$EA/10_fixtures.sql"
apply 20261024100000_sa_emergency_access_grant_flow
"${P[@]}" -f "$RA/10_fixtures.sql"
apply 20261026100000_sa_root_access
apply 20261015100000_sa_initial_policy_same_authority_as_grant
apply 20261020100000_sa_grant_optional_note

# Order tables (stand-ins) + the REAL order authorization objects.
"${P[@]}" -f "$H/05_order_standins.sql"
block 20260928120000_sa_final_modules_supply_chain 'create or replace function public.sa_orders_api_write_guard' 'for each row execute function public.sa_orders_api_write_guard();'
apply 20260621_h2m_hq_access_level_40
apply 20261007100200_save_order_with_items_rpc
"${P[@]}" -f "$H/10_fixtures.sql"
apply 20261028100000_sa_order_creator_policy
"${P[@]}" -f "$E/10_fixtures.sql"
echo "== 20_before_tests.sql (negative control: unpatched schema)"; "${P[@]}" -o /dev/null -f "$E/20_before_tests.sql"
apply 20261030100000_sa_policy_org_type_eligibility
echo "-- re-applying (idempotency)"; "${P[@]}" -f "$M/20261030100000_sa_policy_org_type_eligibility.sql"
for f in "$E"/[3-9]*.sql; do echo "== $(basename "$f")"; "${P[@]}" -o /dev/null -f "$f"; done
# 16. Concurrency: an eligibility change and a grant of the same policy serialize on the policy row.
echo "== concurrency: narrowing commits first, the waiting grant is refused"
"${P[@]}" -o /dev/null -f "$E/race_setup.sql"
A="$(mktemp)"; B="$(mktemp)"
psql -X -q -tA "$URL" -c "begin; update public.sa_business_roles set applicable_org_types = array['HQ'] where role_key = 'saf-race'; select pg_sleep(2); commit;" >"$A" 2>&1 &
sleep 0.5
psql -X -q -tA "$URL" -c "select saf.grant_ok(23, 22, 'saf-race', 11, 11)" >"$B" 2>&1 &
wait
grep -q 'sa_profile_not_applicable' "$B" && [ "$("${P[@]}" -tA -c "select saf.active(22, 'saf-race')")" = "0" ] || { echo "ASSERTION FAILED: the grant must see the narrowed policy"; cat "$A" "$B"; exit 1; }
echo "== concurrency: grant commits first, the waiting narrowing is refused"
"${P[@]}" -o /dev/null -c "update public.sa_business_roles set applicable_org_types = array['HQ','DIST'] where role_key = 'saf-race'"
psql -X -q -tA "$URL" -c "begin; select saf.grant_ok(23, 22, 'saf-race', 11, 11); select pg_sleep(2); commit;" >"$A" 2>&1 &
sleep 0.5
psql -X -q -tA "$URL" -c "update public.sa_business_roles set applicable_org_types = array['HQ'] where role_key = 'saf-race'" >"$B" 2>&1 &
wait
grep -q '^OK$' "$A" && grep -q 'sa_profile_eligibility_has_holders' "$B" && [ "$("${P[@]}" -tA -c "select applicable_org_types::text from public.sa_business_roles where role_key = 'saf-race'")" = "{HQ,DIST}" ] \
  || { echo "ASSERTION FAILED: the narrowing must see the committed grant"; cat "$A" "$B"; exit 1; }
rm -f "$A" "$B"
echo "ALL SA POLICY ELIGIBILITY TESTS PASSED"
