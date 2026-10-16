import type { ChangeRequestStatus, ChangeRequestType } from './types'

/**
 * Approval workflow state machine for position change requests.
 *
 *   draft → pending → approved → scheduled (future-dated) → effective
 *   plus: rejected / returned / cancelled / activation_failed
 *
 * The transitions here mirror the SQL status check constraint in hr04 and are
 * exercised by the API routes before any write.
 */

export const CHANGE_REQUEST_STATUSES: ChangeRequestStatus[] = [
  'draft',
  'pending',
  'returned',
  'rejected',
  'approved',
  'scheduled',
  'effective',
  'activation_failed',
  'cancelled',
]

/** Structural change types that require approval (never applied immediately). */
export const APPROVAL_REQUIRED_TYPES: ChangeRequestType[] = [
  'CREATE_POSITION',
  'UPDATE_POSITION',
  'CHANGE_REPORTING',
  'ASSIGN_EMPLOYEE',
  'REASSIGN_EMPLOYEE',
  'END_ASSIGNMENT',
  'CHANGE_LIFECYCLE',
]

const TRANSITIONS: Record<ChangeRequestStatus, ChangeRequestStatus[]> = {
  draft: ['pending', 'cancelled'],
  pending: ['approved', 'rejected', 'returned', 'cancelled'],
  returned: ['pending', 'cancelled'],
  rejected: [],
  approved: ['scheduled', 'effective', 'cancelled'],
  scheduled: ['effective', 'cancelled'],
  effective: [],
  activation_failed: ['scheduled', 'cancelled'],
  cancelled: [],
}

/** Whether a transition from `from` to `to` is legal. */
export function canTransition(from: ChangeRequestStatus, to: ChangeRequestStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to)
}

/**
 * Given the current status and the effective date, what is the correct status
 * after approval? Future-dated changes become `scheduled`; today/past become
 * `effective` (activation is performed by the activation job/route).
 */
export function statusAfterApproval(effectiveDate: string | null, today = new Date().toISOString().slice(0, 10)): ChangeRequestStatus {
  if (effectiveDate && effectiveDate > today) return 'scheduled'
  return 'effective'
}

/** Does this request type require S&A approval before it may modify live data? */
export function requiresApproval(type: ChangeRequestType): boolean {
  return APPROVAL_REQUIRED_TYPES.includes(type)
}

/** Whether a backdated change needs special authorization (Part B5). */
export function requiresBackdatedAuthorization(effectiveDate: string, today = new Date().toISOString().slice(0, 10)): boolean {
  return effectiveDate < today
}
