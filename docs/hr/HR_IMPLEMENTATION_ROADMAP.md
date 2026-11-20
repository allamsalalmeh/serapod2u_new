# Serapod2U HR — Implementation Roadmap

Last verified: 2026-10-24 · HEAD `b6b78002` (B2A/B2B implementation) · back to [HR_MASTER_INDEX.md](HR_MASTER_INDEX.md)

This roadmap is **authoritative** for sequencing. It consolidates the remediation phases P0–P7 ([HR_IMPLEMENTATION_SEQUENCE.md](assessments/remediation-2026-10-24/HR_IMPLEMENTATION_SEQUENCE.md)), the operational HR Core enhancements ([HR_MASTER_SCOPE.md](HR_MASTER_SCOPE.md)), and Finance-readiness Phases A–D ([HR_CORE_FINANCE_READY_IMPLEMENTATION_ROADMAP.md](architecture/finance-integration-2026-10-24/HR_CORE_FINANCE_READY_IMPLEMENTATION_ROADMAP.md)).

**2026-10-26:** Wave 2 + Wave 3 (B4a–B5, B6 part) applied to staging by the owner 2026-10-25 and **verified read-only** (tracker §12). Next: owner HR configuration + explicit grants → localhost UAT → commit → deploy (BL-28). No new batch. **2026-10-25 (Wave 3):** owner directive "HR CORE MASTER HANDOVER & WAVE 3 CONTINUOUS DEVELOPMENT" authorized Wave 3 implementation, isolated testing and documentation (B4a–B5, B6 part) — not staging/production application, deployment, commit or UAT. **2026-10-25:** the owner directive "CONTINUOUS EXECUTION: complete Wave 1 and develop Wave 2" authorized implementation, isolated testing and documentation of Wave 2 (B1 lifecycle compatibility, B7a, parts of B7b/B7c/B7d readiness, HR-owned B3) — **not** staging/production application, deployment or UAT. Before that: **No batch is approved for implementation.** Approval is recorded per batch in the "Owner approval" row before work starts (rule 6).

Common delivery rules for every batch with database impact: migration stamped after `20261218100000` with a unique version (P-R01), idempotent, prerequisites asserted, rollback SQL in the header, replica test suite under `supabase/tests/security/<name>/`, owner-applied staging first (D-018), recorded in `PRODUCTION_MIGRATION_STATUS.md` in the same commit. Every batch updates the master documents on completion (rule 7).

---

## 1. Batch overview and dependency order

| Batch | Name | Maps to | Depends on | Approval |
|---|---|---|---|---|
| **B0** | Environment & migration verification (read-only) | P0 | — | Code/schema assessment **completed** at `1e0830c6` ([B0 report](assessments/HR_B0_ENVIRONMENT_VERIFICATION.md)); staging & production live diagnostics **PENDING** (owner-run v2) |
| **B1** | Apply pending lifecycle & S&A migrations (owner) | P1 | B0 | Effects present on staging (KVM2 2026-10-25); production NV; Wave 2 builds on them |
| **B2** | Critical containment: leave security, ESS leave fix, payroll fail-closed, disable second payroll GL route, hide mock screen, OT API repair | P2, A8 | B0 | Not approved — proposed split into B2A + B2B (P-R11), see §2a |
| ↳ **B2A** | Leave Security Containment (migration `20261219100000`) | P2 (leave) | D-021…D-028; staging apply after explicit grants + v2 on staging; **not** B1 | **Code + isolated tests: approved (OWN-IMPL) and DONE** · staging/production application **not approved** |
| ↳ **B2B** | Operational Repairs (no migration) | P2 (payroll/attendance/OT/nav), A8 | D-029…D-031 | **Code + tests: approved (OWN-IMPL) and DONE** · deployment **not approved** |
| **B3** | Canonical S&A consolidation for HR | P3 | B1, B2 | Not approved |
| **B4a** | Hybrid Attendance foundation: auto-validation, exception detection & review, mobile clock hardening | Owner WS-06/07/10 | B2, B3, PD-ATT-01/02/03/06/07/08 | **Code + isolated tests DONE (Wave 3, 2026-10-25)** with engineering defaults E-25…E-28 (PD-ATT-* open); `20261222100000` prepared, not applied |
| **B4b** | HR manual attendance & controlled corrections | Owner WS-08 | B4a, PD-ATT-04 | **Code + isolated tests DONE (Wave 3)** — E-29/E-30; not applied |
| **B4c** | Excel bulk attendance import | Owner WS-09 | B4a, B4b, PD-ATT-05 | **Code + isolated tests DONE (Wave 3)** — E-31; not applied |
| **B5** | Overtime approval workflow | Owner WS-11 | B2 (API repair), B3, B4a, PD-OT-01/02/03 | **Code + isolated tests DONE (Wave 3)** — E-33/E-34 (MSS approval needs SA-R7); not applied |
| **B6** | Leave backend & ledger | P4, A5 | B2, B3, PD-LV-*, PD-SA-01 | **Partial (Wave 3)**: ledger/projection, working days, entitlement admin, carry-forward (E-35…E-41); chains/delegation/encashment open; `20261223100000` prepared, not applied |
| **B7a** | Reporting-line reconciliation | P5a | B1 | **Code + isolated tests DONE (Wave 2, 2026-10-25)**; staging not applied |
| **B7b** | Offboarding completion (archive hardening, separation data) | P5b, A6 | B1, B6, PD-LC-* | **Partial (Wave 2)**: employment-end effects + reassign tool; scheduled separation, archive-forced reassignment, leave reassignment, former-employee documents open (PD-LC-01…03, B6) |
| **B7c** | Employment history, compensation integrity, statutory profile | P5c, A1, A2, A4 | B1 | **Code + isolated tests DONE (Wave 2)**; `hr.employee.view_sensitive` pending (SA-R2) |
| **B7d** | Allowance/deduction → payroll component link; final-status vocabulary | A3, A7 | B7c, P-F03 decision | Slot only (Wave 2: nullable, format-checked `payroll_component_code`); mapping/A7 wait for P-F03 |
| **B8** | Navigation & HR reporting | P7 | B2 (quick wins in B2), B4a, B6 | Not approved |
| **B9** | HR Core UAT, data validation & controlled activation | Gates 1–7 | all above | Not approved |
| Phase B | Payroll integration preparation & payroll rebuild | P6, B1–B8 (finance) | HR Core go-live, PD-FIN-08 | Future |
| Phase C | Shared Finance Integration | C1–C8 | Finance module readiness | Future |
| Phase D | Wider cross-module adoption | D1–D6 | Phase C | Future |

