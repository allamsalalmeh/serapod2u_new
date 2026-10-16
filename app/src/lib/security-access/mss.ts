/**
 * Manager Self-Service (MSS) permissions (Security & Access).
 *
 * Lock-step with supabase/migrations/20261103100000_hr_mss_compensation_viewer.sql (the sa_permissions seed and the
 * manager-self-service standard policy). mss.test.ts keeps them identical.
 *
 * MSS is NOT derived from a job title (Manager / Head / Supervisor): it is an explicitly granted policy. Each permission
 * is decided on the manager's organization by the canonical S&A evaluation (organization scope); the DATA scope — the
 * manager's current, active direct reports — is enforced independently in the query (hr_employees.manager_user_id).
 * Approving leave additionally requires a valid workflow assignment (the leave approval flow checks that itself).
 *
 * No legacy role receives these (compatibility rule = nobody). They are granted through the manager-self-service
 * standard policy, Root Access, or a custom policy. MSS never implies compensation access.
 *
 * Isomorphic and pure.
 */

export const MSS_PERMISSIONS = {
  teamView: 'hr.mss.team_view',
  attendanceView: 'hr.mss.attendance_view',
  leaveView: 'hr.mss.leave_view',
  leaveApprove: 'hr.mss.leave_approve',
  performanceView: 'hr.mss.performance_view',
  requestsView: 'hr.mss.requests_view',
} as const

export type MssPermission = (typeof MSS_PERMISSIONS)[keyof typeof MSS_PERMISSIONS]

export const MSS_PERMISSION_KEYS: readonly MssPermission[] = [
  MSS_PERMISSIONS.teamView,
  MSS_PERMISSIONS.attendanceView,
  MSS_PERMISSIONS.leaveView,
  MSS_PERMISSIONS.leaveApprove,
  MSS_PERMISSIONS.performanceView,
  MSS_PERMISSIONS.requestsView,
]

/** Standard Group Policy seeded (assigned to nobody) by 20261103100000. */
export const MSS_STANDARD_POLICY: Record<string, readonly MssPermission[]> = {
  'manager-self-service': [
    MSS_PERMISSIONS.teamView,
    MSS_PERMISSIONS.attendanceView,
    MSS_PERMISSIONS.leaveView,
    MSS_PERMISSIONS.leaveApprove,
    MSS_PERMISSIONS.performanceView,
    MSS_PERMISSIONS.requestsView,
  ],
}

export const MSS_ROLE_KEY = 'manager-self-service'
