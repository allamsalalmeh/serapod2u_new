# Serapod2U HR — Master Scope

Last verified: 2026-10-24 · HEAD `5d6c9bcb` · back to [HR_MASTER_INDEX.md](HR_MASTER_INDEX.md)

This file lists **every agreed HR Core workstream and enhancement**. Nothing may be removed without an owner decision recorded in [HR_DECISION_REGISTER.md](HR_DECISION_REGISTER.md) (rule 12). Operational HR enhancements are **not** replaced by Finance integration work; Finance readiness is a separate workstream (WS-18).

Conventions
- **Requirement source:** where the requirement comes from (owner instruction, existing design doc, assessment). "Owner 2026-10-24" = the owner's documentation-governance instruction of 2026-10-24.
- **Code status (verified at `82da8cd0`):** what exists in the repository today. It says nothing about deployment or environment state — see [HR_PROGRESS_TRACKER.md](HR_PROGRESS_TRACKER.md).
- **Batch:** implementing batch in [HR_IMPLEMENTATION_ROADMAP.md](HR_IMPLEMENTATION_ROADMAP.md).
- Items marked **(details pending)** are agreed at direction level only; specifics are open owner decisions.

---

## Workstream overview

| WS | Workstream | Batches |
|---|---|---|
| WS-01 | Employee Master & Onboarding | B1, B7c |
| WS-02 | Employee Delete/Reset and Bulk Removal | B1 |
| WS-03 | Former Employees and Offboarding | B1, B7b |
| WS-04 | Departments, Positions and Organization Chart | B8 |
| WS-05 | Employee Transfers and Reporting Lines | B7a, B7c |
| WS-06 | Hybrid Attendance | B4a |
| WS-07 | Mobile Clock In/Out | B4a |
| WS-08 | HR Manual Attendance and Corrections | B4b |
| WS-09 | Excel Bulk Attendance Import | B4c |
| WS-10 | Exception-based Attendance Review | B4a |
| WS-11 | Overtime Approval | B2, B5 |
| WS-12 | Leave Management | B2, B6 |
| WS-13 | ESS and MSS | B2, B4a, B5, B6, B8 |
| WS-14 | Performance and KPI | B9 (UAT) |
| WS-15 | Commission | B9 (UAT); payroll hand-off Phase B |
| WS-16 | HR Reporting and Navigation | B2, B8 |
| WS-17 | Canonical S&A Integration | B0, B3 |
| WS-18 | Finance-Ready HR Foundation | B2, B6, B7b, B7c, B7d; Phases B–D |
| (future) | Payroll | Phase B |
| (future) | Shared Finance Integration | Phases C–D |

---

## WS-01 Employee Master & Onboarding

| ID | Requirement | Source | Code status |
|---|---|---|---|
| S-01.1 | One canonical identity (`public.users`, immutable UUID); `hr_employees` is the employment anchor owning `employee_no` | Existing architecture (D-005) | Implemented |
| S-01.2 | Explicit onboarding state (`pending`/`completed`/`reset`), owned only by onboarding/reset functions | `HR_ONBOARDING_AND_DATA_RESET.md` | Implemented (migration `20261003100000`) |
| S-01.3 | Add Employee reuses existing identity; email/phone resolution via `identity_resolve`; no name matching | same | Implemented |
| S-01.4 | Operational guard: no attendance/leave/payroll rows for non-onboarded employees | same | Implemented |
| S-01.5 | HR Data Management pre-go-live reset with snapshot/restore; `hr_mark_go_live` one-way | same | Implemented |
| S-01.6 | Statutory & personal master data capture (DOB, residency/citizenship, NRIC/passport, EPF/SOCSO/tax refs, marital/children) with column-level grants | Payroll risk assessment P8; Finance readiness A4 | **Missing** |
| S-01.7 | Employment history (effective-dated versions) | Lifecycle review D6; Finance readiness A1 | **Missing** |

## WS-02 Employee Delete/Reset and Bulk Removal

