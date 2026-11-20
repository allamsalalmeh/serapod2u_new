# HR — Recommended Implementation Sequence

Branch `Enhancement03` @ `82da8cd0` · 2026-10-24 · **proposal only — awaiting explicit owner approval before any implementation, migration or S&A change.**

Companion reports: `HR_REMEDIATION_DEPENDENCY_MATRIX.md` (Task A + matrix), `HR_SA_CONSOLIDATION_PLAN.md` (B), `HR_LEAVE_IMPLEMENTATION_DESIGN.md` (C), `HR_EMPLOYEE_LIFECYCLE_GAP_REVIEW.md` (D), `HR_PAYROLL_RISK_ASSESSMENT.md` (E). Task F (navigation & reporting) is in §3 of this document.

Conventions for every phase
- New migrations are stamped **after `20261218100000`**, unique version, idempotent, with prerequisites asserted in a `do $pre$` block, rollback SQL in the header, and a replica suite under `supabase/tests/security/<name>/` (pattern already used by `hr_employee_delete`, `identity_archive_release`).
- Migrations are applied by the owner, staging first, recorded in `PRODUCTION_MIGRATION_STATUS.md` in the same commit.
- No S&A permission/policy/mode change without a separate owner decision.
- Nothing touches canonical identity, the controlled Delete/Reset functions' guarantees, or S&A as the single authority.

---

## 1. Sequence at a glance

| Phase | Name | Type | Size | Can start after | Production-blocking? |
|---|---|---|---|---|---|
| **P0** | Environment truth & freeze | read-only | S | approval | yes (gate for all) |
| **P1** | Apply already-written lifecycle + S&A migrations | owner SQL | S | P0 | yes for People actions |
| **P2** | Containment hotfixes (leave guard, payroll fail-closed, hide mock/duplicate GL) | code + 1 migration | M | P0 (parallel with P1) | **yes — ship first** |
| **P3** | HR S&A consolidation | code + catalog + owner flips | M | P1, P2 | yes |
| **P4** | Leave management server workflow | code + migration | L | P2, P3 (new keys) | yes for leave go-live |
| **P5** | Employee lifecycle completion (a: reporting lines, b: offboarding, c: history + statutory profile, d: former-employee docs) | code + migrations | L | P1 (P5b also P4) | yes for payroll go-live |
| **P6** | Payroll statutory engine & canonical GL | code + migrations + parallel run | XL | P3, P4, P5c | yes for payroll go-live |
| **P7** | Navigation & reporting | code | M | quick wins with P2; rest after P4/P6 | partially |

Go-live slicing (recommended): **Release A** = P0–P3 + P5a + P7 quick wins (People, Attendance, Performance, Commission usable, safely). **Release B** = P4 (+P5b) (Leave). **Release C** = P5c + P6 + certification (Payroll).

---

## 2. Phase detail

### P0 — Environment truth & freeze (read-only)

| Item | Detail |
|---|---|
| Scope | (1) On staging and production, read-only check of effects for migrations `20261211…20261218` and untracked S&A files; (2) production `sa_migration_modes` for `hr.%`, `legacy_authorization.read_only`, shadow parity for `hr.%`; (3) count of rows in `hr_leave_requests/balances`, `hr_payroll_runs/items`, `hr_overtime_requests`, `hr_public_holidays` per org (to size data fixes); (4) generate a column-contract diff: every `from('hr_*')` key in `app/src` vs the catalog dump; (5) correct the stale "Pending" row for `20261003100000` in the status doc. |
| Affected files | `PRODUCTION_MIGRATION_STATUS.md` (doc only), new `supabase/diagnostics/hr_remediation_readonly.sql` |
| Dependencies | none |
| Migrations | none |
| Risks | Production read access policy (earlier audits were refused by tool policy) → owner runs the script |
| Acceptance | Signed table of applied/not-applied per environment; list of HR keys by mode; column-contract diff reviewed |
| Tests | n/a (diagnostic is `BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;`) |
| Rollback | n/a |

### P1 — Apply already-written migrations (owner)

