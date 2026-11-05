/**
 * Acknowledgement outcomes as the user sees them. Shared by the API route (which decides) and AcknowledgeButton (which
 * shows). The route only ever sends these codes and this wording, so no database text, path or stack can reach a toast.
 */
export type AcknowledgeFailureCode =
  | 'ack_unauthenticated'
  | 'ack_access_denied'
  | 'ack_not_found'
  | 'ack_already_acknowledged'
  | 'ack_invalid_request'
  | 'ack_payment_proof_required'
  | 'ack_system_failure'

export interface AcknowledgeFailure {
  code: AcknowledgeFailureCode
  status: number
  message: string
}

export const ACK_SYSTEM_FAILURE_TITLE = 'Unable to acknowledge document'
export const ACK_SYSTEM_FAILURE_MESSAGE = "We couldn't complete your acknowledgement. Please contact your administrator if the issue continues."

const FAILURES: Record<Exclude<AcknowledgeFailureCode, 'ack_system_failure'>, AcknowledgeFailure> = {
  ack_unauthenticated: { code: 'ack_unauthenticated', status: 401, message: 'Your session has ended. Please sign in again.' },
  ack_access_denied: { code: 'ack_access_denied', status: 403, message: 'Your organization is not permitted to acknowledge this document. Please contact the assigned team for assistance.' },
  ack_not_found: { code: 'ack_not_found', status: 404, message: 'This document could not be found. It may have been removed.' },
  ack_already_acknowledged: { code: 'ack_already_acknowledged', status: 409, message: 'This document has already been acknowledged.' },
  ack_invalid_request: { code: 'ack_invalid_request', status: 400, message: 'This document cannot be acknowledged.' },
  ack_payment_proof_required: { code: 'ack_payment_proof_required', status: 400, message: 'Please upload payment proof above before acknowledging this invoice.' },
}

export const acknowledgeFailure = (code: keyof typeof FAILURES): AcknowledgeFailure => FAILURES[code]

/**
 * The business rules po_acknowledge / invoice_acknowledge / payment_acknowledge raise on purpose. Anything else from
 * those RPCs is a system failure. Matched on known wording: their other messages are not safe to pass through.
 */
export function expectedRpcFailure(error: { code?: string | null; message?: string | null } | null | undefined): AcknowledgeFailure | null {
  const message = String(error?.message ?? '').toLowerCase()
  if (message.includes('payment proof is required')) return FAILURES.ack_payment_proof_required
  if (error?.code === '42501' || message.includes('not permitted') || message.includes('for this organization')) return FAILURES.ack_access_denied
  if (message.includes('must be pending')) return FAILURES.ack_already_acknowledged
  if (message.includes('document not found')) return FAILURES.ack_not_found
  return null
}

export interface AcknowledgeToast {
  title: string
  description: string
  reference?: string
}

const TOAST_TITLES: Record<Exclude<AcknowledgeFailureCode, 'ack_system_failure'>, string> = {
  ack_unauthenticated: 'Session Ended',
  ack_access_denied: 'Not Authorized',
  ack_not_found: 'Document Not Found',
  ack_already_acknowledged: 'Already Acknowledged',
  ack_invalid_request: 'Invalid Request',
  ack_payment_proof_required: 'Payment Proof Required',
}

/**
 * Toast for a failed response. Only a recognised code shows its own wording; any other response, such as a gateway
 * error page, is treated as a system failure and its body is ignored.
 */
export function acknowledgeToast(
  body: { code?: unknown; referenceId?: unknown } | null | undefined,
  fallbackReference?: string | null,
  status?: number
): AcknowledgeToast {
  // The Security & Access guard answers with its own body, so a denial is also recognised by its status.
  const code = status === 401 ? 'ack_unauthenticated' : status === 403 ? 'ack_access_denied' : body?.code
  if (typeof code === 'string' && code in FAILURES) {
    const known = code as keyof typeof FAILURES
    return { title: TOAST_TITLES[known], description: FAILURES[known].message }
  }
  const reference = typeof body?.referenceId === 'string' ? body.referenceId : fallbackReference ?? undefined
  return { title: ACK_SYSTEM_FAILURE_TITLE, description: ACK_SYSTEM_FAILURE_MESSAGE, ...(reference ? { reference } : {}) }
}
