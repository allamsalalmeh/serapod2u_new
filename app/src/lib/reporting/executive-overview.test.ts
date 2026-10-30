import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildExecutiveOverviewReport, executiveOverviewFilename, type OverviewOrderInput } from './executive-overview'
import { buildExecutiveOverviewPdf } from './executive-overview-pdf'

const NOW = new Date('2026-10-20T10:00:00+08:00')

let seq = 0
function o(orderType: string | null, status: string, orderDate: string, buyer: [string, string, string], value: number, qty = 1, variantId = 'v1'): OverviewOrderInput {
  seq += 1
  return {
    id: `o${seq}`, orderNo: `SO-${seq}`, orderType, status, orderDate, createdAt: `${orderDate}T03:00:00Z`,
    buyerId: buyer[0], buyerName: buyer[1], buyerType: buyer[2],
    items: [{ variantId, qty, lineTotal: value }],
  }
}
const DA: [string, string, string] = ['d1', 'Dist Alpha', 'DIST']
const DB: [string, string, string] = ['d2', 'Dist Alpha', 'DIST'] // same NAME, different organisation
const S1: [string, string, string] = ['s1', 'Kedai Satu', 'SHOP']
const HQ: [string, string, string] = ['hq', 'HQ', 'HQ']

const ORDERS = [
  o('D2H', 'approved', '2026-10-01', DA, 1000, 10),
  o('D2H', 'closed', '2026-10-15', DB, 500, 5, 'v2'),
  o('S2D', 'shipped_distributor', '2026-10-20', S1, 200, 4),
  o('D2H', 'submitted', '2026-10-10', DA, 7000, 70),
  o('D2H', 'draft', '2026-10-10', DA, 9000, 90),
  o('S2D', 'cancelled', '2026-10-11', S1, 300, 3),
  o('H2M', 'approved', '2026-10-05', HQ, 50000, 500, 'v9'),
  o(null, 'approved', '2026-10-06', DA, 123, 1),
  // Comparison (1–20 Sep) and the rest of September.
  o('D2H', 'approved', '2026-09-20', DA, 800, 8),
  o('D2H', 'approved', '2026-09-21', DA, 999, 9),
]

const build = (month = '2026-10', orders = ORDERS) => buildExecutiveOverviewReport({
  month, orders, now: NOW, productNames: { v1: 'Mango', v2: 'Grape' },
})

