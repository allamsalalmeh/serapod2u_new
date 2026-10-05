import { describe, expect, it } from 'vitest'
import { coverageReport, seededProfilePermissions } from './coverage-audit'
import { buildRollout } from './rollout'
import { buildPermissionPicker } from './profiles'
import { classifyPermission, groupByTaxonomy, moduleGroupName } from './modules'
import { permissionLabel } from './labels'

const report = coverageReport()

describe('S&A coverage audit (read-only)', () => {
  it('finds no orphan registrations: readiness, route checks and profiles only reference known permissions', () => {
    expect(report.orphanReady).toEqual([])
    expect(report.orphanRoutes).toEqual([])
    expect(report.profileOrphans).toEqual([])
  })

  it('classifies every permission into the shared taxonomy (nothing falls into Other / Unmapped)', () => {
    expect(report.unclassified).toEqual([])
  })

  it('qr.batch.manage is registered, enforcement-ready, runtime-referenced and now has exactly one narrow standard profile', () => {
    expect(report.universe).toContain('qr.batch.manage')
    expect(report.withoutProfile).not.toContain('qr.batch.manage')
    const holders = [...seededProfilePermissions()].filter(([, keys]) => keys.has('qr.batch.manage')).map(([role]) => role)
    expect(holders).toEqual(['qr-batch-operator'])
    expect([...seededProfilePermissions().get('qr-batch-operator')!]).toEqual(['qr.batch.manage'])   // nothing else rides along
  })

  it('permission counts and profile counts are different objects and are not forced to match', () => {
    // Informational: some operations legitimately have no standard profile (they are granted through custom
    // profiles or only through compatibility/automatic access). This must never be "fixed" by inventing profiles.
    expect(report.withoutProfile.length).toBeGreaterThan(0)
    expect(report.universe.length).not.toBe(seededProfilePermissions().size)
  })
})

describe('one taxonomy across Migration Modes, Catalogue, Access Profiles and the profile editor', () => {
  const rows = report.universe.map(key => ({ key, label: permissionLabel(key).label, mode: 'SHADOW', enforcementReady: false }))
  const rollout = buildRollout(rows)
  const picker = buildPermissionPicker(report.universe.map(permission_key => ({ permission_key })))
  const direct = groupByTaxonomy(report.universe, k => k)

  it('uses the same module ids, names and order everywhere', () => {
    const ids = (xs: Array<{ id: string }>) => xs.map(x => x.id)
    expect(ids(picker)).toEqual(ids(rollout.groups))
    expect(ids(direct)).toEqual(ids(rollout.groups))
    expect(picker.map(m => m.name)).toEqual(rollout.groups.map(g => g.name))
    expect(rollout.groups.map(g => g.name)).toEqual(rollout.groups.map(g => moduleGroupName(g.id)))
  })

  it('uses the same functional areas (ids, names, order) and the same permissions in each', () => {
    for (const g of rollout.groups) {
      const m = picker.find(x => x.id === g.id)!
      const rolloutAreas = g.children.map(c => c.id.split('/')[1])
      const pickerAreas = m.areas.map(a => a.id).filter(id => id !== '_general')
      expect(pickerAreas, g.id).toEqual(rolloutAreas)
      for (const c of g.children) {
        const area = m.areas.find(a => a.id === c.id.split('/')[1])!
        expect(area.name).toBe(c.name)
        expect(area.permissions.map(p => p.key).sort()).toEqual(c.permissions.map(p => p.key).sort())
      }
      expect(m.total).toBe(g.total)
    }
  })

  it('every permission has one stable path and is listed exactly once', () => {
    const seen = picker.flatMap(m => m.areas.flatMap(a => a.permissions.map(p => p.key)))
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.sort()).toEqual([...report.universe].sort())
    for (const key of report.universe) expect(classifyPermission(key).groupId).not.toBe('other')
  })

  it('the hierarchy is display only: no function here selects, grants or inherits a permission', () => {
    const before = picker.flatMap(m => m.areas.flatMap(a => a.permissions)).length
    const after = buildPermissionPicker([...report.universe, 'inventory.stock_count.brand_new'].map(permission_key => ({ permission_key }))).flatMap(m => m.areas.flatMap(a => a.permissions)).length
    expect(after).toBe(before + 1)   // a newly registered permission is listed, never auto-selected anywhere
  })
})
