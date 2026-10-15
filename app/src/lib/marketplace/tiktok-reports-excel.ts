import ExcelJS from 'exceljs'
import type { TikTokReport } from './tiktok-reports'

const MONEY = '#,##0.00'
const PERCENT = '0.0%'

function sheet(workbook: ExcelJS.Workbook, name: string, columns: { header: string; key: string; width: number; money?: boolean; percent?: boolean }[]) {
  const ws = workbook.addWorksheet(name)
  ws.columns = columns.map(c => ({ header: c.header, key: c.key, width: c.width, style: c.money ? { numFmt: MONEY } : c.percent ? { numFmt: PERCENT } : undefined }))
  const head = ws.getRow(1)
  head.font = { bold: true }
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } }
  ws.views = [{ state: 'frozen', ySplit: 1 }]
  return ws
}

const myDateTime = (iso: string | null) => (iso ? new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ') : '')

/** The report as a workbook: a Summary sheet plus one sheet per table. */
export async function buildTikTokReportWorkbook(report: TikTokReport): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.created = new Date()
  const summary = sheet(workbook, 'Summary', [
    { header: 'Item', key: 'item', width: 36 },
    { header: 'Value', key: 'value', width: 20 },
  ])
  const add = (item: string, value: string | number | null, format?: string) => {
    const row = summary.addRow({ item, value: value ?? '' })
    if (format && typeof value === 'number') row.getCell('value').numFmt = format
  }
  add('Report', `TikTok Shop ${report.kind}`)
  add('Period', report.range.label)
  add('Shops', report.shops.map(s => s.name).join(', '))
  add('Data as of', myDateTime(report.lastSyncAt))
  summary.addRow({})

  const d = report.data
  if (d.kind === 'sales') {
    add('Sales (RM)', d.totals.sales, MONEY)
    add('Orders', d.totals.orders)
    add('Items sold', d.totals.items)
    add('Average order value (RM)', d.totals.aov, MONEY)
    add('Cancelled orders', d.totals.cancelled)
    add('Cancel rate', d.cancelRate, PERCENT)
    add(`Sales ${report.range.compareLabel}`, d.change.sales, PERCENT)

    const trend = sheet(workbook, 'Trend', [
      { header: report.range.period === 'day' ? 'Hour' : 'Day', key: 'label', width: 14 },
      { header: 'Sales (RM)', key: 'sales', width: 14, money: true },
      { header: 'Orders', key: 'orders', width: 10 },
    ])
    for (const p of d.trend) trend.addRow({ label: report.range.period === 'day' ? p.label : p.key, sales: p.sales, orders: p.orders })

    const products = sheet(workbook, 'Products', [
      { header: 'Group', key: 'group', width: 12 },
      { header: 'Product', key: 'product', width: 48 },
      { header: 'Seller SKU', key: 'sku', width: 22 },
      { header: 'Items', key: 'items', width: 10 },
      { header: 'Sales (RM)', key: 'sales', width: 14, money: true },
    ])
    for (const p of d.topProducts) products.addRow({ group: 'Top', ...p })
    for (const p of d.lowProducts) products.addRow({ group: 'Lowest', ...p })

    if (d.shops.length) {
      const shops = sheet(workbook, 'By shop', [
        { header: 'Shop', key: 'shop', width: 22 },
        { header: 'Sales (RM)', key: 'sales', width: 14, money: true },
        { header: 'Orders', key: 'orders', width: 10 },
        { header: 'Items', key: 'items', width: 10 },
        { header: 'Cancelled', key: 'cancelled', width: 10 },
      ])
      for (const s of d.shops) shops.addRow(s)
    }
  } else if (d.kind === 'settlement') {
    for (const line of d.waterfall) add(`${line.label} (RM)`, line.amount, MONEY)
    add('Net settlement (RM)', d.net, MONEY)
    summary.addRow({})
    add('Paid to bank in period (RM)', d.paidToBank, MONEY)
    add('Orders settled', d.ordersSettled)
    add('Refunds to buyers, already in revenue (RM)', d.refunds, MONEY)
    add('Pending orders (not settled yet)', d.pending.orders)
    add('Pending, estimated (RM)', d.pending.amount, MONEY)
    add('Median days from delivery to settlement', d.timing.deliveryToSettledDays)
    for (const b of d.balances) add(`${b.shop}: settled since last withdrawal${b.lastWithdrawal ? ` (${b.lastWithdrawal})` : ''} (RM)`, b.settledSince, MONEY)

    const withdrawals = sheet(workbook, 'Paid to bank', [
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Shop', key: 'shop', width: 20 },
      { header: 'Amount (RM)', key: 'amount', width: 14, money: true },
      { header: 'Status', key: 'status', width: 14 },
      { header: 'Reference', key: 'reference', width: 24 },
    ])
    for (const w of d.withdrawals) withdrawals.addRow(w)

    const pending = sheet(workbook, 'Pending', [
      { header: 'Reason', key: 'reason', width: 40 },
      { header: 'Orders', key: 'orders', width: 10 },
      { header: 'Estimated (RM)', key: 'amount', width: 16, money: true },
    ])
    for (const r of d.pending.reasons) pending.addRow(r)

    if (d.shops.length) {
      const shops = sheet(workbook, 'By shop', [
        { header: 'Shop', key: 'shop', width: 22 },
        { header: 'Gross revenue (RM)', key: 'revenue', width: 18, money: true },
        { header: 'Fees & deductions (RM)', key: 'deductions', width: 20, money: true },
        { header: 'Net settlement (RM)', key: 'net', width: 18, money: true },
        { header: 'Paid to bank (RM)', key: 'paidToBank', width: 16, money: true },
        { header: 'Pending (RM)', key: 'pending', width: 14, money: true },
      ])
      for (const s of d.shops) shops.addRow(s)
    }
  } else {
    add('Orders shipped', d.shipped)
    add('Orders delivered', d.delivered)
    add('Orders cancelled', d.cancelled)
    add('To pack now', d.toPack)
    add('To pack, waiting over 48 hours', d.toPackLate)
    add('Shipped within 24 hours', d.within24h, PERCENT)
    add('Median hours to ship', d.speed.medianHours)
    add('Median days to deliver', d.deliveryDays)
    summary.addRow({})
    add('Shipping paid by buyers (RM)', d.money.buyerPaid, MONEY)
    add('TikTok shipping subsidy (RM)', d.money.subsidy, MONEY)
    add('Courier cost (RM)', d.money.courierCost, MONEY)
    add('Return shipping (RM)', d.money.returns, MONEY)
    add('Other shipping (RM)', d.money.other, MONEY)
    add('Net shipping cost (RM)', d.money.net, MONEY)

    const couriers = sheet(workbook, 'Couriers', [
      { header: 'Courier', key: 'courier', width: 24 },
      { header: 'Shipped', key: 'shipped', width: 10 },
      { header: 'Delivered', key: 'delivered', width: 10 },
      { header: 'Median days to deliver', key: 'medianDeliveryDays', width: 22 },
    ])
    for (const c of d.couriers) couriers.addRow(c)

    const orders = sheet(workbook, 'Shipped orders', [
      { header: 'Shipped', key: 'shipped', width: 17 },
      { header: 'Shop', key: 'shop', width: 18 },
      { header: 'Order ID', key: 'orderId', width: 22 },
      { header: 'Courier', key: 'courier', width: 18 },
      { header: 'Tracking number', key: 'tracking', width: 22 },
      { header: 'Status', key: 'status', width: 18 },
      { header: 'Hours to ship', key: 'hoursToShip', width: 14 },
      { header: 'Delivered', key: 'delivered', width: 17 },
    ])
    for (const o of d.orders) {
      orders.addRow({ ...o, shipped: myDateTime(o.shippedAt), delivered: myDateTime(o.deliveredAt), courier: o.courier || '', tracking: o.tracking || '' })
    }

    if (d.shops.length) {
      const shops = sheet(workbook, 'By shop', [
        { header: 'Shop', key: 'shop', width: 22 },
        { header: 'Shipped', key: 'shipped', width: 10 },
        { header: 'Delivered', key: 'delivered', width: 10 },
        { header: 'To pack now', key: 'toPack', width: 12 },
        { header: 'Median hours to ship', key: 'medianHours', width: 20 },
      ])
      for (const s of d.shops) shops.addRow(s)
    }
  }

  return Buffer.from(await workbook.xlsx.writeBuffer())
}
