# Serapod2U HR — Wave 1 + Wave 2 Comprehensive UAT Guide (owner-run, localhost)

Back to [HR_MASTER_INDEX.md](../HR_MASTER_INDEX.md) · release packages: [Wave 1 (B2A/B2B)](../release/b2a-staging-2026-10-24/README.md) · [Wave 2 (employment foundation)](../release/wave2-employment-foundation-2026-10-25/README.md)

Prepared 2026-10-25 (MYT) on branch `Enhancement03`, HEAD `b6b78002` + uncommitted HR changes. **Not executed by Coder AI.** Every PASS/FAIL box is for the owner.

---

> **UI reconciliation (2026-10-26, evening):** every step of this guide now uses a screen. Console steps were replaced: AT-02/AT-03 → Attendance Operations → Corrections; OT-01/OT-02 → My Attendance → Overtime + Attendance Operations → Overtime; HI-02 → HR Profile → History → *Record employment change*; HS-01 → My Workspace → *Show my employment history*; OS-01 → screens (console optional); LV-08 → *Withdraw request* (My Leave) and *Cancel leave* (HR); PH-01 → HR → Attendance → Public Holidays. PY-03 is an optional technical check. Menu names changed: **Attendance Operations** (was "Clock In / Out"), **Leave Requests & Approvals**, new **Balances & Entitlements** and **Public Holidays**. Screen map and first-time setup: [Wave 3 guide, top](HR_WAVE3_UAT.md). Labels: 🔴 destructive / company-wide (separate authorization) · 🟠 changes shared-staging data (test accounts only).

> **Wave 3 update (2026-10-25):** the working tree now also contains Wave 3 (attendance, overtime, leave ledger). With Wave 3 code, **AT-01, AT-02, AT-03, OT-01 and OT-02 need the Wave 3 migrations on staging** and are superseded by [HR_WAVE3_UAT.md](HR_WAVE3_UAT.md) (W3-AT-01, W3-AT-05/06, W3-OT-01…05 — screens instead of the console step of AT-02). Leave tests LV-01…LV-10 still apply; with Wave 3B installed the database additionally sets the working days and posts the ledger (W3-RG-01).

## 0. Read this first (safety)

| ⚠️ | Rule |
|---|---|
| **Shared database** | Localhost (`npm run dev` with `app/.env.local`) talks to the **shared KVM2 staging Supabase** (`serapod-stg-db`). Every click in this guide changes **real staging rows** that other workstreams also use. |
| **Test accounts only** | Use only the dedicated test accounts in §2. Never approve, archive, reset or delete a real person. |
| **Announce the window** | Tell the S&A, Identity, E-Commerce, System Logs, Navigation and Finance owners before you start (BL-12). |
| **🔴 DESTRUCTIVE** | Tests marked **🔴 DESTRUCTIVE — separate authorization** change data that cannot simply be undone (archive, permanent delete, HR reset). Do **not** run them unless you have separately authorized that test, on test accounts only. |
| **Wave 2 migration** | `20261221100000_hr_employment_foundation.sql` is **applied and verified on staging** (2026-10-26, 26/26 function bodies). NA-01 ("not installed" state) can therefore only be observed on a database without Wave 2 — mark it *Not run (Wave 2 installed)*. |
| **App build** | Run the **current working tree** on localhost. The deployed staging app (Coolify) is the old build without Wave 1/2 fixes (KVM2 diagnostic 2026-10-25: no B2A/B2B markers). |
| **Production** | Nothing here touches production. |

## 1. Suggested UAT order

1. **§3 Preconditions** (P-01 … P-08) — accounts, grants, build.
2. **Part A — Wave 1** (migration already applied on staging 2026-10-24, verified 12/12 on 2026-10-25): S&A visibility → Leave (web) → Leave (mobile) → Attendance corrections / Timesheets / OT → Payroll safety → Audit/messages.
3. Owner applies Wave 2 migration to staging (release README W-3), re-runs the post-apply check (W-4).
4. **Part B — Wave 2**: Employee registration/linking → Profile → Department/position → Reporting lines → Org scope → History → Offboarding guard → Regression of Part A leave tests LV-03/LV-04 after a reporting-line change.
5. **Part C — destructive tests** only with separate authorization.
6. **Part D — regression sweep** (quick re-check of the most important Wave 1 tests after Wave 2).
7. Report results with the template in §9.

## 2. Test accounts (create once; all in the staging HQ company unless stated)

