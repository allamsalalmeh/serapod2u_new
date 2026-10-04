# HR onboarding state and HR Data Management (pre-go-live reset)

Migration: `supabase/migrations/20261003100000_hr_onboarding_state_and_data_reset.sql` (apply manually).
Read-only check: `supabase/diagnostics/hr_onboarding_reset_readiness_readonly.sql`.
Replica tests: `supabase/tests/security/hr_onboarding_reset/` (isolated databases only).

## 1. Why an explicit onboarding state

Every internal identity gets an `hr_employees` row automatically (`fn_auto_create_hr_employee`,
`identity_users_forward_employment`, the Stage 2 backfill). That row is the **employment anchor**:
it holds the employee number and projects department, position, manager, employment type and
status onto `public.users`, which Supply Chain approvals, S&A department scope and the org chart
read. The row existing therefore cannot mean "HR registered this person", and deleting it does not
help (triggers recreate it and the projections break).

`hr_employees.onboarding_status` is the HR registration state:

| State | Meaning | HR lists / pickers | ESS |
|---|---|---|---|
| `pending` | automatic anchor; HR has not registered the person | "Awaiting onboarding" tab only | pending-setup screen |
| `completed` | HR completed onboarding (or legacy record, see §3) | listed, selectable | normal |
| `reset` | registration reset by HR Data Management | "Awaiting onboarding" tab only | pending-setup screen |

Ownership: only `hr_onboarding_complete`, `hr_reset_execute` and `hr_reset_restore` change it.
The `hr_employees_onboarding_guard` trigger forces new rows to `pending` and refuses any other
change of the onboarding columns (including by API roles). Profile edits, the users→HR
forwarding, the auto-create trigger and logins never onboard or re-onboard anyone.

Not part of onboarding: employment status, employee number, account status, credentials,
memberships, legacy role code, S&A roles, the users projection. A reset is never a resignation,
termination, suspension or access revocation.

`hire_date_confirmed` marks a hire date HR entered during onboarding. Anchors default
`hire_date` from the login/creation date; that date is never shown as a confirmed hire date
(the HR list API and candidate preview return it only when confirmed).

## 2. Add Employee (one central identity)

1. **Find**: name search lists internal staff of the HR administrator's organization (selection
   aid only, `hr_onboarding_search`), or email/phone lookup through `identity_resolve`
   (normalization and conflict rules unchanged; conflicts are recorded in `identity_conflicts`).
2. **Preview**: `hr_onboarding_candidate` — masked email/phone, login present, onboarding state,
   employee number, current HR facts of the same organization; another organization's name is
   never disclosed.
3. **Onboard**:
   - existing internal identity of the organization → `hr_onboarding_complete`: same user id,
     login, credentials, identifiers, role code and memberships; the existing employment record
     and employee number are reused; HR facts (department, position, manager, employment type,
     actual hire date — required) are written to the employment record and projected as before;
   - genuinely new person → canonical `provisionIdentity` (login with temporary password,
     membership, employee self-service baseline; legacy code `GUEST`, no business access), then
     `hr_onboarding_complete`;
   - distributor/shop/manufacturer/consumer accounts, other organizations, archived/suspended
     accounts, ended employment and conflicting identifiers are **blocked** with the existing
     conversion/move/reactivation process named; nothing is converted or moved silently;
   - repeat submission returns `ALREADY_ONBOARDED` and changes nothing; self-onboarding is refused.
4. Access stays in Security & Access; onboarding never grants business access.

The legacy `POST /api/hr/employees/profile` ("link existing users") now goes through the same
function and requires a hire date.

## 3. Legacy backfill rule (reviewed; no mass reset)

When the migration runs, every existing `hr_employees` row becomes
`onboarding_status = 'completed'`, `onboarding_source = 'legacy_backfill'`,
`hire_date_confirmed = false`. HR lists look exactly as before the migration. Rows created
afterwards start `pending`. To make HR register everyone properly before go-live, use
**Reset Employee Onboarding** deliberately; it is never a side effect of the migration.
Operational guards (§5) do not affect legacy records.

## 4. HR Data Management (HR Settings → Configuration → bottom)

Eligibility, enforced in the database for every call:

- Super Admin (legacy role level 1) **and** an explicit S&A assignment of **HR Data Reset
  Administrator** (`hr.data.reset`) whose scope covers the organization — no compatibility rule,
  no delegation, no backfill, in every migration mode;
- organization's HR is `pre_go_live` (`hr_go_live_state`; seeded for organizations with
  employment records; `hr_mark_go_live` is one-way).

