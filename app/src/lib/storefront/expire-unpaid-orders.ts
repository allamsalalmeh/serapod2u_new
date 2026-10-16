import { createAdminClient } from '@/lib/supabase/admin'
import { getGatewayByProvider } from '@/lib/payments'
import { applyStorefrontPaymentResult } from '@/lib/payments/apply-callback'
import { EXPIRING_CHANNELS, UNPAID_ORDER_TTL_HOURS, unpaidOrderCutoff } from './unpaid-order-deadline'
import { recordOrderEvent } from './order-events'
import { notifyOutdoorOrderStatus } from '@/lib/outdoor/order-status-email'

export { isUnpaidOrderExpired, UNPAID_ORDER_TTL_HOURS } from './unpaid-order-deadline'

export type StripeSessionState = 'paid' | 'processing' | 'open' | 'closed'

/**
 * What the order's Checkout Session allows. A session this Stripe account does not
 * know (null) can never be paid, so it counts as closed. `complete` but unpaid is a
 * delayed method (e.g. FPX) still settling: never cancel under it.
 */
export function stripeSessionState(session: { status?: string | null; payment_status?: string | null } | null): StripeSessionState {
  if (!session) return 'closed'
  if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') return 'paid'
  if (session.status === 'complete') return 'processing'
  if (session.status === 'open') return 'open'
  return 'closed'
}

type StripeCall = { ok: true; session: any } | { ok: false; missing: boolean }

async function stripeSessionCall(sessionId: string, secretKey: string, action: 'get' | 'expire'): Promise<StripeCall> {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return { ok: false, missing: true }
  const base = `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`
  try {
    const res = await fetch(action === 'expire' ? `${base}/expire` : base, {
      method: action === 'expire' ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${secretKey}` },
      cache: 'no-store',
    })
    if (res.ok) return { ok: true, session: await res.json() }
    if (res.status === 404) return { ok: false, missing: true }
    console.error(`[unpaid-expiry] Stripe ${action} ${sessionId} failed:`, res.status, await res.text().catch(() => ''))
    return { ok: false, missing: false }
  } catch (err) {
    console.error(`[unpaid-expiry] Stripe ${action} ${sessionId} error:`, err)
    return { ok: false, missing: false }
  }
}

export type UnpaidExpiryOutcome = 'cancelled' | 'paid' | 'kept'

export interface UnpaidExpiryResult {
  orderRef: string
  outcome: UnpaidExpiryOutcome
  reason: string
}

interface ExpiringOrder {
  id: string
  order_ref: string
  payment_provider: string | null
  payment_ref: string | null
}

async function cancelOrder(admin: any, order: ExpiringOrder): Promise<UnpaidExpiryResult> {
  let query = admin
    .from('storefront_orders')
    .update({ status: 'cancelled' })
    .eq('id', order.id)
    .eq('status', 'pending_payment')
  query = order.payment_ref ? query.eq('payment_ref', order.payment_ref) : query.is('payment_ref', null)
  const { data, error } = await query.select('id')
  if (error) throw error
  const cancelled = Array.isArray(data) && data.length > 0
  if (cancelled) {
    await recordOrderEvent(admin, {
      orderId: order.id,
      eventType: 'status_changed',
      fromStatus: 'pending_payment',
      toStatus: 'cancelled',
      actorType: 'system',
      actorLabel: 'Automatic',
      note: `Not paid within ${UNPAID_ORDER_TTL_HOURS} hours — payment page closed`,
    })
    await notifyOutdoorOrderStatus(order.id, 'auto_cancelled')
  }
  return {
    orderRef: order.order_ref,
    outcome: cancelled ? 'cancelled' : 'kept',
    reason: cancelled ? `not paid within ${UNPAID_ORDER_TTL_HOURS} hours` : 'order changed meanwhile',
  }
}

async function expireOrder(admin: any, order: ExpiringOrder, stripeKey: string): Promise<UnpaidExpiryResult> {
  const kept = (reason: string): UnpaidExpiryResult => ({ orderRef: order.order_ref, outcome: 'kept', reason })
  const sessionId = String(order.payment_ref || '')
  // Placed while no payment gateway was on: there is no payment page, so it can never be paid.
  if (order.payment_provider === 'manual') return cancelOrder(admin, order)
  if (order.payment_provider !== 'stripe' || !sessionId.startsWith('cs_')) return kept('not a Stripe payment')
  if (!stripeKey) return kept('Stripe is not configured')

  let call = await stripeSessionCall(sessionId, stripeKey, 'get')
  if (!call.ok && !call.missing) return kept('Stripe unreachable')
  let state = stripeSessionState(call.ok ? call.session : null)

  if (state === 'open') {
    const expired = await stripeSessionCall(sessionId, stripeKey, 'expire')
    call = expired.ok ? expired : await stripeSessionCall(sessionId, stripeKey, 'get')
    if (!call.ok && !call.missing) return kept('Stripe unreachable')
    state = stripeSessionState(call.ok ? call.session : null)
  }

  if (state === 'paid') {
    await applyStorefrontPaymentResult({ verified: true, orderId: order.id, paid: true, transactionId: sessionId })
    return { orderRef: order.order_ref, outcome: 'paid', reason: 'payment found on Stripe' }
  }
  if (state !== 'closed') return kept('payment still in progress')
  return cancelOrder(admin, order)
}

/**
 * Cancels Outdoor orders left unpaid past the deadline, closing their Stripe payment
 * page first. An order Stripe reports as paid is marked paid instead, and one whose
 * payment is still settling or cannot be checked is left alone.
 */
export async function expireUnpaidOrders(options: {
  email?: string
  orderRef?: string
  limit?: number
  now?: Date
} = {}): Promise<UnpaidExpiryResult[]> {
  const admin: any = createAdminClient()
  let query = admin
    .from('storefront_orders')
    .select('id, order_ref, payment_provider, payment_ref')
    .eq('status', 'pending_payment')
    .in('sales_channel', EXPIRING_CHANNELS)
    .lte('created_at', unpaidOrderCutoff(options.now))
    .order('created_at', { ascending: true })
    .limit(options.limit ?? 50)
  if (options.email) query = query.ilike('customer_email', options.email)
  if (options.orderRef) query = query.eq('order_ref', options.orderRef)

  const { data: orders, error } = await query
  if (error) throw error
  if (!orders?.length) return []

  const gateway = await getGatewayByProvider('stripe')
  const stripeKey = String((gateway?.credentials as Record<string, string> | undefined)?.secret_key || '')

  const results: UnpaidExpiryResult[] = []
  for (const order of orders as ExpiringOrder[]) {
    try {
      results.push(await expireOrder(admin, order, stripeKey))
    } catch (err) {
      console.error('[unpaid-expiry] order failed', order.order_ref, err)
      results.push({ orderRef: order.order_ref, outcome: 'kept', reason: err instanceof Error ? err.message : 'failed' })
    }
  }
  return results
}
