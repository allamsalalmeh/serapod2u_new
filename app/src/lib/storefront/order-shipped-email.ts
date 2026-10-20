import { createAdminClient } from '@/lib/supabase/admin'
import { sendTransactionalHtmlEmail } from '@/lib/email/transactional-html-email'
import { resolveOrgForEmail } from '@/server/auth/passwordResetService'
import { escapeHtml } from '@/lib/outdoor/order-email-shell'
import { OWN_DELIVERY_LABEL } from '@/lib/storefront/delivery'
import { STORE_FROM_NAME, storeEmailShell } from '@/lib/storefront/order-paid-email'

export type StoreShippingEmailKind = 'shipped' | 'tracking_updated'

/**
 * Which shipping email a staff change sends a Serapod2U Store customer, if any:
 * the first time the order ships, or when a shipped order gets a new tracking number.
 */
export function storeShippingEmailFor(change: {
  salesChannel?: string | null
  fromStatus?: string | null
  toStatus: string
  fromTracking?: string | null
  toTracking?: string | null
}): StoreShippingEmailKind | null {
  if ((change.salesChannel || 'store') !== 'store' || change.toStatus !== 'shipped') return null
  if (change.fromStatus !== 'shipped') return 'shipped'
  const toTracking = String(change.toTracking || '').trim()
  return toTracking && toTracking !== String(change.fromTracking || '').trim() ? 'tracking_updated' : null
}

interface StoreOrderForShippingEmail {
  order_ref: string
  customer_name?: string | null
  shipping_courier_name?: string | null
  shipping_tracking_no?: string | null
  shipping_address?: { line1?: string; line2?: string; city?: string; state?: string; postcode?: string } | null
  storefront_order_items?: Array<{ product_name: string; variant_name?: string | null; quantity: number }> | null
}

export function buildStoreShippingEmail(kind: StoreShippingEmailKind, order: StoreOrderForShippingEmail) {
  const ref = String(order.order_ref)
  const firstName = String(order.customer_name || '').trim().split(/\s+/)[0]
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,'
  const courier = String(order.shipping_courier_name || '').trim()
  const tracking = String(order.shipping_tracking_no || '').trim()
  const ownDelivery = courier === OWN_DELIVERY_LABEL
  const addr = order.shipping_address || {}
  const address = [addr.line1, addr.line2, [addr.postcode, addr.city].filter(Boolean).join(' '), addr.state].filter(Boolean).join(', ')
  const items = (order.storefront_order_items || []).map(
    (item) => `${item.product_name}${item.variant_name ? ` · ${item.variant_name}` : ''} × ${Number(item.quantity) || 1}`,
  )

  const subject = kind === 'shipped' ? `Order ${ref} is on its way` : `New tracking number for order ${ref}`
  const title = kind === 'shipped' ? 'Your order is on its way' : 'Your tracking number was updated'
  const intro = ownDelivery
    ? `Good news: order ${ref} has left our warehouse. Our own delivery team is bringing it to you.`
    : kind === 'shipped'
      ? `Good news: order ${ref} has left our warehouse${courier ? ` with ${courier}` : ''}.`
      : `We updated the courier details for order ${ref}${courier ? ` (${courier})` : ''}.`

  const detailRows = [
    !ownDelivery && courier ? ['Courier', courier] : null,
    !ownDelivery && tracking ? ['Tracking number', tracking] : null,
    address ? ['Delivering to', address] : null,
  ].filter(Boolean) as string[][]

  const text = [
    greeting,
    intro,
    ...detailRows.map(([label, value]) => `${label}: ${value}`),
    items.length ? `Items:\n${items.join('\n')}` : '',
    'Thank you for shopping with Serapod2U.',
  ].filter(Boolean).join('\n\n')

  const html = storeEmailShell(
    title,
    `<p style="margin:0 0 12px;line-height:1.55">${escapeHtml(greeting)}</p>
<p style="margin:0 0 12px;line-height:1.55">${escapeHtml(intro)}</p>
${detailRows.length ? `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:12px 0">${detailRows
      .map(([label, value]) => `<tr><td style="padding:6px 0;color:#7c878e;width:40%">${escapeHtml(label)}</td><td style="padding:6px 0;font-weight:600">${escapeHtml(value)}</td></tr>`)
      .join('')}</table>` : ''}
${items.length ? `<p style="margin:0 0 12px;line-height:1.55;font-size:13px;color:#7c878e">${items.map(escapeHtml).join('<br>')}</p>` : ''}
<p style="margin:0;line-height:1.55">Thank you for shopping with Serapod2U.</p>`,
    null,
  )
  return { subject, text, html }
}

/** Emails a Serapod2U Store customer that their order shipped. Never throws: the change is already saved. */
export async function notifyStoreOrderShipped(orderId: string, kind: StoreShippingEmailKind | null) {
  if (!kind) return
  try {
    const admin: any = createAdminClient()
    const { data: order } = await admin
      .from('storefront_orders')
      .select('order_ref, sales_channel, customer_name, customer_email, shipping_courier_name, shipping_tracking_no, shipping_address, storefront_order_items(product_name, variant_name, quantity)')
      .eq('id', orderId)
      .maybeSingle()
    if (!order || (order.sales_channel || 'store') !== 'store' || !order.customer_email) return

    const orgId = await resolveOrgForEmail(admin)
    if (!orgId) return

    const email = buildStoreShippingEmail(kind, order)
    const sent = await sendTransactionalHtmlEmail(admin, orgId, { to: order.customer_email, ...email, fromName: STORE_FROM_NAME })
    if (!sent.success) console.error(`[store-order-email] ${kind} email failed:`, sent.error)
  } catch (err) {
    console.error(`[store-order-email] ${kind} email failed:`, err)
  }
}
