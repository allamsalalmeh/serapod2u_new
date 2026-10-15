/**
 * TikTok Shop reports (sales, settlement, shipping) for a day, week or month,
 * built from the marketplace tables. Pure functions: the server loader
 * (tiktok-reports-server.ts) fetches the rows, these turn them into numbers.
 *
 * Money is added up in cents so totals match TikTok to the sen. Periods are
 * Malaysia calendar days; weeks start on Monday.
 */

export type ReportKind = 'sales' | 'settlement' | 'shipping'
export type ReportPeriod = 'day' | 'week' | 'month'

export const REPORT_KINDS: ReportKind[] = ['sales', 'settlement', 'shipping']
export const REPORT_PERIODS: ReportPeriod[] = ['day', 'week', 'month']

const MYT_MS = 8 * 3600 * 1000
const DAY_MS = 86400 * 1000
const HOUR_MS = 3600 * 1000
const TO_SHIP = 'To ship'
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// ── Small helpers ─────────────────────────────────────────────────────

const cents = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}
const rm = (c: number) => Math.round(c) / 100
const isCancelled = (status: unknown) => /^cancel/i.test(String(status || ''))
const isUnpaid = (status: unknown) => /^unpaid/i.test(String(status || ''))
const ts = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : null
}

export function mytDay(value: Date | number): string {
  return new Date(Number(value) + MYT_MS).toISOString().slice(0, 10)
}
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}
/** UTC instant (ms) of Malaysia midnight starting `date`. */
export function mytMidnight(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) - MYT_MS
}
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)

export function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const round1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10)
const change = (current: number, previous: number) => (previous ? (current - previous) / Math.abs(previous) : null)

function dayLabel(date: string) {
  const d = new Date(`${date}T00:00:00Z`)
  return `${WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}`
}
function shortDate(date: string, withYear = false) {
  const d = new Date(`${date}T00:00:00Z`)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)}${withYear ? ` ${d.getUTCFullYear()}` : ''}`
}

// ── Periods ───────────────────────────────────────────────────────────

export interface PeriodRange {
  period: ReportPeriod
  /** First day and the day after the last day (YYYY-MM-DD). */
  start: string
  end: string
  label: string
  compareLabel: string
  isCurrent: boolean
  /** Instants of the period and of the comparable part of the previous period. */
  startIso: string
  endIso: string
  prevStartIso: string
  prevCutoffIso: string
  prevDate: string
  nextDate: string | null
}

export function periodRange(period: ReportPeriod, date: string, now: Date = new Date()): PeriodRange {
  const today = mytDay(now.getTime())
  let start: string
  let end: string
  let prevStart: string
  if (period === 'day') {
    start = date
    end = addDays(date, 1)
    prevStart = addDays(date, -1)
  } else if (period === 'week') {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
    start = addDays(date, -((dow + 6) % 7))
    end = addDays(start, 7)
    prevStart = addDays(start, -7)
  } else {
    const [y, m] = date.split('-').map(Number)
    start = `${y}-${String(m).padStart(2, '0')}-01`
    end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
    prevStart = m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`
  }

  const isCurrent = start <= today && today < end
  const cutoff = Math.min(mytMidnight(end), now.getTime())
  const elapsed = Math.max(0, cutoff - mytMidnight(start))
  const prevCutoff = Math.min(mytMidnight(prevStart) + elapsed, mytMidnight(start))

  let label: string
  if (period === 'day') label = dayLabel(start)
  else if (period === 'week') {
    const last = addDays(end, -1)
    const sameYear = start.slice(0, 4) === last.slice(0, 4)
    label = start.slice(0, 7) === last.slice(0, 7)
      ? `${Number(start.slice(8))} – ${shortDate(last, true)}`
      : `${shortDate(start, !sameYear)} – ${shortDate(last, true)}`
  } else label = `${MONTHS[Number(start.slice(5, 7)) - 1]} ${start.slice(0, 4)}`

  const compareLabel = period === 'day'
    ? (isCurrent ? 'vs same time yesterday' : 'vs previous day')
    : period === 'week'
      ? (isCurrent ? 'vs same point last week' : 'vs previous week')
      : (isCurrent ? 'vs same point last month' : 'vs previous month')

  return {
    period,
    start,
    end,
    label,
    compareLabel,
    isCurrent,
    startIso: new Date(mytMidnight(start)).toISOString(),
    endIso: new Date(mytMidnight(end)).toISOString(),
    prevStartIso: new Date(mytMidnight(prevStart)).toISOString(),
    prevCutoffIso: new Date(prevCutoff).toISOString(),
    prevDate: prevStart,
    nextDate: end <= today ? end : null,
  }
}

