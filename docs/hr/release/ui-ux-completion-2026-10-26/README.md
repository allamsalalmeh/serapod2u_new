# Serapod2U HR — Wave 1–3 UI/UX completion & owner UAT readiness (2026-10-26)

Back to [HR_MASTER_INDEX.md](../../HR_MASTER_INDEX.md) · UAT guides: [Wave 1 + 2](../../uat/HR_WAVE1_WAVE2_COMPREHENSIVE_UAT.md) · [Wave 3](../../uat/HR_WAVE3_UAT.md) · release packages: [Wave 2](../wave2-employment-foundation-2026-10-25/README.md) · [Wave 3](../wave3-attendance-overtime-leave-2026-10-25/README.md)

Branch `Enhancement03`, HEAD `b6b78002` + uncommitted changes. **No git staging, commit, push, deployment, staging SQL, S&A grant or HR configuration was made.** Other workstreams' uncommitted files (S&A, Inventory, Identity, E-Commerce, Finance, Navigation) were not edited, except one scoped HR registration line in `DashboardContent.tsx` (see §2).

## 1. Wave 1–3 feature → UI navigation map

Legend: ✅ reachable through normal UI · 🆕 made reachable in this session · ⚙️ owner action outside HR (People & Access) · ⛔ intentionally not in UI.

### People (Wave 2)

| Function | Where (menu path) | Who | Status |
|---|---|---|---|
| Employee list, search, tabs (Onboarded / Awaiting onboarding / Archived) | HR → People → Employees | HR (`hr.employee.view`) | ✅ |
| Register / onboard (Add Employee, link existing user) | Employees → *Add Employee* / *Awaiting onboarding* tab | HR (`hr.employee.manage`) | ✅ |
| HR Profile (personal, ID & Tax, emergency, bank) | Employees → click name → HR Profile sheet | HR; statutory by HR only, never own | ✅ |
| **Work state** (drives state holidays) | HR Profile → ID & Tax → *Work state* | HR | 🆕 (column existed, no UI) |
| Employment history (effective-dated) | HR Profile → *History* | HR, employee (own) | ✅ |
| **Effective-dated employment change** (transfer, manager, type, status, probation) | HR Profile → History → *Record employment change* | HR, never own | 🆕 (was console only, HI-02) |
| **Own employment history** | My Workspace → My Employment → *Show my employment history* | Employee | 🆕 (was console only, HS-01) |
| Department / position / manager (inline, bulk) | Employees → row pencil / bulk bar | HR | ✅ |
| Reporting-line check & reassignment | Employees → *Reporting-line check* | HR | ✅ |
| Departments, positions, org chart | HR → People → Departments / Positions / Organization Chart | HR; staff chart for directory holders | ✅ |
| Lifecycle: archive & revoke, remove / reset registration, permanent delete, bulk removal | Employees → row ⋯ menu | HR + identity permissions | ✅ (🔴 destructive) |

### Attendance (Waves 1 + 3)

| Function | Where | Who | Status |
|---|---|---|---|
| Employee clock in / out (server time), history, corrections, missing day | My Workspace → My Attendance (`/hr/mobile/attendance`) | ESS | ✅ |
| Employee overtime request (worked / plan ahead) | My Attendance → *Overtime* | ESS | ✅ |
| Daily board | HR → Attendance → **Attendance Operations** → Operations → *Daily board* | HR (`hr.attendance.manage`) | ✅ (menu renamed from "Clock In / Out") |
| Exceptions & review queue (check range, acknowledge / excuse / dismiss, confirm manual entry) | … → *Exceptions* | HR | ✅ |
| Corrections & approvals (incl. HR adjustment maker-checker) | … → *Corrections* | HR (never own) | ✅ |
| HR manual entry | … → *Manual entry* (or *Add entry* on the board) | HR, second HR confirms | ✅ |
| Excel bulk import (template, preview, commit, discard, history) | … → *Excel import* | HR | ✅ |
| Overtime approvals (partial, reject with reason, HR cancel) | … → *Overtime* | HR (never own) | ✅ |
| Attendance report + CSV | … → *Report* | HR | ✅ |
| Attendance policy, overtime rules, shifts | Attendance Operations → **Policy & shifts** tab | HR | 🆕 grouped (was stacked under operations) |
| HR person's own clock | Attendance Operations → **My clock-in** tab | HR as employee | 🆕 grouped |
| Deep links to every tab | `/hr/attendance/clock-in-out?tab=board│exceptions│corrections│manual│import│overtime│report│setup│my` | — | 🆕 |
| Timesheets | HR → Attendance → Timesheets | HR | ✅ |
| **Public holidays** (national / state / per Federal Territory) | HR → Attendance → **Public Holidays** | view: HR settings or attendance; edit: HR settings | 🆕 page (URL was 404; checklist link was dead) |
| Manager team attendance view | My Workspace → My Team (MSS) | MSS | ✅ (decisions HR-only: SA-R6/R7 keys do not exist) |

