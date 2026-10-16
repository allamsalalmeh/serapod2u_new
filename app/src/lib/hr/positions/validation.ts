import type { DateRange } from './types'

/**
 * Pure, DB-independent validation rules for HR Position Management V1.1.
 * These mirror the SQL constraints/triggers in hr02/hr03 so the API can fail
 * fast with friendly messages and the tests can exercise the exact rules.
 */

const OPEN = '9999-12-31'

/** Normalize an open-ended range to a closed interval for comparison. */
const close = (r: DateRange): { from: string; to: string } => ({
  from: r.from,
  to: r.to ?? OPEN,
})

/**
 * Do two date ranges overlap? Ranges overlap when neither is entirely before
 * the other. Open-ended ranges (to === null) extend to "forever".
 */
export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  const ca = close(a)
  const cb = close(b)
  return ca.from <= cb.to && cb.from <= ca.to
}

/** A contiguous range is one where `from` does not come after `to`. */
export function isValidRange(r: DateRange): boolean {
  return !r.to || r.from <= r.to
}

/**
 * Would assigning `parentId` as the (PRIMARY) parent of `positionId` create a
 * reporting cycle? Follows the PRIMARY parent chain (current, active, as-of
 * today) and returns true if `positionId` is reachable from `parentId`.
 */
export function wouldCreateCycle(
  positionId: string,
  parentId: string | null,
  primaryParentById: ReadonlyMap<string, string | null>,
): boolean {
  if (!parentId) return false
  if (positionId === parentId) return true

  const seen = new Set<string>()
  let current: string | null = parentId
  while (current) {
    if (current === positionId) return true
    if (seen.has(current)) return false // pre-existing unrelated cycle — stop
    seen.add(current)
    current = primaryParentById.get(current) ?? null
  }
  return false
}

export interface OverlapResult {
  ok: boolean
  code?: 'EMPLOYEE_OVERLAP' | 'SLOT_OVERLAP'
  message?: string
}

/**
 * Validate a new/updated position assignment against:
 *   1. one active PRIMARY assignment per employee (no time overlap), and
 *   2. max one active incumbent per position slot (no time overlap).
 *
 * `existing` are the OTHER active assignments (excluding the row being edited).
 */
export function validateAssignmentOverlap(
  existing: ReadonlyArray<{
    id: string
    position_id: string
    employee_user_id: string
    assignment_type: string
    effective_from: string
    effective_to: string | null
  }>,
  candidate: { id: string; position_id: string; employee_user_id: string; assignment_type: string; effective_from: string; effective_to: string | null },
): OverlapResult {
  const range: DateRange = { from: candidate.effective_from, to: candidate.effective_to }

  for (const other of existing) {
    if (other.id === candidate.id) continue
    const otherRange: DateRange = { from: other.effective_from, to: other.effective_to }

    // 1) One active PRIMARY per employee.
    if (candidate.assignment_type === 'PRIMARY' && other.assignment_type === 'PRIMARY'
      && other.employee_user_id === candidate.employee_user_id
      && rangesOverlap(range, otherRange)) {
      return {
        ok: false,
        code: 'EMPLOYEE_OVERLAP',
        message: 'This employee already holds an active primary position for an overlapping period.',
      }
    }

    // 2) Max one active incumbent per slot.
    if (other.position_id === candidate.position_id && rangesOverlap(range, otherRange)) {
      return {
        ok: false,
        code: 'SLOT_OVERLAP',
        message: 'This position slot already has an active incumbent for an overlapping period.',
      }
    }
  }
  return { ok: true }
}

export interface PrimaryOverlapResult {
  ok: boolean
  message?: string
}

/**
 * Validate a PRIMARY relationship against other active PRIMARY relationships for
 * the same child position (no overlapping effective periods).
 */
export function validatePrimaryRelationshipOverlap(
  existing: ReadonlyArray<{ id: string; effective_from: string; effective_to: string | null }>,
  candidate: { id: string; effective_from: string; effective_to: string | null },
): PrimaryOverlapResult {
  const range: DateRange = { from: candidate.effective_from, to: candidate.effective_to }
  for (const other of existing) {
    if (other.id === candidate.id) continue
    if (rangesOverlap(range, { from: other.effective_from, to: other.effective_to })) {
      return {
        ok: false,
        message: 'This position already has a primary parent for an overlapping effective period.',
      }
    }
  }
  return { ok: true }
}

/** Is a backdated change? (effective date strictly before today). */
export function isBackdated(effectiveDate: string, today = new Date().toISOString().slice(0, 10)): boolean {
  return effectiveDate < today
}

/** Is a future-dated change? (effective date strictly after today). */
export function isFutureDated(effectiveDate: string, today = new Date().toISOString().slice(0, 10)): boolean {
  return effectiveDate > today
}
