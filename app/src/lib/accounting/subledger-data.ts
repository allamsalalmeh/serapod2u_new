/**
 * Loads the receivables (AR, D2H sales) or payables (AP, purchases) sub-ledger:
 * every invoice with its posting status and the money actually received or paid
 * on its order (fin_payments, plus payments posted before fin_payments existed).
 *
 * Call with the admin client: fin_payments is not readable by users. Every query
 * is filtered by company. Callers check the finance permission first.
 */
import {
  agingBucket,
  buildAging,
  daysBetween,
  invoiceBalance,
  type AgingBucket,
  type AgingRow,
  type InvoiceBalance,
} from '@/modules/finance/subledger'

export type SubledgerSide = 'AR' | 'AP'

export interface SubledgerInvoice {
  /** INVOICE / PAYMENT_REQUEST document id, or the order id for a sales order posted the old way. */
  documentId: string
  documentNo: string
  orderId: string
  orderNo: string
  partyId: string
  partyName: string
  documentDate: string
  documentStatus: string
  posted: boolean
  postedDate: string | null
  journalNumber: string | null
  balance: InvoiceBalance
}

const CHUNK = 100

async function inChunks<T>(ids: string[], fetch: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []
  const unique = [...new Set(ids.filter(Boolean))]
  for (let i = 0; i < unique.length; i += CHUNK) out.push(...(await fetch(unique.slice(i, i + CHUNK))))
  return out
}

const SIDE = {
  AR: {
    invoiceDocType: 'INVOICE',
    invoicePosting: 'SALES_INVOICE',
    direction: 'IN',
    legacyPaymentPostings: ['RECEIPT'],
    legacyPaymentDocType: 'RECEIPT',
    partyColumn: 'buyer_org_id',
  },
  AP: {
    invoiceDocType: 'PAYMENT_REQUEST',
    invoicePosting: 'SUPPLIER_INVOICE_RECOGNITION',
    direction: 'OUT',
    legacyPaymentPostings: ['SUPPLIER_DEPOSIT_PAYMENT', 'SUPPLIER_BALANCE_PAYMENT'],
    legacyPaymentDocType: 'PAYMENT',
    partyColumn: 'seller_org_id',
  },
} as const

