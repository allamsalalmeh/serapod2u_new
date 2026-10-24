# Serapod2U HR — Progress Tracker (baseline)

Last verified: 2026-10-24 · HEAD `1e0830c6` (B0 evidence reconciliation) · back to [HR_MASTER_INDEX.md](HR_MASTER_INDEX.md)

## Rules for this file

- Every field is evidence-based. **Unknown environment state = NOT VERIFIED.**
- **Deployment is never inferred from Git commits.** No application deployment has been verified by this documentation task, so every "Deployed" and "Operationally verified" field is NOT VERIFIED.
- **Tests passing never marks an item complete.** "Tests" records what was run, by whom and at which HEAD.
- **Migration applied** fields cite `PRODUCTION_MIGRATION_STATUS.md` (PMS, last updated 2026-10-16). "Owner-reported" = run by the owner, independent re-check pending (as recorded in PMS).
- **Design approved** = an owner approval is recorded in [HR_DECISION_REGISTER.md](HR_DECISION_REGISTER.md). A design document without a recorded approval is shown as "Documented".
- Update this file after every approved batch (rule 7).

Legend: **Yes** · **Partial** · **No** · **NV** (NOT VERIFIED) · **n/a**.
"Tests: Reported (baseline)" = reported passing in `HR Gap & Go-Live Readiness Audit.md` at `92022c44`; **not re-run** at `82da8cd0`.

---

## 1. Tracker