### Leave (Waves 1 + 3)

| Function | Where | Who | Status |
|---|---|---|---|
| Apply (database working-day quote, balance after, blocking errors) | My Leave → *Apply* | ESS | ✅ |
| **Withdraw own pending request** | My Leave → Requests → *Withdraw request*; HR staff also on the HR screen | ESS | 🆕 (LV-08 had no UI) |
| Manager approvals | My Leave → *Approvals* tab | MSS direct manager | ✅ |
| HR approval work queue | HR → Leave Management → **Leave Requests & Approvals** (pending count → filter) | HR (`hr.leave.approve`) | ✅ (Approve/Reject now visible without hover) |
| **HR cancellation of approved leave** (ledger reversal) | same → request card → *Cancel leave* | HR, never own | 🆕 (W3-LV-05/LV-08 had no UI) |
| HR "New Request" for themselves with database quote | same → *New Request* | HR as employee | 🆕 quote (was browser-only count; fake attachment drop zone removed) |
| Balances & ledger, set entitlement, adjust ± | HR → Leave Management → **Balances & Entitlements** (`?tab=balances`) | HR | 🆕 own menu entry + tab (was inline above the queue) |
| Entitlement run / carry-forward **preview** | Balances & Entitlements → *Preview entitlement run…* / *Preview carry-forward…* | HR | ✅ |
| Entitlement run / carry-forward **apply** | same dialog → reason **and** "explicit owner authorization" checkbox | HR, owner-authorized | 🆕 separated (🔴 company-wide) |
| Leave types (paid/unpaid, tiers, carry-forward) | HR → Leave Management → Leave Types | HR | ✅ |
| Leave reports | — | — | ⛔ none implemented beyond balances/ledger (deferred, §3) |

### Payroll · Performance · HR Settings (preserved)

| Item | Verified status | Action |
|---|---|---|
| Payroll: Salary Structure, Allowances/Deductions, Payslips, Commission | functional (B2B fail-closed; approval locked until statutory certification) | unchanged (no Phase B work) |
| Performance: KPIs, Appraisals, Reviews | functional screens | unchanged |
| HR Settings → Approval Rules | saves organization defaults that **no leave/attendance/OT decision reads** | kept, with an explicit notice and links to where those rules really live |
| HR Settings → Configuration | setup checklist; its "Public holidays" link now opens a real page | ✅ |
| Leave Approval Flow (mock) | already removed from the menu (B2B); URL shows an unavailable state | unchanged |
| HR landing cards | derived from the menu; descriptions corrected (no "approval flows") | 🆕 text |

## 2. HR UI/UX changes implemented (all uncommitted)

