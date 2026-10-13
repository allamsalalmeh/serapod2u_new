import { describe, expect, it } from 'vitest'
import { ESS_ROLE_KEY, essAllowedForOrgType, filterPoliciesForOrgType, isHqOrgType } from './ess-eligibility'

describe('Employee Self Service is HQ-only', () => {
  it.each([['HQ', true], ['hq', true], [' HQ ', true], ['DIST', false], ['SHOP', false], ['MFG', false], ['WH', false], ['', false], [null, false], [undefined, false]])('%s → %s', (code, ok) => {
    expect(isHqOrgType(code as any)).toBe(ok)
    expect(essAllowedForOrgType(code as any)).toBe(ok)
  })

  it('filters ESS policies out for every non-HQ type and keeps every other policy', () => {
    const policies = [{ id: 'a', roleKey: ESS_ROLE_KEY }, { id: 'b', roleKey: 'warehouse-operator' }, { id: 'c', roleKey: null }]
    expect(filterPoliciesForOrgType(policies, 'HQ').map(p => p.id)).toEqual(['a', 'b', 'c'])
    for (const type of ['DIST', 'SHOP', 'MFG', 'WH', null]) expect(filterPoliciesForOrgType(policies, type).map(p => p.id)).toEqual(['b', 'c'])
  })
})