| ID | Enhancement | Design approved | Code implemented | Tests passed | Migration created | Applied staging | Applied production | UAT passed | Deployed | Operationally verified | Current blocker | Next action |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S-01.1–.5 | Canonical identity, onboarding state, Add Employee, operational guard, HR Data Management | Yes (D-005); design documented | Yes | Reported (baseline) | Yes `20261003100000` | Yes — PMS verified 2026-10-13 | Yes — PMS catalog diff 2026-10-16 | NV | NV | NV | — | Include in B9 UAT |
| S-01.6 | Statutory & personal master data | No (P-F09 proposed) | No | n/a | No | n/a | n/a | n/a | n/a | n/a | Decision P-F09 | B7c |
| S-01.7 | Employment history versions | No (proposed) | No | n/a | No | n/a | n/a | n/a | n/a | n/a | P-F02/P-F09 | B7c |
| S-02.1 | Controlled Remove/Reset HR Registration | Yes (D-006) | Yes (commit `17c84ab7`) | Reported (baseline: registration route tests) | Yes `20261214100000` | **NV** (not in PMS) | **NV** | NV | NV | NV | BL-2 | B0 → B1 |
| S-02.2 | Canonical permanent identity deletion | Documented (`docs/identity/PERMANENT_IDENTITY_DELETION.md`); approval not recorded | Yes (`f5297467`) | NV (commit claims replica suite; not re-run) | Yes `20261216100000_identity_permanent_deletion` | NV | NV | NV | NV | NV | BL-2, duplicate version | B0 → B1 |
| S-02.3 | Bulk employee removal | Documented (`BULK_EMPLOYEE_REMOVAL.md`); approval not recorded | Yes (`82da8cd0`; serialized execution + bounded lock-conflict retry `5d6c9bcb`) | NV (unit/UI/API tests and isolated PG locking reproduction added in commits; not re-run) | n/a (no migration) | n/a (depends on S-02.2, S-03.1) | n/a | NV | NV | NV | Depends on B1 | B1 then UAT |
| S-03.1 | Archive & Revoke Access, identifier release | Yes (D-007, D-008) | Yes (`b9934f48`, `0df40475`) | NV (replica 75 asserts per commit; not re-run) | Yes `20261217100000`, `20261218100000` | NV | NV | NV | NV | NV | BL-2 | B0 → B1 |
| S-03.2 | Former Employees tab | Documented; approval not recorded | Yes (`94299cf9`) | NV | n/a | n/a | n/a | NV | NV | NV | Depends on S-03.1 migration | B1 UAT |
| S-03.3/.4 | Archive: reassignment, end dependent HR state | No (proposed) | No | n/a | No | n/a | n/a | n/a | n/a | n/a | PD-LC-02 | B7b |
| S-03.5 | Scheduled separation, last working date | No | No | n/a | No | n/a | n/a | n/a | n/a | n/a | PD-LC-01 | B7b |
| S-03.6 | Former-employee documents | No | No | n/a | No | n/a | n/a | n/a | n/a | n/a | PD-LC-03 | B7b |
| S-04.1/.3 | Departments, org charts | Documented | Yes | Reported (baseline) | n/a | NV | NV | NV | NV | NV | — | B9 UAT |
| S-04.2 | Position management V1.1 foundation | Documented (`POSITION_MANAGEMENT_V1.1.md`) | Partial (D3/D4/D6 UI gaps) | Reported (baseline) | Yes HR01–HR05 | Yes — PMS user-confirmed, verified 2026-10-13 | Yes — PMS catalog diff 2026-10-16 | NV | NV | NV | UI gaps | Scope decision; B8/B9 |
| S-04.4 | Single Departments/Positions entry | No (P-R10) | No | n/a | n/a | n/a | n/a | n/a | n/a | n/a | — | B8 |
| S-05.2 | Reporting-line reconciliation | No (P-R08) | No | n/a | No | n/a | n/a | n/a | n/a | n/a | — | B7a |
| S-05.3 | Additional-manager RLS | No | No | n/a | No | n/a | n/a | n/a | n/a | n/a | — | Not yet batched (candidate B7a) |
| S-06.1–.2 | Hybrid attendance, auto-validation | Yes — direction (D-011, D-012); details pending | Partial (clock only) | n/a | No | n/a | n/a | n/a | n/a | n/a | BL-6 / PD-ATT-01,03,07,08 | Owner answers → B4a |
| S-06.4 | Timesheets (period summaries) | Documented | Partial — **generation broken** (non-existent columns); submit/approve/reject aligned | n/a | n/a | n/a | n/a | NV | NV | NV | BL-10 | B2B |
| S-07.1 | Mobile clock in/out (basic) | Documented | Yes | NV | n/a | NV | NV | NV | NV | NV | — | B9 UAT |
| S-07.2 | Mobile capture controls | Direction only | No | n/a | No | n/a | n/a | n/a | n/a | n/a | PD-ATT-02 | B4a |
| S-08.1 | Corrections with controlled approval | Yes — direction (D-013); approver pending | Partial — requests aligned; **review route broken** (`review_note`, audit columns), no self-review block (B0 2026-10-24) | NV | n/a | NV | NV | NV | NV | NV | PD-ATT-04 | B4b |
| S-08.2 | HR manual attendance entry | Direction only | No | n/a | No | n/a | n/a | n/a | n/a | n/a | PD-ATT-04 | B4b |
| S-09.1–.2 | Excel bulk attendance import | Direction only | No | n/a | No | n/a | n/a | n/a | n/a | n/a | PD-ATT-05 | B4c |
| S-10.1–.2 | Exception detection & review | Yes — direction (D-012) | No | n/a | No | n/a | n/a | n/a | n/a | n/a | PD-ATT-03, 06 | B4a |
| S-11.1 | OT separate from attendance | Yes (D-014) | Partial (table/policy) | n/a | n/a | NV | NV | NV | NV | NV | — | B5 |
| S-11.2 | OT request API working, no self-approval | No (P-R03 family) | **Broken** (column drift) | n/a | n/a | n/a | n/a | n/a | n/a | n/a | — | B2 |
| S-11.3/.4 | Approved OT as payroll source; MSS OT approval | No | No | n/a | No | n/a | n/a | n/a | n/a | n/a | PD-OT-01..03 | B5 |
| S-12.1 | Leave containment (RLS) | No (P-R02; B2A design P-R13 final in B0-PLAN, awaiting OD-B2A-1…7) | **Open P0 defect** | n/a | No | n/a | n/a | n/a | n/a | n/a | BL-3 | B2 |
| S-12.2 | ESS leave form type list | n/a (defect) | **Broken** (re-checked `1e0830c6`: filter `is_active` still wrong; uncommitted other-workstream edit only renames `max_days_per_year`, BL-9) | n/a | n/a | n/a | n/a | n/a | n/a | n/a | — | B2 |
| S-12.3–.7 | Leave workflow, ledger, entitlements, holidays, unpaid days | No (P-R04) | Partial (tables; client writes; mock flow) | n/a | No | n/a | n/a | n/a | n/a | n/a | PD-LV-*, PD-SA-01 | B6 |
| S-13.1 | ESS | Documented | Yes (leave form broken) | Reported (baseline) | Yes (`20261106100000` profile edit) | Yes — PMS verified 2026-10-13 | Yes — PMS catalog diff 2026-10-16 | NV | NV | NV | S-12.2 | B2, B9 |
| S-13.2 | MSS read & compensation viewer | Documented (`docs/security/ESS_MSS_*`) | Yes | Reported (baseline) | Yes `20261103…20261105` | Yes — PMS 2026-10-13 | Yes — PMS (20261103/04 owner-reported after D-1 fix; 20261105 verified) | NV | NV | NV | Independent re-check pending (PMS) | B0 re-check |
| S-13.3 | MSS actions (leave/OT/exception approval) | No | No | n/a | No | n/a | n/a | n/a | n/a | n/a | B4a/B5/B6 | — |
| S-14.1 | Performance & KPI | Documented | Yes | Reported (baseline) | (earlier migrations) | NV | NV | NV | NV | NV | — | B9 UAT |
| S-15.1 | Commission | Documented (`STAFF_COMMISSION.md`) | Yes | Reported (`STAFF_COMMISSION.md` + baseline) | Yes `20261102110000`, `20261102120000` | Yes — PMS 2026-10-13 | Yes — PMS catalog diff 2026-10-16 | NV | NV | NV | — | B9 UAT |
| S-15.2 | Commission → payroll consumer | No (P-F10) | No | n/a | No | n/a | n/a | n/a | n/a | n/a | Phase B | Phase B |
| S-16.1–.5 | Navigation & reporting fixes | No (P-R10) | No | n/a | n/a | n/a | n/a | n/a | n/a | n/a | — | B2 (quick wins), B8 |
| S-17.1 | S&A as authority (architecture) | Yes (D-004) | Partial | Reported (baseline: 90 S&A tests) | Yes (S&A waves) | Yes (PMS) | Yes (PMS) | NV | NV | NV | Prod modes NV since 2026-10-02 | B0 |
| S-17.2–.6 | HR S&A consolidation | No (P-R05..07) | No | n/a | Partial (`20261215110000`, `20261216100000_sa_legacy_preview…` untracked) | NV | NV | n/a | n/a | n/a | PD-SA-01/02 | B1 (controls), B3 |
| S-18.2–.8 | Finance-ready data items A1–A7 | No (P-F02, P-F09) | No | n/a | No | n/a | n/a | n/a | n/a | n/a | Owner decisions | B6, B7b–d |
| S-18.9 | Payroll fail-closed; second GL route disabled | No (P-R03) | No | n/a | n/a | n/a | n/a | n/a | n/a | n/a | BL-4 | B2 |
| F-PAY | Payroll | No | Partial (runs/approval/locking; calc broken) | n/a | — | NV | NV | NV | NV | NV | Phase B | — |
| F-FIN | Shared Finance Integration | Direction only (D-009) | No | n/a | No | n/a | n/a | n/a | n/a | n/a | Phase C | — |
| GOV-01 | Master documentation in `docs/hr/` | Yes (OWN-DOC) | Yes (2026-10-24) | n/a | n/a | n/a | n/a | n/a | n/a | n/a | Version-controlled: committed `8add030c` (D-020). Pushed: No (no upstream) | Owner decision on pushing `Enhancement03` |

