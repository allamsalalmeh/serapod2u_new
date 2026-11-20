/** A delivered order can be refunded for this many days (the "report within 7 days of delivery" policy). */
export const REFUND_WINDOW_DAYS = 7

/** When refunding a delivered order stops being possible; null when the delivery time is unknown. */
export function refundWindowEndsAt(deliveredAt: string | null | undefined): Date | null {
  const at = Date.parse(String(deliveredAt || ''))
  return Number.isFinite(at) ? new Date(at + REFUND_WINDOW_DAYS * 86_400_000) : null
}

/** Delivered orders only; an unknown delivery time does not block the refund. */
export function refundWindowOpen(deliveredAt: string | null | undefined, now = Date.now()) {
  const ends = refundWindowEndsAt(deliveredAt)
  return !ends || now <= ends.getTime()
}

/** Latest "delivered" status change per order, from storefront_order_events. */
export async function deliveredAtByOrder(supabase: any, orderIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (orderIds.length === 0) return map
  const { data } = await supabase
    .from('storefront_order_events')
    .select('order_id, created_at')
    .in('order_id', orderIds)
    .eq('to_status', 'delivered')
  for (const row of data || []) {
    const id = String(row.order_id)
    const at = String(row.created_at)
    if (!map.has(id) || Date.parse(at) > Date.parse(map.get(id)!)) map.set(id, at)
  }
  return map
}
