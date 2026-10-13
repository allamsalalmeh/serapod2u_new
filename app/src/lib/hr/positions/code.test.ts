import { describe, expect, it } from 'vitest'
import { prefixFromName, sequenceSuffix, nextPositionCode } from './code'

describe('prefixFromName', () => {
  it('builds initials for multi-word names', () => {
    expect(prefixFromName('Warehouse Operator')).toBe('WO')
  })
  it('handles a single word', () => {
    expect(prefixFromName('Operator')).toBe('OPE')
  })
  it('handles empty input', () => {
    expect(prefixFromName('')).toBe('POS')
  })
  it('strips punctuation', () => {
    expect(prefixFromName('Managing Director')).toBe('MD')
  })
})

describe('nextPositionCode', () => {
  it('creates WH-OP-001 when nothing is taken', () => {
    expect(nextPositionCode('WH-OP', [], 3)).toBe('WH-OP')
  })
  it('increments to the next free slot when the base is taken', () => {
    expect(nextPositionCode('WH-OP', ['WH-OP'], 3)).toBe('WH-OP-001')
    expect(nextPositionCode('WH-OP', ['WH-OP', 'WH-OP-001', 'WH-OP-002'], 3)).toBe('WH-OP-003')
  })
  it('is case-insensitive against existing codes', () => {
    expect(nextPositionCode('wh-op', ['WH-OP'], 3)).toBe('WH-OP-001')
  })
  it('normalizes whitespace to a dash', () => {
    expect(nextPositionCode('Warehouse Operator', ['WAREHOUSE-OPERATOR'], 3)).toBe('WAREHOUSE-OPERATOR-001')
  })
})

describe('sequenceSuffix', () => {
  it('zero-pads to width', () => {
    expect(sequenceSuffix(1, 3)).toBe('001')
    expect(sequenceSuffix(42, 3)).toBe('042')
  })
})
