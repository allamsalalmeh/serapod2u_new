#!/usr/bin/env bash
# =============================================================================
# Serapod2U HR — Wave 1 KVM2 STAGING read-only verification (owner-run from the Mac)
# Prepared 2026-10-24 for B2A (20261219100000_hr_leave_containment_guard) / B2B.
#
#   cd /Users/edierwan/serapod2u_dev/docs/hr/release/b2a-staging-2026-10-24
#   bash kvm2_hr_wave1_readonly.sh            # writes ~/serapod-hr-kvm2/out-<timestamp>/ (outside the repo)
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
V2="$ROOT/docs/hr/assessments/hr_b0_environment_readonly_v2.sql"
POST="$HERE/hr_b2a_staging_post_apply_readonly.sql"
OUT="$HOME/serapod-hr-kvm2/out-$(date +%Y%m%d-%H%M%S)"   # outside the repository (raw output is never committed)
[ -r "$KEY" ] || { echo "SSH identity $KEY not readable - stopping."; exit 2; }
[ -r "$V2" ] && [ -r "$POST" ] || { echo "Diagnostic SQL files not found next to this script - stopping."; exit 2; }
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

echo "== 3. Which leave/payroll code is deployed (marker strings in the built app; counts only)" | tee "$OUT/03_build_markers.txt"
# B2A/B2B markers exist only in the new build:
#   B2A  'was not found or you are not authorized to act on it'   (modules/hr/leave/leaveErrors.ts)
#   B2A  'no completed HR employment record in this company'      (Wave 1 fix)
#   B2B  'PAYROLL_STATUTORY_NOT_CERTIFIED'                        (payroll approve lock)
# Old-code marker: mobile approval stamping the approver client-side ('approved_at:new Date' in the bundle).
"${SSH[@]}" 'for c in $(docker ps --format "{{.Names}}" | grep -viE "db|postgres|kong|gotrue|auth|rest|realtime|storage|meta|studio|imgproxy|analytics|vector|pooler|supavisor|edge|inbucket|mail"); do
    wd=$(docker inspect --format "{{.Config.WorkingDir}}" "$c"); [ -n "$wd" ] || wd=/
    echo "-- $c (workdir $wd)"
    for m in "was not found or you are not authorized to act on it" "no completed HR employment record in this company" "PAYROLL_STATUTORY_NOT_CERTIFIED" "approved_at:new Date"; do
      n=$(docker exec "$c" sh -c "grep -rlF \"$m\" \"$wd/.next\" 2>/dev/null | wc -l" 2>/dev/null || echo "n/a")
      echo "   marker [$m] files=$n"
    done
  done' 2>&1 | tee -a "$OUT/03_build_markers.txt"

echo "== 4. HR error codes in the last 7 days of logs (counts only)" | tee "$OUT/04_log_counts.txt"
"${SSH[@]}" 'for c in $(docker ps --format "{{.Names}}"); do
    r=$(docker logs --since 168h "$c" 2>&1 | grep -oE "hr_leave_[a-z_]+|hr_onboarding_pending|PAYROLL_STATUTORY_NOT_CERTIFIED" | sort | uniq -c | tr "\n" ";")
    [ -n "$r" ] && echo "$c: $r"
  done; echo "(end)"' 2>&1 | tee -a "$OUT/04_log_counts.txt"

echo "== 5. B0 diagnostic v2 (read-only)" | tee "$OUT/05_b0_v2.txt"
"${SSH[@]}" "$PSQL" < "$V2" >> "$OUT/05_b0_v2.txt" 2>&1 || true

echo "== 6. B2A post-apply verification (read-only)" | tee "$OUT/06_b2a_post_apply.txt"
"${SSH[@]}" "$PSQL" < "$POST" >> "$OUT/06_b2a_post_apply.txt" 2>&1 || true

echo
echo "Done. Results in: $OUT"
echo "If db_role_used=supabase_read_only_user and 06 sections F/G show 'permission denied', re-run those sections only as postgres (still read-only)."
echo "Check first: 01 shows hostname=mail and read_only=on; 06 section A body_matches_repo all 't'; 06 G3 blocked_no_decider = 0."