| Item | Detail |
|---|---|
| Scope | Lifecycle: `20261214100000` → `20261216100000_identity_permanent_deletion` → `20261217100000` → `20261218100000`; optional `20261215120000`. S&A (independent): commit untracked files, then `20261215110000` → `20261216100000_sa_legacy_preview_scope_coverage` (re-stamp to `20261216110000` before first apply). Others (`20261211`, `20261212`, `20261213`, `20261215100000`) on their own track. Re-stamp untracked `20261022100000_core_system_preferences` before it is ever applied. |
| Affected files | migration files (stamp only for never-applied ones), status doc |
| Dependencies | P0 |
| Migrations | the listed files — no new SQL |
| Risks | Version collisions confuse any filename-based runner (no ledger exists); app already calls these RPCs |
| Acceptance | Replica suites `hr_employee_delete`, `identity_permanent_delete`, `identity_archive_release`, `sa_legacy_cutover` pass on staging copy; HR People row menu actions work on staging; status doc updated |
| Tests | existing replica suites; `HrPeopleView.*.test.tsx`; `api/identity/*` route tests |
| Rollback | per-file rollback sections (functions dropped, audit tables kept); `sa_set_migration_mode(...,'SHADOW')` for 20261215120000 |

### P2 — Containment hotfixes (ship before any further feature)

| Item | Detail |
|---|---|
| Scope | **Leave:** `hr_leave_requests_transition_guard` trigger + narrowed SELECT (own / direct reports / `hr.leave.approve`) — design §10 of leave report; fix `HrMobileLeave` type query and team scope. **Payroll:** fix column contract in calculate/approve/payslips/preview, fail run on any line error, correct audit columns, fix `hr_settings` keying, exclude employees whose `hr_employees.status` is `resigned/terminated` or `end_date < period_start`, block **approve** while `payroll.statutory_certified` is false. **GL:** `/api/hr/finance/post-payroll-run` → 410. **OT requests:** fix column contract, forbid requester auto-approval. **Holidays:** drop `category` from inserts, mark Thaipusam as state-scoped. **Seeds:** disable `default_leave_types`/`default_approval_chain` actions until P4. **Nav:** hide Leave → Approval Flow (mock). **CI:** duplicate-migration-version check + column-contract test. |
| Affected files | `components/hr/mobile/HrMobileLeave.tsx`, `api/hr/payroll/runs/[id]/{calculate,approve}/route.ts`, `api/hr/payroll/statutory-settings/route.ts`, `api/hr/accounting/preview-journal/route.ts`, `components/hr/modules/HrPayrollPayslipsView.tsx`, `lib/api/payroll.ts`, `api/hr/finance/post-payroll-run/route.ts`, `api/hr/attendance/overtime/requests/route.ts`, `api/hr/public-holidays/route.ts`, `api/hr/config/audit/route.ts`, `modules/hr/hrNav.ts`, CI config |
| Dependencies | P0 (row counts decide whether existing leave rows need status cleanup) |
| Migrations | `20261219100000_hr_leave_containment_guard.sql` (trigger + policy replacement; previous policy text in header) |
| Risks | Existing leave rows in non-standard statuses; managers approving via mobile lose org-wide reach (intended) |
| Acceptance | SQL replica: impersonated insert, approved-status insert, self-approval all refused; manager approves direct report; non-report refused. Payroll: calculated run has N lines for N eligible employees or fails with per-employee errors; approve blocked with provisional message. |
| Tests | new replica `hr_leave_containment/`; route tests for calculate/approve with schema-shaped fixtures; column-contract test; `hrNav.test.ts` |
| Rollback | drop trigger, restore policies from header; revert app commit |

### P3 — HR S&A consolidation

See `HR_SA_CONSOLIDATION_PLAN.md` §5 for the owner procedure.

| Item | Detail |
|---|---|
| Scope | (a) HR Permissions → read-only S&A panel; legacy store API writes → 410; readiness/AI checks re-pointed; (b) new keys `hr.leave.manage`, `hr.leave.view`, `hr.employee.view_sensitive` (+ optional `hr.mss.overtime_approve`), no compat rule, LEGACY_RETIRED from birth, added to standard HR policies by explicit decision; (c) replace 32 `() => true` evaluators and inline `role_level` checks; (d) owner: explicit grants, per-key SHADOW → NEW_ENFORCED waves on production; (e) owner: retire `legacy-power-user`, `legacy-hq` (HR keys) via `sa_retire_legacy_compat_role` after impact review. |
| Affected files | `HrSettingsPermissionsView.tsx`, `api/hr/settings/permissions/route.ts`, `lib/server/hr/seedPermissions.ts`, `api/hr/config/audit/route.ts`, `lib/ai/hrAudit.ts`, `lib/server/hrAccess.ts`, `lib/server/nav-access.ts`, 32+14 HR routes, `lib/security-access/{route-coverage,policy-dependencies,nav-access}.ts` |
| Dependencies | P1 (`20261215110000` reports), P2 |
| Migrations | `2026122xxxxxxx_sa_hr_leave_keys.sql` (catalog + readiness + standard-policy membership) |
| Risks | Hidden users losing access at flip time; mis-scoped grants |
| Acceptance | see S&A plan §5 acceptance |
| Tests | route-coverage gate, `nav-access.test.ts`, route deny/allow/cross-org tests, replica `sa_hr_keys/` |
| Rollback | revert commits; `sa_set_migration_mode(...,'SHADOW')`; `sa_restore_legacy_compat_role` |

