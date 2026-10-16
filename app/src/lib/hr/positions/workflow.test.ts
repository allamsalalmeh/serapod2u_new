import { describe, expect, it } from 'vitest'
import {
  canTransition,
  statusAfterApproval,
  requiresApproval,
  requiresBackdatedAuthorization,
} from './workflow'

describe('workflow state machine', () => {
  it('allows draft -> pending and draft -> cancelled', () => {
    expect(canTransition('draft', 'pending')).toBe(true)
    expect(canTransition('draft', 'cancelled')).toBe(true)
    expect(canTransition('draft', 'effective')).toBe(false)
  })
  it('allows pending -> approved / rejected / returned', () => {
    expect(canTransition('pending', 'approved')).toBe(true)
    expect(canTransition('pending', 'rejected')).toBe(true)
    expect(canTransition('pending', 'returned')).toBe(true)
    expect(canTransition('pending', 'draft')).toBe(false)
  })
  it('allows returned -> pending (resubmission)', () => {
    expect(canTransition('returned', 'pending')).toBe(true)
  })
  it('approved becomes scheduled when future-dated, effective otherwise', () => {
    expect(statusAfterApproval('2026-06-01', '2026-02-01')).toBe('scheduled')
    expect(statusAfterApproval('2026-02-01', '2026-02-01')).toBe('effective')
    expect(statusAfterApproval('2026-01-01', '2026-02-01')).toBe('effective')
    expect(statusAfterApproval(null, '2026-02-01')).toBe('effective')
  })
  it('terminal states do not transition', () => {
    expect(canTransition('effective', 'cancelled')).toBe(false)
    expect(canTransition('rejected', 'pending')).toBe(false)
    expect(canTransition('cancelled', 'draft')).toBe(false)
  })
})

describe('approval gating', () => {
  it('all structural change types require approval', () => {
    for (const t of ['CREATE_POSITION', 'UPDATE_POSITION', 'CHANGE_REPORTING', 'ASSIGN_EMPLOYEE', 'REASSIGN_EMPLOYEE', 'END_ASSIGNMENT', 'CHANGE_LIFECYCLE'] as const) {
      expect(requiresApproval(t)).toBe(true)
    }
  })
  it('backdated changes require special authorization', () => {
    expect(requiresBackdatedAuthorization('2026-01-01', '2026-02-01')).toBe(true)
    expect(requiresBackdatedAuthorization('2026-02-01', '2026-02-01')).toBe(false)
  })
})