export async function loadSubledger(
  admin: any,
  opts: { companyId: string; side: SubledgerSide; asOf?: string | null },
): Promise<{ invoices: SubledgerInvoice[]; error: string | null }> {
  const cfg = SIDE[opts.side]
  const asOf = opts.asOf || null

  // 1. Invoices (D2H only for AR; everything but D2H for AP).
  let docQuery = admin
    .from('documents')
    .select(`id, doc_no, display_doc_no, status, created_at, order_id,
             orders!inner ( id, order_no, display_doc_no, order_type, buyer_org_id, seller_org_id )`)
    .eq('company_id', opts.companyId)
    .eq('doc_type', cfg.invoiceDocType)
  docQuery = opts.side === 'AR' ? docQuery.eq('orders.order_type', 'D2H') : docQuery.neq('orders.order_type', 'D2H')
  const { data: docs, error: docError } = await docQuery.order('created_at', { ascending: true })
  if (docError) return { invoices: [], error: docError.message }

  const invoiceDocs: any[] = docs || []
  const docIds = invoiceDocs.map((d) => d.id)
  const orderIdsWithInvoice = new Set(invoiceDocs.map((d) => d.order_id))

  // 2. Invoice postings (by document; for AR also sales orders posted the old way, by order id).
  const { data: invoicePostingsRaw, error: postError } = await admin
    .from('gl_document_postings')
    .select('document_id, journal_id, posting_status')
    .eq('company_id', opts.companyId)
    .eq('document_type', cfg.invoicePosting)
    .eq('posting_status', 'POSTED')
  if (postError) return { invoices: [], error: postError.message }
  const invoicePostings: any[] = invoicePostingsRaw || []
  const postingByDoc = new Map<string, any>(invoicePostings.map((p) => [p.document_id, p]))

  // Sales orders posted by order id that have no INVOICE document (older orders).
  const legacyOrderIds = opts.side === 'AR'
    ? invoicePostings.map((p) => p.document_id).filter((id) => !docIds.includes(id) && !orderIdsWithInvoice.has(id))
    : []
  const legacyOrders = await inChunks(legacyOrderIds, async (chunk) => {
    const { data } = await admin
      .from('orders')
      .select('id, order_no, display_doc_no, order_type, buyer_org_id, seller_org_id, created_at, status')
      .in('id', chunk)
      .eq('order_type', 'D2H')
    return data || []
  })

  const allOrderIds = [...orderIdsWithInvoice, ...legacyOrders.map((o: any) => o.id)]

  // 3. Journal dates and numbers of the invoice postings.
  const journals = await inChunks(invoicePostings.map((p) => p.journal_id), async (chunk) => {
    const { data } = await admin.from('gl_journals').select('id, journal_number, journal_date').in('id', chunk)
    return data || []
  })
  const journalById = new Map<string, any>(journals.map((j: any) => [j.id, j]))

  // 4. Order totals.
  const items = await inChunks(allOrderIds, async (chunk) => {
    const { data } = await admin.from('order_items').select('order_id, line_total').in('order_id', chunk)
    return data || []
  })
  const orderTotal = new Map<string, number>()
  for (const it of items as any[]) orderTotal.set(it.order_id, (orderTotal.get(it.order_id) || 0) + (Number(it.line_total) || 0))

  // 5. Money received / paid per order (posted, up to the report date).
  const payments = await inChunks(allOrderIds, async (chunk) => {
    let q = admin
      .from('fin_payments')
      .select('order_id, document_id, amount, payment_date')
      .eq('company_id', opts.companyId)
      .eq('direction', cfg.direction)
      .eq('status', 'POSTED')
      .in('order_id', chunk)
    if (asOf) q = q.lte('payment_date', asOf)
    const { data } = await q
    return data || []
  })
  const settledByOrder = new Map<string, number>()
  const docsWithPayments = new Set<string>()
  for (const p of payments as any[]) {
    settledByOrder.set(p.order_id, (settledByOrder.get(p.order_id) || 0) + (Number(p.amount) || 0))
    docsWithPayments.add(p.document_id)
  }

  // Payments posted before fin_payments existed: posting rows on payment documents
  // that have no fin_payments row.
  const paymentDocs = await inChunks(allOrderIds, async (chunk) => {
    const { data } = await admin
      .from('documents')
      .select('id, order_id')
      .eq('company_id', opts.companyId)
      .eq('doc_type', cfg.legacyPaymentDocType)
      .in('order_id', chunk)
    return data || []
  })
  const legacyCandidates = (paymentDocs as any[]).filter((d) => !docsWithPayments.has(d.id))
  const orderByPaymentDoc = new Map<string, string>(legacyCandidates.map((d) => [d.id, d.order_id]))
  const legacyPayments = await inChunks(legacyCandidates.map((d) => d.id), async (chunk) => {
    const { data } = await admin
      .from('gl_document_postings')
      .select('document_id, posted_amount, created_at')
      .eq('company_id', opts.companyId)
      .in('document_type', [...cfg.legacyPaymentPostings])
      .eq('posting_status', 'POSTED')
      .in('document_id', chunk)
    return data || []
  })
  for (const p of legacyPayments as any[]) {
    if (asOf && p.created_at && String(p.created_at).slice(0, 10) > asOf) continue
    const orderId = orderByPaymentDoc.get(p.document_id)
    if (orderId) settledByOrder.set(orderId, (settledByOrder.get(orderId) || 0) + (Number(p.posted_amount) || 0))
  }

  // 6. Party names.
  const partyIds = [
    ...invoiceDocs.map((d) => d.orders?.[cfg.partyColumn]),
    ...legacyOrders.map((o: any) => o[cfg.partyColumn]),
  ]
  const orgs = await inChunks(partyIds, async (chunk) => {
    const { data } = await admin.from('organizations').select('id, org_name').in('id', chunk)
    return data || []
  })
  const orgName = new Map<string, string>(orgs.map((o: any) => [o.id, o.org_name]))

  // 7. Build the rows. Money on an order is applied to its invoices oldest first.
  type Raw = Omit<SubledgerInvoice, 'balance'> & { total: number }
  const raws: Raw[] = []
  for (const d of invoiceDocs) {
    const posting = postingByDoc.get(d.id) || postingByDoc.get(d.order_id)
    const journal = posting ? journalById.get(posting.journal_id) : null
    const postedDate = journal?.journal_date || null
    const posted = !!posting && (!asOf || !postedDate || postedDate <= asOf)
    const partyId = d.orders?.[cfg.partyColumn] || ''
    raws.push({
      documentId: d.id,
      documentNo: d.display_doc_no || d.doc_no,
      orderId: d.order_id,
      orderNo: d.orders?.display_doc_no || d.orders?.order_no || '',
      partyId,
      partyName: orgName.get(partyId) || '-',
      documentDate: d.created_at,
      documentStatus: d.status,
      posted,
      postedDate: posted ? postedDate : null,
      journalNumber: posted ? journal?.journal_number || null : null,
      total: orderTotal.get(d.order_id) || 0,
    })
  }
  for (const o of legacyOrders as any[]) {
    const posting = postingByDoc.get(o.id)
    const journal = posting ? journalById.get(posting.journal_id) : null
    const postedDate = journal?.journal_date || null
    if (asOf && postedDate && postedDate > asOf) continue
    const partyId = o[cfg.partyColumn] || ''
    raws.push({
      documentId: o.id,
      documentNo: o.display_doc_no || o.order_no,
      orderId: o.id,
      orderNo: o.display_doc_no || o.order_no,
      partyId,
      partyName: orgName.get(partyId) || '-',
      documentDate: o.created_at,
      documentStatus: o.status,
      posted: true,
      postedDate,
      journalNumber: journal?.journal_number || null,
      total: orderTotal.get(o.id) || 0,
    })
  }

  const pool = new Map(settledByOrder)
  const invoices: SubledgerInvoice[] = raws.map(({ total, ...rest }) => {
    const available = pool.get(rest.orderId) || 0
    const settled = Math.min(available, total)
    pool.set(rest.orderId, available - settled)
    return { ...rest, balance: invoiceBalance({ total, settled, posted: rest.posted }) }
  })

  return { invoices, error: null }
}

