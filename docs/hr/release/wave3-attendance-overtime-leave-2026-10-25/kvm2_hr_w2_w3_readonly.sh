#!/usr/bin/env bash
# =============================================================================
# Serapod2U HR — Wave 2 independent verification + Wave 3 preflight / post-apply, KVM2 STAGING, READ-ONLY
# (owner-run from the Mac). Prepared 2026-10-25. Supersedes nothing: the Wave 1 script stays valid for B2A alone.
#
#   cd /Users/edierwan/serapod2u_dev/docs/hr/release/wave3-attendance-overtime-leave-2026-10-25
#   bash kvm2_hr_w2_w3_readonly.sh            # writes ~/serapod-hr-kvm2/out-w2w3-<timestamp>/ (outside the repo)
#
# Runs, in one read-only session each: environment proof → containers → build markers (Wave 1/2/3 code deployed?)
# → Wave 2 post-apply (sections 1–9) → Wave 2 function bodies = repository + Wave 3 preflight → B2A post-apply
# (still intact) → Wave 3 post-apply (reports "not applied" until the owner applies 20261222100000/20261223100000).
#
# READ-ONLY BY CONSTRUCTION
#   * Remote commands: hostname, docker ps / docker inspect --format <named fields only>, docker logs | grep -c,
#     grep inside the app container, and psql inside serapod-stg-db.
#   * Every psql session runs with PGOPTIONS='-c default_transaction_read_only=on' AND the scripts open
#     their own READ ONLY transaction and end with ROLLBACK. Nothing is restarted, deployed, granted or written.
#   * No environment variables, secrets, connection strings or full `docker inspect` output are printed.
#     Log extraction keeps only counts of HR error codes (no personal data, no request bodies).
#
# ENVIRONMENT PROOF (from supabase/migrations/PRODUCTION_MIGRATION_STATUS.md "Database and deployment identity")
#   Staging   = KVM2, hostname `mail`,        container `serapod-stg-db`, database `supabase`, PostgreSQL 17.6
#   Production= KVM8, hostname `srv1871914`,  container `serapod-prd-db`  -> this script REFUSES to continue there.
# =============================================================================
set -euo pipefail
umask 077                                   # output files readable by the owner only
HOST="72.62.253.182"
KEY="$HOME/.ssh/serapod_migration"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
W2POST="$ROOT/docs/hr/release/wave2-employment-foundation-2026-10-25/hr_w2_staging_post_apply_readonly.sql"
W2W3="$HERE/hr_w2_verify_w3_preflight_readonly.sql"
B2APOST="$ROOT/docs/hr/release/b2a-staging-2026-10-24/hr_b2a_staging_post_apply_readonly.sql"
W3POST="$HERE/hr_w3_staging_post_apply_readonly.sql"
UATREADY="$HERE/hr_w3_uat_readiness_readonly.sql"
OUT="$HOME/serapod-hr-kvm2/out-w2w3-$(date +%Y%m%d-%H%M%S)"   # outside the repository (raw output is never committed)
[ -r "$KEY" ] || { echo "SSH identity $KEY not readable - stopping."; exit 2; }
for f in "$W2POST" "$W2W3" "$B2APOST" "$W3POST" "$UATREADY"; do [ -r "$f" ] || { echo "Diagnostic SQL file $f not found - stopping."; exit 2; }; done
mkdir -p "$OUT"
# Host-key checking stays ON (BatchMode refuses an unknown or changed host key instead of prompting).
SSH=(ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=yes "root@$HOST")
DB=serapod-stg-db
# Least privilege: prefer Supabase's read-only role; fall back to postgres only if it cannot connect.
# Either way the session is forced read-only (default_transaction_read_only) and every script runs READ ONLY + ROLLBACK.
DBROLE=postgres
if "${SSH[@]}" "docker exec -e PGOPTIONS='-c default_transaction_read_only=on' $DB psql -U supabase_read_only_user -d supabase -XAtc 'select 1'" >/dev/null 2>&1; then
  DBROLE=supabase_read_only_user
fi
PSQL="docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' $DB psql -U $DBROLE -d supabase -X -v env=staging -v ON_ERROR_STOP=0 -f -"

echo "== 1. Environment identity" | tee "$OUT/01_identity.txt"
"${SSH[@]}" 'h=$(hostname); echo "hostname=$h"
  if [ "$h" != "mail" ]; then echo "REFUSING: hostname is not the KVM2 staging host (mail)"; exit 3; fi
  if docker ps --format "{{.Names}}" | grep -qx serapod-prd-db; then echo "REFUSING: a production DB container is present on this host"; exit 3; fi
  docker ps --format "{{.Names}}" | grep -qx serapod-stg-db || { echo "REFUSING: serapod-stg-db is not running"; exit 3; }
  echo "staging DB container present: serapod-stg-db"' 2>&1 | tee -a "$OUT/01_identity.txt"
grep -q "staging DB container present" "$OUT/01_identity.txt" || { echo "Environment proof failed - stopping."; exit 3; }
"${SSH[@]}" "$PSQL" >> "$OUT/01_identity.txt" 2>&1 <<'SQL'
begin transaction read only;
select current_database() as db, split_part(version(), ' on ', 1) as version, current_setting('transaction_read_only') as read_only,
       inet_server_addr() as server_addr, current_user as role;
