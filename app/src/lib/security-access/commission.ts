/**
 * Staff Sales Commission permissions (Security & Access).
 *
 * Lock-step with supabase/migrations/20261102110000_hr_commission_core.sql (hr_commission_permission_keys and the
 * sa_permissions seed) and 20261102120000_hr_commission_policies.sql (standard policies). commission.test.ts keeps
 * them identical.
 *
 * No legacy role receives these (compatibility rule = nobody). They are granted through the standard policies below,
 * Root Access, or a custom policy. While HR compensation is not S&A-authoritative, the database falls back to a Super
 * Admin of the same company only.
 *
 * Isomorphic and pure.
 */

export const COMMISSION_PERMISSIONS = {
  view: 'hr.commission.view',
  manage: 'hr.commission.manage',
  approve: 'hr.commission.approve',
  reportView: 'reporting.commission.view',
  reportExport: 'reporting.commission.export',
} as const

export type CommissionPermission = (typeof COMMISSION_PERMISSIONS)[keyof typeof COMMISSION_PERMISSIONS]

export const COMMISSION_PERMISSION_KEYS: readonly CommissionPermission[] = [
  COMMISSION_PERMISSIONS.view,
  COMMISSION_PERMISSIONS.manage,
  COMMISSION_PERMISSIONS.approve,
  COMMISSION_PERMISSIONS.reportView,
  COMMISSION_PERMISSIONS.reportExport,
]

/** Standard Group Policies seeded (assigned to nobody) by 20261102120000. */
export const COMMISSION_STANDARD_POLICIES: Record<string, readonly CommissionPermission[]> = {
  'commission-administrator': [COMMISSION_PERMISSIONS.manage, COMMISSION_PERMISSIONS.view],
  'commission-approver': [COMMISSION_PERMISSIONS.approve, COMMISSION_PERMISSIONS.view],
  'commission-report-viewer': [COMMISSION_PERMISSIONS.reportExport, COMMISSION_PERMISSIONS.reportView],
}

/** The access summary returned by hr_commission_my_access(). */
export type CommissionAccess = { companyId: string | null } & Record<CommissionPermission, boolean>

export const NO_COMMISSION_ACCESS: CommissionAccess = {
  companyId: null,
  'hr.commission.view': false,
  'hr.commission.manage': false,
  'hr.commission.approve': false,
  'reporting.commission.view': false,
  'reporting.commission.export': false,
}

export function parseCommissionAccess(raw: unknown): CommissionAccess {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: CommissionAccess = { ...NO_COMMISSION_ACCESS, companyId: typeof r.company_id === 'string' ? r.company_id : null }
  for (const key of COMMISSION_PERMISSION_KEYS) out[key] = r[key] === true
  return out
}

/** Reading the commission ledger (cycles, items, sources): HR commission view or Commission Reporting. */
export const canReadLedger = (a: CommissionAccess) => a['hr.commission.view'] || a['reporting.commission.view']
