# ESS/MSS Security and Functional Gap Assessment

Companion to `ESS_MSS_COMPENSATION_VIEWER.md`. Records the security review outcomes for the continuation tasks.

## 1. Compensation API service-role elimination (done)

`GET /api/hr/mss/compensation` previously read `hr_employee_compensation` and `hr_employee_allowances` through the
service role (`createAdminClient`), so row-level security did not protect those reads. This is fixed:

- **`20261104100000_hr_mss_compensation_rls.sql`** adds two SECURITY DEFINER predicates
  (`hr_mss_salary_viewer_can_read`, `hr_mss_allowance_viewer_can_read`) and two RLS SELECT policies on
  `hr_employee_compensation` and `hr_employee_allowances`. A direct PostgREST read is now restricted to the caller's
  current, active direct reports, with the matching permission and company isolation enforced in the database.
- The route now reads salary/allowances through the **caller's own session** (`createClient`), so RLS applies. It passes
  no employee id; the database restricts the rows. Only the permitted columns are selected
  (`basic_salary`, `effective_date`, `currency` / `amount`, `currency`, `allowance_type_id`).
- The non-sensitive directory projection (name, job title, department) still uses the admin client, scoped server-side to
  `manager_user_id = caller`; it never returns email, phone, salary or payroll data.

Remaining column-level nuance: the RLS policies are row-level; the route enforces column projection. `hourly_rate`,
`salary_band_id` and `notes` on a permitted row are not selected by the route, but a direct PostgREST query by a holder
could read them (they are still "own compensation" data, not other employees'). This matches every other HR read pattern.

## 2. `hr.self_service.use` action-level granularity (assessed — no change)

Employee Self-Service is a single own-record permission. That is adequate, and no granular `hr.ess.*` permissions are
introduced, because every ESS action is scoped to the authenticated employee's **own** record (the employee id is always
the verified session, never a request parameter). Within own-record scope there is no privilege-escalation surface: an
employee can only ever reach their own profile, attendance, leave, documents, requests and published payslips.

The one theoretically separable capability — viewing one's own payslip — remains in the same permission because it is
still own-record data; splitting it would add registry churn and risk breaking the lifecycle baseline
(`employeeBaseline: true`) without a security gain. Salary/job-title/department/reporting-line/payroll-configuration
remain outside ESS edit permissions entirely (see §3).

## 3. ESS hybrid profile editing (verified — safe, partially incomplete)

- **Basic fields (Category A)** have no dedicated self-edit endpoint yet. This is a functional gap, not a security gap.
- **Sensitive fields (Category B)** exist: `POST /api/hr/self-service/profile-change-requests` creates a
  `hr_profile_change_requests` row with `status = 'pending'`; the employee is always the authenticated account and cannot
  set `status`, `reviewed_by`, `reviewed_at`, or file on another employee's behalf (verified by `hr-scope.test.ts`).
- **No auto-apply path exists**: a request stays `pending` until HR acts; there is no endpoint that applies a request to
  the official record, and the `change_payload` is not auto-applied. So the security property "sensitive changes require
  HR approval before updating official records" holds by construction, but the approval/apply workflow (and its audit
  trail of before/after values + effective date) is not yet built.
- **Salary/payroll data is not editable through ESS.** ESS writes only `hr_profile_change_requests`;
  `hr_employee_compensation` / `hr_employee_allowances` / `hr_employee_deductions` are gated by `hr.compensation.manage`
  (HR), and the Manager Compensation Viewer is read-only. No ESS route writes payroll/salary tables.

Remaining work (documented, not implemented): a Category A basic-edit endpoint with audit logging, and a Category B
HR approval endpoint that validates a field whitelist, applies the change, and records before/after values, approver,
timestamps and effective date.

## 4. Test failure triage (baseline, not regressions)

The three reported failures pre-date this work and are unrelated to ESS/MSS:

1. `emergency-access-readiness.test.ts > no migration registers it in sa_enforcement_readiness` — the emergency-access
   grant flow migration (`20261024100000_sa_emergency_access_grant_flow.sql`) now registers `security.emergency_access.grant`;
   the readiness test was not updated.
2. `emergency-access-readiness.test.ts > the latest sa_request_emergency_access is still the refusing stub` — the stub
   now raises `emergency_access_use_grant_flow` instead of `emergency_access_activation_not_implemented`.
3. `ui-contract.test.ts > shows only implemented top-level sections` — the Security & Access page gained an "Approval
   Limits" section; the UI contract snapshot is stale.

These are the user's in-progress emergency-access flow and S&A UI work, not caused by ESS/MSS. None of my 119 ESS/MSS
tests regress.

## 5. Migration ordering and safety

- `20261102100000_order_status_events.sql` → `20261102110000_hr_commission_core.sql` →
  `20261102120000_hr_commission_policies.sql` (already applied to staging — untouched) →
  `20261103100000_hr_mss_compensation_viewer.sql` → `20261104100000_hr_mss_compensation_rls.sql`.
- Both MSS migrations are `create or replace` / `on conflict` / `drop policy if exists` (repeat-safe), assign no role,
  extend no Full Access policy, and are destructive-free.
