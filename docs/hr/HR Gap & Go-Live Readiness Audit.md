The audit is complete. I have gathered sufficient evidence from the repository, schema, migrations, tests, and documentation. Below is the comprehensive final report.

---

# Serapod2U HR Module — Gap & Go-Live Readiness Audit

## 0. Pre-flight verification

| Check | Result |
|---|---|
| `pwd` | `/Users/edierwan/serapod2u_dev` ✅ |
| `git branch --show-current` | `Enhancement03` ✅ |
| `git rev-parse HEAD` | `92022c446f2f87f39aca73ad6ceffd30fd78b7d4` ✅ |
| Remote URL | `https://github.com/edierwan/serapod2u_new.git` ⚠️ naming-only discrepancy |
| Working tree | 33 modified + ~12 untracked files (S&A + HR + settings) |
| HR controlled-delete work present | ✅ commit `17c84ab73`, migration `20261214100000_hr_employee_controlled_delete.sql` (committed) + `20261215120000_sa_hr_employee_delete_mode_retired.sql` (untracked) |

> **Caveat (verified, non-blocking):** the local checkout directory and branch match the corrected target exactly (`serapod2u_dev` / `Enhancement03`). Only the `origin` remote *label* still reads `serapod2u_new.git`. I did **not** switch anything and audited only the local checkout as instructed. If you later want the remote renamed, that is a separate `git remote set-url` action outside this read-only scope.

**Automated-test validation performed (read-only):** `142` HR tests across `23` files pass, plus `90` S&A tests across `5` files pass (`hrNav`, `position-workflow`, `staff-org-chart`, `mss`, `compensation-viewer`, `hr-data-catalog`, `ess-eligibility`, `commission`, `nav-access`, `stage2c-conversions`, `employees`, `registration`, `self-service`, `data-management`, `position-slots`, `org-chart/staff`, `mss/*`, `accounting/actions`). Runtime/UAT (live DB) is **not verifiable from this environment** — the migrations are documented as "apply manually" and "not applied to any environment."

---

## REPORT A — Executive Summary

**Overall maturity: "broad foundation, uneven completion."** Serapod2U has a genuinely deep HR data model (`102,467`-line schema, ~115 `hr_*` tables) and a disciplined, S&A-first authorization architecture. The **strongest, most production-shaped areas are Performance/KPI and the employee identity/onboarding lifecycle**. The **weakest are Leave Management (admin UI is partly mock, no server API), the orphaned submodules (Recruitment/Learning/Benefits/Compliance/Time & Expense/Analytics are unreachable), and Payroll statutory/GL depth.**

**Strengths**
- One canonical identity (`public.users`) with a separate employment anchor (`public.hr_employees`) — correctly decoupled.
- S&A is the single authorization authority; `hrCan`/`hrCanIn`/`hrSelfCan` + `sa_rls_gate` RLS with legacy-fallback, and explicit (non-title-derived) ESS/MSS/compensation-viewer grants.
- Go-live gating exists (`hr_go_live_state`, `hr_mark_go_live()`).
- Controlled Employee Delete/Reset is mature (break-glass S&A permission, preview token, idempotency, append-only audit, row locks).
- Strong test coverage on the security-critical paths (232 tests pass in sampled runs).

**Weaknesses / go-live risks**
1. **Leave admin is effectively not operational** — no `/api/hr/leave` server API; desktop Types/Requests do direct client-Supabase writes, and the **Approval Flow screen is wired to an in-memory mock** (`HrLeaveApprovalFlowView` → `getLeaveRepository()`).
2. **A second, legacy HR permission system** (`hr_permissions` / `hr_access_groups*`) is still surfaced in HR Settings → HR Permissions, contradicting the "one S&A" principle.
3. **Six submodules are "orphaned"** — routes + APIs + components exist but are not wired into `DashboardContent`, so their pages render the generic dashboard.
4. **Statutory payroll is simplified** (flat rates + a 3-tier PCB approximation), not full EPF/SOCSO/EIS/PCB tables; two overlapping GL-posting RPCs exist.
5. **Employee vs position reporting lines are not reconciled** (documented open gap).
6. **Migrations are un-applied** in any environment per the docs — nothing here is "live".

**Bottom line:** do not treat the HR module as go-live ready. Core identity/onboarding + Performance + Commission are closest; Leave, Payroll statutory/GL, and navigation completeness must be closed first.

---

## REPORT B — Complete Feature Inventory