describe('Executive Overview report', () => {
  it('counts only approved D2H + S2D as sales; H2M, pipeline, cancelled, drafts and untyped stay out', () => {
    const { summary } = build()
    expect(summary.approvedSalesValue).toBe(1700)
    expect(summary.approvedSalesOrders).toBe(3)
    expect(summary.distributorSalesValue).toBe(1500)
    expect(summary.shopSalesValue).toBe(200)
    expect(summary.purchaseValue).toBe(50000)
    expect(summary.pipelineValue).toBe(7000)
    expect(summary.cancelledValue).toBe(300)
    expect(summary.unclassifiedOrders).toBe(1)
    expect(summary.unitsSold).toBe(19)
    expect(summary.avgOrderValue).toBe(566.67)
  })

  it('keys buyers by organisation id, so two buyers with one name are not merged', () => {
    const { summary, topBuyers } = build()
    expect(summary.activeBuyers).toBe(3)
    expect(summary.activeDistributorBuyers).toBe(2)
    expect(summary.activeShopBuyers).toBe(1)
    expect(topBuyers.map((b) => b.buyerId)).toEqual(['d1', 'd2', 's1'])
    expect(topBuyers.reduce((sum, b) => sum + b.value, 0)).toBe(1700)
  })

  it('compares month to date with the same elapsed days (20 Sep is in, 21 Sep is not)', () => {
    const { comparison, period } = build()
    expect(period.rangeLabel).toBe('01 Oct 2026 – 20 Oct 2026')
    expect(period.comparisonRangeLabel).toBe('01 Sep 2026 – 20 Sep 2026')
    expect(comparison.approvedSalesValue).toEqual({ current: 1700, previous: 800, changePct: 112.5 })
  })

  it('reports the six-month trend with full historical months and a partial current month', () => {
    const { monthlyTrend } = build()
    expect(monthlyTrend.map((m) => m.month)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'])
    expect(monthlyTrend.find((m) => m.month === '2026-09')).toMatchObject({ value: 1799, orders: 2, isPartial: false })
    expect(monthlyTrend.at(-1)).toMatchObject({ value: 1700, isPartial: true })
  })

  it('compares January with the whole of the previous December', () => {
    const report = buildExecutiveOverviewReport({
      month: '2026-01',
      now: NOW,
      orders: [o('D2H', 'approved', '2025-12-31', DA, 100), o('D2H', 'approved', '2026-01-01', DA, 150)],
    })
    expect(report.period.comparisonRangeLabel).toBe('01 Dec 2025 – 31 Dec 2025')
    expect(report.comparison.approvedSalesValue).toEqual({ current: 150, previous: 100, changePct: 50 })
    expect(report.dailyTrend).toHaveLength(31)
  })

  it('returns an explicit empty report for an empty month', () => {
    const report = build('2026-06')
    expect(report.isEmpty).toBe(true)
    expect(report.summary.approvedSalesValue).toBe(0)
    expect(report.comparison.approvedSalesValue.changePct).toBeNull()
    expect(report.dailyTrend).toHaveLength(30)
    expect(report.topBuyers).toEqual([])
  })

  it('names the file by month, with MTD only for the running month', () => {
    expect(executiveOverviewFilename(build('2026-10').period)).toBe('Serapod_Executive_Overview_2026-10_MTD.pdf')
    expect(executiveOverviewFilename(build('2026-09').period)).toBe('Serapod_Executive_Overview_2026-09.pdf')
  })
})

const pdfText = async (blob: Blob) => Buffer.from(await blob.arrayBuffer()).toString('latin1')
const pageCount = (text: string) => (text.match(/\/Type \/Page[^s]/g) || []).length

describe('Executive Overview PDF', () => {
  it('formats the DTO only — no data access and no second calculation', () => {
    const source = readFileSync(new URL('./executive-overview-pdf.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/supabase|createClient|fetch\(|\.rpc\(/)
    expect(source).not.toMatch(/buildExecutiveOverviewReport|summarizeSales/)
  })

  it('renders a multi-page A4 report carrying the selected month, figures and page numbers', async () => {
    const pdf = await buildExecutiveOverviewPdf(build(), { generatedAt: '2026-10-20T02:00:00.000Z', generatedBy: 'QA Tester' })
    const text = await pdfText(pdf.blob)
    expect(text.slice(0, 5)).toBe('%PDF-')
    expect(pdf.filename).toBe('Serapod_Executive_Overview_2026-10_MTD.pdf')
    const pages = pageCount(text)
    expect(pages).toBeGreaterThanOrEqual(2)
    for (let page = 1; page <= pages; page++) expect(text).toContain(`Page ${page} of ${pages}`)
    expect(text).toContain('SERAPOD EXECUTIVE OVERVIEW REPORT')
    expect(text).toContain('October 2026')
    // jsPDF writes the en dash as WinAnsi 0x96 and escapes parentheses.
    expect(text).toContain('01 Oct 2026 \u0096 20 Oct 2026 \\(month to date\\)')
    expect(text).toContain('QA Tester')
    expect(text).toContain('RM 1,700.00') // approved sales
    expect(text).toContain('RM 50,000.00') // H2M shown apart
    expect(text).toContain('H2M MANUFACTURER PURCHASES')
  })

  it('renders an informative empty-month report without blank pages', async () => {
    const pdf = await buildExecutiveOverviewPdf(build('2026-06'), { generatedAt: '2026-10-20T02:00:00.000Z' })
    const text = await pdfText(pdf.blob)
    expect(pdf.filename).toBe('Serapod_Executive_Overview_2026-06.pdf')
    expect(text).toContain('No orders were recorded in June 2026')
    const pages = pageCount(text)
    expect(pages).toBeGreaterThanOrEqual(1)
    for (let page = 1; page <= pages; page++) expect(text).toContain(`Page ${page} of ${pages}`)
  })
})
