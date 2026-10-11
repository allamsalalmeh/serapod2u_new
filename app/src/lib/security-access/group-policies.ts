import { MODULE_TAXONOMY, classifyPermission, moduleGroupName } from './modules'
import { COMMISSION_PERMISSION_KEYS } from './commission'
import { MSS_PERMISSION_KEYS } from './mss'
import { COMPENSATION_VIEWER_PERMISSION_KEYS } from './compensation-viewer'

/**
 * Group Policies (the user-facing name of a business role / "Access Profile").
 *
 * Standard module-wide "Full Access" policies are seeded by
 * supabase/migrations/20261009100000_sa_group_policies_full_access.sql as explicit permission lists. This file is
 * the client-safe catalogue the UI shares: which standard policy belongs to which module, how they are ordered
 * (module Full Access first, then narrower policies) and what each one's assignment caveats are. It decides
 * nothing: authorization is always the database's.
 */

export const GROUP_POLICY_LABEL = { singular: 'Group Policy', plural: 'Group Policies' } as const

export interface FullAccessPolicy {
  roleKey: string
  /** Module group id of the shared taxonomy (modules.ts). */
  moduleId: string
  name: string
}

/** One per top-level business module, in taxonomy order. Reporting is a single shared analytics permission, not a module. */
export const FULL_ACCESS_POLICIES: readonly FullAccessPolicy[] = [
  { roleKey: 'supply-chain-full-access', moduleId: 'supply_chain', name: 'Supply Chain Full Access' },
  { roleKey: 'customer-growth-full-access', moduleId: 'customer_growth', name: 'Customer & Growth Full Access' },
  { roleKey: 'hr-payroll-full-access', moduleId: 'hr_payroll', name: 'HR & Payroll Full Access' },
  { roleKey: 'finance-full-access', moduleId: 'finance', name: 'Finance Full Access' },
  { roleKey: 'security-access-full-access', moduleId: 'security_access', name: 'Security & Access Full Access' },
  { roleKey: 'platform-settings-full-access', moduleId: 'platform_settings', name: 'Platform & Settings Full Access' },
]

const BY_KEY = new Map(FULL_ACCESS_POLICIES.map(p => [p.roleKey, p]))
export const fullAccessPolicy = (roleKey?: string | null) => (roleKey ? BY_KEY.get(roleKey) ?? null : null)
export const isFullAccessPolicy = (roleKey?: string | null) => Boolean(fullAccessPolicy(roleKey))

/** Module (taxonomy) group ids whose permissions a Full Access policy for that module must contain. */
export const fullAccessModuleIds = FULL_ACCESS_POLICIES.map(p => p.moduleId)

/** Every registered permission that genuinely belongs to a module (by the shared taxonomy). */
/**
 * Registered permissions that are deliberately in NO module Full Access policy (reviewed; the drift report lists them):
 *   platform.system_logs.view — reading other users' diagnostics is granted only through the narrow System Log Viewer
 *   policy (20261017110000), never implied by platform administration.
 *   hr.commission.* — Staff Sales Commission (20261102110000/20261102120000): HR & Payroll Full Access is NOT extended,
 *   so commission is granted through its own policies only.
 *   hr.mss.* and hr.compensation.salary/allowance.view — Manager Self-Service and the Manager Compensation Viewer are
 *   separate, explicitly granted policies (20261103100000); being an HR administrator alone must not imply manager or
 *   compensation access (least privilege).
 */
export const OUTSIDE_FULL_ACCESS: readonly string[] = ['platform.system_logs.view', ...COMMISSION_PERMISSION_KEYS, ...MSS_PERMISSION_KEYS, ...COMPENSATION_VIEWER_PERMISSION_KEYS]

export const permissionsOfModule = (moduleId: string, keys: readonly string[]) =>
  keys.filter(k => classifyPermission(k).groupId === moduleId).slice().sort()

/**
 * Selection order: module Full Access policies first (taxonomy order), then every other policy by name.
 * Used by Group Policies, the Add User picker and the grant form so the module policy is always the first,
 * most prominent choice.
 */
export function sortGroupPolicies<T>(items: readonly T[], roleKeyOf: (item: T) => string | null | undefined, nameOf: (item: T) => string): T[] {
  const rank = (item: T) => {
    const policy = fullAccessPolicy(roleKeyOf(item))
    return policy ? MODULE_TAXONOMY.findIndex(g => g.id === policy.moduleId) : 1000
  }
  return items.slice().sort((a, b) => rank(a) - rank(b) || nameOf(a).localeCompare(nameOf(b)))
}

/** Short label shown beside a Full Access policy ("Full Access · Supply Chain"). */
export const fullAccessBadge = (roleKey?: string | null) => {
  const policy = fullAccessPolicy(roleKey)
  return policy ? `Full Access · ${moduleGroupName(policy.moduleId)}` : null
}

/**
 * Why a policy may be missing while creating a user. Mirrors the database rule (sa_actor_may_assign_profile, the same
 * authority Grant Policy enforces): policies holding security administration or reset/destructive permissions are
 * offered only to an administrator who holds those permissions in the organization.
 */
export const POST_CREATION_ASSIGNMENT_NOTE =
  'Some Full Access policies hold security administration or reset permissions. They are offered here only when you hold those permissions in this organization (the same rule as Grant Policy); otherwise create the person first and ask an administrator who holds them to assign the policy in Security & Access → People & Access.'

/** Standard policy coverage drift as reported by sa_standard_policy_drift(). */
export interface PolicyDrift { roleKey: string; recordedCount: number; liveCount: number; catalogueNotCovered: string[]; liveNotRecorded: string[]; recordedNotLive: string[] }