## 2. Batch status

| Batch | Approved | Started | Code complete | Tests | Staging applied | Production applied | UAT | Deployed | Notes |
|---|---|---|---|---|---|---|---|---|---|
| B0 | Owner-directed | Yes | Code/schema assessment **completed** 2026-10-24 — [B0 report](assessments/HR_B0_ENVIRONMENT_VERIFICATION.md) (snapshot/document/replica evidence) | Diagnostic v2 replica-tested by the B0 session (no data) | **PENDING** (live diagnostic) | **PENDING** (live diagnostic) | n/a | n/a | v2 = canonical; v1 superseded |
| B1 | No | No | Migrations written | Replica suites per commits (not re-run) | **NOT VERIFIED** | **NOT VERIFIED** | — | — | Lifecycle #1–#5 absent from snapshots ≤ 2026-10-20 |
| B2 | No | No | — | — | — | — | — | — | Split into B2A/B2B (P-R11, proposed) |
| B2A | No | No | **NOT IMPLEMENTED** (planned; design P-R13) | — | — | — | — | — | Blocked by OD-B2A-1…7, PD-B2-10; staging also needs explicit grants + v2 on staging |
| B2B | No | No | **NOT IMPLEMENTED** (planned) | — | n/a (no migration) | n/a | — | — | Blocked by OD-B2B-1…3, BL-9 |
| B3 | No | No | — | — | — | — | — | — | Separate S&A dependency; after S&A finalization V2 merge; BL-11 baseline 25 compat-only staging users |
| B4a–B9 | No | No | — | — | — | — | — | — | |

