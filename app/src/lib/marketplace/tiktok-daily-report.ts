/**
 * TikTok Shop daily shipping report (what to pack, what shipped today).
 *
 * Seller SKUs are expanded to the physical items the warehouse packs, so a
 * promo like "PROMO - HB (1) FREE T1L (1)" counts as one Highback and one
 * Tumbler 1L. A SKU that cannot be read is listed under its own SKU, never
 * dropped. Times are Malaysia time (UTC+8, no daylight saving).
 */

export {
  TIKTOK_DAILY_REPORT_EVENT as DAILY_REPORT_EVENT,
  TIKTOK_DAILY_SUMMARY_EVENT as DAILY_SUMMARY_EVENT,
} from '@/lib/notifications/notificationEventCatalog'
export const TO_SHIP_STATUS = 'To ship'

export type DailyReportSlot = 'packing' | 'shipped'

/** Malaysia hour → report. The hourly sync runs at :23, the report at :35. */
export const DAILY_REPORT_SCHEDULE: Record<number, DailyReportSlot> = { 9: 'packing', 12: 'packing', 18: 'shipped' }

const MYT_OFFSET_MS = 8 * 3600 * 1000

export interface ReportOrderLine {
  shop_id: string
  order_id: string
  package_id: string | null
  seller_sku: string | null
  product_name: string | null
  variation: string | null
  quantity: number | null
  order_substatus: string | null
  created_time: string | null
}

export interface ReportShop {
  id: string
  name: string
}

export interface ShopReport {
  shop: string
  parcels: number
  items: number
  orderFrom: string | null
  orderTo: string | null
  itemTotals: { item: string; quantity: number; variations: { name: string; quantity: number }[] }[]
  parcelLines: string[]
  parcelRows: { no: number; orderId: string; packageId: string | null; status: string | null; contents: string }[]
}

export interface DailyReport {
  slot: DailyReportSlot
  title: string
  subject: string
  text: string
  summary: string
  /** Pieces of the summary for SMS/WhatsApp templates. */
  label: string
  date: string
  time: string
  shopCounts: string
  parcels: number
  items: number
  shops: ShopReport[]
}

const CODE_ITEMS: Record<string, string> = {
  HB: 'HIGHBACK',
  MC: 'MOONCHAIR',
  CHAIR: 'MOONCHAIR',
  T1L: 'TUMBLER 1L',
  CM: 'CAMPING MAT',
}

const ALL_IN = ['TUMBLER 1L', 'HIGHBACK', 'MOONCHAIR', 'CAMPING MAT']

const SINGLE_SKUS: Record<string, string> = {
  'SERAPOD CAMPING MAT': 'CAMPING MAT',
  'SERAPOD HIGHBACK': 'HIGHBACK',
  'SERAPOD MOONCHAIR': 'MOONCHAIR',
  'SERAPOD TUMBLER 1L': 'TUMBLER 1L',
  '500ML': 'TUMBLER 500ML',
  'S.EDGE': 'SONAR EDGE SPEAKER',
  'S.STROM': 'SONAR STORM SPEAKER',
  'T-TREATS': 'TREAT',
}

const DEFAULT_VARIATIONS = new Set(['', 'LALAI', 'DEFAULT'])

export interface SkuItem { item: string; quantity: number }

function parseCombo(sku: string): SkuItem[] | null {
  const body = sku.replace(/^(PROMO|COMBO|BUNDLE)\b/, ' ').replace(/\b(FREE|AND)\b/g, ' ')
  const pattern = /(T1L|HB|MC|CM|CHAIR)\s*(?:\(\s*(\d+)\s*\))?/g
  const items: SkuItem[] = []
  for (const match of body.matchAll(pattern)) {
    items.push({ item: CODE_ITEMS[match[1]], quantity: match[2] ? Number(match[2]) : 1 })
  }
  const rest = body.replace(pattern, ' ')
  return items.length && /^[\s\-X&+,]*$/.test(rest) ? items : null
}

