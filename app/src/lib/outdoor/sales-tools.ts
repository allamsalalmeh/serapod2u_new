/**
 * Outdoor sales tools shared by checkout, the shop and the staff page:
 * combos (one price, stock taken from each real SKU), the checkout offer
 * (order bump), the delivery subsidy and affiliate / live-host links.
 */

export const OUTDOOR_BUNDLE_PREFIX = 'bundle:'
export const OUTDOOR_REF_STORAGE_KEY = 'serapod_outdoor_ref'
export const OUTDOOR_REF_DAYS = 30
export const OUTDOOR_SOLD_STATUSES = ['paid', 'processing', 'shipped', 'delivered']

export type OutdoorCheckoutSettings = {
  shippingCustomerSharePercent: number
  orderBumpEnabled: boolean
  orderBumpVariantId: string | null
  orderBumpPrice: number | null
  orderBumpComparePrice: number | null
  orderBumpText: string
}

export const DEFAULT_OUTDOOR_CHECKOUT_SETTINGS: OutdoorCheckoutSettings = {
  shippingCustomerSharePercent: 100,
  orderBumpEnabled: false,
  orderBumpVariantId: null,
  orderBumpPrice: null,
  orderBumpComparePrice: null,
  orderBumpText: '',
}

export type OutdoorOrderBumpOffer = {
  variantId: string
  productId: string
  productName: string
  variantName: string
  imageUrl: string | null
  price: number
  comparePrice: number | null
  text: string
}

export type OutdoorBundleComponent = {
  variantId: string
  productId: string
  productName: string
  imageUrl?: string | null
  variantName: string
  quantity: number
  retailPrice: number
}

export type OutdoorBundle = {
  id: string
  name: string
  description: string
  price: number
  imageUrl: string | null
  components: OutdoorBundleComponent[]
  /** Sum of the components at their normal retail prices. */
  comparePrice: number
  /** Combos the warehouse can still cover; null when stock cannot be read. */
  available: number | null
}

export function roundRm(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100
}

