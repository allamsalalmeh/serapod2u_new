import { describe, expect, it } from 'vitest'
import {
  rangesOverlap,
  isValidRange,
  wouldCreateCycle,
  validateAssignmentOverlap,
  validatePrimaryRelationshipOverlap,
  isBackdated,
  isFutureDated,
} from './validation'

describe('rangesOverlap', () => {
  it('detects an overlapping pair', () => {
    expect(rangesOverlap({ from: '2026-01-01', to: '2026-12-31' }, { from: '2026-06-01', to: null })).toBe(true)
  })
  it('detects adjacency as non-overlap (from == prior to)', () => {
    expect(rangesOverlap({ from: '2026-01-01', to: '2026-01-31' }, { from: '2026-02-01', to: null })).toBe(false)
  })
  it('open-ended ranges overlap later ranges', () => {
    expect(rangesOverlap({ from: '2026-01-01', to: null }, { from: '2026-06-01', to: null })).toBe(true)
  })
  it('non-overlapping disjoint ranges do not overlap', () => {
    expect(rangesOverlap({ from: '2026-01-01', to: '2026-01-31' }, { from: '2026-03-01', to: '2026-03-31' })).toBe(false)
  })
})

describe('isValidRange', () => {
  it('rejects a range where from > to', () => {
    expect(isValidRange({ from: '2026-02-01', to: '2026-01-01' })).toBe(false)
  })
  it('accepts open-ended and valid ranges', () => {
    expect(isValidRange({ from: '2026-01-01', to: null })).toBe(true)
    expect(isValidRange({ from: '2026-01-01', to: '2026-01-31' })).toBe(true)
  })
})

describe('wouldCreateCycle', () => {
  const parents = new Map<string, string | null>([
    ['MD1', null],
    ['MD2', null],
    ['GM', 'MD1'],
    ['WH-MGR', 'GM'],
    ['WH-OP', 'WH-MGR'],
  ])

  it('rejects self-parenting', () => {
    expect(wouldCreateCycle('GM', 'GM', parents)).toBe(true)
  })
  it('rejects a cycle (GM -> WH-OP when WH-OP reports up to GM)', () => {
    expect(wouldCreateCycle('GM', 'WH-OP', parents)).toBe(true)
  })
  it('accepts a valid new parent', () => {
    expect(wouldCreateCycle('WH-OP', 'GM', parents)).toBe(false)
  })
  it('accepts a null parent (root)', () => {
    expect(wouldCreateCycle('X', null, parents)).toBe(false)
  })
})

describe('validateAssignmentOverlap', () => {
  it('rejects a second active primary assignment for the same employee', () => {
    const res = validateAssignmentOverlap(
      [{ id: 'a1', position_id: 'p1', employee_user_id: 'e1', assignment_type: 'PRIMARY', effective_from: '2026-01-01', effective_to: null }],
      { id: 'a2', position_id: 'p2', employee_user_id: 'e1', assignment_type: 'PRIMARY', effective_from: '2026-06-01', effective_to: null },
    )
    expect(res.ok).toBe(false)
    expect(res.code).toBe('EMPLOYEE_OVERLAP')
  })
  it('rejects a second active incumbent for the same slot', () => {
    const res = validateAssignmentOverlap(
      [{ id: 'a1', position_id: 'p1', employee_user_id: 'e1', assignment_type: 'PRIMARY', effective_from: '2026-01-01', effective_to: null }],
      { id: 'a2', position_id: 'p1', employee_user_id: 'e2', assignment_type: 'PRIMARY', effective_from: '2026-06-01', effective_to: null },
    )
    expect(res.ok).toBe(false)
    expect(res.code).toBe('SLOT_OVERLAP')
  })
  it('allows non-overlapping successive assignments to the same slot', () => {
    const res = validateAssignmentOverlap(
      [{ id: 'a1', position_id: 'p1', employee_user_id: 'e1', assignment_type: 'PRIMARY', effective_from: '2026-01-01', effective_to: '2026-01-31' }],
      { id: 'a2', position_id: 'p1', employee_user_id: 'e2', assignment_type: 'PRIMARY', effective_from: '2026-02-01', effective_to: null },
    )
    expect(res.ok).toBe(true)
  })
})

describe('validatePrimaryRelationshipOverlap', () => {
  it('rejects overlapping primary parents', () => {
    const res = validatePrimaryRelationshipOverlap(
      [{ id: 'r1', effective_from: '2026-01-01', effective_to: null }],
      { id: 'r2', effective_from: '2026-06-01', effective_to: null },
    )
    expect(res.ok).toBe(false)
  })
  it('allows non-overlapping primary parents', () => {
    const res = validatePrimaryRelationshipOverlap(
      [{ id: 'r1', effective_from: '2026-01-01', effective_to: '2026-01-31' }],
      { id: 'r2', effective_from: '2026-02-01', effective_to: null },
    )
    expect(res.ok).toBe(true)
  })
})

describe('effective date classification', () => {
  it('classifies past, today and future', () => {
    expect(isBackdated('2026-01-01', '2026-02-01')).toBe(true)
    expect(isBackdated('2026-02-01', '2026-02-01')).toBe(false)
    expect(isFutureDated('2026-03-01', '2026-02-01')).toBe(true)
    expect(isFutureDated('2026-02-01', '2026-02-01')).toBe(false)
  })
})
