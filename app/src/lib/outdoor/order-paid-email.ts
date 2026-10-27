import { createAdminClient } from '@/lib/supabase/admin'
import { sendTransactionalHtmlEmail } from '@/lib/email/transactional-html-email'
import { resolveOrgForEmail } from '@/server/auth/passwordResetService'
import { outdoorPublicOrigin } from '@/lib/outdoor/auth-return'
import { escapeHtml, money, OUTDOOR_FROM, OUTDOOR_INBOX, shell } from '@/lib/outdoor/order-email-shell'
import { outdoorMessageChannels } from '@/lib/outdoor/customer-messages'

export const OUTDOOR_STAFF_INBOXES = [OUTDOOR_INBOX, 'store@serapod.com']

/**
 * Sent once, when an Outdoor order first becomes paid. /store orders are left alone.
 * Staff can switch off the customer's copy; the Outdoor inbox always gets its notice.
 */
export async function notifyOutdoorOrderPaid(orderId: string) {
  const admin: any = createAdminClient()
  const { data: order } = await admin
    .from('storefront_orders')
    .select('order_ref, sales_channel, customer_name, customer_email, customer_phone, total_amount, shipping_amount, currency, shipping_address, storefront_order_items(product_name, variant_name, quantity, subtotal)')
    .eq('id', orderId)
    .maybeSingle()
  if (!order || order.sales_channel !== 'outdoor' || !order.customer_email) return

  const orgId = await resolveOrgForEmail(admin)
  if (!orgId) return

  const currency = order.currency || 'MYR'
  const items: any[] = order.storefront_order_items || []
  const shipping = Number(order.shipping_amount) || 0
  const total = Number(order.total_amount) || 0
  const addr = order.shipping_address || {}
  const address = [addr.line1, addr.line2, [addr.postcode, addr.city].filter(Boolean).join(' '), addr.state]
    .filter(Boolean)
    .join(', ')
  const origin = outdoorPublicOrigin()
  const ref = String(order.order_ref)
  const firstName = String(order.customer_name || '').trim().split(/\s+/)[0]

  const rowsHtml = items
    .map(
      (item) =>
        `<tr><td style="padding:6px 0">${escapeHtml(item.product_name)}${item.variant_name ? ` · ${escapeHtml(item.variant_name)}` : ''} × ${Number(item.quantity) || 1}</td><td style="padding:6px 0;text-align:right">${money(Number(item.subtotal) || 0, currency)}</td></tr>`,
    )
    .join('')
  const summaryHtml = `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:12px 0">${rowsHtml}
<tr><td style="padding:6px 0;border-top:1px solid #e5e1cf">Shipping</td><td style="padding:6px 0;border-top:1px solid #e5e1cf;text-align:right">${shipping > 0 ? money(shipping, currency) : 'Free'}</td></tr>
<tr><td style="padding:6px 0;font-weight:700">Total</td><td style="padding:6px 0;text-align:right;font-weight:700">${money(total, currency)}</td></tr></table>`
  const summaryText = [
    ...items.map((item) => `${item.product_name}${item.variant_name ? ` · ${item.variant_name}` : ''} × ${item.quantity}  ${money(Number(item.subtotal) || 0, currency)}`),
    `Shipping: ${shipping > 0 ? money(shipping, currency) : 'Free'}`,
    `Total: ${money(total, currency)}`,
  ].join('\n')

  const trackLink = `${origin}/outdoor/track?order=${encodeURIComponent(ref)}`
  const emailCustomer = (await outdoorMessageChannels(admin, 'paid')).email
  const customer = !emailCustomer ? null : await sendTransactionalHtmlEmail(admin, orgId, {
    to: order.customer_email,
    subject: `Order ${ref} confirmed — thank you!`,
    text: [
      firstName ? `Hi ${firstName},` : 'Hi,',
      `Thank you for your order. Payment for ${ref} is confirmed.`,
      summaryText,
      address ? `Delivering to: ${address}` : '',
      'We pack your order and hand it to the courier within 1–3 business days. The tracking number appears on your order when it ships.',
      `Track your order: ${trackLink}`,
    ].filter(Boolean).join('\n\n'),
    html: shell(
      'Your order is confirmed',
      `<p style="margin:0 0 12px;line-height:1.55">${firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi,'}</p>
<p style="margin:0 0 12px;line-height:1.55">Thank you for your order. Payment for <strong>${escapeHtml(ref)}</strong> is confirmed.</p>
${summaryHtml}
${address ? `<p style="margin:0 0 12px;line-height:1.55;font-size:13px;color:#7c878e"><strong style="color:#3f1c1f">Delivering to</strong> ${escapeHtml(address)}</p>` : ''}
<p style="margin:0;line-height:1.55">We pack your order and hand it to the courier within 1–3 business days. The tracking number appears on your order when it ships.</p>`,
      { href: trackLink, label: 'Track my order' },
    ),
    ...OUTDOOR_FROM,
  })
  if (customer && !customer.success) console.error('[outdoor-order-paid] customer email failed:', customer.error)

  const deskLink = `${origin}/outdoor/fulfilment`
  const staffMessage = {
    subject: `New paid order ${ref} · ${money(total, currency)}`,
    text: [
      `Order: ${ref}`,
      `Customer: ${order.customer_name || ''} <${order.customer_email}> ${order.customer_phone || ''}`,
      summaryText,
      address ? `Deliver to: ${address}` : '',
      `Open the desk: ${deskLink}`,
    ].filter(Boolean).join('\n\n'),
    html: shell(
      `New paid order ${ref}`,
      `<p style="margin:0 0 12px;line-height:1.55"><strong>Customer:</strong> ${escapeHtml(order.customer_name || '')} &lt;${escapeHtml(order.customer_email)}&gt; ${escapeHtml(order.customer_phone || '')}</p>
${summaryHtml}
${address ? `<p style="margin:0;line-height:1.55;font-size:13px"><strong>Deliver to:</strong> ${escapeHtml(address)}</p>` : ''}`,
      { href: deskLink, label: 'Open fulfilment desk' },
    ),
    ...OUTDOOR_FROM,
  }
  for (const inbox of OUTDOOR_STAFF_INBOXES) {
    const staff = await sendTransactionalHtmlEmail(admin, orgId, { ...staffMessage, to: inbox })
    if (!staff.success) console.error(`[outdoor-order-paid] staff email to ${inbox} failed:`, staff.error)
  }
}
