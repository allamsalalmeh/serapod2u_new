/**
 * Website orders and warehouse stock: items leave the online shop's warehouse when an
 * order ships, come back only when staff confirm a return, and the shop stops selling
 * what the warehouse cannot cover. The database functions do the posting; this module
 * turns their answers into messages staff and shoppers can act on.
 */

export type StockMoveResult =
  | { ok: true; status: 'taken' | 'returned' | 'already' | 'not_taken' | 'unavailable'; units: number }
  | { ok: false; error: string }

/** Stock functions not deployed yet: keep selling and shipping exactly as before. */
function isMissingFunction(error: any) {
  const text = `${error?.code || ''} ${error?.message || ''}`
  return /PGRST202|42883|could not find the function|does not exist/i.test(text)
}

export function stockErrorMessage(error: any): string {
  const message = String(error?.message || error || '')
  const short = message.match(/storefront_stock_short:\s*(.+)/)
  if (short) return `Not enough stock to ship: ${short[1].trim()} Add stock in Inventory first.`
  if (/inventory_cutoff_warehouse_frozen/.test(message)) {
    return 'The warehouse is in the middle of a stock count, so nothing can leave it until the count is posted.'
  }
  if (/storefront_no_fulfilment_warehouse/.test(message)) {
    return 'The online shop has no active warehouse. Open the warehouse in Organizations and choose “Ship Website Orders From This Warehouse”, then try again.'
  }
  if (/canonical operational stock configuration/i.test(message)) {
    return 'One of the products has no stock configuration in master data, so its stock cannot be moved.'
  }
  return `The warehouse stock could not be updated (${message || 'unknown error'}).`
}

async function callStockFunction(admin: any, fn: string, orderId: string, actorId: string | null): Promise<StockMoveResult> {
  let data: any
  let error: any
  try {
    ;({ data, error } = await admin.rpc(fn, { p_order_id: orderId, p_actor: actorId }))
  } catch (err) {
    error = err
  }
  if (error) {
    if (isMissingFunction(error)) {
      console.warn(`[order-stock] ${fn} is not deployed yet; stock unchanged for order ${orderId}`)
      return { ok: true, status: 'unavailable', units: 0 }
    }
    console.error(`[order-stock] ${fn} failed for order ${orderId}:`, error.message)
    return { ok: false, error: stockErrorMessage(error) }
  }
  return { ok: true, status: data?.status || 'taken', units: Number(data?.units) || 0 }
}

/** Takes a shipped order's items out of the warehouse. Safe to repeat: it posts once. */
export function takeOrderStock(admin: any, orderId: string, actorId: string | null) {
  return callStockFunction(admin, 'storefront_order_stock_out', orderId, actorId)
}

/** Puts a returned order's items back. Does nothing when no stock was ever taken. */
export function returnOrderStock(admin: any, orderId: string, actorId: string | null) {
  return callStockFunction(admin, 'storefront_order_stock_return', orderId, actorId)
}

/** Reverses a stock-out whose shipment was never saved, so the real shipment takes it again. */
export function undoOrderStock(admin: any, orderId: string, actorId: string | null) {
  return callStockFunction(admin, 'storefront_order_stock_undo', orderId, actorId)
}

export function stockMoveNote(result: StockMoveResult, direction: 'out' | 'back'): string | null {
  if (!result.ok || result.units <= 0) return null
  if (result.status === 'taken' && direction === 'out') {
    return `${result.units} item${result.units === 1 ? '' : 's'} taken out of warehouse stock`
  }
  if (result.status === 'returned' && direction === 'back') {
    return `${result.units} item${result.units === 1 ? '' : 's'} put back into warehouse stock`
  }
  return null
}

export type StorefrontStockChannel = 'store' | 'outdoor'

/**
 * How many of each variant the shop can still sell: its warehouse's free stock, capped by
 * the variant's online allocation. Null when stock cannot be read (functions not deployed,
 * no warehouse configured): callers then keep selling.
 */
export async function sellableStock(
  admin: any,
  variantIds: string[],
  channel: StorefrontStockChannel = 'store',
): Promise<Map<string, number> | null> {
  const ids = [...new Set(variantIds.filter(Boolean))]
  if (ids.length === 0) return new Map()
  let data: unknown
  let error: any
  try {
    ;({ data, error } = await admin.rpc('storefront_variant_stock', { p_variant_ids: ids, p_channel: channel }))
  } catch (err) {
    error = err
  }
  if (error) {
    if (!isMissingFunction(error)) console.error('[order-stock] storefront_variant_stock failed:', error.message)
    return null
  }
  const stock = new Map<string, number>()
  for (const row of (data || []) as Array<{ variant_id: string; available: number }>) {
    stock.set(row.variant_id, Math.max(0, Number(row.available) || 0))
  }
  return stock
}

/** The first line the warehouse cannot cover, as a message for the shopper. */
export function stockShortfall(
  lines: Array<{ variantId: string; quantity: number; name: string }>,
  stock: Map<string, number> | null,
): string | null {
  if (!stock) return null
  const wanted = new Map<string, { quantity: number; name: string }>()
  for (const line of lines) {
    const prev = wanted.get(line.variantId)
    wanted.set(line.variantId, { quantity: (prev?.quantity || 0) + line.quantity, name: line.name })
  }
  for (const [variantId, { quantity, name }] of wanted) {
    const available = stock.get(variantId) ?? 0
    if (available <= 0) return `${name} is out of stock. Remove it from your cart to continue.`
    if (quantity > available) return `Only ${available} of ${name} left. Lower the quantity to continue.`
  }
  return null
}
