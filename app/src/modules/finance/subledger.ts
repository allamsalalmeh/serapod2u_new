/**
 * Receivables / payables sub-ledger calculations (pure, no I/O).
 *
 * An invoice is in AR / AP only once it is posted to the GL. Money received or paid
 * before that sits in Customer Deposits / Supplier Deposits and is shown as an
 * unapplied advance. Once the invoice is posted, everything received or paid on the
 * order counts against it (the posting applied the advances).
 */

export type PaymentStatus = 'UNPAID' | 'PARTIAL' | 'PAID'

export interface InvoiceBalanceInput {
  total: number
  /** Sum of money received (AR) or paid (AP) on the order, as of the report date. */
  settled: number
  /** Invoice posted to the GL (as of the report date). */
  posted: boolean
}

export interface InvoiceBalance {
  total: number
  settled: number
  /** Open AR / AP on the invoice: zero until it is posted. */
  outstanding: number
  /** Money held as a deposit because the invoice is not posted yet. */
  unappliedAdvance: number
  /** Money above the invoice total (should not happen: postings are capped). */
  overpaid: number
  status: PaymentStatus
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

export function invoiceBalance({ total, settled, posted }: InvoiceBalanceInput): InvoiceBalance {
  const t = round2(total)
  const s = round2(settled)
  const status: PaymentStatus = s <= 0 ? 'UNPAID' : s >= t ? 'PAID' : 'PARTIAL'
  if (!posted) {
    return { total: t, settled: s, outstanding: 0, unappliedAdvance: s, overpaid: 0, status }
  }
  return {
    total: t,
    settled: s,
    outstanding: round2(Math.max(t - s, 0)),
    unappliedAdvance: 0,
    overpaid: round2(Math.max(s - t, 0)),
    status,
  }
}

export const AGING_BUCKETS = ['current', 'd31_60', 'd61_90', 'd91_120', 'over_120'] as const
export type AgingBucket = (typeof AGING_BUCKETS)[number]

export const AGING_BUCKET_LABELS: Record<AgingBucket, string> = {
  current: '0–30 days',
  d31_60: '31–60 days',
  d61_90: '61–90 days',
  d91_120: '91–120 days',
  over_120: 'Over 120 days',
}

/** Whole days from `fromDate` to `asOf` (YYYY-MM-DD), never negative. */
export function daysBetween(fromDate: string, asOf: string): number {
  const a = Date.UTC(+fromDate.slice(0, 4), +fromDate.slice(5, 7) - 1, +fromDate.slice(8, 10))
  const b = Date.UTC(+asOf.slice(0, 4), +asOf.slice(5, 7) - 1, +asOf.slice(8, 10))
  return Math.max(Math.round((b - a) / 86400000), 0)
}

export function agingBucket(days: number): AgingBucket {
  if (days <= 30) return 'current'
  if (days <= 60) return 'd31_60'
  if (days <= 90) return 'd61_90'
  if (days <= 120) return 'd91_120'
  return 'over_120'
}

export interface AgingLine {
  partyId: string
  partyName: string
  /** Invoice date for posted invoices (journal date). */
  invoiceDate: string | null
  outstanding: number
  unappliedAdvance: number
}

export interface AgingRow {
  partyId: string
  partyName: string
  current: number
  d31_60: number
  d61_90: number
  d91_120: number
  over_120: number
  /** Open AR / AP (sum of the buckets). */
  total: number
  /** Deposits received / paid on invoices not posted yet. */
  advances: number
  /** Net position: open AR / AP less advances. */
  net: number
  openInvoices: number
}

export function buildAging(lines: AgingLine[], asOf: string): { rows: AgingRow[]; totals: Omit<AgingRow, 'partyId' | 'partyName'> } {
  const byParty = new Map<string, AgingRow>()
  for (const l of lines) {
    if (l.outstanding <= 0 && l.unappliedAdvance <= 0) continue
    let row = byParty.get(l.partyId)
    if (!row) {
      row = { partyId: l.partyId, partyName: l.partyName, current: 0, d31_60: 0, d61_90: 0, d91_120: 0, over_120: 0, total: 0, advances: 0, net: 0, openInvoices: 0 }
      byParty.set(l.partyId, row)
    }
    if (l.outstanding > 0) {
      const bucket = agingBucket(l.invoiceDate ? daysBetween(l.invoiceDate, asOf) : 0)
      row[bucket] = round2(row[bucket] + l.outstanding)
      row.total = round2(row.total + l.outstanding)
      row.openInvoices += 1
    }
    row.advances = round2(row.advances + l.unappliedAdvance)
    row.net = round2(row.total - row.advances)
  }
  const rows = [...byParty.values()].sort((a, b) => b.total - a.total || a.partyName.localeCompare(b.partyName))
  const totals = rows.reduce(
    (t, r) => ({
      current: round2(t.current + r.current),
      d31_60: round2(t.d31_60 + r.d31_60),
      d61_90: round2(t.d61_90 + r.d61_90),
      d91_120: round2(t.d91_120 + r.d91_120),
      over_120: round2(t.over_120 + r.over_120),
      total: round2(t.total + r.total),
      advances: round2(t.advances + r.advances),
      net: round2(t.net + r.net),
      openInvoices: t.openInvoices + r.openInvoices,
    }),
    { current: 0, d31_60: 0, d61_90: 0, d91_120: 0, over_120: 0, total: 0, advances: 0, net: 0, openInvoices: 0 },
  )
  return { rows, totals }
}

/**
 * Payables: which documents are the supplier invoice of each order.
 * Split orders: the balance PAYMENT_REQUEST. Single-payment orders (COD / 100%) have
 * no request; their INVOICE is the supplier invoice. An INVOICE is used only for
 * orders without a PAYMENT_REQUEST, so no order is counted twice.
 */
export function pickPayableInvoiceDocs<T extends { doc_type: string; order_id: string }>(docs: T[]): T[] {
  const withRequest = new Set(docs.filter((d) => d.doc_type === 'PAYMENT_REQUEST').map((d) => d.order_id))
  const seenInvoice = new Set<string>()
  return docs.filter((d) => {
    if (d.doc_type === 'PAYMENT_REQUEST') return true
    if (d.doc_type !== 'INVOICE' || withRequest.has(d.order_id) || seenInvoice.has(d.order_id)) return false
    seenInvoice.add(d.order_id)
    return true
  })
}
