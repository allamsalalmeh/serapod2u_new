#!/usr/bin/env bash
# Usage: run.sh <connection string of a DISPOSABLE database named sa_prof_test*>
# REAL S&A migrations on stand-in platform tables (same base as sa_policy_eligibility, through
# 20261030100000_sa_policy_org_type_eligibility, plus 20261001100000 automatic-access restore), a negative control on the
# unpatched schema, then 20261108100000_sa_policy_grant_restore (applied twice) and the restore suite, including a
# concurrent double restore. Never run against Supabase: localhost shares the staging database.
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
R="$ROOT/supabase/tests/security/sa_policy_restore"
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
apply 20261030100000_sa_policy_org_type_eligibility
apply 20261001100000_sa_restore_overridden_automatic_access
"${P[@]}" -f "$R/10_fixtures.sql"
echo "== 20_before_tests.sql (negative control: unpatched schema)"; "${P[@]}" -o /dev/null -f "$R/20_before_tests.sql"
apply 20261108100000_sa_policy_grant_restore
echo "-- re-applying (idempotency)"; "${P[@]}" -f "$M/20261108100000_sa_policy_grant_restore.sql"
for f in "$R"/[3-8]*.sql; do echo "== $(basename "$f")"; "${P[@]}" -o /dev/null -f "$f"; done
# 11. Concurrency: two administrators restore the same revoked grant at the same moment — exactly one new grant.
echo "== concurrency: two simultaneous restores of one revoked grant"
"${P[@]}" -o /dev/null -f "$R/race_setup.sql"
A="$(mktemp)"; B="$(mktemp)"
psql -X -q -tA "$URL" -c "begin; select saf.try(format('select public.sa_restore_policy_grant(%L, %L)', saf.u(1), saf.race_id())); select pg_sleep(2); commit;" >"$A" 2>&1 &
sleep 0.5
psql -X -q -tA "$URL" -c "select saf.try(format('select public.sa_restore_policy_grant(%L, %L)', saf.u(23), saf.race_id()))" >"$B" 2>&1 &
wait
grep -q '^OK$' "$A" && grep -Eq 'sa_role_already_held|sa_restore_already_restored|sa_restore_superseded' "$B" \
  && [ "$("${P[@]}" -tA -c "select count(*) from public.sa_role_assignments where restored_from_assignment_id = saf.race_id()")" = "1" ] \
  && [ "$("${P[@]}" -tA -c "select count(*) from public.sa_role_assignments where user_id = saf.u(32) and role_id = saf.role('finance-viewer') and status = 'active'")" = "1" ] \
  || { echo "ASSERTION FAILED: concurrent restores must create exactly one grant"; cat "$A" "$B"; exit 1; }
echo "== concurrency: a restore and an ordinary grant of the same identity"
"${P[@]}" -o /dev/null -c "select saf.race_reset()"
psql -X -q -tA "$URL" -c "begin; select saf.try(format('select public.sa_restore_policy_grant(%L, %L)', saf.u(1), saf.race_id())); select pg_sleep(2); commit;" >"$A" 2>&1 &
sleep 0.5
psql -X -q -tA "$URL" -c "select saf.try(format('select public.sa_assign_role(%L, %L, %L, %L, array[%L]::uuid[], null, null, null)', saf.u(23), saf.u(32), saf.role('finance-viewer'), saf.o(1), saf.s(1)))" >"$B" 2>&1 &
wait
grep -q '^OK$' "$A" && grep -q 'sa_role_already_held' "$B" \
  && [ "$("${P[@]}" -tA -c "select count(*) from public.sa_role_assignments where user_id = saf.u(32) and role_id = saf.role('finance-viewer') and status = 'active'")" = "1" ] \
  || { echo "ASSERTION FAILED: a grant racing a restore must be refused, not merged"; cat "$A" "$B"; exit 1; }
rm -f "$A" "$B"
echo "ALL SA POLICY RESTORE TESTS PASSED"