### P4 — Leave management

Full design in `HR_LEAVE_IMPLEMENTATION_DESIGN.md`.

| Item | Detail |
|---|---|
| Scope | P4a data model + functions + ledger + RLS lockdown; P4b `/api/hr/leave/*` + UI switch (delete `MockLeaveRepository`) + MSS approval; P4c entitlement grant, year-close, carry-forward expiry job, statutory seeds, public-holiday data per state |
| Affected files | `modules/hr/leave/*`, `components/hr/modules/HrLeave*.tsx`, `components/hr/mobile/HrMobileLeave.tsx`, `HrMobileHome.tsx`, `components/hr/workspace/HrManagerWorkspaceView.tsx`, new `app/api/hr/leave/**`, `lib/server/hr/leave/*`, `lib/server/hr/assistant/tools.ts`, cron registration in `lib/cron-scheduler.ts` |
| Dependencies | P2, P3 |
| Migrations | `hr_leave_workflow` (additive columns, ledger, runs, functions, RLS), opening-balance backfill, seeds |
| Risks | Opening balances; state holiday accuracy; approver resolution with unreconciled lines (do P5a first if possible) |
| Acceptance | No client writes to `hr_leave_*`; ledger sum = projection for all employees; replica + route + quote tests green; UAT: apply → manager approve → HR view → cancel → year-close |
| Tests | see leave design §12 |
| Rollback | see leave design §13 |

### P5 — Employee lifecycle completion

Detail table in `HR_EMPLOYEE_LIFECYCLE_GAP_REVIEW.md` §4. Order: **P5a** (reporting-line reconciliation; can run right after P1, ideally before P4b) → **P5b** (archive hardening + scheduled separation; after P4) → **P5c** (employment history + statutory profile; before P6) → **P5d** (former-employee documents; after P6).

### P6 — Payroll

Detail table in `HR_PAYROLL_RISK_ASSESSMENT.md` §9: P6a statutory rate sets + PCB engine → P6b DB calculation function (components, proration, OT from approved requests, unpaid leave, commission import, maker ≠ checker) → P6c canonical GL + statutory remittance reports → certification parallel run (≥ 2 months) → owner flips `payroll.statutory_certified`.

### P7 — Navigation & reporting (Task F)

See §3.

---

## 3. Navigation & reporting assessment (Task F)

### 3.1 Findings

| # | Type | Finding | Evidence |
|---|---|---|---|
| N1 | Unreachable | App pages exist but render the generic dashboard: `hr/analytics/overview`, `benefits/overview`, `compliance-docs/overview`, `learning/overview`, `onboarding/overview`, `recruitment/{jobs,applicants,interviews,offers}`, `self-service/overview`, `time-expense/overview` — no `DashboardContent` case. Page destinations (`hr/analytics/overview`) also differ from `HR_DESTINATIONS` ids (`hr/analytics`). | `app/hr/*/page.tsx`; `DashboardContent.tsx:879-990`; `lib/security-access/nav-access.ts:95-101` |
| N2 | Hidden real feature | **Payroll runs** (create/calculate/approve/post) live inside "Payslips" — no nav entry says so | `HrPayrollPayslipsView.tsx:240` |
| N3 | Hidden real feature | **Public Holidays**: destination + view case exist, no sidebar entry, no page route | `nav-access.ts:70`, `DashboardContent.tsx:924` |
| N4 | Embedded feature | Shifts, overtime rules, corrections are inside Clock In/Out (`OvertimeRulesCard`) — discoverable only there | `HrAttendanceClockView.tsx:32` |
| N5 | Mock screen | Leave → Approval Flow uses `MockLeaveRepository` | `HrLeaveApprovalFlowView.tsx:79` |
| N6 | Misleading screen | HR Settings → HR Permissions edits a non-authoritative store | S&A plan L-A |
| N7 | Duplicates | Departments and Positions under People **and** HR Settings (same components); legacy top-level routes `app/hr/{departments,positions,org-chart}` + view ids `hr-people/hr-org-chart/hr-departments/hr-positions/hr-settings` duplicate `hr/people/*` | `hrNav.ts:97-98,146-147`; `DashboardContent.tsx:879-902`; `nav-access.ts:386-393` |
| N8 | Gate mismatch | Nav `hr/settings/accounting` requires `hr.settings.manage`; its APIs require `finance.payroll_integration.manage` → users see a screen whose calls 403 (or holders of the finance key cannot find it) | `nav-access.ts:92`; `api/hr/accounting/*` |
| N9 | Reporting reality | `HrAnalyticsView` is a manual KPI-definition/report catalogue (`hr_kpi_definitions`, `hr_reports`, `hr_kpi_snapshots`), not workforce analytics; exposing it as "HR Reporting" yields an empty screen | `api/hr/analytics/*` |
| N10 | MSS | Manager approvals for leave/OT not surfaced (no API until P4) | `api/hr/mss/leave` read-only |

