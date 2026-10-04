import { guardUserOperation } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateQRBatch } from '@/lib/qr-generator'
import { PROCESSING_ORG_TYPES, canProcessBatchForOrder } from '@/lib/qr-batch-access'
import { resolveQrBufferPercent } from '@/lib/orders/qr-buffer'

/**
 * POST /api/qr-batches/generate  { order_id }
 *
 * Queue QR batch generation for an approved/closed H2M order. This only creates
 * the batch record (status 'queued'); the codes and the Excel file are produced
 * by the resumable worker (/api/qr-batches/process or the cron).
 *
 * Authorization: the qr.batch.manage operation guard, then the same ownership
 * rule /api/qr-batches/process applies (the order's manufacturer, or the HQ
 * that owns it). The batch row is written with the service-role client after
 * those checks: since the identity Stage 1 closure (20260929140000) the
 * qr_batches INSERT policy only admits internal staff, so a manufacturer
 * user's own session can no longer create the row.
 *
 * Idempotent per order: an existing batch is returned instead of a new one, a
 * 'failed' batch is re-queued (the worker resumes its phases), and two
 * concurrent requests settle on the oldest row so an order never ends up with
 * two batches.
 */
export const dynamic = 'force-dynamic'

const BATCH_COLUMNS = 'id, status, total_unique_codes, total_master_codes, buffer_percent, last_error, created_at'

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status })
}

