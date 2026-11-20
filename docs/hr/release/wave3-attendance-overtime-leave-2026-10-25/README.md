# Wave 3 — Hybrid Attendance, Overtime workflow, Leave ledger — release package (2026-10-25)

Back to [HR_MASTER_INDEX.md](../../HR_MASTER_INDEX.md) · previous packages: [Wave 1 (B2A/B2B)](../b2a-staging-2026-10-24/README.md) · [Wave 2](../wave2-employment-foundation-2026-10-25/README.md) · UAT: [uat/HR_WAVE3_UAT.md](../../uat/HR_WAVE3_UAT.md) · S&A: [HR_SA_DEPENDENCY_HANDOVER_WAVE3.md](HR_SA_DEPENDENCY_HANDOVER_WAVE3.md)

Prepared by Coder AI on branch `Enhancement03`, HEAD `b6b78002` (no commit, no push, no deploy, no live database action).

## 1. Status at a glance (separate fields — rule 14)

| Field | Wave 3A `20261222100000_hr_hybrid_attendance_overtime.sql` | Wave 3B `20261223100000_hr_leave_ledger.sql` | Application (routes + screens) |
|---|---|---|---|
| Design approved | Owner directive 2026-10-25 (Wave 3, "continue directly"); detail = engineering defaults E-25…E-45 (PD-ATT/PD-OT/PD-LV still open) | same | same |
| Code implemented | **Yes** (uncommitted) | **Yes** (uncommitted) | **Yes** (uncommitted) |
| Automated tests | 2026-10-26: replica **411/411** incl. E-47 WP alias; Mac Vitest 6,721 pass / 1 known non-HR fail, build PASS, **tsc crashed (no result — re-run)**. Earlier: Replica **405/405** (staging snapshot, lifecycle order) + **362/362** (production snapshot, `--no-lifecycle`), negative control 3/3 | included | Vitest full 6,717 pass / 1 known non-HR fail; full tsc 0 HR errors |
| Migration prepared | Yes | Yes | n/a |
| Applied to staging | **Yes 2026-10-25 (owner); VERIFIED read-only 2026-10-26** | **Yes 2026-10-25 (owner); VERIFIED read-only 2026-10-26** | n/a |
| Applied to production | No | No | n/a |
| Deployed | n/a | n/a | **No** — staging still runs the old build (BL-28): UAT on localhost |
| Owner UAT | **Not performed** | Not performed | Not performed |
| Go-live ready | No | No | No |

## 2. What Wave 3 delivers

**Hybrid Attendance (B4a/B4b/B4c)**
- *Reliable capture*: every attendance / correction / OT write goes through database functions — server clock, canonical identity (current completed employment), channel (`web`, `mobile`, `hr_manual`, `import`, `correction`), audit. API roles can no longer write those tables directly (guard trigger). The device time is stored only as information (`client_clock_in_at`).
- *Employee*: mobile clock in/out, 31-day history with review state and exceptions, correction of an entry or a **missing day**, withdraw a pending correction (`/hr/mobile/attendance`).
- *Auto-validation (D-012)*: a valid day needs no approval. Exceptions — late arrival, early departure, missing clock-out, working day without attendance or leave, work on a rest day/public holiday, HR manual entry — are detected from the **existing** policy and shift fields, idempotently, and cleared automatically when the cause disappears.
- *Independent review*: exceptions and corrections are decided by explicit HR (`hr.attendance.manage`), or by the direct manager once S&A provides `hr.mss.attendance_approve`; never by the employee or the requester. An HR manual entry is confirmed by a **second** HR person (maker-checker). HR adjustments of existing entries are corrections approved by someone else. Originals are kept on the correction row and in `hr_attendance_audit` (before/after).
- *HR operations screen* (HR → Attendance → Clock In / Out → "Attendance operations"): daily board, exceptions (with "Check this range"), corrections, manual entry, Excel import, overtime queue, period report with CSV.
- *Excel bulk import*: downloadable template (+ instructions sheet), browser-side reading (ISO / DD/MM/YYYY / Excel dates; 24-h, AM/PM or Excel times), **database preview** of every row (employee number and/or e-mail, formats, employment dates, duplicates in the file, exact duplicates of recorded attendance, conflicts), explicit commit with the previewed valid count, commit-time re-validation, per-row outcome, idempotent retry, same file (SHA-256) only once per company, recorded attendance never overwritten, audit.