```
B0 ─┬─▶ B1 ─┬─▶ B7a
    │       ├─▶ B7c ─▶ B7d
    │       └──────────────┐
    └─▶ B2 ─▶ B3 ─┬─▶ B4a ─▶ B4b ─▶ B4c
                  │    └──▶ B5
                  └─▶ B6 ─▶ B7b
            B2(quick wins) ─▶ B8 (after B4a, B6)
all ─▶ B9 (HR Core go-live) ─▶ Phase B (Payroll) ─▶ Phase C (Finance) ─▶ Phase D
```

Recommended first approval: **B0 + B2** (small, reversible, closes live exposures, produces facts for B1/B3).

---

## 2. Batch definitions

### B0 — Environment & migration verification (read-only)

| Field | Content |
|---|---|
| Scope | Read-only checks on staging and production: application state of `20261211…20261218` and untracked S&A files; `sa_migration_modes` for `hr.%`; `legacy_authorization.read_only`; S&A shadow parity for `hr.%`; HR row counts (leave, payroll, OT, holidays, attendance); column-contract diff of `from('hr_*')` usage vs schema; correct stale PMS row for `20261003100000` |
| Current code status | Not started. Evidence today: PMS 2026-10-16 + schema dumps |
| Dependencies | — |
| Database impact | None. Read-only diagnostic run by the owner inside a read-only transaction. Canonical diagnostic: [`hr_b0_environment_readonly_v2.sql`](assessments/hr_b0_environment_readonly_v2.sql) (supersedes v1; the old name `hr_remediation_readonly.sql` was never created) |
| S&A impact | None |
| Required tests | n/a (diagnostic) |
| UAT scenarios | n/a |
| Acceptance criteria | Signed table of applied/not-applied per migration per environment; HR keys by mode; row counts; column-contract diff reviewed; PMS updated |
| Rollback | n/a |
| Owner approval | **Not approved** |
| Status (2026-10-24) | Code/schema assessment: **completed** (B0 report, snapshot/replica evidence). Staging live diagnostic: **PENDING**. Production live diagnostic: **PENDING**. Owner-run instructions: [HR_PROGRESS_TRACKER.md](HR_PROGRESS_TRACKER.md) §5 |

### B1 — Apply pending lifecycle & S&A migrations (owner-run)

| Field | Content |
|---|---|
| Scope | `20261214100000` → `20261216100000_identity_permanent_deletion` → `20261217100000` → `20261218100000`; optional `20261215120000`; S&A track: commit untracked files, then `20261215110000` → `20261216100000_sa_legacy_preview_scope_coverage` (re-stamp before first apply); re-stamp never-applied `20261022100000_core_system_preferences`. `20261024110000` stays held (D-016) |
| Current code status | Migrations written; app already calls their functions (WS-02/03) |
| Dependencies | B0 |
| Database impact | Functions, audit tables (no data deletion) |
| S&A impact | `hr.employee.delete` mode label only (optional); cutover *controls* only (no access change) |
| Required tests | Replica suites `hr_employee_delete`, `identity_permanent_delete`, `identity_archive_release`, `sa_legacy_cutover`; Vitest `HrPeopleView.*`, `api/identity/*`, bulk removal tests |
| UAT scenarios | Remove/Reset registration; permanent delete of an unused test identity; archive with/without identifier release; reactivate; bulk removal mixed outcomes; blocked cases (self, HR live, history, Root) |
| Acceptance criteria | All replica suites pass on a staging copy; UAT scenarios pass on staging; PMS records each file with date and method |
| Rollback | Per-file rollback sections (drop functions, keep audit tables); `sa_set_migration_mode(...,'SHADOW')` for `20261215120000` |
| Owner approval | **Not approved** |

