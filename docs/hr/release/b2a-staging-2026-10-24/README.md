# B2A/B2B — Staging release and UAT package (2026-10-24)

Back to [HR_MASTER_INDEX.md](../../HR_MASTER_INDEX.md) · roadmap [§2b](../../HR_IMPLEMENTATION_ROADMAP.md) · tracker [§7–§8](../../HR_PROGRESS_TRACKER.md)

Prepared at `Enhancement03` HEAD `b6b78002` (B2A/B2B and Wave 1 fixes **uncommitted**). Nothing in this folder has been run against staging or production by the AI session: KVM2 was not reachable from it (no SSH route, no access to `~/.ssh`).

## Files

| File | What it does | Writes? |
|---|---|---|
| `local_verify_isolated.sh` | Owner-run on the Mac: native `npm test`, `npx tsc --noEmit`, `npm run build` with every staging-pointing variable forced to loopback (process env beats `.env.local`), cron workers disabled; refuses if any variable still names a remote DB. Logs to `~/serapod-hr-local-verify/`. The build is verification-only — never deploy it | Only `app/.next` (git-ignored) and the log folder |
| `kvm2_hr_wave1_readonly.sh` | Owner-run from the Mac. SSH to KVM2 (host-key checking on), **refuses unless** hostname = `mail` and `serapod-stg-db` is present and `serapod-prd-db` is not, the DB session reports `READONLY_CHECK=on`, and you type `STAGING`; prefers the `supabase_read_only_user` role (falls back to `postgres`, still read-only); lists containers (named fields only), deployed-build markers, HR error-code counts from logs, then runs the two SQL scripts below inside `serapod-stg-db`. Output goes to `~/serapod-hr-kvm2/out-<time>/` (outside the repo). | No — `PGOPTIONS=-c default_transaction_read_only=on` + READ ONLY transactions + ROLLBACK; no restart/deploy |
| `hr_b2a_staging_post_apply_readonly.sql` | Post-apply verification of `20261219100000`: function bodies (md5 vs repo), security mode, EXECUTE grants, triggers, RLS, audit table, reset scope, identity markers, S&A coverage, pending requests with no authorized decider, employment-org discrepancies, historical rows. Aggregates only. | No |
| `hr_b2a_approver_coverage_readonly.sql` | **Named** worklist for the minimum grants: people who actually decided leave in the last 365 days (HR candidates) and recorded direct managers, each with their strict B2A status; legacy-only holders who did not decide leave (not to be granted by default). Keep output local. | No |
| `../../assessments/hr_b0_environment_readonly_v2.sql` | Canonical B0 diagnostic (run by the script, step 5) | No |

Verified in the AI workspace: the KVM2 script ran end-to-end against a local PostgreSQL replica through a mocked `ssh`/`docker` (identity refusal, read-only check, both diagnostics; output mode 600); both SQL scripts run without error on disposable PostgreSQL 16 replicas built from the 2026-10-16 snapshots with the migration applied (the only error is the expected absent `supabase_migrations` ledger); the shell script's flow and its refusal on a non-staging hostname were exercised with a mocked `ssh`/`docker`.

## Release procedure (staging only; each step owner-run, nothing below is authorized for production)

