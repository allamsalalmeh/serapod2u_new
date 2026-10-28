#!/usr/bin/env bash
# =============================================================================
# Serapod2U HR — Wave 1 native verification on the Mac, isolated from shared staging.
#
#   cd /Users/edierwan/serapod2u_dev
#   bash docs/hr/release/b2a-staging-2026-10-24/local_verify_isolated.sh      # → ~/serapod-hr-local-verify/<time>/
#
# Why: app/.env.local points at the SHARED staging Supabase. Next.js loads .env.local for `next build`, and some
# code reads process.env directly. Variables already present in the process environment are NOT overridden by
# .env files (Next.js / @next/env precedence), so every staging-pointing variable is set here to a dead loopback
# address first. Nothing in this script can reach staging; the build it produces is for verification only and
# must NOT be deployed (its NEXT_PUBLIC_* values are the dead addresses).
# Writes only: app/.next (build output, git-ignored) and the log folder outside the repository.
# =============================================================================
set -uo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
LOG="$HOME/serapod-hr-local-verify/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$LOG"
cd "$ROOT/app"

DEAD_HTTP="http://127.0.0.1:9"
export NEXT_PUBLIC_SUPABASE_URL="$DEAD_HTTP"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="isolated-test-anon"
export SUPABASE_SERVICE_ROLE_KEY="isolated-test-service"
export DATABASE_POOL_URL="postgresql://isolated@127.0.0.1:9/none"
export NEXT_TELEMETRY_DISABLED=1
# NOTE (2026-10-25): NEXT_PUBLIC_APP_URL / NEXT_PUBLIC_SITE_URL / DISABLE_INTERNAL_CRON_WORKERS are set ONLY for the
# build step below. Setting them for Vitest makes 24 cron/excel tests fail (they assert the default behaviour when
# those variables are absent) — a harness artefact, not a code defect.
unset ALLOW_REMOTE_DB_WORKERS_FROM_LOCAL DATABASE_URL SUPABASE_DB_URL PGHOST PGPASSWORD PGUSER PGDATABASE

# Refuse if any other variable in this environment still names a Supabase/pooler host.
if env | grep -iE "supabase\.co|pooler|serapod.*(stg|prd)|72\.62\.253\.182" | grep -vE "^(NEXT_PUBLIC_SUPABASE_URL|DATABASE_POOL_URL)=" ; then
  echo "REFUSING: the variables above still point at a remote database." | tee "$LOG/REFUSED.txt"; exit 2
fi
echo "isolation: Supabase/DB/app URLs forced to loopback; cron workers disabled" | tee "$LOG/00_isolation.txt"

run() { local name="$1"; shift; echo "== $name: $*"; "$@" > "$LOG/$name.log" 2>&1; local rc=$?; echo "$name exit=$rc" | tee -a "$LOG/summary.txt"; tail -5 "$LOG/$name.log"; }

run 01_vitest  npm test
# tsc needs more than Node's default ~4 GB heap on this project (2026-10-26: exit 134 = V8 out of memory on the Mac).
( export NODE_OPTIONS="--max-old-space-size=8192"; run 02_tsc npx tsc --noEmit )
( export NEXT_PUBLIC_APP_URL="$DEAD_HTTP" NEXT_PUBLIC_SITE_URL="$DEAD_HTTP" DISABLE_INTERNAL_CRON_WORKERS="true"; run 03_build npm run build )

echo
grep -E "Test Files|Tests " "$LOG/01_vitest.log" | tee -a "$LOG/summary.txt"
if grep -q "02_tsc exit=1[0-9][0-9]" "$LOG/summary.txt" || grep -q "heap out of memory" "$LOG/02_tsc.log"; then
  echo "tsc CRASHED (no type-check result — NOT a pass). Re-run with a larger NODE_OPTIONS heap." | tee -a "$LOG/summary.txt"
else
  echo "tsc errors total: $(grep -c 'error TS' "$LOG/02_tsc.log")  in HR files: $(grep -E 'error TS' "$LOG/02_tsc.log" | grep -cE '(/hr/|hr-|Hr[A-Z]|/leave/)')" | tee -a "$LOG/summary.txt"
fi
echo "Known non-HR baseline (2026-10-25): 1 Vitest failure (orders/[orderId]/ship-metrics), ~250 tsc errors in non-HR files." | tee -a "$LOG/summary.txt"
echo "Logs: $LOG   (do not deploy app/.next from this run)"
