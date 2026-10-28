# Serapod2U HR — Wave 3 UAT Guide (Hybrid Attendance, Excel import, Overtime, Leave ledger) — owner-run, localhost

Back to [HR_MASTER_INDEX.md](../HR_MASTER_INDEX.md) · release package: [Wave 3](../release/wave3-attendance-overtime-leave-2026-10-25/README.md) · earlier guide: [Wave 1 + Wave 2](HR_WAVE1_WAVE2_COMPREHENSIVE_UAT.md)

Prepared 2026-10-25, finalised 2026-10-26, **reconciled with the implemented UI on 2026-10-26 (evening, "Wave 1–3 UI/UX completion")** (MYT) on branch `Enhancement03`, HEAD `b6b78002` + uncommitted HR changes. **Not executed by Coder AI. No grant, policy, configuration or staging SQL was created by Coder AI.** Every PASS/FAIL box is for the owner. Every step below uses a screen; no developer console is needed (W3-SEC-03 is optional and already covered by replica tests).

**Staging state on 2026-10-26 (read-only verification, tracker §12):** Wave 2 + Wave 3 migrations applied and verified ✅ · deployed staging app = **old build** (cannot write attendance/OT any more → use **localhost**) · 0 active leave types · 0 active shifts · 1 attendance policy · 14 national holidays + 1 `WP` · 0 explicit HR/MSS holders (only Root) · WH001: 4 employees without a manager.

### Where everything is (localhost, HR menu = top navigation on any `/hr` page)

| Function | Screen (menu path) | Direct URL |
|---|---|---|
| Employee clock in/out, history, corrections, missing day, overtime request | My Workspace → **My Attendance** (phone or desktop) | `/hr/mobile/attendance` |
| Employee leave: balance, apply (working-day quote), requests, **withdraw**; manager Approvals tab | My Workspace → **My Leave** | `/hr/mobile/leave` |
| Daily board · Exceptions · Corrections · Manual entry · Excel import · Overtime · Report | HR → Attendance → **Attendance Operations** → *Operations* tab → sub-tab | `/hr/attendance/clock-in-out?tab=board` (or `exceptions`, `corrections`, `manual`, `import`, `overtime`, `report`) |
| Attendance policy, overtime rules, shifts | HR → Attendance → Attendance Operations → **Policy & shifts** | `/hr/attendance/clock-in-out?tab=setup` |
| HR person's own clock (optional) | HR → Attendance → Attendance Operations → **My clock-in** | `/hr/attendance/clock-in-out?tab=my` |
| Timesheets | HR → Attendance → **Timesheets** | `/hr/attendance/timesheets` |
| Public holidays (national / per state / per Federal Territory) | HR → Attendance → **Public Holidays** | `/hr/attendance/public-holidays` |
| Leave approval queue, HR cancellation of approved leave, own withdraw | HR → Leave Management → **Leave Requests & Approvals** | `/hr/leave/requests` |
| Balances, ledger, set entitlement, adjust ±, entitlement-run & carry-forward **previews** | HR → Leave Management → **Balances & Entitlements** | `/hr/leave/requests?tab=balances` |
| Leave types (paid/unpaid, tiers, carry-forward) | HR → Leave Management → **Leave Types** | `/hr/leave/types` |
| Employees, onboarding, HR Profile (incl. **Work state**), History + **Record employment change**, reporting-line check | HR → People → **Employees** | `/hr/people/employees` |
| S&A grants | People & Access (main menu) → user → policies | — |

### First-time HR setup (short version — details in §1)

1. **Accounts** (People & Access / User Management): create the test users of the [Wave 1+2 guide §2](HR_WAVE1_WAVE2_COMPREHENSIVE_UAT.md) (E1, E2, E3, M1, M2, H1, H2, L1, X1, N1). 🟠 *shared-staging data change*.
2. **Grants** (People & Access → user → assign policy, scope HQ test company): H1 and H2 → *Leave & Attendance Administrator* + *HR Records Officer*; M1 → *Manager Self-Service*; others nothing extra (§1.3). 🟠 *S&A change — owner only*. Users log out/in.
3. **Onboard** E1, E2, E3, M1, M2, H1, H2 (HR → People → Employees → *Add Employee*), with **Reports To**: E1, E2 → M1; E3 → M2. 🟠
4. **Attendance policy + one shift** (Attendance Operations → *Policy & shifts* → *Save Policy*; *Add Shift*). 🟠 *company-wide setting*.
5. **Leave types**: *Annual Leave* (paid, tiers, carry-forward) and *Unpaid Leave* (unpaid), status active (Leave Management → *Leave Types*). 🟠 *company-wide setting*.
6. **Holidays**: Public Holidays → check the year; add state / territory holidays with *Applies to* (Root). 🟠
7. **Entitlements for test accounts only**: Balances & Entitlements → click E1/E2 Annual cell → *Set entitlement* + reason. 🟠 Never apply an entitlement run or carry-forward (🔴 company-wide) without separate authorization.

### Testing sequence

§1 set-up → §2 steps 1–13 in order (attendance ESS → HR attendance → exceptions → import → overtime → report → leave → security → regression) → §4 summary. Then the Wave 1+2 guide Part A/B regression items it lists.

### Owner testing checklist (tick as you go)

