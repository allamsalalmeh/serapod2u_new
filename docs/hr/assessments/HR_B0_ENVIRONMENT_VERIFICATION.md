# HR Core — Batch B0 Environment Verification

Repository `serapod2u_dev` · branch `Enhancement03` · HEAD `1e0830c6` (unchanged throughout the assessment) · 2026-10-24 (MYT) · **read-only: no code, SQL, migration, S&A, documentation or Git change was made.**

Classification: **VERIFIED** · **NOT VERIFIED** · **BLOCKED** · **OUTDATED** · **OWNER ACTION REQUIRED**.
Evidence types: **[code]** repository at HEAD · **[snapshot]** schema dumps of 2026-10-16 (prod + staging) / 2026-10-20 (`current_schema.sql`) · **[PMS]** `PRODUCTION_MIGRATION_STATUS.md` (last updated 2026-10-16) · **[stg-audit]** `docs/security/sa-finalization-v2/read-only-audit.json` (staging read-only, 2026-10-23) · **[replica]** throwaway local PostgreSQL 16 loaded from the production snapshot (structure only, no data; destroyed after use).
**No live staging or production database was queried.** Everything labelled "environment" below is snapshot or document evidence, not a live reading.

---

## 0. Shared-branch state

| Item | Finding | Class |
|---|---|---|
| Branch / HEAD | `Enhancement03` / `1e0830c6` (docs commits); last code commit `5d6c9bcb` (identity bulk removal) | VERIFIED |
| Working tree | 83 uncommitted paths, **none HR-owned**: S&A finalization V2 (21 `lib/security-access`, 12 S&A components, S&A API routes), system logs, payment gateway, cron lease, e-commerce, identity tests, 7 untracked migrations, `.gitignore` S&A allowlist hunk | VERIFIED |
| HR files changed since the assessment base `82da8cd0` | only `api/hr/employees/bulk-removal/route.ts` (identity workstream) | VERIFIED |
| B2 target files with uncommitted changes | **none** | VERIFIED |
| `app/.env.local` | points at **shared staging** — any localhost run of HR features reads and writes staging data | VERIFIED [stg-audit UAT_RESULTS.md] |

---

## 1. B0 Environment Verification Matrix