| ID | Requirement | Source | Code status |
|---|---|---|---|
| S-02.1 | Controlled Remove HR Registration / Reset HR Registration (break-glass `hr.employee.delete`, preview token, idempotency, locks, append-only record) | D-006; `HR_ONBOARDING_AND_DATA_RESET.md` §7 | Code + migration `20261214100000` present; **migration not recorded applied** |
| S-02.2 | Canonical permanent identity deletion (pre-go-live clean-up) shared by UM and HR | `docs/identity/PERMANENT_IDENTITY_DELETION.md` | Code + migration `20261216100000_identity_permanent_deletion`; not recorded applied |
| S-02.3 | Bulk employee removal via canonical delete/archive with signed plan | `docs/identity/BULK_EMPLOYEE_REMOVAL.md` | Committed `82da8cd0`; depends on S-02.2/S-03.1 migrations |

## WS-03 Former Employees and Offboarding

| ID | Requirement | Source | Code status |
|---|---|---|---|
| S-03.1 | Archive & Revoke Access: end employment, archive identity, revoke login/sessions, optional identifier release; UUID and history kept | D-007, D-008; `IDENTITY_ARCHIVE_AND_IDENTIFIER_RELEASE.md` | Code + migrations `20261217100000`, `20261218100000`; not recorded applied |
| S-03.2 | Former Employees tab (archived = former; read-only; never offered as manager) | commit `94299cf9` | Implemented (UI) |
| S-03.3 | Archive must handle direct reports (reassignment) and pending approvals | Lifecycle review D1/D2 | **Missing** (warning only) |
| S-03.4 | End compensation/allowances/position assignments at employment end; exclude leavers from payroll | Lifecycle review D2 | **Missing** |
| S-03.5 | Scheduled separation with last working date and separation reason (decoupled from immediate access revocation) | Lifecycle review D3; Finance readiness A6 | **Missing** — PD-LC-01 |
| S-03.6 | Former-employee access to final payslips / Form EA (HR-mediated) | Lifecycle review D4 | **Missing** — PD-LC-03 |

## WS-04 Departments, Positions and Organization Chart

| ID | Requirement | Source | Code status |
|---|---|---|---|
| S-04.1 | Departments (shared table) | baseline audit | Implemented |
| S-04.2 | Position management V1.1 (slots, classifications, relationships, assignments, change approval, history) | `POSITION_MANAGEMENT_V1.1.md` | Foundation implemented (HR01–HR05 recorded applied); D3/D4/D6 UI gaps |
| S-04.3 | Admin and staff org charts | baseline audit | Implemented |
| S-04.4 | One canonical navigation entry for Departments/Positions (remove Settings duplicates) | baseline C12 | Open |

## WS-05 Employee Transfers and Reporting Lines

| ID | Requirement | Source | Code status |
|---|---|---|---|
| S-05.1 | Transfers/promotions via position change requests | `POSITION_MANAGEMENT_V1.1.md` | Partial |
| S-05.2 | Employee reporting line (`hr_employees.manager_user_id`) reconciled with position relationships; HR-approved reconciliation | baseline C6; lifecycle D5 | **Missing** |
| S-05.3 | Additional-manager scoped visibility enforced in RLS | baseline C11 | Missing (API-only) |
| S-05.4 | Transfers recorded as effective-dated employment versions | S-01.7 | Missing |

## WS-06 Hybrid Attendance  *(details pending — PD-ATT-01…08)*

| ID | Requirement | Source | Code status |
|---|---|---|---|
| S-06.1 | Hybrid attendance: multiple capture channels feed one attendance record | Owner 2026-10-24 (D-011) | Partial: web/mobile clock exists (`source: 'web'`); no channel model |
| S-06.2 | **Normal attendance is auto-validated — no daily approval** | Owner 2026-10-24 (D-012) | Policy fields exist (`late_after_minutes`, `early_leave_before_minutes`, `attendance_flag`); no auto-validation rule engine |
| S-06.3 | Attendance remains operational data: never posts to Finance; only feeds payroll after approval | D-015, Finance readiness §2.3 | Consistent today |
| S-06.4 | Timesheets (existing) continue as period summaries | baseline | Implemented |

## WS-07 Mobile Clock In/Out  *(details pending — PD-ATT-02)*