- [ ] Mac: `bash docs/hr/release/b2a-staging-2026-10-24/local_verify_isolated.sh` → note Vitest / tsc / build exit codes (non-HR baseline: Reporting tests, ~250 tsc errors outside HR)
- [ ] `cd app && npm run dev` → `http://localhost:3000`, signed in as Root
- [ ] Smoke: HR → Attendance → **Attendance Operations** (Daily board loads) · **Public Holidays** (year shown) · Leave Management → **Balances & Entitlements** — no 404, no "not installed"
- [ ] 🟠 Test accounts + onboarding + Reports To (E1, E2 → M1; E3 → M2)
- [ ] 🟠 S&A grants: H1, H2 → Leave & Attendance Administrator + HR Records Officer; M1 → Manager Self-Service; users log out/in
- [ ] 🟠 Policy & shifts: save policy, add one shift · Leave Types: Annual (paid, tiers, carry-forward) + Unpaid, active · Public Holidays checked
- [ ] 🟠 Balances & Entitlements: set Annual entitlement for E1/E2 only (never Apply a company-wide run 🔴)
- [ ] §2 steps 1–13 below, then Wave 1+2 guide items it lists (LV-01…LV-10, HI-02, HS-01, RL-01…RL-05)
- [ ] §4 summary signed → send to Coder AI for the tracker

## 0. Safety (read first)

| ⚠️ | Rule |
|---|---|
| **Shared database** | Localhost uses the **shared KVM2 staging** database. Every action changes real staging rows. Use only the test accounts of the Wave 1+2 guide §2 (E1, E2, E3, M1, M2, H1, H2, L1, X1) — never a real person. Announce the UAT window (BL-12). |
| **Run on localhost, not on the staging URL** | The deployed staging app is the old build; after Wave 3A its direct attendance/OT writes are refused (BL-28). Start the working tree locally (`cd app && npm run dev`, `.env.local` → staging Supabase) and test on `http://localhost:3000`. |
| **🔴 organization-wide actions** | Entitlement run and carry-forward **apply** to every employee of the company, and staging contains real staff (BL-31). Only the **preview** is part of this guide; the Apply button stays disabled until a reason is typed **and** the box "I have explicit owner authorization…" is ticked — do not tick it. HR reset is never run on shared staging. |
| **No developer console** | Every scenario uses screens, except the optional technical check W3-SEC-03. |
| **Labels** | 🔴 = destructive or company-wide (separate authorization) · 🟠 = changes shared-staging data (test accounts only) |
| **Grants are the owner's** | All S&A assignments in §1.3 are made by the owner in People & Access. Remove them after UAT if the test accounts should not keep them. |

## 1. Owner set-up before UAT (do once, in this order)

### 1.1 Technical readiness

| ID | Step | PASS when | ☐ |
|---|---|---|---|
| W3-P-01 | Working tree contains the Wave 3 files (release README §9) | `git status --short -- app/src docs/hr supabase` lists them | ☐ |
| W3-P-02 | Mac: `bash docs/hr/release/b2a-staging-2026-10-24/local_verify_isolated.sh` (tsc now runs with an 8 GB heap) | Vitest: only the known non-HR `ship-metrics` failure; **tsc reports a number** (0 HR errors) — "tsc CRASHED" is **not** a pass; build exit 0 | ☐ |
| W3-P-03 | Staging verification | **Done 2026-10-26** (Wave 2 26/26, Wave 3 61/61, opening balance 0 mismatches) | ☑ |
| W3-P-04 | Optional: WP holiday fix — **not needed for Leave UAT** (0 work states on staging; national holidays work without it). Only if you give a test account a Federal-Territory work state: either apply `20261224100000_hr_w3_wp_holiday_alias.sql` (E-47, owner) **or**, without SQL, Public Holidays → edit the `WP` holiday → *Applies to* = W.P. Kuala Lumpur (add separate rows for Labuan / Putrajaya) | only needed for a Federal-Territory state-holiday check | ☐ |
| W3-P-05 | Optional: re-run `kvm2_hr_w2_w3_readonly.sh` → `09_uat_readiness.txt` lists the policies that carry the Wave 3 permissions and the configuration per company | file present, `08_sql_errors.txt` only the ledger error | ☐ |
| W3-P-06 | Local app: `cd app && npm run dev`; log in as Root at `http://localhost:3000` | HR → Attendance → **Attendance Operations** opens on the Operations tab with the Daily board (no "not installed" message) | ☐ |

### 1.2 HR configuration (HQ test company — Root or H1 after §1.3)

| ID | Where | What to create | Needed by | ☐ |
|---|---|---|---|---|
| W3-C-01 | HR → Attendance → Attendance Operations → **Policy & shifts** tab (`/hr/attendance/clock-in-out?tab=setup`) → Attendance Policy → **Save Policy** | Review the existing policy: workdays Mon–Fri, timezone Asia/Kuala_Lumpur, Late after 15 min, Early leave 15 min, Max open entry 16 h, OT max daily 120 min (current staging values) | AT-03, EX-01, OT-07 | ☐ |
| W3-C-02 | same tab → Shifts → **Add Shift** (or **Load Template** → "Office 9-6") | **One active shift**, e.g. "UAT Office 09:00–18:00", 60 min break. There is no per-employee shift assignment: the employee picks the shift when clocking in | AT-03, EX-01 | ☐ |
| W3-C-03 | HR → Leave Management → **Leave Types** | **Annual Leave** active, paid, entitlement tiers (e.g. 0–2 y = 8 d, 2–5 y = 12 d, 5 y+ = 16 d), carry-forward enabled (max 5 d); **Unpaid Leave** active, unpaid; optional **Medical Leave** active | all W3-LV, LV-07/08 previews | ☐ |
| W3-C-04 | HR → Attendance → **Public Holidays** (`/hr/attendance/public-holidays`; editing needs HR settings authority — Root) | Confirm the current-year national holidays (empty → **Load Malaysia Template**, national only). Add one test-period holiday on a weekday only if none falls in your test week (**Add Holiday** → *Applies to* = National, or a state for W3-C-05) | LV-01 | ☐ |
| W3-C-05 | HR → People → Employees → click E1 → HR Profile → **ID & Tax** → **Work state** → Save | Work state for E1 (e.g. Selangor) — optional; without it only national holidays count. State holidays are added in Public Holidays with *Applies to* = that state | LV-01 (state) | ☐ |
| W3-C-06 | HR → People → Employees → row pencil (**Reports To**) — or HR Profile → **History** → *Record employment change* → Manager (reason, effective date) | E1, E2 → manager **M1**; E3 → manager **M2**; all onboarded. Then **Reporting-line check** shows no finding for them. (Staging WH001 has 4 employees without a manager — do not use them) | MSS, AT-05, OT, LV | ☐ |