Legend: `IMPLEMENTED` / `PARTIAL` / `BACKEND ONLY` / `UI ONLY` / `MISSING` / `DUPLICATED` / `BLOCKED` / `UNKNOWN`.

### People

| Submodule | UI | API | DB | S&A | Tests | Status | Evidence |
|---|---|---|---|---|---|---|---|
| Employees (master data) | ✅ `HrPeopleView` | ✅ `/api/hr/employees` GET/POST, `candidates`, `profile` | ✅ `hr_employees`, `users` | `hr.employee.view`/`hr.employee.manage` | ✅ | **IMPLEMENTED** | `route.ts`, `route.identity.test.ts`, `HrPeopleView.registration.test.tsx` |
| Employee onboarding | ✅ (in Employees view) | ✅ `provisionIdentity`+`hr_onboarding_complete` | ✅ `hr_employees.onboarding_status` | `hr.employee.manage` | ✅ | **IMPLEMENTED** | `HR_ONBOARDING_AND_DATA_RESET.md`, `route.identity.test.ts` |
| Employee profile | ✅ self/manager edit | ✅ `/api/hr/employees/profile`, `/self-service/profile` | ✅ | own+`hr.employee.manage` | ✅ | **IMPLEMENTED** | `profile-edit.ts`, `profile/route.test.ts` |
| Offboarding (resign/terminate) | ⚪ | ⚪ | 🟡 `status` enum only | — | — | **PARTIAL** (data field, no workflow) | `hr_employees.status` CHECK |
| Employment history | ⚪ | ⚪ | 🟡 position versions only | — | — | **MISSING** (no `hr_employee_versions`) | schema |
| Employee transfers / promotion | 🟡 via position change requests | ✅ `position-change-requests` | ✅ `hr_position_assignments` | `hr.employee.manage` | ✅ | **PARTIAL** | `position-workflow.ts` |
| Salary revision history | ⚪ | ⚪ | 🟡 compensation current-state | — | — | **MISSING** | `hr_employee_compensation` |
| Employee documents | 🟡 compliance-docs (orphaned) | ✅ `compliance/*`, `self-service/document-requests` | ✅ `hr_document_requests`, `hr_policies` | `hr.policy.manage` | — | **PARTIAL/BACKEND** | `compliance/*` |
| Position management | ✅ `HrPositionManagementView` | ✅ `position-slots`, `job-classifications`, `positions` | ✅ `hr_position_slots` etc. | `hr.employee.manage` | ✅ 14+12 | **PARTIAL** (D3/D4/D6 UI gaps) | `POSITION_MANAGEMENT_V1.1.md` |
| Reporting-line mgmt | ✅ (position relationships) | ✅ | ✅ `hr_position_relationships` | — | ✅ | **PARTIAL** (no employee↔position reconciliation) | docs §3 |
| Departments | ✅ `HrDepartmentsView` | ✅ (shared `departments`) | ✅ `departments` | `hr.employee.view`/`hr.settings.manage` | — | **IMPLEMENTED** (shared SC table) | `DashboardContent.tsx` |
| Org chart | ✅ admin + staff | ✅ `org-chart/staff`, `position-slots/org-chart` | ✅ | `hr.employee.view` / staff directory | ✅ 5+4 | **IMPLEMENTED** | `staff-org-chart.ts`, tests |

### Attendance

| Submodule | UI | API | DB | S&A | Tests | Status | Evidence |
|---|---|---|---|---|---|---|---|
| Clock In/Out | ✅ | ✅ `/attendance/clock` | ✅ `hr_attendance_entries` | `hr.self_service.use` (+onboarding gate) | — | **IMPLEMENTED** | `clock/route.ts` |
| Timesheets | ✅ | ✅ `timesheets` + submit/approve/reject | ✅ `hr_timesheets` | `hr.attendance.manage` | — | **IMPLEMENTED** | `timesheets/*` |
| Shift management | ✅ (admin) | ✅ `shifts` | ✅ `hr_shifts` | `hr.attendance.manage` | — | **IMPLEMENTED** | `shifts/route.ts` |
| Rostering / scheduling | ⚪ | ⚪ | ⚪ | — | — | **MISSING** | no `hr_roster*` table |
| Overtime mgmt | 🟡 `OvertimeRulesCard` | ✅ `overtime/*`, `requests`, `preview` | ✅ `hr_overtime_*` | `hr.attendance.manage` | — | **PARTIAL** | `overtime/route.ts` |
| Attendance corrections | ✅ | ✅ `corrections` + review | ✅ `hr_attendance_corrections` | `hr.attendance.manage` | — | **IMPLEMENTED** | `corrections/*` |
| Late / early departure | ⚪ | ⚪ | ⚪ | — | — | **MISSING** | no detection |
| Absence management | ⚪ | ⚪ | ⚪ (only leave) | — | — | **MISSING** | — |
| Attendance exceptions (auto) | ⚪ | ⚪ | ⚪ | — | — | **MISSING** | — |
| Attendance approval | 🟡 (timesheet+cxn only) | ✅ | ✅ | — | — | **PARTIAL** | — |
| Attendance→Payroll | 🟡 inline in calc | ✅ (reads entries) | ✅ | — | — | **PARTIAL** | `runs/[id]/calculate/route.ts` |

