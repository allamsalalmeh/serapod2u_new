/**
 * Payment terms for H2M orders, read from the master data (public.payment_terms).
 * The chosen term is copied into orders.payment_terms by save_order_with_items;
 * the master data itself is never changed here.
 */

export interface PaymentTermOption {
  id: string
  term_code: string
  term_name: string
  deposit_percentage: number
  balance_percentage: number
  is_default?: boolean | null
}

export type PaymentTermKind = 'split' | 'full_prepayment' | 'after_invoice'

/** Split terms run Deposit -> Balance request -> Balance; the others are one payment. */
export function paymentTermKind(depositPercentage: number): PaymentTermKind {
  const d = Number(depositPercentage) || 0
  if (d >= 100) return 'full_prepayment'
  if (d <= 0) return 'after_invoice'
  return 'split'
}

/** The document steps the order will follow, shown under the selector. */
export function paymentTermFlow(term: Pick<PaymentTermOption, 'deposit_percentage' | 'balance_percentage'>): string {
  switch (paymentTermKind(term.deposit_percentage)) {
    case 'full_prepayment':
      return 'Purchase Order → Invoice → Full payment (100%) → Receipt. No balance request.'
    case 'after_invoice':
      return 'Purchase Order → Invoice → Payment (100%) → Receipt. No deposit and no balance request.'
    default:
      return `Purchase Order → Deposit Invoice (${Number(term.deposit_percentage)}%) → Deposit Payment → Balance Request (${Number(term.balance_percentage)}%, on first warehouse receipt) → Balance Payment → Receipt.`
  }
}

/**
 * The option matching what an order already holds: its saved term id first,
 * else the term with the same deposit/balance split (orders saved before ids were stored).
 */
export function termIdForOrder(
  options: PaymentTermOption[],
  saved: { term_id?: string | null; deposit_pct?: number | string | null; balance_pct?: number | string | null } | null | undefined,
): string | null {
  if (!saved) return null
  if (saved.term_id && options.some((o) => o.id === saved.term_id)) return saved.term_id
  const pct = (v: unknown) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return null
    return Math.round((n > 1 ? n : n * 100) * 100) / 100
  }
  const dep = pct(saved.deposit_pct)
  const bal = pct(saved.balance_pct)
  if (dep === null || bal === null) return null
  const match = options.find((o) => Number(o.deposit_percentage) === dep && Number(o.balance_percentage) === bal)
  return match?.id ?? null
}

/** What orders.payment_terms holds (fractions; extra keys from save/override). */
export interface OrderPaymentTerms {
  term_id?: string | null
  term_code?: string | null
  term_name?: string | null
  deposit_pct?: number | string | null
  balance_pct?: number | string | null
  source?: 'partner' | 'default' | 'override' | string | null
  changed_by_name?: string | null
  changed_at?: string | null
  change_reason?: string | null
}

export interface OrderTermsSummary {
  name: string
  kind: PaymentTermKind
  depositPercentage: number
  balancePercentage: number
  depositAmount: number
  balanceAmount: number
}

const toPercent = (v: unknown, fallback: number) => {
  const n = Number(v)
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return fallback
  return Math.round((n > 1 ? n : n * 100) * 100) / 100
}

/** Name, kind and expected amounts for an order's saved terms (old orders default to 50/50). */
export function orderTermsSummary(terms: OrderPaymentTerms | null | undefined, orderTotal: number): OrderTermsSummary {
  const depositPercentage = toPercent(terms?.deposit_pct, 50)
  const balancePercentage = toPercent(terms?.balance_pct, 100 - depositPercentage)
  const total = Number(orderTotal) || 0
  const depositAmount = Math.round(total * depositPercentage) / 100
  return {
    name: terms?.term_name || `${depositPercentage}/${balancePercentage} Split`,
    kind: paymentTermKind(depositPercentage),
    depositPercentage,
    balancePercentage,
    depositAmount,
    balanceAmount: Math.round((total - depositAmount) * 100) / 100,
  }
}

/** Where the order's term came from, in words. */
export function termSourceLabel(terms: OrderPaymentTerms | null | undefined, orderType: string | null | undefined): string {
  const partner = orderType === 'D2H' ? 'distributor' : orderType === 'H2M' ? 'manufacturer' : 'seller'
  switch (terms?.source) {
    case 'override': {
      const who = terms.changed_by_name ? ` by ${terms.changed_by_name}` : ''
      const when = terms.changed_at ? ` on ${new Date(terms.changed_at).toLocaleDateString('en-GB')}` : ''
      return `Changed${who}${when}`
    }
    case 'partner':
      return `From the ${partner}'s master data`
    case 'default':
      return `Default term (the ${partner} has no payment term in the master data)`
    default:
      return 'Saved on the order'
  }
}

/** Why the Change button is not offered. */
export function paymentTermLockText(reason: string | null | undefined): string | null {
  switch (reason) {
    case null:
    case undefined:
    case '':
      return null
    case 'po_acknowledged':
      return 'Locked: the manufacturer has acknowledged the purchase order.'
    case 'invoice_issued':
      return 'Locked: an invoice or payment document has been issued.'
    case 'order_closed':
      return 'Locked: the order is closed.'
    case 'order_cancelled':
      return 'Locked: the order is cancelled.'
    case 'not_authorized':
      return null
    default:
      return 'Payment terms can no longer be changed for this order.'
  }
}

/** Message for an order_change_payment_term error. */
export function paymentTermChangeErrorMessage(error: { message?: string | null; details?: string | null } | null | undefined): string {
  const msg = error?.message || ''
  if (msg.includes('reason_required')) return 'Enter a reason (at least 5 characters).'
  if (msg.includes('invalid_payment_term')) return 'The selected payment term is not available. Choose another one.'
  if (msg.includes('not_authorized')) return 'Only HQ Admin can change payment terms.'
  if (msg.includes('payment_terms_locked')) {
    return paymentTermLockText(error?.details) || 'Payment terms can no longer be changed for this order.'
  }
  return 'The payment term was not changed. Try again.'
}