**Overtime (B5)** — separate from attendance (D-014): pre-approval or worked (post) requests, one active request per employee and day, day type from the calendar, policy-cap and recorded-time flags for the approver, partial approval, rejection with comment, append-only status history, HR-only cancellation of approved OT, idempotency key, `payroll_consumed_ref` slot (Phase B). **No auto-approval, no pay/rate calculation.**

**Leave (B6, part)** — on top of B2A (B2A still decides every transition):
- Append-only **leave ledger**; `hr_leave_balances` becomes the database projection (entitled + carried forward + adjustment − taken − pending). Approval posts *taken*; HR cancellation of approved leave posts a *reversal*.
- **Opening balance**: existing balances and approved requests are posted so that every **available** balance is unchanged; differences between stored "taken" and approved requests stay visible as an explicit reconciliation line.
- **Working days** by the database for every submission (policy workdays, national + work-state public holidays, half day = 0.5), cross-year split, duplicate/overlap protection, balance enforcement where an entitlement exists (re-checked at approval).
- HR: balance overview, ledger per employee, set entitlement, ± adjustment (reason), **entitlement run** from the leave type's own tiers/pro-rata, **carry-forward run** capped by the type's own setting (preview first; expiry not automated).
- Employee: server quote before submitting (working days, days not counted, balance after, warnings/blocking errors) on mobile; corrected balance formula on web and mobile.
- Payroll readiness: approved unpaid leave days per period (no pay calculation).

## 3. Wave 1/2 defects found and fixed in this session

| # | Defect (current code before Wave 3) | Fix |
|---|---|---|
| D3-1 | `POST /api/hr/attendance/clock` upserted the weekly timesheet with `status='pending'` on every clock-out — an **approved** period was silently reset | Timesheet summary only for draft/pending periods (`hr_att_refresh_timesheet`); replica A10 |
| D3-2 | Mobile attendance wrote `hr_attendance_entries` directly with the **device clock**; clock-out set no `worked_minutes` and no timesheet; corrections only against an open entry | Routes + database functions; missing-day corrections |
| D3-3 | RLS let an employee **update their own OT request** (e.g. to `approved`) and insert/update their own attendance with any time | Guard trigger; negative control N1/N2, G1/G3/G3b |
| D3-4 | Web and mobile leave "remaining" ignored carried-forward and adjustment days | Formula = table rule / ledger projection |
| D3-5 | Leave `total_days` was client-calculated (weekends/holidays counted) | Database working days (N3 → L1–L4) |

## 4. Supported order and coupling (read before applying)

1. `20261219100000` (B2A, applied on staging) → `20261221100000` (Wave 2, **owner-reported applied on staging**; verify with step X-1) → **`20261222100000`** → **`20261223100000`**. 3B refuses to run without 3A; 3A refuses without Wave 2.
2. **Coupling:** apply both Wave 3 files **together with the deployment of the Wave 3 build** to the same environment. The old build writes attendance/OT directly and is refused by the guard after 3A; the Wave 3 build on a database without 3A shows "not installed" (HTTP 503) on attendance and overtime screens. Localhost UAT against staging needs 3A/3B on staging.
3. 3B refuses to run if `hr_leave_balances` holds two rows for the same employee, leave type and year (preflight B3 counts them).

## 5. Owner-run steps (each separately authorized)