| Step | Action | Pass criterion / evidence |
|---|---|---|
| R1 | On the Mac: `bash docs/hr/release/b2a-staging-2026-10-24/local_verify_isolated.sh` (never plain `npm run build` with `.env.local` active) | Vitest: only the known non-HR baseline failure (`orders/[orderId]/ship-metrics`, `v_stock_movements_display` absent from the snapshot); tsc: no error in HR files (250 pre-existing non-HR errors at `b6b78002`); build succeeds |
| R2 | Review the HR diff; commit **only** HR files (`git add -p`; tests with `git add -f`, BL-16; this folder's `.sh` needs `git add -f`). Do not push without separate approval | Commit hash |
| R3 | `bash docs/hr/release/b2a-staging-2026-10-24/kvm2_hr_wave1_readonly.sh` | `01`: hostname `mail`, `read_only=on`; `06` A: `body_matches_repo` all `t`; B: anon `f`, guard/recorder all `f`; C: guard + recorder `O`; D: 6 `b2a` policies, 0 others; E: no `hr_leave_requests_status_chk`, events row `keep` |
| R4 | Record the staging application in `PRODUCTION_MIGRATION_STATUS.md` (date, method, verifier, R3 output) | PMS row |
| R5 | Run `hr_b2a_approver_coverage_readonly.sql`; owner decides grants from W1/W2 (S&A action, People & Access): `hr-leave-attendance-administrator` (HQ-scoped) to genuine HR deciders with `strict_hr = f`; `manager-self-service` to genuine managers with `strict_mss = f`. Never grant W3 by default | Re-run `06`: G3 `blocked_no_decider = 0` |
| R6 | Deploy the R2 commit to staging (separately authorized); record the image/revision | `03_build_markers`: the three B2A/B2B markers present, old marker absent |
| R7 | Announce the UAT window (BL-12); create dedicated test accounts E1, E2 (employees, E2 reports to M1), M1 (MSS + reporting line), M2 (no MSS), H1 (explicit HR), L1 (legacy-only), X1 (only if G4 finds an employment-record mismatch) | Account list |
| R8 | UAT scenarios below | UAT log |
| R9 | Rollback if needed: **SAFE** rollback from the migration header only (never the full revert, D-028) | Re-run R3 |

## UAT scenarios (B2A)

| # | Actor | Action | Expected |
|---|---|---|---|
| U1 | E1 | Apply leave (web and mobile) | Pending; event `self/insert` |
| U2 | E1 | Approve own request (no button on web/mobile; try via API) | Refused `hr_leave_self_approval`; no success toast |
| U3 | M1 | Approve E2's request | Approved; `approved_by` = M1 stamped by DB; event `manager` |
| U4 | M2 | Approve E2's request | Refused / not visible; red "Decision not saved" toast, never "Approved" |
| U5 | H1 | Approve any request in own HQ / child company | Approved; event `hr` |
| U6 | H1 | Request in another HQ company | Not visible |
| U7 | L1 | Approve or view others' leave | Not visible / refused |
| U8 | E1 | Cancel own pending; try to cancel approved | Pending → cancelled; approved refused (HR only) |
| U9 | H1 | Cancel approved leave | Cancelled; approver kept |
| U10 | E1 | Read others' leave and balances | Own only |
| U11 | X1 (only if post-apply G4 > 0) | Apply leave | Clear refusal: "no completed HR employment record in this company…" — by design the current employment is the record in the home organization (Identity Stage 2); fix the employee's data, not the rule |
| U12 | H1 | `select * from hr_leave_containment_review('<org>')` | Lists legacy/suspicious rows; nothing changed |
| U13 | HR admin | HR Data Management reset preview/restore on a **test** organization only (if UAT scope allows) | Events table listed as kept, no blocker |

B2B UAT (unchanged from roadmap S6): payroll approve blocked with `PAYROLL_STATUTORY_NOT_CERTIFIED`; correction self-review refused; timesheet regenerate-after-approve refused; OT self-approval refused; holiday template national-only.

## HR-only commit manifest

Prepared at HEAD `b6b78002` for owner review. **Not staged, not committed.** Stage exactly these paths (never `git add .`/`-A`); review hunks with `git add -p` for the modified files.

**Modified, tracked — 28 files** (manifest total 61 files: 28 modified + 11 new + 22 forced):

```bash
git add -p -- .gitignore   # only the D-032 hunk: "!/docs/hr/**/*.sql"
git add -p -- \
  app/src/app/api/hr/accounting/preview-journal/route.ts \
  'app/src/app/api/hr/attendance/corrections/[id]/review/route.ts' \
  app/src/app/api/hr/attendance/overtime/preview/route.ts \
  app/src/app/api/hr/attendance/overtime/requests/route.ts \
  app/src/app/api/hr/attendance/timesheets/route.ts \
  app/src/app/api/hr/config/audit/route.ts \
  app/src/app/api/hr/finance/post-payroll-run/route.ts \
  'app/src/app/api/hr/payroll/runs/[id]/approve/route.ts' \
  'app/src/app/api/hr/payroll/runs/[id]/calculate/route.ts' \
  app/src/app/api/hr/payroll/runs/route.ts \
  app/src/app/api/hr/payroll/statutory-settings/route.ts \
  app/src/app/api/hr/public-holidays/route.ts \
  app/src/components/hr/mobile/HrMobileLeave.tsx \
  app/src/components/hr/modules/HrLeaveApprovalFlowView.tsx \
  app/src/components/hr/modules/HrLeaveRequestsView.tsx \
  app/src/components/hr/modules/HrPayrollPayslipsView.tsx \
  app/src/lib/api/payroll.ts \
  app/src/modules/hr/hrNav.ts app/src/modules/hr/hrNav.test.ts \
  app/src/modules/hr/leave/supabaseRepository.ts app/src/modules/hr/leave/types.ts \
  docs/hr/HR_MASTER_INDEX.md docs/hr/HR_MASTER_SCOPE.md docs/hr/HR_DECISION_REGISTER.md \
  docs/hr/HR_IMPLEMENTATION_ROADMAP.md docs/hr/HR_PROGRESS_TRACKER.md docs/hr/HR_GO_LIVE_GATES.md
```

**New, trackable without force:**

```bash
git add -- \
  supabase/migrations/20261219100000_hr_leave_containment_guard.sql \
  app/src/lib/hr/attendance-repairs.ts app/src/lib/hr/payroll-calculation.ts app/src/lib/hr/schema-contract.ts \
  app/src/lib/hr/test-support/fakeSupabase.ts \
  app/src/modules/hr/leave/leaveErrors.ts \
  app/src/components/hr/modules/HrLeaveRequestsView.decisions.test.tsx \
  docs/hr/assessments/hr_b0_environment_readonly_v2.sql \
  docs/hr/release/b2a-staging-2026-10-24/README.md \
  docs/hr/release/b2a-staging-2026-10-24/hr_b2a_staging_post_apply_readonly.sql \
  docs/hr/release/b2a-staging-2026-10-24/hr_b2a_approver_coverage_readonly.sql
```

**New, git-ignored by broad rules — need `git add -f`** (`*.test.ts` rule, `*.sh` rule, `**/tests/**` rule):

```bash
git add -f -- \
  'app/src/app/api/hr/attendance/corrections/[id]/review/route.test.ts' \
  app/src/app/api/hr/attendance/overtime/requests/route.test.ts \
  app/src/app/api/hr/attendance/timesheets/route.test.ts \
  'app/src/app/api/hr/payroll/runs/[id]/approve/route.test.ts' \
  'app/src/app/api/hr/payroll/runs/[id]/calculate/route.test.ts' \
  app/src/lib/hr/attendance-repairs.test.ts app/src/lib/hr/payroll-calculation.test.ts \
  app/src/lib/hr/schema-contract.test.ts app/src/lib/hr/migration-versions.test.ts \
  app/src/lib/hr/b2b-retired-and-holidays.test.ts \
  app/src/modules/hr/leave/leaveErrors.test.ts app/src/modules/hr/leave/supabaseRepository.test.ts \
  docs/hr/release/b2a-staging-2026-10-24/kvm2_hr_wave1_readonly.sh \
  docs/hr/release/b2a-staging-2026-10-24/local_verify_isolated.sh \
  supabase/tests/security/hr_leave_containment/
```

**Excluded (not HR, or not for commit):** `app/src/components/dashboard/DashboardContent.tsx` and `app/src/lib/navigation/` (view-navigation workstream); `a3.out`, `d5.out`, `h1.out`, `h2.out`, `backup_diag.txt`, the two `.code-workspace` files; `docs/hr/hr_b2a_staging_post_apply_readonly.sql` (owner's earlier copy of the release SQL — superseded by the release-folder version; delete or keep locally); `tmp/*` (git-ignored scratch: two source/dependency archives and two doc-update scripts from the AI session — safe to delete).

**After staging, before committing:** `git diff --cached --stat` must list only the paths above; `git status --short` must still show the excluded files as unstaged.
