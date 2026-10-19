import { createAdminClient } from '@/lib/supabase/admin'
import { sendTransactionalHtmlEmail } from '@/lib/email/transactional-html-email'
import { resolveOrgForEmail } from '@/server/auth/passwordResetService'
import { getGatewayByProvider } from '@/lib/payments'
import { escapeHtml, money } from '@/lib/outdoor/order-email-shell'

export const STORE_INBOX = 'admin@serapod.com'
const STORE_FROM_NAME = 'Serapod2U Store'

function storeOrigin() {
  const env = String(process.env.NEXT_PUBLIC_APP_URL || '').trim().replace(/\/+$/, '')
  if (env && !/0\.0\.0\.0|127\.0\.0\.1|localhost/i.test(env)) return env
  return 'https://www.serapod2u.com'
}

function shell(title: string, body: string, cta: { href: string; label: string } | null) {
  return `<div style="font-family:Arial,sans-serif;color:#333f48;max-width:560px;margin:0 auto;padding:24px">
<h2 style="margin:0 0 16px;color:#1f2a30">${escapeHtml(title)}</h2>${body}
${cta ? `<p style="margin:22px 0 0"><a href="${escapeHtml(cta.href)}" style="display:inline-block;background:#1f2a30;color:#ffffff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:600">${escapeHtml(cta.label)}</a></p>` : ''}</div>`
}

