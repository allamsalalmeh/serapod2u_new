import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { buildTikTokReportWorkbook } from './tiktok-reports-excel'
import { buildSalesReport, buildSettlementReport, buildShippingReport, periodRange, type TikTokReport } from './tiktok-reports'

const NOW = new Date('2026-10-15T04:00:00Z')
const shops = [{ id: 'sera', name: 'SeraOutdoor' }, { id: 'ell', name: 'Ellbow' }]
const range = periodRange('month', '2026-10-15', NOW)
const wrap = (kind: TikTokReport['kind'], data: TikTokReport['data']): TikTokReport => ({
  kind, period: 'month', date: '2026-10-15', range, shops, lastSyncAt: '2026-10-15T03:23:00Z', generatedAt: NOW.toISOString(), data,
})

async function sheets(report: TikTokReport) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(await buildTikTokReportWorkbook(report) as any)
  return wb
}

describe('buildTikTokReportWorkbook', () => {
  it('writes a summary and the tables of each report', async () => {
    const sales = await sheets(wrap('sales', buildSalesReport({
      range, shops, now: NOW,
      lines: [{ shop_id: 'sera', order_id: '1', product_name: 'Chair', seller_sku: 'CHAIR', order_status: 'Completed', quantity: 1, subtotal_after_discount: 99.5, created_time: '2026-10-02T01:00:00Z' }],
    })))
    expect(sales.worksheets.map(w => w.name)).toEqual(['Summary', 'Trend', 'Products', 'By shop'])
    expect(sales.getWorksheet('Summary')!.getRow(3).values).toEqual([, 'Period', 'October 2026'])

    const settlement = await sheets(wrap('settlement', buildSettlementReport({
      range, shops, payouts: [], unsettled: [], timings: [],
      settlements: [{ shop_id: 'sera', transaction_type: 'Order', related_order_id: '1', settled_date: '2026-10-05', total_revenue: 100, total_fees: -20, total_settlement_amount: 80, customer_refund: null, fee_breakdown: { tiktok_shop_commission_fee: -20 } }],
    })))
    expect(settlement.worksheets.map(w => w.name)).toEqual(['Summary', 'Paid to bank', 'Pending', 'By shop'])
    const values = settlement.getWorksheet('Summary')!.getColumn(2).values
    expect(values).toContain(80)

    const shipping = await sheets(wrap('shipping', buildShippingReport({
      range, shops, settlements: [], now: NOW,
      lines: [{ shop_id: 'sera', order_id: '583001', order_status: 'Shipped', order_substatus: 'In transit', shipping_provider: 'J&T Express', tracking_number: 'JNT777', quantity: 1, created_time: '2026-10-02T01:00:00Z', paid_time: '2026-10-02T01:00:00Z', shipped_time: '2026-10-03T01:00:00Z', delivered_time: null, cancelled_time: null }],
    })))
    expect(shipping.worksheets.map(w => w.name)).toEqual(['Summary', 'Couriers', 'Shipped orders', 'By shop'])
    expect(shipping.getWorksheet('Shipped orders')!.getRow(2).getCell(5).value).toBe('JNT777')
  })
})
