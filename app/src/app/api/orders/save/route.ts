import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { guardUserOperation } from '@/lib/security-access/operation'
import { buildOrderEventPayload, queueNotificationEvent } from '@/lib/notifications/supplyChainEventQueue'
import {
  classifySaveOrderError,
  parseSaveOrderRequest,
  stageFromError,
  type SaveOrderFailure,
  type SaveOrderSuccess,
} from '@/lib/orders/save-order'

export const dynamic = 'force-dynamic'

function failure(
  status: number,
  body: Omit<SaveOrderFailure, 'success'>,
) {
  return NextResponse.json({ success: false, ...body } satisfies SaveOrderFailure, { status })
}

/**
 * Atomic order save. Header, replacement items and requested status are
 * written by public.save_order_with_items() in ONE transaction as the
 * authenticated caller (RLS applies). The notification is queued only after
 * that commit and never turns a committed save into a failure.
 */
export async function POST(request: NextRequest) {
  const correlationId = randomUUID()
  const supabase = await createClient()

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return failure(401, { outcome: 'not_saved', code: 'unauthorized', message: 'Your session has expired. Sign in again; your form is unchanged.', correlationId })
  }
  const denied = await guardUserOperation(user.id, 'supply_chain.order.create')
  if (denied) return denied

  const parsed = parseSaveOrderRequest(await request.json().catch(() => null))
  if (!parsed) {
    return failure(400, { outcome: 'not_saved', code: 'invalid_request', message: 'The order details are not valid. Nothing was saved.', correlationId })
  }

  const startedAt = Date.now()
  const { data, error } = await (supabase as any).rpc('save_order_with_items', {
    p_order_id: parsed.orderId,
    p_mode: parsed.mode,
    p_requested_status: parsed.requestedStatus,
    p_expected_updated_at: parsed.expectedUpdatedAt ?? null,
    p_seller_org_id: parsed.sellerOrgId,
    p_units_per_case: parsed.unitsPerCase,
    p_qr_buffer_percent: parsed.qrBufferPercent,
    p_extra_qr_master: parsed.extraQrMaster,
    p_has_rfid: parsed.hasRfid,
    p_has_points: parsed.hasPoints,
    p_has_lucky_draw: parsed.hasLuckyDraw,
    p_has_redeem: parsed.hasRedeem,
    p_notes: parsed.notes,
    p_items: parsed.items,
  })

  if (error || !data) {
    const stage = error ? stageFromError(error) : undefined
    const classified = classifySaveOrderError(error || {})
    // Identifiers and failure class only: no notes, customer or item payload.
    console.error('[orders.save] failed', {
      correlationId,
      mode: parsed.mode,
      orderId: parsed.orderId,
      actorId: user.id,
      itemCount: parsed.items.length,
      stage,
      sqlstate: error?.code ?? null,
      elapsedMs: Date.now() - startedAt,
    })
    return failure(classified.status, {
      outcome: 'not_saved',
      code: classified.code,
      message: classified.message,
      correlationId,
      stage,
    })
  }

  const saved = data as { order_id: string; order_no: string; status: string; updated_at: string; item_count: number; replayed: boolean }
  console.info('[orders.save] ok', {
    correlationId,
    mode: parsed.mode,
    orderId: saved.order_id,
    itemCount: saved.item_count,
    status: saved.status,
    replayed: saved.replayed,
    elapsedMs: Date.now() - startedAt,
  })

  let notification: SaveOrderSuccess['notification'] = 'skipped'
  if (saved.status === 'submitted') {
    try {
      const admin = createAdminClient()
      const { orgId, payload } = await buildOrderEventPayload(admin, {
        orderId: saved.order_id,
        eventCode: 'order_submitted',
        baseUrl: request.nextUrl.origin,
      })
      await queueNotificationEvent(admin, {
        orgId,
        eventCode: 'order_submitted',
        payload,
        // same dedupe key as /api/notifications/order-event, so a retried
        // save cannot enqueue a second notification
        dedupePayload: { order_no: payload.order_no },
      })
      notification = 'queued'
      fetch(`${request.nextUrl.origin}/api/cron/notification-outbox-worker`).catch(() => { })
    } catch (notifyError: any) {
      notification = 'failed'
      console.warn('[orders.save] notification enqueue failed', { correlationId, orderId: saved.order_id, message: notifyError?.message })
    }
  }

  return NextResponse.json({
    success: true,
    outcome: 'saved',
    correlationId,
    order: {
      id: saved.order_id,
      orderNo: saved.order_no,
      status: saved.status,
      updatedAt: saved.updated_at,
      itemCount: saved.item_count,
      replayed: saved.replayed,
    },
    notification,
  } satisfies SaveOrderSuccess)
}