### Leave Management

| Submodule | UI | API | DB | S&A | Tests | Status | Evidence |
|---|---|---|---|---|---|---|---|
| Leave Types | ✅ (client Supabase) | ❌ no `/api/hr/leave` | ✅ `hr_leave_types` | RLS only | — | **PARTIAL** (client-direct) | `HrLeaveTypesView.tsx`, `supabaseRepository.ts` |
| Leave Requests | ✅ (client Supabase) | ❌ | ✅ `hr_leave_requests` | RLS only | — | **PARTIAL** | `HrLeaveRequestsView.tsx`, `HrMobileLeave.tsx` |
| Approval Flow | ✅ but **mock data** | ❌ | ✅ tables | — | — | **UI ONLY** | `HrLeaveApprovalFlowView.tsx` → `getLeaveRepository()` |
| Entitlements / balances | ✅ read (mobile) | ❌ | ✅ `hr_leave_balances` | RLS | — | **BACKEND ONLY** (no server calc) | `assistant/tools.ts` |
| Leave calendar | ⚪ | ⚪ | ⚪ | — | — | **MISSING** | — |
| Carry forward | 🟡 config only | ❌ | 🟡 config JSON | — | — | **BACKEND ONLY** (no processing) | `hr_leave_types.carry_forward` |
| Encashment | ⚪ | ⚪ | ⚪ | — | — | **MISSING** | — |
| Delegation | ✅ (mock UI) | ❌ | ✅ `hr_delegation_rules` | — | — | **UI ONLY** | `HrLeaveApprovalFlowView.tsx` |
| Public holiday integration | ✅ `HrPublicHolidaysView` | ✅ `public-holidays` | ✅ `hr_public_holidays` | — | — | **IMPLEMENTED** | `public-holidays/route.ts` |
| Leave→Payroll | ⚪ | ⚪ | ⚪ | — | — | **MISSING** (calc ignores leave) | `calculate/route.ts` |

### Payroll

| Submodule | UI | API | DB | S&A | Tests | Status | Evidence |
|---|---|---|---|---|---|---|---|
| Salary structure | ✅ | ✅ `compensation`, `salary-bands` | ✅ `hr_employee_compensation`, `hr_salary_bands` | `hr.compensation.view` | — | **IMPLEMENTED** | `payroll/compensation` |
| Allowances/Deductions | ✅ | ✅ `allowance-types`, `deduction-types`, `employee-*` | ✅ | `hr.compensation.view` | — | **IMPLEMENTED** | `lib/api/payroll.ts` |
| Payslips | ✅ | ✅ `self-service/payslips`, `payslip-access` | ✅ `hr_payslip_access_logs` | `hr.payroll.view` / ESS | — | **IMPLEMENTED** | `self-service/payslips` |
| Payroll runs + approval | ✅ | ✅ `runs`, `calculate`, `approve` | ✅ `hr_payroll_runs`, `_items` | `hr.payroll.prepare`/`approve`/`release` | — | **IMPLEMENTED** | `runs/*` |
| Payroll cut-off | ⚪ | ⚪ | ⚪ | — | — | **MISSING** | — |
| Statutory (EPF/SOCSO/EIS/PCB) | 🟡 settings | ✅ `statutory-settings` | 🟡 `hr_settings` | `hr.compensation.manage` | — | **PARTIAL** (flat rates + 3-tier PCB) | `calculate/route.ts:67-133` |
| Payroll adjustments | ⚪ | ⚪ | ⚪ | — | — | **MISSING** | — |
| Payroll reports | ⚪ | ⚪ | ⚪ | — | — | **MISSING** | — |
| Payroll→GL | 🟡 `HrAccountingView` | ✅ `post-to-gl`, `finance/post-payroll-run`, `accounting/*` | ✅ `hr_gl_mappings`, `hr_gl_postings` | `hr.payroll.release` | — | **PARTIAL / DUPLICATED** (2 RPCs) | `post-to-gl`, `finance/post-payroll-run` |
| Commission | ✅ `CommissionSettingsView` | ✅ `commission/*` (full) | ✅ `hr_commission_*` | `hr.commission.*` (5 perms) | ✅ | **IMPLEMENTED** | `STAFF_COMMISSION.md`, `commission.test.ts` |

