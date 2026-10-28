# Serapod2U HR — Progress Tracker (baseline)

Last verified: 2026-10-26 · HEAD `b6b78002` (**Wave 2 + Wave 3 applied to staging by the owner 2026-10-25 and VERIFIED read-only 2026-10-26**; code uncommitted, not deployed; owner UAT **not performed**). Earlier: 2026-10-25 Wave 3 implemented. Earlier the same day: Wave 1 closure + Wave 2, uncommitted. Earlier: 2026-10-24 · HEAD `b6b78002` (B2A/B2B implementation, uncommitted) · back to [HR_MASTER_INDEX.md](HR_MASTER_INDEX.md)

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
| S-01.6 | Statutory & personal master data | Engineering (E-21, owner directive 2026-10-25); P-F09 still PROPOSED | **Yes (Wave 2)**: `hr_employee_statutory_profiles` + `hr_employee_profiles`, server-only, explicit HR | Replica PASS (P/F/G blocks); Vitest PASS | Yes `20261221100000` | **Yes** 2026-10-25 (owner); **VERIFIED read-only 2026-10-26** (§12, 26/26 bodies) | No | No | No | No | BL-24 | W-3 |
| S-01.7 | Employment history versions | Engineering (E-16, E-17) | **Yes (Wave 2)**: `hr_employee_versions`, as-of, History tab | Replica PASS (V/L/E/X/A/O) | Yes `20261221100000` | **Yes** 2026-10-25 (owner); **VERIFIED read-only 2026-10-26** (§12, 26/26 bodies) | No | No | No | No | BL-24 | W-3 |
| S-02.1 | Controlled Remove/Reset HR Registration | Yes (D-006) | Yes (commit `17c84ab7`) | Reported (baseline); Wave 2 compat re-run PASS (C3) | Yes `20261214100000` | **Effects present (KVM2 2026-10-25)**; not in PMS | **NV** | NV | NV | NV | BL-2 | B0 → B1 |
| S-02.2 | Canonical permanent identity deletion | Documented (`docs/identity/PERMANENT_IDENTITY_DELETION.md`); approval not recorded | Yes (`f5297467`) | NV (commit claims replica suite; not re-run) | Yes `20261216100000_identity_permanent_deletion` | NV | NV | NV | NV | NV | BL-2, duplicate version | B0 → B1 |
| S-02.3 | Bulk employee removal | Documented (`BULK_EMPLOYEE_REMOVAL.md`); approval not recorded | Yes (`82da8cd0`; serialized execution + bounded lock-conflict retry `5d6c9bcb`) | NV (unit/UI/API tests and isolated PG locking reproduction added in commits; not re-run) | n/a (no migration) | n/a (depends on S-02.2, S-03.1) | n/a | NV | NV | NV | Depends on B1 | B1 then UAT |
| S-03.1 | Archive & Revoke Access, identifier release | Yes (D-007, D-008) | Yes (`b9934f48`, `0df40475`) | NV (replica 75 asserts per commit; not re-run) | Yes `20261217100000`, `20261218100000` | NV | NV | NV | NV | NV | BL-2 | B0 → B1 |
| S-03.2 | Former Employees tab | Documented; approval not recorded | Yes (`94299cf9`) | NV | n/a | n/a | n/a | NV | NV | NV | Depends on S-03.1 migration | B1 UAT |
| S-03.3/.4 | Archive: reassignment, end dependent HR state | Engineering (E-19) for end effects; reassignment = explicit HR tool (E-20); PD-LC-02 open | **Partial (Wave 2)**: salary/allowance/deduction/position end at end date; reassign tool + reporting-line check; archive does not force reassignment | Replica PASS (X1–X8, A1–A4) | Yes `20261221100000` | n/a | n/a | n/a | n/a | n/a | PD-LC-02 | B7b |
| S-03.5 | Scheduled separation, last working date | No | No | n/a | No | n/a | n/a | n/a | n/a | n/a | PD-LC-01 | B7b |
| S-03.6 | Former-employee documents | No | No | n/a | No | n/a | n/a | n/a | n/a | n/a | PD-LC-03 | B7b |
| S-04.1/.3 | Departments, org charts | Documented | Yes | Reported (baseline) | n/a | NV | NV | NV | NV | NV | — | B9 UAT |
| S-04.2 | Position management V1.1 foundation | Documented (`POSITION_MANAGEMENT_V1.1.md`) | Partial (D3/D4/D6 UI gaps) | Reported (baseline) | Yes HR01–HR05 | Yes — PMS user-confirmed, verified 2026-10-13 | Yes — PMS catalog diff 2026-10-16 | NV | NV | NV | UI gaps | Scope decision; B8/B9 |
| S-04.4 | Single Departments/Positions entry | No (P-R10) | No | n/a | n/a | n/a | n/a | n/a | n/a | n/a | — | B8 |
| S-05.2 | Reporting-line reconciliation | Engineering (E-20); P-R08 PROPOSED | **Yes (Wave 2)**: review (incl. position divergence) + set/reassign with reason + log; manager validation guard | Replica PASS (R/S blocks); Vitest PASS | Yes `20261221100000` | n/a | n/a | n/a | n/a | n/a | — | B7a |
| S-05.3 | Additional-manager RLS | No | No | n/a | No | n/a | n/a | n/a | n/a | n/a | — | Not yet batched (candidate B7a) |
| S-06.1–.2 | Hybrid attendance, auto-validation | Yes — direction (D-011, D-012); detail = engineering defaults E-25…E-28 (PD-ATT-01/03/07/08 open) | **Yes (Wave 3)**: channels web/mobile/hr_manual/import/correction; database-owned writes (server time, guard); auto-validation + idempotent exception detection from existing policy/shift fields | Replica PASS (G/A/X blocks, 405 total); Vitest PASS | Yes `20261222100000` | **Yes** 2026-10-25 (owner); **VERIFIED read-only 2026-10-26** (§12) | No | No | No | No | BL-27, BL-28 | X-1…X-9 |
| S-06.4 | Timesheets (period summaries) | Documented | **Repaired in code (B2B)**: real columns; approved periods never regenerated | n/a | n/a | n/a | n/a | NV | NV | NV | BL-10 | B2B |
| S-07.1 | Mobile clock in/out (basic) | Documented | **Rewritten (Wave 3)**: through `/api/hr/attendance/clock` (server time; device time informational); history, corrections, OT on mobile (D3-2 fixed) | Replica A1–A10; component test `HrMobileAttendance.test.tsx` | Yes `20261222100000` | **Yes** 2026-10-25 (owner); **VERIFIED read-only 2026-10-26** (§12) | No | No | No | No | BL-27 | X-6/X-7 |
| S-07.2 | Mobile capture controls | Direction only | No (location/device/photo NOT implemented — PD-ATT-02 open; only server time + channel + device time recorded) | n/a | No | n/a | n/a | n/a | n/a | n/a | PD-ATT-02 | Owner decision |
| S-08.1 | Corrections with controlled approval | Yes — direction (D-013); approver default E-28 (PD-ATT-04 open) | **Yes (Wave 3)**: employee correction + missing day, HR adjustment (maker-checker), one pending per day/entry, originals + audit before/after, withdraw | Replica C1–C17; route tests | Yes `20261222100000` | **Yes** 2026-10-25 (owner); **VERIFIED read-only 2026-10-26** (§12) | No | No | No | No | BL-27, SA-R6 | X-6…X-9 |
| S-08.2 | HR manual attendance entry | Engineering E-29 (PD-ATT-04 open) | **Yes (Wave 3)**: reason, overlap/future/own-record refused, second-HR confirmation | Replica M1–M14; route tests | Yes `20261222100000` | **Yes** 2026-10-25 (owner); **VERIFIED read-only 2026-10-26** (§12) | No | No | No | No | BL-27, SA-R8 (2 HR people) | X-9 |
| S-09.1–.2 | Excel bulk attendance import | Engineering E-31 (PD-ATT-05 open) | **Yes (Wave 3)**: template, browser read, DB preview per row, commit with count, re-validation, SHA-256 once per company, never overwrites | Replica I1–I11; lib + component tests | Yes `20261222100000` | **Yes** 2026-10-25 (owner); **VERIFIED read-only 2026-10-26** (§12) | No | No | No | No | BL-27 | X-9 |
| S-10.1–.2 | Exception detection & review | Yes — direction (D-012); engineering E-27/E-28 (PD-ATT-03/06 open) | **Yes (Wave 3)**: 6 exception codes, idempotent, auto-cleared, HR queue + resolve (acknowledged/excused/dismissed/corrected), manager view; manager decision needs SA-R6 | Replica X1–X16 | Yes `20261222100000` | **Yes** 2026-10-25 (owner); **VERIFIED read-only 2026-10-26** (§12) | No | No | No | No | BL-27, SA-R6, no scheduler | X-9 |
| S-11.1 | OT separate from attendance | Yes (D-014) | **Yes (Wave 3)**: own lifecycle, linked to attendance, flags only | Replica O-block | Yes `20261222100000` (columns) | **Yes** 2026-10-25 (owner); **VERIFIED read-only 2026-10-26** (§12) | No | No | No | No | BL-27 | X-9 |
| S-11.2 | OT request API working, no self-approval | Yes (D-030) | **Yes (Wave 3, supersedes B2B route)**: database functions; RLS gap closed (employee could approve own OT by direct update — D3-3) | Replica O1–O22, negative control N2; route tests | Yes `20261222100000` | **Yes** 2026-10-25 (owner); **VERIFIED read-only 2026-10-26** (§12) | No | No | No | No | BL-27 | X-9 |
| S-11.3/.4 | Approved OT as payroll source; MSS OT approval | Engineering E-33/E-34 (PD-OT-01…03 open) | **Partial (Wave 3)**: `approved_minutes` + `payroll_consumed_ref` slot (no consumption, no rates); manager approval path ready but needs `hr.mss.overtime_approve` (SA-R7) | Replica O8/O20 | Yes `20261222100000` | **Yes** 2026-10-25 (owner); **VERIFIED read-only 2026-10-26** (§12) | No | No | No | No | PD-OT-*, SA-R7 | Phase B / S&A |
| S-12.1 | Leave containment (RLS) | Yes (D-021…D-028) | **Implemented (B2A migration created, replica PASS)**; live defect remains until applied | n/a | No | n/a | n/a | n/a | n/a | n/a | BL-3 | B2 |
| S-12.2 | ESS leave form type list | n/a (defect) | **Repaired in code (B2A/B2B)**: `status = 'active'`; approval sends status only; errors mapped — not deployed | n/a | n/a | n/a | n/a | n/a | n/a | n/a | — | B2 |
| S-12.3–.7 | Leave workflow, ledger, entitlements, holidays, unpaid days | Engineering E-35…E-41 (P-R04 direction; PD-LV-01…04 open) | **Partial (Wave 3)**: append-only ledger + projection, opening balance (available unchanged), DB working days + state holidays, overlap + balance checks, HR entitlement/adjust/runs (type config), carry-forward (no expiry), unpaid-days read; B2A still decides transitions; no multi-level chain/delegation/encashment | Replica L0–L32, BA1–BA9, B0–B9, RS7 | Yes `20261223100000` | **Yes** 2026-10-25 (owner); **VERIFIED read-only 2026-10-26** (§12) | No | No | No | No | BL-27, PD-LV-*, PD-SA-01 | X-9 |
| S-13.1 | ESS | Documented | Yes; Wave 3: attendance history/corrections/OT and leave quote on mobile | Reported (baseline); Wave 3 component tests | Yes (`20261106100000` profile edit) | Yes — PMS verified 2026-10-13 | Yes — PMS catalog diff 2026-10-16 | NV | NV | NV | BL-27 (Wave 3 parts) | X-9 |
| S-13.2 | MSS read & compensation viewer | Documented (`docs/security/ESS_MSS_*`) | Yes | Reported (baseline) | Yes `20261103…20261105` | Yes — PMS 2026-10-13 | Yes — PMS (20261103/04 owner-reported after D-1 fix; 20261105 verified) | NV | NV | NV | Independent re-check pending (PMS) | B0 re-check |
| S-13.3 | MSS actions (leave/OT/exception approval) | Partial: leave via B2A (D-022); OT/attendance per E-28/E-34 | **Partial (Wave 3)**: mobile Approvals tab for whatever the database lets the person decide; manager OT/attendance decisions wait for SA-R6/SA-R7 | Replica X13/C10/O8 (synthetic keys) | Yes `20261222100000` | **Yes** 2026-10-25 (owner); **VERIFIED read-only 2026-10-26** (§12) | No | No | No | No | SA-R6, SA-R7 | S&A |
| S-14.1 | Performance & KPI | Documented | Yes | Reported (baseline) | (earlier migrations) | NV | NV | NV | NV | NV | — | B9 UAT |
| S-15.1 | Commission | Documented (`STAFF_COMMISSION.md`) | Yes | Reported (`STAFF_COMMISSION.md` + baseline) | Yes `20261102110000`, `20261102120000` | Yes — PMS 2026-10-13 | Yes — PMS catalog diff 2026-10-16 | NV | NV | NV | — | B9 UAT |
| S-15.2 | Commission → payroll consumer | No (P-F10) | No | n/a | No | n/a | n/a | n/a | n/a | n/a | Phase B | Phase B |
| S-16.1–.5 | Navigation & reporting fixes | No (P-R10) | Partial (Wave 3): attendance period report + CSV, leave balance overview inside existing destinations (no nav change, E-43) | Replica R4/R5 | n/a | n/a | n/a | n/a | n/a | n/a | SA-R11 | B8 |
| S-17.1 | S&A as authority (architecture) | Yes (D-004) | Partial | Reported (baseline: 90 S&A tests) | Yes (S&A waves) | Yes (PMS) | Yes (PMS) | NV | NV | NV | Prod modes NV since 2026-10-02 | B0 |
| S-17.2–.6 | HR S&A consolidation | No (P-R05..07); S-17.3 HR-owned part done (E-24) | **S-17.3 partial (Wave 2)**: 32 `() => true` removed; 14 inline role-level legacy evaluators remain (SA-R5) | n/a | Partial (`20261215110000`, `20261216100000_sa_legacy_preview…` untracked) | NV | NV | n/a | n/a | n/a | PD-SA-01/02 | B1 (controls), B3 |
| S-18.2–.8 | Finance-ready data items A1–A7 | Engineering (E-22, E-23); P-F02/P-F09 PROPOSED | **Partial (Wave 2)**: A1 versions + `cost_center_ref` slot, A2 overlap guard + log, A3 `payroll_component_code` slot, A4 statutory capture, contract view v1; A5–A7 open | n/a | No | n/a | n/a | n/a | n/a | n/a | Owner decisions | B6, B7b–d |
| S-18.9 | Payroll fail-closed; second GL route disabled | Yes (D-029) | **Yes in code (B2B)**: fail-closed calculate, approval blocked until certified, `/api/hr/finance/post-payroll-run` 410 — not deployed | n/a | n/a | n/a | n/a | n/a | n/a | n/a | BL-4 | B2 |
| F-PAY | Payroll | No | Partial (runs/approval/locking; calc broken) | n/a | — | NV | NV | NV | NV | NV | Phase B | — |
| F-FIN | Shared Finance Integration | Direction only (D-009) | No | n/a | No | n/a | n/a | n/a | n/a | n/a | Phase C | — |
| GOV-01 | Master documentation in `docs/hr/` | Yes (OWN-DOC) | Yes (2026-10-24) | n/a | n/a | n/a | n/a | n/a | n/a | n/a | Version-controlled: committed `8add030c` (D-020). Pushed: No (no upstream) | Owner decision on pushing `Enhancement03` |