### 1.3 S&A grants (owner, People & Access → assign, **scope: HQ test company**) — Coder AI granted nothing

| Account | Policy (role key) | Gives | Why |
|---|---|---|---|
| **H1** | Leave & Attendance Administrator (`hr-leave-attendance-administrator`) + HR Records Officer (`hr-records-officer`) | `hr.attendance.manage`, `hr.leave.approve`, `hr.employee.*` | HR actions; legacy access never counts |
| **H2** | same as H1 | same | **maker-checker**: H2 confirms H1's manual entries/adjustments |
| **M1** | Manager Self-Service (`manager-self-service`) | `hr.mss.attendance_view`, `hr.mss.leave_view`, `hr.mss.leave_approve` | team view, leave approval; attendance/OT decisions stay HR-only (SA-R6/SA-R7 keys do not exist) |
| **E1, E2, E3, M2, X1** | default Employee Self-Service only | `hr.self_service.use` (28 explicit holders already) | clock, corrections, OT, leave |
| **L1** | **nothing** (legacy compatibility only) | — | W3-SEC-01 proves legacy gets no authority |

After granting, H1 must log out/in. Check: H1 opens HR → Attendance → Attendance Operations → Daily board without an access message.

## 2. Practical UI sequence (one sitting ≈ 2–3 h; two browsers: normal + private window)

| Step | Who | Do | Scenarios |
|---|---|---|---|
| 1 | E1 (phone or narrow window) | `/hr/mobile/attendance` → Today → Clock in; try again (refused); wait 2 min → Clock out → History | AT-01, AT-02, AT-03, AT-04 |
| 2 | E2 | Today → "Report a missing day" (yesterday 09:00–18:00, reason) | AT-05 |
| 3 | E1 | History → "Request correction" on today's entry | AT-06 |
| 4 | E1 → H1 | E1 tries to approve own correction (no button / refused); H1 → Attendance Operations → Corrections → approve E2's, reject E1's with reason; E1 withdraws a second request | AT-05…AT-07, OT-05 pattern |
| 5 | H1 → H2 | Daily board; Manual entry for E3 (missing day); H2 confirms; refusals (future, overlap, own record); "Adjust hh:mm" by H1, confirmed by H2 | HR-01…HR-04 |
| 6 | H1 / M1 | Exceptions → "Check this range" (last 7 days) → resolve / excuse / dismiss; M1 sees but cannot decide | EX-01…EX-03 |
| 7 | H1 | Excel import: download template → fill 3 rows (E1, E2 valid; 1 invalid) → preview → discard → preview again → commit → upload same file (refused); re-validation case | IM-01…IM-05 |
| 8 | E1 → H1 | Overtime: E1 submits 90 min for today; second claim refused; H1 approves 60 of 90; E2 submit → H1 rejects with reason; cancel rules; pre-approval + cap flag | OT-01…OT-07 |
| 9 | H1 | Report: last 7 days → CSV | RP-01 |
| 10 | H1 → E1 → M1 | Leave balances: set E1 Annual entitlement (reason) → E1 `/hr/mobile/leave` → Apply (quote shows working days; weekend-only and overlap refused; too many days refused with numbers) → M1/H1 approves → balance taken → H1 cancels → reversed; adjustments; **previews only** for entitlement run and carry-forward | LV-01…LV-09 |
| 11 | L1, X1 | L1 opens HR → Attendance → Attendance Operations (access denied, or every list shows the authority message); X1 cannot see HQ rows | SEC-01, SEC-02 |
| 12 | H1 | Wave 1 leave approval regression; Data Management screen only (no reset) | RG-01, RG-02 |
| 13 | Owner | Fill §4 summary; send to Coder AI for the tracker | — |

Detailed expected results per scenario follow. Preconditions "W3-P-01…W3-P-06" below mean all of §1.

