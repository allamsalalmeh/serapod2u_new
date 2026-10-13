import { describe, expect, it } from 'vitest'
import { type CoverageRole, coveredPermissions, coveringAssignments, fullyCoveredModules, grantableModulePermissions, isCurrentAssignment, isRedundantPolicy, scopeCoversOrganization } from './grant-coverage'

const HQ = 'org-hq', WH = 'wh-alma', DIST = 'org-dist'
const NOW = new Date('2026-10-08T00:00:00Z')
const role = (id: string, keys: string[], extra: Partial<CoverageRole> = {}): CoverageRole => ({ id, status: 'active', source: 'template', permissionKeys: keys, ...extra })
const FIN = ['finance.module.view', 'finance.ledger.view', 'finance.payment.approve', 'finance.cash.prepare']
const ROLES = new Map<string, CoverageRole>([
  ['fin-fa', role('fin-fa', FIN)],
  ['bank', role('bank', ['finance.cash.prepare'])],
  ['sa-fa', role('sa-fa', ['security.access.manage', 'security.role.manage'])],
  ['hr-fa', role('hr-fa', ['hr.payroll.approve', 'hr.employee.view'])],
  ['retired-fa', role('retired-fa', FIN, { status: 'retired' })],
  ['legacy', role('legacy', FIN, { source: 'legacy' })],
  // Named like Full Access, but holds one permission.
  ['fake-fa', role('fake-fa', ['finance.ledger.view'])],
])
const orgScope = (value: string, type = 'organization') => ({ scope: { id: `s-${value}`, scope_type: type, scope_value: value, display_name: value } })
const grant = (roleId: string, extra: any = {}) => ({ id: `a-${roleId}`, status: 'active', source: 'manual', effective_from: null, effective_until: null, role: { id: roleId }, scopes: [orgScope(HQ)], ...extra })
const covered = (assignments: any[], organizationId = HQ, parents?: Map<string, string | null>) => coveredPermissions({ assignments, organizationId, roles: ROLES, parents, now: NOW })
const REQUIRED = grantableModulePermissions(Array.from(ROLES.values()).filter(r => r.status === 'active' && r.source !== 'legacy'))

describe('grant coverage', () => {
  it('Full Access over the whole organization covers its module and makes narrower policies redundant', () => {
    const c = covered([grant('fin-fa')])
    expect(fullyCoveredModules(REQUIRED, c)).toEqual(new Set(['finance']))
    expect(isRedundantPolicy(['finance.cash.prepare'], c)).toBe(true)
    expect(isRedundantPolicy(['finance.cash.prepare', 'hr.payroll.approve'], c)).toBe(false) // adds HR: still legitimate
  })

  it('partial access never covers a module', () => {
    expect(fullyCoveredModules(REQUIRED, covered([grant('bank'), grant('fake-fa')])).has('finance')).toBe(false)
  })

  it('revoked, expired, future-start, retired-policy and compatibility grants cover nothing', () => {
    for (const a of [
      grant('fin-fa', { status: 'revoked' }), grant('fin-fa', { status: 'expired' }),
      grant('fin-fa', { effective_until: '2026-10-01T00:00:00Z' }), grant('fin-fa', { effective_from: '2026-11-01T00:00:00Z' }),
      grant('retired-fa'), grant('legacy'), grant('unknown-role'),
    ]) expect(covered([a]).size).toBe(0)
    expect(isCurrentAssignment(grant('fin-fa', { effective_until: '2026-12-01T00:00:00Z' }), NOW)).toBe(true) // temporary but current
  })

  it('evaluates several Full Access grants together', () => {
    const c = covered([grant('fin-fa'), grant('hr-fa'), grant('sa-fa')])
    expect(fullyCoveredModules(REQUIRED, c)).toEqual(new Set(['finance', 'hr_payroll', 'security_access']))
    expect(isRedundantPolicy(['hr.payroll.approve', 'finance.payment.approve'], c)).toBe(true) // cross-module, both covered
    expect(isRedundantPolicy(['hr.payroll.approve', 'finance.payment.approve'], covered([grant('fin-fa')]))).toBe(false)
  })

  it('only a scope reaching the whole membership organization counts', () => {
    expect(covered([grant('fin-fa', { scopes: [orgScope(WH, 'warehouse')] })]).size).toBe(0)   // one warehouse of the HQ
    expect(covered([grant('fin-fa', { scopes: [orgScope('dept-1', 'department')] })]).size).toBe(0)
    expect(covered([grant('fin-fa', { scopes: [{ scope: { display_name: 'Serapod HQ' } }] })]).size).toBe(0) // unknown reach: never hides
    expect(covered([grant('fin-fa', { scopes: [orgScope(WH, 'warehouse')] })], WH).size).toBe(FIN.length) // a warehouse membership, own scope
    expect(covered([grant('fin-fa')], DIST).size).toBe(0)                                           // another organization
  })

  it('an organization scope on an ancestor covers the organization beneath it; cycles are safe', () => {
    const parents = new Map<string, string | null>([[WH, HQ], [HQ, null]])
    expect(scopeCoversOrganization(grant('fin-fa'), WH, parents)).toBe(true)
    expect(scopeCoversOrganization(grant('fin-fa', { scopes: [orgScope(HQ, 'warehouse')] }), WH, parents)).toBe(false)
    expect(scopeCoversOrganization(grant('fin-fa'), WH, new Map([[WH, 'x'], ['x', WH]]))).toBe(false)
  })

  it('a policy with no permissions is never redundant, and an empty module is never covered', () => {
    expect(isRedundantPolicy([], new Set(['finance.ledger.view']))).toBe(false)
    expect(fullyCoveredModules(new Map([['finance', new Set<string>()]]), new Set()).size).toBe(0)
  })

  it('module requirements ignore permissions outside Full Access and retired catalogue entries', () => {
    const req = grantableModulePermissions([{ permissionKeys: ['platform.user.manage', 'platform.system_logs.view', 'platform.old.thing'] }],
      [{ permission_key: 'platform.user.manage', status: 'active' }, { permission_key: 'platform.system_logs.view', status: 'active' }, { permission_key: 'platform.old.thing', status: 'retired' }])
    expect(req.get('platform_settings')).toEqual(new Set(['platform.user.manage']))
  })

  it('coveringAssignments never mutates its input', () => {
    const list = [grant('fin-fa'), grant('bank', { status: 'revoked' })]
    const copy = JSON.stringify(list)
    expect(coveringAssignments({ assignments: list, organizationId: HQ, roles: ROLES, now: NOW })).toHaveLength(1)
    expect(JSON.stringify(list)).toBe(copy)
  })
})