## 2. Batch status

| Batch | Approved | Started | Code complete | Tests | Staging applied | Production applied | UAT | Deployed | Notes |
|---|---|---|---|---|---|---|---|---|---|
| B0 | Owner-directed | Yes | Code/schema assessment **completed** 2026-10-24 — [B0 report](assessments/HR_B0_ENVIRONMENT_VERIFICATION.md) (snapshot/document/replica evidence) | Diagnostic v2 replica-tested by the B0 session (no data) | **PENDING** (live diagnostic) | **PENDING** (live diagnostic) | n/a | n/a | v2 = canonical; v1 superseded |
| B1 | Owner directive 2026-10-25 (Wave 2) | Yes | Migrations written; Wave 2 lifecycle code on top | Replica: B2A suite `--lifecycle`/`--lifecycle-after` PASS 195/195; Wave 2 suite both orders PASS | **Effects present (KVM2 2026-10-25)** | **NOT VERIFIED** | — | — | Not recorded in PMS (BL-2) |
| Wave 2 | Owner directive 2026-10-25 | Yes | **Yes** (uncommitted) | Replica 235 / 235 (`--w2-first`) / 192 (prod, `--no-lifecycle`) / negative control 7; Vitest **6,677 pass / 1 fail (non-HR, pre-existing `orders/[orderId]/ship-metrics`)** / 6 skipped, 676 files; tsc **0 errors in HR files**; 250 pre-existing errors in 83 non-HR files (unchanged) | **Yes** 2026-10-25 (owner); **VERIFIED read-only 2026-10-26** (§12: 26/26 bodies = repository, 13 triggers, compensation overlap 0) | No | **No** | **No** | §10, §11 |
| B2 | No | No | — | — | — | — | — | — | Split into B2A/B2B (P-R11, proposed) |
| B2A | Code + tests: Yes (OWN-IMPL) | Yes | **Yes** (uncommitted) | Replica: **PASS** 172 (prod snapshot), 172 (staging snapshot), 195 + lifecycle (both B1/B2A orders); re-run 2026-10-25 PASS | Migration created `20261219100000`; staging: **applied 2026-10-24 (owner); VERIFIED read-only 2026-10-25 (12/12)** — approver coverage gap BL-23 | **No (not authorized)** | **No** | **No** (BL-21) | Wave 1: replica re-run PASS; web view fixes; grants coverage NOT VERIFIED (BL-11) |
| B2B | Code + tests: Yes (OWN-IMPL) | Yes | **Yes** (uncommitted) | Wave 1: real Vitest full suite 6,553 pass / 1 non-HR fail; full tsc 0 HR errors; build NOT RUN (BL-15) | n/a (no migration) | n/a | **No** | **No** (BL-21) | — |
| B3 | HR-owned part under the 2026-10-25 directive | Yes | Partial (E-24) | `b3-legacy-evaluators.test.ts`, route-coverage PASS | n/a | n/a | No | No | S&A-owned remainder: [handover](release/wave2-employment-foundation-2026-10-25/HR_SA_DEPENDENCY_HANDOVER_WAVE2.md) |
| B4a/B4b/B4c | Owner directive 2026-10-25 (Wave 3) | Yes | **Yes** (uncommitted) — engineering defaults E-25…E-32 | Replica 405 (stg) / 362 (prod); Vitest PASS | **Yes** 2026-10-25 (owner); **VERIFIED 2026-10-26** (§12) | No | No | No | §11 |
| B5 | Owner directive 2026-10-25 (Wave 3) | Yes | **Yes** (uncommitted) — E-33/E-34 | included | **Yes** 2026-10-25 (owner); **VERIFIED 2026-10-26** (§12) | No | No | No | §11 |
| B6 | Owner directive 2026-10-25 (Wave 3) | Yes | **Partial** (ledger, working days, entitlement admin; no chains/delegation/encashment) — E-35…E-41 | included | **Yes** 2026-10-25 (owner); **VERIFIED 2026-10-26** (§12) | No | No | No | §11 |
| B7b, B8, B9 | No | No | — | — | — | — | — | — | |

