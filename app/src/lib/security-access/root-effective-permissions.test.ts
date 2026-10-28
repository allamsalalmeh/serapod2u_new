import { describe, expect, it } from 'vitest'
import { catalogueRollout, type CataloguePermission, type Rollout } from './rollout'
import { rootEffectivePermissions } from './root-access-shared'
import { FINAL_WAVE_PERMISSION_KEYS } from './catalog'
import { IDENTITY_PERMISSION_KEYS } from './identity-catalog'
import { STAGE2D_PERMISSION_KEYS } from './stage2d-catalog'
import { USER_ADMIN_PERMISSION_KEYS } from './user-admin-catalog'

const keys = Array.from(new Set([...FINAL_WAVE_PERMISSION_KEYS, ...IDENTITY_PERMISSION_KEYS, ...STAGE2D_PERMISSION_KEYS, ...USER_ADMIN_PERMISSION_KEYS]))
const catalogue: CataloguePermission[] = keys.map(permission_key => ({ permission_key, status: 'active', description: `About ${permission_key}` }))
const leafKeys = (r: Rollout) => r.groups.flatMap(g => [...g.permissions, ...g.children.flatMap(c => c.permissions)]).map(p => p.key)

describe('Effective Root Permissions (display model)', () => {
  it('uses exactly the Roles & Policies → Policies hierarchy for an all-active catalogue', () => {
    const root = rootEffectivePermissions(catalogue)!
    expect(root.rollout).toEqual(catalogueRollout(catalogue))
    expect(root.rollout.groups.map(g => g.name)).toEqual(
      ['Supply Chain', 'Customer & Growth', 'HR & Payroll', 'Finance', 'Security & Access', 'Platform & Settings', 'Reporting'])
  })

  it('lists and counts every active permission exactly once; group and subgroup counts add up', () => {
    const { rollout } = rootEffectivePermissions(catalogue)!
    expect(rollout.total).toBe(keys.length)
    expect(leafKeys(rollout).sort()).toEqual([...keys].sort())
    for (const g of rollout.groups) expect(g.total).toBe(g.permissions.length + g.children.reduce((n, c) => n + c.total, 0))
    expect(rollout.groups.reduce((n, g) => n + g.total, 0)).toBe(rollout.total)
  })

  it('excludes inactive permissions from the list and the count; the rest keep their Policies placement', () => {
    const inactive = new Set([keys[0], keys[5], keys[keys.length - 1]])
    const mixed = catalogue.map(p => inactive.has(p.permission_key) ? { ...p, status: 'inactive' } : p)
    const root = rootEffectivePermissions(mixed, keys.length - inactive.size)!
    expect(root.rollout.total).toBe(keys.length - inactive.size)
    expect(root.inactiveExcluded).toBe(inactive.size)
    expect(leafKeys(root.rollout).some(k => inactive.has(k))).toBe(false)
    expect(root.reconciled).toBe(true)
    expect(root.rollout).toEqual(catalogueRollout(mixed.filter(p => p.status === 'active')))
  })

  it('includes a newly added permission automatically (an unmapped module stays visible, as in Policies)', () => {
    const added = [...catalogue, { permission_key: 'brandnew.widget.view', status: 'active' }]
    const root = rootEffectivePermissions(added)!
    expect(root.rollout.total).toBe(keys.length + 1)
    expect(leafKeys(root.rollout)).toContain('brandnew.widget.view')
    expect(root.rollout.groups.map(g => g.id)).toEqual(catalogueRollout(added).groups.map(g => g.id))
  })

  it('does not claim reconciliation when the server count differs from the rows shown', () => {
    expect(rootEffectivePermissions(catalogue, keys.length + 2)!.reconciled).toBe(false)
    expect(rootEffectivePermissions(catalogue, keys.length)!.reconciled).toBe(true)
    expect(rootEffectivePermissions(catalogue, null)!.reconciled).toBe(true)
  })

  it('returns nothing without a catalogue and an empty tree for an empty one', () => {
    expect(rootEffectivePermissions(undefined)).toBeNull()
    expect(rootEffectivePermissions(null)).toBeNull()
    expect(rootEffectivePermissions([], 0)).toMatchObject({ rollout: { total: 0, groups: [] }, reconciled: true })
  })
})