| Area | Item | Code evidence | Environment evidence | Class |
|---|---|---|---|---|
| A | Lifecycle migrations 20261214/16/17/18 applied? | App calls their functions (10 RPCs) | Functions absent from all snapshots (≤ 2026-10-20); commit messages say "UNAPPLIED"; not in PMS | **NOT VERIFIED** → OWNER ACTION REQUIRED |
| A | Earlier HR migrations (onboarding/reset, commission, MSS/compensation, ESS edit, HR01–05) | Present | PMS: applied staging + production (2026-10-13/16; MSS 20261103/04 production owner-reported, re-check pending) | VERIFIED [PMS] (independent re-check pending for 20261103/04) |
| A | Duplicate migration versions | `20261216100000` ×2 (identity deletion tracked; S&A preview untracked); `20261022100000` ×2 (untracked core prefs vs applied S&A); older collisions documented | — | VERIFIED |
| A | Future-dated stamps (`202612xx` today 2026-10-24) | Present | — | VERIFIED (ordering risk) |
| B | Leave INSERT allows any employee_id/status | Policy text | [snapshot] prod+stg; re-confirmed by loading into [replica] | VERIFIED (snapshot); live NOT VERIFIED |
| B | Leave UPDATE allows employee self-approval | Policy text `u.id = employee_id OR …` | [snapshot] | VERIFIED (snapshot) |
| B | Org-wide SELECT of leave requests & balances | Policy text | [snapshot]+[replica] | VERIFIED (snapshot) |
| B | No status CHECK / no transition trigger on `hr_leave_requests` | DDL | [snapshot]+[replica] triggers list | VERIFIED (snapshot) |
| B | ESS leave type list empty (`is_active`) | `HrMobileLeave.tsx:106` | column absent [snapshot] | VERIFIED |
| B | Existing leave data volumes / self-approved rows | — | Prod 2026-10-02: HR real-use signals 0; nothing since | NOT VERIFIED → OWNER ACTION REQUIRED (SQL §E) |
| C | Payroll calculate writes non-existent columns, swallows errors | `calculate/route.ts:143-165` | DDL identical prod/stg [snapshot] | VERIFIED |
| C | Statutory settings use non-existent `hr_settings.config_key` | `statutory-settings/route.ts:18,51`; `calculate:31` | `hr_settings` = organization_id, config, created_at, updated_at [snapshot]+[replica] | VERIFIED |
| C | OT always 0 (wrong timesheet columns) | `calculate:95` | [snapshot] | VERIFIED |
| C | Payroll audit never written | `calculate:193-198` | [snapshot] | VERIFIED |
| C | Maker-checker enforced | trigger `sa_payroll_run_transition_guard` | trigger present [snapshot]+[replica]; SoD `payroll-prepare-approve` ENFORCE via `20261110100000` (applied per PMS) | VERIFIED (snapshot/PMS) |
| C | Duplicate GL paths can double-post | two RPCs, separate idempotency stores | function bodies [snapshot] | VERIFIED (design); actual double posts NOT VERIFIED |
| C | Payroll runs/items volumes | — | Prod 2026-10-02: payroll runs 0 | NOT VERIFIED → OWNER ACTION REQUIRED |
| D | HR key modes — staging | — | Staging 2026-10-23: 133 LEGACY_RETIRED / 2 SHADOW incl. all HR keys except `hr.employee.delete` [SA report] | VERIFIED (document, 1 day old) |
| D | HR key modes — production | — | Last record 2026-10-02: 111 SHADOW / 3 LEGACY_ENFORCED | **NOT VERIFIED / likely OUTDATED** → OWNER ACTION REQUIRED |
| D | HR keys held only via compat policies (staging) | — | **25 people** rely solely on `legacy-hq` (14), `legacy-power-user` (9), `legacy-sa` (2) for **all 23 HR keys** incl. `hr.payroll.prepare/approve/release`, `hr.compensation.*`, `hr.leave.approve` [stg-audit] | VERIFIED (staging, 2026-10-23) |
| D | `legacy_authorization.read_only` | — | staging `true` [SA report]; production unknown | Staging VERIFIED; prod NOT VERIFIED |
| E | Lifecycle function dependencies | 10 RPCs from 20261214/16/17/18 | absent from snapshots | VERIFIED (dependency) / NOT VERIFIED (current env) |
| E | **Attendance correction review cannot complete** | `corrections/[id]/review/route.ts:36` writes `review_note` (column is `review_comment`) → 500; audit insert uses `entry_id/performed_by/old_values/new_values` (actual `actor_user_id/entity_type/entity_id/metadata`) | [snapshot] | **VERIFIED — NEW** |
| E | **Timesheet generation fails** | `timesheets/route.ts:121-132` upserts `total_days, total_work_minutes, total_overtime_minutes, late_count, early_leave_count` (not columns) | [snapshot] | **VERIFIED — NEW** |
| E | Correction review has no self-approval block | review route checks only `hr.attendance.manage` | — | **VERIFIED — NEW** |
| E | OT request API drift; requester auto-approval | `overtime/requests/route.ts:135-202` | [snapshot] | VERIFIED |
| E | Clock in/out, shifts, policy, timesheet approve writes | column-aligned | [snapshot] | VERIFIED |
| E | Reporting lines vs archived managers; overlapping compensation; archived-but-onboarded | — | — | NOT VERIFIED → OWNER ACTION REQUIRED (SQL §E) |

---

## 2. HR Migration Application Status & Dependency Register

