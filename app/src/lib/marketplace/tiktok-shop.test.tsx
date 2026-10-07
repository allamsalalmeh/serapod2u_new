import fs from 'node:fs'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { readXlsx, type XlsxSheet } from './xlsx-lite'
import { detectTikTokFile, normalizeHeader, parseTikTokOrders, parseTikTokSettlements, parseTikTokTime } from './tiktok-shop'

function zip(files: Record<string, string>) {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(content, 'utf8'))
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8)
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(Buffer.byteLength(content), 22); local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10)
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(Buffer.byteLength(content), 24); central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, data)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(files).length, 8); eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const col = (i: number) => String.fromCharCode(65 + (i % 26)).padStart(i >= 26 ? 2 : 1, String.fromCharCode(64 + Math.floor(i / 26)))

/** Writes every cell in its own <row>, like TikTok Seller Center does. */
function workbook(sheets: Record<string, string[][]>) {
  const names = Object.keys(sheets)
  const files: Record<string, string> = {
    'xl/workbook.xml': `<workbook xmlns:r="r"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships>${names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="ws" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
    'xl/sharedStrings.xml': '<sst><si><t>Shared &amp; text</t></si></sst>',
  }
  names.forEach((n, s) => {
    const cells = sheets[n].flatMap((r, ri) => r.map((v, ci) => `<row r="${ri + 1}"><c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c></row>`))
    files[`xl/worksheets/sheet${s + 1}.xml`] = `<worksheet><sheetData>${cells.join('')}</sheetData></worksheet>`
  })
  return files
}

const ORDER_HEADER = ['Order ID', 'Order Status', 'Order Substatus', 'Cancelation/Return Type', 'SKU ID', 'Seller SKU', 'Product Name', 'Variation', 'Quantity', 'Sku Quantity of return', 'SKU Unit Original Price', 'SKU Subtotal After Discount', 'Order Amount', 'Order Refund Amount', 'Created Time', 'Paid Time', 'Delivered Time', 'Buyer Username', 'Recipient', 'Phone #', 'Zipcode', 'State', 'Detail Address', 'Tracking ID', 'Weight(kg)']
const orderRow = (id: string, sku: string, status = 'Completed', created = '30/09/2026 22:58:49') =>
  [id, status, '', '', sku, 'COMBO-HB(2)', 'Moonchair', 'Default', '1', '0', '145', '130.50', '137.40', '0', created, '30/09/2026 22:59:32', '', 'buyer_x', 'Ali', '(+60)123', '43000', 'Selangor', '1 Jalan A', 'TRK1', '4']
const description = ['Platform unique order ID.', 'Current order status.', ...Array(ORDER_HEADER.length - 2).fill('')]

const SETTLE_HEADER = ['Order/Adjustment ID', 'Transaction type', 'Order created time', 'Order settled time', 'Currency', 'Total settlement amount', 'Total Revenue', 'Total Fees', 'Transaction fee', 'TikTok Shop commission fee', 'Credit card instalment - Handling fee', 'GMV Max voucher', '', 'Customer payment', 'Estimated parcel weight', "Customer's bank for payment"]
const settleRow = (id: string, settled: string, total: string, fee = '-4.29') => [id, 'Order', '2026/09/30', settled, 'MYR', total, '104', String(Number(total) - 104), fee, '-8.42', '0', '0', '', '110.38', '9690', 'Maybank']
const reports = (total: string) => [['', '', ''], ['', 'Time period', '2026/09/04-2026/10/05'], ['', 'Currency', 'MYR'], ['', 'Total settlement amount', total]]
const withdrawals = [['Transaction type', 'Reference ID', 'Request time', 'Amount', 'Status', 'Success time', 'Bank account'], ['Earnings', '9000000000006189', '2026/10/05', '179.27', 'Transferred', '2026/10/05', '/']]

const read = (sheets: Record<string, string[][]>): XlsxSheet[] => readXlsx(zip(workbook(sheets)))

describe('xlsx reader', () => {
  it('places cells by reference even when each cell has its own row element', () => {
    const files = workbook({ OrderSKUList: [['Order ID', 'Order Status'], ['5800000000000001', 'Completed']] })
    files['xl/worksheets/sheet1.xml'] = files['xl/worksheets/sheet1.xml'].replace('</sheetData>', '<row r="3"><c r="B3" t="s"><v>0</v></c></row><row r="3"><c r="A3" t="str"><v>5800000000000002</v></c></row></sheetData>')
    const [sheet] = readXlsx(zip(files))
    expect(sheet.name).toBe('OrderSKUList')
    expect(sheet.rows).toEqual([['Order ID', 'Order Status'], ['5800000000000001', 'Completed'], ['5800000000000002', 'Shared & text']])
  })

  it('refuses something that is not an Excel file', () => {
    expect(() => readXlsx(Buffer.from('Order ID,Status\n1,2'))).toThrow(/Excel/)
  })
})

describe('TikTok orders file', () => {
  it('reads order lines without any customer personal data', () => {
    const sheets = read({ OrderSKUList: [ORDER_HEADER, description, orderRow('5800000000000001', '1729000000000157'), orderRow('5800000000000002', '1729000000000157', 'Shipped', '01/09/2026 08:00:00')] })
    expect(detectTikTokFile(sheets)).toBe('orders')
    const { errors, value } = parseTikTokOrders(sheets)
    expect(errors).toEqual([])
    expect(value?.lines).toHaveLength(2)
    expect(value?.periodStart).toBe('2026-09-01')
    expect(value?.periodEnd).toBe('2026-09-30')
    const row = value!.lines[0].row
    expect(row).toMatchObject({ order_status: 'Completed', quantity: 1, unit_original_price: '145.00', order_amount: '137.40', buyer_state: 'Selangor', created_time: '2026-09-30T22:58:49+08:00' })
    expect(JSON.stringify(value)).not.toMatch(/buyer_x|Ali|\(\+60\)|43000|Jalan|TRK1/)
  })

  it('changes the line fingerprint when the status changes, so a later file updates it', () => {
    const a = parseTikTokOrders(read({ OrderSKUList: [ORDER_HEADER, orderRow('5800000000000001', '1', 'Shipped')] })).value!
    const b = parseTikTokOrders(read({ OrderSKUList: [ORDER_HEADER, orderRow('5800000000000001', '1', 'Completed')] })).value!
    const c = parseTikTokOrders(read({ OrderSKUList: [ORDER_HEADER, orderRow('5800000000000001', '1', 'Completed')] })).value!
    expect(a.lines[0].contentHash).not.toBe(b.lines[0].contentHash)
    expect(b.lines[0].contentHash).toBe(c.lines[0].contentHash)
  })

  it('refuses IDs changed by Excel and duplicate lines', () => {
    expect(parseTikTokOrders(read({ OrderSKUList: [ORDER_HEADER, orderRow('5.8E+17', '1')] })).errors[0]).toMatch(/changed by Excel/)
    expect(parseTikTokOrders(read({ OrderSKUList: [ORDER_HEADER, orderRow('5800000000000001', '1'), orderRow('5800000000000001', '1')] })).errors[0]).toMatch(/same SKU twice/)
    expect(parseTikTokTime('2026-09-30 10:00')).toBe('invalid')
  })
})

describe('TikTok transaction file', () => {
  it('checks the rows against the report total and keeps a second settlement of the same order', () => {
    const sheets = read({
      'Order details': [SETTLE_HEADER, settleRow('5800000000008900', '2026/10/02', '76.99'), settleRow('5800000000008900', '2026/10/03', '2.01', '0'), settleRow('5800000000008900', '2026/10/03', '1.00', '0')],
      Reports: reports('80.00'),
      'Withdrawal records': withdrawals,
    })
    expect(detectTikTokFile(sheets)).toBe('settlements')
    const { errors, value } = parseTikTokSettlements(sheets)
    expect(errors).toEqual([])
    expect(value?.settlements.map(s => s.dedupeKey)).toEqual([
      '5800000000008900|Order|2026-10-02|1',
      '5800000000008900|Order|2026-10-03|1',
      '5800000000008900|Order|2026-10-03|2',
    ])
    expect(value?.periodStart).toBe('2026-09-04')
    expect(value?.payouts[0].row).toEqual({ reference_id: '9000000000006189', transaction_type: 'Earnings', request_date: '2026-10-05', amount: '179.27', status: 'Transferred', success_date: '2026-10-05' })
    const fees = value!.settlements[0].row.fee_breakdown as Record<string, number>
    expect(fees).toEqual({ transaction_fee: -4.29, tiktok_shop_commission_fee: -8.42 })
    expect(JSON.stringify(value)).not.toMatch(/Maybank|9690/)
  })

  it('refuses a file whose rows do not add up to the report total', () => {
    const { errors } = parseTikTokSettlements(read({ 'Order details': [SETTLE_HEADER, settleRow('5800000000008900', '2026/10/02', '76.99')], Reports: reports('99.00') }))
    expect(errors[0]).toMatch(/add up to 76.99.*report total is 99.00/)
  })

  it('treats renamed TikTok columns as the same fee', () => {
    expect(normalizeHeader('Credit card instalment - Handling fee')).toBe(normalizeHeader('Credit card installment - Handling fee'))
    expect(normalizeHeader('GMV Max voucher')).toBe(normalizeHeader('GMV Max coupon'))
    expect(normalizeHeader('EAMS Programme service fee')).toBe('eams_program_service_fee')
  })
})

describe('TikTok Shop migration', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../../../../supabase/migrations/20261006110000_tiktok_shop_import.sql'), 'utf8').toLowerCase()

  it('keeps one row per order line, settlement and payout', () => {
    expect(sql).toContain('unique (shop_id, order_id, sku_id)')
    expect(sql).toContain('unique (shop_id, dedupe_key)')
    expect(sql).toContain('unique (shop_id, reference_id, transaction_type)')
  })

  it('has no columns for customer personal data and no direct app access', () => {
    expect(sql).not.toMatch(/^\s+(recipient|phone|buyer_username|detail_address|zipcode|tracking_id|buyer_message|seller_note)\b/m)
    for (const t of ['marketplace_shops', 'marketplace_imports', 'marketplace_order_lines', 'marketplace_settlements', 'marketplace_payouts']) {
      expect(sql).toContain(`alter table public.${t} enable row level security`)
      expect(sql).toContain(`revoke all on table public.${t} from public, anon, authenticated`)
    }
    expect(sql).not.toMatch(/grant [^;]* to authenticated/)
    expect(sql).not.toContain('create policy')
  })
})
