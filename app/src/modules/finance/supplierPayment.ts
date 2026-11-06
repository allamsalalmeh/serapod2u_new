// Actual supplier payments: Finance posts the amount really paid, with its bank
// account and reference. Payment terms only give the requested (default) amount.

export const SUPPLIER_PAYMENT_TYPES = ['SUPPLIER_DEPOSIT_PAYMENT', 'SUPPLIER_BALANCE_PAYMENT'] as const

export function isSupplierPaymentType(type: unknown): boolean {
  return typeof type === 'string' && (SUPPLIER_PAYMENT_TYPES as readonly string[]).includes(type)
}

export interface SupplierPaymentInput {
  amount: number
  bankAccountId: string | null
  reference: string | null
  closesDocument: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const MAX_REFERENCE_LENGTH = 100

/** Rounds to cents; returns NaN for anything that is not a finite number. */
export function toAmount(value: unknown): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN
}

export const MAX_REASON_LENGTH = 300

/** Validates a close ("Mark as complete") or reopen request on a payment document. */
export function parsePaymentDocumentAction(
  documentId: unknown,
  body: Record<string, unknown>,
): { ok: true; value: { action: 'close' | 'reopen'; reason: string } } | { ok: false; error: string } {
  if (typeof documentId !== 'string' || !UUID.test(documentId)) {
    return { ok: false, error: 'A valid document id is required' }
  }
  if (body.action !== 'close' && body.action !== 'reopen') {
    return { ok: false, error: "action must be 'close' or 'reopen'" }
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (!reason) return { ok: false, error: 'Enter the reason' }
  if (reason.length > MAX_REASON_LENGTH) {
    return { ok: false, error: `The reason must be at most ${MAX_REASON_LENGTH} characters` }
  }
  return { ok: true, value: { action: body.action, reason } }
}

/** Validates the actual-payment fields sent with a supplier payment posting. */
export function parseSupplierPaymentInput(
  body: Record<string, unknown>,
): { ok: true; value: SupplierPaymentInput } | { ok: false; error: string } {
  const amount = toAmount(body.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'amount must be the amount actually paid (more than zero)' }
  }

  let bankAccountId: string | null = null
  if (body.bankAccountId !== undefined && body.bankAccountId !== null && body.bankAccountId !== '') {
    if (typeof body.bankAccountId !== 'string' || !UUID.test(body.bankAccountId)) {
      return { ok: false, error: 'bankAccountId must be a valid id' }
    }
    bankAccountId = body.bankAccountId
  }

  let reference: string | null = null
  if (body.reference !== undefined && body.reference !== null) {
    if (typeof body.reference !== 'string') return { ok: false, error: 'reference must be text' }
    const trimmed = body.reference.trim()
    if (trimmed.length > MAX_REFERENCE_LENGTH) {
      return { ok: false, error: `reference must be at most ${MAX_REFERENCE_LENGTH} characters` }
    }
    reference = trimmed || null
  }

  const closesDocument = body.closesDocument === undefined ? true : body.closesDocument === true

  return { ok: true, value: { amount, bankAccountId, reference, closesDocument } }
}