| Code | Purpose | Account type | S&A policy (People & Access → assign, **scope: HQ company**) | HR setup |
|---|---|---|---|---|
| **E1** | Employee | Internal employee, HQ | none beyond the default Employee Self-Service | Onboarded (HR → People → Add Employee), manager = **M1** |
| **E2** | Employee reporting to M1 | Internal employee, HQ | default ESS | Onboarded, manager = **M1** |
| **E3** | Employee reporting to M2 | Internal employee, HQ | default ESS | Onboarded, manager = **M2** |
| **M1** | Line manager **with** MSS | Internal employee, HQ | **Manager Self-Service** (`manager-self-service`) | Onboarded |
| **M2** | Line manager **without** MSS | Internal employee, HQ | none | Onboarded |
| **H1** | HR administrator (explicit) | Internal employee, HQ | **Leave & Attendance Administrator** (`hr-leave-attendance-administrator`) **and** **HR Records Officer** (`hr-records-officer`) | Onboarded |
| **H2** | Second HR administrator (for "HR cannot change own record") | Internal employee, HQ | same as H1 | Onboarded |
| **P1** | Payroll preparer | Internal employee, HQ | HR & Payroll Full Access (`hr-payroll-full-access`) | Onboarded |
| **L1** | Legacy-only admin (must NOT get HR authority) | HQ admin role level ≤ 20, **no explicit HR policy** (legacy compatibility only) | none | — |
| **X1** | Other-company employee | Internal employee in **another HQ company** | default ESS | Onboarded in that company |
| **N1** | New hire for onboarding tests | Internal employee account, HQ, **not onboarded** | none | Awaiting onboarding |
| **F1** | Former employee (only for Part C) | Internal employee, HQ | none | Onboarded, later archived in C-01 |

Record the email of each account in the table of §9. Never use a real person.

## 3. Preconditions

| ID | Precondition | How to check | ☐ |
|---|---|---|---|
| P-01 | Mac working tree contains the Wave 1 + Wave 2 HR changes (see release manifest) | `git status --short -- docs/hr app/src` shows the HR files | ☐ |
| P-02 | Native checks pass on the Mac | `bash docs/hr/release/b2a-staging-2026-10-24/local_verify_isolated.sh` → Vitest only the known non-HR failure (`orders/[orderId]/ship-metrics`); tsc 0 HR errors; build succeeds | ☐ |
| P-03 | Localhost started against staging | `cd app && npm run dev` → open `http://localhost:3000` | ☐ |
| P-04 | B2A migration verified on staging | KVM2 output `out-20261025-001019`: 12/12 PASS (already done) | ☐ |
| P-05 | Test accounts of §2 exist and can sign in | Sign in once with each | ☐ |
| P-06 | Explicit grants given (§2 column "S&A policy") | People & Access → user → Policies shows the policy with scope = HQ company | ☐ |
| P-07 | Leave types exist (status **active**) in the HQ company — staging had **0** on 2026-10-26: create Annual (paid, tiers) and Unpaid (Wave 3 guide W3-C-03) 🟠 | HR → Leave Management → Leave Types | ☐ |
| P-08 | (Part B only) Wave 2 migration applied on staging and post-apply check passed | **Done 2026-10-26** (KVM2 read-only, Wave 2 26/26) | ☑ |

---

# PART A — WAVE 1 (B2A leave security, B2B operational repairs)

### SA-01 — S&A policy visibility for HR
| | |
|---|---|
| Module / ID | Security & Access · SA-01 |
| Role | Owner (Root / Super Admin) |
| Preconditions | P-05, P-06 |
| Navigation | People & Access → Users → open **H1**, **M1**, **L1** |
| Steps | 1. Open H1 → Policies. 2. Open M1 → Policies. 3. Open L1 → Policies. |
| Expected UI | H1 shows *Leave & Attendance Administrator* and *HR Records Officer* (scope HQ). M1 shows *Manager Self-Service*. L1 shows no explicit HR policy (only legacy compatibility). |
| Expected DB / business | Assignments active, organization-scoped. No change to any other user. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | `sa_role_assignments`, `sa_assignment_scopes`; B2A D-021/D-022; coverage SQL `release/b2a-staging-2026-10-24/hr_b2a_approver_coverage_readonly.sql` |

### SA-02 — HR menu by role
| | |
|---|---|
| Module / ID | Navigation · SA-02 |
| Role | E1, M1, H1, L1 (sign in as each) |
| Navigation | `http://localhost:3000/hr` |
| Steps | Sign in as each account and open `/hr`. |
| Expected UI | **E1**: lands on *My Workspace* (no administrative dashboard). **M1**: My Workspace; mobile Leave shows an **Approvals** tab. **H1**: HR dashboard with People, Leave Management, Attendance. **L1**: whatever the legacy role still shows, but every leave decision is refused (see LV-07). No "Leave → Approval Flow" mock screen for anyone. |
| Expected DB | None (read only). |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | `modules/hr/hrNav.ts`, `app/hr/mobile/layout.tsx` (Approvals tab = `hr/leave/requests` OR `hr/team-leave`), `lib/security-access/nav-access.ts` |

### LV-01 — Employee submits leave (web)
| | |
|---|---|
| Module / ID | Leave · LV-01 |
| Role | E2 |
| Navigation | My Workspace → **My Leave** (`/hr/mobile/leave`) → **Apply** (an employee has no access to the HR leave screen; HR staff applying for themselves may also use HR → Leave Management → Leave Requests & Approvals → *New Request*) |
| Steps | 1. Choose an active leave type. 2. Pick a single future working day. 3. Reason "UAT LV-01". 4. Submit. |
| Expected UI | Green "submitted" toast; request listed as **Pending**. |
| Expected DB | `hr_leave_requests` row: `employee_id` = E2, `status = pending`, `approved_by` null; `hr_leave_request_events` row `authority = self`, `action = insert`. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | B2A guard `hr_leave_requests_guard`; `modules/hr/leave/supabaseRepository.ts` |

