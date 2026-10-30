import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { buildShopPerformanceReport, readShopScans, shopPerformanceFilename, type ShopInfoRow, type ShopScanRow } from './shop-performance'
import { buildShopPerformancePdf } from './shop-performance-pdf'

const NOW = new Date('2026-10-20T10:00:00+08:00')

let seq = 0
const scan = (shop: string, at: string, consumer: string | null, points = 10): ShopScanRow =>
  ({ id: `x${++seq}`, shop_id: shop, scanned_at: at, consumer_id: consumer, points_amount: points })

const SHOPS = new Map<string, ShopInfoRow>([
  ['s1', { id: 's1', org_name: 'Kedai Satu', branch: 'KL', state_id: 'st-sel-a' }],
  ['s2', { id: 's2', org_name: 'Kedai Dua', branch: null, state_id: 'st-sel-b' }],
  ['s3', { id: 's3', org_name: 'Kedai Tiga', branch: null, state_id: null }],
])
// Two `states` rows for one real state, as in production.
const STATES = [
  { id: 'st-sel-a', state_name: 'Selangor', region_id: 'r1' },
  { id: 'st-sel-b', state_name: 'Selangor', region_id: 'r1' },
  { id: 'st-jhr', state_name: 'Johor', region_id: 'r2' },
]

const SCANS = [
  // 1 Oct 00:15 MYT is still 30 Sep in UTC — it belongs to October.
  scan('s1', '2026-09-30T16:15:00Z', 'c1'),
  scan('s1', '2026-10-02T03:00:00Z', 'c1'),
  scan('s1', '2026-10-02T04:00:00Z', 'c2'),
  ...Array.from({ length: 6 }, (_, i) => scan('s2', `2026-10-1${i}T05:00:00Z`, i % 2 ? 'c3' : null, 5)),
  scan('s3', '2026-10-20T08:00:00Z', 'c4'),
  // Outside the window: 30 Sep 23:00 MYT, and a stray future row.
  scan('s1', '2026-09-30T15:00:00Z', 'c9'),
  scan('s1', '2026-10-25T00:00:00Z', 'c9'),
]

const build = (month = '2026-10', scans = SCANS) => buildShopPerformanceReport({ month, scans, shops: SHOPS, states: STATES, now: NOW })

describe('Shop Performance report', () => {
  it('counts only scans inside the Malaysia-time reporting window', () => {
    const { kpis } = build()
    expect(kpis.totalScans).toBe(10)
    expect(kpis.activeShops).toBe(3)
    expect(kpis.uniqueConsumers).toBe(4)
    expect(kpis.pointsIssued).toBe(10 * 4 + 5 * 6)
    expect(kpis.avgScansPerShop).toBe(3.3)
  })

  it('reconciles every section to the same scans', () => {
    const report = build()
    expect(report.dailyTrend).toHaveLength(20)
    expect(report.dailyTrend.reduce((sum, d) => sum + d.scans, 0)).toBe(report.kpis.totalScans)
    expect(report.dailyTrend[0]).toMatchObject({ date: '2026-10-01', scans: 1 })
    expect(report.shopRanking.reduce((sum, s) => sum + s.scans, 0)).toBe(report.kpis.totalScans)
    expect(report.sizeDistribution.reduce((sum, b) => sum + b.count, 0)).toBe(report.kpis.activeShops)
    expect(report.shopRanking.map((s) => s.name)).toEqual(['Kedai Dua', 'Kedai Satu (KL)', 'Kedai Tiga'])
  })

  it('folds duplicate state rows into one Negeri and reports scans with no state apart', () => {
    const report = build()
    expect(report.negeri).toHaveLength(1)
    expect(report.negeri[0]).toMatchObject({ negeri: 'Selangor', shops: 2, scans: 9 })
    expect(report.unassignedNegeriScans).toBe(1)
  })

  it('reports an empty month explicitly', () => {
    const report = build('2026-06')
    expect(report.isEmpty).toBe(true)
    expect(report.kpis.totalScans).toBe(0)
    expect(report.dailyTrend).toHaveLength(30)
  })

  it('names the file by month, with MTD only for the running month', () => {
    expect(shopPerformanceFilename(build('2026-10').period)).toBe('Serapod_Shop_Performance_2026-10_MTD.pdf')
    expect(shopPerformanceFilename(build('2026-09').period)).toBe('Serapod_Shop_Performance_2026-09.pdf')
  })
})

describe('readShopScans pages through the whole month', () => {
  it('requests successive ranges until a short page', async () => {
    const ranges: [number, number][] = []
    const rows = Array.from({ length: 2345 }, (_, i) => ({ id: `r${i}` }))
    const q: any = {}
    for (const m of ['select', 'eq', 'not', 'gte', 'lt', 'order']) q[m] = vi.fn(() => q)
    q.range = (from: number, to: number) => { ranges.push([from, to]); return Promise.resolve({ data: rows.slice(from, to + 1), error: null }) }
    const out = await readShopScans({ from: () => q }, 'a', 'b')
    expect(out).toHaveLength(2345)
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })
})

const pdfText = async (blob: Blob) => Buffer.from(await blob.arrayBuffer()).toString('latin1')
const pageCount = (text: string) => (text.match(/\/Type \/Page[^s]/g) || []).length

describe('Shop Performance PDF', () => {
  it('formats the DTO only — no data access and no second calculation', () => {
    const source = readFileSync(new URL('./shop-performance-pdf.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/supabase|createClient|fetch\(|\.rpc\(/)
    expect(source).not.toMatch(/buildShopPerformanceReport|buildNegeriReport/)
  })

  it('renders the selected month with its figures, Negeri and ranking, and numbered pages', async () => {
    const pdf = await buildShopPerformancePdf(build(), { generatedAt: '2026-10-20T02:00:00.000Z', generatedBy: 'QA Tester' })
    const text = await pdfText(pdf.blob)
    expect(text.slice(0, 5)).toBe('%PDF-')
    expect(pdf.filename).toBe('Serapod_Shop_Performance_2026-10_MTD.pdf')
    const pages = pageCount(text)
    expect(pages).toBeGreaterThanOrEqual(2)
    for (let page = 1; page <= pages; page++) expect(text).toContain(`Page ${page} of ${pages}`)
    expect(text).toContain('SERAPOD SHOP PERFORMANCE REPORT')
    // jsPDF writes the en dash as WinAnsi 0x96 and escapes parentheses.
    expect(text).toContain('01 Oct 2026 \u0096 20 Oct 2026 \\(month to date\\)')
    expect(text).toContain('SHOP BY NEGERI')
    expect(text).toContain('Selangor')
    expect(text).toContain('Kedai Satu \\(KL\\)')
  })

  it('renders an informative empty-month report', async () => {
    const pdf = await buildShopPerformancePdf(build('2026-06'), { generatedAt: '2026-10-20T02:00:00.000Z' })
    const text = await pdfText(pdf.blob)
    expect(text).toContain('No shop scans were recorded in June 2026')
    const pages = pageCount(text)
    expect(pages).toBeGreaterThanOrEqual(1)
    for (let page = 1; page <= pages; page++) expect(text).toContain(`Page ${page} of ${pages}`)
  })
})
