import { createHash } from 'node:crypto'
import type { XlsxSheet } from './xlsx-lite'

/**
 * Parsers for TikTok Shop Seller Center exports (Malaysia, times in UTC+8):
 *  - orders file: sheet "OrderSKUList", one line per order and SKU, row 2 holds column descriptions
 *  - transaction file: sheet "Order details" (settlements), "Withdrawal records" and "Reports" (totals)
 *
 * Columns are found by header name. Customer personal data (buyer, recipient,
 * phone, address, postcode, messages, notes, tracking number, customer's bank)
 * is never read into the result.
 */

export type TikTokFileKind = 'orders' | 'settlements'

export interface ParseResult<T> {
  errors: string[]
  warnings: string[]
  value: T | null
}

export interface TikTokOrderLine {
  orderId: string
  skuId: string
  contentHash: string
  row: Record<string, string | number | null>
}

export interface TikTokOrdersFile {
  lines: TikTokOrderLine[]
  orderIds: string[]
  periodStart: string | null
  periodEnd: string | null
}

export interface TikTokSettlement {
  dedupeKey: string
  recordId: string
  settledDate: string | null
  totalSettlementCents: number
  row: Record<string, unknown>
}

export interface TikTokPayout {
  referenceId: string
  transactionType: string
  amountCents: number
  row: Record<string, string | null>
}

export interface TikTokSettlementsFile {
  settlements: TikTokSettlement[]
  payouts: TikTokPayout[]
  periodStart: string | null
  periodEnd: string | null
  currency: string | null
  totalSettlementCents: number
  reportTotalCents: number | null
}

const MAX_ERRORS = 10

export function normalizeHeader(header: string) {
  return header
    .toLowerCase()
    .replace(/instalment/g, 'installment')
    .replace(/programme/g, 'program')
    .replace(/cancellation/g, 'cancelation')
    .replace(/gmv max voucher/g, 'gmv max coupon')
    .replace(/parcel weight/g, 'package weight')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export function centsToAmount(cents: number) {
  const abs = Math.abs(cents)
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

function parseMoneyCents(value: string): number | null | 'invalid' {
  const v = value.replace(/,/g, '').trim()
  if (!v) return null
  if (!/^-?\d+(\.\d+)?$/.test(v)) return 'invalid'
  return Math.round(Number(v) * 100)
}

const looksExcelMangled = (value: string) => /^\d(\.\d+)?e\+?\d+$/i.test(value.trim())

function findSheet(sheets: XlsxSheet[], name: string, requiredHeader: string) {
  return sheets.find(s => s.name.trim().toLowerCase() === name.toLowerCase())
    || sheets.find(s => (s.rows[0] || []).some(h => normalizeHeader(h) === requiredHeader))
}

export function detectTikTokFile(sheets: XlsxSheet[]): TikTokFileKind | null {
  const orders = findSheet(sheets, 'OrderSKUList', 'order_id')
  if (orders && (orders.rows[0] || []).some(h => normalizeHeader(h) === 'sku_id')) return 'orders'
  if (findSheet(sheets, 'Order details', 'order_adjustment_id')) return 'settlements'
  return null
}

function headerIndex(header: string[]) {
  const map = new Map<string, number>()
  header.forEach((h, i) => {
    const key = normalizeHeader(h)
    if (key && !map.has(key)) map.set(key, i)
  })
  return map
}

// ── Orders file ───────────────────────────────────────────────────────

const ORDER_TEXT: Record<string, string> = {
  order_status: 'order_status',
  order_substatus: 'order_substatus',
  cancel_return_type: 'cancelation_return_type',
  normal_or_preorder: 'normal_or_pre_order',
  seller_sku: 'seller_sku',
  product_name: 'product_name',
  variation: 'variation',
  cancel_by: 'cancel_by',
  cancel_reason: 'cancel_reason',
  fulfillment_type: 'fulfillment_type',
  warehouse_name: 'warehouse_name',
  delivery_option: 'delivery_option',
  shipping_provider: 'shipping_provider_name',
  payment_method: 'payment_method',
  product_category: 'product_category',
  package_id: 'package_id',
  purchase_channel: 'purchase_channel',
  order_channel: 'order_channel',
  creator_handle: 'creator_handle',
  buyer_state: 'state',
  buyer_country: 'country',
}

const ORDER_MONEY: Record<string, string> = {
  unit_original_price: 'sku_unit_original_price',
  subtotal_before_discount: 'sku_subtotal_before_discount',
  platform_discount: 'sku_platform_discount',
  seller_discount: 'sku_seller_discount',
  subtotal_after_discount: 'sku_subtotal_after_discount',
  shipping_fee_after_discount: 'shipping_fee_after_discount',
  original_shipping_fee: 'original_shipping_fee',
  shipping_fee_seller_discount: 'shipping_fee_seller_discount',
  shipping_fee_platform_discount: 'shipping_fee_platform_discount',
  payment_platform_discount: 'payment_platform_discount',
  taxes: 'taxes',
  order_amount: 'order_amount',
  order_refund_amount: 'order_refund_amount',
}

const ORDER_TIMES: Record<string, string> = {
  created_time: 'created_time',
  paid_time: 'paid_time',
  rts_time: 'rts_time',
  shipped_time: 'shipped_time',
  delivered_time: 'delivered_time',
  cancelled_time: 'cancelled_time',
}

const REQUIRED_ORDER_HEADERS = ['order_id', 'order_status', 'sku_id', 'quantity', 'created_time', 'order_amount']

/** "30/09/2026 22:58:49" (UTC+8) → ISO timestamp with offset. */
export function parseTikTokTime(value: string): string | null | 'invalid' {
  const v = value.trim()
  if (!v) return null
  const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!m) return 'invalid'
  const [, d, mo, y, h, mi, s = '00'] = m
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31 || Number(h) > 23 || Number(mi) > 59) return 'invalid'
  return `${y}-${mo}-${d}T${h}:${mi}:${s}+08:00`
}