export interface AgingInvoiceLine {
  documentId: string
  documentNo: string
  orderNo: string
  invoiceDate: string | null
  days: number | null
  bucket: AgingBucket | null
  total: number
  settled: number
  outstanding: number
  advance: number
  posted: boolean
}

export interface AgingReportRow extends AgingRow {
  invoices: AgingInvoiceLine[]
}

/**
 * Aging of open AR / AP as of a date, by party, from posted invoices and the money
 * actually received / paid. Advances on invoices not posted yet are shown apart.
 */
export async function loadAgingReport(
  admin: any,
  opts: { companyId: string; side: SubledgerSide; asOf: string },
): Promise<{ rows: AgingReportRow[]; totals: Omit<AgingRow, 'partyId' | 'partyName'>; error: string | null }> {
  const { invoices, error } = await loadSubledger(admin, opts)
  const { rows, totals } = buildAging(
    invoices.map((i) => ({
      partyId: i.partyId || 'unknown',
      partyName: i.partyName,
      invoiceDate: i.postedDate,
      outstanding: i.balance.outstanding,
      unappliedAdvance: i.balance.unappliedAdvance,
    })),
    opts.asOf,
  )
  const linesByParty = new Map<string, AgingInvoiceLine[]>()
  for (const i of invoices) {
    if (i.balance.outstanding <= 0 && i.balance.unappliedAdvance <= 0) continue
    const days = i.posted && i.postedDate ? daysBetween(i.postedDate, opts.asOf) : null
    const line: AgingInvoiceLine = {
      documentId: i.documentId,
      documentNo: i.documentNo,
      orderNo: i.orderNo,
      invoiceDate: i.postedDate,
      days,
      bucket: days === null ? null : agingBucket(days),
      total: i.balance.total,
      settled: i.balance.settled,
      outstanding: i.balance.outstanding,
      advance: i.balance.unappliedAdvance,
      posted: i.posted,
    }
    const key = i.partyId || 'unknown'
    linesByParty.set(key, [...(linesByParty.get(key) || []), line])
  }
  return {
    rows: rows.map((r) => ({
      ...r,
      invoices: (linesByParty.get(r.partyId) || []).sort((a, b) => (b.days ?? -1) - (a.days ?? -1)),
    })),
    totals,
    error,
  }
}