### W3-AT-01 — Clock in / out records the server time
| | |
|---|---|
| Module / ID | Attendance (ESS) · W3-AT-01 |
| Role / policy | E1 (default Employee Self-Service) |
| Navigation | `/hr/mobile/attendance` |
| Preconditions | W3-P-01…W3-P-06 done. E1 not clocked in today. |
| Steps | 1. Open My Attendance → **Today**. 2. Note your phone/PC clock. 3. Press **CLOCK IN**. 4. Wait ≥ 2 minutes. 5. Press **CLOCK OUT**. 6. Open **History**. |
| Expected UI | Toast "✅ Clocked in — Recorded with the server time."; then "✅ Clocked out". History shows today with in/out times, worked time, channel **Mobile** (or Web when using a desktop browser). |
| Expected DB | `hr_attendance_entries`: new row, `source` = mobile/web, `clock_in_at` = server time (± seconds), `client_clock_in_at` = device time, `work_date` = today (MYT), `worked_minutes` ≥ 2, `status` closed. `hr_attendance_audit`: `clock_in`, `clock_out` rows (actor E1). |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | `hr_attendance_clock`; replaces direct table writes (D3-2) |
### W3-AT-02 — A second clock-in is refused
| | |
|---|---|
| Module / ID | Attendance (ESS) · W3-AT-02 |
| Role / policy | E1 |
| Navigation | `/hr/mobile/attendance` |
| Preconditions | E1 clocked in (W3-AT-01 step 3, before clock-out). |
| Steps | While clocked in, open My Attendance in a second browser tab and press **CLOCK IN** there. |
| Expected UI | Red toast "Not recorded — You are already clocked in." No success message. |
| Expected DB | Still exactly one open entry for E1. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | `hr_attendance_already_clocked_in` |
### W3-AT-03 — Shift punctuality (late arrival flagged, not blocked)
| | |
|---|---|
| Module / ID | Attendance (ESS) + review · W3-AT-03 |
| Role / policy | E1, then H1 |
| Navigation | `/hr/mobile/attendance` → Today → Shift |
| Preconditions | HR has a shift whose start time is **at least 20 minutes before now** (e.g. create "UAT early shift" in Attendance → Shifts) and policy "Late after (min)" = 15. |
| Steps | 1. E1 selects the shift and clocks in. 2. E1 clocks out. 3. H1 opens HR → Attendance → **Attendance Operations** → Operations → **Exceptions** (today). |
| Expected UI | E1 history shows a red **Late** badge and "under review". H1 sees "Late arrival (N min)" for E1 with **Acknowledge / Excuse / Dismiss**. |
| Expected DB | `attendance_flag` = late; `hr_attendance_exceptions` row `late_arrival`, `status` open, `entry_ref` = the entry; `review_state` pending. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | E-26 |
### W3-AT-04 — Normal day needs no approval (auto-validation)
| | |
|---|---|
| Module / ID | Attendance · W3-AT-04 |
| Role / policy | E2, H1 |
| Navigation | `/hr/mobile/attendance` and HR → Attendance → **Attendance Operations** → Operations → Daily board |
| Preconditions | E2 clocks in/out within the shift (or without a shift). |
| Steps | 1. E2 clocks in and out. 2. H1 opens Daily board for today. |
| Expected UI | E2 row shows "OK" in the Review column; nothing appears under Exceptions for E2. |
| Expected DB | E2 entry `review_state` = not_required; no `hr_attendance_exceptions` row for that entry. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | D-012 |
### W3-AT-05 — Report a missing day → independent approval
| | |
|---|---|
| Module / ID | Attendance corrections · W3-AT-05 |
| Role / policy | E1 (request), H1 (decide) |
| Navigation | `/hr/mobile/attendance` → Today → "Forgot to clock? Report a missing day"; then HR → Attendance → **Attendance Operations** → Operations → Corrections |
| Preconditions | A past **working** day on which E1 has no attendance and no leave (e.g. yesterday if it was a working day). |
| Steps | 1. E1: choose that date, In 09:00, Out 18:00, Break 60, reason "UAT missing day". **Submit for review**. 2. E1: History → "My correction requests" shows it **pending**. 3. H1: Corrections → the request → **Approve** (comment optional). |
| Expected UI | E1: "✅ Correction requested — … Your original record is kept." H1: "Correction approved — entry updated, original kept in the audit". E1 History now shows the day with channel **Correction**. |
| Expected DB | `hr_attendance_corrections`: `kind` missing_day, `status` approved, `reviewed_by` H1, `created_entry_ref` set. New entry `source` correction, 480 worked minutes. Any `absent_no_record` exception for that day → `resolved`, `resolution` corrected. Audit `correction_approved` with before/after. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | E-30 |
### W3-AT-06 — Correct an existing entry; the employee cannot approve it
| | |
|---|---|
| Module / ID | Attendance corrections · W3-AT-06 |
| Role / policy | E1, H1, H2 |
| Navigation | `/hr/mobile/attendance` → History → "Request correction" |
| Preconditions | E1 has an entry (W3-AT-01). |
| Steps | 1. E1: on the W3-AT-01 entry → **Request correction** → change In to 5 minutes earlier, reason "UAT reader delay" → Submit. 2. Try to submit a second correction for the same entry. 3. H1 (who is also an employee): request a correction of **H1's own** entry, then look at Corrections as H1. 4. H2 approves H1's correction. |
| Expected UI | Step 2: "A correction for this day is already waiting for review." Step 3: H1 sees no Approve button for their own request (it is not in H1's queue). Step 4: approved by H2. |
| Expected DB | One pending correction per entry; `original_clock_in` = recorded value; after H2 approval the entry `status` adjusted and `worked_minutes` recalculated. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | `hr_attendance_correction_pending`, `hr_attendance_self_review` |
### W3-AT-07 — Rejection needs a reason; requester can withdraw
| | |
|---|---|
| Module / ID | Attendance corrections · W3-AT-07 |
| Role / policy | E2, H1 |
| Navigation | `/hr/mobile/attendance` and HR → Attendance → **Attendance Operations** → Operations → Corrections |
| Preconditions | — |
| Steps | 1. E2 requests a correction (any entry). 2. H1 → Reject → try to confirm with an empty reason. 3. Enter "UAT not supported" → Reject. 4. E2 submits another correction and presses **Withdraw**. |
| Expected UI | Step 2: the Reject button stays disabled. Step 3: "Correction rejected"; E2 sees status **rejected** with the comment. Step 4: status **cancelled**. |
| Expected DB | Statuses rejected (with `review_comment`) and cancelled; entry unchanged. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref |  |
### W3-HR-01 — Daily attendance board
| | |
|---|---|
| Module / ID | Attendance (HR) · W3-HR-01 |
| Role / policy | H1 (Leave & Attendance Administrator) |
| Navigation | HR → Attendance → **Attendance Operations** → Operations → Daily board |
| Preconditions | — |
| Steps | Pick yesterday and today. |
| Expected UI | Every onboarded active employee of the HQ company with day type (working day / rest day / public holiday / On leave), attendance, worked time and open exceptions. |
| Expected DB | Read-only. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | `hr_attendance_day_board` |
### W3-HR-02 — HR manual entry → second HR person confirms (maker-checker)
| | |
|---|---|
| Module / ID | Attendance (HR) · W3-HR-02 |
| Role / policy | H1 (maker), H2 (checker) |
| Navigation | HR → Attendance → **Attendance Operations** → Operations → Manual entry; then Exceptions |
| Preconditions | E3 has no attendance on a past working day. |
| Steps | 1. H1: Manual entry → employee E3, that date, 09:00–18:00, break 60, reason "UAT card reader offline" → **Record attendance**. 2. H1: Exceptions → find "HR manual entry (second review)" for E3 → **Confirm entry**. 3. H2: Exceptions → **Confirm entry**. |
| Expected UI | Step 1: "Attendance recorded — A second HR person must confirm it". Step 2: refused "Another HR person must confirm an attendance entry you recorded." Step 3: resolved. |
| Expected DB | Entry `source` hr_manual, `recorded_by_ref` H1, `manual_reason` set; exception `manual_entry` resolved by H2 (`resolved_authority` hr). Audit `hr_manual_entry`. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | E-29 |
### W3-HR-03 — Manual entry refusals
| | |
|---|---|
| Module / ID | Attendance (HR) · W3-HR-03 |
| Role / policy | H1 |
| Navigation | HR → Attendance → **Attendance Operations** → Operations → Manual entry |
| Preconditions | W3-HR-02 done. |
| Steps | Try: (a) the same employee/date/time again; (b) H1 as the employee; (c) tomorrow's date; (d) an empty reason. |
| Expected UI | (a) "This time overlaps attendance already recorded…"; (b) "You cannot change your own HR record…"; (c) "Attendance cannot be recorded for the future."; (d) button disabled. |
| Expected DB | No new rows. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref |  |
### W3-HR-04 — HR adjustment of an existing entry (maker-checker)
| | |
|---|---|
| Module / ID | Attendance (HR) · W3-HR-04 |
| Role / policy | H1, H2 |
| Navigation | HR → Attendance → **Attendance Operations** → Operations → Daily board → "Adjust hh:mm" |
| Preconditions | E2 has an entry (W3-AT-04). |
| Steps | 1. H1: Daily board → E2 → **Adjust** → Clock out 17:30, reason "UAT badge-out late" → Submit adjustment. 2. H1: Corrections → the item has no Approve button. 3. H2: Corrections → Approve. |
| Expected UI | Step 1: "Adjustment submitted — Another HR person … must approve it." Step 3: approved; board shows the new time. |
| Expected DB | Correction `kind` hr_adjustment, `requested_by` H1, `reviewed_by` H2; entry `status` adjusted; audit before/after. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | E-29 |
### W3-EX-01 — Exception detection over a date range
| | |
|---|---|
| Module / ID | Attendance exceptions · W3-EX-01 |
| Role / policy | H1 |
| Navigation | HR → Attendance → **Attendance Operations** → Operations → Exceptions |
| Preconditions | A public holiday exists in the last 14 days (HR → Public Holidays) and one test employee has approved leave on a working day in that range. |
| Steps | 1. Status **Open**, From = 14 days ago, To = today → **Check this range**. 2. Look for E1/E2/E3. 3. Press **Check this range** again. |
| Expected UI | Toast "Attendance checked — N new exception(s)". Working days without attendance or leave show "No attendance (no leave)"; the public holiday and the approved-leave day do **not**. Step 3: "0 new exception(s)". |
| Expected DB | `hr_attendance_exceptions`: one row per employee/day/code; re-run adds nothing. Audit `exceptions_detected`. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | E-27 (absence rule) |
### W3-EX-02 — Resolve, excuse, dismiss
| | |
|---|---|
| Module / ID | Attendance exceptions · W3-EX-02 |
| Role / policy | H1 |
| Navigation | HR → Attendance → **Attendance Operations** → Operations → Exceptions |
| Preconditions | W3-EX-01 done. |
| Steps | 1. **Excuse** one absence with an empty note → then with "UAT approved by phone". 2. **Acknowledge** a late arrival. 3. Filter **Resolved**. |
| Expected UI | Excuse needs a note; resolved rows show the resolution, who decided and the note. |
| Expected DB | `status` resolved, `resolution` excused/acknowledged, `resolved_by_ref` H1. No change to attendance, payroll or leave. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | No payroll/disciplinary effect |
### W3-EX-03 — Manager without the approval key cannot decide
| | |
|---|---|
| Module / ID | Attendance exceptions (MSS) · W3-EX-03 |
| Role / policy | M1 (Manager Self-Service) |
| Navigation | `/hr/mobile/attendance` → (no Approvals tab expected) |
| Preconditions | S&A has **not** created `hr.mss.attendance_approve` (SA-R6). |
| Steps | M1 opens My Attendance. |
| Expected UI | No **Approvals** tab (nothing M1 may decide). HR decides instead. |
| Expected DB | — |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | SA-R6 forward-compatible path |
### W3-IM-01 — Download the import template
| | |
|---|---|
| Module / ID | Excel import · W3-IM-01 |
| Role / policy | H1 |
| Navigation | HR → Attendance → **Attendance Operations** → Operations → Excel import → **Download template** |
| Preconditions | — |
| Steps | Download and open the file. |
| Expected UI | Workbook with sheet **Attendance** (headers Employee No, Employee Email, Work Date, Clock In, Clock Out, Break Minutes, Shift, Note) and sheet **Instructions**. |
| Expected DB | — |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref |  |
### W3-IM-02 — Preview classifies every row; nothing is saved
| | |
|---|---|
| Module / ID | Excel import · W3-IM-02 |
| Role / policy | H1 |
| Navigation | HR → Attendance → **Attendance Operations** → Operations → Excel import → **Upload .xlsx for preview** |
| Preconditions | Template filled with **test accounts only**: row A = E2 valid past working day 09:00–18:00; row B = E2 same date and clock-in again (duplicate); row C = employee number 999999; row D = date 31/02/2026; row E = tomorrow; row F = E1 overlapping W3-AT-01 attendance; row G = E3 by e-mail (lower/upper case mixed). |
| Steps | Upload the file. |
| Expected UI | Preview: rows A and G **Ready**; B **Duplicate (skipped)**; C, D, E **Error** with reasons; F **Conflict (skipped)** "Overlaps attendance already recorded…". The counts line matches. |
| Expected DB | `hr_attendance_import_batches` status previewed with counts; `hr_attendance_import_rows` one row per line with outcome and messages. **No** new `hr_attendance_entries`. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | E-31 |
### W3-IM-03 — Commit, then the same file is refused
| | |
|---|---|
| Module / ID | Excel import · W3-IM-03 |
| Role / policy | H1 |
| Navigation | HR → Attendance → **Attendance Operations** → Operations → Excel import |
| Preconditions | W3-IM-02 preview open. |
| Steps | 1. **Import 2 row(s)**. 2. Upload the **same** file again. |
| Expected UI | Step 1: "2 row(s) imported"; batch status committed. Step 2: "This file has already been imported for this company." |
| Expected DB | Two entries `source` import with `import_batch_ref`; rows outcome imported with `entry_ref`; audit `import_committed`. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | idempotent |
### W3-IM-04 — Discard a preview
| | |
|---|---|
| Module / ID | Excel import · W3-IM-04 |
| Role / policy | H1 |
| Navigation | HR → Attendance → **Attendance Operations** → Operations → Excel import |
| Preconditions | — |
| Steps | Upload a different file (change one cell) → **Discard**. |
| Expected UI | Preview closes; "Recent imports" shows it cancelled. |
| Expected DB | Batch `status` cancelled; no entries. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref |  |
### W3-IM-05 — Commit re-validates (attendance recorded meanwhile)
| | |
|---|---|
| Module / ID | Excel import · W3-IM-05 |
| Role / policy | H1 |
| Navigation | HR → Attendance → **Attendance Operations** → Operations → Excel import + Manual entry |
| Preconditions | — |
| Steps | 1. Preview a file with one valid E3 row. 2. Before importing, record a Manual entry for E3 overlapping that row. 3. Import. |
| Expected UI | "0 row(s) imported — 1 row(s) changed since the preview and were skipped." Row shows **Conflict**. |
| Expected DB | Row outcome conflict; no duplicate attendance. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref |  |
### W3-OT-01 — Employee submits worked overtime
| | |
|---|---|
| Module / ID | Overtime (ESS) · W3-OT-01 |
| Role / policy | E1 |
| Navigation | `/hr/mobile/attendance` → **Overtime** |
| Preconditions | E1 has attendance on the date (W3-AT-01). |
| Steps | "Already worked", today, 60 minutes, reason "UAT month end" → **Submit overtime for approval**. |
| Expected UI | "✅ Overtime submitted for approval" (+ "Flagged for the approver: more than your recorded time" when the attendance does not cover it). The request appears **submitted**. |
| Expected DB | `hr_overtime_requests`: `status` submitted, `request_kind` post, `day_type` from the calendar, `exceeds_*` flags, `submitted_at`; `hr_overtime_request_events` one `submitted` row. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | D-014, E-33 |
### W3-OT-02 — Second claim for the same day refused
| | |
|---|---|
| Module / ID | Overtime (ESS) · W3-OT-02 |
| Role / policy | E1 |
| Navigation | `/hr/mobile/attendance` → Overtime |
| Preconditions | W3-OT-01 submitted. |
| Steps | Submit another request for the same date. |
| Expected UI | "You already have an overtime request for this date. Cancel it first…" |
| Expected DB | No second row. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | `hr_ot_duplicate` |
### W3-OT-03 — HR approves part of the request
| | |
|---|---|
| Module / ID | Overtime (HR) · W3-OT-03 |
| Role / policy | H1 |
| Navigation | HR → Attendance → **Attendance Operations** → Operations → Overtime (Waiting for decision) |
| Preconditions | W3-OT-01 submitted. |
| Steps | Approve E1's request, approved minutes **45**, comment "UAT partial". |
| Expected UI | "Overtime approved"; filter Approved shows 60m → 45m, decided by H1 (hr). E1 sees "approved 45m". |
| Expected DB | `status` approved, `approved_minutes` 45, `approver_id` H1, `decided_authority` hr; event `approved`. No pay calculated. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref |  |
### W3-OT-04 — Rejection needs a reason
| | |
|---|---|
| Module / ID | Overtime (HR) · W3-OT-04 |
| Role / policy | H1 |
| Navigation | same |
| Preconditions | E2 submitted a request. |
| Steps | Reject without text, then with "UAT covered by swap". |
| Expected UI | Button disabled until a reason is typed; then rejected with the comment visible to E2. |
| Expected DB | `status` rejected, `approver_comment` set. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref |  |
### W3-OT-05 — No self-approval
| | |
|---|---|
| Module / ID | Overtime · W3-OT-05 |
| Role / policy | H1 (as employee), H2 |
| Navigation | H1: `/hr/mobile/attendance` → Overtime; H1/H2: HR → Attendance → **Attendance Operations** → Operations → Overtime |
| Preconditions | — |
| Steps | 1. H1 submits own OT. 2. H1 looks at the Overtime queue. 3. H2 approves it. |
| Expected UI | Step 2: H1's own request is not in H1's queue. Step 3: approved by H2. |
| Expected DB | `approver_id` H2. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | `hr_ot_self_approval` |
### W3-OT-06 — Cancellation rules
| | |
|---|---|
| Module / ID | Overtime · W3-OT-06 |
| Role / policy | E1, H1 |
| Navigation | mobile + HR screen |
| Preconditions | An approved request (W3-OT-03) and a submitted one. |
| Steps | 1. E1 cancels the **submitted** one. 2. E1 has no Cancel on the **approved** one. 3. H1: Approved filter → **Cancel (HR)** → reason "UAT cancelled by management". |
| Expected UI | Step 1 cancelled; step 3 cancelled with history submitted > approved > cancelled. |
| Expected DB | Events in order; row kept (`status` cancelled, `cancel_reason`). |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref |  |
### W3-OT-07 — Pre-approval request and policy cap flag
| | |
|---|---|
| Module / ID | Overtime (ESS) · W3-OT-07 |
| Role / policy | E2 |
| Navigation | `/hr/mobile/attendance` → Overtime → "Plan ahead" |
| Preconditions | Policy overtime "maxDailyMinutes" = 120 (default). |
| Steps | Tomorrow, 150 minutes, From 18:00 To 20:30, reason "UAT cut-over". |
| Expected UI | Submitted; toast mentions "above the daily policy cap". HR queue shows **Above daily cap**. |
| Expected DB | `request_kind` pre, `planned_start_at/planned_end_at` set, `exceeds_policy_cap` true. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | not auto-refused |
### W3-RP-01 — Attendance period report
| | |
|---|---|
| Module / ID | Reporting · W3-RP-01 |
| Role / policy | H1 |
| Navigation | HR → Attendance → **Attendance Operations** → Operations → Report |
| Preconditions | — |
| Steps | Last 30 days → **Show** → **CSV**. |
| Expected UI | One row per employee: days, worked, late, early, no record, open, manual/import, OT approved/waiting. CSV downloads. |
| Expected DB | Read-only; minutes only (no pay). |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref |  |
### W3-LV-01 — Leave quote: working days by the database
| | |
|---|---|
| Module / ID | Leave (ESS) · W3-LV-01 |
| Role / policy | E1 |
| Navigation | `/hr/mobile/leave` → Apply |
| Preconditions | A public holiday inside the next weeks (or use a weekend). |
| Steps | Choose Annual leave from a Friday to the next Monday. |
| Expected UI | Grey box: "2 working days", "Not counted: <Sat> (rest day), <Sun> (rest day)" (and holidays), balance after when an entitlement exists. |
| Expected DB | Nothing written (quote only). |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | `hr_leave_quote` |
### W3-LV-02 — Database sets total days; weekend-only and overlap refused
| | |
|---|---|
| Module / ID | Leave (ESS) · W3-LV-02 |
| Role / policy | E1 |
| Navigation | `/hr/mobile/leave` → Apply |
| Preconditions | — |
| Steps | 1. Submit Friday–Monday. 2. Submit Saturday–Sunday. 3. Submit the same Friday again. |
| Expected UI | Step 1 submitted (2 days in Requests). Step 2: quote error "contains no working days" and Submit disabled (or "The selected dates contain no working days" if forced). Step 3: "You already have leave on some of these dates." |
| Expected DB | Request `total_days` = 2 whatever the client sent; no row for steps 2/3. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | E-36, E-38 |
### W3-LV-03 — HR sets an entitlement (ledger line with reason)
| | |
|---|---|
| Module / ID | Leave (HR) · W3-LV-03 |
| Role / policy | H1 |
| Navigation | HR → Leave Management → **Balances & Entitlements** (`/hr/leave/requests?tab=balances`) |
| Preconditions | — |
| Steps | Year = this year → click E2's Annual cell → **Set entitlement** 3, reason "UAT entitlement" → Save. |
| Expected UI | "Balance updated — Recorded as a ledger line with your reason."; cell shows 3 (minus pending/taken). E2 mobile Balance shows the same. |
| Expected DB | `hr_leave_ledger` entry_type entitlement (+delta), actor H1, reason; `hr_leave_balances` row updated by the database. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | E-35 |
### W3-LV-04 — Insufficient balance refused, with the numbers
| | |
|---|---|
| Module / ID | Leave (ESS) · W3-LV-04 |
| Role / policy | E2 |
| Navigation | `/hr/mobile/leave` → Apply |
| Preconditions | W3-LV-03 (3 days). |
| Steps | Apply 4 working days of Annual leave. |
| Expected UI | Quote: "Not enough balance in <year>: 4 day(s) requested, 3 available." Submit disabled. |
| Expected DB | No request. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | E-37 |
### W3-LV-05 — Approval posts taken; HR cancellation reverses
| | |
|---|---|
| Module / ID | Leave (ESS/HR) · W3-LV-05 |
| Role / policy | E2, H1 |
| Navigation | E2: `/hr/mobile/leave`; H1: HR → Leave Management → **Leave Requests & Approvals** (Approve / **Cancel leave** on the request card) |
| Preconditions | E2 applies 2 days (within balance). |
| Steps | 1. H1 approves (Leave Requests & Approvals → **Approve**). 2. Check E2 balance (Balances & Entitlements, and E2 mobile Balance). 3. H1 presses **Cancel leave** on the approved request → **Cancel leave**. 4. Check again. |
| Expected UI | After approval: taken 2, available 1. After cancellation: taken 0, available 3. |
| Expected DB | Ledger: taken −2 (request_ref), then taken_reversal +2. B2A event rows unchanged in behaviour. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref |  |
### W3-LV-06 — Adjustment rules
| | |
|---|---|
| Module / ID | Leave (HR) · W3-LV-06 |
| Role / policy | H1 |
| Navigation | HR → Leave Management → **Balances & Entitlements** (`/hr/leave/requests?tab=balances`) |
| Preconditions | — |
| Steps | 1. Adjust E2 by +0.5 with reason. 2. Try +0.3. 3. Try adjusting **H1's own** balance. |
| Expected UI | 1 saved; 2 "Enter a valid number of days (whole or half days)"; 3 "You cannot change your own HR record…". |
| Expected DB | Ledger only for step 1. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref |  |
### W3-LV-07 — Entitlement run — PREVIEW only
> 🔴 **Applying** the run writes entitlements for **every employee of the company** (real staff on shared staging). Do not press Apply unless separately authorized.

| | |
|---|---|
| Module / ID | Leave (HR) · W3-LV-07 |
| Role / policy | H1 |
| Navigation | HR → Leave Management → **Balances & Entitlements** (`/hr/leave/requests?tab=balances`) → "Preview entitlement run…" |
| Preconditions | The Annual leave type has entitlement tiers (Leave Types → Entitlement tiers). |
| Steps | Set Year = next year; press **Preview entitlement run…**; read the preview; press **Close (nothing written)**. Do **not** tick the authorization box. |
| Expected UI | Rows per employee: years of service, days from the type's tiers (pro-rata for this year's hires), status would set / skipped existing / skipped own record. |
| Expected DB | Nothing written. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | E-39 |
### W3-LV-08 — Carry-forward — PREVIEW only
> 🔴 Applying posts carry-forward lines for every eligible employee of the company — separate authorization only. Expiry is NOT automated (PD-LV-02).

