import { describe, expect, it } from 'vitest'
import { asJsonObject, isJsonObject } from './json'

describe('jsonb RPC result narrowing', () => {
  it('accepts JSON objects only', () => {
    expect(isJsonObject({ total_qr_codes: 3 })).toBe(true)
    expect(isJsonObject({})).toBe(true)
    for (const value of [null, undefined, [], [{ a: 1 }], 'x', '', 0, 7, true, false]) {
      expect(isJsonObject(value)).toBe(false)
    }
  })

  it('returns the same object, so reads see the RPC values unchanged', () => {
    const result = { success: true, batch_updated: 1, error: null }
    expect(asJsonObject(result)).toBe(result)
    expect(asJsonObject(result).batch_updated).toBe(1)
  })

  it('maps non-objects to {} so property reads are undefined, as optional chaining was', () => {
    for (const value of [null, undefined, [], 'error', 42, true]) {
      const narrowed = asJsonObject(value)
      expect(narrowed).toEqual({})
      expect(narrowed.total_qr_codes).toBeUndefined()
      expect(Number(narrowed.total_qr_codes || 0)).toBe(0)
    }
  })
})