### 3.2 Recommended target navigation

| Group | Entries (✅ keep · ➕ expose · ➖ remove/hide) |
|---|---|
| My Workspace | ✅ My Workspace, My Attendance, My Leave, My Payslips; ➕ Team Approvals (after P4) for MSS holders |
| People | ✅ Employees, Organization Chart, Departments, Positions (canonical home) |
| Attendance | ✅ Clock In/Out, Timesheets; ➕ Shifts, Overtime, Corrections (split existing view sections — same components) |
| Leave | ✅ Types, Requests; ➕ Public Holidays (P2/P7), Balances & Calendar (P4); ➖ Approval Flow until P4b |
| Payroll | ✅ Salary Structure, Allowances/Deductions, Commission Settings; ➕ **Payroll Runs** (same view, own entry); Payslips; ➕ Statutory Settings (after P6a) |
| Performance | ✅ KPIs, Appraisals, Reviews |
| HR Settings | ✅ Approval Rules, Configuration; ➖ Departments/Positions duplicates (redirect to People); Accounting re-gated to `finance.payroll_integration.manage`; HR Permissions → read-only S&A panel |
| HR Reporting (new, after P4/P6) | Headcount & movement (from `hr_employees` + `hr_employee_versions`), Leave liability (ledger), Payroll summary & statutory remittance (P6c), KPI reports (existing `kpi/reports/*`); existing KPI catalogue as a sub-page |
| Deferred (stay hidden) | Recruitment, Learning, Benefits, Compliance Docs, Time & Expense, Onboarding module — redirect their pages to `/hr` with "Not available yet" instead of the generic dashboard |

### 3.3 P7 phase detail

| Item | Detail |
|---|---|
| Scope | Quick wins (with P2): hide Approval Flow; expose Public Holidays and Payroll Runs entries; re-gate Accounting; deferred pages show an explicit "not available" state. Later: remove Settings duplicates with redirects; legacy `hr-*` view ids map to `hr/people/*`; Attendance sub-entries; HR Reporting group after P4/P6; Team Approvals after P4. |
| Affected files | `modules/hr/hrNav.ts`, `modules/hr/components/HRTopNav.tsx`, `components/dashboard/DashboardContent.tsx`, `lib/security-access/nav-access.ts`, `lib/server/nav-access.ts`, `app/hr/**/page.tsx`, `modules/hr/components/HrLandingView.tsx` |
| Dependencies | P2 (quick wins), P4, P6 (reporting content) |
| Migrations | none |
| Risks | Bookmarked URLs to removed duplicates → keep redirects |
| Acceptance | Every sidebar entry renders its feature or an explicit unavailable state; no page renders the generic dashboard by accident; each entry's destination permission equals its API permission |
| Tests | `hrNav.test.ts`, `pages.access.test.tsx`, `HrLandingView.access.test.tsx`, `nav-access.test.ts`, new test asserting every `app/hr/**/page.tsx` initialView has a `DashboardContent` case or an explicit unavailable state |
| Rollback | revert commit |

---

## 4. Recommended first approval request

Approve **P0 (read-only diagnostics) and P2 (containment)** together. They are small, independently reversible, close the two live exposures (self-approved leave, false "calculated" payroll runs), and produce the facts (applied migrations, production modes, row counts) that P1 and P3 need. P1 (owner SQL) can run as soon as P0 confirms the target state.

Nothing in this document has been implemented. Awaiting explicit owner approval per phase.