| | |
|---|---|
| Module / ID | Leave (HR) · W3-LV-08 |
| Role / policy | H1 |
| Navigation | HR → Leave Management → **Balances & Entitlements** → "Preview carry-forward …" |
| Preconditions | Annual leave type has carry-forward enabled (max days). |
| Steps | Open the preview for this year → **Close (nothing written)**. Do **not** tick the authorization box. |
| Expected UI | Rows with the capped days, "skipped pending requests" where requests are pending. |
| Expected DB | Nothing written. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | E-40 |
### W3-LV-09 — Opening balance preserved
| | |
|---|---|
| Module / ID | Leave (data check) · W3-LV-09 |
| Role / policy | Owner (KVM2 output) |
| Navigation | X-8 output section 6 |
| Preconditions | Wave 3B applied. |
| Steps | Read section 6 of the post-apply output. |
| Expected UI | — |
| Expected DB | `opening_marker` t, `projection_mismatches` 0, `approved_requests_without_taken_line` 0; balances the employees saw before are unchanged (spot-check two test accounts on mobile). |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | E-35 |
### W3-SEC-01 — Legacy-only admin gets no attendance authority
| | |
|---|---|
| Module / ID | Security · W3-SEC-01 |
| Role / policy | L1 |
| Navigation | HR → Attendance → Attendance Operations |
| Preconditions | — |
| Steps | Open the page; if it opens, try any action. |
| Expected UI | Page denied, or each Operations tab shows the amber "You do not have HR authority…" message with *Try again* (no data, no actions). |
| Expected DB | No rows written. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | D-021/E-24 rule |
### W3-SEC-02 — Other company isolation
| | |
|---|---|
| Module / ID | Security · W3-SEC-02 |
| Role / policy | X1 / HR of another company |
| Navigation | their own HR attendance screen |
| Preconditions | — |
| Steps | Look for HQ test employees on the board, exceptions and overtime queue. |
| Expected UI | None visible. |
| Expected DB | — |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref |  |
### W3-SEC-03 — Old direct-write path is closed (technical, optional)
| | |
|---|---|
| Module / ID | Security · W3-SEC-03 |
| Role / policy | E1 |
| Navigation | browser DevTools console on localhost (optional) |
| Preconditions | Wave 3A applied. |
| Steps | No action needed in UAT: proven by the replica tests G1–G4, G3b, RS10 (tracker §11). Mark **Not run (covered by replica)** unless a technical reviewer wants to repeat it. |
| Expected UI | Error "hr_attendance_direct_write_refused". |
| Expected DB | No row. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref | guard trigger |
### W3-RG-01 — Regression: Wave 1 leave approval with the ledger
| | |
|---|---|
| Module / ID | Regression · W3-RG-01 |
| Role / policy | E1, M1, H1 |
| Navigation | Wave 1 guide LV-03, LV-04, LV-05 |
| Preconditions | Wave 1 accounts. |
| Steps | Re-run LV-03, LV-04, LV-05 of the Wave 1+2 guide. |
| Expected UI | Same results as in the Wave 1 guide; in addition the ledger shows taken lines for approvals. |
| Expected DB | B2A rules unchanged. |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref |  |
### W3-RG-02 — HR Data Management reset/restore with Wave 3
> 🔴 DESTRUCTIVE — separate authorization; never on shared staging with real data.

