import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { buildDailyReport, type ReportOrderLine } from './tiktok-daily-report'
import { buildDailyReportWorkbook } from './tiktok-daily-report-excel'
import { loadTikTokDailyReport } from './tiktok-daily-report-server'
import { ROUTE_COVERAGE } from '@/lib/security-access/route-coverage'

const line = (over: Partial<ReportOrderLine>): ReportOrderLine => ({
  shop_id: 'sera',
  order_id: 'o1',
  package_id: 'p1',
  seller_sku: 'PROMO - HB (1) FREE T1L (1)',
  product_name: null,
  variation: 'Black',
  quantity: 1,
  order_substatus: 'Awaiting collection',
  created_time: '2026-10-05T05:00:00Z',
  ...over,
})

const shops = [{ id: 'sera', name: 'SeraOutdoor' }]

function fakeDb(rows: Record<string, any[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = []
  const from = (table: string) => {
    const builder: any = {}
    for (const method of ['select', 'eq', 'in', 'order', 'gte', 'lt', 'range']) {
      builder[method] = (...args: unknown[]) => {
        calls.push({ table, method, args })
        return builder
      }
    }
    builder.then = (resolve: (v: unknown) => void) => resolve({ data: rows[table] || [], error: null })
    return builder
  }
  return { db: { from }, calls }
}

describe('report for the TikTok Shop page', () => {
  it('lists each parcel with order, package and status', () => {
    const report = buildDailyReport({ slot: 'packing', now: new Date('2026-10-07T01:35:00Z'), shops, lines: [line({}), line({ order_id: 'o2', package_id: 'p2', quantity: 2 })] })
    expect(report.shops[0].parcelRows).toEqual([
      { no: 1, orderId: 'o1', packageId: 'p1', status: 'Awaiting collection', contents: '1x PROMO - HB (1) FREE T1L (1) (Black)' },
      { no: 2, orderId: 'o2', packageId: 'p2', status: 'Awaiting collection', contents: '2x PROMO - HB (1) FREE T1L (1) (Black)' },
    ])
    expect(report.shops[0].parcelLines[0]).toBe('1. Order o1 [Awaiting collection]: 1x PROMO - HB (1) FREE T1L (1) (Black)')
  })

  it('names an earlier shipped day instead of "today"', () => {
    const report = buildDailyReport({ slot: 'shipped', now: new Date('2026-10-05T04:00:00Z'), shops, lines: [], pastDay: true })
    expect(report.title).toBe('TIKTOK SHOP - SHIPPED 5/10/2026')
    expect(report.subject).toBe('TikTok Shop - shipped on 5/10/2026')
    expect(report.text).toContain('Nothing shipped.')
    expect(report.text).not.toContain('today')
  })

  it('downloads as a workbook with summary, items and parcels', async () => {
    const report = buildDailyReport({ slot: 'packing', now: new Date('2026-10-07T01:35:00Z'), shops, lines: [line({}), line({ order_id: 'o2', package_id: 'p2' })] })
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load((await buildDailyReportWorkbook(report)) as any)
    expect(workbook.worksheets.map((s) => s.name)).toEqual(['Summary', 'Items', 'Parcels'])
    const summary = workbook.getWorksheet('Summary')!
    expect(summary.getRow(2).values).toEqual([undefined, 'SeraOutdoor', 2, 4, '5/10/2026'])
    const items = workbook.getWorksheet('Items')!
    expect(items.getRow(2).values).toEqual([undefined, 'SeraOutdoor', 'HIGHBACK', 2, 'Black 2'])
    const parcels = workbook.getWorksheet('Parcels')!
    expect(parcels.rowCount).toBe(3)
    expect(parcels.getRow(3).getCell(3).value).toBe('o2')
  })

  it('loads an earlier day by that Malaysia day and only for the company', async () => {
    const { db, calls } = fakeDb({
      marketplace_shops: [{ id: 'sera', shop_name: 'SeraOutdoor' }],
      marketplace_shop_connections: [{ shop_id: 'sera', last_sync_at: '2026-10-07T07:23:00Z' }],
      marketplace_order_lines: [line({})],
    })
    const report = await loadTikTokDailyReport(db, { companyId: 'hq', shopIds: ['sera'], slot: 'shipped', day: '2026-10-05', now: new Date('2026-10-07T08:00:00Z') })
    expect(report.day).toBe('2026-10-05')
    expect(report.subject).toBe('TikTok Shop - shipped on 5/10/2026')
    expect(report.parcels).toBe(1)
    const lineCalls = calls.filter((c) => c.table === 'marketplace_order_lines')
    expect(lineCalls).toContainEqual({ table: 'marketplace_order_lines', method: 'eq', args: ['company_id', 'hq'] })
    expect(lineCalls).toContainEqual({ table: 'marketplace_order_lines', method: 'gte', args: ['shipped_time', '2026-10-04T16:00:00.000Z'] })
    expect(lineCalls).toContainEqual({ table: 'marketplace_order_lines', method: 'lt', args: ['shipped_time', '2026-10-05T16:00:00.000Z'] })
    expect(calls).toContainEqual({ table: 'marketplace_shops', method: 'eq', args: ['company_id', 'hq'] })
  })

  it('packing ignores the date and lists what is still to ship', async () => {
    const { db, calls } = fakeDb({ marketplace_shops: [{ id: 'sera', shop_name: 'SeraOutdoor' }], marketplace_order_lines: [] })
    const report = await loadTikTokDailyReport(db, { companyId: 'hq', shopIds: ['sera'], slot: 'packing', day: '2026-10-01', now: new Date('2026-10-07T08:00:00Z') })
    expect(report.day).toBe('2026-10-07')
    expect(calls).toContainEqual({ table: 'marketplace_order_lines', method: 'eq', args: ['order_status', 'To ship'] })
  })

  it('the page route is gated by the marketplace permission', () => {
    expect(ROUTE_COVERAGE['ecommerce/tiktok-shop/daily-report']).toMatchObject({ kind: 'ENTERPRISE', permissions: ['ecommerce.order.manage'] })
  })
})