### LV-02 — Self-approval denied
| | |
|---|---|
| Module / ID | Leave · LV-02 (negative) |
| Role | E2 (then M1 on own request) |
| Preconditions | LV-01 done. M1 submits his own request "UAT LV-02". |
| Navigation | `/hr/leave/requests` and `/hr/mobile/leave` |
| Steps | 1. As E2, look for Approve/Reject on own request. 2. As M1, open Approvals (mobile) and Leave Requests (web). |
| Expected UI | No Approve/Reject button on one's **own** request (web and mobile); M1's own request never appears in his Approvals list. |
| Expected DB | Nothing changes. (A forced API call returns `hr_leave_self_approval`.) |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | E-09; `HrLeaveRequestsView.decisions.test.tsx`; mobile `.neq('employee_id', me)` |

### LV-03 — Direct manager (with MSS) approves
| | |
|---|---|
| Module / ID | Leave · LV-03 |
| Role | M1 |
| Preconditions | LV-01 (E2 pending, E2 reports to M1) |
| Navigation | Mobile: `/hr/mobile/leave` → **Approvals** · Web: `/hr/leave/requests` |
| Steps | Approve E2's "UAT LV-01". |
| Expected UI | "✅ Approved" toast **only after** the request shows Approved; list refreshes. |
| Expected DB | `status = approved`, `approved_by` = M1, `approved_at` set **by the database**; event `authority = manager`. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | D-022; `assertDecisionStored` (`modules/hr/leave/mobileLeave.ts`) |

### LV-04 — Manager without MSS / not the direct manager is refused
| | |
|---|---|
| Module / ID | Leave · LV-04 (negative) |
| Role | M2 |
| Preconditions | E2 submits another request "UAT LV-04" (E2 reports to M1, not M2) |
| Navigation | `/hr/mobile/leave` (Approvals tab may be absent — that is a pass) and `/hr/leave/requests` |
| Steps | Try to find and approve E2's request. |
| Expected UI | Request not visible to M2; if visible through any path, approving shows red **"Decision not saved"** — never "Approved". |
| Expected DB | Request stays `pending`. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | `hr_leave_can_decide`; no false success (Wave 1 E-09, mobile fix 2026-10-25) |

### LV-05 — HR approves (explicit HR)
| | |
|---|---|
| Module / ID | Leave · LV-05 |
| Role | H1 |
| Preconditions | E2 "UAT LV-04" pending |
| Navigation | `/hr/leave/requests` |
| Steps | Approve the request. |
| Expected UI | Success toast; status Approved. |
| Expected DB | `approved_by` = H1; event `authority = hr`. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | D-021, D-023 |

### LV-06 — Cross-organization access denied
| | |
|---|---|
| Module / ID | Leave · LV-06 (negative) |
| Role | H1, then X1 |
| Preconditions | X1 (other company) submits "UAT LV-06" |
| Navigation | `/hr/leave/requests` |
| Steps | 1. As H1, search for X1's request. 2. As X1, look for HQ requests. |
| Expected UI | Neither sees the other company's requests or balances. |
| Expected DB | No change. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | D-026 (`sa_org_ancestry`) |

### LV-07 — Legacy-only access denied
| | |
|---|---|
| Module / ID | Leave · LV-07 (negative) |
| Role | L1 |
| Navigation | `/hr/leave/requests`, `/hr/mobile/leave` |
| Steps | Try to view other people's leave and approve any request. |
| Expected UI | Other people's requests are not listed (or approving shows "Decision not saved"). |
| Expected DB | No change; staging diagnostic: `hr.leave.approve` holders via legacy compat = 13, explicit = 0 before grants — L1 must not decide. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | D-021, P-R12, BL-11 |

### LV-08 — Cancellation rules
| | |
|---|---|
| Module / ID | Leave · LV-08 |
| Role | E1, then H1 |
| Steps | 1. E1: My Leave → Apply "UAT LV-08a" → **Requests** → **Withdraw request**. 2. E1: an **approved** request (from LV-03/05) shows "Approved leave can only be cancelled by HR." and no withdraw button. 3. H1: HR → Leave Management → **Leave Requests & Approvals** → that request → **Cancel leave** → confirm. |
| Expected UI | Step 1 "Request withdrawn", status Cancelled; step 2 no cancel action for the employee; step 3 "Approved leave cancelled", approver kept. A refusal shows "Leave not cancelled" (never a success). |
| Expected DB | Events `status_change` for 1 and 3; nothing for 2. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | D-024 |

### LV-09 — Privacy of leave reasons and balances
| | |
|---|---|
| Module / ID | Leave · LV-09 (negative) |
| Role | E1 |
| Steps | Open Leave pages and the mobile Balance tab. |
| Expected UI | Only E1's own requests and balances. |
| Expected DB | — |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | B2A select policies |

### LV-10 — Error messages are explicit, never false success
| | |
|---|---|
| Module / ID | Leave · LV-10 |
| Role | N1 (not onboarded) |
| Steps | Try to submit leave. |
| Expected UI | Red "Leave not submitted" with "no completed HR employment record in this company…" — no success toast. |
| Expected DB | No row. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | `leaveErrors.ts` (`hr_onboarding_pending`) |