| Step | Action | Evidence / PASS criterion |
|---|---|---|
| X-1 | **DONE 2026-10-25/26** (`out-w2w3-20261025-195856`: Wave 2 26/26 verified). On the Mac: `bash docs/hr/release/wave3-attendance-overtime-leave-2026-10-25/kvm2_hr_w2_w3_readonly.sh` (read-only; refuses non-staging hosts; asks you to type STAGING) | 04: Wave 2 sections as listed; **05: `matching | expected` = `26 | 26`** (Wave 2 bodies = repository → independent verification of the owner-reported application), B1 all `t`, B2 all `f`, **B3 duplicate_balance_keys = 0**; 06: B2A intact; 07: `w3a_applied = f`, `w3b_applied = f`. Share the output folder |
| X-2 | **PARTIAL 2026-10-26** — Vitest + build PASS, tsc crashed (heap); script fixed, re-run. Mac: `bash docs/hr/release/b2a-staging-2026-10-24/local_verify_isolated.sh` | Vitest: only the known non-HR failure; tsc 0 HR errors; `npm run build` OK |
| X-3 | Optional: replica suite on a local PostgreSQL 16/17: `build_replica_from_snapshot.sh <port> stg w3test` then `supabase/tests/security/hr_attendance_overtime/run.sh postgresql://…/w3test` | `ALL HR WAVE 3 TESTS PASSED (405 checks)` |
| X-4 | Review the diff; commit **only** the manifest of §9 (tests/scripts need `git add -f`, BL-16) | commit hash |
| X-5 | S&A: explicit `hr-leave-attendance-administrator` (has `hr.attendance.manage` + `hr.leave.approve`) for real HR approvers; Manager Self-Service for line managers (handover) | assignment list |
| X-6 | **DONE 2026-10-25 (owner)** — record both in PMS. Backup staging; `psql "<staging>" -X -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20261222100000_hr_hybrid_attendance_overtime.sql`, then the same for `20261223100000_hr_leave_ledger.sql`; record both in `PRODUCTION_MIGRATION_STATUS.md` | both applied without error |
| X-7 | Deploy the X-4 commit to staging **in the same window as X-6** | KVM2 03 markers `hr_attendance_my_overview` > 0 |
| X-8 | **DONE 2026-10-26: PASS** (61/61 bodies, 7/7 triggers, 5/5 sealed, 5/5 reset scope, backfill 0, marker `t`, 0 mismatches, B2A 6/0). Re-run X-1 | 07: every function `body_matches_repo = t`, 7 triggers `O`, sealed tables, 5 reset-scope rows, `entries_without_work_date = 0`, opening marker `t`, `projection_mismatches = 0`, `approved_requests_without_taken_line = 0`, B2A 6/0 |
| X-8b | Optional (E-47): `psql "<staging>" -X -1 -v ON_ERROR_STOP=1 -f supabase/migrations/20261224100000_hr_w3_wp_holiday_alias.sql` (replaces only `hr_att_day_type`; WP/Federal Territory holidays count for KUL/LBN/PJY). Alternative: relabel the `WP` holiday to `KUL` | re-run X-1: `hr_att_day_type` `body_matches_repo = t` (either hash accepted) |
| X-8c | Optional: re-run X-1 for **section 9** (`09_uat_readiness.txt`: policies carrying the Wave 3 permissions; HR configuration per organization) | input for UAT §1 |
| X-9 | Owner UAT (**localhost**, after UAT §1 configuration + grants): [uat/HR_WAVE3_UAT.md](../../uat/HR_WAVE3_UAT.md) | signed summary |

Production: not prepared, not authorized.

## 6. Isolated test evidence (Coder AI, 2026-10-25; no staging/production connection)

| Check | Result |
|---|---|
| Replica `hr_attendance_overtime/run.sh` (staging snapshot 2026-10-16; lifecycle → B2A → W2 → **W3A → W3B**, re-apply ×2, W2 behaviour with W3, W3 behaviour, B2A + W2 lifecycle compatibility with W3, **HR reset/restore byte-identical**, safe rollback, re-apply) | **PASS 405 checks** |
| Same on the production snapshot (`--no-lifecycle`) | **PASS 362 checks** |
| Negative control (W3 not installed: employee sets own attendance time, approves own OT by direct update, weekend leave accepted) | **3/3 gaps reproduced** |
| Wave 2 suite baseline at session start | PASS 235/235 |
| Vitest full suite (679 files) | **6,717 pass / 1 fail (known non-HR ship-metrics) / 6 skipped**; HR scope 100 % PASS; new mobile attendance test fails 5/5 on the old component (negative control) |
| Full `tsc --noEmit` | **0 errors in HR files**; 250 pre-existing errors in 83 non-HR files (unchanged baseline) |
| KVM2 script | rehearsed end-to-end with mocked ssh/docker against the replica (only the expected missing `supabase_migrations` ledger error) |