### Performance

| Submodule | UI | API | DB | S&A | Tests | Status | Evidence |
|---|---|---|---|---|---|---|---|
| KPIs | ✅ `HrKpiModuleView` (9 tabs) | ✅ `/api/hr/kpi/*` (30+ routes) | ✅ `hr_kpi_*` | `hr.performance.manage` | ✅ | **IMPLEMENTED (strongest)** | `kpi/*` |
| Appraisals | ✅ | ✅ `performance/appraisals` | ✅ `hr_appraisal_cycles` | `hr.performance.manage` | — | **IMPLEMENTED** | `appraisals/route.ts` |
| Reviews | ✅ | ✅ `performance/reviews`, `templates` | ✅ `hr_performance_reviews`, `hr_review_templates` | `hr.performance.manage` | — | **IMPLEMENTED** | `reviews/route.ts` |
| Goal tracking | ✅ (objectives/targets) | ✅ | ✅ | — | — | **IMPLEMENTED** | `kpi/objectives`, `targets` |
| Development plans / training recs | ⚪ | ⚪ | ⚪ | — | — | **MISSING (P2)** | — |
| Performance reporting | ✅ KPI reports | ✅ `kpi/reports/*` | ✅ | — | — | **IMPLEMENTED** | `kpi/reports` |

### HR Settings

| Submodule | UI | API | DB | S&A | Tests | Status | Evidence |
|---|---|---|---|---|---|---|---|
| Departments | ✅ | shared | shared | `hr.settings.manage` | — | **DUPLICATED** (People + Settings) | `hrNav.ts:97,146` |
| Positions | ✅ | shared | shared | `hr.settings.manage` | — | **DUPLICATED** (People + Settings) | `hrNav.ts:98,147` |
| Approval Rules | ✅ | (via `config/audit`) | ✅ `hr_approval_chains` | `hr.settings.manage` | — | **PARTIAL** (leave chain UI mock) | `HrSettingsApprovalRulesView` |
| HR Permissions | ✅ | ✅ `settings/permissions` | ⚠️ `hr_permissions` (legacy) | ⚠️ separate system | — | **DUPLICATED/legacy** | `seedPermissions.ts`, `legacy-stores.ts` |
| Accounting | ✅ | ✅ `accounting/*` | ✅ `hr_control_accounts`, `hr_gl_mappings` | `finance.payroll_integration.manage` | ✅ | **IMPLEMENTED** | `HrAccountingView` |
| Configuration | ✅ | ✅ `config/audit` | ✅ `hr_settings` | `hr.settings.manage` | — | **IMPLEMENTED** | `HrConfigurationView` |
| Data Management | ✅ | ✅ `data-management/*` | ✅ `hr_reset_*`, `hr_go_live_state` | `hr.data.reset` | ✅ 7 | **IMPLEMENTED** | `data-management/route.test.ts` |

### HR Reporting (proposed)

| Submodule | UI | API | DB | S&A | Tests | Status | Evidence |
|---|---|---|---|---|---|---|---|
| Analytics overview | ✅ `HrAnalyticsView` (orphaned) | ✅ `analytics/{kpis,reports,snapshots}` | ✅ `hr_reports` | `hr.analytics.view` | — | **BACKEND ONLY** (not navigable) | `HrAnalyticsView.tsx` not wired |
| Workforce/headcount reports | 🟡 KPI reports only | ✅ KPI summary/heatmap | ✅ | — | — | **PARTIAL** | `kpi/reports/*` |

---

## REPORT C — Missing & Partial Features