### ML-01 — Mobile leave: full-day application
| | |
|---|---|
| Module / ID | Mobile leave · ML-01 |
| Role | E3 (phone or browser responsive mode) |
| Navigation | `http://localhost:3000/hr/mobile/leave` → **Apply** |
| Steps | Type, two-day range, Submit. |
| Expected UI | "✅ Leave Applied" only after the row is stored; moves to Requests tab; request Pending with 2 days. |
| Expected DB | `total_days = 2`, `is_half_day = false`, `half_day_period` null. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | `buildMobileLeaveRequest` (Wave 1 closure fix) |

### ML-02 — Mobile leave: half day (morning/afternoon)
| | |
|---|---|
| Module / ID | Mobile leave · ML-02 |
| Role | E3 |
| Steps | Apply → tick **Half-day leave** → choose **Afternoon** → same start/end date → Submit. Then try again without choosing morning/afternoon, and with different start/end dates. |
| Expected UI | First: success, "(Half day)" shown. Second/third: red message **before** sending ("choose morning or afternoon" / "must start and end on the same date"). |
| Expected DB | First: `total_days = 0.5`, `is_half_day = true`, `half_day_period = 'afternoon'`. Before this fix every mobile half-day failed on `hr_leave_requests_half_day_chk`. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | `HrMobileLeave.test.tsx` |

### ML-03 — Mobile Approvals tab for MSS managers
| | |
|---|---|
| Module / ID | Mobile leave · ML-03 |
| Role | M1 (MSS, **no** HR policy) |
| Steps | Open mobile Leave. |
| Expected UI | **Approvals** tab present listing only direct reports' pending requests (E1, E2). Approve one → success only when stored. |
| Expected DB | As LV-03. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | Before 2026-10-25 the tab required the HR leave key; MSS-only managers could not see it. |
| Tech ref | `app/hr/mobile/layout.tsx`; `pages.access.test.tsx` |

### ML-04 — Mobile read failure is shown
| | |
|---|---|
| Module / ID | Mobile leave · ML-04 (negative) |
| Role | E3 |
| Steps | With localhost running, temporarily turn the Wi-Fi off and reload the Leave screen, then turn it on. |
| Expected UI | Red banner "…could not be loaded" instead of an empty screen. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | `loadError` in `HrMobileLeave.tsx` |

### AT-01 — Attendance capture (clock in / out)
| | |
|---|---|
| Module / ID | Attendance · AT-01 |
| Role | E1 |
| Navigation | My Workspace → **My Attendance** (`/hr/mobile/attendance`) |
| Steps | Clock in, wait 2 minutes, clock out. |
| Expected UI | Times shown; today's worked minutes > 0. |
| Expected DB | `hr_attendance_entries` row with clock in/out, `worked_minutes`. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | `HrMobileAttendance.tsx` |

### AT-02 — Attendance correction request and review
| | |
|---|---|
| Module / ID | Attendance · AT-02 |
| Role | E1 (request), H1 (review) |
| Steps | 1. E1: My Attendance → **History** → *Request correction* on the AT-01 entry (reason ≥ 5 characters). 2. H1: HR → Attendance → **Attendance Operations** → Operations → **Corrections** (Pending) → **Approve**, comment "UAT AT-02". (Same as W3-AT-06; no console needed.) |
| Expected UI / response | Toast "Correction approved — entry updated, original kept in the audit"; E1 History shows the corrected time. |
| Expected DB | Correction `status` approved, `review_comment` = "UAT AT-02", reviewer = H1; entry updated; original kept in the correction row. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | B2B route `api/hr/attendance/corrections/[id]/review` (was writing `review_note`, BL-10) |

### AT-03 — Correction self-review refused
| | |
|---|---|
| Module / ID | Attendance · AT-03 (negative) |
| Role | H1 |
| Steps | H1 requests a correction on **own** entry (My Attendance → History), then opens Attendance Operations → Corrections. |
| Expected response | H1's own request is **not listed** in H1's queue (no Approve button); it stays pending until H2 decides (W3-AT-06). |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | `attendance-repairs.ts` |

### TS-01 — Timesheet generation and approval
| | |
|---|---|
| Module / ID | Timesheets · TS-01 |
| Role | H1 |
| Navigation | HR → Attendance → Timesheets (`/hr/attendance/timesheets`) |
| Steps | Generate the current period, open E1's timesheet, Approve. |
| Expected UI | Totals shown (minutes/OT minutes); Approve succeeds. |
| Expected DB | `hr_timesheets` uses `total_minutes`, `overtime_minutes`; status approved. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | B2B timesheets route |

### TS-02 — Approved period is not regenerated
| | |
|---|---|
| Module / ID | Timesheets · TS-02 (negative) |
| Role | H1 |
| Steps | Generate the same period again. |
| Expected UI | Approved timesheet unchanged (explicit message or skipped count). |
| Expected DB | Same row, same totals. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | E-07 |

### OT-01 — OT request submit and independent approval
| | |
|---|---|
| Module / ID | Overtime · OT-01 |
| Role | E1 (request), H1 (approve) |
| Steps | 1. E1: My Attendance → **Overtime** → "Already worked", today, 60 min, reason "UAT OT-01" → *Submit overtime for approval*. 2. H1: Attendance Operations → Operations → **Overtime** (Waiting for decision) → **Approve**, comment "UAT OT-01 ok". (Same as W3-OT-01/03.) |
| Expected | Request `pending` (never auto-approved); after H1 approval `approved`, `approver_id` = H1. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | D-030; `api/hr/attendance/overtime/requests/route.ts` (payload fields per route test `route.test.ts`) |

