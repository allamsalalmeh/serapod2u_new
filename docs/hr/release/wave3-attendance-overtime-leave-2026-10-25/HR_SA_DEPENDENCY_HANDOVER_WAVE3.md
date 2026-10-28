# HR → S&A dependency handover — Wave 3 (2026-10-25)

Back to the [Wave 3 release README](README.md) · earlier: [Wave 2 handover](../wave2-employment-foundation-2026-10-25/HR_SA_DEPENDENCY_HANDOVER_WAVE2.md) (SA-R1…SA-R5 still open).

HR changed **no** S&A catalogue row, policy, grant, mode or S&A-owned source. The only S&A-adjacent HR edit is the HR rows of `app/src/lib/security-access/route-coverage.ts` (registry of HR API routes, as in Wave 2). Wave 3 database functions use the Wave 2 rule `hr_actor_has_explicit` (explicit, non-legacy assignment or Root Access in the employee's organization; legacy compatibility, delegation and emergency access never count).

| # | Request to the S&A owner | Why | Until it is done |
|---|---|---|---|
| SA-R6 | **Create `hr.mss.attendance_approve`** (Manager Self-Service: decide a direct report's attendance exceptions and corrections) — LEGACY_RETIRED from birth, member of `manager-self-service` only if the owner wants managers to decide (PD-ATT-04/06) | Database already checks it (forward-compatible) together with the verified reporting line | Only explicit HR (`hr.attendance.manage`) decides; managers **see** exceptions with `hr.mss.attendance_view` |
| SA-R7 | **Create `hr.mss.overtime_approve`** (proposed in P-R05) — same pattern (PD-OT-01) | Database already checks it | Only explicit HR approves OT |
| SA-R8 | Explicit `hr-leave-attendance-administrator` grants (holds `hr.attendance.manage` **and** `hr.leave.approve`) for the real HR approvers, scoped to the HQ company — at least **two people** (maker-checker for manual attendance entries and HR adjustments) | KVM2 2026-10-25: 0 explicit `hr.leave.approve` holders (BL-23); `hr.attendance.manage` coverage measured by the X-1 preflight (B8) | Only Root can act as HR |
| SA-R9 | Confirm `hr.self_service.use` reaches every employee who should clock in (default ESS) | The clock, my-attendance, OT submission and leave quote routes require it | Employees without ESS get 403 |
| SA-R10 | (with PD-SA-01) `hr.leave.manage` / `hr.leave.view` | Leave balance administration uses `hr.leave.approve` until then | as is |
| SA-R11 | (B8, navigation) optional HR destinations for Attendance → Exceptions / Import / Overtime, Leave → Balances | Wave 3 screens live inside the existing destinations `hr/attendance/clock-in-out` and `hr/leave/requests` (no nav-access change by HR) | Screens reachable through the existing entries |

Route coverage added (HR rows): `hr/attendance/{board,exceptions,import,manual-entry,me,report}`, `hr/leave/{admin,balances,ledger,quote,unpaid}`; re-pointed to `lib/hr/wave3/server.ts`: `hr/attendance/{clock,corrections,corrections/[id]/review,overtime/requests}`. Permissions referenced are existing catalogue keys only (`hr.attendance.manage`, `hr.mss.attendance_view`, `hr.self_service.use`, `hr.leave.approve`, `hr.mss.leave_view`); the two requested MSS keys appear only in the database and in `W3_PERMISSIONS`.
