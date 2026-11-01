import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compatGrants } from './catalog'
import { FISCAL_PERIOD_CATALOG, FISCAL_PERIOD_PERMISSION_KEYS, FISCAL_PERIOD_POLICIES, fiscalLegacyAllowed, fiscalPermissionFor } from './fiscal-period-catalog'
import { ALL_ENFORCEMENT_READY_PERMISSIONS } from './readiness'
import { ROUTE_COVERAGE } from './route-coverage'
import { classifyPermission } from './modules'
import { permissionLabel } from './labels'
import { isSensitivePermission } from './profiles'
import { coverageReport, seededProfilePermissions } from './coverage-audit'

const migration = readFileSync(new URL('../../../../supabase/migrations/20261219100000_finance_fiscal_period_permissions.sql', import.meta.url), 'utf8')

describe('Fiscal Year & Periods permissions ↔ migration lock-step', () => {
  it.each(FISCAL_PERIOD_CATALOG)('$key is seeded (SHADOW, Super Admin compatibility) and registered as ready', ({ key, compat }) => {
    const [, resource, action] = key.split('.')
    expect(migration).toContain(`('${key}','finance','${resource}','${action}'`)
    expect(migration).toContain(`('${key}', ${compat.maxRoleLevel}, '{}', '{}', false,`)
    expect(migration).toContain(`('${key}', true, 'rpc_guard'`)
    expect(ALL_ENFORCEMENT_READY_PERMISSIONS).toContain(key)
  })

  it('starts in SHADOW and never enforces a mode', () => {
    expect(migration).toContain("select k, 'SHADOW', null")
    expect(migration).not.toMatch(/update\s+public\.sa_migration_modes\s+set\s+mode/i)
    expect(migration).not.toMatch(/^\s*[^-\s].*'(NEW_ENFORCED|LEGACY_RETIRED)'/m)
  })

  it('compatibility: only the central Super Admin (level 1); HQ Admin (10/20) does not get it', () => {
    for (const entry of FISCAL_PERIOD_CATALOG) {
      const role = (level: number) => ({ roleCode: `L${level}`, roleLevel: level, permissions: ['edit_org_settings', 'view_settings'] })
      expect(compatGrants(entry, role(1)), entry.key).toBe(true)
      for (const level of [10, 20, 30]) expect(compatGrants(entry, role(level)), `${entry.key} level ${level}`).toBe(false)
    }
    expect(fiscalLegacyAllowed(1)).toBe(true)
    expect(fiscalLegacyAllowed(10)).toBe(false)
  })

  it('one narrow Group Policy per permission, assigned to nobody; Finance Full Access not extended', () => {
    const seeded = seededProfilePermissions()
    for (const [role, key] of Object.entries(FISCAL_PERIOD_POLICIES)) {
      expect(migration).toContain(`'${role}'`)
      expect([...(seeded.get(role) ?? [])].sort()).toEqual(['finance.ledger.view', 'finance.module.view', key].sort())
    }
    expect(migration).not.toMatch(/sa_assign_role|sa_create_assignment_internal|insert\s+into\s+public\.sa_role_assignments/i)
    expect(migration).not.toMatch(/perform\s+public\.sa_extend_standard_policy/i)
    for (const key of FISCAL_PERIOD_PERMISSION_KEYS) expect(seeded.get('finance-full-access')?.has(key) ?? false).toBe(false)
    const report = coverageReport()
    for (const key of FISCAL_PERIOD_PERMISSION_KEYS) {
      expect(report.universe).toContain(key)
      expect(report.withoutProfile).not.toContain(key)
    }
  })

  it('transitions map to exactly one permission, matching the database functions', () => {
    expect(fiscalPermissionFor('period', 'future', 'open')).toBe('finance.period.open')
    expect(fiscalPermissionFor('period', 'open', 'closed')).toBe('finance.period.close')
    expect(fiscalPermissionFor('period', 'closed', 'open')).toBe('finance.period.reopen')
    expect(fiscalPermissionFor('period', 'closed', 'locked')).toBe('finance.fiscal_year.lock')
    expect(fiscalPermissionFor('year', 'open', 'closed')).toBe('finance.period.close')
    expect(fiscalPermissionFor('year', 'closed', 'open')).toBe('finance.period.reopen')
    expect(fiscalPermissionFor('year', 'closed', 'locked')).toBe('finance.fiscal_year.lock')
    for (const [from, to] of [['future', 'closed'], ['open', 'locked'], ['locked', 'open'], ['locked', 'closed'], ['open', 'future']]) {
      expect(fiscalPermissionFor('period', from, to), `${from}->${to}`).toBeNull()
    }
    expect(fiscalPermissionFor('year', 'future', 'open')).toBeNull()
    for (const [from, to, key] of [['future', 'open', 'finance.period.open'], ['open', 'closed', 'finance.period.close'],
      ['closed', 'open', 'finance.period.reopen'], ['closed', 'locked', 'finance.fiscal_year.lock']]) {
      expect(migration).toMatch(new RegExp(`status = '${from}'\\s+and p_status = '${to}'\\s+then '${key.replace(/\./g, '\\.')}'`))
    }
  })

  it('routes decide through the new keys', () => {
    expect((ROUTE_COVERAGE as any)['accounting/fiscal-years'].permissions).toContain('finance.fiscal_year.create')
    for (const route of ['accounting/fiscal-years/[id]', 'accounting/fiscal-years/[id]/periods/[periodId]']) {
      for (const key of ['finance.period.close', 'finance.period.reopen', 'finance.fiscal_year.lock']) {
        expect((ROUTE_COVERAGE as any)[route].permissions, route).toContain(key)
      }
    }
    expect((ROUTE_COVERAGE as any)['accounting/fiscal-years/[id]/periods/[periodId]'].permissions).toContain('finance.period.open')
  })

  it('is listed under Finance → Fiscal Year & Periods with readable labels, not grant-sensitive', () => {
    for (const key of FISCAL_PERIOD_PERMISSION_KEYS) {
      expect(classifyPermission(key)).toMatchObject({ groupId: 'finance', areaId: 'fiscal_periods' })
      expect(isSensitivePermission(key)).toBe(false)
    }
    expect(permissionLabel('finance.fiscal_year.create').label).toBe('Create Fiscal Year')
    expect(permissionLabel('finance.period.open').label).toBe('Open Accounting Period')
    expect(permissionLabel('finance.period.reopen').label).toBe('Reopen Closed Period / Fiscal Year')
    expect(permissionLabel('finance.fiscal_year.lock').label).toBe('Lock Fiscal Year Permanently')
  })
})
