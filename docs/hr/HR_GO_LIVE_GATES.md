# Serapod2U HR — Go-Live Gates (HR Core)

Last verified: 2026-10-24 · HEAD `1e0830c6` (B0 evidence reconciliation) · back to [HR_MASTER_INDEX.md](HR_MASTER_INDEX.md)

HR Core goes live per organization only when **all seven gates PASS**, each with recorded evidence. A gate is **FAIL** if any criterion fails or lacks evidence. Payroll and Finance posting have their **own later gates** (D-003); Gate 7 checks only contract/data readiness.

Evidence rules: evidence is stored or referenced in [HR_PROGRESS_TRACKER.md](HR_PROGRESS_TRACKER.md) with date, environment, HEAD and who ran it. Automated test results alone never pass a gate that requires UAT.

Current state of every gate: **NOT ASSESSED** (2026-10-24).

Status note (2026-10-24 handover sync): still **NOT ASSESSED**. B0 live verification is **PENDING** for staging and production (B0 deliverables restored and verified; BL-8 resolved), so no live evidence exists yet for 1.1–1.3, 2.1–2.2 or 3.x. Criteria 1.6, 2.3, 4.6 and 7.7 depend on B2A/B2B, which are **NOT IMPLEMENTED**.

---

## Gate 1 — Security & Access

| # | Criterion (pass/fail) | Evidence required |
|---|---|---|
| 1.1 | Every `hr.*` permission used by HR Core is NEW_ENFORCED or LEGACY_RETIRED in the target environment | Read-only query output of `sa_migration_modes` for `hr.%` |
| 1.2 | Zero unexplained shadow-parity mismatches for HR keys over the last 7 days before each enforcement wave | `sa_shadow_parity_summary` output per wave |
| 1.3 | No `hr.*` permission is held only through a legacy compatibility policy | `sa_legacy_cutover_impact()` filtered to `hr.%` = 0 `would_lose` rows (or each accepted by owner in writing) |
| 1.4 | `grep "() => true" app/src/app/api/hr` = 0; no inline `role_level` authorization in HR routes | Grep output at release HEAD |
| 1.5 | HR Permissions screen does not write the legacy store; API writes return 410 | Route test + UAT screenshot |
| 1.6 | Leave: impersonated insert, approved-status insert and self-approval are refused; non-direct-report manager refused | Replica test output (B2/B6) |
| 1.7 | Cross-organization isolation: other-org employee/leave/attendance records return not-found for HR, MSS and ESS | Route tests + UAT |
| 1.8 | Role walkthrough (HR admin, HR manager, line manager, employee, payroll preparer, payroll approver, Finance user) shows only permitted destinations and APIs | UAT record per role |
| 1.9 | Break-glass `hr.employee.delete` assigned to nobody at go-live (or explicitly time-boxed) | Assignment query |
| 1.10 | No `hr.*` permission is held solely through a legacy compatibility policy in staging **and** production; HR leave authority never via compat (P-R12). Baseline: 25 staging users compat-only (2026-10-23) | v2 diagnostic §D per environment *(proposed by B0 report §9; criterion added 2026-10-24, not owner-approved)* |

## Gate 2 — Database & Migration Integrity

| # | Criterion | Evidence |
|---|---|---|
| 2.1 | Every migration required by HR Core is recorded applied in staging and production in PMS with date and verification method | PMS rows |
| 2.2 | No HR Core feature depends on an unapplied migration (app RPC calls ⊆ applied functions) | Diagnostic: list of RPCs called by HR code vs `pg_proc` |
| 2.3 | HR column-contract test passes against the target schema (no code reading/writing non-existent columns) | CI output + schema dump date |
| 2.4 | No new duplicate migration version introduced; CI duplicate check active | CI output |
| 2.5 | Replica suites for all HR migrations pass (onboarding/reset, delete, permanent delete, archive, leave, attendance, lifecycle) | Suite outputs |
| 2.6 | Backups taken before production application; rollback SQL reviewed | Owner record |
| 2.7 | Never-applied duplicate versions (`20261216100000_sa_legacy_preview_scope_coverage`, `20261022100000_core_system_preferences`) re-stamped before first application | Migration listing *(proposed, B0 report §9)* |

## Gate 3 — Employee Lifecycle

| # | Criterion | Evidence |
|---|---|---|
| 3.1 | Every active employee has exactly one `hr_employees` anchor with `onboarding_status='completed'`, a confirmed hire date, department and manager (or documented top-level) | Data validation query: counts of violations = 0 |
| 3.2 | No active employee reports to an archived/inactive manager | Query = 0 |
| 3.3 | Employee vs position reporting lines reconciled (zero unexplained divergences) | B7a reconciliation report |
| 3.4 | Archive of a leaver ends compensation/assignments and reassigns reports and pending approvals | UAT scenario record (B7b) |
| 3.5 | Remove/Reset Registration, permanent delete (pre-go-live), archive, release and reactivate behave per design incl. blocked cases | UAT records (B1) |
| 3.6 | Employment history rows exist for every active employee from migration date; no overlapping compensation | Queries = 0 violations (B7c) |
| 3.7 | Former-employee document process documented and tested | UAT record |