export interface ReportShop { id: string; name: string }

const inRange = (iso: string | null | undefined, fromIso: string, toIso: string) => {
  const t = ts(iso)
  return t !== null && t >= Date.parse(fromIso) && t < Date.parse(toIso)
}

// ── Sales ─────────────────────────────────────────────────────────────

export interface SalesLine {
  shop_id: string
  order_id: string
  product_name: string | null
  seller_sku: string | null
  order_status: string | null
  quantity: number | string | null
  subtotal_after_discount: number | string | null
  created_time: string | null
}

export interface SalesTotals { sales: number; orders: number; items: number; aov: number; cancelled: number }

function salesTotals(lines: SalesLine[]): SalesTotals {
  const sold = lines.filter(l => !isCancelled(l.order_status) && !isUnpaid(l.order_status))
  const salesCents = sold.reduce((s, l) => s + cents(l.subtotal_after_discount), 0)
  const orders = new Set(sold.map(l => `${l.shop_id}|${l.order_id}`)).size
  return {
    sales: rm(salesCents),
    orders,
    items: sold.reduce((s, l) => s + (Number(l.quantity) || 0), 0),
    aov: orders ? rm(salesCents / orders) : 0,
    cancelled: new Set(lines.filter(l => isCancelled(l.order_status)).map(l => `${l.shop_id}|${l.order_id}`)).size,
  }
}

export interface ProductRow { product: string; sku: string | null; items: number; sales: number }
export interface TrendPoint { key: string; label: string; sales: number; orders: number }

export interface SalesReport {
  kind: 'sales'
  totals: SalesTotals
  previous: SalesTotals
  change: { sales: number | null; orders: number | null; items: number | null; aov: number | null }
  cancelRate: number | null
  trend: TrendPoint[]
  topProducts: ProductRow[]
  lowProducts: ProductRow[]
  shops: { shop: string; sales: number; orders: number; items: number; cancelled: number }[]
}

function hourLabel(h: number) {
  return `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`
}

export function buildSalesReport(input: { range: PeriodRange; shops: ReportShop[]; lines: SalesLine[]; now?: Date }): SalesReport {
  const { range } = input
  const now = (input.now ?? new Date()).getTime()
  const current = input.lines.filter(l => inRange(l.created_time, range.startIso, range.endIso))
  const prev = input.lines.filter(l => inRange(l.created_time, range.prevStartIso, range.prevCutoffIso))
  const totals = salesTotals(current)
  const previous = salesTotals(prev)
  const sold = current.filter(l => !isCancelled(l.order_status) && !isUnpaid(l.order_status))

  const buckets: (TrendPoint & { orderSet: Set<string>; cents: number })[] = []
  const lastTs = Math.min(Date.parse(range.endIso), now)
  if (range.period === 'day') {
    for (let h = 0; h < 24; h++) {
      if (Date.parse(range.startIso) + h * HOUR_MS > lastTs) break
      buckets.push({ key: String(h), label: hourLabel(h), sales: 0, orders: 0, orderSet: new Set(), cents: 0 })
    }
  } else {
    for (let d = range.start; d < range.end; d = addDays(d, 1)) {
      if (mytMidnight(d) > lastTs) break
      const date = new Date(`${d}T00:00:00Z`)
      buckets.push({
        key: d,
        label: range.period === 'week' ? `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()}` : String(date.getUTCDate()),
        sales: 0, orders: 0, orderSet: new Set(), cents: 0,
      })
    }
  }
  const bucketOf = new Map(buckets.map(b => [b.key, b]))
  for (const l of sold) {
    const t = ts(l.created_time)!
    const key = range.period === 'day' ? String(new Date(t + MYT_MS).getUTCHours()) : mytDay(t)
    const b = bucketOf.get(key)
    if (!b) continue
    b.cents += cents(l.subtotal_after_discount)
    b.orderSet.add(`${l.shop_id}|${l.order_id}`)
  }

  const products = new Map<string, ProductRow & { cents: number }>()
  for (const l of sold) {
    const name = (l.product_name || l.seller_sku || 'Unnamed product').trim()
    const p = products.get(name) || { product: name, sku: l.seller_sku, items: 0, sales: 0, cents: 0 }
    p.items += Number(l.quantity) || 0
    p.cents += cents(l.subtotal_after_discount)
    products.set(name, p)
  }
  const productRows = [...products.values()].map(({ cents: c, ...p }) => ({ ...p, sales: rm(c) }))
  const topProducts = [...productRows].sort((a, b) => b.sales - a.sales || b.items - a.items).slice(0, 5)
  const topNames = new Set(topProducts.map(p => p.product))
  const lowProducts = productRows.filter(p => !topNames.has(p.product)).sort((a, b) => a.items - b.items || a.sales - b.sales).slice(0, 5)

  const placed = totals.orders + totals.cancelled
  return {
    kind: 'sales',
    totals,
    previous,
    change: {
      sales: change(totals.sales, previous.sales),
      orders: change(totals.orders, previous.orders),
      items: change(totals.items, previous.items),
      aov: change(totals.aov, previous.aov),
    },
    cancelRate: placed ? totals.cancelled / placed : null,
    trend: buckets.map(({ orderSet, cents: c, ...b }) => ({ ...b, sales: rm(c), orders: orderSet.size })),
    topProducts,
    lowProducts,
    shops: input.shops.length > 1
      ? input.shops.map(s => {
        const t = salesTotals(current.filter(l => l.shop_id === s.id))
        return { shop: s.name, sales: t.sales, orders: t.orders, items: t.items, cancelled: t.cancelled }
      })
      : [],
  }
}

