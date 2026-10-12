import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GENERAL_AREA, classifyPermission, groupByTaxonomy, permissionModuleLabel } from './modules'
import { aggregateRollout } from './rollout'
import { buildPermissionPicker } from './profiles'
import { COMMISSION_PERMISSION_KEYS } from './commission'
import { MSS_PERMISSION_KEYS } from './mss'
import { HR_DATA_RESET_PERMISSION } from './hr-data-catalog'

// Every hr.* permission seeded into sa_permissions by any migration: ('hr.x.y','hr','x','y', ...
const migrationsDir = resolve(process.cwd(), '..', 'supabase', 'migrations')
const SEEDED_HR_KEYS = Array.from(new Set(readdirSync(migrationsDir).filter(f => f.endsWith('.sql'))
  .flatMap(f => [...readFileSync(resolve(migrationsDir, f), 'utf8').matchAll(/\('(hr\.([a-z_]+)\.([a-z_]+))',\s*'hr',\s*'\2',\s*'\3'/g)].map(m => m[1])))).sort()

const HR_AREAS = ['Payroll & Compensation', 'Employees & Contracts', 'Time, Leave & Expenses', 'Performance & Learning',
  'Employee Self-Service', 'Manager Self-Service', 'HR Administration']
const HR_COMMISSION_KEYS = COMMISSION_PERMISSION_KEYS.filter(k => k.startsWith('hr.'))
const area = (key: string) => classifyPermission(key).areaName

describe('HR & Payroll permission grouping', () => {
  it('finds the seeded HR catalogue (sanity check of the migration scan)', () => {
    expect(SEEDED_HR_KEYS.length).toBeGreaterThanOrEqual(37)
    for (const k of [...HR_COMMISSION_KEYS, ...MSS_PERMISSION_KEYS, HR_DATA_RESET_PERMISSION]) expect(SEEDED_HR_KEYS).toContain(k)
  })

  it('shows exactly the seven approved HR groups, in order', () => {
    const hr = groupByTaxonomy(SEEDED_HR_KEYS, k => k).find(m => m.id === 'hr_payroll')!
    expect(hr.areas.map(a => a.name)).toEqual(HR_AREAS)
    expect(hr.total).toBe(SEEDED_HR_KEYS.length)
  })

  it('leaves no seeded HR permission ungrouped', () => {
    for (const k of SEEDED_HR_KEYS) {
      expect(classifyPermission(k).groupId, k).toBe('hr_payroll')
      expect(classifyPermission(k).areaId, k).not.toBeNull()
    }
    expect(groupByTaxonomy(SEEDED_HR_KEYS, k => k).flatMap(m => m.areas).some(a => a.id === GENERAL_AREA.id)).toBe(false)
  })

  it('places commission under Payroll & Compensation', () => {
    expect(HR_COMMISSION_KEYS).toEqual(['hr.commission.view', 'hr.commission.manage', 'hr.commission.approve'])
    for (const k of HR_COMMISSION_KEYS) expect(area(k), k).toBe('Payroll & Compensation')
    // Commission reporting stays a shared Reporting permission.
    expect(classifyPermission('reporting.commission.view').groupId).toBe('reporting')
  })

  it('groups the six MSS permissions together under Manager Self-Service', () => {
    expect([...MSS_PERMISSION_KEYS].sort()).toEqual(['hr.mss.attendance_view', 'hr.mss.leave_approve', 'hr.mss.leave_view', 'hr.mss.performance_view', 'hr.mss.requests_view', 'hr.mss.team_view'])
    for (const k of MSS_PERMISSION_KEYS) expect(classifyPermission(k), k).toMatchObject({ groupId: 'hr_payroll', areaId: 'manager_self_service' })
    expect(SEEDED_HR_KEYS.filter(k => area(k) === 'Manager Self-Service').sort()).toEqual([...MSS_PERMISSION_KEYS].sort())
  })

  it('places Reset HR Data under HR Administration', () => {
    expect(permissionModuleLabel(HR_DATA_RESET_PERMISSION)).toBe('HR & Payroll · HR Administration')
  })

  it('keeps every other HR permission in its previous group (no unrelated reclassification)', () => {
    const before: Record<string, string[]> = {
      'Payroll & Compensation': ['payroll', 'compensation', 'benefits'],
      'Employees & Contracts': ['employee', 'contract', 'onboarding', 'recruitment'],
      'Time, Leave & Expenses': ['attendance', 'leave', 'expense'],
      'Performance & Learning': ['performance', 'learning'],
      'Employee Self-Service': ['self_service'],
      'HR Administration': ['module', 'settings', 'policy', 'analytics', 'ai'],
    }
    for (const k of SEEDED_HR_KEYS) {
      const resource = k.split('.')[1]
      const prior = Object.entries(before).find(([, rs]) => rs.includes(resource))?.[0]
      if (prior) expect(area(k), k).toBe(prior)
      else expect(['commission', 'mss', 'data'], k).toContain(resource)
    }
  })

  it('preserves each permission key and its migration mode, including Legacy Retired', () => {
    const modes = SEEDED_HR_KEYS.map((permission_key, i) => ({ permission_key, mode: permission_key === HR_DATA_RESET_PERMISSION ? 'LEGACY_RETIRED' : ['SHADOW', 'NEW_ENFORCED'][i % 2] }))
    const hr = aggregateRollout(modes).groups.find(g => g.id === 'hr_payroll')!
    expect(hr.children.map(c => c.name)).toEqual(HR_AREAS)
    expect(hr.permissions).toEqual([])
    const leaves = hr.children.flatMap(c => c.permissions)
    expect(leaves.map(p => p.key).sort()).toEqual(SEEDED_HR_KEYS)
    for (const p of leaves) expect(p.mode, p.key).toBe(modes.find(m => m.permission_key === p.key)!.mode)
    const admin = hr.children.find(c => c.name === 'HR Administration')!
    expect(admin.permissions.find(p => p.key === HR_DATA_RESET_PERMISSION)?.mode).toBe('LEGACY_RETIRED')
    expect(admin.counts.LEGACY_RETIRED).toBe(1)
  })

  it('shows the same HR grouping in the catalogue, the policy editors and the Overview', () => {
    const catalogue = groupByTaxonomy(SEEDED_HR_KEYS, k => k).find(m => m.id === 'hr_payroll')!
    const editor = buildPermissionPicker(SEEDED_HR_KEYS.map(permission_key => ({ permission_key }))).find(m => m.id === 'hr_payroll')!
    const overview = aggregateRollout(SEEDED_HR_KEYS.map(permission_key => ({ permission_key, mode: 'SHADOW' }))).groups.find(g => g.id === 'hr_payroll')!
    const shape = (areas: Array<{ name: string; keys: string[] }>) => areas.map(a => [a.name, [...a.keys].sort()])
    const expected = shape(catalogue.areas.map(a => ({ name: a.name, keys: a.items })))
    expect(shape(editor.areas.map(a => ({ name: a.name, keys: a.permissions.map(p => p.key) })))).toEqual(expected)
    expect(shape(overview.children.map(c => ({ name: c.name, keys: c.permissions.map(p => p.key) })))).toEqual(expected)
  })
})
