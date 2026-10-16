import { describe, expect, it } from 'vitest'
import { scopeLabels } from './scope-labels'

const orgs = new Map([['o1', 'Serapod HQ'], ['o2', 'Balakong WH']])
describe('scopeLabels', () => {
  it('names per-organization own-record scopes by organization', () => {
    const l = scopeLabels([{ id: 'a', display_name: 'Own record', scope_type: 'own_record', organization_id: 'o1' }, { id: 'b', display_name: 'Own record', scope_type: 'own_record', organization_id: 'o2' }], orgs)
    expect([l.get('a'), l.get('b')]).toEqual(['Own record · Serapod HQ', 'Own record · Balakong WH'])
  })
  it('tells an organization and a warehouse with the same name apart, and leaves unique names alone', () => {
    const l = scopeLabels([{ id: 'a', display_name: 'Balakong WH', scope_type: 'organization', organization_id: 'o2' }, { id: 'b', display_name: 'Balakong WH', scope_type: 'warehouse', organization_id: 'o2' }, { id: 'c', display_name: 'Serapod HQ', scope_type: 'organization', organization_id: 'o1' }], orgs)
    expect([l.get('a'), l.get('b'), l.get('c')]).toEqual(['Balakong WH (Organization)', 'Balakong WH (Warehouse)', 'Serapod HQ'])
  })
  it('falls back to the plain name when the organization is unknown', () => {
    expect(scopeLabels([{ id: 'a', display_name: 'Own record', scope_type: 'own_record', organization_id: 'x' }]).get('a')).toBe('Own record')
  })
})
