import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { coverageReport, seededProfilePermissions } from './coverage-audit'
import { DESTRUCTIVE_PERMISSIONS, FULL_ACCESS_POLICIES, OUTSIDE_FULL_ACCESS, fullAccessBadge, isFullAccessPolicy, permissionsOfModule, sortGroupPolicies } from './group-policies'
import { classifyPermission, moduleGroupName, MODULE_TAXONOMY } from './modules'
import { isSensitivePermission } from './profiles'
import { resolveGroup } from './bulk-modes'
import { COMMISSION_PERMISSION_KEYS } from './commission'
import { MSS_PERMISSION_KEYS } from './mss'
import { COMPENSATION_VIEWER_PERMISSION_KEYS } from './compensation-viewer'
import { FISCAL_PERIOD_PERMISSION_KEYS } from './fiscal-period-catalog'

const MIGRATION = readFileSync(resolve(process.cwd(), '..', 'supabase', 'migrations', '20261009100000_sa_group_policies_full_access.sql'), 'utf8')
const universe = coverageReport().universe
const seeded = seededProfilePermissions()
const EXPECTED_COUNTS: Record<string, number> = {
  'supply-chain-full-access': 32, 'customer-growth-full-access': 23, 'hr-payroll-full-access': 25,
  'finance-full-access': 12, 'security-access-full-access': 12, 'platform-settings-full-access': 9,
}

describe('standard module Full Access policies (reviewed explicit lists)', () => {
  it('there is exactly one per top-level business module, none for the shared Reporting analytics permission', () => {
    expect(FULL_ACCESS_POLICIES.map(p => p.roleKey)).toEqual(Object.keys(EXPECTED_COUNTS))
    expect(FULL_ACCESS_POLICIES.map(p => p.moduleId)).toEqual(['supply_chain', 'customer_growth', 'hr_payroll', 'finance', 'security_access', 'platform_settings'])
    for (const p of FULL_ACCESS_POLICIES) expect(MODULE_TAXONOMY.some(g => g.id === p.moduleId)).toBe(true)
    expect(FULL_ACCESS_POLICIES.some(p => p.moduleId === 'reporting')).toBe(false)
  })

  it('each seeded list contains every registered permission that belongs to its module, and nothing else', () => {
    for (const p of FULL_ACCESS_POLICIES) {
      const keys = [...(seeded.get(p.roleKey) ?? [])].sort()
      expect(keys, p.roleKey).toEqual(permissionsOfModule(p.moduleId, universe).filter(k => !OUTSIDE_FULL_ACCESS.includes(k)))
      expect(keys.length, p.roleKey).toBe(EXPECTED_COUNTS[p.roleKey])
      for (const k of keys) expect(classifyPermission(k).groupId, k).toBe(p.moduleId)
    }
  })

  it('module boundaries: no permission belongs to two policies and only Reporting (and the reviewed exclusions) is outside every policy', () => {
    const all = FULL_ACCESS_POLICIES.flatMap(p => [...seeded.get(p.roleKey)!])
    const reviewedOutside = ['platform.system_logs.view', ...COMMISSION_PERMISSION_KEYS, ...MSS_PERMISSION_KEYS, ...COMPENSATION_VIEWER_PERMISSION_KEYS, ...DESTRUCTIVE_PERMISSIONS, ...FISCAL_PERIOD_PERMISSION_KEYS].sort()
    expect(new Set(all).size).toBe(all.length)
    expect(universe.filter(k => !all.includes(k))).toEqual([...reviewedOutside, 'reporting.analytics.view'].sort())
    expect([...OUTSIDE_FULL_ACCESS].sort()).toEqual(reviewedOutside)
  })

  it('cancel/reverse/emergency stay in their policy; destructive reset/delete moved to break-glass (20261110100000)', () => {
    const has = (role: string, key: string) => seeded.get(role)!.has(key)
    expect(has('hr-payroll-full-access', 'hr.data.reset')).toBe(false)
    expect(has('finance-full-access', 'finance.data.reset')).toBe(false)
    expect(has('platform-settings-full-access', 'platform.data.destructive')).toBe(false)
    expect(has('platform-settings-full-access', 'platform.identity.delete')).toBe(false)
    expect(has('supply-chain-full-access', 'supply_chain.order.cancel')).toBe(true)
    expect(has('supply-chain-full-access', 'manufacturing.scan.reverse')).toBe(true)
    expect(has('security-access-full-access', 'security.emergency_access.grant')).toBe(true)
  })

  it('Security & Access Full Access holds every current S&A permission, including policy, assignment, governance and mode management', () => {
    const sa = [...seeded.get('security-access-full-access')!].sort()
    expect(sa).toEqual(universe.filter(k => k.startsWith('security.')))
    expect(sa).toEqual(expect.arrayContaining(['security.access.view', 'security.role.manage', 'security.role.assign', 'security.scope.manage', 'security.permission.manage',
      'security.policy.manage', 'security.access_request.approve', 'security.access_review.manage', 'security.delegation.manage', 'security.audit.view', 'security.service_identity.manage']))
  })

  it('seeding is explicit and repeat-safe: no wildcard or module-based selection, nothing assigned, nothing else changed', () => {
    const body = MIGRATION.slice(MIGRATION.indexOf('do $seed$'), MIGRATION.indexOf('end $seed$'))
    expect(body).toContain('p.permission_key = any(r.permission_keys)')
    expect(body).not.toMatch(/\blike\b|module\s*=|split_part|'\*'/i)
    expect(body).toContain('on conflict (role_key) do nothing')
    expect(body).toContain('continue when v_role is null')                     // an existing policy is never touched or expanded
    expect(body).toContain("array['internal']")
    expect(body).not.toMatch(/sa_role_assignments|sa_migration_modes|update public\.users|insert into public\.users/i)
    expect(MIGRATION).not.toMatch(/update public\.sa_migration_modes|update public\.roles|update public\.users/i)
  })

  it('previously applied migrations are untouched (the seed lives in a new migration file only)', () => {
    expect(MIGRATION).toMatch(/Requires: 20261005110000_sa_access_profiles\.sql/)
  })

  it('a permission registered later is not in any policy, and the drift RPC is the reviewed path to add it', () => {
    const later = 'supply_chain.order.future_operation'
    expect(classifyPermission(later).groupId).toBe('supply_chain')
    for (const p of FULL_ACCESS_POLICIES) expect(seeded.get(p.roleKey)!.has(later)).toBe(false)
    expect(permissionsOfModule('supply_chain', [...universe, later])).toContain(later)   // visible to review, not granted
    expect(MIGRATION).toContain('sa_standard_policy_drift')
    expect(MIGRATION).toMatch(/revoke all on function public\.sa_extend_standard_policy\(text,text\[\],text\) from public, anon, authenticated, service_role/)
  })

  it('which Full Access policies can be assigned while creating a user mirrors the database rule', () => {
    const sensitive = FULL_ACCESS_POLICIES.filter(p => [...seeded.get(p.roleKey)!].some(isSensitivePermission)).map(p => p.roleKey)
    // 20261110100000: HR and Finance Full Access no longer hold a reset permission, so they are offered at user creation.
    expect(sensitive).toEqual(['security-access-full-access', 'platform-settings-full-access'])
  })
})

