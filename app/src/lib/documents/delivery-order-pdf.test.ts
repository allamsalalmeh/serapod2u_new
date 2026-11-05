import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { constants, inflateSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { ClassicTemplate } from '@/lib/pdf-templates'
import { PDFGenerator } from '@/lib/pdf-generator'
import { STANDARD_DELIVERY_NOTES, buildDeliveryAcknowledgement, buildDeliveryLines, parseOrderDeliveryNotes, relatedSalesOrderNo, resolveDeliveryRecipient } from './delivery-order-content'

vi.spyOn(console, 'error').mockImplementation(() => {})

const buyer = { org_name: 'GM Vape', org_type_code: 'DIST', address: '1 Org Street', city: 'Bedong', postal_code: '08100', contact_name: 'Org Contact', contact_phone: '+60100000000', contact_email: 'org@example.test' }
const seller = { org_name: 'Serapod Technology Sdn Bhd', org_type_code: 'HQ', address: 'No 4 Tingkat 1', contact_email: 'seller@example.test' }
const line = (product: string, variant: string, qty: number) => ({ qty, unit_price: 32, line_total: qty * 32, product: { product_name: product, product_code: 'P' }, variant: { variant_name: variant } })
const order = (over: Record<string, unknown> = {}): any => ({
  order_no: 'ORD-DH-0926-07',
  display_doc_no: 'SO26000150',
  order_type: 'D2H',
  status: 'approved',
  created_at: '2026-09-10T10:07:10Z',
  notes: 'Customer: Nasrul, Phone: +601110546094, Address: 288, Lorong 13, Taman Desa Aman',
  payment_terms: { deposit_percent: 50, balance_percent: 50 },
  organization_terms: 'Payment to be made to: Hong Leong Islamic Bank 2260 1019 821. Email the remittance slip.',
  buyer_org: buyer,
  seller_org: seller,
  creator: { full_name: 'Edi' },
  approver: { full_name: 'Approver Name' },
  order_items: [line('Cellera Zero', 'Zero Edition Novella [ Strawberry Vanilla ]', 100), line('Cellera Hero', 'Deluxe Cellera Cartridge [ Keladi ]', 100)],
  ...over,
})
const deliveryOrder = (over: Record<string, unknown> = {}): any => ({
  doc_no: 'DO-ORD-DH-0926-07',
  display_doc_no: 'DO26000150',
  doc_type: 'DO',
  status: 'pending',
  created_at: '2026-09-10T10:07:10Z',
  prepared_by: { full_name: 'Admin Dev', signature_image: null },
  ...over,
})
const FORBIDDEN = ['Price', 'Amount', 'RM ', '32.00', '3200', '6,400', 'Payment', 'Bank', '2260', 'remittance', 'TERMS', 'Ledger', 'PO#', 'Not available']

/** The text a PDF draws, read back from the file itself: its page streams are inflated and the text operators collected. */
async function pdfText(blob: Blob): Promise<{ text: string; pages: number }> {
  const raw = Buffer.from(await blob.arrayBuffer()).toString('latin1')
  const streams = [...raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)].map((m) => {
    try {
      return inflateSync(Buffer.from(m[1], 'latin1'), { finishFlush: constants.Z_SYNC_FLUSH }).toString('latin1')
    } catch {
      return ''
    }
  })
  const text = streams
    .flatMap((stream) => [...stream.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)].map((m) => m[1].replace(/\\([()\\])/g, '$1')))
    .join('\n')
  return { text, pages: (raw.match(/\/Type \/Page\b(?!s)/g) || []).length }
}
const classic = async (o: any = order(), d: any = deliveryOrder(), title = 'Delivery Order') =>
  pdfText(await new ClassicTemplate([]).generate(o, d, title))
const detailed = async (o: any = order(), d: any = deliveryOrder()) => pdfText(await new PDFGenerator([]).generateDeliveryOrderPDF(o, d))