| # | Migration | Git | Staging | Production | Hard prerequisites | Notes |
|---|---|---|---|---|---|---|
| 1 | `20261214100000_hr_employee_controlled_delete` | tracked | NOT VERIFIED (absent ≤ 10-20) | NOT VERIFIED | 20261003100000, 20261009100000, 20261110100000 (applied per PMS) | UI already calls it |
| 2 | `20261215120000_sa_hr_employee_delete_mode_retired` | **untracked** | NOT VERIFIED | NOT VERIFIED | #1 | Optional; mode label only |
| 3 | `20261216100000_identity_permanent_deletion` | tracked | NOT VERIFIED | NOT VERIFIED | #1 | **Duplicate version** with #7 |
| 4 | `20261217100000_identity_archive_identifier_release` | tracked | NOT VERIFIED | NOT VERIFIED | #3, #1, 20261027100000 | |
| 5 | `20261218100000_identity_archive_optional_reason` | tracked | NOT VERIFIED | NOT VERIFIED | #4 | Replaces `identity_archive_execute` body |
| 6 | `20261215110000_sa_legacy_compat_cutover_controls` | **untracked** | NOT VERIFIED (header of #7 claims applied; S&A report says "ready for the owner") | NOT VERIFIED | 20261026100000, 20261005110000 | S&A workstream; needed before HR compat retirement |
| 7 | `20261216100000_sa_legacy_preview_scope_coverage` | **untracked** | NOT VERIFIED | NOT VERIFIED | #6 | Re-stamp before first apply (collision with #3) |
| 8 | `20261215100000_sa_payment_gateway_restriction` | untracked | Effects reported live on staging (UAT_RESULTS 2026-10-24, from read-only dump) | NOT VERIFIED | — | Not HR; listed for collision awareness |
| 9 | `20261213100000_sa_organization_insert_gate` | tracked | NOT VERIFIED | NOT VERIFIED | — | Not HR |
| 10 | `20261211100000`, `20261212100000` | tracked | NOT VERIFIED | NOT VERIFIED | — | Not HR |
| 11 | `20261022100000_core_system_preferences` | untracked | NOT VERIFIED | NOT VERIFIED | — | Collides with applied `20261022100000_sa_actor_org_gates_row_context`; re-stamp before first apply |
| 12 | `20261024110000_sa_emergency_access_enable` | untracked | Not applied (intentional, D-016) | Not applied | — | Must stay unapplied |

Order when approved (B1): **#1 → #3 → #4 → #5** (+ optional #2). S&A track independently: **#6 → #7** (re-stamped). No HR B2 migration may be applied before #1–#5 are settled, because B2's new migration must be stamped after `20261218100000`.

---

## 3. Current Critical Security Findings

| ID | Finding | Severity | Exposure condition | Class |
|---|---|---|---|---|
| SEC-1 | Any staff member can insert a leave request for another employee, with any status (incl. `approved`) | **Critical** | Wherever `hr_leave_*` is reachable by `authenticated` (direct PostgREST) | VERIFIED (snapshot) |
| SEC-2 | Employee can self-approve via direct UPDATE (own row, any column) | **Critical** | Same | VERIFIED (snapshot) |
| SEC-3 | Organization-wide read of all leave requests (reasons may be medical) and balances | High (PDPA) | Same | VERIFIED (snapshot) |
| SEC-4 | 25 staging users hold payroll prepare/approve/release, compensation and leave-approve **only** through legacy compatibility policies (HQ / power user / SA) | High | Every mode (compat policies authorize like explicit grants) | VERIFIED (staging 2026-10-23) |
| SEC-5 | Production HR decisions likely still decided by legacy evaluators (SHADOW) incl. 32 routes with `() => true` | High | Production while SHADOW; RLS is the backstop | NOT VERIFIED (prod modes) |
| SEC-6 | Attendance correction self-approval possible (when review works) | Medium | HR manager approving own correction | VERIFIED [code] |
| SEC-7 | Unguarded invoker GL writers (`hr_post_payroll_payment_to_gl`, `hr_post_statutory_payment_to_gl`, `hr_post_expense_reimbursement_to_gl`) limited only by `gl_journals` RLS | Medium | `finance.journal.post` holders | VERIFIED (snapshot) — Finance workstream |
| SEC-8 | `app/.env.local` → shared staging: local UAT mutates shared staging data | Process risk | Any localhost HR test | VERIFIED |

Integrity (not security) defects blocking safe use: payroll false success (C), correction review 500, timesheet generation failure, OT request API, ESS leave types.

---

## 4. B2 Security Containment Readiness Assessment

| Readiness criterion | Status | Notes |
|---|---|---|
| Defects reproduced at current HEAD | **READY** | All B2 anchors re-confirmed at `1e0830c6` |
| No conflicting uncommitted work in B2 files | **READY** | B2 file set is clean in the working tree |
| Migration ordering | **BLOCKED until B1 is decided** | B2 migration must be stamped after `20261218100000`; #1–#5 application state unknown. B2 can be coded/tested meanwhile; its migration is applied only after #1–#5 |
| Existing leave/payroll data shape | **OWNER ACTION REQUIRED** | Run SQL §B/§C on staging + production: status values, self-approved rows, runs without lines decide whether the trigger is added `NOT VALID` and whether a data-review note is needed |
| Who keeps leave-approval ability after containment | **OWNER ACTION REQUIRED (decision)** | Containment keeps `sa_rls_gate('hr.leave.approve')` holders + direct manager (`hr_employees.manager_user_id`). On staging that includes 25 compat-policy holders (SEC-4). Accept for containment (recommended; B3 narrows it) or restrict now |
| Payroll approve block mechanism | **READY (design)** | Gate via a server-side setting/feature flag; avoid a new `hr_settings` key until its shape (no `config_key`) is fixed in the same batch |
| Test infrastructure | **READY** | Replica pattern (`supabase/tests/security/*/run.sh`) + Vitest; a disposable PG was proven usable here |
| UAT environment | **CONDITION** | Only shared staging is available (`.env.local`); UAT must use dedicated test employees and be announced to other workstreams |

**Verdict:** B2 is **ready to code and test**; its database part is **ready to apply only after B1 decisions** and after the owner runs the diagnostic on staging.

---

## 5. Shared Branch / Cross-Workstream Impact Matrix

| Proposed fix | S&A infra | Identity lifecycle | Org/user data | Navigation | Finance/Accounting | DB migrations | Coordination |
|---|---|---|---|---|---|---|---|
| B2 leave guard trigger + RLS | uses `sa_rls_gate` (read) — no catalogue change | — | reads `hr_employees.manager_user_id` | — | — | **new HR migration** (after 20261218100000) | Inform S&A: policies on `hr_leave_*` change; S&A V2 does not touch them |
| B2 ESS leave fix (`HrMobileLeave`) | — | — | — | — | — | — | None |
| B2 payroll fail-closed (calc/approve/payslips/preview/statutory) | uses `hrCan` (unchanged) | — | — | — | preview-journal reads Finance mappings | none | Finance: preview-journal output changes |
| B2 410 on `/api/hr/finance/post-payroll-run` | route-coverage entry stays | — | — | — | removes a GL entry point (no DB change) | none | Finance owner informed (P-F03) |
| B2 OT request repair | `attendanceCan` | — | — | — | — | none | None |
| B2 correction review + timesheet repair (proposed addition) | `attendanceCan` | — | — | — | — | none | None |
| B2 holiday template / config seeds | — | — | — | — | — | none | None |
| B2 hide Approval Flow (`hrNav.ts`) | destinations untouched | — | — | **HR nav only** | — | none | S&A V2 edits `nav-access.ts` (not `hrNav.ts`) — no overlap |
| B2 CI duplicate-version + column-contract checks | — | — | — | — | — | CI only | Affects every workstream's future migrations — announce |
| B1 apply 20261214/16/17/18 | S&A keys used, no change | **yes** (identity workstream owns 16/17/18) | **yes** (users, auth, hr_employees) | — | — | owner-applied | Identity workstream sign-off; announce on staging |
| B1 S&A #6/#7 | **yes** | — | — | — | — | owner-applied | S&A workstream owns |
| B3 consolidation | **yes** — depends on uncommitted S&A V2 change: app evaluator now ignores non-active (retired) compat policies (`authorization.ts` `loadNewPolicy`) | — | grants | destinations | `finance.payroll_integration.manage` | catalogue migration | Must follow S&A V2 merge; joint cutover plan |
| B4–B8 | per batch | B7b touches identity archive | yes | B8 | Phase B/C | yes | Per-batch review |

Observed uncommitted S&A V2 behaviour change relevant to HR: `authorize()` now throws `AuthorizationUnavailableError` on evaluation failure; `hrCan()` already catches all errors and returns **deny (403)**, so HR stays fail-closed (no 503 surfaced). No HR code change needed.

---

## 6. Proposed B2 Implementation Boundaries

**In scope (HR-owned files only):**
1. Migration `20261219xxxxxx_hr_leave_containment_guard.sql` (stamp after `20261218100000`): `BEFORE INSERT OR UPDATE` trigger on `hr_leave_requests` — insert only for self (or `hr.leave.approve` holder) with status `draft|pending`; status → `approved|rejected` only if actor ≠ employee and (gate `hr.leave.approve` or actor = employee's `hr_employees.manager_user_id`); `approved_by` must equal actor. Replace SELECT policies on `hr_leave_requests`/`hr_leave_balances` with own / direct reports / `hr.leave.approve`. Previous policy text kept verbatim in the header for rollback. Service-role paths unaffected.
2. `components/hr/mobile/HrMobileLeave.tsx`: `status='active'`; team tab limited to direct reports.
3. Payroll fail-closed: `api/hr/payroll/runs/[id]/calculate`, `.../approve`, `statutory-settings`, `api/hr/accounting/preview-journal`, `components/hr/modules/HrPayrollPayslipsView.tsx`, `lib/api/payroll.ts` — correct column contract, abort on any line error, correct `hr_payroll_audit` columns, exclude leavers, approval blocked while uncertified.
4. `api/hr/finance/post-payroll-run/route.ts` → 410 (DB function untouched).
5. `api/hr/attendance/overtime/requests/route.ts`: column repair; no requester self-approval.
6. **Recommended addition (newly found):** `api/hr/attendance/corrections/[id]/review/route.ts` (`review_comment`, audit columns, block self-review) and `api/hr/attendance/timesheets/route.ts` (real columns).
7. `api/hr/public-holidays/route.ts` (drop `category`; Thaipusam state-scoped) and `api/hr/config/audit/route.ts` (disable broken seed actions).
8. `modules/hr/hrNav.ts`: hide Leave → Approval Flow.
9. CI: duplicate migration version check; HR column-contract test (runs against the committed schema snapshot).
10. Tests: new replica suite `supabase/tests/security/hr_leave_containment/`; route tests for each changed route.

**Out of scope (explicitly):** any file under `lib/security-access/**`, `lib/server/nav-access.ts`, `components/security-access/**`, identity files, S&A catalogue/modes/grants, Finance functions or tables, `.gitignore`, migrations of other workstreams, payroll statutory logic (Phase B), leave backend (B6), attendance features (B4).

**Done means:** code + tests pass at a recorded HEAD; replica suite passes; migration applied to staging by owner with PMS entry; UAT on staging with test employees; production application separately approved; master documents updated with separate fields for code / tests / migration staging / migration production / UAT / deployment.

---

## 7. Owner-run read-only SQL diagnostics

File: `hr_b0_environment_readonly.sql` (delivered alongside this report). Run on **staging** and **production** separately; output is aggregate counts and catalog facts only. It runs inside `BEGIN TRANSACTION READ ONLY … ROLLBACK` with a 60 s statement timeout. It was executed end-to-end without errors against a throwaway replica of the 2026-10-16 production schema.

| Section | Answers |
|---|---|
| A | Which of migrations #1–#7, #9, #11 have their effects present; `hr.employee.delete` / emergency-access modes |
| D | HR keys by mode; `legacy_authorization` setting; payroll SoD enforcement; compat policies and their HR permission counts; HR shadow parity |
| B | Live leave policies and triggers; leave status distribution; self-approved and approver-less approved rows |
| C | Payroll runs by status/GL status, runs without lines; GL postings per path and double-posted runs; `hr_settings` columns |
| E | Onboarding/employment status matrix; go-live phase; archived-but-active employment; reports to inactive managers; position assignments; attendance/OT/correction/holiday/compensation volumes; overlapping active compensation |

---

## 8. Recommended next action

1. **Owner:** run the diagnostic on staging and production; share the output (or record it in PMS).
2. **Owner decision:** accept the B2 boundary in §6 (including the two newly found attendance fixes) and the containment approver set (§4).
3. **Then:** approve B2 coding/testing immediately (it does not depend on the diagnostic for code), and decide B1 application of #1→#3→#4→#5 based on the diagnostic. B2's migration is applied after B1.

---

## 9. Proposed documentation updates (not applied during B0)

**`HR_MASTER_INDEX.md`**
- Header: last verified HEAD `1e0830c6`, B0 executed 2026-10-24 (read-only, snapshot/document evidence; live DB not queried).
- §2 status: "Current approved phase: B0 complete (assessment) — B2 awaiting approval."
- §3 blockers: add **BL-8** attendance correction review and timesheet generation broken (column drift); add **BL-9** 25 staging users rely solely on legacy compat policies for all HR keys; add **BL-10** localhost → shared staging (UAT must use test employees); BL-2/BL-5 → "OWNER ACTION REQUIRED: run `hr_b0_environment_readonly.sql`".
- §5.4 corrections: Master Scope S-08.1 "schema-aligned" is **OUTDATED** — only correction *requests* are aligned; review fails.

**`HR_PROGRESS_TRACKER.md`**
- S-08.1: Code implemented → **Partial (review route broken)**; blocker BL-8.
- S-06.4 / timesheets: add row "Timesheet generation — Broken (column drift)".
- S-02.1/S-02.2/S-03.1: Applied staging/production stay **NV**, note "absent from snapshots ≤ 2026-10-20; diagnostic pending".
- S-17.4: production modes "NV — last record 2026-10-02 (likely outdated)"; S-17.5: "25 staging users compat-only (2026-10-23)".
- Batch table: B0 → Approved Yes · Started Yes · Code n/a · Evidence "B0 report 2026-10-24; owner SQL pending".

**`HR_IMPLEMENTATION_ROADMAP.md`**
- B0: Current code status "Assessment complete 2026-10-24; owner diagnostic outstanding".
- B2 scope: add item (9) correction review + timesheet generation repair and correction self-review block; add explicit out-of-scope list (§6); add dependency "B2 migration applied only after B1 #1–#5 decided".
- B3 dependency: "after S&A finalization V2 (uncommitted `authorization.ts` retired-policy filter) is merged".
- Add a "Coordination" row to every batch (shared-workstream impact).

**`HR_GO_LIVE_GATES.md`**
- Gate 2: add 2.7 "Duplicate-version collisions (`20261216100000`, `20261022100000`) resolved by re-stamping never-applied files before application".
- Gate 4: add 4.11 "Correction review and timesheet generation succeed end-to-end; correction self-review refused".
- Gate 5: add 5.6 "UAT on shared staging uses dedicated test employees; other workstreams notified".
- Gate 1: add 1.10 "No HR permission held solely via a legacy compatibility policy in staging **and** production (baseline: 25 staging users on 2026-10-23)".