## 7. Rollback (safe — never restores insecure access, never deletes history)

Per the migration headers: drop the three `*_api_guard` triggers (3A) and `hr_w3_leave_requests_quote` / `hr_leave_requests_w3_ledger` (3B). Functions and all new tables (exceptions, imports, OT history, leave ledger) are kept as evidence. B2A and Wave 2 are untouched by a Wave 3 rollback (replica RB3). After a rollback the old build works again; `hr_leave_balances` keeps its last projected values.

## 8. Decisions taken (engineering defaults, documented as E-25…E-45 in the decision register)

Open owner decisions are **not** pre-empted: no statutory leave minima, no carry-forward expiry, no attendance lock, no OT pay rates, no disciplinary or payroll effect of exceptions. Where a mechanism needed a rule, the rule comes from the **existing configuration HR already maintains** (policy late/early minutes, workdays, shifts, holidays, leave-type tiers/pro-rata/carry-forward cap) and the alternatives are listed with each PD item.

## 9. HR-only Git manifest (Wave 3 additions to the Wave 1 + Wave 2 manifest) — not staged, not committed

```
# new migrations
supabase/migrations/20261222100000_hr_hybrid_attendance_overtime.sql
supabase/migrations/20261223100000_hr_leave_ledger.sql
supabase/migrations/20261224100000_hr_w3_wp_holiday_alias.sql   (optional correction E-47, 2026-10-26)
# replica suite (git add -f: **/tests/**, *.sh)
supabase/tests/security/hr_attendance_overtime/{run.sh,05_negative_control.sql,10_opening_checks.sql,15_w3_fixtures.sql,20_w3_tests.sql,30_reset_compat.sql,40_safe_rollback.sql,50_after_reapply.sql,60_wp_alias.sql}
# application — new
app/src/lib/hr/wave3/{messages.ts,server.ts,client.ts,attendance-import.ts}
app/src/app/api/hr/attendance/{me,manual-entry,exceptions,board,report,import}/route.ts
app/src/app/api/hr/leave/{quote,balances,ledger,admin,unpaid}/route.ts
app/src/components/hr/modules/{HrAttendanceOperationsView.tsx,HrLeaveBalancesPanel.tsx}
# application — rewritten / modified
app/src/app/api/hr/attendance/clock/route.ts
app/src/app/api/hr/attendance/corrections/route.ts
app/src/app/api/hr/attendance/corrections/[id]/review/route.ts
app/src/app/api/hr/attendance/overtime/requests/route.ts
app/src/components/hr/mobile/HrMobileAttendance.tsx
app/src/components/hr/mobile/HrMobileLeave.tsx
app/src/components/hr/modules/HrAttendanceClockView.tsx
app/src/components/hr/modules/HrLeaveRequestsView.tsx
app/src/lib/api/attendance.ts
app/src/modules/hr/leave/{leaveErrors.ts,supabaseRepository.ts,mobileLeave.ts}
app/src/lib/security-access/route-coverage.ts            (11 new HR routes; 4 HR entries re-pointed — HR-owned lines only)
# tests (git add -f: *.test.ts / *.test.tsx)
app/src/lib/hr/wave3/wave3-lib.test.ts
app/src/lib/hr/test-support/wave3Mocks.ts
app/src/app/api/hr/attendance/__tests__/wave3-attendance-routes.test.ts
app/src/app/api/hr/leave/__tests__/wave3-leave-routes.test.ts
app/src/components/hr/mobile/HrMobileAttendance.test.tsx
app/src/components/hr/mobile/HrMobileLeave.test.tsx                (Wave 3 quote test appended)
app/src/components/hr/modules/HrAttendanceOperationsView.test.tsx
app/src/lib/hr/migration-versions.test.ts                          (Wave 3 version test appended)
# removed (replaced by the Wave 3 route tests above; they tested the B2B direct-write routes) — moved to tmp/hr-wave3/_removed/ (never committed)
app/src/app/api/hr/attendance/corrections/[id]/review/route.test.ts
app/src/app/api/hr/attendance/overtime/requests/route.test.ts
# documentation
docs/hr/release/wave3-attendance-overtime-leave-2026-10-25/{README.md,HR_SA_DEPENDENCY_HANDOVER_WAVE3.md,hr_w2_verify_w3_preflight_readonly.sql,hr_w3_staging_post_apply_readonly.sql,hr_w3_uat_readiness_readonly.sql,kvm2_hr_w2_w3_readonly.sh}
docs/hr/release/b2a-staging-2026-10-24/local_verify_isolated.sh   (tsc heap fix E-48)
docs/hr/uat/HR_WAVE3_UAT.md
docs/hr/uat/HR_WAVE1_WAVE2_COMPREHENSIVE_UAT.md
docs/hr/{HR_MASTER_INDEX,HR_MASTER_SCOPE,HR_DECISION_REGISTER,HR_IMPLEMENTATION_ROADMAP,HR_PROGRESS_TRACKER,HR_GO_LIVE_GATES}.md
```