### OT-02 — OT self-approval refused
| | |
|---|---|
| Module / ID | Overtime · OT-02 (negative) |
| Role | H1 |
| Steps | H1 submits own OT request (My Attendance → Overtime) and looks for it in Attendance Operations → Overtime. |
| Expected | H1's own request is not offered for decision in H1's queue; it stays submitted until H2 decides (W3-OT-05). |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | D-030 |

### PY-01 — Payroll calculation fails closed / creates lines
| | |
|---|---|
| Module / ID | Payroll · PY-01 |
| Role | P1 |
| Navigation | HR → Payroll → Payslips (`/hr/payroll/payslips`) |
| Steps | Create a run for the current month; Calculate. |
| Expected UI | Either lines are created for onboarded employees with active salary, or an explicit failure listing the problem — **never** "calculated" with zero lines. Leavers are excluded. |
| Expected DB | `hr_payroll_run_items` rows with `employee_user_id`, or run unchanged with error. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | B2B `payroll/runs/[id]/calculate` (BL-4) |

### PY-02 — Payroll approval locked until statutory certification
| | |
|---|---|
| Module / ID | Payroll · PY-02 (negative) |
| Role | another payroll approver (not P1) |
| Steps | Approve the PY-01 run. |
| Expected UI | Refused with `PAYROLL_STATUTORY_NOT_CERTIFIED` message ("provisional — not certified"). |
| Expected DB | Run not approved. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | D-029 |

### PY-03 — Second payroll GL route retired
| | |
|---|---|
| Module / ID | Payroll · PY-03 (negative) |
| Role | P1 |
| Steps | **Optional technical check** (no screen calls this retired route any more; covered by the route test). Mark *Not run (covered by test)*, or a technical reviewer may call `POST /api/hr/finance/post-payroll-run` from the browser console. |
| Expected | **410** (retired). No journal created. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | S-18.9 |

### PH-01 — Public-holiday template national only
| | |
|---|---|
| Module / ID | Settings · PH-01 |
| Role | H1 |
| Navigation | HR → Attendance → **Public Holidays** (`/hr/attendance/public-holidays`) → **Load Malaysia Template** (needs HR settings authority — Root). The Configuration checklist's "Public holidays" link opens the same page. |
| Steps | Load the Malaysian template. |
| Expected | Preview lists national holidays only; toast "N national holidays loaded … state holidays not loaded: Thaipusam, Federal Territory Day"; the list's *Applies to* column shows "National (all employees)". 🟠 shared-staging data change |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | B2B public-holidays route |

### AU-01 — Leave audit evidence
| | |
|---|---|
| Module / ID | Audit · AU-01 |
| Role | Owner (Supabase Studio, read only) |
| Steps | Open `hr_leave_request_events` filtered by the UAT requests. |
| Expected | One event per transition with `authority` self/manager/hr, no reason text; table cannot be edited (append-only). |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | E-02 |

---

# PART B — WAVE 2 (employee lifecycle, organization foundation, HR S&A, Finance-ready data)

### NA-01 — Before the Wave 2 migration: clear "not installed" state
| | |
|---|---|
| Module / ID | Wave 2 · NA-01 (run only if P-08 is NOT done) |
| Role | H1 |
| Navigation | HR → People → Employees → open any onboarded test employee → **History** tab; button **Reporting-line check** |
| Expected UI | Amber message "This HR feature is not installed on this environment yet (migration 20261221100000)" — no crash, no fake data. HR Profile **Save** shows the same message. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | `employmentError` 503 `NOT_AVAILABLE` |

### EO-01 — Register / onboard a new employee
| | |
|---|---|
| Module / ID | Employee lifecycle · EO-01 |
| Role | H1 |
| Preconditions | N1 awaiting onboarding |
| Navigation | `/hr/people/employees` → **Awaiting onboarding** tab → N1 → *Add Employee* (or toolbar *Add Employee* → find N1) |
| Steps | Hire date = today, department, position, **Reports to = M1**, Full-time → Save. |
| Expected UI | N1 moves to **Onboarded** with an employee number; manager M1. |
| Expected DB | `hr_employees.onboarding_status = completed` (same user id and employee number — no new identity); `hr_employee_versions` new row `change_kind = onboarding`. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | `hr_onboarding_complete`; Wave 2 guard (fresh onboarding validates the manager) |

### EO-02 — Onboarding cannot use a former manager
| | |
|---|---|
| Module / ID | Employee lifecycle · EO-02 (negative) |
| Role | H1 |
| Preconditions | F1 archived (Part C C-01) — or skip until then |
| Steps | Onboard another awaiting account choosing F1 as manager (F1 is no longer offered in the list; if it appears through any path, select it). |
| Expected UI | F1 not offered; if forced: red "The selected manager is a former or inactive employee." |
| Expected DB | No change. |
| Result | ☐ PASS ☐ FAIL ☐ N/A |
| Defect notes | |
| Tech ref | `hr_manager_inactive` |