## Gate 4 — Attendance & Leave

| # | Criterion | Evidence |
|---|---|---|
| 4.1 | Normal attendance days require no approval; rule outcome traceable to policy version | UAT + query sample |
| 4.2 | Exceptions generated exactly once per rule/day; managers see only direct reports | Replica + UAT |
| 4.3 | Corrections and HR manual entries: no self-approval; original values and reason preserved | Replica + UAT |
| 4.4 | Excel import: same file cannot be imported twice; row-level results; validation equal to other channels | UAT |
| 4.5 | OT approval independent of attendance approval; approved OT immutable except via reversal | UAT |
| 4.6 | No client-side writes to `hr_leave_*` (grep gate) | Grep output |
| 4.7 | Leave ledger sum = balance projection for 100 % of employees | Query = 0 mismatches |
| 4.8 | Entitlements meet Employment Act minima for every leave type marked statutory | Query + HR sign-off |
| 4.9 | Public holidays loaded for the go-live year for each relevant state, reviewed by HR | HR sign-off |
| 4.10 | Leave cancel, half day, holiday exclusion, year-end carry-forward scenarios pass | UAT records |
| 4.11 | Correction review and timesheet generation succeed end-to-end; correction self-review refused | Route tests + UAT *(proposed, B0 report §9)* |

## Gate 5 — UAT & Data Validation

| # | Criterion | Evidence |
|---|---|---|
| 5.1 | UAT scenario list for every in-scope workstream executed on staging with PASS | UAT log (scenario ID, tester, date, result) |
| 5.2 | All P0/P1 defects closed or formally accepted by owner | Defect list |
| 5.3 | Master-data reconciliation signed by HR (headcount per department, managers, hire dates) | HR sign-off |
| 5.4 | No mock screen reachable from navigation; every HR URL renders its feature or explicit unavailable state | Page-coverage test + walkthrough |
| 5.5 | Performance & KPI, Commission and ESS/MSS regression UAT passed | UAT log |
| 5.6 | UAT on shared staging uses dedicated test accounts; other workstreams notified (BL-12) | UAT log *(proposed, B0 report §9)* |

## Gate 6 — Controlled Activation

| # | Criterion | Evidence |
|---|---|---|
| 6.1 | Activation plan per organization approved by owner (order, date, rollback window) | Approved plan |
| 6.2 | Pre-go-live clean-up completed (Reset/Remove registration of test data) and snapshot verified | HR Data Management run records |
| 6.3 | `hr_mark_go_live` executed per organization by the authorized administrator; HR Data Reset Administrator assignments removed afterwards | `hr_go_live_state` rows; assignment query |
| 6.4 | Deployed application revision identified and recorded (not inferred from Git) | Deployment record |
| 6.5 | Post-activation operational check within 48 h (clock-ins, exceptions, leave approvals, no authorization denials for valid users) | System Logs / denial log review |
| 6.6 | Support runbook and owner contacts published | Runbook link |

## Gate 7 — Finance Integration Readiness (contract/data only — not Finance posting go-live)

| # | Criterion | Evidence |
|---|---|---|
| 7.1 | Ordinary attendance, leave and OT records have no path to `gl_journals` | Code search + design review |
| 7.2 | HR financial sources (OT, corrections, leave, commission transfers, payroll runs) have stable UUIDs, human numbers and final/locked statuses that are immutable after lock | Schema review + replica tests |
| 7.3 | Employment versions carry department (and nullable cost-centre slot) effective-dated | Schema + sample |
| 7.4 | Every allowance/deduction type references a payroll component code | Query = 0 unmapped |
| 7.5 | Statutory employee profile captured for every active employee (or tracked exceptions list) | Completeness report |
| 7.6 | Leave ledger records unpaid days and encashment entries in days | Schema + sample |
| 7.7 | `/api/hr/finance/post-payroll-run` disabled; payroll approval blocked while statutory engine uncertified | Route test + UAT |
| 7.8 | HR does not create Chart-of-Accounts entries (Finance-owned) — or remaining HR seed paths documented for removal | Code review |

---

## Future gates (out of HR Core scope)

- **Payroll go-live gate** (Phase B): statutory test vectors pass; ≥ 2-month parallel run variance = 0 or explained; finance sign-off; canonical GL path decision executed (P-F03).
- **Finance integration go-live gate** (Phase C): posting contract, acceptance SoD, period lock, journal immutability, reconciliation views, dead-letter handling.