Excluded (other workstreams, present in the working tree): inventory files, `components/dashboard/DashboardContent.tsx`, `lib/navigation/`, `*.out`, `backup_diag.txt`, `.code-workspace` files, `20261220100000_inventory_cases_and_pcs.sql`.

### 9a. Additions of the 2026-10-26 UI/UX completion session ([report](../ui-ux-completion-2026-10-26/README.md)) — not staged, not committed

```
# application — new
app/src/app/hr/attendance/public-holidays/page.tsx
# application — modified (HR-owned)
app/src/modules/hr/hrNav.ts
app/src/modules/hr/components/HrLandingView.tsx
app/src/components/hr/HrPeopleView.tsx
app/src/components/hr/people/EmploymentHistoryPanel.tsx
app/src/components/hr/workspace/HrMyWorkspaceView.tsx
app/src/components/hr/mobile/HrMobileLeave.tsx
app/src/components/hr/modules/{HrAttendanceClockView,HrAttendanceOperationsView,HrLeaveRequestsView,HrLeaveBalancesPanel,HrPublicHolidaysView,HrSettingsApprovalRulesView}.tsx
app/src/lib/hr/employment-messages.ts
# shared file — ONE HR line only (HrMyWorkspaceView userId); stage with `git add -p`, never the navigation workstream's hunks
app/src/components/dashboard/DashboardContent.tsx
# database (prepared, not applied) + replica test
supabase/migrations/20261224100000_hr_w3_wp_holiday_alias.sql
supabase/tests/security/hr_attendance_overtime/60_wp_alias.sql
# tests (git add -f)
app/src/modules/hr/hrNav.routes.test.ts
app/src/app/hr/attendance/public-holidays/page.access.test.tsx
app/src/components/hr/modules/{HrAttendanceClockView.tabs,HrAttendanceOperationsView.states,HrLeaveRequestsView.workflow,HrLeaveBalancesPanel,HrPublicHolidaysView}.test.tsx
app/src/components/hr/mobile/HrMobileLeave.withdraw.test.tsx
app/src/components/hr/people/EmploymentChange.test.tsx
app/src/components/hr/workspace/HrMyWorkspaceView.history.test.tsx
# docs
docs/hr/release/ui-ux-completion-2026-10-26/README.md
docs/hr/uat/HR_WAVE1_WAVE2_COMPREHENSIVE_UAT.md
docs/hr/uat/HR_WAVE3_UAT.md
```