### EO-03 — Link an existing user (no duplicate account)
| | |
|---|---|
| Module / ID | Employee lifecycle · EO-03 |
| Role | H1 |
| Steps | Awaiting tab → select an existing test user → *Link to HR* (hire date required). |
| Expected UI | Linked, same email/phone; no second account. |
| Expected DB | Same `users.id`; one `hr_employees` row per user per company (`hr_employees_user_org_uniq`); version `onboarding`. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | POST `/api/hr/employees/profile`; D-005 |

### PR-01 — HR edits an employee profile (personal + statutory)
| | |
|---|---|
| Module / ID | Employee profile · PR-01 |
| Role | H1 |
| Navigation | Employees → click E1 → HR Profile sheet |
| Steps | Personal: blood type, education. ID & Tax: NRIC `900101-01-1234` (test value), EPF `12345678`, SOCSO `A1234567`. Emergency: name/phone. Bank: test number digits only. **Save Profile**. Close and reopen. |
| Expected UI | "Profile saved"; reopened sheet shows the values (NRIC shown as 12 digits). |
| Expected DB | Personal fields in `hr_employee_profiles`; NRIC/EPF/SOCSO in `hr_employee_statutory_profiles` (one source); `hr_statutory_profile_changes` lists **column names only** (no NRIC/bank values). Before Wave 2 every save failed (table did not exist). |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | `hr_employee_profile_save`; `splitProfilePayload` |

### PR-02 — Invalid statutory format refused
| | |
|---|---|
| Module / ID | Employee profile · PR-02 (negative) |
| Role | H1 |
| Steps | NRIC `1234` → Save. Then bank account `12-AB` → Save. |
| Expected UI | Red "Profile not saved" with the format message; nothing changes. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | `statutoryFormatError`, DB checks |

### PR-03 — HR cannot change own statutory record
| | |
|---|---|
| Module / ID | Employee profile · PR-03 (negative) |
| Role | H1 |
| Steps | Open **own** profile → ID & Tax. |
| Expected UI | Fields read-only with the note "changed only by HR … never on your own record"; saving changes only personal fields. |
| Expected DB | Statutory row of H1 unchanged. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | `hr_statutory_self_edit_refused` |

### PR-04 — Legacy-only admin cannot read/edit profiles
| | |
|---|---|
| Module / ID | Employee profile · PR-04 (negative) |
| Role | L1 |
| Steps | Open E1's HR Profile. |
| Expected UI | "Profile not available — You do not have HR authority for this employee …"; no data shown. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | Intended Wave 2 behaviour: explicit HR policy required (fail closed). |
| Tech ref | `hr_actor_has_explicit` |

### DP-01 — Department and position assignment (inline / bulk)
| | |
|---|---|
| Module / ID | Organization · DP-01 |
| Role | H1 |
| Navigation | Employees list → pencil on E3 → change Department and Position → ✓ |
| Expected UI | "Updated"; row shows new department/position. |
| Expected DB | `hr_employees` updated through the identity projection; `hr_employee_versions` row `change_kind = transfer`. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | `/api/users/[id]/hr`; `hr_employees_record_version` |

### RL-01 — Change a manager (valid)
| | |
|---|---|
| Module / ID | Reporting lines · RL-01 |
| Role | H1 |
| Steps | Inline edit E3: Reports to = M1 → ✓. |
| Expected UI | "Updated". |
| Expected DB | Version `reporting_change`; projection `users.manager_user_id` = M1. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | lifecycle guard |

### RL-02 — Invalid managers refused (self, cycle, other company)
| | |
|---|---|
| Module / ID | Reporting lines · RL-02 (negative) |
| Role | H1 |
| Steps | a) M1 reports to E2 (E2 → M1 already: cycle). b) E1 reports to X1 (other company) — only if X1 is offered. c) E1 reports to E1 (not offered; skip if absent). |
| Expected UI | a) "This reporting line would create a reporting cycle." b) "…belongs to another company." Nothing saved. |
| Expected DB | No change, no version. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | `hr_manager_cycle`, `hr_manager_outside_company` |

### RL-03 — Reporting-line check
| | |
|---|---|
| Module / ID | Reporting lines · RL-03 |
| Role | H1 |
| Navigation | Employees → **Reporting-line check** |
| Steps | Review the list (staging had 2 employees reporting to inactive/archived managers on 2026-10-25). Choose a new manager for one test finding, enter reason "UAT RL-03", Apply. |
| Expected UI | Findings with readable reasons; after Apply "Reporting line updated" and the row disappears. Real-person findings: **do not change** — report them. |
| Expected DB | `hr_reporting_line_changes` row (from/to/actor/reason); version `reporting_change` with the reason. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | `hr_reporting_line_review_for`, `hr_set_reporting_line` |

### RL-04 — Leave authority follows the new reporting line
| | |
|---|---|
| Module / ID | Reporting lines × Leave · RL-04 (regression) |
| Role | E3, M1, M2 |
| Preconditions | RL-01 moved E3 from M2 to M1 |
| Steps | E3 submits leave; M1 approves on mobile; then M2 tries. |
| Expected UI | M1 sees and approves (success only when stored); M2 does not see it. |
| Expected DB | `approved_by` = M1, event `manager`. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | B2A `hr_leave_manager_authority` reads `hr_employees.manager_user_id` |