### B2 — Critical containment

| Field | Content |
|---|---|
| Scope | (1) Leave: transition-guard trigger + narrowed SELECT on `hr_leave_requests`/`hr_leave_balances` (P-R02); fix ESS leave type query (`status='active'`), team tab = direct reports only. (2) Payroll fail-closed (P-R03): correct column contract in calculate/approve/payslips/preview, fail on any line error, correct audit columns and `hr_settings` access, exclude leavers, block approve while uncertified. (3) `/api/hr/finance/post-payroll-run` → 410 (route only; DB function untouched). (4) OT request API column repair and no requester self-approval. (5) Public-holiday template: drop `category`, Thaipusam state-scoped. (6) Disable broken config seed actions. (7) Hide Leave → Approval Flow (mock). (8) CI: duplicate migration version check + HR column-contract test |
| Current code status | All defects verified at `82da8cd0` (see [dependency matrix](assessments/remediation-2026-10-24/HR_REMEDIATION_DEPENDENCY_MATRIX.md) §2) |
| Dependencies | B0 (row counts for existing leave statuses) |
| Database impact | One migration: `hr_leave_containment_guard` (trigger + policy replacement) |
| S&A impact | None (uses existing `hr.leave.approve`, MSS direct-report relation) |
| Required tests | Replica `hr_leave_containment/` (impersonated insert, approved-status insert, self-approval refused; manager approves direct report; non-report refused); route tests for payroll calculate/approve with schema-shaped fixtures; OT request route tests; column-contract test; `hrNav.test.ts` |
| UAT scenarios | Employee applies leave on mobile; manager approves direct report; employee cannot approve own leave; HR calculates a payroll run (lines created or explicit failure); approval refused with "provisional" message; OT request submit/approve |
| Acceptance criteria | All tests pass; UAT scenarios pass on staging; no change to identity, S&A catalogue or Finance tables |
| Rollback | Drop trigger, restore previous policies (verbatim in migration header); revert app commit |
| Owner approval | **Not approved** |

### 2a. Proposed B2 split (P-R11 — not approved)

**Design reference (authoritative for B2A/B2B detail): [HR_B0_REVIEW_AND_B2_PLAN.md](assessments/HR_B0_REVIEW_AND_B2_PLAN.md) Tasks 2–4** (file scopes §4.1/§4.2, sequencing §4.3, coordination §4.4, UAT/rollback §4.5). The tables below summarise it; where they differ, the plan wins unless a later owner decision says otherwise. Code re-checked at `1e0830c6` (tracker §4).

**Sequencing (B0-PLAN §4.3):** (1) owner runs v2 on staging + production → (2) OD decisions → (3) owner grants explicit `hr-leave-attendance-administrator`/`hr-payroll-full-access` to real HR approvers and `manager-self-service` to line managers (S&A action, not HR code) → (4) B2A + B2B coding with replica/Vitest tests (can start after (2)) → (5) B2B deploy (no DB) → (6) B2A staging apply + UAT (after 3, 4) → (7) production, separately approved. **B2A does not depend on B1** (corrects B0 report §4).

#### B2A — Leave Security Containment

| Field | Content |
|---|---|
| Scope | Refuse inserts on behalf of another employee (unless explicit HR authority per PD-B2-02) and inserts in non-`pending` status; refuse employee self-approval; direct-manager approval rule (PD-B2-01); explicit HR approval authority (PD-B2-02); org scope (PD-B2-03); remove role-level / compatibility exposure from leave policies without changing S&A grants (PD-B2-04); narrow SELECT on `hr_leave_requests` and `hr_leave_balances` to self, direct reports and explicit HR; approved-leave cancellation rule (PD-B2-05); MSS team scope (PD-B2-06); append-only audit event per transition |
| Design | P-R13 (B0-PLAN Task 2): SELF / MANAGER (`hr.mss.leave_*` + direct report) / explicit non-legacy HR / SERVICE bypass; guard trigger stamps `approved_by`/`approved_at`; self-approval refused unconditionally; on-behalf insert refused for everyone; RLS on requests/approvals/balances; append-only `hr_leave_request_events` without reason text; status CHECK `NOT VALID`; historical rows reported not altered (OD-B2A-5) |
| Files | `supabase/migrations/20261219100000_hr_leave_containment_guard.sql`; `supabase/tests/security/hr_leave_containment/*`; `components/hr/mobile/HrMobileLeave.tsx` (**BL-9 overlap**); `modules/hr/leave/supabaseRepository.ts`; `modules/hr/hrNav.ts` + test; `components/hr/modules/HrLeaveApprovalFlowView.tsx`; new `HrMobileLeave.test.tsx` |
| Rollback | B0-PLAN: header rollback restores previous policies verbatim (events table kept) — **re-opens SEC-1…3**; posture to be decided (PD-B2-10) |
| Verified current state | Production schema 2026-10-16: `hr_leave_requests_insert` checks only same-org membership; `hr_leave_requests_update` legacy branch admits `u.id = employee_id` or `role_level <= 20`; SELECT on requests and balances is organization-wide. No later migration touches these tables. Mobile manager tab queries all same-org pending requests |
| Dependencies | Explicit grants (step 3) before staging apply; v2 on staging. Identity/HR Data Management: service-role bypass keeps reset/restore working; events table added to the reset allowlist; registration in `identity_deletion_category` guarded with `to_regprocedure(...)` because `20261216100000_identity_permanent_deletion` application is unverified (BL-2). Not dependent on B1 |
| Database impact | One migration (stamped after `20261218100000`): transition-guard trigger + replacement policies, previous policies verbatim in rollback header |
| S&A impact | **None** — no catalogue, grant or policy-membership change |
| Required tests | Replica suite `hr_leave_containment/`: impersonated insert refused; approved-status insert refused; self-approval refused; non-report manager refused; direct report approved; HR holder approved; cross-org refused; cancellation matrix; delete/reset/archive functions still succeed |
| Owner approval | **Not approved** |

