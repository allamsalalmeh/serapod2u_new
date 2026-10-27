import { createAdminClient } from '@/lib/supabase/admin'
import type { PaymentCallbackResult } from './types'
import { recordOrderEvent } from '@/lib/storefront/order-events'

/**
 * Order statuses a payment result may move from. Replayed or late callbacks
 * (a reloaded return page, gateway retries) must never pull a shipped order back
 * to paid, or turn a paid order into failed.
 */
export function paymentResultFromStatuses(paid: boolean) {
  return paid ? ['pending_payment', 'payment_failed'] : ['pending_payment']
}

/**
 * A Stripe session that expires or fails only fails the order when it is still the
 * order's current session. "Continue payment" opens a new session, and the old
 * one expiring later must not mark the order failed.
 */
export function failureNeedsCurrentSession(result: Pick<PaymentCallbackResult, 'paid' | 'transactionId'>) {
  return !result.paid && String(result.transactionId || '').startsWith('cs_')
}

export async function applyStorefrontPaymentResult(result: PaymentCallbackResult) {
  if (!result.verified || !result.orderId) return { updated: false }
  const supabase: any = createAdminClient()
  let query = supabase
    .from('storefront_orders')
    .update({
      status: result.paid ? 'paid' : 'payment_failed',
      payment_ref: result.transactionId || undefined,
      paid_at: result.paid ? new Date().toISOString() : undefined,
    })
    .eq('id', result.orderId)
    .in('status', paymentResultFromStatuses(result.paid))
  if (failureNeedsCurrentSession(result)) {
    query = query.eq('payment_ref', result.transactionId)
  }
  const { data, error } = await query.select('id')

  if (error) {
    console.error('[payments] DB update failed:', error)
    throw error
  }
  const updated = Array.isArray(data) && data.length > 0
  if (updated) {
    await recordOrderEvent(supabase, {
      orderId: result.orderId,
      eventType: 'status_changed',
      toStatus: result.paid ? 'paid' : 'payment_failed',
      actorType: 'payment',
      actorLabel: 'Payment gateway',
      note: result.transactionId ? `Payment ref ${result.transactionId}` : null,
    })
  }
  if (updated && result.paid) {
    const email = (async () => {
      try {
        const { notifyOutdoorOrderPaid } = await import('@/lib/outdoor/order-paid-email')
        await notifyOutdoorOrderPaid(result.orderId)
      } catch (err) {
        console.error('[payments] order paid email failed:', err)
      }
    })()
    const storeEmail = (async () => {
      try {
        const { notifyStoreOrderPaid } = await import('@/lib/storefront/order-paid-email')
        await notifyStoreOrderPaid(result.orderId)
      } catch (err) {
        console.error('[payments] store order paid email failed:', err)
      }
    })()
    const sms = (async () => {
      try {
        const { notifyOutdoorOrderSms } = await import('@/lib/outdoor/order-sms')
        await notifyOutdoorOrderSms(result.orderId, 'paid')
      } catch (err) {
        console.error('[payments] order paid SMS failed:', err)
      }
    })()
    const staffAlert = (async () => {
      try {
        const { notifyStaffOrderPaid } = await import('@/lib/storefront/order-paid-staff-alert')
        await notifyStaffOrderPaid(result.orderId)
      } catch (err) {
        console.error('[payments] staff paid alert failed:', err)
      }
    })()
    await Promise.all([email, storeEmail, sms, staffAlert])
  }
  if (!updated && result.paid) {
    const { data: current } = await supabase
      .from('storefront_orders')
      .select('status')
      .eq('id', result.orderId)
      .maybeSingle()
    if (current?.status === 'cancelled') {
      console.error(`[payments] order ${result.orderId} was cancelled but a payment arrived — refund or restore it manually`)
    }
  }
  return { updated, paid: result.paid }
}