// ── Settlement ────────────────────────────────────────────────────────

export interface SettlementRow {
  shop_id: string
  transaction_type: string | null
  related_order_id: string | null
  settled_date: string | null
  total_settlement_amount: number | string | null
  total_revenue: number | string | null
  total_fees: number | string | null
  customer_refund: number | string | null
  fee_breakdown: Record<string, unknown> | null
}

export interface PayoutRow {
  shop_id: string
  reference_id: string
  transaction_type: string | null
  request_date: string | null
  amount: number | string | null
  status: string | null
}

export interface UnsettledRow {
  shop_id: string
  order_id: string | null
  reason: string | null
  est_settlement: number | string | null
  synced_at: string | null
}

export interface OrderTiming { shop_id: string; order_id: string; created_time: string | null; delivered_time: string | null }

export interface WaterfallLine { key: string; label: string; amount: number }

export interface SettlementReport {
  kind: 'settlement'
  revenue: number
  deductions: number
  net: number
  paidToBank: number
  ordersSettled: number
  refunds: number
  waterfall: WaterfallLine[]
  withdrawals: { shop: string; date: string; amount: number; status: string | null; reference: string }[]
  balances: { shop: string; lastWithdrawal: string | null; settledSince: number }[]
  pending: { orders: number; amount: number; reasons: { reason: string; orders: number; amount: number }[]; syncedAt: string | null }
  timing: { orders: number; deliveryToSettledDays: number | null; orderToSettledDays: number | null }
  shops: { shop: string; revenue: number; deductions: number; net: number; paidToBank: number; pending: number }[]
}

const fee = (row: SettlementRow, ...keys: string[]) => keys.reduce((s, k) => s + cents(row.fee_breakdown?.[k]), 0)
const isWithdrawal = (p: PayoutRow) => /withdraw/i.test(String(p.transaction_type || '')) && !/fail/i.test(String(p.status || ''))
const isEarning = (p: PayoutRow) => /earning/i.test(String(p.transaction_type || ''))

function settlementTotals(rows: SettlementRow[]) {
  const t = { revenue: 0, fees: 0, net: 0, commission: 0, transaction: 0, shipping: 0, affiliate: 0, ads: 0, refunds: 0 }
  for (const r of rows) {
    t.revenue += cents(r.total_revenue)
    t.fees += cents(r.total_fees)
    t.net += cents(r.total_settlement_amount)
    t.commission += fee(r, 'tiktok_shop_commission_fee')
    t.transaction += fee(r, 'transaction_fee')
    t.shipping += fee(r, 'seller_shipping_fee')
    t.affiliate += fee(r, 'affiliate_commission', 'affiliate_ads_commission')
    t.ads += fee(r, 'gmv_max_ad_fee')
    t.refunds += Math.abs(cents(r.customer_refund))
  }
  return t
}

