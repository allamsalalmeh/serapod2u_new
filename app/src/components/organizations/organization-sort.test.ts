import { describe, expect, it } from 'vitest'
import { compareOrganizations, type SortableOrganization } from './organization-sort'

const org = (name: string, extra: Partial<SortableOrganization> = {}): SortableOrganization => ({
  org_name: name,
  org_type_code: 'SHOP',
  contact_name: null,
  is_active: true,
  org_types: { type_name: 'Shop' },
  states: null,
  ...extra,
})

const names = (list: SortableOrganization[]) => list.map(o => o.org_name)

describe('compareOrganizations', () => {
  it('sorts by the joined state name, organizations without a state last', () => {
    const list = [
      org('Penang Shop', { states: { state_name: 'Pulau Pinang' } }),
      org('No State'),
      org('Johor Shop', { states: { state_name: 'johor' } }),
      org('KL Shop', { states: { state_name: 'Kuala Lumpur' } }),
    ]
    expect(names([...list].sort((a, b) => compareOrganizations(a, b, 'state', 'asc'))))
      .toEqual(['Johor Shop', 'KL Shop', 'Penang Shop', 'No State'])
    expect(names([...list].sort((a, b) => compareOrganizations(a, b, 'state', 'desc'))))
      .toEqual(['Penang Shop', 'KL Shop', 'Johor Shop', 'No State'])
  })

  it('keeps name, type and status ordering', () => {
    const list = [
      org('beta', { org_type_code: 'DIST', org_types: { type_name: 'Distributor' }, is_active: false }),
      org('Alpha', { org_type_code: 'WH', org_types: null }),
      org('Gamma', { org_type_code: 'HQ', org_types: { type_name: 'Headquarters' } }),
    ]
    expect(names([...list].sort((a, b) => compareOrganizations(a, b, 'org_name', 'asc')))).toEqual(['Alpha', 'beta', 'Gamma'])
    // Type name when known, otherwise the code (WH).
    expect(names([...list].sort((a, b) => compareOrganizations(a, b, 'org_type_code', 'asc')))).toEqual(['beta', 'Gamma', 'Alpha'])
    expect(names([...list].sort((a, b) => compareOrganizations(a, b, 'is_active', 'asc')))).toEqual(['beta', 'Alpha', 'Gamma'])
  })

  it('puts missing contact names last', () => {
    const list = [org('A'), org('B', { contact_name: 'zed' }), org('C', { contact_name: 'Amy' })]
    expect(names([...list].sort((a, b) => compareOrganizations(a, b, 'contact_name', 'asc')))).toEqual(['C', 'B', 'A'])
  })
})