### RL-05 — Manager self-service sees only direct reports
| | |
|---|---|
| Module / ID | Reporting lines · RL-05 |
| Role | M1 |
| Navigation | My Workspace (`/hr/my-workspace`) → My Team card (Manager Self-Service) / mobile Approvals |
| Expected UI | Only current direct reports (E1, E2, E3 after RL-01); never other teams. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | `lib/server/hr/manager-self-service.ts` |

### OS-01 — Organization scope for HR
| | |
|---|---|
| Module / ID | Organization scope · OS-01 (negative) |
| Role | H1 |
| Steps | As H1: 1. HR → People → Employees (all tabs, search X1's name). 2. **Reporting-line check**. 3. Attendance Operations → Daily board; Leave Requests & Approvals → All Requests. *(Optional technical check: the console calls of the earlier version of this guide.)* |
| Expected | X1 appears nowhere — HR authority is scoped to the HQ company and its child organizations (optional console check: **403**). |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | S&A scope in `hr_actor_has_explicit` |

### HI-01 — Employment history tab
| | |
|---|---|
| Module / ID | History · HI-01 |
| Role | H1 |
| Navigation | Employees → E3 → HR Profile → **History** |
| Expected UI | Newest first: reporting change (RL-01), transfer (DP-01), baseline "Recorded at go-live of history (earlier changes not reconstructed)", each with effective date, who and why. |
| Expected DB | Matches `hr_employee_versions` for E3. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | `hr_employee_history` |

### HI-02 — Effective-dated change (back-dated transfer)
| | |
|---|---|
| Module / ID | History · HI-02 |
| Role | H1 |
| Steps | As H1: Employees → click E3 → HR Profile → **History** → **Record employment change (effective-dated)** → Employment type = *Contract*, Effective date = first day of this month, Reason "UAT HI-02 conversion" → **Record change**. Then open the form again: the date picker allows no future date (the button stays disabled), and *Status* offers only Active / Probation / Suspended. |
| Expected | Toast "Employment change recorded"; History shows a new "Employment terms changed" entry, **Effective** = first day of month, reason and H1's name. No future date and no "resigned/terminated" can be chosen (ending employment = Archive & Revoke Access; the database also refuses both). H1 changing **own** record: "You cannot change your own HR record…". 🟠 |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | `hr_employment_change` |

### HI-03 — History cannot be edited
| | |
|---|---|
| Module / ID | History · HI-03 (negative) |
| Role | Owner (Supabase Studio) |
| Steps | Try to edit or delete a row in `hr_employee_versions`. |
| Expected | Refused `hr_history_append_only`. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | append-only triggers |

### HS-01 — Employee sees own history and own statutory data (read-only)
| | |
|---|---|
| Module / ID | Self-service · HS-01 |
| Role | E1 |
| Steps | As E1: My Workspace (`/hr/my-workspace`) → My Employment → **Show my employment history**. Then check that no screen offers E2's history or profile to E1 (the HR menu and HR Profile are not available to E1). |
| Expected | E1's own versions are listed read-only (no *Record employment change*). No way to open another person's history (optional console check: 403). |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | self branch of `hr_employee_history` |

### CP-01 — Compensation overlap refused
| | |
|---|---|
| Module / ID | Finance-ready data · CP-01 |
| Role | H1 / P1 |
| Navigation | HR → Payroll → Salary Structure → E1 compensation |
| Steps | Add a salary effective today (supersedes the old one) — OK. Then try to add a second **active** salary overlapping it directly (if the screen allows). |
| Expected UI | Revision works; overlap refused "Another active salary record already covers part of this period". |
| Expected DB | `hr_compensation_change_log` has insert/update rows with old/new values (sealed table). |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | `hr_employee_compensation_no_overlap` |

### FR-01 — Finance-ready contract (read-only check)
| | |
|---|---|
| Module / ID | Finance-ready data · FR-01 |
| Role | Owner (Studio, read only) |
| Steps | `select * from hr_employment_finance_contract_v1 limit 5` |
| Expected | Employment id, company, department, position, `cost_center_ref` (null — Finance owns cost centres), pay type/currency, `statutory_profile_complete`; **no** salary amount, **no** NRIC/EPF numbers. No journal, no GL posting anywhere. |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | D-010; contract v1 |

### AC-01 — Access-denied handling
| | |
|---|---|
| Module / ID | S&A · AC-01 (negative) |
| Role | E1 |
| Steps | Open `/hr/people/employees` directly. |
| Expected UI | Access-denied page (no technical codes, no data). |
| Result | ☐ PASS ☐ FAIL |
| Defect notes | |
| Tech ref | `AccessState` |

---

# PART C — 🔴 DESTRUCTIVE TESTS (separate authorization required, test accounts only)

### C-01 — 🔴 Archive & Revoke Access (offboarding) with Wave 2 effects
| | |
|---|---|
| Module / ID | Offboarding · C-01 — **🔴 DESTRUCTIVE — separate authorization** |
| Role | Super Admin with *Platform Data Maintenance Administrator* |
| Preconditions | F1 onboarded with a test salary and a position |
| Navigation | Employees → F1 → ⋯ → Archive & Revoke Access |
| Expected UI | F1 moves to **Former employees**; profile read-only. |
| Expected DB | `hr_employees.status` resigned/terminated + `end_date`; version `end_of_employment`; active salary/allowances/deductions **ended at the end date** (rows kept); position assignment ended; login revoked. |
| Result | ☐ PASS ☐ FAIL ☐ NOT AUTHORIZED |
| Defect notes | |
| Tech ref | `identity_archive_execute` + `hr_employees_end_effects` |

### C-02 — Archived employee cannot be changed or re-employed
| | |
|---|---|
| Module / ID | Offboarding · C-02 (negative, after C-01) |
| Role | H1 |
| Steps | Try to change F1's department (Former tab is read-only; if any path allows, try) and to set employment status active. |
| Expected UI | "This person is a former employee (archived)…" |
| Expected DB | No change. |
| Result | ☐ PASS ☐ FAIL ☐ N/A |
| Defect notes | |
| Tech ref | `hr_employment_archived_locked` |

### C-03 — 🔴 Remove / Reset HR Registration restrictions
| | |
|---|---|
| Module / ID | Controlled delete/reset · C-03 — **🔴 DESTRUCTIVE — separate authorization** |
| Role | H1 + *HR Employee Record Administrator* |
| Steps | a) Remove HR Registration of a test employee **with** leave history. b) Reset HR Registration of the same employee. |
| Expected UI | a) Blocked: "This employee has … leave requests … use Reset". b) Completes; history kept. |
| Expected DB | Reset: `onboarding_status = reset`; leave rows and `hr_employee_versions` kept. |
| Result | ☐ PASS ☐ FAIL ☐ NOT AUTHORIZED |
| Defect notes | |
| Tech ref | D-006; `hr_employee_registration_execute` |

