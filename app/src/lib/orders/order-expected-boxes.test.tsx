import { Buffer } from 'node:buffer'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { formatExpectedDelivery, formatOrderExpectedBoxes } from './packaging'
import { ClassicTemplate, type TemplateDocumentData, type TemplateOrderData } from '@/lib/pdf-templates'

const line = (variant: string, qty: number, unitPrice = 14, units_per_case?: number) => ({
  product: { product_name: 'Cellera Hero', product_code: 'CEL' },
  variant: { variant_name: `Fruity Cellera Cartridge [ ${variant} ]` },
  qty,
  unit_price: unitPrice,
  line_total: qty * unitPrice,
  ...(units_per_case ? { units_per_case } : {}),
})

describe('Expected Boxes (H2M / D2H) reuses the SO Standard/Small Box rule', () => {
  it('exact multiple', () => {
    expect(formatOrderExpectedBoxes([{ qty: 1000 }], 100)).toBe('10 Standard Boxes')
  })

  it('remainder goes into one Small Box', () => {
    expect(formatOrderExpectedBoxes([{ qty: 5550 }], 100)).toBe('55 Standard Boxes + 1 Small Box')
    expect(formatOrderExpectedBoxes([{ qty: 50 }], 100)).toBe('1 Small Box')
  })

  it('multiple variants are boxed from the order total, as the SO does', () => {
    const lines = [{ qty: 450 }, { qty: 350 }, { qty: 250 }]
    expect(formatOrderExpectedBoxes(lines, 100)).toBe('10 Standard Boxes + 1 Small Box')
    expect(formatOrderExpectedBoxes(lines, 100)).toBe(formatExpectedDelivery(1050, 100))
  })

  it('uses the box size the lines agree on, else the order setting', () => {
    expect(formatOrderExpectedBoxes([{ qty: 600, units_per_case: 50 }, { qty: 20, units_per_case: 50 }], 100)).toBe(
      '12 Standard Boxes + 1 Small Box',
    )
    expect(formatOrderExpectedBoxes([{ qty: 600, units_per_case: 50 }, { qty: 400, units_per_case: 200 }], 100)).toBe(
      '10 Standard Boxes',
    )
    expect(formatOrderExpectedBoxes([{ qty: 1000 }], null)).toBe('10 Standard Boxes')
  })

  it('boxes ordered cases only; the buffer is not added', () => {
    // 1,000 ordered + 10 buffer cases is still 10 Standard Boxes, not "+ 1 Small Box".
    expect(formatOrderExpectedBoxes([{ qty: 1000 }], 100)).toBe('10 Standard Boxes')
  })
})

// --- Classic PDF -------------------------------------------------------------

function pdfText(bytes: Buffer): string[] {
  const raw = bytes.toString('latin1')
  let content = ''
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const data = Buffer.from(match[1], 'latin1')
    try {
      content += inflateSync(data).toString('latin1')
    } catch {
      content += match[1]
    }
  }
  return [...content.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)].map((m) => m[1].replace(/\\([()\\])/g, '$1'))
}

const ORG = { org_name: 'Serapod Sdn Bhd', org_type_code: 'HQ' }

async function render(orderType: string, docType: string, items: any[], qrBufferPercent: number | null = 1) {
  const orderData = {
    order_no: 'ORD26000106',
    order_type: orderType,
    status: 'approved',
    created_at: '2026-10-01T00:00:00Z',
    buyer_org: ORG,
    seller_org: { org_name: 'Manufacturer Sdn Bhd', org_type_code: 'MFG' },
    order_items: items,
    units_per_case: 100,
    qr_buffer_percent: qrBufferPercent,
    organization_terms: 'Payment within 30 days.',
  } as unknown as TemplateOrderData
  const documentData = {
    doc_no: `${docType}26000106`,
    display_doc_no: `${docType}26000106`,
    doc_type: docType,
    status: 'approved',
    created_at: '2026-10-01T00:00:00Z',
  } as TemplateDocumentData
  const blob = await new ClassicTemplate([]).generate(orderData, documentData, 'Purchase Order')
  return pdfText(Buffer.from(await blob.arrayBuffer()))
}

describe('classic PO PDF for H2M / D2H orders', () => {
  it('H2M: "Grand Total | 1,000 | RM 14,000.00", then Expected Boxes and the buffer', async () => {
    const text = await render('H2M', 'PO', [line('Honeydew', 1000)])
    const label = text.indexOf('Grand Total')
    expect(label).toBeGreaterThan(-1)
    expect(text[label + 1]).toBe('1,000')
    expect(text[label + 2]).toBe('RM 14,000.00')
    expect(text).not.toContain('Total')

    const heading = text.indexOf('Expected Boxes:')
    expect(heading).toBeGreaterThan(label)
    expect(text[heading + 1]).toBe('10 Standard Boxes')
    expect(text[heading + 2]).toBe('Manufacturer buffer: 10 cases (1%), not included in Expected Boxes')
  })

  it('D2H: remainder and multiple variants, no manufacturer buffer line', async () => {
    const text = await render('D2H', 'PO', [line('Honeydew', 3000), line('Mango', 2550)])
    const label = text.indexOf('Grand Total')
    expect(text[label + 1]).toBe('5,550')
    const heading = text.indexOf('Expected Boxes:')
    expect(text[heading + 1]).toBe('55 Standard Boxes + 1 Small Box')
    expect(text.join('\n')).not.toContain('Manufacturer buffer')
  })

  it('agrees with the shared helper the order page uses', async () => {
    const items = [line('Honeydew', 450), line('Mango', 350), line('Almond', 250)]
    const text = await render('H2M', 'PO', items)
    expect(text[text.indexOf('Expected Boxes:') + 1]).toBe(formatOrderExpectedBoxes(items, 100))
  })

  it('a Sales Order document keeps its Total / Expected Delivery layout', async () => {
    const text = await render('H2M', 'SO', [line('Honeydew', 1000)])
    expect(text).toContain('Total')
    expect(text).not.toContain('Grand Total')
    expect(text).toContain('Expected Delivery:')
    expect(text).not.toContain('Expected Boxes:')
  })
})
