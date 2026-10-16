import { describe, expect, it } from 'vitest'
import { HUMAN_PRINCIPAL_TYPES, derivePrincipalType } from '@/lib/identity/resolution'
import { getOrgTypeName } from '@/lib/utils/orgHierarchy'
import { CATEGORY_LABELS, GRANT_BLOCK_TEXT, ORG_TYPE_OPTIONS, categoryLabel, grantBlock, orgTypeLabel } from './directory-labels'
import { DIRECTORY_CATEGORIES } from './directory'

describe('directory classification mirrors User Management / identity', () => {
  it('user categories are exactly the identity principal types plus an honest Unclassified', () => {
    expect([...DIRECTORY_CATEGORIES]).toEqual([...HUMAN_PRINCIPAL_TYPES, 'UNCLASSIFIED'])
    for (const c of DIRECTORY_CATEGORIES) expect(CATEGORY_LABELS[c], c).toBeTruthy()
    expect(categoryLabel(null)).toBe('Unclassified')
    expect(categoryLabel(undefined)).toBe('Unclassified')
  })
  it('a shop account is shop staff and only a store-scope account is a consumer, whatever its legacy role code is', () => {
    expect(derivePrincipalType('portal', 'SHOP')).toBe('SHOP_STAFF')     // e.g. role GUEST in a shop
    expect(derivePrincipalType('store', 'SHOP')).toBe('CONSUMER')
    expect(derivePrincipalType('store', null)).toBe('CONSUMER')
    expect(derivePrincipalType('portal', 'MFG')).toBe('MANUFACTURER_USER')
    expect(derivePrincipalType('portal', 'DIST')).toBe('DISTRIBUTOR_USER')
    expect(derivePrincipalType('portal', 'HQ')).toBe('INTERNAL_EMPLOYEE')
  })
  it('organization-type labels are the ones User Management shows', () => {
    for (const t of ORG_TYPE_OPTIONS) expect(orgTypeLabel(t), t).toBe(getOrgTypeName(t))
    expect([...ORG_TYPE_OPTIONS]).toEqual(['HQ', 'MFG', 'DIST', 'WH', 'SHOP'])
  })
})

describe('grantBlock', () => {
  const active = (over: any = {}) => ({ status: 'active', grantable: true, ...over })
  it('is null when an active, grantable membership exists for someone else', () => {
    expect(grantBlock({ id: 'a', is_active: true, membership: [active()] }, 'v')).toBeNull()
  })
  it('keeps missing membership separate from every other reason', () => {
    expect(grantBlock({ id: 'a', is_active: true, membership: [] }, 'v')).toBe('no_membership')
    expect(grantBlock({ id: 'a', is_active: true, membership: [{ status: 'inactive', grantable: false }] }, 'v')).toBe('membership_inactive')
    expect(grantBlock({ id: 'a', is_active: false, membership: [] }, 'v')).toBe('account_inactive')
    expect(grantBlock({ id: 'v', is_active: true, membership: [active()] }, 'v')).toBe('self')
    expect(grantBlock({ id: 'a', is_active: true, membership: [active({ grantable: false, grant_blocked_reason: 'not_authorized' })] }, 'v')).toBe('not_authorized')
    expect(grantBlock({ id: 'a', is_active: false, membership: [active()] }, 'v')).toBe('account_inactive')
  })
  it('uses short neutral wording (no warning language, no HR enrolment, no access claim)', () => {
    expect(GRANT_BLOCK_TEXT.no_membership).toBe('An active business membership is required to assign an Group Policy.')
    for (const text of Object.values(GRANT_BLOCK_TEXT)) {
      expect(text).not.toMatch(/cannot grant:|nothing can be granted|HR employee|enrol|No additional S&A access/i)
    }
  })
})
