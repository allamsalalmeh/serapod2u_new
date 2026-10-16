import { describe, expect, it } from 'vitest'
import { userCategoryLabel, userSubtitle } from './display-label'

describe('user category label', () => {
  it('shows a staff label, not "Guest", for the baseline legacy classification', () => {
    expect(userCategoryLabel({ orgTypeCode: 'HQ', roleCode: 'GUEST', roleName: 'Guest' })).toBe('HQ staff')
    expect(userCategoryLabel({ orgTypeCode: 'HQ', roleCode: 'USER', roleName: 'User' })).toBe('HQ staff')
    expect(userCategoryLabel({ orgTypeCode: 'SHOP', roleCode: 'GUEST', roleName: 'Guest' })).toBe('Shop staff')
    expect(userCategoryLabel({ orgTypeCode: null, roleCode: 'GUEST', roleName: 'Guest' })).toBe('Staff')
  })
  it('keeps meaningful role names (administrators, managers) as stored', () => {
    expect(userCategoryLabel({ orgTypeCode: 'HQ', roleCode: 'HQ_ADMIN', roleName: 'HQ Admin' })).toBe('HQ Admin')
    expect(userCategoryLabel({ orgTypeCode: 'WH', roleCode: 'WH_MANAGER', roleName: 'Warehouse Manager' })).toBe('Warehouse Manager')
    expect(userCategoryLabel({ orgTypeCode: 'HQ', roleCode: 'CUSTOM', roleName: null })).toBe('CUSTOM')
  })
  it('never exposes a role level and tolerates missing data', () => {
    expect(userCategoryLabel({})).toBe('Staff')
    expect(userSubtitle({ orgTypeCode: 'HQ', roleCode: 'GUEST', roleName: 'Guest', organizationName: 'Serapod' })).toBe('HQ staff • Serapod')
    expect(userSubtitle({ roleCode: 'GUEST' })).toBe('Staff • No Org')
    expect(userSubtitle({ orgTypeCode: 'HQ', roleCode: 'GUEST' })).not.toMatch(/level|\d{2}/i)
  })
})