#### B2B — Operational Repairs

| Field | Content |
|---|---|
| Scope | Payroll calculate fail-closed (column contract `employee_user_id`, `total_minutes`/`overtime_minutes`; any line error fails the run) and approval lock (PD-B2-08); attendance correction review (`review_note` → `review_comment`); timesheet generation column contract (`total_work_minutes`/`total_days` do not exist); OT request API (`ot_minutes_claimed`, `approved_by`, `approver_remarks`, `planned_*_time` do not exist; self-approval PD-B2-07); mobile leave type filter `is_active` → `status`; public-holiday template (`category` column does not exist; Thaipusam state-scoped); disable broken HR configuration seed actions; `/api/hr/finance/post-payroll-run` → 410 (DB function untouched); hide mock Leave Approval Flow (`MockLeaveRepository`); HR schema-contract tests (PD-B2-09) |
| Dependencies | BL-9 (`HrMobileLeave.tsx` only — `HrMobileAttendance.tsx` is not a B2B file); v2 payroll volumes (OD-B2B-1). Files per B0-PLAN Task 3; all clean in the working tree at reconciliation |
| Database impact | None expected (app routes only) |
| S&A impact | None |
| Owner approval | **Not approved** |

### 2b. B2A/B2B implementation record and staging plan (2026-10-24)

**Implemented (uncommitted, HEAD `b6b78002`):** see [HR_PROGRESS_TRACKER.md](HR_PROGRESS_TRACKER.md) §7 for every file and test result.

**Wave 1 closure (2026-10-24):** local engineering complete; next phase = owner actions R1–R9 in the release package, then Wave 2 (B1 lifecycle migrations, B3 S&A consolidation) per §1 — not started. **Wave 1 status (2026-10-24):** the owner reports S3 (apply) executed on staging **before** S0–S2; effects NOT VERIFIED (KVM2 unreachable from the AI session, BL-18). The executable release/UAT package replacing S0–S8 is [release/b2a-staging-2026-10-24/README.md](release/b2a-staging-2026-10-24/README.md) (R1–R9, U1–U13). Production remains **not authorized**.

**Exact staging migration / UAT plan (owner-run; original plan, kept for history):**

| Step | Action | Evidence to record |
|---|---|---|
| S0 | On the Mac: `cd app && npm test` (full Vitest incl. jsdom suites) and `npx tsc --noEmit`; review the diff; commit with `git add -f` for tests (BL-16). Optionally re-run `supabase/tests/security/hr_leave_containment/run.sh` (all four modes) on a local PostgreSQL | Test output + commit hash |
| S1 | Run `docs/hr/assessments/hr_b0_environment_readonly_v2.sql` on **staging** (tracker §5) | Output file; record suspicious leave rows, compat-only holders |
| S2 | People & Access on staging: grant `hr-leave-attendance-administrator` (or `hr-payroll-full-access`) to the real HR approvers and `manager-self-service` to line managers, **organization-scoped to their HQ** | Assignment list (who, policy, scope) |
| S3 | Backup staging; apply `20261219100000_hr_leave_containment_guard.sql` with `psql -X -1 -v ON_ERROR_STOP=1`; record in `PRODUCTION_MIGRATION_STATUS.md` | PMS row (date, method, verifier) |
| S4 | Post-apply read-only checks: 6 `b2a` policies only; triggers `hr_leave_requests_guard` + `hr_leave_requests_record_event`; `hr_leave_request_events` exists with no FKs; `hr_reset_scope` row; run `select * from hr_leave_containment_review('<org>')` as HR | Query output |
| S5 | Deploy the B2A/B2B app build to staging (owner) | Deployed revision id |
| S6 | UAT with dedicated test accounts (E1, E2, M1 with MSS, M2 without, H1 explicit HR, L1 legacy-only), announced to other workstreams (BL-12): B0-PLAN §4.5 scenarios 1–14 + payroll approve blocked message + correction self-review refused + timesheet regenerate-after-approve refused + OT self-approval refused + holiday template national-only | UAT log per scenario |
| S7 | Rollback rehearsal on staging only if S6 fails: SAFE rollback from the migration header (never the full revert) | Result |
| S8 | Production: separate owner approval after S6 passes; repeat S1–S6 with production specifics | — |