describe('delivery order content', () => {
  it('reads the delivery details the order form stores in its notes', () => {
    expect(parseOrderDeliveryNotes('Customer: Ali, Phone: 012, Address: 1, Jalan A, KL')).toEqual({ contactName: 'Ali', phone: '012', address: '1, Jalan A, KL', remarks: null })
    expect(parseOrderDeliveryNotes('Customer: , Phone: , Address: ')).toEqual({ contactName: null, phone: null, address: null, remarks: null })
  })

  it('treats anything else in the notes as a remark, and nothing as nothing', () => {
    expect(parseOrderDeliveryNotes('Deliver before noon').remarks).toBe('Deliver before noon')
    expect(parseOrderDeliveryNotes(null)).toEqual({ contactName: null, phone: null, address: null, remarks: null })
  })

  it('names the distributor, with the order address first and the organization as fallback', () => {
    const fromNotes = resolveDeliveryRecipient(order())
    expect(fromNotes).toMatchObject({ label: 'Distributor:', name: 'GM VAPE' })
    expect(fromNotes.detailLines).toEqual(['288, Lorong 13, Taman Desa Aman', 'Attn: Nasrul', 'Tel: +601110546094'])
    const fromOrg = resolveDeliveryRecipient(order({ notes: null }))
    expect(fromOrg.detailLines).toContain('1 Org Street')
    expect(fromOrg.detailLines).toContain('Attn: Org Contact')
    expect(fromOrg.detailLines.join()).not.toContain('org@example.test')
  })

  it('leaves out contact lines nobody stored', () => {
    const lines = resolveDeliveryRecipient({ buyer_org: { org_name: 'X', address: '1 Road' }, notes: null }).detailLines
    expect(lines).toEqual(['1 Road'])
  })

  it('lists variants and quantities in the Sales Order sequence, with the total', () => {
    const { rows, totalQuantity } = buildDeliveryLines(order({ order_items: [line('Cellera Zero', 'Z [ A ]', 1), line('Cellera Hero', 'H [ B ]', 1250)] }).order_items)
    expect(rows).toEqual([
      { no: '1', description: 'Cellera Hero - [ B ]', quantity: '1,250', unit: 'Cases' },
      { no: '2', description: 'Cellera Zero - [ A ]', quantity: '1', unit: 'Case' },
    ])
    expect(totalQuantity).toBe('1,251')
  })

  it('fills acknowledgement fields only from records', () => {
    expect(buildDeliveryAcknowledgement({ created_at: '2026-09-10' })).toEqual([
      { label: 'Prepared By:', name: '', signatureImage: null, date: null },
      { label: 'Delivered By:', name: '', signatureImage: null, date: null },
      { label: 'Received By:', name: '', signatureImage: null, date: null },
    ])
    const [prepared, delivered, received] = buildDeliveryAcknowledgement({
      created_at: '2026-09-10', acknowledged_at: '2026-09-12',
      prepared_by: { full_name: 'Admin Dev', signature_image: 'img-1' },
      acknowledger: { full_name: 'Nasrul' }, acknowledger_signature_image: 'img-2',
    })
    expect(prepared).toMatchObject({ name: 'Admin Dev', signatureImage: 'img-1', date: '2026-09-10' })
    expect(delivered).toMatchObject({ name: '', signatureImage: null, date: null })
    expect(received).toMatchObject({ name: 'Nasrul', signatureImage: 'img-2', date: '2026-09-12' })
  })

  it('names the related Sales Order by its display number', () => {
    expect(relatedSalesOrderNo({ display_doc_no: 'SO26000150', order_no: 'ORD-1' })).toBe('SO26000150')
    expect(relatedSalesOrderNo({ order_no: 'ORD-1' })).toBe('ORD-1')
  })
})

