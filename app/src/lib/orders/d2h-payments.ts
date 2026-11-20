/** D2H partial payments: summary from d2h_order_payment_summary and its wording. */

export interface D2HPaymentSummary {
  order_total: number
  paid: number
  verified: number
  outstanding: number
  pending_payment_id: string | null
  pending_payment_no: string | null
  pending_amount: number | null
  invoice_acknowledged: boolean
  order_status: string
  can_record: boolean
}

/** Label and colour of the order's payment state. */
export function d2hPaymentStatus(s: Pick<D2HPaymentSummary, 'order_total' | 'paid' | 'verified' | 'order_status'>): { label: string; tone: string } {
  const total = Number(s.order_total) || 0
  const paid = Number(s.paid) || 0
  const verified = Number(s.verified) || 0
  if (s.order_status === 'cancelled') return { label: 'Cancelled', tone: 'bg-gray-100 text-gray-700' }
  if (s.order_status === 'closed') return { label: 'Closed — paid and verified', tone: 'bg-emerald-100 text-emerald-800' }
  if (total > 0 && paid >= total - 0.005) {
    return verified >= total - 0.005
      ? { label: 'Paid and verified', tone: 'bg-emerald-100 text-emerald-800' }
      : { label: 'Paid — pending Finance verification', tone: 'bg-amber-100 text-amber-800' }
  }
  if (paid > 0) {
    const fmt = (n: number) => n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    return { label: `Partially paid: RM ${fmt(paid)} of RM ${fmt(total)}`, tone: 'bg-blue-100 text-blue-800' }
  }
  return { label: 'Not paid yet', tone: 'bg-gray-100 text-gray-700' }
}

/**
 * Amount HQ acknowledges when the pending payment has no amount stated, as payment_acknowledge
 * does: the deposit for the first payment of a split term, otherwise what is outstanding.
 */
export function d2hExpectedPendingAmount(
  s: Pick<D2HPaymentSummary, 'paid' | 'outstanding'>,
  terms: { kind: string; depositAmount: number } | null | undefined,
): number {
  const outstanding = Math.max(Number(s.outstanding) || 0, 0)
  const first = (Number(s.paid) || 0) <= 0.005
  const amount = first && terms?.kind === 'split' ? Number(terms.depositAmount) || 0 : outstanding
  return Math.round(Math.min(Math.max(amount, 0), outstanding) * 100) / 100
}

/** Message for an error of d2h_set_pending_payment_amount / d2h_record_next_payment. */
export function d2hPaymentErrorMessage(error: { message?: string | null; details?: string | null } | null | undefined): string {
  const msg = error?.message || ''
  if (msg.includes('invalid_payment_amount')) {
    const out = /outstanding=([\d.]+)/.exec(error?.details || '')?.[1]
    return out ? `Enter an amount above 0 and up to the outstanding RM ${out}.` : 'Enter an amount above 0 and up to what is outstanding.'
  }
  if (msg.includes('payment_proof_required')) return 'Upload the payment proof first.'
  if (msg.includes('payment_already_pending')) return 'A payment is already waiting for HQ to acknowledge it.'
  if (msg.includes('nothing_outstanding')) return 'Nothing is outstanding on this order.'
  if (msg.includes('invoice_not_acknowledged')) return 'The invoice must be acknowledged first.'
  if (msg.includes('order_not_open')) return 'The order is closed or cancelled.'
  if (msg.includes('not_authorized')) return 'Only the distributor or HQ Admin can record payments for this order.'
  if (msg.includes('no_pending_payment')) return 'There is no payment waiting for an amount.'
  return 'Something went wrong. Try again.'
}