| # | Problem | Root cause / missing impl | Business impact | Priority | Proposed solution | Source files |
|---|---|---|---|---|---|---|
| C1 | Leave admin is not a real workflow | No `/api/hr/leave` API; Approval Flow uses `MockLeaveRepository`; Types/Requests do client-direct writes | Leave approvals, balances, carry-forward not trustworthy; S&A not enforced server-side | **P0** | Build server leave API (apply/approve/reject/balance update) using existing `hr_leave_*` tables; wire admin views to it; gate with `hrCan('hr.leave.approve')` | `modules/hr/leave/repository.ts`, `supabaseRepository.ts`, `HrLeaveApprovalFlowView.tsx` |
| C2 | Second HR permission system | `hr_permissions`/`hr_access_groups*` legacy store surfaced in HR Settings → HR Permissions | Conflicting access sources; violates "one S&A" | **P0** | Retire/read-only the legacy store everywhere; make HR Settings → Permissions deep-link to `/security-access` | `settings/permissions/route.ts`, `seedPermissions.ts`, `legacy-stores.ts` |
| C3 | 6 submodules render the generic dashboard | Routes+APIs+components exist but no `case` in `DashboardContent` switch | Recruitment/Onboarding/Learning/Benefits/Compliance/Time-Expense/Analytics unreachable | **P1** | Either wire components into `DashboardContent` or remove from nav/destinations; never leave blank | `DashboardContent.tsx:1061 default`, `app/hr/*/page.tsx` |
| C4 | Simplified statutory payroll | Flat EPF/SOCSO/EIS + 3-tier PCB approximation | Non-compliant Malaysia payroll | **P0 (for payroll go-live)** | Implement EPF age-tier + SOCSO/EIS wage-band tables and MTD (PCB) function; add tests | `runs/[id]/calculate/route.ts:67-133` |
| C5 | Duplicate GL posting RPCs | `post_payroll_run_to_gl` and `hr_post_payroll_run_to_gl` | Ambiguous source of truth, double-posting risk | **P1** | Choose one canonical posting path; remove/deprecate the other | `payroll/post-to-gl`, `finance/post-payroll-run` |
| C6 | Employee vs position reporting divergence | `users.manager_user_id` vs `hr_position_relationships` not reconciled | MSS/leave/payroll manager may disagree with org chart | **P0** | Reconcile script + guard: sync `users.manager_user_id` from active PRIMARY incumbent | `POSITION_MANAGEMENT_V1.1.md §3`, `hr03/hr04` migrations |
| C7 | No employment effective-dating | No `hr_employee_versions`; only position versions | Salary/job history lost; no audit trail for compensation changes | **P1** | `hr_employee_versions` + as-of queries (reuse position pattern) | docs §2 |
| C8 | No offboarding workflow | `status` enum only; no UI/API | Resignation/termination can't be processed safely | **P1** | Offboarding action (status + end date + exit checklist) reusing controlled-delete guards | `hr_employees.status` |
| C9 | Rostering, late/early, exceptions, absence | Not implemented | Attendance incomplete for operations | **P2** | Defer; model after leave/attendance foundations stabilize | — |
| C10 | Leave→payroll (unpaid leave) | Payroll calc ignores leave | Unpaid-leave not deducted | **P1** | Feed approved unpaid leave into `calculate` | `calculate/route.ts` |
| C11 | Scoped additional-manager visibility is API-only | No RLS predicate for additional managers | Least-privilege gap at DB layer | **P1** | Add RLS predicates mirroring `position-management` additional-manager scope | `POSITION_MANAGEMENT_V1.1.md §7` |
| C12 | Duplicated Departments/Positions | Same components under People and HR Settings | Confusing nav | **P1** | Canonicalize one entry (see Report D) | `hrNav.ts:97-98,146-147` |

---

## REPORT D — Navigation & Dashboard Assessment

**Current nav (single source of truth `hrNav.ts`):** My Workspace, People, Attendance, Leave Management, Payroll, Performance, HR Settings — matching the recommended 7-area structure, with **Payroll containing "Commission Settings"** (not a top-level card; appears as a Payroll child link on the landing card — the "missing card" observation is because Commission has no dedicated card, only a nested link, gated by `hr.commission.view`).

**Destinations defined but not in navigation (`nav-access.ts` HR_DESTINATIONS):** `hr/recruitment`, `hr/learning`, `hr/onboarding`, `hr/benefits`, `hr/compliance-docs`, `hr/analytics`, `hr/time-expense`, `hr/self-service/overview`, plus the `hr/my-team*` MSS destinations (those render inside My Workspace).