select system_identifier from pg_control_system();
select (select count(*) from public.organizations) as organizations, (select count(*) from public.users) as users;
select rolname, rolbypassrls from pg_roles where rolname in ('supabase_read_only_user', 'postgres') order by 1;
\pset tuples_only on
select 'READONLY_CHECK=' || current_setting('transaction_read_only');
rollback;
SQL
echo "db_role_used=$DBROLE (supabase_read_only_user = least privilege; postgres = fallback, still read-only)" >> "$OUT/01_identity.txt"
cat "$OUT/01_identity.txt"
grep -q "READONLY_CHECK=on" "$OUT/01_identity.txt" || { echo "Session is not read-only - stopping."; exit 3; }
# Human confirmation: compare the identity above with PRODUCTION_MIGRATION_STATUS.md (staging = KVM2 / mail /
# serapod-stg-db / PostgreSQL 17.6) before anything else runs. Set CONFIRM_STAGING=STAGING to skip the prompt.
if [ "${CONFIRM_STAGING:-}" != "STAGING" ]; then
  read -r -p "Identity above is STAGING? Type STAGING to continue: " ans
  [ "$ans" = "STAGING" ] || { echo "Not confirmed - stopping."; exit 3; }
fi

echo "== 2. Containers, images, revisions, health (named fields only)" | tee "$OUT/02_containers.txt"
"${SSH[@]}" 'for c in $(docker ps -a --format "{{.Names}}"); do
    docker inspect --format "{{.Name}}|image={{.Config.Image}}|imageId={{.Image}}|created={{.Created}}|started={{.State.StartedAt}}|status={{.State.Status}}|health={{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}|restarts={{.RestartCount}}|revision={{index .Config.Labels \"org.opencontainers.image.revision\"}}|workdir={{.Config.WorkingDir}}" "$c"
  done' 2>&1 | tee -a "$OUT/02_containers.txt"

echo "== 3. Which HR code is deployed (marker strings in the built app; counts only)" | tee "$OUT/03_build_markers.txt"
#   Wave 1  'was not found or you are not authorized to act on it'   (modules/hr/leave/leaveErrors.ts)
#   Wave 2  'hr_employment_change'                                    (lib/hr/employment-foundation.ts)
#   Wave 3  'hr_attendance_my_overview' / 'Recorded with the server time.'  (lib/hr/wave3/server.ts, mobile attendance)
#   Old     'approved_at:new Date'  (pre-Wave-1 mobile approval)
"${SSH[@]}" 'for c in $(docker ps --format "{{.Names}}" | grep -viE "db|postgres|kong|gotrue|auth|rest|realtime|storage|meta|studio|imgproxy|analytics|vector|pooler|supavisor|edge|inbucket|mail"); do
    wd=$(docker inspect --format "{{.Config.WorkingDir}}" "$c"); [ -n "$wd" ] || wd=/
    echo "-- $c (workdir $wd)"
    for m in "was not found or you are not authorized to act on it" "hr_employment_change" "hr_attendance_my_overview" "Recorded with the server time." "approved_at:new Date"; do
      n=$(docker exec "$c" sh -c "grep -rlF \"$m\" \"$wd/.next\" 2>/dev/null | wc -l" 2>/dev/null || echo "n/a")
      echo "   marker [$m] files=$n"
    done
  done' 2>&1 | tee -a "$OUT/03_build_markers.txt"

echo "== 4. Wave 2 post-apply (read-only)" | tee "$OUT/04_w2_post_apply.txt"
"${SSH[@]}" "$PSQL" < "$W2POST" >> "$OUT/04_w2_post_apply.txt" 2>&1 || true

echo "== 5. Wave 2 bodies = repository + Wave 3 preflight (read-only)" | tee "$OUT/05_w2_verify_w3_preflight.txt"
"${SSH[@]}" "$PSQL" < "$W2W3" >> "$OUT/05_w2_verify_w3_preflight.txt" 2>&1 || true

echo "== 6. B2A post-apply, still intact (read-only)" | tee "$OUT/06_b2a_post_apply.txt"
"${SSH[@]}" "$PSQL" < "$B2APOST" >> "$OUT/06_b2a_post_apply.txt" 2>&1 || true

echo "== 7. Wave 3 post-apply (read-only; 'not applied' before the owner applies it)" | tee "$OUT/07_w3_post_apply.txt"
"${SSH[@]}" "$PSQL" < "$W3POST" >> "$OUT/07_w3_post_apply.txt" 2>&1 || true

echo "== 9. Wave 3 localhost-UAT readiness: policies carrying the needed permissions, HR configuration (read-only)" | tee "$OUT/09_uat_readiness.txt"
"${SSH[@]}" "$PSQL" < "$UATREADY" >> "$OUT/09_uat_readiness.txt" 2>&1 || true

grep -h "ERROR" "$OUT"/0[4-7]_*.txt "$OUT"/09_*.txt > "$OUT/08_sql_errors.txt" 2>/dev/null || true
echo
echo "Done. Results in: $OUT"
echo "Check first: 01 hostname=mail, read_only=on; 04 all sections as expected; 05 'matching | expected' = 26 | 26 and B3 duplicate_balance_keys = 0;"
echo "06 body_matches_repo all t; 07 w3a_applied/w3b_applied (f before application); 08_sql_errors.txt (permission-denied lines only if role was read-only user)."
