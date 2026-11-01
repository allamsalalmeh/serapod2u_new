import type { CatalogEntry } from './catalog'

/**
 * Finance → Fiscal Year & Periods. Five separate permissions so each action can be given to a named person.
 * Seeded in SHADOW (legacy = central Super Admin only) and registered as enforcement-ready by
 * supabase/migrations/20261219100000_finance_fiscal_period_permissions.sql (fiscal-period-catalog.test.ts keeps both in step).
 *
 * Every transition is decided in one place, fiscalPermissionFor(), mirrored by fiscal_period_set_status /
 * fiscal_year_set_status in the database. One standard Group Policy per permission, assigned to no one; Finance Full
 * Access is deliberately NOT extended.
 */
export const FISCAL_PERIOD_CATALOG: readonly CatalogEntry[] = [
  { key: 'finance.fiscal_year.create', description: 'Create a fiscal year and its accounting periods (created as Future)',
    sensitivity: 'security_sensitive', compat: { maxRoleLevel: 1 } },
  { key: 'finance.period.open', description: 'Open a new accounting period (Future to Open) so it accepts postings',
    sensitivity: 'security_sensitive', compat: { maxRoleLevel: 1 } },
  { key: 'finance.period.close', description: 'Close an accounting period or a fiscal year (Open to Closed)',
    sensitivity: 'security_sensitive', compat: { maxRoleLevel: 1 } },
  { key: 'finance.period.reopen', description: 'Reopen a closed accounting period or fiscal year (Closed to Open) to post corrections',
    sensitivity: 'security_sensitive', compat: { maxRoleLevel: 1 } },
  { key: 'finance.fiscal_year.lock', description: 'Lock a closed period or fiscal year permanently (Closed to Locked); it can never be changed again',
    sensitivity: 'security_sensitive', compat: { maxRoleLevel: 1 } },
] as const

export const FISCAL_PERIOD_PERMISSION_KEYS: readonly string[] = FISCAL_PERIOD_CATALOG.map(entry => entry.key)

/** Routes decide through these keys; fiscal_* functions re-check the actor (rpc_guard). */
export const FISCAL_PERIOD_ENFORCEMENT_READY: readonly string[] = FISCAL_PERIOD_PERMISSION_KEYS

/** role_key → the fiscal permission it carries (each policy also holds finance.module.view and finance.ledger.view). */
export const FISCAL_PERIOD_POLICIES: Readonly<Record<string, string>> = {
  'fiscal-year-creator': 'finance.fiscal_year.create',
  'accounting-period-opener': 'finance.period.open',
  'accounting-period-closer': 'finance.period.close',
  'accounting-period-reopener': 'finance.period.reopen',
  'fiscal-year-locker': 'finance.fiscal_year.lock',
}

export type FiscalStatus = 'future' | 'open' | 'closed' | 'locked'

/**
 * The permission a status change needs, or null when the change is not allowed at all.
 * Periods: future→open, open→closed, closed→open, closed→locked. Years: open→closed, closed→open, closed→locked.
 */
export function fiscalPermissionFor(kind: 'period' | 'year', from: string, to: string): string | null {
  if (from === 'future' && to === 'open') return kind === 'period' ? 'finance.period.open' : null
  if (from === 'open' && to === 'closed') return 'finance.period.close'
  if (from === 'closed' && to === 'open') return 'finance.period.reopen'
  if (from === 'closed' && to === 'locked') return 'finance.fiscal_year.lock'
  return null
}

/** Legacy rule while the keys are not enforced: active central Super Admin (role level 1). */
export const fiscalLegacyAllowed = (roleLevel: number | null | undefined) => roleLevel === 1