**Duplicated entries:** Departments and Positions appear under **both** People and HR Settings (identical components `HrDepartmentsView` / `HrPositionManagementView`). Recommend **one canonical administration workflow**: keep read/operational views under **People**, keep configuration under **HR Settings** — or collapse to People-only and delete the Settings duplicates.

**Missing shortcuts (backend exists, not navigable):** Analytics (HR Reporting), Onboarding, Recruitment, Learning, Benefits, Compliance Docs, Time & Expense. Recommendation per your 7-area target:
1. **People** — keep Employees / Org Chart / Departments / Positions (canonical).
2. **Attendance** — keep Clock In/Out, Timesheets; add **Shifts**, **Overtime**, **Corrections** as sub-items (they already have APIs/UI components).
3. **Leave** — keep Types/Requests/Approval Flow (once real); add **Public Holidays** (already built, currently only reachable via a dashboard `case` not in nav).
4. **Payroll** — keep Salary/Allowances/Payslips; add **Payroll Runs** and **Commission** explicitly.
5. **Performance** — keep KPIs/Appraisals/Reviews.
6. **HR Settings** — Departments, Positions, Approval Rules, HR Permissions (→ S&A), Accounting, Configuration.
7. **HR Reporting** — **new top-level group** wiring the existing `HrAnalyticsView` + `/api/hr/analytics/*` (reuse, no new engine).

**Defer/exclude** (do not expose now): Recruitment, Learning, Benefits, Compliance Docs, Time & Expense — they are un-wired and would be empty/half pages until completed; keep them out of nav until a decision is made (Report J, batch 3).

---

## REPORT E — Employee Lifecycle Assessment

**Verified lifecycle model (correct as designed):**
1. **One canonical identity** — `public.users` is the single identity; `provisionIdentity` creates login + membership + ESS baseline; `hr_employees` is the separate **employment anchor** (employee number, hire date, department/position/manager/employment type/status, `onboarding_status`).
2. **Registration ≠ login** — `onboarding_status` (`pending`/`completed`/`reset`) is HR registration state; login/S&A/Supply Chain are never touched by onboarding.
3. **Supply Chain users onboarded to HR** — Add Employee reuses the existing identity (`hr_onboarding_complete`, same user id, stable employee number).
4. **Email/phone resolution** — `identity_resolve` normalization + `identity_conflicts`; name matching is never used for matching.
5. **Stable employee numbers** — `hr_employees.employee_no` (integer), projected onto `users` via `identity_hr_project_to_users`; delete/reset never renumbers.
6. **Consistency of manager/dept/position** — projection trigger keeps `users.*` in sync from `hr_employees`.
7. **Controlled Delete/Reset** — `/api/hr/employees/registration` (GET preview + POST execute), break-glass `hr.employee.delete` (`hr-employee-record-administrator`), preview token, idempotent `request_id`, per-employee advisory locks, `FOR KEY SHARE` on employment row, append-only `hr_employee_registration_actions`, blocked when HR is live or self or has dependents/reports.

**Gaps (exact):**
- **E1 (P0):** employee (`users.manager_user_id`) vs position (`hr_position_relationships`) reporting lines can diverge — no reconciliation job/guard.
- **E2 (P1):** no employment effective-dating — compensation/position/job history is not versioned (`hr_employee_versions` absent); salary revision history is missing.
- **E3 (P1):** offboarding is a status enum only — no resignation/termination action, exit checklist, or "offboarding must not delete access/history" workflow (delete/reset already respects this, but a true offboard action does not exist).
- **E4 (verified OK):** delete/reset correctly **preserves** login, `users`, memberships, S&A assignments, employee number, HR history, SC/Finance/audit rows — does not cascade into system access.

---

## REPORT F — Operational Integration Assessment

**Workflow A (clock → attendance → timesheet → exceptions → approved):** Clock In/Out and timesheet submit/approve/reject are implemented server-side. **Missing:** automatic exception detection, late/early flags, rostering, a single "approved attendance" aggregate feeding payroll. Attendance→payroll currently reads raw entries inside `calculate` (partial, manual handoff).

**Workflow B (OT → manager approval → calc → payroll → payslip):** Overtime policy/rules/presets + requests + preview exist (`hr_overtime_*`); payroll `calculate` reads overtime minutes. **Missing:** no explicit manager-approval step for OT in the payroll input path (requests exist but are not enforced as a gate), and no OT-cost reporting.

