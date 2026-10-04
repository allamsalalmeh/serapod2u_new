import { describe, expect, it } from 'vitest'
import {
  DEFAULT_QR_BUFFER_PERCENT,
  allocateQrBufferCases,
  qrBufferCases,
  qrCaseTotals,
  resolveQrBufferPercent,
} from './qr-buffer'
import { generateQRBatch } from '@/lib/qr-generator'

const item = (code: string, qty: number, unitsPerCase = 100) => ({
  product_id: `p-${code}`,
  variant_id: `v-${code}`,
  product_code: 'CEL',
  variant_code: code,
  product_name: 'Cellera Hero',
  variant_name: code,
  qty,
  units_per_case: unitsPerCase,
})

// Same inputs the generate route and the worker pass.
const generate = (items: ReturnType<typeof item>[], bufferPercent: number) =>
  generateQRBatch({
    orderNo: 'ORD26000106',
    manufacturerCode: 'MFG01',
    orderItems: items,
    bufferPercent,
    unitsPerCase: 100,
    useIndividualCaseSizes: true,
  })

describe('manufacturer buffer (cases)', () => {
  it('1,000 ordered cases -> 10 buffer cases -> 1,010 unique case QR codes', () => {
    expect(qrCaseTotals(1000, 1)).toEqual({ orderedCases: 1000, bufferPercent: 1, bufferCases: 10, uniqueCaseQr: 1010 })
  })

  it('defaults to 1% only when no percent is stored', () => {
    expect(DEFAULT_QR_BUFFER_PERCENT).toBe(1)
    expect(resolveQrBufferPercent(null)).toBe(1)
    expect(resolveQrBufferPercent(undefined)).toBe(1)
    expect(resolveQrBufferPercent(Number.NaN)).toBe(1)
    expect(resolveQrBufferPercent(0)).toBe(0)
    expect(resolveQrBufferPercent(10)).toBe(10)
    expect(resolveQrBufferPercent('1.00')).toBe(1)
  })

  it('rounds a fractional 1% down, as QR generation always has', () => {
    expect(qrBufferCases(99, 1)).toBe(0)
    expect(qrBufferCases(150, 1)).toBe(1)
    expect(qrBufferCases(250, 1)).toBe(2)
    expect(qrBufferCases(1099, 1)).toBe(10)
  })

  it('never multiplies cases by pieces per case', () => {
    // 1,000 cases of 4 pcs is still 1,010 case QR codes, not 4,040.
    expect(qrCaseTotals(1000, 1).uniqueCaseQr).toBe(1010)
  })
})

describe('generateQRBatch with the 1% rule', () => {
  it('1,000 cases: 1,010 unique case codes (10 buffer, unboxed) and 10 master codes', () => {
    const batch = generate([item('HONEYDEW', 1000)], 1)

    expect(batch.totalBaseUnits).toBe(1000)
    expect(batch.totalUniqueCodes).toBe(1010)
    expect(batch.individualCodes).toHaveLength(1010)
    const buffer = batch.individualCodes.filter((code) => code.is_buffer)
    expect(buffer).toHaveLength(10)
    expect(buffer.every((code) => code.case_number === 0)).toBe(true)
    // Master (box) QR codes are counted separately, from ordered cases only.
    expect(batch.totalMasterCodes).toBe(10)
    expect(batch.masterCodes.reduce((sum, m) => sum + m.expected_unit_count, 0)).toBe(1000)
  })

  it('codes are unique', () => {
    const batch = generate([item('HONEYDEW', 1000)], 1)
    expect(new Set(batch.individualCodes.map((c) => c.code)).size).toBe(1010)
    expect(new Set(batch.masterCodes.map((c) => c.code)).size).toBe(10)
  })

  it('splits the buffer across variants exactly as allocateQrBufferCases states', () => {
    const items = [item('HONEYDEW', 450), item('MANGO', 350), item('ALMOND', 250)]
    const batch = generate(items, 1)
    const perVariant = items.map(
      (line) => batch.individualCodes.filter((c) => c.is_buffer && c.variant_code === line.variant_code).length,
    )

    expect(perVariant).toEqual(allocateQrBufferCases(items.map((line) => line.qty), 1))
    expect(perVariant.reduce((a, b) => a + b, 0)).toBe(10) // floor(1,050 × 1%)
    expect(batch.totalUniqueCodes).toBe(1060)
  })

  it('is deterministic, so a resumed worker regenerates the same codes', () => {
    const a = generate([item('HONEYDEW', 300), item('MANGO', 120)], 1)
    const b = generate([item('HONEYDEW', 300), item('MANGO', 120)], 1)
    expect(a.individualCodes.map((c) => c.code)).toEqual(b.individualCodes.map((c) => c.code))
  })

  it('keeps a batch created at 10% at 10% (historical batches unchanged)', () => {
    expect(generate([item('HONEYDEW', 1000)], 10).totalUniqueCodes).toBe(1100)
  })
})
