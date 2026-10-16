import { describe, expect, it } from 'vitest'
import {
  resolveCreateOrderTypeOptions,
  type CreateOrderTypeAuthzInput,
  type CreateOrderTypeId,
} from './order-type-options'

const ids = (input: Partial<CreateOrderTypeAuthzInput>): CreateOrderTypeId[] =>
  resolveCreateOrderTypeOptions({ orgTypeCode: input.orgTypeCode, roleLevel: input.roleLevel }).map(o => o.id)

describe('Create Order type options', () => {
  // 1. Options keep a stable, fixed ordering.
  it('always orders options H2M, D2H, S2D (subset preserves order)', () => {
    expect(ids({ orgTypeCode: 'HQ', roleLevel: 10 })).toEqual(['h2m', 'd2h', 's2d'])
    expect(ids({ orgTypeCode: 'DIST', roleLevel: 40 })).toEqual(['d2h', 's2d'])
  })

  // 2. Permission loading cannot flash between option sets: visibility depends
  //    only on synchronous org-type + role-level, so repeated calls are identical.
  it('is deterministic across repeated calls with the same input', () => {
    const input = { orgTypeCode: 'WH', roleLevel: 20 }
    const first = ids(input)
    const second = ids(input)
    const third = ids(input)
    expect(first).toEqual(second)
    expect(second).toEqual(third)
    expect(first).toEqual(['d2h', 's2d'])
  })

  // 3. Stable keys: every option's id is unique and matches its identity.
  it('gives each option a stable, unique id used as its key', () => {
    const options = resolveCreateOrderTypeOptions({ orgTypeCode: 'HQ', roleLevel: 1 })
    const keys = options.map(o => o.id)
    expect(new Set(keys).size).toBe(keys.length)
    for (const option of options) {
      expect(option.id).toMatch(/^(h2m|d2h|s2d)$/)
      expect(option.target).toMatch(/^(create-order|distributor-order|shop-order)$/)
    }
  })

  // 6. Existing permission (authorization) rules remain unchanged: H2M gated to
  //    Headquarters users at role level 40 or higher only.
  it('exposes H2M only to HQ users with sufficient role level', () => {
    expect(ids({ orgTypeCode: 'HQ', roleLevel: 40 })).toContain('h2m')
    expect(ids({ orgTypeCode: 'HQ', roleLevel: 41 })).not.toContain('h2m')
    expect(ids({ orgTypeCode: 'DIST', roleLevel: 1 })).not.toContain('h2m')
    expect(ids({ orgTypeCode: 'WH', roleLevel: 10 })).not.toContain('h2m')
    expect(ids({ orgTypeCode: null, roleLevel: 5 })).not.toContain('h2m')
  })

  it('never exposes an order type to an unauthorized user', () => {
    // A non-HQ user must not receive the H2M option under any role level.
    for (const roleLevel of [1, 10, 40, 41, 99]) {
      expect(ids({ orgTypeCode: 'DIST', roleLevel })).not.toContain('h2m')
    }
  })
})