/** Physical items in one unit of a seller SKU. */
export function expandSku(sellerSku: string | null, productName: string | null): SkuItem[] {
  const sku = String(sellerSku || '').trim().toUpperCase().replace(/\s+/g, ' ')
  const product = String(productName || '').trim()
  if (!sku) {
    if (/ALL IN/i.test(product)) return ALL_IN.map((item) => ({ item, quantity: 1 }))
    if (/^\[FREE ?GIFT\]/i.test(product)) return [{ item: 'FREE GIFT', quantity: 1 }]
    return [{ item: (product || 'UNKNOWN ITEM').slice(0, 40).toUpperCase(), quantity: 1 }]
  }
  if (/^BOX-/.test(sku)) return [{ item: 'TREAT BOX', quantity: 1 }]
  if (/^PACK-10\b/.test(sku)) return [{ item: 'TREAT PEK JIMAT', quantity: 1 }]
  if (SINGLE_SKUS[sku]) return [{ item: SINGLE_SKUS[sku], quantity: 1 }]
  if (/\bALL IN\b/.test(sku)) return ALL_IN.map((item) => ({ item, quantity: 1 }))
  return parseCombo(sku) || [{ item: sku, quantity: 1 }]
}

function titleCase(value: string) {
  return value.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
}

function variationName(value: string | null): string | null {
  const name = String(value || '').trim()
  return DEFAULT_VARIATIONS.has(name.toUpperCase()) ? null : titleCase(name)
}