/**
 * Gross revenue → each fee group → net settlement. "Service fees & other" is
 * whatever else TikTok deducted in total_fees, and "Adjustments" covers rows
 * that are not orders (ad payments, reserves), so the lines always add up to
 * the settlement TikTok paid.
 */
export function buildSettlementReport(input: {
  range: PeriodRange
  shops: ReportShop[]
  settlements: SettlementRow[]
  payouts: PayoutRow[]
  unsettled: UnsettledRow[]
  timings: OrderTiming[]
}): SettlementReport {
  const { range } = input
  const shopName = new Map(input.shops.map(s => [s.id, s.name]))
  const rows = input.settlements.filter(r => r.settled_date && r.settled_date >= range.start && r.settled_date < range.end)
  const t = settlementTotals(rows)
  const otherFees = t.fees - t.commission - t.transaction - t.shipping - t.affiliate - t.ads
  const adjustments = t.net - t.revenue - t.fees

  const withdrawalsInPeriod = input.payouts
    .filter(p => isWithdrawal(p) && p.request_date && p.request_date >= range.start && p.request_date < range.end)
    .sort((a, b) => String(b.request_date).localeCompare(String(a.request_date)))
  const paidToBank = withdrawalsInPeriod.reduce((s, p) => s + Math.abs(cents(p.amount)), 0)

  const balances = input.shops.map(s => {
    const mine = input.payouts.filter(p => p.shop_id === s.id)
    const last = mine.filter(isWithdrawal).map(p => String(p.request_date || '')).filter(Boolean).sort().pop() || null
    const since = mine.filter(p => isEarning(p) && p.request_date && (!last || p.request_date > last)).reduce((sum, p) => sum + cents(p.amount), 0)
    return { shop: s.name, lastWithdrawal: last, settledSince: rm(since) }
  })

  const pendingRows = input.unsettled
  const reasons = new Map<string, { reason: string; orders: Set<string>; cents: number }>()
  for (const u of pendingRows) {
    const reason = u.reason || 'Not settled yet'
    const entry = reasons.get(reason) || { reason, orders: new Set<string>(), cents: 0 }
    entry.orders.add(`${u.shop_id}|${u.order_id}`)
    entry.cents += cents(u.est_settlement)
    reasons.set(reason, entry)
  }
  const syncTimes = pendingRows.map(u => u.synced_at).filter(Boolean).sort() as string[]

  const timingOf = new Map(input.timings.map(o => [`${o.shop_id}|${o.order_id}`, o]))
  const toSettled: number[] = []
  const fromOrder: number[] = []
  const settledOrders = new Set<string>()
  for (const r of rows) {
    if (!/^order$/i.test(String(r.transaction_type || '')) || !r.related_order_id) continue
    const key = `${r.shop_id}|${r.related_order_id}`
    if (settledOrders.has(key)) continue
    settledOrders.add(key)
    const o = timingOf.get(key)
    const delivered = ts(o?.delivered_time)
    const created = ts(o?.created_time)
    if (delivered !== null) toSettled.push(daysBetween(mytDay(delivered), r.settled_date!))
    if (created !== null) fromOrder.push(daysBetween(mytDay(created), r.settled_date!))
  }

  return {
    kind: 'settlement',
    revenue: rm(t.revenue),
    deductions: rm(t.net - t.revenue),
    net: rm(t.net),
    paidToBank: rm(paidToBank),
    ordersSettled: settledOrders.size,
    refunds: rm(t.refunds),
    waterfall: [
      { key: 'revenue', label: 'Gross revenue', amount: rm(t.revenue) },
      { key: 'commission', label: 'TikTok commission', amount: rm(t.commission) },
      { key: 'transaction', label: 'Transaction fee', amount: rm(t.transaction) },
      { key: 'shipping', label: 'Shipping (net)', amount: rm(t.shipping) },
      { key: 'affiliate', label: 'Affiliate commission', amount: rm(t.affiliate) },
      { key: 'ads', label: 'Ads (GMV Max)', amount: rm(t.ads) },
      { key: 'other_fees', label: 'Service fees & other', amount: rm(otherFees) },
      { key: 'adjustments', label: 'Adjustments & ad payments', amount: rm(adjustments) },
    ],
    withdrawals: withdrawalsInPeriod.map(p => ({
      shop: shopName.get(p.shop_id) || '',
      date: String(p.request_date),
      amount: rm(Math.abs(cents(p.amount))),
      status: p.status,
      reference: p.reference_id,
    })),
    balances,
    pending: {
      orders: new Set(pendingRows.map(u => `${u.shop_id}|${u.order_id}`)).size,
      amount: rm(pendingRows.reduce((s, u) => s + cents(u.est_settlement), 0)),
      reasons: [...reasons.values()].map(r => ({ reason: r.reason, orders: r.orders.size, amount: rm(r.cents) })).sort((a, b) => b.amount - a.amount),
      syncedAt: syncTimes[0] ?? null,
    },
    timing: { orders: toSettled.length, deliveryToSettledDays: round1(median(toSettled)), orderToSettledDays: round1(median(fromOrder)) },
    shops: input.shops.length > 1
      ? input.shops.map(s => {
        const st = settlementTotals(rows.filter(r => r.shop_id === s.id))
        return {
          shop: s.name,
          revenue: rm(st.revenue),
          deductions: rm(st.net - st.revenue),
          net: rm(st.net),
          paidToBank: rm(withdrawalsInPeriod.filter(p => p.shop_id === s.id).reduce((sum, p) => sum + Math.abs(cents(p.amount)), 0)),
          pending: rm(pendingRows.filter(u => u.shop_id === s.id).reduce((sum, u) => sum + cents(u.est_settlement), 0)),
        }
      })
      : [],
  }
}

