/**
 * Manager Compensation Viewer permissions (Security & Access).
 *
 * Lock-step with supabase/migrations/20261103100000_hr_mss_compensation_viewer.sql (the sa_permissions seed and the
 * manager-compensation-viewer standard policy). compensation-viewer.test.ts keeps them identical.
 *
 * A SEPARATE, restricted, read-only policy from ESS and MSS. Only HR or Security administrators grant or revoke it.
 * Data scope is the manager's current, active direct reports, and only basic salary + authorized fixed allowances are
 * visible. Payslips, net salary, banking, EPF/SOCSO/PCB, deductions, payroll runs, salary history and export remain out
 * of scope (and require separate explicit permissions if ever introduced).
 *
 * No legacy role receives these (compatibility rule = nobody). Being an HR employee alone must not imply this access.
 *
 * Isomorphic and pure.
 */

export const COMPENSATION_VIEWER_PERMISSIONS = {
  salaryView: 'hr.compensation.salary_view',
  allowanceView: 'hr.compensation.allowance_view',
} as const

export type CompensationViewerPermission = (typeof COMPENSATION_VIEWER_PERMISSIONS)[keyof typeof COMPENSATION_VIEWER_PERMISSIONS]

export const COMPENSATION_VIEWER_PERMISSION_KEYS: readonly CompensationViewerPermission[] = [
  COMPENSATION_VIEWER_PERMISSIONS.salaryView,
  COMPENSATION_VIEWER_PERMISSIONS.allowanceView,
]

/** Standard Group Policy seeded (assigned to nobody) by 20261103100000. */
export const COMPENSATION_VIEWER_STANDARD_POLICY: Record<string, readonly CompensationViewerPermission[]> = {
  'manager-compensation-viewer': [
    COMPENSATION_VIEWER_PERMISSIONS.salaryView,
    COMPENSATION_VIEWER_PERMISSIONS.allowanceView,
  ],
}

export const COMPENSATION_VIEWER_ROLE_KEY = 'manager-compensation-viewer'
