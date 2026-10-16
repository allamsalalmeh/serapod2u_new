import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { PDFGenerator } from '@/lib/pdf-generator'
import { ClassicTemplate, type TemplateDocumentData, type TemplateOrderData } from '@/lib/pdf-templates'
import { isManufacturerOrgType, purchaseOrderHidesPrices } from './po-price-visibility'

function pdfText(bytes: Buffer): string {
  let content = ''
  let cursor = 0
  while (true) {
    const open = bytes.indexOf('stream', cursor)
    if (open === -1) break
    let start = open + 'stream'.length
    if (bytes[start] === 0x0d) start += 1
    if (bytes[start] === 0x0a) start += 1
    const close = bytes.indexOf('endstream', start)
    if (close === -1) break
    try {
      content += inflateSync(bytes.subarray(start, close)).toString('latin1')
    } catch {
      content += bytes.subarray(start, close).toString('latin1')
    }
    cursor = close + 'endstream'.length
  }
  return [...content.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)].map((m) => m[1]).join('\n')
}

const HQ = { org_name: 'Serapod HQ', org_type_code: 'HQ' }
const MFG = { org_name: 'Cellera Factory', org_type_code: 'MFG' }

const ITEMS = [
  { product: { product_name: 'Cellera Hero', product_code: 'CEL' }, variant: { variant_name: 'Hero [ Honeydew ]' }, qty: 1400, units_per_case: 100, unit_price: 32.5, line_total: 45500 },
  { product: { product_name: 'Cellera Zero', product_code: 'CEL' }, variant: { variant_name: 'Zero [ Almond Corn ]' }, qty: 600, units_per_case: 100, unit_price: 31.25, line_total: 18750 },
]

function orderData(orderType: string) {
  return {
    id: 'order-1',
    order_no: 'ORD-1',
    display_doc_no: 'PO26000001',
    order_type: orderType,
    status: 'approved',
    created_at: '2026-10-01T00:00:00Z',
    buyer_org: HQ,
    seller_org: MFG,
    order_items: ITEMS,
    payment_terms: null,
  }
}

const documentData = (docType: string) => ({
  id: 'doc-1',
  doc_no: 'PO-ORD-1',
  display_doc_no: 'PO26000001',
  doc_type: docType,
  status: 'pending',
  created_at: '2026-10-01T00:00:00Z',
})

async function classic(orderType: string, docType = 'PO'): Promise<string> {
  const title = docType === 'PO' ? 'Purchase Order' : 'Invoice'
  const blob = await new ClassicTemplate([]).generate(
    orderData(orderType) as unknown as TemplateOrderData,
    documentData(docType) as unknown as TemplateDocumentData,
    title,
  )
  return pdfText(Buffer.from(await blob.arrayBuffer()))
}

async function detailed(orderType: string): Promise<string> {
  const blob = await new PDFGenerator([]).generatePurchaseOrderPDF(orderData(orderType) as any, documentData('PO') as any)
  return pdfText(Buffer.from(await blob.arrayBuffer()))
}

describe('purchaseOrderHidesPrices', () => {
  it('hides prices only on an H2M Purchase Order', () => {
    expect(purchaseOrderHidesPrices('H2M', 'PO')).toBe(true)
    expect(purchaseOrderHidesPrices('h2m', 'po')).toBe(true)
    expect(purchaseOrderHidesPrices('H2M', 'INVOICE')).toBe(false)
    expect(purchaseOrderHidesPrices('D2H', 'PO')).toBe(false)
    expect(purchaseOrderHidesPrices('S2D', 'PO')).toBe(false)
    expect(purchaseOrderHidesPrices(null, 'PO')).toBe(false)
  })

  it('recognises manufacturer organizations', () => {
    expect(isManufacturerOrgType('MFG')).toBe(true)
    expect(isManufacturerOrgType('MANU')).toBe(true)
    expect(isManufacturerOrgType('HQ')).toBe(false)
    expect(isManufacturerOrgType(undefined)).toBe(false)
  })
})

describe('H2M Purchase Order PDF has no prices', () => {
  it('classic template: products and quantities, no price, amount or total', async () => {
    const text = await classic('H2M')
    expect(text).toContain('Cellera Hero - [ Honeydew ]')
    expect(text).toContain('1400')
    expect(text).not.toMatch(/\bPrice\b|\bAmount\b|\bTotal\b/)
    expect(text).not.toContain('32.50')
    expect(text).not.toContain('45500')
  })

  it('detailed template: no price columns and no totals', async () => {
    const text = await detailed('H2M')
    expect(text).toContain('Cellera Hero')
    expect(text).toContain('1,400')
    expect(text).not.toMatch(/Price\/Case|Total \(RM\)|GRAND TOTAL|Subtotal/)
    expect(text).not.toContain('45,500')
  })

  it('other order types keep their prices', async () => {
    expect(await classic('D2H')).toMatch(/\bPrice\b/)
    expect(await detailed('S2D')).toMatch(/GRAND TOTAL/)
  })

  it('an H2M invoice keeps its prices', async () => {
    expect(await classic('H2M', 'INVOICE')).toMatch(/\bPrice\b/)
  })
})