| | |
|---|---|
| Module / ID | Regression · W3-RG-02 |
| Role / policy | S1-type super admin |
| Navigation | HR → Settings → Data Management |
| Preconditions | — |
| Steps | Do NOT run on shared staging. |
| Expected UI | — |
| Expected DB | Replica evidence only (RS1–RS10). |
| Result | ☐ PASS ☐ FAIL ☐ Not run |
| Defect notes | |
| Tech ref |  |
## 3. Defect reporting

Use the template of the [Wave 1+2 guide §9](HR_WAVE1_WAVE2_COMPREHENSIVE_UAT.md) (test ID, account, time, URL, steps, expected, actual message, network response of the failing `/api/hr/…` call, table/row id — no personal data, severity). Database rows can be checked read-only in Supabase Studio; the post-apply output (X-8) section 8 gives aggregate counts.

## 4. Summary (owner)

| Area | Tests | PASS | FAIL | Not run | Signed off (date) |
|---|---|---|---|---|---|
| Attendance (ESS) | 7 | | | | |
| HR attendance | 4 | | | | |
| Exceptions | 3 | | | | |
| Excel import | 5 | | | | |
| Overtime | 7 | | | | |
| Report | 1 | | | | |
| Leave ledger | 9 | | | | |
| Security | 3 | | | | |
| Regression | 2 | | | | |

UAT PASS is recorded in [HR_PROGRESS_TRACKER.md](../HR_PROGRESS_TRACKER.md) only from this signed summary.