Both actions show organization, counts by category, preserved categories, kept data with counts,
tables not present, blockers and trigger warnings; require a reason (≥ 10 characters) and the
typed phrase (`RESET ONBOARDING <ORG CODE>` / `RESET ALL HR DATA <ORG CODE>`); and run in one
transaction: advisory lock per organization + table locks, re-plan, confirmation and preview-token
check (stale previews refused), blocker check (blocked attempts recorded, nothing changed),
snapshot of every affected row (count-verified; failure aborts everything), ordered org-scoped
row deletes (count-verified), onboarding state change, per-employee log and permanent run record.
The browser sends one `request_id` per reviewed preview; a repeat returns the recorded outcome.

### Reset Employee Onboarding

Changes `completed` → `reset` for the organization's employment records. Nothing is deleted.

### Reset All HR Data — exact delete allowlist (rows of the selected organization only)

| Category | Tables (delete order) |
|---|---|
| Attendance | `hr_attendance_corrections`, `hr_overtime_calculations`, `hr_overtime_requests`, `hr_timesheet_entries`, `hr_timesheets`, `hr_attendance_entries`, `hr_attendance_audit` |
| Leave | `hr_leave_approvals`, `hr_leave_requests`, `hr_leave_balances` |
| Payroll | `hr_payslip_access_logs`, `hr_payroll_audit`, `hr_payroll_run_items`, `hr_payroll_runs` |
| Compensation | `hr_employee_compensation` |
| Allowances & deductions | `hr_employee_allowances`, `hr_employee_deductions` |
| Performance | `hr_kpi_evidence`, `hr_kpi_adjustments`, `hr_kpi_reviews`, `hr_kpi_scorecard_items`, `hr_kpi_scorecards`, `hr_kpi_actuals`, `hr_kpi_targets`, `hr_kpi_assignments`, `hr_performance_reviews` |

plus the onboarding reset above. A table that does not exist is reported "not present".

### Blockers (any one → nothing changes)

- any row outside the delete set that references a row in it (discovered from `pg_constraint`
  at preview and execution — e.g. Finance `payroll_journals` / `payroll_payment_batches`, or another
  organization's row);
- payroll runs with a GL journal, reversal journal, GL posting time or posted/reversed GL status;
- `hr_gl_postings` / `gl_document_postings` for any in-scope record;
- an allowlisted table without `organization_id`/`id`, a multi-column reference, or a delete order
  that contradicts a foreign key.

### Preserved (never touched by either action)

`auth.users`; `public.users` (identity, credentials, email/phone, role code, account status,
employment projections); organization membership and S&A assignments; employment records and
employee numbers; `hr_employee_profiles`; HR configuration — `departments`, `hr_positions`,
`hr_public_holidays`, `hr_attendance_policies` (workweek), `hr_shifts`, `hr_overtime_policies`,
`hr_leave_types`, `hr_approval_chains`, `hr_delegation_rules`, `hr_salary_bands`,
`hr_allowance_types`, `hr_deduction_types`, `hr_settings`, `hr_gl_mappings`, KPI library,
periods and objectives, appraisal cycles, review templates; HR areas outside this reset —
contracts, expense claims, benefits, recruitment, learning, policy acknowledgements, onboarding
checklists, document/profile requests, KPI snapshots and audit log; all Supply Chain, RoadTour,
QR and Finance data. No `TRUNCATE`, no `CASCADE`.

### Snapshot, audit and restore

`hr_reset_snapshots` (RLS forced, no policies, no grants to API roles or `service_role`),
`hr_reset_runs`, `hr_reset_restorations` and `hr_employee_onboarding_log` are append-only.
`hr_reset_restore(actor, run_id, reason)` (same authorization; once per run) re-inserts the
captured rows parent-first and restores onboarding states still marked reset by that run.
Restore is an operator function (SQL), not a UI action. Table triggers on the restored tables fire.

## 5. Operational guard and ESS

New rows in `hr_attendance_entries`, `hr_timesheets`, `hr_leave_requests`,
`hr_employee_compensation`, `hr_employee_allowances`, `hr_employee_deductions` and
`hr_payroll_run_items` require a `completed` employment record of that employee in the row's
organization (`hr_onboarding_pending` otherwise). Payroll calculation includes onboarded employees
only; the HR employee picker lists onboarded employees only. ESS (`/hr/mobile`) shows "Your HR
profile is being set up" for `pending`/`reset`; clock-in returns 409 `HR_ONBOARDING_PENDING`.
Login and other modules are unaffected. The org chart is the shared organization structure and is
unchanged.

## 6. Operating it

1. Run the read-only diagnostic on the target database; review counts and Finance signals.
2. Apply the migration (idempotent; postconditions raise on failure). Run the diagnostic again.
3. In Security & Access, assign **HR Data Reset Administrator** (organization scope) to the Super
   Admin who will run resets. Remove it afterwards.
4. Use HR Settings → Configuration → Data Management. When HR goes live:
   `select public.hr_mark_go_live('<super admin id>', '<organization id>', 'HR go-live');`
