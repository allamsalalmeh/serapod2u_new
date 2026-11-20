/**
 * Shop Performance — the monthly report behind the Shop Performance view and
 * its PDF export.
 *
 * One DTO, built here from the month's shop scans, feeds the web report and
 * the PDF. Rules:
 *
 *   - Reporting month: the shared monthly period model. A historical month is
 *     the complete calendar month; the current month runs to today. Asia/Kuala_Lumpur.
 *   - Population: genuine consumer QR scans attributed to a shop
 *     (`is_manual_adjustment = false`, `shop_id` set) whose `scanned_at` falls
 *     in the window — never lifetime totals.
 *   - Every metric (KPIs, daily activity, size bands, rankings, Negeri) counts
 *     the same scan rows.
 *
 * Isomorphic and pure, except `readShopScans` which pages the source query.
 */

import { addDaysToDateKey, malaysiaDateOf } from '@/lib/orders/order-date'
import { formatReportDate, resolveProductReportPeriod, type ProductReportPeriod } from './product-analytics'
import { buildNegeriReport, type NegeriOrgRow, type NegeriStateRow, type StateRankRow } from './shop-by-negeri'

export type ShopPerformancePeriod = ProductReportPeriod

export const SHOP_SCAN_SOURCE = 'consumer_qr_scans — shop scans, no manual adjustments'
export const SHOP_DATE_FIELD = 'consumer_qr_scans.scanned_at (Malaysia time)'
export const TOP_SHOPS_LIMIT = 10
export const SHOP_RANKING_LIMIT = 50

export interface ShopScanRow {
  id: string
  consumer_id: string | null
  scanned_at: string | null
  shop_id: string | null
  points_amount: number | null
}

export interface ShopInfoRow {
  id: string
  org_name: string
  org_code?: string | null
  branch: string | null
  state_id?: string | null
}

export const SHOP_SIZE_BANDS = [
  { name: '1-5 scans', min: 1, max: 5 },
  { name: '6-20 scans', min: 6, max: 20 },
  { name: '21-50 scans', min: 21, max: 50 },
  { name: '51-100 scans', min: 51, max: 100 },
  { name: '100+ scans', min: 101, max: Infinity },
] as const

export interface ShopPerformanceReport {
  period: ShopPerformancePeriod
  meta: { source: string; dateField: string; timeZone: string }
  kpis: {
    activeShops: number
    totalScans: number
    uniqueConsumers: number
    pointsIssued: number
    avgScansPerShop: number
  }
  dailyTrend: { date: string; label: string; day: number; scans: number; shops: number }[]
  /** Every band, including empty ones; the chart hides empty bands. */
  sizeDistribution: { name: string; count: number; sharePct: number | null }[]
  /** All active shops ranked by scans (ties: consumers, then name). */
  shopRanking: { rank: number; shopId: string; name: string; scans: number; consumers: number; points: number; lastScanAt: string | null; scanSharePct: number | null }[]
  /** Shop by Negeri for the same scans; growth is not compared here. */
  negeri: StateRankRow[]
  unassignedNegeriScans: number
  isEmpty: boolean
}

const round1 = (n: number) => Math.round((n + Number.EPSILON) * 10) / 10
const share = (part: number, total: number) => (total > 0 ? round1((part / total) * 100) : null)

export function resolveShopPerformancePeriod(month: string, now: Date = new Date()): ShopPerformancePeriod {
  return resolveProductReportPeriod(month, now)
}

export function shopDisplayName(shop: ShopInfoRow | undefined): string {
  if (!shop) return 'Unknown Shop'
  return `${shop.org_name}${shop.branch ? ` (${shop.branch})` : ''}`
}

