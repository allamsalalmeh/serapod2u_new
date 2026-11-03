import { createAdminClient } from '@/lib/supabase/admin'
import { sendTransactionalHtmlEmail } from '@/lib/email/transactional-html-email'
import { resolveOrgForEmail } from '@/server/auth/passwordResetService'
import { escapeHtml, money } from '@/lib/outdoor/order-email-shell'
import { STORE_FROM_NAME, storeEmailShell, storeOrigin } from '@/lib/storefront/order-paid-email'

export type StoreStatusEmailKind = 'delivered' | 'cancelled' | 'refunded'

export const STORE_CONTACT_EMAIL = 'store@serapod.com'

/**
 * Which status email a staff change sends a Serapod2U Store customer, if any. A refund
 * email only goes out when money was actually returned as part of the change.
 */
export function storeStatusEmailFor(change: {
  salesChannel?: string | null
  fromStatus?: string | null
  toStatus: string
  moneyReturned?: boolean
}): StoreStatusEmailKind | null {
  if ((change.salesChannel || 'store') !== 'store' || change.fromStatus === change.toStatus) return null
  if (change.toStatus === 'delivered') return 'delivered'
  if (change.toStatus === 'cancelled') return 'cancelled'
  if (change.toStatus === 'refunded') return change.moneyReturned ? 'refunded' : null
  return null
}

interface StoreOrderForStatusEmail {
  order_ref: string
  customer_name?: string | null
  total_amount?: number | string | null
  currency?: string | null
}

export function buildStoreStatusEmail(
  kind: StoreStatusEmailKind,
  order: StoreOrderForStatusEmail,
  options: { moneyReturned?: boolean } = {},
) {
  const ref = String(order.order_ref)
  const firstName = String(order.customer_name || '').trim().split(/\s+/)[0]
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,'
  const total = money(Number(order.total_amount) || 0, order.currency || 'MYR')
  const refundLine = `We have refunded ${total} to your original payment method. Depending on your bank, it can take 5–10 business days to show.`
  const questions = `Questions? Email us at ${STORE_CONTACT_EMAIL}.`

  let subject: string
  let title: string
  let lines: string[]
  let cta: { href: string; label: string } | null = null

  switch (kind) {
    case 'delivered':
      subject = `Order ${ref} has been delivered`
      title = 'Your order has arrived'
      lines = [
        `Order ${ref} has been delivered. We hope you enjoy it!`,
        'If anything is wrong with it, open My Purchases and choose Report a problem within 7 days.',
      ]
      cta = { href: `${storeOrigin()}/store/orders`, label: 'My Purchases' }
      break
    case 'cancelled':
      subject = `Order ${ref} was cancelled`
      title = 'Your order was cancelled'
      lines = [`Order ${ref} has been cancelled.`, options.moneyReturned ? refundLine : 'You have not been charged.', questions]
      break
    case 'refunded':
      subject = `Refund for order ${ref}`
      title = 'Your refund is on its way'
      lines = [refundLine, questions]
      break
  }

  return {
    subject,
    text: [greeting, ...lines, 'Thank you for shopping with Serapod2U.', cta ? `${cta.label}: ${cta.href}` : ''].filter(Boolean).join('\n\n'),
    html: storeEmailShell(
      title,
      [greeting, ...lines, 'Thank you for shopping with Serapod2U.']
        .map((line) => `<p style="margin:0 0 12px;line-height:1.55">${escapeHtml(line)}</p>`)
        .join('\n'),
      cta,
    ),
  }
}

/** Emails a Serapod2U Store customer about a delivered / cancelled / refunded order. Never throws: the change is already saved. */
export async function notifyStoreOrderStatus(orderId: string, kind: StoreStatusEmailKind | null, options: { moneyReturned?: boolean } = {}) {
  if (!kind) return
  try {
    const admin: any = createAdminClient()
    const { data: order } = await admin
      .from('storefront_orders')
      .select('order_ref, sales_channel, customer_name, customer_email, total_amount, currency')
      .eq('id', orderId)
      .maybeSingle()
    if (!order || (order.sales_channel || 'store') !== 'store' || !order.customer_email) return

    const orgId = await resolveOrgForEmail(admin)
    if (!orgId) return

    const email = buildStoreStatusEmail(kind, order, options)
    const sent = await sendTransactionalHtmlEmail(admin, orgId, { to: order.customer_email, ...email, fromName: STORE_FROM_NAME })
    if (!sent.success) console.error(`[store-order-email] ${kind} email failed:`, sent.error)
  } catch (err) {
    console.error(`[store-order-email] ${kind} email failed:`, err)
  }
}