/** Malaysia calendar day for an instant, as D/M/YYYY. */
export function mytDate(value: Date | string): string {
  const d = new Date(new Date(value).getTime() + MYT_OFFSET_MS)
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()}`
}

export function mytTime(value: Date | string): string {
  const d = new Date(new Date(value).getTime() + MYT_OFFSET_MS)
  const h = d.getUTCHours()
  return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
}

export function mytHour(value: Date): number {
  return new Date(value.getTime() + MYT_OFFSET_MS).getUTCHours()
}

/** YYYY-MM-DD of the Malaysia day. */
export function mytDayKey(value: Date): string {
  return new Date(value.getTime() + MYT_OFFSET_MS).toISOString().slice(0, 10)
}

/** UTC instants bounding the Malaysia day that contains `value`. */
export function mytDayBounds(value: Date): { start: string; end: string } {
  const start = Date.parse(`${mytDayKey(value)}T00:00:00Z`) - MYT_OFFSET_MS
  return { start: new Date(start).toISOString(), end: new Date(start + 86400 * 1000).toISOString() }
}

export function buildShopReport(shop: ReportShop, lines: ReportOrderLine[]): ShopReport {
  const parcels = new Map<string, ReportOrderLine[]>()
  const totals = new Map<string, { quantity: number; variations: Map<string, number> }>()
  let orderFrom: number | null = null
  let orderTo: number | null = null

  for (const line of lines) {
    const key = line.package_id || `order:${line.order_id}`
    parcels.set(key, [...(parcels.get(key) || []), line])
    const created = line.created_time ? Date.parse(line.created_time) : NaN
    if (!Number.isNaN(created)) {
      orderFrom = orderFrom === null ? created : Math.min(orderFrom, created)
      orderTo = orderTo === null ? created : Math.max(orderTo, created)
    }
    const units = Math.max(0, Number(line.quantity) || 0)
    const variation = variationName(line.variation)
    for (const part of expandSku(line.seller_sku, line.product_name)) {
      const entry = totals.get(part.item) || { quantity: 0, variations: new Map<string, number>() }
      const count = part.quantity * units
      entry.quantity += count
      if (variation) entry.variations.set(variation, (entry.variations.get(variation) || 0) + count)
      totals.set(part.item, entry)
    }
  }

  const itemTotals = Array.from(totals.entries())
    .map(([item, entry]) => ({
      item,
      quantity: entry.quantity,
      variations: Array.from(entry.variations.entries())
        .map(([name, quantity]) => ({ name, quantity }))
        .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => b.quantity - a.quantity || a.item.localeCompare(b.item))

  const parcelRows = Array.from(parcels.values()).map((group, index) => {
    const first = group[0]
    const contents = group
      .map((line) => {
        const variation = variationName(line.variation)
        return `${Math.max(0, Number(line.quantity) || 0)}x ${line.seller_sku || first.product_name || 'item'}${variation ? ` (${variation})` : ''}`
      })
      .join(', ')
    return { no: index + 1, orderId: first.order_id, packageId: first.package_id, status: first.order_substatus, contents }
  })
  const parcelLines = parcelRows.map((row) => `${row.no}. Order ${row.orderId}${row.status ? ` [${row.status}]` : ''}: ${row.contents}`)

  return {
    shop: shop.name,
    parcels: parcels.size,
    items: itemTotals.reduce((sum, row) => sum + row.quantity, 0),
    orderFrom: orderFrom === null ? null : mytDate(new Date(orderFrom)),
    orderTo: orderTo === null ? null : mytDate(new Date(orderTo)),
    itemTotals,
    parcelLines,
    parcelRows,
  }
}

function shopBlock(report: ShopReport, slot: DailyReportSlot, today: string, pastDay: boolean): string {
  const out = [
    report.shop.toUpperCase(),
    `ACCOUNT : TIKTOK ${report.shop.toUpperCase()}`,
  ]
  if (!report.parcels) {
    out.push(slot === 'packing' ? 'Nothing to pack.' : pastDay ? 'Nothing shipped.' : 'Nothing shipped today.')
    return out.join('\n')
  }
  if (slot === 'shipped') out.push(`SHIP : ${today}`)
  const orderRange = report.orderFrom && report.orderTo && report.orderFrom !== report.orderTo
    ? `${report.orderFrom} - ${report.orderTo}`
    : report.orderFrom
  if (orderRange) out.push(`ORDER : ${orderRange}`)
  out.push('------------------------------')
  out.push(`TOTAL ITEMS : ${report.items}`)
  out.push(`TOTAL PARCEL : ${report.parcels}`)
  out.push('------------------------------')
  out.push('ITEMS')
  for (const row of report.itemTotals) {
    const detail = row.variations.length ? ` (${row.variations.map((v) => `${v.name} ${v.quantity}`).join(', ')})` : ''
    out.push(`${row.item} : ${row.quantity}${detail}`)
  }
  out.push('------------------------------')
  out.push('PARCELS')
  out.push(...report.parcelLines)
  return out.join('\n')
}

export function buildDailyReport(input: {
  slot: DailyReportSlot
  now: Date
  shops: ReportShop[]
  lines: ReportOrderLine[]
  lastSyncAt?: string | null
  /** Shipped report for an earlier day: `now` is that day and has no meaningful time. */
  pastDay?: boolean
}): DailyReport {
  const { slot, now, shops, lines } = input
  const pastDay = slot === 'shipped' && Boolean(input.pastDay)
  const today = mytDate(now)
  const byShop = new Map<string, ReportOrderLine[]>()
  for (const line of lines) byShop.set(line.shop_id, [...(byShop.get(line.shop_id) || []), line])
  const reports = shops.map((shop) => buildShopReport(shop, byShop.get(shop.id) || []))

  const title = slot === 'packing' ? 'TIKTOK SHOP - TO PACK' : pastDay ? `TIKTOK SHOP - SHIPPED ${today}` : 'TIKTOK SHOP - SHIPPED TODAY'
  const subject = slot === 'packing'
    ? `TikTok Shop - to pack (${today}, ${mytTime(now)})`
    : pastDay ? `TikTok Shop - shipped on ${today}` : `TikTok Shop - shipped today (${today})`
  const header = [
    title,
    pastDay ? null : `${today}, ${mytTime(now)}`,
    input.lastSyncAt ? `TikTok data as of ${mytDate(input.lastSyncAt)} ${mytTime(input.lastSyncAt)}` : null,
  ].filter(Boolean).join('\n')
  const text = [header, ...reports.map((report) => shopBlock(report, slot, today, pastDay))].join('\n\n==============================\n\n')

  const counts = reports.map((r) => `${r.shop} ${r.parcels} parcel${r.parcels === 1 ? '' : 's'}/${r.items} item${r.items === 1 ? '' : 's'}`).join('; ')
  const summary = slot === 'packing'
    ? `[Serapod2U] TikTok to pack ${today} ${mytTime(now)}: ${counts}.`
    : `[Serapod2U] TikTok shipped ${today}: ${counts}.`

  return {
    slot,
    title,
    subject,
    text,
    summary,
    label: slot === 'packing' ? 'to pack' : 'shipped',
    date: today,
    time: mytTime(now),
    shopCounts: counts,
    parcels: reports.reduce((sum, r) => sum + r.parcels, 0),
    items: reports.reduce((sum, r) => sum + r.items, 0),
    shops: reports,
  }
}