### B3 — Canonical S&A consolidation for HR

| Field | Content |
|---|---|
| Scope | HR Permissions → read-only S&A panel; legacy store write APIs → 410; readiness/AI checks re-pointed; new keys (PD-SA-01); remove 32 `() => true` evaluators and 14 inline role-level checks; owner-run explicit grants; production SHADOW→NEW_ENFORCED waves; retire compatibility policies for HR keys (PD-SA-02) |
| Current code status | Legacy store not an auth source; legacy evaluators active in SHADOW; compat policies grant HR keys (verified in [S&A plan](assessments/remediation-2026-10-24/HR_SA_CONSOLIDATION_PLAN.md)) |
| Dependencies | B1 (cutover controls), B2 |
| Database impact | Catalogue migration for new keys (readiness, modes, standard-policy membership) |
| S&A impact | **Yes** — new keys; mode flips and compat retirement are separate owner actions |
| Required tests | Route-coverage gate; `nav-access.test.ts`; deny/allow/cross-org route tests; replica `sa_hr_keys/`; legacy cutover replica re-run |
| UAT scenarios | HR admin, HR manager, line manager (MSS), employee (ESS), payroll preparer vs approver, Finance user — each sees exactly their destinations and APIs |
| Acceptance criteria | No HR route uses `() => true`; every `hr.*` key on production NEW_ENFORCED or LEGACY_RETIRED with parity evidence; no `hr.*` permission held only via compat policy |
| Rollback | Revert commits; `sa_set_migration_mode(...,'SHADOW')`; `sa_restore_legacy_compat_role` |
| Owner approval | **Not approved** |

### B4a — Hybrid Attendance foundation

| Field | Content |
|---|---|
| Scope | Channel attribute on attendance entries (per PD-ATT-01); auto-validation of normal attendance (D-012) using policy/shift rules (PD-ATT-03); scheduled exception detection (late, early leave, missing clock-out, absence without approved leave, rest-day/holiday work); exception review queue for managers (MSS) and HR with resolution outcomes (PD-ATT-06); mobile clock hardening (PD-ATT-02); attendance lock at payroll cut-off (PD-ATT-08); timesheet role clarified (PD-ATT-07) |
| Current code status | Clock in/out (web/mobile, onboarding gate) implemented; policy fields `late_after_minutes`, `early_leave_before_minutes`, `grace_minutes`, `attendance_flag` exist; **no** exception engine, review queue, channel model or lock |
| Dependencies | B2, B3; owner answers PD-ATT-01/02/03/06/07/08 |
| Database impact | Yes: channel/validation columns or table, `hr_attendance_exceptions`, lock marker; cron job (existing lease pattern) |
| S&A impact | Uses `hr.attendance.manage`, `hr.mss.attendance_view`; may need an MSS exception-resolve key (decide in PD-ATT-06) |
| Required tests | Unit tests for rule evaluation (grace, thresholds, cross-midnight shifts, holidays); replica tests for exception generation idempotency and lock; route tests; MSS scope tests |
| UAT scenarios | On-time day → no review item; late arrival → exception to manager; missing clock-out → exception; approved leave day → no absence exception; resolve exception; locked period refuses edits |
| Acceptance criteria | Normal days require no approval; every rule outcome traceable to policy version; exceptions generated exactly once; managers see only direct reports |
| Rollback | Disable cron job; additive tables retained; revert app commit |
| Owner approval | **Not approved** (blocked by PD-ATT-*) |

### B4b — HR manual attendance & controlled corrections

| Field | Content |
|---|---|
| Scope | HR manual entry on behalf of an employee (reason mandatory, original/derived values, audit); corrections workflow with controlled approval (D-013, PD-ATT-04), no self-approval, corrections in locked periods per rule |
| Current code status | Corrections request + review routes exist and match schema; manual HR entry missing |
| Dependencies | B4a, PD-ATT-04 |
| Database impact | Yes: entry provenance fields; approval guard trigger |
| S&A impact | `hr.attendance.manage`; possible MSS correction-approve key |
| Required tests | Route tests (self-approval refused, cross-org refused); replica guard tests; audit-row tests |
| UAT scenarios | Employee requests correction → manager/HR approves → entry updated, original preserved; HR enters missing day with reason; self-approval refused |
| Acceptance criteria | Every manual/corrected value has actor, reason, before/after; no self-approval path |
| Rollback | Revert routes; drop guard trigger; data retained |
| Owner approval | **Not approved** (PD-ATT-04) |

### B4c — Excel bulk attendance import