// ── Shipping ──────────────────────────────────────────────────────────

export interface ShippingLine {
  shop_id: string
  order_id: string
  order_status: string | null
  order_substatus: string | null
  shipping_provider: string | null
  tracking_number: string | null
  quantity: number | string | null
  created_time: string | null
  paid_time: string | null
  shipped_time: string | null
  delivered_time: string | null
  cancelled_time: string | null
}

export interface ShippedOrder {
  shop: string
  orderId: string
  shippedAt: string
  courier: string | null
  tracking: string | null
  status: string | null
  hoursToShip: number | null
  deliveredAt: string | null
}

export interface ShippingReport {
  kind: 'shipping'
  shipped: number
  delivered: number
  cancelled: number
  toPack: number
  toPackLate: number
  within24h: number | null
  speed: { within24: number; within48: number; over48: number; medianHours: number | null }
  deliveryDays: number | null
  couriers: { courier: string; shipped: number; delivered: number; medianDeliveryDays: number | null }[]
  money: { buyerPaid: number; subsidy: number; courierCost: number; returns: number; other: number; net: number }
  orders: ShippedOrder[]
  shops: { shop: string; shipped: number; delivered: number; toPack: number; medianHours: number | null }[]
}

interface OrderRecord {
  shopId: string
  orderId: string
  status: string | null
  substatus: string | null
  courier: string | null
  tracking: string | null
  paid: number | null
  shipped: number | null
  delivered: number | null
  cancelled: number | null
}

function groupOrders(lines: ShippingLine[]): OrderRecord[] {
  const orders = new Map<string, OrderRecord>()
  for (const l of lines) {
    const key = `${l.shop_id}|${l.order_id}`
    const o = orders.get(key) || {
      shopId: l.shop_id, orderId: l.order_id, status: null, substatus: null, courier: null, tracking: null,
      paid: null, shipped: null, delivered: null, cancelled: null,
    }
    o.status ??= l.order_status
    o.substatus ??= l.order_substatus
    o.courier ??= l.shipping_provider
    o.tracking ??= l.tracking_number
    o.paid ??= ts(l.paid_time) ?? ts(l.created_time)
    o.shipped ??= ts(l.shipped_time)
    o.delivered ??= ts(l.delivered_time)
    o.cancelled ??= ts(l.cancelled_time)
    orders.set(key, o)
  }
  return [...orders.values()]
}

const LATE_HOURS = 48