/** "2026/09/30" (optionally with a time) → "2026-09-30". */
export function parseTikTokDate(value: string): string | null | 'invalid' {
  const v = value.trim()
  if (!v) return null
  const m = v.match(/^(\d{4})[/-](\d{2})[/-](\d{2})(?:\s+\d{2}:\d{2}(?::\d{2})?)?$/)
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[3]) < 1 || Number(m[3]) > 31) return 'invalid'
  return `${m[1]}-${m[2]}-${m[3]}`
}

function hashRow(row: Record<string, unknown>) {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex')
}

export function parseTikTokOrders(sheets: XlsxSheet[]): ParseResult<TikTokOrdersFile> {
  const errors: string[] = []
  const warnings: string[] = []
  const fail = (msg: string) => { if (errors.length < MAX_ERRORS) errors.push(msg) }
  const sheet = findSheet(sheets, 'OrderSKUList', 'order_id')
  if (!sheet || sheet.rows.length === 0) return { errors: ['This is not a TikTok Shop orders file (sheet "OrderSKUList" not found).'], warnings, value: null }

  const idx = headerIndex(sheet.rows[0])
  const missing = REQUIRED_ORDER_HEADERS.filter(h => !idx.has(h))
  if (missing.length) return { errors: [`Missing column(s): ${missing.join(', ')}. Download the orders file again from TikTok Seller Center.`], warnings, value: null }
  const cell = (r: string[], key: string) => (idx.has(key) ? (r[idx.get(key)!] ?? '').trim() : '')

  const lines: TikTokOrderLine[] = []
  const seen = new Set<string>()
  let dates: string[] = []
  sheet.rows.slice(1).forEach((r, i) => {
    const rowNo = i + 2
    if (!r.some(v => v.trim())) return
    const orderId = cell(r, 'order_id')
    if (rowNo === 2 && !looksExcelMangled(orderId) && /[a-z]{3}/i.test(orderId)) return
    if (looksExcelMangled(orderId)) { fail(`Row ${rowNo}: the order ID was changed by Excel (${orderId}). Use the file exactly as downloaded from TikTok.`); return }
    if (!/^\d{6,30}$/.test(orderId)) { fail(`Row ${rowNo}: invalid order ID "${orderId.slice(0, 40)}".`); return }
    const skuId = cell(r, 'sku_id')
    if (skuId && !/^\d{1,30}$/.test(skuId)) { fail(`Row ${rowNo}: invalid SKU ID "${skuId.slice(0, 40)}".`); return }
    const key = `${orderId}|${skuId}`
    if (seen.has(key)) { fail(`Row ${rowNo}: order ${orderId} lists the same SKU twice.`); return }
    seen.add(key)

    const row: Record<string, string | number | null> = {}
    for (const [field, header] of Object.entries(ORDER_TEXT)) row[field] = cell(r, header) || null
    for (const [field, header] of Object.entries(ORDER_MONEY)) {
      const cents = parseMoneyCents(cell(r, header))
      if (cents === 'invalid') { fail(`Row ${rowNo}: "${header}" is not a number.`); return }
      row[field] = cents === null ? null : centsToAmount(cents)
    }
    for (const [field, header] of Object.entries(ORDER_TIMES)) {
      const t = parseTikTokTime(cell(r, header))
      if (t === 'invalid') { fail(`Row ${rowNo}: "${header}" is not a date (expected DD/MM/YYYY HH:MM:SS).`); return }
      row[field] = t
    }
    const qty = cell(r, 'quantity')
    const ret = cell(r, 'sku_quantity_of_return')
    if (!/^\d+$/.test(qty) || (ret && !/^\d+$/.test(ret))) { fail(`Row ${rowNo}: quantity is not a whole number.`); return }
    row.quantity = Number(qty)
    row.return_quantity = ret ? Number(ret) : 0
    const weight = cell(r, 'weight_kg')
    row.weight_kg = /^\d+(\.\d+)?$/.test(weight) ? weight : null
    if (!row.created_time) { fail(`Row ${rowNo}: created time is empty.`); return }
    dates.push(String(row.created_time).slice(0, 10))
    lines.push({ orderId, skuId, contentHash: hashRow(row), row })
  })

  if (!errors.length && lines.length === 0) errors.push('The orders file has no order lines.')
  dates = dates.sort()
  return {
    errors,
    warnings,
    value: errors.length ? null : {
      lines,
      orderIds: [...new Set(lines.map(l => l.orderId))],
      periodStart: dates[0] ?? null,
      periodEnd: dates[dates.length - 1] ?? null,
    },
  }
}