describe('Security & Access is its own group', () => {
  it('every security.* permission is Security & Access and nothing else is', () => {
    for (const k of universe) expect(classifyPermission(k).groupId === 'security_access', k).toBe(k.startsWith('security.'))
    expect(moduleGroupName('security_access')).toBe('Security & Access')
    expect(moduleGroupName('platform_settings')).toBe('Platform & Settings')
  })

  it('unrelated platform permissions are preserved in Platform & Settings with the same areas', () => {
    expect(classifyPermission('platform.user.manage')).toEqual({ groupId: 'platform_settings', areaId: 'user_admin', areaName: 'User Administration' })
    expect(classifyPermission('platform.settings.manage').areaName).toBe('Integrations & Settings')
    expect(classifyPermission('platform.data.destructive').areaName).toBe('Organizations & Data')
    expect(classifyPermission('security.permission.manage')).toEqual({ groupId: 'security_access', areaId: 'migration_modes', areaName: 'Migration Modes' })
  })

  it('the previous combined bulk-mode group id still resolves to exactly its old permission boundary', () => {
    const keys = universe.filter(k => classifyPermission(k).groupId === 'security_access' || classifyPermission(k).groupId === 'platform_settings')
    const legacy = resolveGroup('platform_security', universe)!
    expect(legacy.keys).toEqual(keys.slice().sort())
    expect(resolveGroup('platform_security/security_governance', universe)!.keys).toEqual(universe.filter(k => k.startsWith('security.')))
    expect(resolveGroup('platform_security/identity', universe)!.keys.every(k => k.startsWith('platform.identity'))).toBe(true)
    expect(resolveGroup('platform_security/unknown', universe)).toBeNull()
    expect(resolveGroup('security_access', universe)!.keys).toEqual(universe.filter(k => k.startsWith('security.')))
  })
})

describe('presentation helpers', () => {
  it('orders module Full Access policies first, then narrower policies by name', () => {
    const items = [{ k: 'warehouse-operator', n: 'Warehouse Operator' }, { k: 'finance-full-access', n: 'Finance Full Access' }, { k: 'access-reviewer', n: 'Access Reviewer' }, { k: 'supply-chain-full-access', n: 'Supply Chain Full Access' }]
    expect(sortGroupPolicies(items, i => i.k, i => i.n).map(i => i.k)).toEqual(['supply-chain-full-access', 'finance-full-access', 'access-reviewer', 'warehouse-operator'])
    expect(isFullAccessPolicy('finance-full-access')).toBe(true)
    expect(isFullAccessPolicy('finance-admin')).toBe(false)
    expect(fullAccessBadge('security-access-full-access')).toBe('Full Access · Security & Access')
  })
})