## 4. B2 findings re-check (code and 2026-10-16 schema dumps only — not a live database check)

Consistent with the restored [B0 report](assessments/HR_B0_ENVIRONMENT_VERIFICATION.md) §1/§3 (SEC-1…3, payroll C, attendance E). The B0 report additionally found the payroll statutory-settings `config_key` drift and the correction-review self-approval gap (SEC-6).

**Status update 2026-10-24 (B2A/B2B implemented, HEAD `b6b78002`, uncommitted):** every B2A and B2B row below is **fixed in code** with tests (§7); in staging and production the findings remain **present until the migration is applied and the build deployed**. Identity lifecycle migrations and the `.env.local` finding are unchanged.

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

## 7. B2A/B2B implementation evidence (2026-10-24, HEAD `b6b78002`, uncommitted)

**Database (B2A)** — `supabase/migrations/20261219100000_hr_leave_containment_guard.sql` (created; NOT applied anywhere).
Replica suite `supabase/tests/security/hr_leave_containment/` (`run.sh`, `build_replica_from_snapshot.sh`, `05…50`), executed on disposable PostgreSQL 16 built from the committed snapshots (no staging/production connection):

| Scenario | Result |
|---|---|
| Production snapshot 2026-10-16: negative control → migration ×2 (idempotent) → after → safe rollback → after | **PASS** (172 checks) |
| Staging snapshot 2026-10-16: same | **PASS** (172) |
| Staging snapshot + lifecycle 20261214…20261218 **before** B2A + compatibility (real `hr_reset_execute`/`hr_reset_restore`, `hr_employee_registration_execute`, `identity_deletion_execute`, `identity_archive_execute`) | **PASS** (195) |
| Same with lifecycle **after** B2A | **PASS** (195) |
| Negative control proves SEC-1…SEC-4 exist before the fix | **PASS** (6 holes reproduced) |