| Field | Content |
|---|---|
| Scope | Template download; upload → parse → validate → dry-run preview → commit; per-row results; file hash dedupe; overlap rules with clocked entries; audit (pattern: bank statement import) |
| Current code status | Missing |
| Dependencies | B4a, B4b, PD-ATT-05 |
| Database impact | Yes: import batch + line tables (immutable), commit function |
| S&A impact | `hr.attendance.manage` (or a dedicated import key, decide in PD-ATT-05) |
| Required tests | Parser unit tests (dates/timezones MYT, malformed rows); replica idempotency (same file twice); overlap handling |
| UAT scenarios | Import a month for 20 employees; re-upload same file refused; row errors reported without partial commit (or per decision) |
| Acceptance criteria | Imported rows traceable to batch and row; duplicates impossible; validation identical to other channels |
| Rollback | Batch reversal function; revert UI |
| Owner approval | **Not approved** (PD-ATT-05) |

### B5 — Overtime approval workflow

| Field | Content |
|---|---|
| Scope | OT request lifecycle separate from attendance (D-014): submit (pre/post per PD-OT-02), manager/HR approval (PD-OT-01), day type and multiplier frozen at approval, link to attendance entry, caps from `hr_overtime_policies`; MSS team OT queue; approved OT marked as the payroll OT source (PD-OT-03) — consumption by payroll is Phase B |
| Current code status | Table and policy exist; API broken (column drift) — repaired minimally in B2 |
| Dependencies | B2, B3, B4a |
| Database impact | Yes: status CHECK, approval guard, consumption marker column (unused until Phase B) |
| S&A impact | `hr.attendance.manage`; proposed `hr.mss.overtime_approve` (PD-SA-01) |
| Required tests | Route & replica tests: no self-approval, caps, cross-org, frozen multiplier |
| UAT scenarios | Employee requests OT → manager approves → visible to HR; over-cap request flagged; rejected request excluded |
| Acceptance criteria | OT approval never depends on attendance approval; approved OT immutable except via reversal |
| Rollback | Revert routes; drop guard |
| Owner approval | **Not approved** (PD-OT-*) |

### B6 — Leave backend & ledger

| Field | Content |
|---|---|
| Scope | Per [leave design](assessments/remediation-2026-10-24/HR_LEAVE_IMPLEMENTATION_DESIGN.md): database-owned apply/decide/cancel/adjust; append-only ledger (days only, `is_unpaid`, encashment entry type — A5); balances projection; entitlement run; year-end close; carry-forward expiry job; state public holidays; `/api/hr/leave/*`; remove mock repository; MSS approval; unpaid-days function for payroll |
| Current code status | Tables exist; client-direct writes; mock Approval Flow; no ledger |
| Dependencies | B2, B3, PD-LV-*, PD-SA-01 |
| Database impact | Yes (additive columns, ledger, runs, functions, RLS lockdown, opening-balance backfill) |
| S&A impact | New keys `hr.leave.manage`, `hr.leave.view`; uses `hr.mss.leave_approve` |
| Required tests | Leave design §12 (replica, quote engine, route, component tests) |
| UAT scenarios | Apply → manager approve → HR view; cancel pending/approved; half day; public holiday excluded; year-end carry-forward; unpaid leave reported for payroll period |
| Acceptance criteria | No client writes to `hr_leave_*`; ledger sum = projection for every employee; statutory minima enforced |
| Rollback | Leave design §13 |
| Owner approval | **Not approved** |

### B7a — Reporting-line reconciliation

| Field | Content |
|---|---|
| Scope | Preview/execute reconciliation of `hr_employees.manager_user_id` against position relationships (HR-approved rows only); position-change approval updates manager in the same transaction (P-R08) |
| Current code status | Missing |
| Dependencies | B1 |
| Database impact | Yes (functions + reconciliation log) |
| S&A impact | `hr.employee.manage` |
| Required tests | Replica; `position-workflow.test.ts`; MSS route tests |
| UAT scenarios | Divergent manager detected and fixed; MSS team list matches org chart |
| Acceptance criteria | Zero unexplained divergences after execution |
| Rollback | Drop functions; log retained |
| Owner approval | **Not approved** |

### B7b — Offboarding completion

| Field | Content |
|---|---|
| Scope | Archive requires manager reassignment (PD-LC-02); end compensation/allowances/position assignments and reassign pending approvals at employment end; last working date + separation reason; optional scheduled separation (PD-LC-01); former-employee documents (PD-LC-03) |
| Current code status | Archive ends employment status only; direct reports warning only |
| Dependencies | B1, B6 (leave reassignment) |
| Database impact | Yes (new archive plan/execute bodies, backward-compatible signature; effects function; daily job) |
| S&A impact | `platform.identity.delete`, `hr.employee.delete` unchanged; optional `hr.employee.offboard` |
| Required tests | Extend `identity_archive_release` replica with reassignment/effects cases; `HrPeopleView.archive.test.tsx`; bulk removal tests |
| UAT scenarios | Archive manager with reports; archive employee with pending leave approvals; scheduled separation on a future date |
| Acceptance criteria | No archived person remains a manager or approver; compensation ended at last working date |
| Rollback | Restore `20261218100000` function bodies |
| Owner approval | **Not approved** |

