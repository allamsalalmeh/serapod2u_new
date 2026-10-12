# Employee Self-Service, Manager Self-Service and the Manager Compensation Viewer

This page records how the three Security & Access policies map to the permission registry, and the migration that
introduces MSS and the restricted Manager Compensation Viewer. ESS already existed (`employee-self-service`, HQ-only,
own-record scope, `hr.self_service.use`) and is unchanged here.

## Permission matrix (logical → registry)

| Logical permission | Actual registry permission | Scope | Notes |
|---|---|---|---|
| `hr.ess.profile.view` | `hr.self_service.use` | Own record | Existing ESS permission; the employee is always the authenticated account. |
| `hr.ess.profile.edit_basic` | `hr.self_service.use` | Own record | Basic contact/address/emergency fields only; validated and audited. |
| `hr.ess.profile.request_sensitive_change` | `hr.self_service.use` | Own record | `hr_profile_change_requests`; HR review before master data changes. |
| `hr.ess.attendance.view` | `hr.self_service.use` | Own record | Own attendance via the existing Attendance module. |
| `hr.ess.attendance.clock` | `hr.self_service.use` | Own record | Clock in/out where attendance configuration permits. |
| `hr.ess.attendance.request_correction` | `hr.self_service.use` | Own record | Subject to workflow availability. |
| `hr.ess.leave.view` | `hr.self_service.use` | Own record | Own balances and history. |
| `hr.ess.leave.request` | `hr.self_service.use` | Own record | Existing leave request flow. |
| `hr.ess.payslip.view` / `.download` | `hr.self_service.use` | Own record | Own published (approved/posted) payslips only. |
| `hr.ess.documents.view` | `hr.self_service.use` | Own record | Own employment documents. |
| `hr.ess.requests.view` | `hr.self_service.use` | Own record | Own HR requests and approvals. |
| `hr.mss.team.view` | `hr.mss.team.view` | Direct reports | New. `GET /api/hr/mss/team`. |
| `hr.mss.attendance.view` | `hr.mss.attendance.view` | Direct reports | New. |
| `hr.mss.leave.view` | `hr.mss.leave.view` | Direct reports | New. |
| `hr.mss.leave.approve` | `hr.mss.leave.approve` | Direct reports + workflow | New. Approval additionally needs a valid workflow assignment. |
| `hr.mss.performance.view` | `hr.mss.performance.view` | Direct reports | New. |
| `hr.mss.requests.view` | `hr.mss.requests.view` | Direct reports | New. |
| `hr.compensation.salary.view` | `hr.compensation.salary.view` | Restricted direct reports | New, read-only. |
| `hr.compensation.allowance.view` | `hr.compensation.allowance.view` | Restricted direct reports | New, read-only. |

ESS is a single own-record permission rather than many granular keys because that is the existing registry design
(`hr.self_service.use`, `employeeBaseline: true`); the granular rows above describe what that one permission permits on
the employee's own record, not new keys. MSS and the Compensation Viewer are genuinely new scope (direct reports) and

## The three standard policies

| Policy | `role_key` | Grant | Eligibility | Scope |
|---|---|---|---|---|
| Employee Self-Service | `employee-self-service` | Automatic (lifecycle baseline, HQ only) | Internal Employee with a valid, active employment record | Own record |
| Manager Self-Service | `manager-self-service` | Explicit | Internal, HQ | Authorized direct reports |
| Manager Compensation Viewer | `manager-compensation-viewer` | Explicit (HR/Security only) | Internal, HQ | Authorized direct reports, read-only |

MSS is **never** derived from a job title (Manager / Head / Supervisor). The Compensation Viewer is a separate policy
from ESS and MSS and does not inherit anything; being an HR employee alone grants neither manager nor compensation
access.

## Migration

`supabase/migrations/20261103100000_hr_mss_compensation_viewer.sql`

1. **Seeds 8 permissions** (`sa_permissions`), all `security_sensitive`, with `sa_legacy_compat_rules` = nobody.
2. **Migration modes**: `NEW_ENFORCED` when the corresponding administrative permission is already S&A-authoritative
   (`hr.employee.view` for MSS, `hr.compensation.view` for the viewer), otherwise `SHADOW` (Super Admin of the company
   only) — the same rule as Commission.
3. **Enforcement readiness**: `rls_gate` for `*.view`, `rpc_guard` for `hr.mss.leave.approve`.
4. **Authorization helpers** (SECURITY DEFINER, not API-callable): `hr_mss_allowed/require`,
   `hr_compensation_viewer_allowed/require`, `hr_manager_is_direct_report`.
5. **Standard policies** `manager-self-service` and `manager-compensation-viewer`, seeded and assigned to **no one**.

No `sa_role_assignments` rows are created. No `hr-payroll-full-access` extension. Nothing destructive. Repeat-safe.

### Validation SQL (after applying to a disposable/staging schema)

```sql
select permission_key, audit_sensitivity from public.sa_permissions
where permission_key like 'hr.mss.%' or permission_key in ('hr.compensation.salary.view','hr.compensation.allowance.view');

select role_key, source, status, applicable_account_types, applicable_org_types from public.sa_business_roles
where role_key in ('manager-self-service','manager-compensation-viewer');
select count(*) as assignments from public.sa_role_assignments a join public.sa_business_roles b on b.id = a.role_id
where b.role_key in ('manager-self-service','manager-compensation-viewer');

select role_key, permission_keys from public.sa_standard_policy_coverage
where role_key in ('manager-self-service','manager-compensation-viewer');
```

### Rollback (only while unassigned)

```sql
delete from public.sa_standard_policy_coverage where role_key in ('manager-self-service','manager-compensation-viewer');
delete from public.sa_business_role_permissions where role_id in (select id from public.sa_business_roles where role_key in ('manager-self-service','manager-compensation-viewer'));
delete from public.sa_business_roles where role_key in ('manager-self-service','manager-compensation-viewer');
delete from public.sa_enforcement_readiness where permission_key like 'hr.mss.%' or permission_key in ('hr.compensation.salary.view','hr.compensation.allowance.view');
delete from public.sa_migration_modes where permission_key like 'hr.mss.%' or permission_key in ('hr.compensation.salary.view','hr.compensation.allowance.view');
delete from public.sa_legacy_compat_rules where permission_key like 'hr.mss.%' or permission_key in ('hr.compensation.salary.view','hr.compensation.allowance.view');
delete from public.sa_permissions where permission_key like 'hr.mss.%' or permission_key in ('hr.compensation.salary.view','hr.compensation.allowance.view');
```

## Data scope (independent of the action permission)

A manager holding a permission can only reach their **current, active direct reports**: `hr_employees.manager_user_id =
manager` with `status in ('active','probation')`, account active and onboarding complete. A reporting-line change or an
organization transfer removes the relationship immediately. The Compensation Viewer additionally returns only
`basic_salary` and authorized fixed (recurring) allowances; payslips, net salary, banking, EPF/SOCSO/PCB, deductions,
payroll runs, salary history and export are never returned and require separate explicit permissions if ever introduced.

are therefore new keys, mirroring the Staff Commission permissions.