// ── Transaction (settlement) file ─────────────────────────────────────

const SETTLEMENT_MONEY: Record<string, string> = {
  total_settlement_amount: 'total_settlement_amount',
  total_revenue: 'total_revenue',
  total_fees: 'total_fees',
  subtotal_before_discounts: 'subtotal_before_discounts',
  seller_discounts: 'seller_discounts',
  subtotal_after_seller_discounts: 'subtotal_after_seller_discounts',
  refund_subtotal_after_seller_discounts: 'refund_subtotal_after_seller_discounts',
  customer_payment: 'customer_payment',
  customer_refund: 'customer_refund',
  adjustment_amount: 'adjustment_amount',
}

const SETTLEMENT_NOT_FEES = new Set([
  'order_adjustment_id', 'transaction_type', 'order_created_time', 'order_settled_time', 'currency',
  'related_order_id', 'details_of_items_sold', 'customer_s_bank_for_payment',
  ...Object.values(SETTLEMENT_MONEY),
])

function reportValue(sheet: XlsxSheet | undefined, label: string) {
  if (!sheet) return null
  for (const r of sheet.rows) {
    const at = r.findIndex(v => normalizeHeader(v) === label)
    if (at >= 0) return r.slice(at + 1).reverse().find(v => v.trim())?.trim() ?? null
  }
  return null
}

