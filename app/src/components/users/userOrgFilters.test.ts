import { describe, expect, it } from 'vitest'
import type { Organization } from '@/types/user'
import {
  buildOrgOptions,
  buildOrgTypeOptions,
  organizationsForType,
  reconcileOrgSelection,
  userMatchesOrgFilters,
} from './userOrgFilters'

const orgs: Organization[] = [
  { id: 'hq', org_name: 'Serapod HQ', org_code: 'HQ01', org_type_code: 'HQ' },
  { id: 'mfg1', org_name: 'Alpha Manufacturing', org_code: 'MFG01', org_type_code: 'MFG' },
  { id: 'mfg2', org_name: 'Legacy Maker', org_code: 'MFG02', org_type_code: 'MANU' },
  { id: 'dist', org_name: 'North Distribution', org_code: 'DIST01', org_type_code: 'DIST' },
  { id: 'wh', org_name: 'Central Warehouse', org_code: 'WH01', org_type_code: 'WH' },
  { id: 'shop1', org_name: 'Kedai Maju', org_code: 'SH01', org_type_code: 'SHOP', branch: 'Ipoh' },
  { id: 'shop2', org_name: 'Kedai Maju', org_code: 'SH02', org_type_code: 'SHOP', branch: 'Klang' },
]
const byId = new Map(orgs.map((o) => [o.id, o]))

describe('organization type options', () => {
  it('lists catalogue types once in hierarchy order, MANU folded into Manufacturer, plus End User', () => {
    expect(buildOrgTypeOptions(orgs)).toEqual([
      { value: 'HQ', label: 'Headquarters' },
      { value: 'MFG', label: 'Manufacturer' },
      { value: 'DIST', label: 'Distributor' },
      { value: 'WH', label: 'Warehouse' },
      { value: 'SHOP', label: 'Shop' },
      { value: 'END_USER', label: 'End User' },
    ])
  })
})

describe('organization options per type', () => {
  it.each([
    ['MFG', ['mfg1', 'mfg2']],
    ['SHOP', ['shop1', 'shop2']],
    ['DIST', ['dist']],
    ['WH', ['wh']],
    ['HQ', ['hq']],
    ['END_USER', []],
    ['', orgs.map((o) => o.id)],
  ])('type %s offers only matching organizations', (type, ids) => {
    expect(organizationsForType(orgs, type).map((o) => o.id)).toEqual(ids)
  })

  it('keeps same-named organizations separate, keyed by id', () => {
    const options = buildOrgOptions(organizationsForType(orgs, 'SHOP'))
    expect(options).toEqual([
      { value: 'shop1', label: 'Kedai Maju (Ipoh · SH01)' },
      { value: 'shop2', label: 'Kedai Maju (Klang · SH02)' },
    ])
  })
})

describe('selection reconciliation', () => {
  it('clears an organization that no longer matches the type and keeps one that does', () => {
    expect(reconcileOrgSelection(orgs, 'MFG', 'shop1')).toBe('')
    expect(reconcileOrgSelection(orgs, 'SHOP', 'shop1')).toBe('shop1')
    expect(reconcileOrgSelection(orgs, '', 'shop1')).toBe('shop1')
    expect(reconcileOrgSelection(orgs, 'END_USER', 'shop1')).toBe('')
    expect(reconcileOrgSelection([], 'SHOP', 'shop1')).toBe('')
  })
})

describe('user matching', () => {
  const users = [
    { id: 'u-hq', organization_id: 'hq' },
    { id: 'u-mfg', organization_id: 'mfg2' },
    { id: 'u-shop1', organization_id: 'shop1' },
    { id: 'u-shop2', organization_id: 'shop2' },
    { id: 'u-consumer', organization_id: null },
    { id: 'u-unknown', organization_id: 'not-in-catalogue' },
  ]
  const match = (type: string, org: string) =>
    users.filter((u) => userMatchesOrgFilters(u, byId, type, org)).map((u) => u.id)

  it('applies type and organization together', () => {
    expect(match('', '')).toEqual(users.map((u) => u.id))
    expect(match('MFG', '')).toEqual(['u-mfg'])
    expect(match('SHOP', '')).toEqual(['u-shop1', 'u-shop2'])
    expect(match('SHOP', 'shop2')).toEqual(['u-shop2'])
    expect(match('', 'shop1')).toEqual(['u-shop1'])
    expect(match('MFG', 'shop1')).toEqual([])
  })

  it('End User means users without an organization', () => {
    expect(match('END_USER', '')).toEqual(['u-consumer'])
  })
})