export function buildShopPerformanceReport(input: {
  month: string
  scans: readonly ShopScanRow[]
  shops: ReadonlyMap<string, ShopInfoRow>
  states?: readonly NegeriStateRow[]
  now?: Date
}): ShopPerformanceReport {
  const period = resolveShopPerformancePeriod(input.month, input.now)
  // Defensive: only rows inside the window count, whatever the caller passed.
  const scans = input.scans.filter((scan) =>
    scan.shop_id && scan.scanned_at && scan.scanned_at >= period.startUtc && scan.scanned_at < period.endUtc)

  const byShop = new Map<string, { scans: number; consumers: Set<string>; points: number; lastScanAt: string | null }>()
  const consumers = new Set<string>()
  const byDay = new Map<string, { scans: number; shops: Set<string> }>()
  let pointsIssued = 0

  for (const scan of scans) {
    const shopId = scan.shop_id!
    const entry = byShop.get(shopId) ?? { scans: 0, consumers: new Set<string>(), points: 0, lastScanAt: null }
    entry.scans += 1
    if (scan.consumer_id) { entry.consumers.add(scan.consumer_id); consumers.add(scan.consumer_id) }
    entry.points += Number(scan.points_amount) || 0
    if (!entry.lastScanAt || scan.scanned_at! > entry.lastScanAt) entry.lastScanAt = scan.scanned_at
    byShop.set(shopId, entry)
    pointsIssued += Number(scan.points_amount) || 0

    const day = malaysiaDateOf(scan.scanned_at!)!
    const bucket = byDay.get(day) ?? { scans: 0, shops: new Set<string>() }
    bucket.scans += 1
    bucket.shops.add(shopId)
    byDay.set(day, bucket)
  }

  const totalScans = scans.length
  const activeShops = byShop.size

  const dailyTrend = Array.from({ length: period.dayCount }, (_, index) => {
    const date = addDaysToDateKey(period.startDate, index)
    const bucket = byDay.get(date)
    return { date, label: formatReportDate(date).slice(0, 6), day: index + 1, scans: bucket?.scans ?? 0, shops: bucket?.shops.size ?? 0 }
  })

  const sizeDistribution = SHOP_SIZE_BANDS.map((band) => {
    const count = [...byShop.values()].filter((entry) => entry.scans >= band.min && entry.scans <= band.max).length
    return { name: band.name, count, sharePct: share(count, activeShops) }
  })

  const shopRanking = [...byShop.entries()]
    .map(([shopId, entry]) => ({
      shopId,
      name: shopDisplayName(input.shops.get(shopId)),
      scans: entry.scans,
      consumers: entry.consumers.size,
      points: entry.points,
      lastScanAt: entry.lastScanAt,
      scanSharePct: share(entry.scans, totalScans),
    }))
    .sort((a, b) => b.scans - a.scans || b.consumers - a.consumers || a.name.localeCompare(b.name))
    .map((row, index) => ({ rank: index + 1, ...row }))

  // Negeri: the same scans, attributed through each shop's state.
  let negeri: StateRankRow[] = []
  let unassignedNegeriScans = 0
  if (input.states && input.states.length > 0) {
    const orgs: NegeriOrgRow[] = [...input.shops.values()].map((shop) => ({
      id: shop.id, org_name: shop.org_name, branch: shop.branch, state_id: shop.state_id ?? null, contact_name: null, contact_phone: null,
    }))
    const start = new Date(period.startUtc)
    const negeriReport = buildNegeriReport({
      scans: scans as any,
      orgs,
      states: input.states as NegeriStateRow[],
      // No comparison window: an empty one, so growth is reported as unavailable rather than invented.
      window: { start, end: new Date(period.endUtc), prevStart: start, prevEnd: start },
    })
    negeri = negeriReport.ranking.filter((row) => row.scans > 0)
    unassignedNegeriScans = totalScans - negeri.reduce((sum, row) => sum + row.scans, 0)
  }

  return {
    period,
    meta: { source: SHOP_SCAN_SOURCE, dateField: SHOP_DATE_FIELD, timeZone: period.timeZone },
    kpis: {
      activeShops,
      totalScans,
      uniqueConsumers: consumers.size,
      pointsIssued,
      avgScansPerShop: activeShops > 0 ? round1(totalScans / activeShops) : 0,
    },
    dailyTrend,
    sizeDistribution,
    shopRanking,
    negeri,
    unassignedNegeriScans,
    isEmpty: totalScans === 0,
  }
}

const SCAN_PAGE_SIZE = 1000
const MAX_SCAN_PAGES = 500

/**
 * Every shop scan in `[startUtc, endUtc)`, read page by page so the PostgREST
 * row cap can never silently truncate a busy month. Ordered by time then id so
 * page boundaries are stable.
 */
export async function readShopScans(supabase: any, startUtc: string, endUtc: string): Promise<ShopScanRow[]> {
  const out: ShopScanRow[] = []
  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    const from = page * SCAN_PAGE_SIZE
    const { data, error } = await supabase
      .from('consumer_qr_scans')
      .select('id, consumer_id, scanned_at, shop_id, collected_points, points_amount')
      .eq('is_manual_adjustment', false)
      .not('shop_id', 'is', null)
      .gte('scanned_at', startUtc)
      .lt('scanned_at', endUtc)
      .order('scanned_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + SCAN_PAGE_SIZE - 1)
    if (error) throw error
    const rows = (data ?? []) as ShopScanRow[]
    out.push(...rows)
    if (rows.length < SCAN_PAGE_SIZE) return out
  }
  throw new Error('Shop scans exceeded the report read limit for one month.')
}

/** `Serapod_Shop_Performance_2026-10_MTD.pdf`; a completed month has no MTD suffix. */
export function shopPerformanceFilename(period: ShopPerformancePeriod): string {
  return `Serapod_Shop_Performance_${period.month}${period.isCurrentMonth ? '_MTD' : ''}.pdf`
}
