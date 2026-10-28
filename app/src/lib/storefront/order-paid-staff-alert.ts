import { createAdminClient } from '@/lib/supabase/admin'
import { resolveOrgForSms } from '@/server/auth/passwordResetService'
import { queueNotificationEvent } from '@/lib/notifications/supplyChainEventQueue'
import { REQUIRED_NOTIFICATION_TYPES, STOREFRONT_ORDER_PAID_EVENT } from '@/lib/notifications/notificationEventCatalog'

interface PaidOrderForAlert {
  order_ref: string
  sales_channel?: string | null
  customer_name?: string | null
  total_amount?: number | string | null
  currency?: string | null
  paid_at?: string | null
  storefront_order_items?: Array<{ product_name?: string | null; variant_name?: string | null; quantity?: number | null }> | null
}

/**
 * Message values for the staff alert. No customer phone, email or order id keys:
 * the outbox would treat those as recipients, and this alert is for staff only.
 */
export function storefrontOrderPaidPayload(order: PaidOrderForAlert): Record<string, string> {
  const currency = String(order.currency || 'MYR').toUpperCase()
  const items = order.storefront_order_items || []
  const quantity = items.reduce((sum, item) => sum + (Number(item.quantity) || 1), 0)
  return {
    shop_name: order.sales_channel === 'outdoor' ? 'Outdoor' : 'Store',
    order_ref: String(order.order_ref),
    total: `${currency === 'MYR' ? 'RM' : currency} ${(Number(order.total_amount) || 0).toFixed(2)}`,
    item_count: String(quantity),
    item_summary: items
      .map((item) => `${item.product_name || 'Item'}${item.variant_name ? ` - ${item.variant_name}` : ''} x ${Number(item.quantity) || 1}`)
      .join('\n'),
    buyer_name: String(order.customer_name || '').trim() || 'Customer',
    paid_at: order.paid_at
      ? new Date(order.paid_at).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short' })
      : '',
  }
}

/**
 * Queues the staff alert for a website order that just became paid. Sends nothing
 * unless the event is switched on in Notification Types. Never throws.
 */
export async function notifyStaffOrderPaid(orderId: string) {
  try {
    const admin: any = createAdminClient()
    const orgId = await resolveOrgForSms(admin)
    if (!orgId) return

    const { data: setting } = await admin
      .from('notification_settings')
      .select('enabled')
      .eq('org_id', orgId)
      .eq('event_code', STOREFRONT_ORDER_PAID_EVENT)
      .maybeSingle()
    if (!setting?.enabled) return

    const { data: order } = await admin
      .from('storefront_orders')
      .select('order_ref, sales_channel, customer_name, total_amount, currency, paid_at, storefront_order_items(product_name, variant_name, quantity)')
      .eq('id', orderId)
      .maybeSingle()
    if (!order?.order_ref) return

    const payload = storefrontOrderPaidPayload(order)
    const allowedChannels = REQUIRED_NOTIFICATION_TYPES.find((t) => t.event_code === STOREFRONT_ORDER_PAID_EVENT)?.available_channels
    const outcome = await queueNotificationEvent(admin, {
      orgId,
      eventCode: STOREFRONT_ORDER_PAID_EVENT,
      payload,
      dedupePayload: { order_ref: payload.order_ref },
      allowedChannels,
    })
    if (outcome.errors?.length) console.error('[order-paid-staff-alert] queue failed:', outcome.errors.join('; '))
  } catch (err) {
    console.error('[order-paid-staff-alert] failed:', err)
  }
}