### B7c — Employment history, compensation integrity, statutory profile

| Field | Content |
|---|---|
| Scope | `hr_employee_versions` with department and nullable cost-centre slot (A1, P-F02); compensation non-overlap constraint + change log (A2); statutory employee profile with column grants and ESS change requests (A4) |
| Current code status | Missing |
| Dependencies | B1; P-F02 for the slot naming |
| Database impact | Yes (additive tables, trigger, exclusion constraint, column grants) |
| S&A impact | Possibly `hr.employee.view_sensitive` (PD-SA-01) |
| Required tests | Replica (version written on every change; overlap refused; column grants); route tests |
| UAT scenarios | Transfer employee → version row; overlapping salary refused; statutory fields hidden from non-holders |
| Acceptance criteria | History complete from migration date; no overlapping compensation |
| Rollback | Drop trigger (stop writes); tables retained |
| Owner approval | **Not approved** |

### B7d — Payroll component link & final-status vocabulary

| Field | Content |
|---|---|
| Scope | Allowance/deduction types reference a payroll component code (A3); HR financial sources (OT, corrections, expense claims) carry final/locked statuses and immutability after lock (A7) |
| Current code status | Missing |
| Dependencies | B7c; P-F03 (component model) |
| Database impact | Yes (code/FK columns, status CHECKs, guards) |
| S&A impact | None |
| Required tests | Constraint tests; route tests |
| UAT scenarios | Create allowance type → choose component; locked record cannot be edited |
| Acceptance criteria | Every type mapped; locks enforced |
| Rollback | Columns nullable; revert guards |
| Owner approval | **Not approved** |

### B8 — Navigation & HR reporting

| Field | Content |
|---|---|
| Scope | (Quick wins already in B2.) Settings duplicates redirect to People; legacy `hr-*` view ids mapped; Attendance sub-entries (shifts, OT, corrections, exceptions); Public Holidays and Payroll Runs entries; Accounting nav gate = API permission; deferred modules show explicit "not available"; HR Reporting group (headcount & movement, attendance exceptions, leave liability in days, KPI) |
| Current code status | Navigation single source `hrNav.ts`; issues N1–N10 verified |
| Dependencies | B2, B4a, B6 |
| Database impact | None (reporting reads) |
| S&A impact | Destinations only |
| Required tests | `hrNav.test.ts`, `pages.access.test.tsx`, `HrLandingView.access.test.tsx`, `nav-access.test.ts`, new page-coverage test |
| UAT scenarios | Each role walks every entry; no generic dashboard on HR URLs |
| Acceptance criteria | Every entry renders its feature or an explicit unavailable state; nav gate equals API gate |
| Rollback | Revert commit |
| Owner approval | **Not approved** |

### B9 — HR Core UAT, data validation & controlled activation

| Field | Content |
|---|---|
| Scope | Execute [HR_GO_LIVE_GATES.md](HR_GO_LIVE_GATES.md) gates 1–7; master-data clean-up (Reset/Remove registration while pre-go-live); onboarding of real employees; `hr_mark_go_live` per organization (one-way) |
| Current code status | Gates defined; nothing executed |
| Dependencies | All HR Core batches |
| Database impact | Operational data only; `hr_mark_go_live` |
| S&A impact | Final grants per role |
| Required tests | Full regression; replica suites |
| UAT scenarios | End-to-end per gate |
| Acceptance criteria | All gates PASS with evidence |
| Rollback | Before `hr_mark_go_live`: HR Data Management restore; after: forward-fix only |
| Owner approval | **Not approved** |

---

### 2c. Wave 2 implementation record (2026-10-25)

Migration `20261221100000_hr_employment_foundation.sql` (prepared, **not applied**), replica suite `supabase/tests/security/hr_employment_foundation/`, application routes `/api/hr/employees/[id]/history`, `/api/hr/employees/[id]/employment`, `/api/hr/reporting-lines`, repaired `/api/hr/employees/profile` (GET/PUT), HR People History tab and Reporting-line check, B3 HR-owned evaluator clean-up. Owner sequence W-1…W-7 and rollback: [Wave 2 release README](release/wave2-employment-foundation-2026-10-25/README.md). UAT: [uat/HR_WAVE1_WAVE2_COMPREHENSIVE_UAT.md](uat/HR_WAVE1_WAVE2_COMPREHENSIVE_UAT.md).

**Next toward Wave 3:** (1) owner W-1…W-7; (2) answers to PD-ATT-01…08 (B4a hybrid attendance) and PD-LV-01…04 (B6 leave backend & ledger) and PD-LC-01…03 (remaining B7b); (3) S&A owner SA-R1…SA-R3 (explicit grants, new keys, production modes); then B4a and B6 in parallel, B5 after B4a.

### 2d. Wave 3 implementation record (2026-10-25)