| File | Change |
|---|---|
| `app/src/modules/hr/hrNav.ts` | Attendance: "Attendance Operations", Timesheets, **Public Holidays**; Leave: "Leave Requests & Approvals", **Balances & Entitlements** (`?tab=balances`, gated by the leave-requests destination), Leave Types |
| `app/src/app/hr/attendance/public-holidays/page.tsx` (new) | server page with the standard S&A destination gate |
| `app/src/components/hr/modules/HrAttendanceClockView.tsx` | tabs Operations · Policy & shifts · My clock-in; `?tab=` deep links; honest toasts ("Not recorded", corrections reviewed by HR, not "your manager") |
| `app/src/components/hr/modules/HrAttendanceOperationsView.tsx` | controlled tabs with `initialTab`; refused/failed reads shown once in place with *Try again* (was up to four red toasts and "No … for this filter"); empty-state hints |
| `app/src/components/hr/modules/HrLeaveRequestsView.tsx` | tabs Requests & approvals · Balances & entitlements; Approve/Reject always visible; *Withdraw* (own pending) and *Cancel leave* (HR, approved, not own) with confirmation and stored-status check; database quote in New Request (submit blocked on quote errors); load error with retry; fake attachment zone replaced by an honest note |
| `app/src/components/hr/modules/HrLeaveBalancesPanel.tsx` | "Preview …" buttons; red company-wide notice; Apply needs reason **and** owner-authorization checkbox; empty states (no leave types / no employees); error with retry |
| `app/src/components/hr/mobile/HrMobileLeave.tsx` | *Withdraw request* on own pending/draft requests (stored status must be `cancelled`); approved → "only HR can cancel" |
| `app/src/components/hr/people/EmploymentHistoryPanel.tsx` | *Record employment change (effective-dated)* form for HR (only changed fields sent; no future date; status limited to active/probation/suspended; employee never offered as own manager) |
| `app/src/components/hr/HrPeopleView.tsx` | passes change options to the History tab (only when the profile is editable); **Work state** select on ID & Tax |
| `app/src/lib/hr/employment-messages.ts` | `work_state` mapped to the statutory profile; validated against the database code list (`WORK_STATES`) |
| `app/src/components/hr/workspace/HrMyWorkspaceView.tsx` | read-only *Show my employment history* |
| `app/src/components/hr/modules/HrPublicHolidaysView.tsx` | *Applies to* (national / state / each Federal Territory) instead of a client-only "category" that was never stored (a "State" holiday used to apply to everyone); column shows the real scope; edit controls only with HR settings authority (the API's own rule); load error state; template dialog shows only what is loaded |
| `app/src/components/hr/modules/HrSettingsApprovalRulesView.tsx` | notice: these defaults do not route approvals; links to policy, holidays, employees |
| `app/src/modules/hr/components/HrLandingView.tsx` | card descriptions; setup banner link `/hr/settings/configuration` (was `/dashboard?view=…`) |
| `app/src/components/dashboard/DashboardContent.tsx` | **one line** (HR view registration): `HrMyWorkspaceView … userId={userProfile.id}`; the navigation workstream's uncommitted hunks are untouched |
| `supabase/migrations/20261224100000_hr_w3_wp_holiday_alias.sql` | (prepared, NOT applied) per-territory spellings added for Labuan/Putrajaya; header documents scope |
| `supabase/tests/security/hr_attendance_overtime/60_wp_alias.sql` | WP7–WP12: Labuan/Putrajaya get `WP` holidays; KL/Labuan/Putrajaya-only holidays stay separate |

**New tests** (force-add on commit, `.gitignore` ignores `*.test.*`): `modules/hr/hrNav.routes.test.ts` (every menu link opens an existing page and has a registered S&A destination), `app/hr/attendance/public-holidays/page.access.test.tsx`, `components/hr/modules/{HrAttendanceClockView.tabs,HrAttendanceOperationsView.states,HrLeaveRequestsView.workflow,HrLeaveBalancesPanel,HrPublicHolidaysView}.test.tsx`, `components/hr/mobile/HrMobileLeave.withdraw.test.tsx`, `components/hr/people/EmploymentChange.test.tsx`, `components/hr/workspace/HrMyWorkspaceView.history.test.tsx`.

## 3. Missing or intentionally deferred screens

| Item | Reason |
|---|---|
| Leave reports (utilisation, liability) | not implemented in Waves 1–3; balances/ledger screen is the reporting surface. Phase after UAT |
| Manager decisions on attendance corrections / exceptions / overtime | S&A keys `hr.mss.attendance_approve` / `hr.mss.overtime_approve` do not exist (BL-29, SA-R6/R7); HR decides |
| Per-employee shift assignment | not in the Wave 3 model (employee picks the shift at clock-in) |
| Leave attachments (medical certificates) | no storage design yet; the dialog now says so instead of showing a dead drop zone |
| Scheduled exception detection | no cron authorized (BL-32); HR uses *Check this range* |
| Carry-forward expiry | PD-LV-02 open |
| Payroll Phase B / Finance Phase C | out of scope by instruction |
| S&A grant UI | owned by People & Access (S&A workstream); grants are owner actions |

## 4. Verification results (2026-10-26)

The AI session cannot run anything natively on the Mac (the linked device shell is a 3 GB Linux VM with no package registry; `tsc` there would run out of memory). Checks were run in an **isolated Linux x64 copy** of the working tree with the Mac `node_modules`, plus Linux esbuild 0.28.2 and an acorn-based stand-in for Rollup's native parser (test harness only; never in the repository). No staging or production connection.

| Check | Result |
|---|---|
| Vitest — HR + navigation suites touched by this work (22 files incl. 10 new) | **all pass** (details: §4 of the tracker entry; new files 44 tests) |
| Vitest — full suite (692 files) | **6,722 pass / 3 fail / 9 skipped**; failures are non-HR: 2 × `ReportingView.overview` + 1 × `reporting/stats/drilldown` (reporting workstream's uncommitted code), plus 5 inventory suites that could not load because the isolated copy omitted `docs/runbooks` etc. (harness artefact). **All HR suites pass.** |
| `tsc --noEmit` (full project, 6 GB heap) | **completed** (no crash): exit 2, **250 errors in 83 files, 0 in HR files** — identical to the known non-HR baseline (BL-22) |
| `next build` | **NOT RUN** — needs the native SWC binary (`@next/swc-*`), unavailable offline for Linux. Owner: `bash docs/hr/release/b2a-staging-2026-10-24/local_verify_isolated.sh` on the Mac |
| Replica (PostgreSQL 16, staging snapshot 2026-10-16) — Wave 3 harness incl. WP alias | **417/417 PASS** |
| Replica (production snapshot, `--no-lifecycle`) | **374/374 PASS** |
| Mac `tsc` | still owner-run; the earlier exit 134 remains a crash, not a pass |

## 5. WP public-holiday migration (`20261224100000`) — recommendation

* **Scope (verified by diff against `20261222100000` §4):** only the Federal-Territory name lists inside `hr_att_day_type` change; signature, `security definer`, search path, grants (revoked from everyone), national-holiday and workday logic are identical. `hr_leave_working_dates` (leave quote and submission) calls the same function, so attendance, overtime and leave stay consistent.
* **Behaviour (replica WP1–WP12):** a holiday stored as `WP` / `W.P.` / `Wilayah Persekutuan` / `Federal Territory` applies to employees whose work state is KUL, LBN or PJY, and to nobody else; a holiday stored as `Kuala Lumpur`, `Labuan`, `W.P. Putrajaya`, `Wilayah Persekutuan Kuala Lumpur` … applies **only** to that territory — distinct schedules are not merged.
* **Needed before Leave UAT? No.** Staging has 0 captured work states, so only national holidays count today, with or without it. It matters only if a test account is given a Federal-Territory work state. Without SQL the owner can instead edit the single `WP` row in Public Holidays (*Applies to* = W.P. Kuala Lumpur, plus rows for Labuan/Putrajaya if wanted) — the new form stores the full names the existing function already matches.
* Keep it as a prepared, optional migration (E-47). Not applied anywhere.

## 6. HR test-account & S&A setup checklist (owner; nothing was granted by Coder AI)

| # | Account | Create / onboard | S&A policy (People & Access → user → assign, scope **HQ test company**) | HR data |
|---|---|---|---|---|
| 1 | **H1** HR admin | internal employee; HR → People → Employees → Add Employee | *Leave & Attendance Administrator* (`hr-leave-attendance-administrator`) **+** *HR Records Officer* (`hr-records-officer`) | onboarded |
| 2 | **H2** HR admin (checker) | same | same as H1 | onboarded |
| 3 | **M1** manager | same | *Manager Self-Service* (`manager-self-service`) | onboarded |
| 4 | **M2** manager without MSS | same | none | onboarded |
| 5 | **E1, E2, E3** employees | same | default Employee Self-Service only | onboarded; Reports To: E1, E2 → M1; E3 → M2; optional Work state (ID & Tax) |
| 6 | **L1** legacy-only admin | role level ≤ 20, no HR policy | none | — |
| 7 | **X1** other company | employee of another HQ company | default ESS | onboarded there |
| 8 | **N1** new hire | internal employee, not onboarded | none | awaiting onboarding |
| 9 | Root (owner) | existing | — | maintains Public Holidays / HR settings (needs `hr.settings.manage`) |

Then (HQ test company, 🟠 shared staging): Attendance Operations → *Policy & shifts* → review policy → *Save Policy*; *Add Shift* "UAT Office 09:00–18:00"; Leave Types → **Annual Leave** (paid, tiers, carry-forward) and **Unpaid Leave** (unpaid), both active; Public Holidays → confirm year; Balances & Entitlements → set Annual entitlement for E1/E2 only. Users log out/in after grants. Remove the grants after UAT if the accounts should not keep them.

## 7. Updated owner UAT guides

* `docs/hr/uat/HR_WAVE1_WAVE2_COMPREHENSIVE_UAT.md` — all console steps replaced by screens (AT-02/03, OT-01/02, HI-02, HS-01, OS-01, LV-08, PH-01); PY-03 optional technical; Wave 2 marked applied; leave-type precondition updated.
* `docs/hr/uat/HR_WAVE3_UAT.md` — screen map with direct URLs, short first-time setup, test sequence, 🔴/🟠 labels, all navigation renamed to the implemented menu.

## 8. Top 10 localhost scenarios to run first

1. **Setup smoke:** Root opens HR → Attendance → Attendance Operations (Daily board loads), Public Holidays (year shown), Leave Management → Balances & Entitlements (types/employees shown) — no 404, no "not installed".
2. **W3-AT-01/02** E1 clock in → second clock-in refused → clock out (My Attendance).
3. **W3-AT-05** E2 reports a missing day → H1 approves in Corrections.
4. **W3-HR-02** H1 manual entry for E3 → H1 cannot confirm → H2 confirms (maker-checker).
5. **W3-OT-01/03/05** E1 overtime → H1 approves part → H1's own request not in H1's queue.
6. **W3-IM-02/03** Excel import preview → commit → same file refused.
7. **W3-LV-03 → LV-01/02** H1 sets E2 entitlement → E2 applies Fri–Mon (quote = 2 working days) → overlap/weekend refused.
8. **W3-LV-05 + LV-08** M1/H1 approves → balance taken → H1 *Cancel leave* → reversed; E1 *Withdraw request* on a pending one.
9. **HI-02 / RL-01** H1 records a back-dated employment change for E3 (History) and changes E1's manager → reporting-line check clean; H1 cannot change own record.
10. **W3-SEC-01 / LV-07** L1 gets no attendance data/actions; entitlement-run **preview only** (authorization box left unticked).

## 9. Outstanding blockers that genuinely prevent owner UAT

| # | Blocker | Owner action |
|---|---|---|
| 1 | No explicit HR / MSS holders on staging (BL-23/BL-34): only Root can act as HR or manager | grant H1/H2/M1 as in §6 |
| 2 | No active leave types and no active shift on staging (BL-33) | create them through the screens in §6 |
| 3 | Test accounts must exist and be onboarded with managers (WH001 has 4 employees without a manager — do not use them) | §6 |
| 4 | `next build` and a completed Mac `tsc` have not been run natively | run `local_verify_isolated.sh` on the Mac before UAT sign-off (not blocking localhost `npm run dev`) |

Not blockers: the WP migration (§5), the old staging app build (UAT is on localhost by design), scheduled exception detection (manual *Check this range*).