/** Stripe's own receipt page for a paid Checkout Session, or null when it can't be read. */
export async function stripeReceiptUrl(sessionId: string): Promise<string | null> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return null
  try {
    const gateway = await getGatewayByProvider('stripe')
    const secretKey = String((gateway?.credentials as Record<string, string> | undefined)?.secret_key || '')
    if (!secretKey) return null
    const res = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent.latest_charge`,
      { headers: { Authorization: `Bearer ${secretKey}` }, cache: 'no-store', signal: AbortSignal.timeout(8000) },
    )
    if (!res.ok) return null
    const session = await res.json()
    const url = session?.payment_intent?.latest_charge?.receipt_url
    return typeof url === 'string' && url.startsWith('https://') ? url : null
  } catch {
    return null
  }
}

/**
 * Sent once, when a Serapod2U Store (/store) order first becomes paid: the order
 * details to the customer, and a notice to the store inbox. Outdoor orders have their own email.
 */
export async function notifyStoreOrderPaid(orderId: string) {
  const admin: any = createAdminClient()
  const { data: order } = await admin
    .from('storefront_orders')
    .select('order_ref, sales_channel, customer_name, customer_email, customer_phone, total_amount, shipping_amount, currency, shipping_address, payment_provider, payment_ref, paid_at, storefront_order_items(product_name, variant_name, quantity, subtotal)')
    .eq('id', orderId)
    .maybeSingle()
  if (!order || (order.sales_channel || 'store') !== 'store') return

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
  const ref = String(order.order_ref)
  const firstName = String(order.customer_name || '').trim().split(/\s+/)[0]
  const paidAt = order.paid_at
    ? new Date(order.paid_at).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', dateStyle: 'medium', timeStyle: 'short' })
    : ''
  const receiptUrl = order.payment_provider === 'stripe' ? await stripeReceiptUrl(String(order.payment_ref || '')) : null

  const rowsHtml = items
    .map(
      (item) =>
        `<tr><td style="padding:6px 0">${escapeHtml(item.product_name)}${item.variant_name ? ` · ${escapeHtml(item.variant_name)}` : ''} × ${Number(item.quantity) || 1}</td><td style="padding:6px 0;text-align:right">${money(Number(item.subtotal) || 0, currency)}</td></tr>`,
    )
    .join('')
  const summaryHtml = `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:12px 0">${rowsHtml}
<tr><td style="padding:6px 0;border-top:1px solid #e3e6e8">Shipping</td><td style="padding:6px 0;border-top:1px solid #e3e6e8;text-align:right">${shipping > 0 ? money(shipping, currency) : 'Free'}</td></tr>
<tr><td style="padding:6px 0;font-weight:700">Total paid</td><td style="padding:6px 0;text-align:right;font-weight:700">${money(total, currency)}</td></tr></table>`
  const summaryText = [
    ...items.map((item) => `${item.product_name}${item.variant_name ? ` · ${item.variant_name}` : ''} × ${item.quantity}  ${money(Number(item.subtotal) || 0, currency)}`),
    `Shipping: ${shipping > 0 ? money(shipping, currency) : 'Free'}`,
    `Total paid: ${money(total, currency)}`,
  ].join('\n')
  const paidLine = `Order ${ref}${paidAt ? ` · paid ${paidAt}` : ''}`

  if (order.customer_email) {
    const customer = await sendTransactionalHtmlEmail(admin, orgId, {
      to: order.customer_email,
      subject: `Order ${ref} confirmed — thank you!`,
      text: [
        firstName ? `Hi ${firstName},` : 'Hi,',
        `Thank you for shopping with Serapod2U. Your payment is confirmed.`,
        paidLine,
        summaryText,
        address ? `Delivering to: ${address}` : '',
        'We will let you know when your order ships.',
        receiptUrl ? `Payment receipt: ${receiptUrl}` : '',
      ].filter(Boolean).join('\n\n'),
      html: shell(
        'Your order is confirmed',
        `<p style="margin:0 0 12px;line-height:1.55">${firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi,'}</p>
<p style="margin:0 0 12px;line-height:1.55">Thank you for shopping with Serapod2U. Your payment is confirmed.</p>
<p style="margin:0 0 4px;font-size:13px;color:#7c878e">${escapeHtml(paidLine)}</p>
${summaryHtml}
${address ? `<p style="margin:0 0 12px;line-height:1.55;font-size:13px;color:#7c878e"><strong style="color:#1f2a30">Delivering to</strong> ${escapeHtml(address)}</p>` : ''}
<p style="margin:0;line-height:1.55">We will let you know when your order ships.</p>`,
        receiptUrl ? { href: receiptUrl, label: 'View payment receipt' } : null,
      ),
      fromName: STORE_FROM_NAME,
    })
    if (!customer.success) console.error('[store-order-paid] customer email failed:', customer.error)
  }

  const ordersLink = `${storeOrigin()}/ecommerce/store-orders`
  const staff = await sendTransactionalHtmlEmail(admin, orgId, {
    to: STORE_INBOX,
    subject: `New paid store order ${ref} · ${money(total, currency)}`,
    text: [
      paidLine,
      `Customer: ${order.customer_name || ''} <${order.customer_email || ''}> ${order.customer_phone || ''}`,
      summaryText,
      address ? `Deliver to: ${address}` : '',
      receiptUrl ? `Stripe receipt: ${receiptUrl}` : '',
      `Open Store Orders: ${ordersLink}`,
    ].filter(Boolean).join('\n\n'),
    html: shell(
      `New paid store order ${ref}`,
      `<p style="margin:0 0 4px;font-size:13px;color:#7c878e">${escapeHtml(paidLine)}</p>
<p style="margin:0 0 12px;line-height:1.55"><strong>Customer:</strong> ${escapeHtml(order.customer_name || '')} &lt;${escapeHtml(order.customer_email || '')}&gt; ${escapeHtml(order.customer_phone || '')}</p>
${summaryHtml}
${address ? `<p style="margin:0 0 12px;line-height:1.55;font-size:13px"><strong>Deliver to:</strong> ${escapeHtml(address)}</p>` : ''}
${receiptUrl ? `<p style="margin:0;font-size:13px"><a href="${escapeHtml(receiptUrl)}">Stripe receipt</a></p>` : ''}`,
      { href: ordersLink, label: 'Open Store Orders' },
    ),
    fromName: STORE_FROM_NAME,
  })
  if (!staff.success) console.error('[store-order-paid] staff email failed:', staff.error)
}