**Workflow C (leave → approval → balance → unpaid → payroll):** **Broken/partial.** Leave apply exists (client-direct), but server approval, balance mutation, unpaid-leave flagging, and payroll deduction are all absent (see C1/C10).

**Workflow D (payroll prepare → calculate → approve → statutory → payslip → GL):** Runs (draft→calculated→approved) + calculate + approve + payslip + two GL posting paths exist. **Missing/partial:** statutory depth (C4), cut-off, adjustments, payroll reports, and a single canonical GL path (C5). Commission has a payroll-transfer **outbox** (`hr_commission_payroll_transfers`) but nothing posts it — manual handoff.

**Source-of-truth tables (verified):** identity `users`; employment `hr_employees`; attendance `hr_attendance_entries`; leave `hr_leave_requests`; compensation `hr_employee_compensation`; payroll `hr_payroll_runs`/`hr_payroll_run_items`; GL `hr_gl_mappings`/`hr_gl_postings`; commission `hr_commission_cycles`/`_items`.

---

## REPORT G — Security & Access Assessment

**Correctly implemented:**
- Canonical S&A: `authorizeOperation` + `hrCan`/`hrCanIn`/`hrSelfCan`; `sa_rls_gate` RLS with legacy-fallback; org-scoped, `hrCanIn` evaluates against the **target** row's org (not caller's).
- ESS/MSS/Compensation-viewer are **explicit grants**, never title-derived (`mss.ts`, `compensation-viewer.ts`, `ess-eligibility.ts`).
- Payroll confidentiality: column grants (`20261105100000_hr_compensation_column_grants.sql`), payslip access logging, compensation viewer excludes net/banking/EPF/payslip.
- Cross-org isolation: employees/positions routes use `hrCanIn`; other-org employees report "not found".
- Controlled delete is break-glass, S&A-only, no compatibility/delegation/backfill.

**Gaps / mismatches:**
- **G1 (P0):** legacy `hr_permissions`/`hr_access_groups*` system still writable-exposed in HR Settings → HR Permissions (read-only switch exists but the UI still targets it).
- **G2 (P1):** Leave admin writes are client-direct (Supabase client) and rely on RLS only — no server-side `hrCan('hr.leave.approve')` (inconsistent with the rest of HR).
- **G3 (P1):** additional-manager scoped visibility enforced at API layer only, not RLS.
- **G4 (verified OK):** HR reporting/analytics API is gated (`hr.analytics.view`); but the view is unreachable (C3), so the permission is currently moot.

---

## REPORT H — Go-Live Readiness Matrix

| Area | Architecture | Functional | Security | Data integrity | Workflow | Tests | Migrations applied | Verdict |
|---|---|---|---|---|---|---|---|---|
| Identity/Onboarding | PASS | PASS | PASS | PASS | PASS | PASS | NOT VERIFIED | **PASS (conditional)** |
| People/Org/Positions | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | PASS | NOT VERIFIED | **PARTIAL** |
| Attendance | PASS | PARTIAL | PASS | PASS | PARTIAL | PARTIAL | NOT VERIFIED | **PARTIAL** |
| Leave | PARTIAL | FAIL | PARTIAL | PARTIAL | FAIL | FAIL | NOT VERIFIED | **FAIL** |
| Payroll | PARTIAL | PARTIAL | PASS | PARTIAL | PARTIAL | PARTIAL | NOT VERIFIED | **PARTIAL** |
| Performance/KPI | PASS | PASS | PASS | PASS | PASS | PASS | NOT VERIFIED | **PASS** |
| Commission | PASS | PASS | PASS | PASS | PARTIAL (posting) | PASS | NOT VERIFIED | **PASS (conditional)** |
| HR Settings | PARTIAL | PARTIAL | FAIL (legacy perms) | PARTIAL | PARTIAL | PARTIAL | NOT VERIFIED | **PARTIAL** |
| HR Reporting | BACKEND | FAIL (unreachable) | PASS | PASS | — | — | NOT VERIFIED | **FAIL** |
| Orphaned submodules | BACKEND | FAIL | PARTIAL | PARTIAL | — | — | NOT VERIFIED | **FAIL (not exposed)** |

> "Migrations applied" is **NOT VERIFIED** across all areas: the docs state the HR/position/commission migrations must be applied manually and are not yet applied to staging/production. This is a hard deployment blocker independent of code quality.

---

## REPORT I — Recommended Implementation Roadmap

