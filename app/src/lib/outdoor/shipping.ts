/** What the Outdoor customer pays when the product has no delivery price of its own. */
export const OUTDOOR_FLAT_SHIPPING_RM = 2

/** Orders at or above this subtotal ship free. null keeps the product rates. */
export const OUTDOOR_FREE_SHIPPING_OVER_RM: number | null = null

export const OUTDOOR_SHIPPING_TITLE = 'Standard delivery'
export const OUTDOOR_SHIPPING_NOTE = 'One rate for every address in Malaysia. We arrange the courier.'
export const OUTDOOR_FREE_SHIPPING_TITLE = 'Free shipping'
export const OUTDOOR_FREE_SHIPPING_NOTE = 'We cover delivery anywhere in Malaysia.'

export type OutdoorShippingRow = {
  outdoor_shipping_title?: string | null
  outdoor_shipping_note?: string | null
  outdoor_shipping_price?: number | string | null
}

export type OutdoorShippingQuote = {
  amount: number
  title: string
  note: string
  /** Set when the company covers part of delivery: the price before the subsidy. */
  actualCost?: number
  subsidy?: number
}

export function outdoorCustomerShippingAmount(
  subtotal: number,
  options?: { flat?: number; freeOver?: number | null },
) {
  const flat = options?.flat ?? OUTDOOR_FLAT_SHIPPING_RM
  const freeOver = options && 'freeOver' in options ? options.freeOver : OUTDOOR_FREE_SHIPPING_OVER_RM
  const goods = Number(subtotal)
  if (freeOver != null && freeOver > 0 && Number.isFinite(goods) && goods >= freeOver) return 0
  if (!Number.isFinite(flat) || flat <= 0) return 0
  return Math.round(flat * 100) / 100
}

export function outdoorShippingPrice(raw: unknown): number | null {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100) / 100
}

function text(raw: unknown) {
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * One delivery line for the whole bag.
 * Each product may set its own title, note, and price in Master Data.
 * When the bag mixes products, the highest delivery price wins.
 */
export function pickOutdoorShipping(
  rows: OutdoorShippingRow[],
  subtotal: number,
  options?: { freeOver?: number | null; customerSharePercent?: number },
): OutdoorShippingQuote {
  const quote = pickFullOutdoorShipping(rows, subtotal, options)
  const share = options?.customerSharePercent
  if (share == null || !Number.isFinite(share) || share >= 100 || quote.amount <= 0) return quote
  const actualCost = quote.amount
  const amount = Math.round(actualCost * Math.max(0, share) + 1e-6) / 100
  return { ...quote, amount, actualCost, subsidy: Math.round((actualCost - amount) * 100) / 100 }
}

function pickFullOutdoorShipping(
  rows: OutdoorShippingRow[],
  subtotal: number,
  options?: { freeOver?: number | null },
): OutdoorShippingQuote {
  let chosen: { price: number; title: string; note: string } | null = null
  for (const row of rows.length > 0 ? rows : [{}]) {
    const price = outdoorShippingPrice(row.outdoor_shipping_price) ?? OUTDOOR_FLAT_SHIPPING_RM
    if (chosen && price <= chosen.price) continue
    chosen = { price, title: text(row.outdoor_shipping_title), note: text(row.outdoor_shipping_note) }
  }

  const amount = outdoorCustomerShippingAmount(subtotal, {
    flat: chosen?.price ?? OUTDOOR_FLAT_SHIPPING_RM,
    freeOver: options && 'freeOver' in options ? options.freeOver : OUTDOOR_FREE_SHIPPING_OVER_RM,
  })
  const free = amount <= 0
  const customPriceFree = (chosen?.price ?? OUTDOOR_FLAT_SHIPPING_RM) <= 0
  const useCustomText = !free || customPriceFree
  return {
    amount,
    title: (useCustomText && chosen?.title) || (free ? OUTDOOR_FREE_SHIPPING_TITLE : OUTDOOR_SHIPPING_TITLE),
    note: (useCustomText && chosen?.note) || (free ? OUTDOOR_FREE_SHIPPING_NOTE : OUTDOOR_SHIPPING_NOTE),
  }
}
