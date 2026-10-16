import { describe, expect, it } from 'vitest'
import { HELD_COVERS_WAREHOUSES_MESSAGE, HELD_MESSAGE, describeHeldGrant, findHeldGrant } from './grant-identity'

const HQ = 'hq'
const fakeAdmin = (rows: any[] | null, requested: any[] = [{ scope_type: 'warehouse' }]) => ({
  from: (table: string) => table === 'sa_role_assignments'
    ? { select: () => ({ eq: () => ({ eq: () => ({ eq: async () => ({ data: rows, error: rows ? null : { message: 'x' } }) }) }) }) }
    : { select: () => ({ in: async () => ({ data: requested }) }) },
})
const held = (org: string, scopes: any[], until: string | null = null) => ({ id: 'a', effective_until: until, membership: { organization_id: org }, scopes: scopes.map(scope => ({ scope })) })
const input = { userId: 'u', roleId: 'r', organizationId: HQ, scopeIds: ['s'] }

describe('describeHeldGrant', () => {
  it('explains that an existing HQ-wide grant already covers a warehouse choice and is not restricted by it', () => {
    expect(describeHeldGrant([{ scope_type: 'organization', scope_value: HQ }], HQ, [{ scope_type: 'warehouse' }])).toEqual({ coversWarehouses: true, message: HELD_COVERS_WAREHOUSES_MESSAGE })
    expect(HELD_COVERS_WAREHOUSES_MESSAGE).toMatch(/would not restrict/)
  })
  it('a plain duplicate, or a warehouse grant being repeated, gets the short message', () => {
    expect(describeHeldGrant([{ scope_type: 'organization', scope_value: HQ }], HQ, [{ scope_type: 'organization' }]).message).toBe(HELD_MESSAGE)
    expect(describeHeldGrant([{ scope_type: 'warehouse', scope_value: 'alma' }], HQ, [{ scope_type: 'warehouse' }]).coversWarehouses).toBe(false)
  })
})

describe('findHeldGrant (person + policy + membership organization, active, not expired)', () => {
  it('finds an active grant in the same membership', async () => {
    const r = await findHeldGrant(fakeAdmin([held(HQ, [{ scope_type: 'organization', scope_value: HQ }])]), input)
    expect(r).toMatchObject({ held: true, coversWarehouses: true })
  })
  it('ignores a grant in another membership organization and an expired one (they may be granted again)', async () => {
    expect((await findHeldGrant(fakeAdmin([held('other', [])]), input)).held).toBe(false)
    expect((await findHeldGrant(fakeAdmin([held(HQ, [], '2000-01-01T00:00:00Z')]), input)).held).toBe(false)
  })
  it('an unreadable table is left to the database rule, never a block', async () => {
    expect((await findHeldGrant(fakeAdmin(null), input)).held).toBe(false)
  })
})