function num(raw: unknown): number | null {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

export function checkoutSettingsFromRow(row: any): OutdoorCheckoutSettings {
  if (!row) return { ...DEFAULT_OUTDOOR_CHECKOUT_SETTINGS }
  const share = num(row.shipping_customer_share_percent)
  return {
    shippingCustomerSharePercent: share === null ? 100 : Math.min(100, Math.max(0, share)),
    orderBumpEnabled: row.order_bump_enabled === true,
    orderBumpVariantId: row.order_bump_variant_id ? String(row.order_bump_variant_id) : null,
    orderBumpPrice: num(row.order_bump_price),
    orderBumpComparePrice: num(row.order_bump_compare_price),
    orderBumpText: typeof row.order_bump_text === 'string' ? row.order_bump_text.trim() : '',
  }
}

export function defaultOrderBumpText(price: number, productName: string, comparePrice: number | null) {
  const was = comparePrice && comparePrice > price ? ` (Original Price RM${formatRm(comparePrice)})` : ''
  return `Add RM${formatRm(price)} only to get a ${productName}${was} - Tick Here`
}

function formatRm(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

export function isBundleCartId(variantId: string) {
  return typeof variantId === 'string' && variantId.startsWith(OUTDOOR_BUNDLE_PREFIX)
}

export function bundleIdFromCartId(variantId: string) {
  return isBundleCartId(variantId) ? variantId.slice(OUTDOOR_BUNDLE_PREFIX.length) : ''
}

export function bundleCartId(bundleId: string) {
  return `${OUTDOOR_BUNDLE_PREFIX}${bundleId}`
}

export function bundleItemsLabel(bundle: Pick<OutdoorBundle, 'components'>) {
  return bundle.components.map((c) => `${c.quantity > 1 ? `${c.quantity}× ` : ''}${c.productName}`).join(' + ')
}

export function bundleComparePrice(components: Array<{ retailPrice: number; quantity: number }>) {
  return roundRm(components.reduce((sum, c) => sum + (Number(c.retailPrice) || 0) * c.quantity, 0))
}

/** Combos the warehouse can cover: the scarcest component decides. */
export function bundleAvailability(
  components: Array<{ variantId: string; quantity: number }>,
  stock: Map<string, number> | null,
): number | null {
  if (!stock) return null
  if (components.length === 0) return 0
  let available = Number.POSITIVE_INFINITY
  for (const c of components) {
    const have = stock.get(c.variantId) ?? 0
    available = Math.min(available, Math.floor(have / Math.max(1, c.quantity)))
  }
  return Number.isFinite(available) ? available : 0
}

/**
 * Splits the combo price over its real items, in proportion to their retail
 * prices. Line subtotals add up to the combo price to the sen.
 */
export function allocateBundlePrice(
  price: number,
  components: Array<{ variantId: string; quantity: number; retailPrice: number }>,
): Array<{ variantId: string; quantity: number; unitPrice: number; subtotal: number }> {
  const totalCents = Math.round(price * 100)
  const weights = components.map((c) => Math.max(0, Number(c.retailPrice) || 0) * c.quantity)
  const weightSum = weights.reduce((a, b) => a + b, 0)
  const shares = components.map((c, i) =>
    weightSum > 0 ? (totalCents * weights[i]) / weightSum : (totalCents * c.quantity) / components.reduce((a, x) => a + x.quantity, 0),
  )
  const cents = shares.map(Math.floor)
  let left = totalCents - cents.reduce((a, b) => a + b, 0)
  const order = shares.map((s, i) => ({ i, frac: s - Math.floor(s) })).sort((a, b) => b.frac - a.frac)
  for (let k = 0; left > 0 && order.length > 0; k = (k + 1) % order.length, left--) cents[order[k].i] += 1
  return components.map((c, i) => ({
    variantId: c.variantId,
    quantity: c.quantity,
    unitPrice: roundRm(cents[i] / 100 / c.quantity),
    subtotal: cents[i] / 100,
  }))
}

export function normalizeAffiliateCode(raw: unknown): string {
  const code = String(raw ?? '').trim().toUpperCase()
  return /^[A-Z0-9_-]{3,32}$/.test(code) ? code : ''
}

/** The saved ref when it is still inside the attribution window. */
export function activeRef(stored: unknown, now = Date.now()): string {
  if (!stored || typeof stored !== 'object') return ''
  const { code, at } = stored as { code?: unknown; at?: unknown }
  const when = Number(at)
  if (!Number.isFinite(when) || now - when > OUTDOOR_REF_DAYS * 86_400_000) return ''
  return normalizeAffiliateCode(code)
}

export function affiliateCommission(goodsAmount: number, commissionPercent: number) {
  return roundRm((Math.max(0, goodsAmount) * Math.max(0, commissionPercent)) / 100)
}

export type AffiliateReportOrder = {
  affiliate_id: string | null
  total_amount: number | string | null
  shipping_amount: number | string | null
  status: string
}

export type AffiliateReportRow = {
  affiliateId: string
  orders: number
  goods: number
  commission: number
}

/** Paid orders per affiliate: goods value (total minus delivery) and commission. */
export function summarizeAffiliateOrders(
  orders: AffiliateReportOrder[],
  commissionById: Map<string, number>,
): AffiliateReportRow[] {
  const rows = new Map<string, AffiliateReportRow>()
  for (const order of orders) {
    if (!order.affiliate_id || !OUTDOOR_SOLD_STATUSES.includes(order.status)) continue
    const goods = Math.max(0, (Number(order.total_amount) || 0) - (Number(order.shipping_amount) || 0))
    const row = rows.get(order.affiliate_id) || { affiliateId: order.affiliate_id, orders: 0, goods: 0, commission: 0 }
    row.orders += 1
    row.goods = roundRm(row.goods + goods)
    rows.set(order.affiliate_id, row)
  }
  for (const row of rows.values()) {
    row.commission = affiliateCommission(row.goods, commissionById.get(row.affiliateId) ?? 0)
  }
  return [...rows.values()].sort((a, b) => b.goods - a.goods)
}