## 4. B2 findings re-check (code and 2026-10-16 schema dumps only — not a live database check)

Consistent with the restored [B0 report](assessments/HR_B0_ENVIRONMENT_VERIFICATION.md) §1/§3 (SEC-1…3, payroll C, attendance E). The B0 report additionally found the payroll statutory-settings `config_key` drift and the correction-review self-approval gap (SEC-6).

Re-checked 2026-10-24 at HEAD `1e0830c6`. "Unchanged" = the relevant route file has no commit after the date shown; none changed since the B0 assessment HEAD.

| Finding (as reported in owner handover) | Batch | Re-check result |
|---|---|---|
| Leave submission on behalf of another employee | B2A | **Still present** — `hr_leave_requests_insert` checks same-org only; any `employee_id`/`status` accepted (prod dump 2026-10-16; no later migration) |
| Leave self-approval | B2A | **Still present** — update policy legacy branch admits `u.id = employee_id` |
| Organization-wide leave privacy | B2A | **Still present** — SELECT on requests and balances = same organization; mobile manager tab lists all org pending requests |
| Legacy compatibility / role-level HR access | B2A, B3 | **Still present** in leave policies (`role_level <= 20` / `<= 10` branches via `sa_rls_gate`); compat-policy grants not re-measured (needs live data) |
| Payroll false-success | B2B | **Still present** — `payroll/runs/[id]/calculate` inserts `employee_id` (column `employee_user_id`), reads `total_work_minutes`/`total_overtime_minutes` (columns `total_minutes`/`overtime_minutes`), logs line errors and returns success (unchanged since 2026-10-03) |
| Attendance correction review mismatch | B2B | **Still present** — writes `review_note`; column is `review_comment` (unchanged since 2026-09-27) |
| Timesheet generation mismatch | B2B | **Still present** — writes `total_days`, `total_work_minutes`, `total_overtime_minutes`; table has `total_minutes`, `overtime_minutes` (unchanged since 2026-09-27) |
| OT request API mismatch & self-approval | B2B | **Still present** — writes `ot_minutes_claimed`, `planned_start_time`, `approved_by`, `approver_remarks` (table: `ot_minutes`, `approver_id`, `approver_comment`); auto-approve records requester as approver; approve path has no requester ≠ approver check |
| Mobile Leave type query | B2B | **Still present** — `.eq('is_active', true)`; column is `status` |
| Duplicate payroll GL paths | B2B | **Still present** — `/api/hr/finance/post-payroll-run` → `hr_post_payroll_run_to_gl`; `/api/hr/payroll/post-to-gl` → `post_payroll_run_to_gl` |
| Public-holiday template | B2B | **Still present** — template rows carry `category` (no such column) |
| Mock Leave Approval Flow | B2B | **Still present** — `MockLeaveRepository` in `modules/hr/leave/repository.ts`; route `approval-flow` mapped |
| HR schema-contract tests | B2B | **Absent** — no HR column-contract test; `ci.yml` has no HR/migration check |
| Pending identity lifecycle migrations | B1 | Application status **NOT VERIFIED** (no new evidence; BL-2) |
| `app/.env.local` → shared staging | Ops | Points to a `*.getouch.cloud` Supabase host; staging vs production **not re-verified** (secrets not read) |