Migrations (prepared, **not applied**): `20261222100000_hr_hybrid_attendance_overtime.sql` (B4a/B4b/B4c/B5) and `20261223100000_hr_leave_ledger.sql` (B6 part); replica suite `supabase/tests/security/hr_attendance_overtime/` (405 / 362 checks, negative control). Application: 11 new HR routes, 4 rewritten, HR "Attendance operations" screen (board, exceptions, corrections, manual entry, Excel import, overtime, report), leave balances panel, mobile attendance (history, corrections, OT, approvals) and mobile leave quote. Decisions E-25…E-46; interim defaults for open PD items in the register §3.4. Owner sequence X-1…X-9 and rollback: [Wave 3 release README](release/wave3-attendance-overtime-leave-2026-10-25/README.md). UAT: [uat/HR_WAVE3_UAT.md](uat/HR_WAVE3_UAT.md).

**Next:** X-1 (verifies the owner-reported Wave 2 staging application read-only and runs the Wave 3 preflight) → X-2…X-9; S&A SA-R6…SA-R11; owner answers to the §3.4 items; then B7b remainder, B8 (navigation entries, HR reporting group), remaining B6 (approval chains, delegation, encashment with Phase B), B9.

## 3. Future phases (separate go-lives)

| Phase | Content | Source | Gate |
|---|---|---|---|
| **Phase B — Payroll** | Statutory rate sets & PCB engine; DB calculation from `compute_payroll_item()`; component-level run detail; run types & revisions; consumption markers (timesheets/OT/commission); commission import; canonical GL path execution (P-F03) and bridge fixes; payroll payment & statutory remittance documents; parallel run & certification | [payroll risk assessment](assessments/remediation-2026-10-24/HR_PAYROLL_RISK_ASSESSMENT.md), [finance roadmap §4](architecture/finance-integration-2026-10-24/HR_CORE_FINANCE_READY_IMPLEMENTATION_ROADMAP.md) | Payroll go-live (PD-FIN-08) |
| **Phase C — Shared Finance Integration** | Posting requests/lines/events, Finance acceptance with SoD, worker & reconciliation, GL hardening, cost centres & dimensions, payroll as contract source #1 | [contract v1](architecture/finance-integration-2026-10-24/SHARED_FINANCE_INTEGRATION_CONTRACT_V1.md), [governance](architecture/finance-integration-2026-10-24/FINANCE_POSTING_GOVERNANCE_DESIGN.md) | Finance integration go-live |
| **Phase D — Wider adoption** | Supply chain documents, HR expenses/benefits, storefront, marketplace, inventory valuation, AP/AR subledgers if needed | [finance roadmap §6](architecture/finance-integration-2026-10-24/HR_CORE_FINANCE_READY_IMPLEMENTATION_ROADMAP.md) | Per module |

## 4. Traceability: workstream → batch

| WS | Batches | WS | Batches |
|---|---|---|---|
| WS-01 | B1, B7c | WS-10 | B4a |
| WS-02 | B1 | WS-11 | B2, B5 |
| WS-03 | B1, B7b | WS-12 | B2, B6 |
| WS-04 | B8 | WS-13 | B2, B4a, B5, B6, B8 |
| WS-05 | B7a, B7c | WS-14 | B9 |
| WS-06 | B4a | WS-15 | B9, Phase B |
| WS-07 | B4a | WS-16 | B2, B8 |
| WS-08 | B4b | WS-17 | B0, B3 |
| WS-09 | B4c | WS-18 | B2, B6, B7b, B7c, B7d, Phases B–D |

## 5. Change log

| Date | Change |
|---|---|
| 2026-10-25 | **Wave 3**: B4a/B4b/B4c/B5 code + isolated tests done, B6 partial; §2d. Not applied, not deployed, no UAT. |
| 2026-10-25 | Wave 1 closure + Wave 2: §2c; batch approvals for B1/B7a/B7b/B7c/B7d updated (code + isolated tests only). |
| 2026-10-24 | Wave 1: §2b status note and link to the release/UAT package; S3 owner-reported executed on staging (unverified). |
| 2026-10-24 | B2A/B2B code + isolated tests done (OWN-IMPL); §2b implementation record and exact staging plan added; B1 note: re-stamp `20261214100000_hr_employee_controlled_delete` and `20261215100000_sa_payment_gateway_restriction` (collisions with applied origin/main files, BL-14). |
| 2026-10-24 | B0 evidence reconciliation: B0 status from the restored report; §2a now references B0-PLAN as design reference with sequencing; B2A independent of B1 (B0 report §4 corrected); rollback posture PD-B2-10; dependencies use OD-B2A/B IDs. |
| 2026-10-24 | Handover sync at `1e0830c6`: B0 status recorded (repo assessment reported completed; live verification PENDING); B0 diagnostic reference corrected; §2a B2A/B2B split added as PROPOSED (P-R11); both NOT IMPLEMENTED, not approved. |
| 2026-10-24 | Roadmap created; all batches "Not approved". |