describe.each([['classic template', classic], ['detailed generator', detailed]] as const)('Delivery Order PDF: %s', (_name, render) => {
  it('shows the delivery header, recipient, lines and total', async () => {
    const { text } = await render()
    for (const expected of ['DELIVERY ORDER', 'DO No.:', 'DO26000150', 'DO Date:', 'Sales Order:', 'SO26000150', 'Prepared By', 'Admin Dev', 'PENDING', 'GM VAPE', '288, Lorong 13, Taman Desa Aman', 'Attn: Nasrul', 'Tel: +601110546094', 'Product Description', 'Quantity', 'Unit', 'Cellera Hero - [ Keladi ]', 'Cellera Zero - [ Strawberry Vanilla ]', 'Total Quantity', '200', 'Delivered By', 'Received By']) {
      expect(text).toContain(expected)
    }
  })

  it('carries no price, payment or bank information', async () => {
    const { text } = await render()
    FORBIDDEN.forEach((word) => expect(text).not.toContain(word))
  })

  it('always prints the standard delivery notes, after the total', async () => {
    const { text } = await render()
    STANDARD_DELIVERY_NOTES.forEach((note) => expect(text).toContain(note))
    expect(text.indexOf('Total Quantity')).toBeLessThan(text.indexOf('DELIVERY NOTES'))
  })

  it('adds a free-text order note below the standard ones', async () => {
    const { text } = await render(order({ notes: 'Deliver before noon' }))
    expect(text.indexOf(STANDARD_DELIVERY_NOTES[2])).toBeLessThan(text.indexOf('Deliver before noon'))
    expect(text).toContain('Deliver before noon')
  })

  it('invents nothing when records are missing', async () => {
    const { text } = await render(order({ notes: null, buyer_org: { org_name: 'GM Vape' } }), deliveryOrder({ prepared_by: null }))
    for (const invented of ['Not available', 'Attn:', 'Tel:', 'Estimated ETA', '30 Oct 2025', 'Admin Dev', 'Edi']) expect(text).not.toContain(invented)
  })

  it('shows the recorded acknowledgement as Received By', async () => {
    const { text } = await render(order(), deliveryOrder({ status: 'acknowledged', acknowledged_at: '2026-09-12T02:00:00Z', acknowledger: { full_name: 'Received Person' } }))
    expect(text).toContain('Received Person')
    expect(text).toContain('ACKNOWLEDGED')
  })

  it('runs onto further pages with every line, the total and the acknowledgement intact', async () => {
    const items = Array.from({ length: 70 }, (_, i) => line(i % 2 ? 'Cellera Zero' : 'Cellera Hero', `Range [ Flavour ${i + 1} ]`, 10))
    const { text, pages } = await render(order({ order_items: items }))
    expect(pages).toBeGreaterThan(1)
    for (let i = 1; i <= 70; i++) expect(text).toContain(`Flavour ${i} ]`)
    expect(text).toContain('700')
    expect(text).toContain('Received By')
  })
})

describe('Delivery Order PDF: long values', () => {
  const longName = 'Muhammad Farhan Bin PAA Mohd Farok Abdullah'

  it('wraps a long name inside its footer column and a long address clear of the status box', async () => {
    const { text } = await classic(
      order({ notes: `Customer: A, Phone: 1, Address: ${'Long delivery address words '.repeat(6)}` }),
      deliveryOrder({ prepared_by: { full_name: longName } })
    )
    expect(text).not.toContain(longName)
    expect(text).toContain('Muhammad Farhan Bin')
    expect(text).toContain('Abdullah')
    expect(text).not.toContain('Long delivery address words '.repeat(4).trim())
  })
})

describe('other documents are untouched', () => {
  const invoice = { doc_no: 'SI-1', display_doc_no: 'SI26000150-01', doc_type: 'INVOICE', status: 'pending', created_at: '2026-09-10T10:07:10Z' }

  it('the invoice keeps its prices, terms and footer', async () => {
    const { text } = await classic(order(), invoice, 'Invoice')
    for (const expected of ['INVOICE', 'PO#:', 'Ledger:', 'Price', 'Amount', 'RM 3200.00', 'Grand Total', 'TERMS & CONDITIONS', 'Hong Leong', 'Created by:', 'Approved by:', 'APPROVED']) expect(text).toContain(expected)
    for (const absent of ['Prepared By', 'Delivered By', 'Total Quantity', 'DELIVERY STATUS']) expect(text).not.toContain(absent)
  })

  it('the sales order keeps its prices and terms', async () => {
    const { text } = await classic(order(), { ...invoice, doc_type: 'SO', display_doc_no: 'SO26000150' }, 'Sales Order')
    for (const expected of ['SALES ORDER', 'Price', 'TERMS & CONDITIONS', 'Expected Delivery:']) expect(text).toContain(expected)
  })
})

describe('every Delivery Order path', () => {
  const route = readFileSync(join(process.cwd(), 'src/app/api/documents/generate/route.ts'), 'utf8')

  it('never serves or stores a cached copy, which could predate this content', () => {
    expect(route).toContain("const cacheable = type !== 'delivery_order'")
    expect(route).toContain('if (cacheable && !noCache && documentId)')
    expect(route).toContain('if (cacheable && documentId && buffer)')
  })
})