Defects found and fixed by these tests before declaring code-ready: status CHECK broke restore (E-01); archived account with live token could submit (E-03); identity deletion would have blocked on an `actor_id` column (E-02, designed out).
Not reproduced on the replica: Supabase-specific grants/REVOKEs (emulated defaults), GoTrue behaviour, real data volumes. The identity workstream's own replica suites could not run here (they need the staging configuration dump) — they failed identically **with and without** B2A, so they gave no signal.

**Application (B2A + B2B)** — modified: `components/hr/mobile/HrMobileLeave.tsx` (on top of the owner's type alignment), `modules/hr/leave/supabaseRepository.ts`, `modules/hr/hrNav.ts`, `modules/hr/hrNav.test.ts`, `components/hr/modules/HrLeaveApprovalFlowView.tsx` (mock removed), `components/hr/modules/HrPayrollPayslipsView.tsx`, `lib/api/payroll.ts`, `api/hr/payroll/runs/route.ts`, `api/hr/payroll/runs/[id]/calculate/route.ts`, `…/[id]/approve/route.ts`, `api/hr/payroll/statutory-settings/route.ts`, `api/hr/accounting/preview-journal/route.ts`, `api/hr/finance/post-payroll-run/route.ts` (410), `api/hr/attendance/corrections/[id]/review/route.ts`, `api/hr/attendance/timesheets/route.ts`, `api/hr/attendance/overtime/requests/route.ts`, `api/hr/attendance/overtime/preview/route.ts`, `api/hr/public-holidays/route.ts`, `api/hr/config/audit/route.ts`; `.gitignore` (D-032). New: `modules/hr/leave/leaveErrors.ts`, `lib/hr/payroll-calculation.ts`, `lib/hr/attendance-repairs.ts`, `lib/hr/schema-contract.ts`, `lib/hr/test-support/fakeSupabase.ts` and tests (`leaveErrors`, `payroll-calculation`, `attendance-repairs`, `schema-contract`, `migration-versions`, `b2b-retired-and-holidays`, route tests for calculate, approve, correction review, OT requests, timesheets). **All `*.test.ts` and `supabase/tests/**` files need `git add -f`** (BL-16).

| Test set (offline Vitest-compatible runner on the device shell; Supabase env forced to a dead local URL) | Result |
|---|---|
| New B2A/B2B tests (12 files) | **75 PASS / 0 FAIL** |
| Existing HR API/lib/nav tests incl. `route-coverage`, `nav-access` (S&A), `hr-data-catalog`, `pages.access` | **PASS** (all non-component suites) |
| Existing jsdom component suites (HrPeopleView ×5, workspace ×3, HrLandingView) — components NOT changed | **Not executable here** (runner fidelity) — run on the Mac |
| `tsc` (strict, project tsconfig) over the 36 changed/new files + 795 transitively imported files | **0 errors** (targeted; full-project `npx tsc --noEmit` exceeded the 3-minute shell limit — run on the Mac) |
| Real Vitest (`npm test`) | **NOT RUN** (BL-15) |

Contract test baseline (BL-17): `lib/server/hr/assistant/tools.ts` 8 non-existent columns; 3 missing tables. Additional defects found by it and fixed in B2B: payroll run creation (`name`, `employee_count`), OT preview (`work_minutes`), `enable_overtime_ea1955` seed.

## 8. Wave 1 evidence (2026-10-24, HEAD `b6b78002`, uncommitted)

**Environment isolation:** tests ran in the cloud workspace on a copy of the working tree (no `.env*` files copied); Supabase variables forced to `http://127.0.0.1:9` and dummy keys. No connection to staging or production. Mac `node_modules` reused; Linux esbuild 0.28.2 swapped in and Rollup's native parser replaced by acorn **in the copy only** (Vite SSR transform) — harness limitation, not a code change.

| Check | Result |
|---|---|
| Real Vitest 3.2.7, HR folders (`src/lib/hr`, `src/modules/hr`) | **110 / 110 PASS** (before Wave 1 fixes) |
| Real Vitest full suite (663 files, incl. jsdom component suites HrPeopleView, workspace, HrLandingView) | **6,553 PASS, 1 FAIL, 6 skipped** — the failure is non-HR (`orders/[orderId]/ship-metrics`, view missing in snapshot; BL-22) |
| Wave 1 new tests (`supabaseRepository.test.ts` 6, `HrLeaveRequestsView.decisions.test.tsx` 4) + `leaveErrors` 6 | **16 / 16 PASS**; negative control: all 4 view tests **fail on the pre-Wave-1 view** |
| Full `tsc --noEmit` (whole app) | **0 errors in HR files**; 250 pre-existing errors in 83 non-HR files (identical file set before and after Wave 1) |
| `next build` | **NOT RUN** — needs native SWC; registry unreachable (BL-15) |
| Replica `hr_leave_containment` (PG 16): prod snapshot / staging snapshot / `--lifecycle` / `--lifecycle-after` | **PASS 172 / 172 / 195 / 195** |
| Post-apply and coverage SQL on replicas | Run cleanly (only the expected missing `supabase_migrations` ledger error) |
| Live staging (KVM2) | **NOT VERIFIED** — not reachable (BL-18); owner package ready |

**Defects fixed in Wave 1** (B2A scope, web leave screen `HrLeaveRequestsView.tsx` + repository):
1. Decision errors were unhandled (no message; dialog stuck) and submission errors only logged → explicit success / "Decision not saved" / "not submitted" toasts with the guard's message; success shown only when the **stored** status equals the requested one.
2. Approve/Reject offered on the viewer's own pending request → hidden (DB still refuses).
3. A legacy status value (e.g. `Approved`, frozen by the guard) crashed the list (`STATUS_CONFIG[...]` undefined) → rendered with a neutral badge.
4. Approval-history insert result was ignored → decision kept (already stored and audited) but the response carries `approvalStepRecorded: false` and the toast says so.
5. Employment organization ≠ home organization: refusal now explains the cause (BL-19); the DB rule itself is unchanged (P-R14).

Files: modified `components/hr/modules/HrLeaveRequestsView.tsx`, `modules/hr/leave/{supabaseRepository,leaveErrors,types}.ts`; new `modules/hr/leave/supabaseRepository.test.ts`, `components/hr/modules/HrLeaveRequestsView.decisions.test.tsx` (`git add -f`, BL-16); new `docs/hr/release/b2a-staging-2026-10-24/` (README, two SQL, one `.sh` — `.sh` needs `git add -f`).

## 9. Wave 1 closure (2026-10-24, HEAD `b6b78002`, uncommitted)

| # | Check | Result |
|---|---|---|
| C1 | HEAD / working tree | `b6b78002`, no commits; HR changes + concurrent non-HR changes (`DashboardContent.tsx`, `lib/navigation/`) — non-HR excluded from manifest |
| C2 | Native `npm test` / `tsc` / `build` **on the Mac** | **NOT RUN by the AI session** (no native Mac execution available) — owner runs `release/b2a-staging-2026-10-24/local_verify_isolated.sh` |
| C3 | Vitest 3.2.7 full suite, current tree, isolated (dead Supabase/DB URLs, no `.env*`) | **PASS for HR** — 6,572 pass / **1 fail (non-HR, pre-existing)** / 6 skipped (666 files) |
| C4 | Full `tsc --noEmit`, current tree | **PASS for HR** — 0 errors in HR files; 250 pre-existing errors in 83 non-HR files (unchanged set) |
| C5 | `next build` | **NOT RUN** (native SWC; BL-15) |
| C6 | B2A/B2B tests after fixes (HR folders + `app/api/hr`) | **PASS** 283 / 283 (45 files) |
| C7 | Leave approval false success (web + mobile) | **PASS** — fixed and covered by tests that fail on the old view |
| C8 | Replica security suites (PG 16, 4 modes) | **PASS** 172 / 172 / 195 / 195 (Wave 1, migration unchanged since) |
| C9 | Release scripts review | **PASS after hardening** — see release README; KVM2 script exercised end-to-end against a local replica via mocked ssh/docker |
| C10 | Trackability of new HR files | **PASS with `git add -f`** for 13 `*.test.ts`, the `.sh` scripts (`*.sh`) and `supabase/tests/security/hr_leave_containment/*` (`**/tests/**`); everything else trackable as is |
| C11 | P-R14 needed now? | **No** — by design (BL-19 reclassified) |
| C12 | Live staging migration effects / UAT | **NOT VERIFIED / NOT PERFORMED** (BL-18) |

## 10. Wave 1 closure + Wave 2 evidence (2026-10-25, HEAD `b6b78002`, uncommitted)

Isolation: cloud copy of the working tree without `.env*`; Supabase/DB URLs forced to `127.0.0.1:9`; disposable PostgreSQL 16 replicas built from the 2026-10-16 snapshots. Coder AI made **no** connection to staging/production. Harness only (never shipped): Linux esbuild 0.28.2 and an acorn-backed Rollup parser substitute in the copy's `node_modules`; `next build` not runnable (native SWC, BL-15).

| # | Check | Result |
|---|---|---|
| W1 | `hr-closure.zip` (Wave 1 closure package) | **Was not applied** — applied 2026-10-25 on the Mac (4 release files + `hr_docs_closure_update.py`, all anchors matched) |
| W2 | KVM2 owner run `out-20261025-001019` | Read: B2A **verified on staging** (M00–M11 PASS); B1 effects present; deployed app lacks Wave 1 markers; approver gap (BL-23) |
| W3 | B2A replica re-run (prod / stg / `--lifecycle` / `--lifecycle-after`) | **PASS 172 / 172 / 195 / 195** |
| W4 | Wave 2 replica `hr_employment_foundation` (stg default / `--w2-first` / prod `--no-lifecycle` / `--negative-control`) | **PASS 235 / 235 / 192 / 7** (incl. B2A after-tests and B2A lifecycle compatibility with Wave 2 installed; safe rollback + re-apply) |
| W5 | Vitest full suite (667+ files) | **6,677 pass / 1 fail (non-HR, pre-existing `orders/[orderId]/ship-metrics`)** / 6 skipped, 676 files |
| W6 | `tsc --noEmit` (whole app) | **0 errors in HR files**; 250 pre-existing errors in 83 non-HR files (unchanged) |
| W7 | Mobile leave defects found and fixed | (1) half-day always refused (`half_day_period` missing vs `hr_leave_requests_half_day_chk`); (2) decision success shown without checking the stored status; (3) submission success without the stored row; (4) MSS-only managers had no Approvals tab; (5) read errors shown as an empty screen — tests fail on the old component (negative control) |
| W8 | Verification script | `local_verify_isolated.sh` produced 24 false Vitest failures (cron/site variables) — fixed (BL-25) |
| W9 | Post-apply SQL `hr_w2_staging_post_apply_readonly.sql` | Runs cleanly on a replica inside a read-only transaction |
| W10 | Live staging Wave 2 / UAT | **NOT APPLIED / NOT PERFORMED** (not authorized) |

## 11. Wave 3 evidence (2026-10-25, HEAD `b6b78002`, uncommitted)

Isolation: cloud copy of the working tree (no `.env*`), Supabase/DB URLs forced to `127.0.0.1:9`; disposable PostgreSQL 16 replicas from the 2026-10-16 snapshots; Coder AI made **no** staging/production connection (KVM2 unreachable from both AI shells — same as BL-18).

| # | Check | Result |
|---|---|---|
| W3-1 | Wave 2 baseline replica at session start | PASS 235/235 |
| W3-2 | `hr_attendance_overtime/run.sh` staging snapshot (lifecycle → B2A → W2 → **W3A → W3B** → re-apply ×2 → W2 behaviour with W3 → W3 behaviour → B2A + W2 lifecycle compatibility with W3 → HR reset/restore → safe rollback → re-apply) | **PASS 405 checks** |
| W3-3 | Same, production snapshot `--no-lifecycle` | **PASS 362 checks** |
| W3-4 | Negative control (without Wave 3): employee writes own attendance time, approves own OT by direct update, weekend leave accepted | **3/3 reproduced** (N1–N3) |
| W3-5 | HR reset/restore with Wave 3 tables | attendance, ledger, OT, exceptions restored **byte-identical** (RS6–RS9); guard never blocks maintenance |
| W3-6 | Vitest **full suite** (679 files) | **6,717 pass / 1 fail / 6 skipped** — the failure is the known non-HR `orders/[orderId]/ship-metrics` (BL-22); 1 non-HR file not loadable in the harness (`stock-transfer-hq-readiness` reads `docs/runbooks/…`, not copied to the isolated workspace). HR scope incl. all new Wave 3 tests PASS. Negative control: the new `HrMobileAttendance.test.tsx` fails 5/5 on the pre-Wave-3 component |
| W3-7 | Full `tsc --noEmit` (final tree) | **0 errors in HR files**; 250 pre-existing errors in 83 non-HR files (identical to the Wave 1/2 baseline). The first run found 3 errors in the new `HrAttendanceOperationsView.tsx` — fixed |
| W3-8 | Route coverage gate (`route-coverage.test.ts`) with the 11 new routes | PASS |
| W3-9 | Error-message completeness (every `raise exception` code of both migrations mapped) | PASS (`wave3-lib.test.ts`) |
| W3-10 | KVM2 script `kvm2_hr_w2_w3_readonly.sh` | rehearsed with mocked ssh/docker against the replica (only the expected missing-ledger error) |
| W3-11 | `next build` | NOT RUN (native SWC; owner X-2) |
| W3-12 | Live staging Wave 2 verification / Wave 3 apply / UAT | Verification + apply: **done → §12**. UAT: **NOT PERFORMED** (owner X-9) |

W3-SEC-03 (direct-write refusal) is proven by replica tests G1–G4, G3b and RS10; the owner UAT does not need a console step for it.

## 12. Wave 2 + Wave 3 staging verification (2026-10-26, read-only, owner-run `kvm2_hr_w2_w3_readonly.sh`, output `out-w2w3-20261025-195856`)

The owner applied `20261222100000_hr_hybrid_attendance_overtime.sql` and `20261223100000_hr_leave_ledger.sql` to KVM2 staging on 2026-10-25 (after Wave 2 `20261221100000`). Coder AI read the diagnostic output; it did **not** connect to staging and wrote nothing there.

| # | Check (file) | Expected | Result |
|---|---|---|---|
| V-1 | Wave 2 function bodies = repository (05 A1) | 26/26 | **PASS** 26/26 |
| V-2 | Wave 2 triggers, append-only, grants, history without user FKs (04, 05 A2/A3) | as listed | **PASS** (13 triggers, 39 baselines, compensation overlap 0, no history→user FK) |
| V-3 | Wave 3 function bodies = repository (07 §1) | 61/61 `body_matches_repo = t`, definer flags as listed | **PASS** 61/61 |
| V-4 | Grants: `authenticated` executes only `hr_leave_w3_check` + trigger fn `hr_leave_requests_w3_quote`; `service_role` only entry points | as listed | **PASS** |
| V-5 | Triggers (07 §2) | 7 rows `O` | **PASS** 7/7 |
| V-6 | Sealed tables (07 §3) | RLS + forced, no API-role privileges | **PASS** 5/5 |
| V-7 | Reset scope (07 §4) | 5 rows | **PASS** 5/5 |
| V-8 | Attendance backfill (07 §5) | `entries_without_work_date = 0` | **PASS** (0 of 0 — staging had no attendance entries) |
| V-9 | Leave opening balance (07 §6) | marker `t`, projection mismatches 0, duplicate keys 0, approved without taken line 0 | **PASS** |
| V-10 | B2A intact (06, 07 §7) | 6 b2a policies / 0 others, guard + recorder `O` | **PASS** 6/0 |
| V-11 | `08_sql_errors.txt` | only the missing `supabase_migrations` ledger | **PASS** (expected only) |
| V-12 | `03_build_markers.txt` | — | cloudflared container `sh: not found` = Docker shell noise (not HR). Deployed app = **old build** (no Wave 2/3 markers) → finding F-1 |

Findings (not failures of the migrations):

| # | Finding | Impact | Owner action |
|---|---|---|---|
| F-1 | Staging app is the pre-Wave-2 build; after Wave 3A its direct attendance/OT writes are refused by the guard | Staging UI cannot record attendance/OT → **UAT runs on localhost** (working tree, same staging DB) | Deploy only after commit (X-4/X-7) |
| F-2 | 0 explicit holders of `hr.attendance.manage`, `hr.leave.approve`, `hr.mss.*` (13 legacy-compat only; 2 Root grants); ESS `hr.self_service.use` 28 explicit | Only Root can act as HR/manager | S&A grants per [UAT §1.3](uat/HR_WAVE3_UAT.md) (not done by Coder AI) |
| F-3 | `hr.mss.attendance_approve`, `hr.mss.overtime_approve`, `hr.leave.manage`, `hr.leave.view` not in catalogue | Managers cannot decide exceptions/OT (by design until SA-R6/SA-R7) | S&A |
| F-4 | 0 active leave types, 0 active shifts, 1 attendance policy, 0 work states | Leave cannot be requested; no shift-based lateness | Owner configuration per UAT §1.2 |
| F-5 | 1 holiday labelled `WP` never matched a state | Holiday counted as working day for WP staff | Optional `20261224100000_hr_w3_wp_holiday_alias.sql` (E-47), or relabel the holiday |
| F-6 | WH001: 4 onboarded employees without a manager | MSS scenarios need a test employee with a manager | Assign a manager to the test employees |

Mac native verification (owner, 2026-10-26): Vitest **6,721 pass / 1 fail (known non-HR ship-metrics, BL-22) / 6 skipped** → PASS for HR; `npm run build` **PASS (exit 0)**; full `tsc --noEmit` **CRASHED (exit 134, V8 heap out of memory) → NO RESULT, not a pass**. `local_verify_isolated.sh` now runs tsc with an 8 GB heap and reports a crash explicitly; re-run required. Coder AI isolated tsc on the same tree: 0 HR errors, 250 known non-HR errors in 83 files (reference only, does not replace the Mac run).

Coder AI (isolated, 2026-10-26) after adding E-47: replica suite **411/411 PASS**; HR Vitest (`src/lib/hr`, `src/app/api/hr`) 38 files / 286 tests PASS.

## 13. Wave 1–3 UI/UX completion & localhost-UAT readiness (2026-10-26 / 2026-10-27, HEAD `b6b78002`, uncommitted)

Report: [release/ui-ux-completion-2026-10-26/README.md](release/ui-ux-completion-2026-10-26/README.md) (feature→UI map, changes, deferred items, WP recommendation, setup checklist, top-10 scenarios, blockers). Manifest: [Wave 3 README §9a](release/wave3-attendance-overtime-leave-2026-10-25/README.md).

| Field | Status |
|---|---|
| Design approved | Owner directive "Wave 1–3 UI/UX completion" (2026-10-26) + "final writeback" (2026-10-27) — UI only, no new architecture |
| Code implemented | **Yes** (uncommitted). Navigation: Attendance → *Attendance Operations* (tabs Operations · Policy & shifts · My clock-in, `?tab=` deep links), *Timesheets*, **Public Holidays** (new page); Leave → *Leave Requests & Approvals*, **Balances & Entitlements** (`?tab=balances`), *Leave Types*. New UI actions: withdraw own pending leave (web + mobile), HR cancel approved leave, effective-dated employment change (HR Profile → History), own employment history (My Workspace), work state (HR Profile → ID & Tax), holiday *Applies to* (state / territory), company-wide run Apply separated from preview (reason + owner-authorization confirmation) |
| Writeback | 2026-10-27: the 14 files missing after the 2026-10-26 disconnect restored from `hr-ui-ux-2026-10-26-writeback.zip` (paths validated; the 6 pre-existing targets were byte-identical to the session snapshot, i.e. no newer edits were overwritten). The 16 application files on the Mac are byte-identical (SHA-1) to the code the tests were run against |
| Tests passed | Isolated Linux copy of the working tree (Mac `node_modules` + Linux esbuild; no staging connection): HR/navigation/security/layout suites **138/139 files, 1,200/1,202 tests** — the 2 failures are `ReportingView.overview` (Reporting workstream). Full Vitest: **exit 1** — 6,722 pass / 3 fail (all Reporting) / 9 skipped; 5 inventory suites not loadable in the partial copy (harness). `tsc --noEmit` (6 GB heap) **completed, exit 2: 250 errors in 83 files, 0 in HR** (= baseline BL-22). Replica PG16: Wave 3 harness incl. WP1–WP12 **417/417** (stg), **374/374** (prod, `--no-lifecycle`) |
| Native Mac | **NOT RUN by Coder AI** — the AI's device shell is a Linux VM (no macOS binaries, no package registry, 3 GB RAM). `next build` not run anywhere (needs native SWC). Owner: `local_verify_isolated.sh` |
| Server-side gates (code review) | Attendance Operations APIs → database `hr.attendance.manage` (explicit); leave balances/admin → `hr_leave_assert_hr` = explicit `hr.leave.approve` in the target organization, **also for dry-run and apply**; apply additionally needs a reason (route + database) and `dry_run` defaults to true. The "owner authorization" checkbox is a UI safeguard only — any explicit leave administrator can apply through the API (E-39 design; governance, not a code defect). Profiles / employment change → database (`hr_assert_hr_manage`, no self-change). Public-holiday writes → `hrCan('hr.settings.manage', legacy role level ≤ 20)` — legacy evaluator still decides while that key is not in ENFORCE (pre-existing, S&A item, BL-36) |
| Migration | `20261224100000_hr_w3_wp_holiday_alias.sql` **PREPARED ONLY — not applied anywhere**; not needed before Leave UAT |
| Applied to staging / production | No change |
| Deployed | No |
| UAT | **Owner UAT pending** — guides updated: [Wave 1+2](uat/HR_WAVE1_WAVE2_COMPREHENSIVE_UAT.md), [Wave 3](uat/HR_WAVE3_UAT.md) (screen map, first-time setup, owner checklist) |

## 6. Change log

| Date | HEAD | Change |
|---|---|---|
| 2026-10-27 | `b6b78002` | §13 UI/UX completion: navigation (Attendance Operations, Public Holidays, Balances & Entitlements), new UI actions, 14 files restored from the writeback archive, isolated test/tsc results, gate review; owner UAT pending. |
| 2026-10-26 | `b6b78002` | Wave 2 + Wave 3 staging application VERIFIED read-only (§12); Wave 2/3 rows set to applied + verified; findings F-1…F-6; Mac tsc crash recorded as no result; E-47 WP alias correction prepared (not applied). UAT not performed. |
| 2026-10-25 | `b6b78002` | **Wave 3**: S-06.1–.2, S-07.1/.2, S-08.1/.2, S-09, S-10, S-11.x, S-12.3–.7, S-13.1/.3, S-16 rows; batch rows B4a–B6; Wave 2 staging owner-reported; §11 evidence. |
| 2026-10-25 | `b6b78002` | Wave 1 closure + Wave 2: S-01.6, S-01.7, S-02.1, S-03.3/.4, S-05.2, S-17.2–.6, S-18.2–.8 rows; batch rows B1, B2A, B3, Wave 2; §10 evidence. |
| 2026-10-24 | `b6b78002` | Wave 1 closure: §9 PASS/FAIL table. |
| 2026-10-24 | `b6b78002` | Wave 1: batch rows updated (staging owner-reported/unverified; deployment No); §8 evidence added. |
| 2026-10-24 | `b6b78002` | B2A/B2B implemented (code + isolated tests, uncommitted): batch rows, §4 statuses (fixed in code, open live), §7 evidence. S-06.4, S-08.1, S-11.2, S-12.1, S-12.2, S-16, S-18.9 updated. |
| 2026-10-24 | `1e0830c6` | B0 evidence reconciliation: B0 assessment completed (evidenced); live diagnostics PENDING; B1 NOT VERIFIED; B2A/B2B planned, NOT IMPLEMENTED; B3 separate dependency; S-06.4 and S-08.1 corrected (BL-10); §5 rewritten for v2 (ON_ERROR_STOP=0). |
| 2026-10-24 | `1e0830c6` | Handover sync: B0 (repo assessment reported completed; live PENDING); B2A/B2B rows NOT IMPLEMENTED; §4 code re-check of B2 findings; §5 owner-run B0 instructions; S-12.2 note (BL-9). |
| 2026-10-24 | `8add030c` | GOV-01: committed; not pushed. |
| 2026-10-24 | `5d6c9bcb` | GOV-01 updated: tracking fix prepared, not committed. |
| 2026-10-24 | `5d6c9bcb` | Baseline created (assessed at `82da8cd0`; `5d6c9bcb` bulk-removal fix recorded). No status was inferred from commits; environment fields from PMS 2026-10-16 only. |