async function findOrderBatches(admin: any, orderId: string) {
  return admin
    .from('qr_batches')
    .select(BATCH_COLUMNS)
    .eq('order_id', orderId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
}

function existingBatchResponse(batch: any) {
  return json(200, {
    success: true,
    message: 'QR batch already exists for this order',
    batch_id: batch.id,
    batch,
    status: batch.status,
    total_unique_codes: batch.total_unique_codes,
    existing: true,
  })
}

export async function POST(request: NextRequest) {
  let orderId: unknown
  try {
    ;({ order_id: orderId } = await request.json())
  } catch {
    orderId = undefined
  }
  if (typeof orderId !== 'string' || orderId.trim() === '') {
    return json(400, { error: 'Missing order_id parameter' })
  }

  try {
    const supabase = await createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return json(401, { error: 'Unauthorized' })
    }
    const saDenied = await guardUserOperation(user.id, 'qr.batch.manage')
    if (saDenied) return saDenied

    const { data: profile, error: profileError } = await (supabase as any)
      .from('users')
      .select('is_active, organization_id, organizations:organization_id(org_type_code)')
      .eq('id', user.id)
      .single()

    const orgType = String(profile?.organizations?.org_type_code || '').toUpperCase()
    const orgId = String(profile?.organization_id || '')
    if (profileError || !profile || profile.is_active === false || !orgId || !PROCESSING_ORG_TYPES.includes(orgType)) {
      return json(403, { error: 'You do not have access to generate QR batches.' })
    }

    const admin = createAdminClient() as any

    // 1. The order, with everything the code generator needs.
    const { data: order, error: orderError } = await admin
      .from('orders')
      .select(`
        *,
        buyer_org:organizations!orders_buyer_org_id_fkey(
          id, org_name, org_code
        ),
        seller_org:organizations!orders_seller_org_id_fkey(
          id, org_name, org_code
        ),
        order_items(
          id,
          qty,
          product_id,
          variant_id,
          units_per_case,
          product:products(
            id,
            product_code,
            product_name
          ),
          variant:product_variants(
            id,
            variant_code,
            variant_name
          )
        )
      `)
      .eq('id', orderId)
      .maybeSingle()

    if (orderError) {
      console.error('[qr-batches/generate] order lookup failed:', orderError.message)
      return json(500, { error: 'Could not load the order. Please try again.', details: orderError.message })
    }
    // Orders outside the caller's organization answer 404 so their existence is not revealed.
    if (
      !order ||
      !canProcessBatchForOrder(orgType, orgId, order) ||
      order.order_type !== 'H2M' ||
      !['approved', 'closed'].includes(order.status)
    ) {
      return json(404, { error: 'Order not found or not eligible for QR generation (approved or closed H2M orders only).' })
    }

    // 2. One batch per order: return or resume an existing one.
    const { data: existingBatches, error: existingError } = await findOrderBatches(admin, order.id)
    if (existingError) {
      console.error('[qr-batches/generate] batch lookup failed:', existingError.message)
      return json(500, { error: 'Could not check for an existing QR batch. Please try again.', details: existingError.message })
    }

    const existing = existingBatches?.[0]
    if (existing) {
      if (existing.status !== 'failed') return existingBatchResponse(existing)

      // A failed batch keeps whatever it already produced; re-queuing lets the
      // worker resume from its recorded phase instead of starting a duplicate.
      const { data: requeued, error: requeueError } = await admin
        .from('qr_batches')
        .update({ status: 'queued', last_error: null })
        .eq('id', existing.id)
        .eq('status', 'failed')
        .select(BATCH_COLUMNS)

      if (requeueError) {
        console.error('[qr-batches/generate] re-queue failed:', requeueError.message)
        return json(500, { error: 'Could not retry the failed QR batch. Please try again.', details: requeueError.message })
      }
      const batch = requeued?.[0] ?? existing
      return json(200, {
        success: true,
        message: 'The failed QR batch was queued again and will resume where it stopped.',
        batch_id: batch.id,
        batch,
        status: batch.status,
        total_unique_codes: batch.total_unique_codes,
        resumed: true,
      })
    }

    // 3. Validate the lines before anything is written.
    const items: any[] = order.order_items ?? []
    if (items.length === 0) {
      return json(422, { error: 'This order has no items to generate QR codes for.' })
    }
    const incomplete = items.filter((item) => !item.product?.product_code || !item.variant?.variant_code)
    if (incomplete.length > 0) {
      return json(422, {
        error: `${incomplete.length} order line(s) are missing a product or variant code. Complete the product master data and try again.`,
      })
    }
    if (!order.seller_org?.id) {
      return json(422, { error: 'The order has no manufacturer organization.' })
    }

    const orderItems = items.map((item: any) => ({
      product_id: item.product_id,
      variant_id: item.variant_id,
      product_code: item.product.product_code,
      variant_code: item.variant.variant_code,
      product_name: item.product.product_name,
      variant_name: item.variant.variant_name,
      qty: item.qty,
      // Same resolution as the worker (lib/qr-batch-generation), so the stored
      // totals match the codes it generates.
      units_per_case: item.units_per_case ?? (order.units_per_case || 100),
    }))

    // Totals from the same generator the worker runs: one unique QR per ordered
    // case plus the buffer cases, and one master QR per box.
    const qrBatch = generateQRBatch({
      orderNo: order.order_no,
      manufacturerCode: order.seller_org.org_code,
      orderItems,
      bufferPercent: resolveQrBufferPercent(order.qr_buffer_percent),
      unitsPerCase: order.units_per_case || 100,
      useIndividualCaseSizes: orderItems.some(item => item.units_per_case != null),
    })

    // 4. Create the batch record ('queued').
    const { data: batch, error: batchError } = await admin
      .from('qr_batches')
      .insert({
        order_id: order.id,
        company_id: order.company_id || order.seller_org.id,
        total_master_codes: qrBatch.totalMasterCodes,
        total_unique_codes: qrBatch.totalUniqueCodes,
        buffer_percent: qrBatch.bufferPercent,
        status: 'queued',
        created_by: user.id,
        excel_generated: false,
        master_inserted: false,
        qr_inserted_count: 0,
      })
      .select(BATCH_COLUMNS)
      .single()

    if (batchError || !batch) {
      // The one-batch-per-order index (when installed) rejects a concurrent duplicate.
      if (batchError?.code === '23505') {
        const { data: winners } = await findOrderBatches(admin, order.id)
        if (winners?.[0]) return existingBatchResponse(winners[0])
      }
      console.error('[qr-batches/generate] batch insert failed:', batchError?.message)
      return json(500, { error: 'Failed to create the QR batch record.', details: batchError?.message })
    }

    // 5. Two requests that both passed step 2 settle on the oldest row; the
    // newer one is removed while it is still an empty 'queued' record.
    const { data: siblings } = await findOrderBatches(admin, order.id)
    const winner = siblings?.[0]
    if (winner && winner.id !== batch.id) {
      await admin.from('qr_batches').delete().eq('id', batch.id).eq('status', 'queued')
      return existingBatchResponse(winner)
    }

    return json(200, {
      success: true,
      message: 'Batch queued for generation. This may take a few minutes.',
      batch_id: batch.id,
      batch,
      status: 'queued',
      total_unique_codes: qrBatch.totalUniqueCodes,
      total_master_codes: qrBatch.totalMasterCodes,
    })
  } catch (error: any) {
    console.error('❌ QR Batch Queue Error:', error)
    return json(500, { error: 'Failed to queue QR batch', details: error?.message })
  }
}
