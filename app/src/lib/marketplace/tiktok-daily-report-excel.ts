import ExcelJS from 'exceljs'
import type { DailyReport } from './tiktok-daily-report'

function styleHeader(sheet: ExcelJS.Worksheet) {
  const row = sheet.getRow(1)
  row.font = { bold: true }
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } }
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
}

/** Daily report as a workbook: Summary, Items (with variations) and Parcels, one row per shop line. */
export async function buildDailyReportWorkbook(report: DailyReport): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.created = new Date()

  const summary = workbook.addWorksheet('Summary')
  summary.columns = [
    { header: 'Shop', key: 'shop', width: 24 },
    { header: 'Parcels', key: 'parcels', width: 10 },
    { header: 'Items', key: 'items', width: 10 },
    { header: 'Order dates', key: 'orders', width: 26 },
  ]
  for (const shop of report.shops) {
    summary.addRow({
      shop: shop.shop,
      parcels: shop.parcels,
      items: shop.items,
      orders: shop.orderFrom && shop.orderTo && shop.orderFrom !== shop.orderTo ? `${shop.orderFrom} - ${shop.orderTo}` : shop.orderFrom || '',
    })
  }
  summary.addRow({ shop: 'TOTAL', parcels: report.parcels, items: report.items }).font = { bold: true }
  styleHeader(summary)
  summary.addRow([])
  summary.addRow([report.subject])

  const items = workbook.addWorksheet('Items')
  items.columns = [
    { header: 'Shop', key: 'shop', width: 18 },
    { header: 'Item', key: 'item', width: 28 },
    { header: 'Quantity', key: 'quantity', width: 10 },
    { header: 'Variations', key: 'variations', width: 60 },
  ]
  for (const shop of report.shops) {
    for (const row of shop.itemTotals) {
      items.addRow({
        shop: shop.shop,
        item: row.item,
        quantity: row.quantity,
        variations: row.variations.map((v) => `${v.name} ${v.quantity}`).join(', '),
      })
    }
  }
  styleHeader(items)

  const parcels = workbook.addWorksheet('Parcels')
  parcels.columns = [
    { header: 'Shop', key: 'shop', width: 18 },
    { header: 'No', key: 'no', width: 6 },
    { header: 'Order ID', key: 'order', width: 22 },
    { header: 'Package ID', key: 'package', width: 22 },
    { header: 'Status', key: 'status', width: 20 },
    { header: 'Contents', key: 'contents', width: 70 },
  ]
  for (const shop of report.shops) {
    for (const row of shop.parcelRows) {
      parcels.addRow({ shop: shop.shop, no: row.no, order: row.orderId, package: row.packageId || '', status: row.status || '', contents: row.contents })
    }
  }
  styleHeader(parcels)

  return Buffer.from(await workbook.xlsx.writeBuffer())
}
