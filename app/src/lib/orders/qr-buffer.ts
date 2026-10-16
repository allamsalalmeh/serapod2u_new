/**
 * Manufacturer buffer for H2M orders, in CASES.
 *
 * Business rules (confirmed):
 *   - Order quantity is in cases; one unique QR code is attached to each case.
 *   - The manufacturer supplies an additional 1% of cases as buffer, so
 *     1,000 ordered cases + 10 buffer cases = 1,010 unique case QR codes.
 *   - Master (box) QR codes are separate and cover the ordered cases only.
 *
 * The rounding is the one QR generation has always used
 * (`generateQRBatch`): floor(total ordered cases × percent ÷ 100) on the order
 * total, then shared across the lines in proportion to their quantity, with
 * whatever the per-line floors leave over going to the first line. Every
 * screen that states a buffer or unique-QR count uses these functions so the
 * figures match the batch that is actually generated.
 */

/** Default buffer percent for a new order, and for an order that has none. */
export const DEFAULT_QR_BUFFER_PERCENT = 1

/**
 * The order's buffer percent. A stored value (including 0) is kept as is;
 * only a missing / invalid value falls back to the 1% default.
 */
export function resolveQrBufferPercent(value: unknown): number {
  if (value === null || value === undefined || value === '') return DEFAULT_QR_BUFFER_PERCENT
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_QR_BUFFER_PERCENT
}

const wholeCases = (value: unknown) => Math.max(0, Math.floor(Number(value) || 0))

/** Buffer cases for an order total: floor(cases × percent ÷ 100). */
export function qrBufferCases(orderedCases: number, bufferPercent: number): number {
  return Math.floor(wholeCases(orderedCases) * (Number(bufferPercent) || 0) / 100)
}

/**
 * Buffer cases per line, exactly as `generateQRBatch` distributes them.
 * The result always sums to `qrBufferCases(total, percent)`.
 */
export function allocateQrBufferCases(lineCases: number[], bufferPercent: number): number[] {
  const qtys = lineCases.map(wholeCases)
  const total = qtys.reduce((sum, qty) => sum + qty, 0)
  const buffer = qrBufferCases(total, bufferPercent)
  let remaining = buffer
  const shares = qtys.map((qty) => {
    if (total === 0) return 0
    const share = Math.min(Math.floor((qty / total) * buffer), remaining)
    remaining -= share
    return share
  })
  if (remaining > 0 && shares.length > 0) shares[0] += remaining
  return shares
}

export interface QrCaseTotals {
  orderedCases: number
  bufferPercent: number
  bufferCases: number
  /** One unique QR per case: ordered + buffer. */
  uniqueCaseQr: number
}

export function qrCaseTotals(orderedCases: number, bufferPercent: unknown): QrCaseTotals {
  const ordered = wholeCases(orderedCases)
  const percent = resolveQrBufferPercent(bufferPercent)
  const bufferCases = qrBufferCases(ordered, percent)
  return { orderedCases: ordered, bufferPercent: percent, bufferCases, uniqueCaseQr: ordered + bufferCases }
}