### C-04 — 🔴 Permanent deletion of an unused test identity
| | |
|---|---|
| Module / ID | Controlled deletion · C-04 — **🔴 DESTRUCTIVE — separate authorization** |
| Role | Super Admin (*Platform Data Maintenance Administrator*) |
| Steps | Create an unused test identity (never onboarded), then Delete Employee Permanently. Then try the same on an identity **with** an HR profile/statutory record. |
| Expected UI | First: deleted. Second: blocked ("HR records"). |
| Expected DB | First: identity removed; its baseline history removed with it; `identity_deletion_requests` audit retained. Second: nothing deleted. |
| Result | ☐ PASS ☐ FAIL ☐ NOT AUTHORIZED |
| Defect notes | |
| Tech ref | `identity_deletion_execute`; `hr_employees_purge_versions` |

### C-05 — 🔴 HR Data Management reset (test organization only)
| | |
|---|---|
| Module / ID | HR reset · C-05 — **🔴 DESTRUCTIVE — separate authorization; NEVER on the real HQ** |
| Expected | Preview lists the Wave 2 tables as **kept**; no blocker. |
| Result | ☐ PASS ☐ FAIL ☐ NOT AUTHORIZED |
| Tech ref | `hr_reset_scope` (6 new rows, keep) |

---

# PART D — Regression sweep after Wave 2

| ID | Re-run | Expected | ☐ PASS ☐ FAIL | Notes |
|---|---|---|---|---|
| RG-01 | LV-01 (submit) | unchanged | ☐ ☐ | |
| RG-02 | LV-02 (self-approval) | refused | ☐ ☐ | |
| RG-03 | LV-03 (manager approves) | stored & stamped | ☐ ☐ | |
| RG-04 | LV-07 (legacy-only) | refused | ☐ ☐ | |
| RG-05 | ML-02 (half day) | stored with period | ☐ ☐ | |
| RG-06 | PY-02 (approval lock) | refused | ☐ ☐ | |
| RG-07 | OT-02 (OT self-approval) | refused | ☐ ☐ | |

---

## 9. Reporting results back to Coder AI

Fill one block per failure and paste it into the next Coder AI session (together with the KVM2/console output if any).

```
UAT DEFECT
Test ID:            (e.g. RL-03)
Account used:       (code + email, e.g. H1 hr.test1@…)
Date/time (MYT):
URL:
Steps done:         (numbered)
Expected:           (copy from the guide)
Actual:             (exact message / screenshot file name)
Browser console:    (red errors, if any)
Network response:   (status + JSON body of the failing /api/… call — DevTools → Network)
Data seen in Studio:(table, row id — no personal data)
Severity:           Blocker / Major / Minor
```

Test account register (fill in):

| Code | Email | Created | Policies granted (date) |
|---|---|---|---|
| E1 | | | |
| E2 | | | |
| E3 | | | |
| M1 | | | Manager Self-Service |
| M2 | | | — |
| H1 | | | Leave & Attendance Administrator; HR Records Officer |
| H2 | | | Leave & Attendance Administrator; HR Records Officer |
| P1 | | | HR & Payroll Full Access |
| L1 | | | legacy only |
| X1 | | | — |
| N1 | | | — |
| F1 | | | — |

Summary (owner):

| Part | Tests | PASS | FAIL | Not run | Signed off (date) |
|---|---|---|---|---|---|
| A — Wave 1 | 25 | | | | |
| B — Wave 2 | 21 | | | | |
| C — Destructive | 5 | | | | |
| D — Regression | 7 | | | | |

UAT PASS is recorded in [HR_PROGRESS_TRACKER.md](../HR_PROGRESS_TRACKER.md) only from this signed summary.
