# HR — Employee Lifecycle Gap Review (Task D)

Branch `Enhancement03` @ `82da8cd0` · read-only · 2026-10-24.
Preserved decisions: one canonical identity (`public.users`, immutable UUID); `hr_employees` as the employment anchor owning the employee number; onboarding state separate from login/access; controlled Delete/Reset via break-glass `hr.employee.delete`; Archive keeps UUID, name, employee number and all history.

---

## 1. Lifecycle operations now in the code base

| Operation | Entry | DB function (migration) | Applied? | Effect |
|---|---|---|---|---|
| Add Employee / onboard | HR → Employees | `hr_onboarding_complete` (20261003100000) | ✅ staging + prod | `pending/reset → completed`, reuses identity + employee no. |
| Remove HR Registration | row menu | `hr_employee_registration_execute` action `delete` (20261214100000) | ❌ not recorded | `→ pending`; blocked by any HR row, direct reports, HR live, self |
| Reset HR Registration | row menu | same, action `reset` | ❌ | `completed → reset`; history kept |
| Delete Employee Permanently | row menu, bulk | `identity_deletion_execute` (20261216100000) | ❌ | Deletes `auth.users` + `public.users` + `hr_employees` in one transaction; blocked by any history, direct reports, HR live, Root, last admin |
| **Archive & Revoke Access** | row menu, bulk, UM | `identity_archive_execute` (20261217100000 → 20261218100000) | ❌ | `hr_employees.status = resigned|terminated`, `end_date = coalesce(end_date, current_date)`; `ARCHIVED`; S&A leaver sync; login ban + sessions/tokens revoked; optional identifier release |
| Release Email & Phone | Former tab | `identity_release_identifiers` | ❌ | Placeholder email, original values in restricted snapshot |
| Reactivate | UM | `identity_set_account_status` | ❌ (new body) | Restores identifiers (fails closed if reused) |
| Bulk removal | HR toolbar | loops the two canonical executes (no new DB function) | committed `82da8cd0` (needs #8/#10 applied) | HMAC-signed plan, per-target preview hashes |

**Verdict on the controlled Delete/Reset architecture:** sound and consistent with the canonical identity model; the remaining gaps are all in the *ongoing* (post-go-live) leaver path and in history, not in delete/reset.

## 2. Gaps

### D1 — Archive leaves reporting lines pointing at a former employee (P0 before go-live)

`identity_archive_plan` reports `DIRECT_REPORTS` as a **warning** (`…20261217100000…sql:448`), not a blocker, and nothing re-points `hr_employees.manager_user_id`. Consequences: MSS (`loadDirectReports`) returns nobody for the subordinates' new manager; leave approver resolution (P4) finds an archived approver; the org chart shows a former employee as manager; position `hr_position_relationships` diverge further from employee reporting.
**Fix:** archive preview must require a reassignment target (or explicit "HR will reassign" acknowledgement that sets subordinates' manager to the archived person's manager) and perform it in the same transaction through the existing projection (`hr_employees` → `users`). Permanent delete already blocks on direct reports — keep.

### D2 — Archive does not close dependent HR state (P0 before payroll go-live)

`identity_archive_execute` touches only `hr_employees.status/end_date` (grep: no reference to `hr_position_assignments`, `hr_employee_compensation`, allowances, commission). After archive:
- `hr_employee_compensation.status` stays `active` and `onboarding_status` stays `completed`. The payroll calculation selects `status='active'` compensation of `completed` employees and **does not check employment status or end date** → a former employee is included in the next payroll run (latent today only because the run cannot write lines, see payroll report P1).
- `hr_position_assignments` PRIMARY stays `active` → the slot looks filled; position org chart wrong.
- Pending approvals assigned to the person (leave steps, timesheets, OT, position change steps, commission approvals) stay pending.
- Recurring allowances/deductions and commission profiles stay active.

**Fix (P5b):** an `hr_employment_end_effects(employee, end_date)` step inside the archive transaction (and inside a future non-archiving offboard): end compensation/allowances/deductions at `last_working_date`, end position assignments (`effective_to`, status `ended`), deactivate commission profile from next cycle, reassign pending approvals (`hr_leave_reassign_pending` and equivalents), all logged in `identity_lifecycle_actions.details`.

### D3 — Offboarding is welded to immediate access revocation (P1)

Archive is the only way to end employment. Real separations need: notice period with access, a **last working date** (archive forces `current_date` unless `end_date` was already set), a final payroll after the last day, leave encashment/forfeiture, statutory notifications, and later archive. 

**Fix (P5b):** separate the two concerns while reusing the same functions:
1. `hr_employment_end_schedule(actor, employee, last_working_date, reason_code, request_id)` — sets `end_date`, `status` stays `active` until the date (or new status `notice`), blocks new leave beyond the date, schedules effects (D2). Key: `hr.employee.manage` (or new `hr.employee.offboard`).
2. Daily job on `end_date + 1`: apply status `resigned/terminated` and D2 effects.
3. Archive & Revoke Access remains the identity step, run when HR confirms (can be automatic at end date or after final pay). Archive must accept a supplied `last_working_date` instead of `current_date`.
Status vocabulary: `hr_employees_status_check` allows only `active, probation, suspended, resigned, terminated`. Add reason codes (`contract_end`, `retirement`, `death`, `mutual_separation`, `dismissal_misconduct`) as a separate `separation_reason` column rather than widening `status`.

### D4 — Former employees lose access to their own records (P1, compliance)

Archive bans the login. Former employees still need their final payslips and the annual **Form EA** (employer must issue by end of February for the previous year) and may need an employment letter. Options: (a) HR-mediated export/email from the Former tab (`hr.payroll.view`), or (b) a time-boxed, document-only portal. Recommend (a) for go-live — no access model change.

### D5 — Employee vs position reporting lines still unreconciled (P0, baseline C6/E1)

No change since the baseline. `users.manager_user_id` (projected from `hr_employees.manager_user_id`) drives MSS, leave, approvals and the admin chart; `hr_position_relationships` drives the position chart.
**Fix (P5a):** declare employee reporting authoritative for workflows (MSS/leave/approvals already use it); add `hr_reporting_line_reconcile_preview/execute` that, for every active PRIMARY incumbent, derives the expected manager from the parent position's active PRIMARY incumbent, reports differences, and applies only HR-approved rows (never automatic). Add a guard on position-change approval to update `hr_employees.manager_user_id` in the same transaction when the change is a reporting change. Ignore archived incumbents.

### D6 — No employment history or salary revision history (P1, baseline C7/E2)

`hr_employees` is current-state; compensation rows have `effective_date/end_date` but nothing enforces non-overlap or records who changed what. Position history exists (HR05) but employee history does not.
**Fix (P5c):** `hr_employee_versions` (effective-dated snapshot of department, position, manager, employment type, status, work state, written by a trigger on `hr_employees` changes with actor and reason) + exclusion constraint on `hr_employee_compensation (employee_id, daterange(effective_date, end_date))` + `hr_compensation_change_log`. As-of queries reuse the HR05 pattern.

### D7 — Statutory and personal master data missing (P0 for payroll; P1 for leave)

No DOB, citizenship/residency, NRIC/passport, EPF/SOCSO/income-tax numbers, marital status, children, gender, work state (see payroll report P8). Paternity/maternity eligibility and statutory rates depend on them.
**Fix (P5c):** `hr_employee_statutory_profile` (one row per employment, column-level grants like compensation, edited via `hr.employee.view_sensitive` / `hr.employee.manage`, ESS change via existing `hr_profile_change_requests` Category B), with effective dating for residency and marital status.

### D8 — Former Employee behaviour — verified and remaining items

Verified (commit `94299cf9`): Former = `account_status = ARCHIVED`; never in Onboarded/Awaiting; read-only profile; no bulk selection; never offered as manager. Remaining: archived people still counted as incumbents (D2); Former tab exposes Release/Delete actions — permanent delete of a former employee is refused by the history blockers, which is correct; ensure the UI explains this instead of offering a dead action.

### D9 — Pending migrations block the lifecycle UI

The HR People menu calls RPCs from 20261214/16/17/18, none of which is recorded as applied. Apply order in the dependency matrix (#4 → #8 → #10 → #11).

### D10 — Minor

- `LAST_ADMINISTRATOR` protection uses legacy `role_level <= 10` — fine as a protection, but should move to "last holder of `security.*` / Root" when legacy levels are retired.
- `hr_employees.employment_type` CHECK uses display strings (`'Full-time'`) — keep, but map in one place.

## 3. Historical dependencies that must survive every lifecycle action

| Data | Delete Registration | Reset | Archive | Permanent delete |
|---|---|---|---|---|
| `public.users` row / UUID | kept | kept | kept | **removed** (only if no history) |
| Employee number | kept | kept | kept | removed with row |
| Attendance, leave, payroll, commission, KPI | must not exist (blocker) | kept | kept | must not exist (blocker) |
| S&A assignments | kept | kept | revoked with end date (history kept) | cleanup allowlist |
| Audit logs (FK-less) | kept | kept | kept | retained, mapped in deletion record |
| Leave ledger (new, P4) | blocker | kept | kept | blocker |
| Statutory profile (new, P5c) | blocker | kept | kept | blocker |

New tables introduced by P4–P6 **must** be classified in `identity_deletion_category()` and the HR reset allowlist in the same migration that creates them (otherwise permanent delete would treat them as BLOCKING by default — safe, but undocumented).

## 4. Phase P5 — implementation detail

| Item | Affected files | Migration | Depends on | Acceptance | Tests | Rollback |
|---|---|---|---|---|---|---|
| **P5a** Reporting-line reconciliation | `lib/server/hr/position-workflow.ts`, `position-activation.ts`, new `api/hr/reporting-lines/*`, `HrPositionManagementView` | `hr_reporting_line_reconcile_*` functions + reconciliation log table | P1 | Preview lists all divergences; execute applies only approved rows; MSS team = position chart for reconciled rows | SQL replica; `position-workflow.test.ts`; MSS route tests | Drop functions; log retained |
| **P5b** Archive hardening + scheduled separation | `lib/identity/archive.ts`, `ArchiveIdentityDialog.tsx`, `BulkRemovalDialog.tsx`, `HrPeopleView.tsx`, new `api/hr/employees/separation` | new body for `identity_archive_plan/execute` (adds last working date, manager reassignment, `hr_employment_end_effects`), `hr_employment_end_schedule`, daily job | P1, P4 (leave reassign) | Archive with direct reports requires reassignment; compensation/assignments ended; pending approvals reassigned; final-pay flag set | Extend `identity_archive_release` replica (75 asserts) with D1/D2 cases; `HrPeopleView.archive.test.tsx` | Restore 20261218 function bodies (kept in header) |
| **P5c** History + statutory profile | `api/hr/employees/*`, `profile-edit.ts`, `HrPeopleView` profile panel, ESS profile | `hr_employee_versions`, compensation exclusion constraint, `hr_employee_statutory_profile` + column grants | P1 | Every change to employment facts produces a version row; compensation overlaps refused; statutory fields readable only with the key | SQL replica; column-grant test like `20261105100000` | Tables additive; drop trigger to stop writes |
| **P5d** Former-employee documents | `HrPeopleView` Former tab, payslip export route | none | P6 (payslips correct) | HR can export final payslips/EA for a former employee | route tests | revert |

## 5. Risks

| Risk | Mitigation |
|---|---|
| Changing `identity_archive_execute` after bulk removal ships | Bulk removal only calls the canonical function — keep the signature backward compatible (new params with defaults) |
| Reassigning managers silently changes MSS visibility | Reassignment is explicit in the preview and recorded in `identity_lifecycle_actions` |
| Backfilling `hr_employee_versions` | Seed one version per employee "as of migration" — no reconstruction of the past |
| Former employees in historical payroll runs | Runs are immutable after approval; effects apply only to future periods |