export function parseTikTokSettlements(sheets: XlsxSheet[]): ParseResult<TikTokSettlementsFile> {
  const errors: string[] = []
  const warnings: string[] = []
  const fail = (msg: string) => { if (errors.length < MAX_ERRORS) errors.push(msg) }
  const sheet = findSheet(sheets, 'Order details', 'order_adjustment_id')
  if (!sheet || sheet.rows.length === 0) return { errors: ['This is not a TikTok Shop transaction file (sheet "Order details" not found).'], warnings, value: null }

  const idx = headerIndex(sheet.rows[0])
  const missing = ['order_adjustment_id', 'transaction_type', 'order_settled_time', 'total_settlement_amount'].filter(h => !idx.has(h))
  if (missing.length) return { errors: [`Missing column(s): ${missing.join(', ')}. Download the transaction file again from TikTok Seller Center.`], warnings, value: null }
  const cell = (r: string[], key: string) => (idx.has(key) ? (r[idx.get(key)!] ?? '').trim() : '')
  const feeColumns = [...idx.entries()].filter(([key]) => !SETTLEMENT_NOT_FEES.has(key) && !key.endsWith('_weight'))

  const settlements: TikTokSettlement[] = []
  const occurrences = new Map<string, number>()
  let total = 0
  const settledDates: string[] = []
  sheet.rows.slice(1).forEach((r, i) => {
    const rowNo = i + 2
    if (!r.some(v => v.trim())) return
    const recordId = cell(r, 'order_adjustment_id')
    if (looksExcelMangled(recordId)) { fail(`Row ${rowNo}: the order ID was changed by Excel (${recordId}). Use the file exactly as downloaded from TikTok.`); return }
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(recordId)) { fail(`Row ${rowNo}: invalid order/adjustment ID "${recordId.slice(0, 40)}".`); return }
    const type = cell(r, 'transaction_type')
    if (!type) { fail(`Row ${rowNo}: transaction type is empty.`); return }
    const settled = parseTikTokDate(cell(r, 'order_settled_time'))
    const created = parseTikTokDate(cell(r, 'order_created_time'))
    if (settled === 'invalid' || created === 'invalid') { fail(`Row ${rowNo}: a date is not in YYYY/MM/DD format.`); return }

    const row: Record<string, unknown> = {
      record_id: recordId,
      transaction_type: type,
      related_order_id: cell(r, 'related_order_id') || null,
      order_created_date: created,
      settled_date: settled,
      currency: cell(r, 'currency') || null,
      items_sold: cell(r, 'details_of_items_sold') || null,
    }
    for (const [field, header] of Object.entries(SETTLEMENT_MONEY)) {
      const cents = parseMoneyCents(cell(r, header))
      if (cents === 'invalid') { fail(`Row ${rowNo}: "${header}" is not a number.`); return }
      row[field] = cents === null ? null : centsToAmount(cents)
    }
    const fees: Record<string, number> = {}
    for (const [key, col] of feeColumns) {
      const cents = parseMoneyCents((r[col] ?? '').trim())
      if (cents === 'invalid') { fail(`Row ${rowNo}: "${key}" is not a number.`); return }
      if (cents) fees[key] = cents / 100
    }
    row.fee_breakdown = fees

    const cents = parseMoneyCents(cell(r, 'total_settlement_amount'))
    const totalCents = typeof cents === 'number' ? cents : 0
    const base = `${recordId}|${type}|${settled ?? ''}`
    const n = (occurrences.get(base) ?? 0) + 1
    occurrences.set(base, n)
    total += totalCents
    if (settled) settledDates.push(settled)
    settlements.push({ dedupeKey: `${base}|${n}`, recordId, settledDate: settled, totalSettlementCents: totalCents, row })
  })

  const payouts: TikTokPayout[] = []
  const withdrawals = sheets.find(s => s.name.trim().toLowerCase() === 'withdrawal records')
  if (withdrawals && withdrawals.rows.length > 0) {
    const w = headerIndex(withdrawals.rows[0])
    const wc = (r: string[], key: string) => (w.has(key) ? (r[w.get(key)!] ?? '').trim() : '')
    const seen = new Set<string>()
    withdrawals.rows.slice(1).forEach((r, i) => {
      const rowNo = i + 2
      if (!r.some(v => v.trim())) return
      const referenceId = wc(r, 'reference_id')
      const type = wc(r, 'transaction_type')
      if (looksExcelMangled(referenceId) || !/^[A-Za-z0-9_-]{4,40}$/.test(referenceId)) { fail(`Withdrawal records row ${rowNo}: invalid reference ID.`); return }
      const amount = parseMoneyCents(wc(r, 'amount'))
      const requested = parseTikTokDate(wc(r, 'request_time'))
      const succeeded = parseTikTokDate(wc(r, 'success_time'))
      if (amount === 'invalid' || amount === null) { fail(`Withdrawal records row ${rowNo}: amount is not a number.`); return }
      if (requested === 'invalid' || succeeded === 'invalid') { fail(`Withdrawal records row ${rowNo}: a date is not in YYYY/MM/DD format.`); return }
      const key = `${referenceId}|${type}`
      if (seen.has(key)) { fail(`Withdrawal records row ${rowNo}: reference ${referenceId} appears twice.`); return }
      seen.add(key)
      payouts.push({
        referenceId,
        transactionType: type,
        amountCents: amount,
        row: { reference_id: referenceId, transaction_type: type, request_date: requested, amount: centsToAmount(amount), status: wc(r, 'status') || null, success_date: succeeded },
      })
    })
  } else {
    warnings.push('No "Withdrawal records" sheet: only settlements will be imported.')
  }

  const reports = sheets.find(s => s.name.trim().toLowerCase() === 'reports')
  const reportTotalRaw = reportValue(reports, 'total_settlement_amount')
  const reportTotal = reportTotalRaw === null ? null : parseMoneyCents(reportTotalRaw)
  const period = reportValue(reports, 'time_period')?.match(/^(\d{4}\/\d{2}\/\d{2})\s*-\s*(\d{4}\/\d{2}\/\d{2})$/)
  if (typeof reportTotal === 'number') {
    if (!errors.length && reportTotal !== total) {
      errors.push(`The order rows add up to ${centsToAmount(total)}, but the file's report total is ${centsToAmount(reportTotal)}. The file may be incomplete or edited; download it again.`)
    }
  } else {
    warnings.push('The "Reports" sheet with the total settlement amount was not found, so the file total could not be checked.')
  }
  if (!errors.length && settlements.length === 0 && payouts.length === 0) errors.push('The transaction file has no rows.')

  const sorted = settledDates.sort()
  return {
    errors,
    warnings,
    value: errors.length ? null : {
      settlements,
      payouts,
      periodStart: period ? (parseTikTokDate(period[1]) as string) : sorted[0] ?? null,
      periodEnd: period ? (parseTikTokDate(period[2]) as string) : sorted[sorted.length - 1] ?? null,
      currency: reportValue(reports, 'currency'),
      totalSettlementCents: total,
      reportTotalCents: typeof reportTotal === 'number' ? reportTotal : null,
    },
  }
}