| ID | Requirement | Source | Code status |
|---|---|---|---|
| S-07.1 | Mobile clock in/out for ESS users with onboarding gate | baseline | Implemented (`/hr/mobile/attendance`, `/api/hr/attendance/clock`) |
| S-07.2 | Mobile capture controls (e.g. location/device evidence) | Owner 2026-10-24 (scope title only) | Not implemented; requirements pending |

## WS-08 HR Manual Attendance and Corrections

| ID | Requirement | Source | Code status |
|---|---|---|---|
| S-08.1 | Employee correction requests with **controlled approval** | Owner 2026-10-24 (D-013) | Partial: `hr_attendance_corrections` + `/attendance/corrections` + review route (schema-aligned); approver model to confirm (PD-ATT-04) |
| S-08.2 | HR manual attendance entry (on behalf of employee) with reason and audit trail | Owner 2026-10-24 | **Missing** |
| S-08.3 | Corrections never self-approved; original values preserved | Governance principle | Original values stored; self-approval check to verify in B4b |

## WS-09 Excel Bulk Attendance Import  *(details pending — PD-ATT-05)*

| ID | Requirement | Source | Code status |
|---|---|---|---|
| S-09.1 | Bulk import of attendance from Excel with validation, dry-run preview and per-row results | Owner 2026-10-24 | **Missing** |
| S-09.2 | Import is idempotent (file hash / row keys) and auditable | Existing pattern (bank statement import) | Missing |

## WS-10 Exception-based Attendance Review  *(details pending — PD-ATT-03)*

| ID | Requirement | Source | Code status |
|---|---|---|---|
| S-10.1 | System detects exceptions (e.g. late, early leave, missing clock-out, absence without leave) and only exceptions are reviewed | Owner 2026-10-24 (D-012) | **Missing** (no detection job) |
| S-10.2 | Review queue for HR and managers (MSS) with resolution outcomes | Owner 2026-10-24 | Missing |

## WS-11 Overtime Approval

| ID | Requirement | Source | Code status |
|---|---|---|---|
| S-11.1 | **OT approval is separate from attendance** | Owner 2026-10-24 (D-014) | Separate table `hr_overtime_requests` exists |
| S-11.2 | OT request submit/approve API works against the real schema; requester never self-approves | Payroll risk assessment P6 | **Broken** (column drift; requester auto-approval) |
| S-11.3 | Approved OT (with day type and frozen multiplier) is the sole OT source for payroll | Payroll risk assessment §3 | Not implemented (payroll reads timesheets) — PD-OT-03 |
| S-11.4 | Manager (MSS) approval of team OT | MSS model | Missing — PD-OT-01 |

## WS-12 Leave Management

| ID | Requirement | Source | Code status |
|---|---|---|---|
| S-12.1 | Leave containment: no impersonated insert, no self-approval, narrowed read | Remediation L1–L3 | **Open P0** |
| S-12.2 | ESS leave form works (leave types load) | Remediation L4 | **Broken** |
| S-12.3 | Server-side workflow: apply, approve/reject (multi-level, delegation), cancel | Leave design | Missing (client-direct writes; Approval Flow is mock) |
| S-12.4 | Append-only leave ledger (days only) and balance projection | Leave design; Finance readiness A5 | Missing |
| S-12.5 | Entitlements (Employment Act minima, service tiers, proration), carry-forward, expiry, year-end close | Leave design §4 | Config JSON only |
| S-12.6 | Public holidays by state with replacement days | Leave design §3 | Partial (template load broken: `category` column) |
| S-12.7 | Unpaid leave and encashment exposed to payroll (no money in leave ledger) | Finance readiness §2.5 | Missing |

## WS-13 ESS and MSS

| ID | Requirement | Source | Code status |
|---|---|---|---|
| S-13.1 | ESS: own profile (hybrid edit), attendance, leave, payslips | baseline | Implemented (leave form broken, S-12.2) |
| S-13.2 | MSS: team, attendance, leave, requests, performance, compensation viewer — explicit grants, never title-derived | baseline; D-004 | Implemented (read) |
| S-13.3 | MSS actions: approve team leave, OT, exceptions | Leave design; WS-10/11 | Missing |

## WS-14 Performance and KPI