## 5. Owner-run B0 live diagnostic (instructions)

Script: [`docs/hr/assessments/hr_b0_environment_readonly_v2.sql`](assessments/hr_b0_environment_readonly_v2.sql) — verified 2026-10-24: complete (ends `rollback;`), one `begin transaction read only` block, no write/DDL statements, aborts unless `-v env` is given, `ON_ERROR_ROLLBACK on`, `statement_timeout 60s`, `lock_timeout 3s`, aggregates only. Not executed by Claude against any environment.

1. **psql only** (uses `\if`, `\set`, `\echo`) — not the Supabase web SQL editor.
2. Connect to the **application database `supabase`** of each environment with the owner/`postgres` role (must see all rows — check section R `role_sees_all = t`; if `f`, counts are false zeros: re-run with a bypass role).
3. **Staging first:**
   `psql "<staging connection>" -X -v env=staging -v ON_ERROR_STOP=0 -f docs/hr/assessments/hr_b0_environment_readonly_v2.sql > b0_staging_<YYYYMMDD>.txt 2>&1`
4. **Production, separately:**
   `psql "<production connection>" -X -v env=production -v ON_ERROR_STOP=0 -f docs/hr/assessments/hr_b0_environment_readonly_v2.sql > b0_production_<YYYYMMDD>.txt 2>&1`
   Optional extra guard: prefix with `PGOPTIONS='-c default_transaction_read_only=on'`. **Do not** use `ON_ERROR_STOP=1` (corrects the 2026-10-24 handover note): v2 isolates each failing statement and continues.
5. Check section I fingerprints (server address, `system_identifier`, data counts) match the declared environment and the PMS identity table; R shows `transaction_read_only = on`.
6. Return both output files; they are recorded here and in `PRODUCTION_MIGRATION_STATUS.md`.

**Limitations:** `effect_present` shows characteristic objects/markers only — **not** proof that a whole migration was applied or that bodies match the repository (D-018: hand-applied migrations may not appear in `supabase_migrations.schema_migrations`). Individual statements may fail for missing privileges (e.g. `pg_control_system`) without affecting others. Counts are point-in-time; shadow-parity depends on the traffic window. The script is git-ignored (BL-13, PD-GOV-02).

## 6. Change log

| Date | HEAD | Change |
|---|---|---|
| 2026-10-24 | `1e0830c6` | B0 evidence reconciliation: B0 assessment completed (evidenced); live diagnostics PENDING; B1 NOT VERIFIED; B2A/B2B planned, NOT IMPLEMENTED; B3 separate dependency; S-06.4 and S-08.1 corrected (BL-10); §5 rewritten for v2 (ON_ERROR_STOP=0). |
| 2026-10-24 | `1e0830c6` | Handover sync: B0 (repo assessment reported completed; live PENDING); B2A/B2B rows NOT IMPLEMENTED; §4 code re-check of B2 findings; §5 owner-run B0 instructions; S-12.2 note (BL-9). |
| 2026-10-24 | `8add030c` | GOV-01: committed; not pushed. |
| 2026-10-24 | `5d6c9bcb` | GOV-01 updated: tracking fix prepared, not committed. |
| 2026-10-24 | `5d6c9bcb` | Baseline created (assessed at `82da8cd0`; `5d6c9bcb` bulk-removal fix recorded). No status was inferred from commits; environment fields from PMS 2026-10-16 only. |
