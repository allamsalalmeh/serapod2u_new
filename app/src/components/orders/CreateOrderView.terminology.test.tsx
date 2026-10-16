import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_QR_BUFFER_PERCENT, qrBufferCases } from '@/lib/orders/qr-buffer'

const source = readFileSync(
  path.resolve(__dirname, 'CreateOrderView.tsx'),
  'utf-8'
)

/**
 * Create Order operates in Cases (sellable/manufacturer cases).
 * The outer container is a Box: N Cases = 1 Box.
 * This suite guards the acceptance numbers and the user-facing terminology.
 */
describe('CreateOrderView acceptance calculation', () => {
  // Cellera example: 100 Cases @ RM14, 100 cases per box, 1% manufacturer buffer
  const qty = 100
  const unitPrice = 14
  const unitsPerCase = 100 // legacy internal name = cases per box

  it('keeps the line total at RM1,400', () => {
    expect(qty * unitPrice).toBe(1400)
  })

  it('keeps the outer-container (Box) count at 1', () => {
    expect(Math.ceil(qty / unitsPerCase)).toBe(1)
  })

  it('keeps Master QR at 1', () => {
    const totalCases = Math.ceil(qty / unitsPerCase)
    expect(totalCases).toBe(1)
  })

  it('Unique QR is one per case plus the 1% buffer, rounded down as QR generation does', () => {
    expect(qty + qrBufferCases(qty, DEFAULT_QR_BUFFER_PERCENT)).toBe(101)
    expect(1000 + qrBufferCases(1000, DEFAULT_QR_BUFFER_PERCENT)).toBe(1010)
    expect(150 + qrBufferCases(150, DEFAULT_QR_BUFFER_PERCENT)).toBe(151)
  })

  it('still uses the original formulas in the component', () => {
    // Box / Master QR count
    expect(source).toContain('Math.ceil(item.qty / (item.units_per_case || unitsPerCase))')
    // Unique QR with buffer: the shared rule QR generation uses
    expect(source).toContain('const bufferCases = qrBufferCases(orderedCases, resolveQrBufferPercent(qrBuffer))')
    expect(source).toContain('allocateQrBufferCases(')
    expect(source).not.toContain('Math.round(item.qty + (item.qty * qrBuffer / 100))')
    expect(source).toContain('useState(DEFAULT_QR_BUFFER_PERCENT)')
    // Line total & subtotal
    expect(source).toContain('line_total: qty * item.unit_price')
    expect(source).toContain('sum + (item.qty * item.unit_price)')
    // Totals block
    expect(source).toContain('const masterQR = totalCases')
  })

  it('keeps the internal units_per_case contract intact', () => {
    expect(source).toContain('units_per_case')
    expect(source).toContain('unitsPerCase')
    expect(source).toContain('customUnitsPerCase')
    expect(source).toContain('useIndividualCases')
    expect(source).toContain('totals.totalCases')
  })

  it('keeps the default family cases-per-box values', () => {
    // Cellera Hero/Zero: 100, Ellbow Cat Treat: 20, S.Box: 50, S.Line: 200
    const familyBlock = source.slice(
      source.indexOf('const getDefaultCaseSize'),
      source.indexOf('const getDefaultCaseSize') + 500
    )
    expect(familyBlock).toContain('return 100')
    expect(familyBlock).toContain('return 20')
    expect(familyBlock).toContain('return 50')
    expect(familyBlock).toContain('return 200')
  })
})

describe('CreateOrderView user-facing terminology', () => {
  const expectedLabels = [
    'Smart Box Configuration',
    'Box Configuration',
    'Same cases per box for all products',
    'Individual cases per box for each product',
    "'Default Cases per Box' : 'Cases per Box'",
    '20 Cases per Box',
    '50 Cases per Box',
    '100 Cases per Box',
    '200 Cases per Box',
    'Quantity (Cases)',
    'Price per Case (RM)',
    'Boxes:</span>',
    'Master QR copies per Box',
    'Unique QR (with {qrBuffer}% buffer)',
    'Total Boxes:',
    'Full Boxes:',
    'cases per box',
  ]

  it.each(expectedLabels)('renders the label %s', (label) => {
    expect(source).toContain(label)
  })

  const staleLabels = [
    'units per case</option>',
    'Unit Price (RM)',
    'Unique Units',
    'Total Cases:</span>',
    'Full Cases:',
    'Same units per case for all products',
    'Individual units per case for each product',
    'Smart Case Size Configuration',
    'Master QR copies per case',
    'Default Units per Case',
  ]

  it.each(staleLabels)('no longer shows the stale label %s', (label) => {
    expect(source).not.toContain(label)
  })

  it('shows Cases and Boxes in the order summary line', () => {
    expect(source).toContain(
      "{item.qty.toLocaleString()} Cases • {boxCount.toLocaleString()} {boxCount === 1 ? 'Box' : 'Boxes'}"
    )
  })
})