| ID | Requirement | Source | Code status |
|---|---|---|---|
| S-14.1 | KPI module, appraisals, reviews, goals, KPI reporting | baseline | Implemented (strongest area); UAT pending |
| S-14.2 | Development plans, calibration, succession | baseline (P2) | Deferred (not HR Core V1) |

## WS-15 Commission

| ID | Requirement | Source | Code status |
|---|---|---|---|
| S-15.1 | Staff sales commission cycles with SoD, snapshots, reports, payroll-ready outbox | `STAFF_COMMISSION.md` | Implemented; migrations recorded applied |
| S-15.2 | Commission reaches payroll only through the outbox; expense recognised only via payroll | Finance roadmap D10 (proposed) | Outbox has no consumer (Phase B) |

## WS-16 HR Reporting and Navigation

| ID | Requirement | Source | Code status |
|---|---|---|---|
| S-16.1 | No mock screens in navigation (Leave Approval Flow) | Remediation N5 | Open |
| S-16.2 | Expose real hidden features (Payroll Runs, Public Holidays, Attendance sub-features) | Remediation N2–N4 | Open |
| S-16.3 | Unreachable modules show explicit "not available" instead of generic dashboard | Remediation N1 | Open |
| S-16.4 | Navigation gate equals API permission (e.g. HR Accounting) | Remediation N8 | Open |
| S-16.5 | HR Reporting group (headcount & movement, leave liability, attendance exceptions, KPI) | Remediation §3.2 | Missing |

## WS-17 Canonical S&A Integration

| ID | Requirement | Source | Code status |
|---|---|---|---|
| S-17.1 | S&A is the single authorization authority | D-004 | Architecture in place |
| S-17.2 | HR Permissions screen no longer edits the legacy store; points to S&A | S&A plan L-A | Open |
| S-17.3 | Remove `() => true` and inline role-level evaluators from HR routes | S&A plan L-B | Open (32 + 14 routes) |
| S-17.4 | Production HR keys moved SHADOW → enforced in waves with parity evidence | S&A plan §5 | Not started; prod modes NOT VERIFIED since 2026-10-02 |
| S-17.5 | Retire legacy compatibility policies for HR keys after explicit grants | S&A plan L-C | Controls migration `20261215110000` untracked/unapplied |
| S-17.6 | New keys for leave management/view and sensitive profile | S&A plan §3 | Proposed (PD-SA-01) |

## WS-18 Finance-Ready HR Foundation

| ID | Requirement | Source | Code status |
|---|---|---|---|
| S-18.1 | HR Core captures complete, reliable, approved/locked financial-source data; ordinary attendance never posts | D-001, D-002, D-015 | Principle |
| S-18.2 | Employment versions with department and nullable cost-centre slot (A1) | Finance roadmap A1 | Missing |
| S-18.3 | Compensation non-overlap + change log (A2) | A2 | Missing |
| S-18.4 | Allowance/deduction type → payroll component link (A3) | A3 | Missing |
| S-18.5 | Statutory profile capture (A4) = S-01.6 | A4 | Missing |
| S-18.6 | Leave ledger in days (A5) = S-12.4 | A5 | Missing |
| S-18.7 | Separation data (A6) = S-03.5 | A6 | Missing |
| S-18.8 | Final/locked statuses on HR financial sources (A7) | A7 | Partial |
| S-18.9 | Payroll fail-closed and second payroll GL route disabled (A8) | A8 | Open |
| S-18.10 | Finance owns accounting master data; HR references it | D-010 | Principle; HR currently seeds GL accounts |

## Future phases (separate from HR Core)

| ID | Item | Phase |
|---|---|---|
| F-PAY | Payroll rebuild (statutory engine, component detail, run types, consumption markers, canonical GL bridge) | Phase B |
| F-FIN | Shared Finance Integration Framework (posting requests, acceptance, worker, GL hardening, cost centres) | Phase C |
| F-X | Supply chain, expenses/benefits, e-commerce, marketplace, inventory adoption | Phase D |
| F-HR2 | Recruitment, Learning, Benefits, Compliance Docs, Time & Expense, Onboarding module, rostering | Deferred (not HR Core V1; not removed from long-term scope) |