**P0 (must complete before go-live):**
1. **Leave server API + real approval workflow** (C1) — Medium complexity, ~4–6 routes + `hr_leave_balances` update + tests.
2. **Retire legacy HR permission system** (C2) — Low/Medium; route HR Settings → Permissions to S&A.
3. **Reporting-line reconciliation** (C6) — Medium; SQL job + guard + tests.
4. **Malaysia statutory payroll** (C4) — Medium/High; statutory tables + MTD function + tests.
5. **Navigation: expose real features, hide/defer orphans** (C3/D) — Low; `hrNav.ts` + `DashboardContent` wiring.

**P1 (high-value after core stability):**
- Canonical GL posting path (C5); leave→payroll unpaid deduction (C10); employment effective-dating + salary history (C7/E2); offboarding workflow (C8/E3); additional-manager RLS (C11); de-duplicate Departments/Positions (C12).

**P2 (future/optional):**
- Rostering, late/early + exceptions, absence mgmt (C9); development plans/calibration/succession; benefits/compliance/learning/recruitment completion.

---

## REPORT J — Proposed Implementation Batches (do not implement yet)

**Batch 1 — Leave backend to parity (P0).**
- Scope: `/api/hr/leave` (types/requests/approve/reject/balances/carry-forward), wire admin + mobile views to it, replace mock.
- Dependencies: none.
- Files: `modules/hr/leave/*`, `components/hr/modules/HrLeave*`, `components/hr/mobile/HrMobileLeave`, `lib/server/hr/leave*`.
- DB: use existing `hr_leave_*`; add balance ledger + carry-forward RPC.
- S&A: `hr.leave.approve`, `hr.self_service.use`.
- Acceptance: end-to-end apply→approve→balance→(unpaid) with server `hrCan`; no client-direct writes.
- Regression: existing self-service/MSS tests + new leave route tests.
- Rollback: revert routes; tables already exist.

**Batch 2 — S&A consolidation + navigation cleanup (P0).**
- Scope: read-only the legacy `hr_permissions` UI; wire Analytics + Attendance sub-items into nav; hide orphans; de-duplicate Departments/Positions.
- Files: `hrNav.ts`, `DashboardContent.tsx`, `HrSettingsPermissionsView`, `nav-access.ts`.
- DB: none (or `sa_legacy_authorization_read_only` enforcement).
- S&A: no new perms; verify `hr.analytics.view` etc.
- Acceptance: no blank pages; single canonical dept/position entry; HR Permissions deep-links to S&A.
- Regression: `pages.access.test.tsx`, `hrNav.test.ts`, `nav-access.test.ts`.

**Batch 3 — Payroll statutory + canonical GL (P0/P1).**
- Scope: EPF/SOCSO/EIS/PCB tables+functions; single GL posting RPC; unpaid-leave deduction.
- Files: `api/hr/payroll/runs/[id]/calculate`, `post-to-gl`/`finance/post-payroll-run`, `lib/server/hr/payroll*`.
- DB: new `hr_statutory_*` tables + `hr_employee_versions` (P1) + RPC consolidation.
- S&A: `hr.payroll.prepare/approve/release`, `finance.payroll_integration.manage`.
- Acceptance: statutory figures match known test vectors; one GL path with reversal.
- Regression: payroll + accounting tests.
- Rollback: drop new tables/RPC; restore old RPC.

**Batch 4 — Lifecycle completion (P0/P1).**
- Scope: reporting-line reconciliation job, offboarding action, employment effective-dating + salary history, additional-manager RLS.
- Files: `lib/server/hr/position-*`, `api/hr/employees/*`, new offboarding API, `supabase/migrations`.
- DB: reconciliation RPC + `hr_employee_versions` + offboarding columns.
- S&A: `hr.employee.manage`, `hr.employee.delete`.
- Acceptance: manager/dept/position never diverge; resignation preserves access+history; salary history auditable.
- Regression: `position-workflow.test.ts`, `registration/route.test.ts`, `stage2c-conversions.test.ts`.

---

### Final determination
The HR system is **not go-live ready** today. Its identity/onboarding and Performance/KPI foundations are strong and reusable; Leave, Payroll statutory/GL, the legacy permission duplication, and the un-wired navigation are the concrete blockers. The highest-leverage first move is **Batch 1 (Leave backend)** plus **Batch 2 (S&A + navigation cleanup)**, which convert the largest "looks done but isn't" risks into genuinely operational features without touching the working identity/S&A/Supply Chain core.