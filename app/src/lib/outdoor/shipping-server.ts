import { pickOutdoorShipping, type OutdoorShippingQuote, type OutdoorShippingRow } from '@/lib/outdoor/shipping'

/**
 * Reads each product's Outdoor delivery settings. Missing columns fall back to the standard RM 2 line.
 * customerSharePercent below 100 makes the company cover the rest of the delivery price.
 */
export async function resolveOutdoorShipping(
  supabase: any,
  productIds: string[],
  subtotal: number,
  options?: { customerSharePercent?: number },
): Promise<OutdoorShippingQuote> {
  const ids = [...new Set(productIds.filter(Boolean))]
  let rows: OutdoorShippingRow[] = []
  if (ids.length > 0) {
    const { data, error } = await supabase
      .from('products')
      .select('id, outdoor_shipping_title, outdoor_shipping_note, outdoor_shipping_price')
      .in('id', ids)
    if (error) {
      if (!/outdoor_shipping/i.test(error.message || '')) {
        console.error('[outdoor shipping] product settings', error)
      }
    } else {
      rows = data || []
    }
  }
  return pickOutdoorShipping(rows, subtotal, { customerSharePercent: options?.customerSharePercent })
}