export function buildShippingReport(input: {
  range: PeriodRange
  shops: ReportShop[]
  lines: ShippingLine[]
  settlements: SettlementRow[]
  now?: Date
}): ShippingReport {
  const { range } = input
  const now = (input.now ?? new Date()).getTime()
  const from = Date.parse(range.startIso)
  const to = Date.parse(range.endIso)
  const within = (t: number | null) => t !== null && t >= from && t < to
  const shopName = new Map(input.shops.map(s => [s.id, s.name]))
  const orders = groupOrders(input.lines)

  const shipped = orders.filter(o => within(o.shipped))
  const delivered = orders.filter(o => within(o.delivered))
  const toPack = orders.filter(o => o.status === TO_SHIP)
  const hoursToShip = (o: OrderRecord) => (o.paid !== null && o.shipped !== null ? Math.max(0, (o.shipped - o.paid) / HOUR_MS) : null)
  const deliveryDays = (o: OrderRecord) => (o.shipped !== null && o.delivered !== null ? Math.max(0, (o.delivered - o.shipped) / DAY_MS) : null)

  const hours = shipped.map(hoursToShip).filter((h): h is number => h !== null)
  const speed = {
    within24: hours.filter(h => h <= 24).length,
    within48: hours.filter(h => h > 24 && h <= 48).length,
    over48: hours.filter(h => h > 48).length,
    medianHours: round1(median(hours)),
  }

  const couriers = new Map<string, { courier: string; shipped: number; delivered: number; days: number[] }>()
  for (const o of shipped) {
    const name = o.courier || 'Unknown'
    const c = couriers.get(name) || { courier: name, shipped: 0, delivered: 0, days: [] }
    c.shipped++
    const d = deliveryDays(o)
    if (d !== null) { c.delivered++; c.days.push(d) }
    couriers.set(name, c)
  }

  const money = { buyerPaid: 0, subsidy: 0, courierCost: 0, returns: 0, net: 0 }
  for (const r of input.settlements) {
    if (!r.settled_date || r.settled_date < range.start || r.settled_date >= range.end) continue
    money.buyerPaid += fee(r, 'customer_shipping_fee')
    money.subsidy += fee(r, 'platform_shipping_fee_discount')
    money.courierCost += fee(r, 'actual_shipping_fee')
    money.returns += fee(r, 'actual_return_shipping_fee')
    money.net += fee(r, 'seller_shipping_fee')
  }

  return {
    kind: 'shipping',
    shipped: shipped.length,
    delivered: delivered.length,
    cancelled: orders.filter(o => within(o.cancelled)).length,
    toPack: toPack.length,
    toPackLate: toPack.filter(o => o.paid !== null && now - o.paid > LATE_HOURS * HOUR_MS).length,
    within24h: hours.length ? speed.within24 / hours.length : null,
    speed,
    deliveryDays: round1(median(delivered.map(deliveryDays).filter((d): d is number => d !== null))),
    couriers: [...couriers.values()]
      .map(c => ({ courier: c.courier, shipped: c.shipped, delivered: c.delivered, medianDeliveryDays: round1(median(c.days)) }))
      .sort((a, b) => b.shipped - a.shipped),
    money: {
      buyerPaid: rm(money.buyerPaid),
      subsidy: rm(money.subsidy),
      courierCost: rm(money.courierCost),
      returns: rm(money.returns),
      other: rm(money.net - money.buyerPaid - money.subsidy - money.courierCost - money.returns),
      net: rm(money.net),
    },
    orders: [...shipped]
      .sort((a, b) => (b.shipped ?? 0) - (a.shipped ?? 0))
      .map(o => {
        const h = hoursToShip(o)
        return {
          shop: shopName.get(o.shopId) || '',
          orderId: o.orderId,
          shippedAt: new Date(o.shipped!).toISOString(),
          courier: o.courier,
          tracking: o.tracking,
          status: o.substatus || o.status,
          hoursToShip: h === null ? null : Math.round(h),
          deliveredAt: o.delivered === null ? null : new Date(o.delivered).toISOString(),
        }
      }),
    shops: input.shops.length > 1
      ? input.shops.map(s => {
        const mine = shipped.filter(o => o.shopId === s.id)
        return {
          shop: s.name,
          shipped: mine.length,
          delivered: delivered.filter(o => o.shopId === s.id).length,
          toPack: toPack.filter(o => o.shopId === s.id).length,
          medianHours: round1(median(mine.map(hoursToShip).filter((h): h is number => h !== null))),
        }
      })
      : [],
  }
}

// ── Report envelope ───────────────────────────────────────────────────

export interface ReportEnvelope {
  kind: ReportKind
  period: ReportPeriod
  date: string
  range: PeriodRange
  shops: ReportShop[]
  lastSyncAt: string | null
  generatedAt: string
}

export type TikTokReport = ReportEnvelope & { data: SalesReport | SettlementReport | ShippingReport }
