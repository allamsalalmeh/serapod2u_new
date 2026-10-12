import { guardUserOperation } from '@/lib/security-access/operation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { queueNotificationEvent } from '@/lib/notifications/supplyChainEventQueue'
import { loadProcessableBatch } from '@/lib/qr-batch-access-server'
import { NextRequest, NextResponse } from 'next/server'

/**
 * POST /api/manufacturer/complete-production
 * Marks a batch as production complete (ready for warehouse shipment)
 * Changes batch status from 'in_production' to 'completed'
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    // Get authenticated user
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const saDenied = await guardUserOperation(user.id, 'manufacturing.production.manage')
    if (saDenied) return saDenied

    const body = await request.json()
    const { batch_id } = body

    if (!batch_id) {
      return NextResponse.json(
        { error: 'batch_id is required' },
        { status: 400 }
      )
    }

    console.log('🏭 Completing production for batch:', batch_id)

    const loaded = await loadProcessableBatch(supabase, user.id, batch_id, 'id, status, total_master_codes, order_id')
    if (loaded.response) return loaded.response
    const { admin, batch } = loaded

    const orderInfo = Array.isArray(batch.order) ? batch.order[0] : batch.order

    // CRITICAL: Verify order has a destination warehouse assigned
    if (!orderInfo?.warehouse_org_id) {
      return NextResponse.json(
        {
          error: 'Order has no destination warehouse assigned. Cannot complete production.',
          order_id: orderInfo?.id,
          order_no: orderInfo?.order_no
        },
        { status: 400 }
      )
    }

    // Verify batch is in production or printing status (printing is valid for Mode C)
    const validStatuses = ['in_production', 'printing']
    if (!batch.status || !validStatuses.includes(batch.status)) {
      return NextResponse.json(
        {
          error: `Batch must be in production or printing status. Current status: ${batch.status}`,
          current_status: batch.status
        },
        { status: 400 }
      )
    }

    // Check if all master codes are packed
    // We use count: 'exact' to avoid 1000 row limit issues
    const { count: totalMasters, error: totalError } = await admin
      .from('qr_master_codes')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', batch_id)

    if (totalError) {
      throw totalError
    }

    const { count: packedMasters, error: packedError } = await admin
      .from('qr_master_codes')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', batch_id)
      .eq('status', 'packed')

    if (packedError) {
      throw packedError
    }

    const progressPercentage = (totalMasters || 0) > 0 ? Math.round(((packedMasters || 0) / (totalMasters || 0)) * 100) : 0

    console.log('📊 Production progress:', {
      batch_id,
      total_master_codes: totalMasters,
      packed_master_codes: packedMasters,
      progress: `${progressPercentage}%`
    })

    // ============================================================================
    // PART 3: CRITICAL PROPAGATION STEP
    // Before marking batch as completed, we MUST copy the order's warehouse
    // assignment into EVERY master case for this batch.
    // This is what makes warehouse receive work!
    // 
    // CHAIN OF CUSTODY:
    // orders.warehouse_org_id → qr_master_codes.warehouse_org_id
    // This happens HERE, at production completion time.
    // ============================================================================

    console.log('🔄 CRITICAL: Propagating warehouse assignment to all master cases...')
    console.log(`   Source: orders.warehouse_org_id = ${orderInfo.warehouse_org_id}`)
    console.log(`   Target: qr_master_codes.warehouse_org_id for batch ${batch_id}`)
    console.log(`   Expected cases to update: ${totalMasters}`)

    // Execute the critical UPDATE using database function to bypass RLS
    // This MUST succeed or warehouse receive will show empty forever
    const { data: propagateResult, error: propagateError } = await admin
      .rpc('propagate_warehouse_to_master_codes', {
        p_batch_id: batch_id
      })

    if (propagateError) {
      console.error('❌ CRITICAL ERROR: Failed to propagate warehouse assignment to master cases:', propagateError)
      throw new Error(`Failed to assign warehouse to master cases: ${propagateError.message}`)
    }

    const result = Array.isArray(propagateResult) ? propagateResult[0] : propagateResult
    const casesUpdated = result?.cases_updated || 0
    const propagatedWarehouseId = result?.warehouse_org_id

    console.log(`✅ SUCCESS: Warehouse assignment propagated to ${casesUpdated} master cases`)
    console.log(`   All cases now have warehouse_org_id = ${propagatedWarehouseId}`)

    if (casesUpdated !== totalMasters) {
      console.error(`❌ CRITICAL WARNING: Updated ${casesUpdated} cases but expected ${totalMasters}`)
      console.error(`   This means some master codes were NOT assigned to the warehouse!`)
      throw new Error(`Warehouse propagation incomplete: ${casesUpdated}/${totalMasters} cases updated`)
    }

    // Verify the propagated warehouse matches the order's warehouse
    if (propagatedWarehouseId !== orderInfo.warehouse_org_id) {
      console.error('❌ CRITICAL: Verification failed - warehouse_org_id mismatch!')
      console.error(`   Expected: ${orderInfo.warehouse_org_id}`)
      console.error(`   Got: ${propagatedWarehouseId}`)
      throw new Error('Warehouse propagation verification failed')
    }

    console.log('✅ Verification passed: warehouse_org_id correctly set in qr_master_codes')

    // ============================================================================
    // Update all master codes from 'packed' to 'ready_to_ship'
    // NOTE: Worker now sets them to 'ready_to_ship' directly, but we keep this
    // as a safety net to ensure everything is consistent.
    // ============================================================================

    console.log('📝 Ensuring master codes status is ready_to_ship')

    const { error: masterUpdateError, count: masterUpdatedCount } = await admin
      .from('qr_master_codes')
      .update({
        status: 'ready_to_ship',
        updated_at: new Date().toISOString()
      })
      .eq('batch_id', batch_id)
      .in('status', ['packed', 'printed']) // Catch any stragglers

    if (masterUpdateError) {
      console.error('❌ Failed to update master codes status:', masterUpdateError)
      throw masterUpdateError
    }

    console.log(`✅ ${masterUpdatedCount || 0} master codes ensured as 'ready_to_ship' status`)

    // ============================================================================
    // Update all unique codes from 'packed' to 'ready_to_ship'
    // ============================================================================

    console.log('📝 Ensuring unique codes status is ready_to_ship')

    // Update using batch_id directly instead of fetching master IDs first
    // This avoids the 1000 row limit on fetching master IDs
    const { error: uniqueUpdateError, count: uniqueUpdatedCount } = await admin
      .from('qr_codes')
      .update({
        status: 'ready_to_ship',
        updated_at: new Date().toISOString()
      })
      .eq('batch_id', batch_id)
      .in('status', ['packed', 'printed']) // Catch any stragglers

    if (uniqueUpdateError) {
      console.error('❌ Failed to update unique codes status:', uniqueUpdateError)
      throw uniqueUpdateError
    }

    console.log(`✅ ${uniqueUpdatedCount || 0} unique codes ensured as 'ready_to_ship' status`)

    // ============================================================================
    // NOW mark batch as completed (only after successful propagation)
    // ============================================================================

    // Update batch status to completed
    const { data: completedRows, error: updateError } = await admin
      .from('qr_batches')
      .update({
        status: 'completed',
        production_completed_at: new Date().toISOString(),
        production_completed_by: user.id,
        updated_at: new Date().toISOString()
      })
      .eq('id', batch_id)
      .select('id')

    if (updateError) {
      console.error('❌ Failed to update batch status:', updateError)
      throw updateError
    }
    if (!completedRows || completedRows.length === 0) {
      throw new Error('Batch could not be marked as completed')
    }

    console.log('✅ Batch marked as completed and ready for warehouse shipment')

    // ============================================================================
    // CREATE BALANCE PAYMENT REQUEST
    // Trigger balance payment request creation when production is complete
    // ============================================================================

    console.log('💰 Creating balance payment request for order:', orderInfo.id)

    const { data: balancePaymentDoc, error: balanceError } = await admin
      .rpc('fn_create_balance_payment_request', {
        p_order_id: orderInfo.id
      })

    let balancePaymentCreated = false
    let balanceDocumentNo = null

    if (balanceError) {
      // Log error but don't fail the whole operation
      console.error('⚠️  Failed to create balance payment request:', balanceError)
    } else if (balancePaymentDoc) {
      balancePaymentCreated = true
      console.log('✅ Balance payment request created:', balancePaymentDoc)

      // Fetch the created document to get its doc_no
      const { data: docData } = await admin
        .from('documents')
        .select('doc_no')
        .eq('id', balancePaymentDoc)
        .single()

      balanceDocumentNo = docData?.doc_no
    }

    // ============================================================================
    // QUEUE NOTIFICATION: Manufacturer Scan Complete
    // ============================================================================
    try {
      const adminSupabase = createAdminClient()

      // Fetch order with more details for notification
      const { data: orderDetail } = await adminSupabase
        .from('orders')
        .select('display_doc_no, order_no, company_id, buyer_org_id, seller_org_id, notes')
        .eq('id', orderInfo.id)
        .single()

      const displayOrderNo = orderDetail?.display_doc_no || orderDetail?.order_no || orderInfo.order_no
      const notes = orderDetail?.notes || ''
      const customerMatch = notes.match(/Customer:\s*([^,]+)/)
      const customerName = customerMatch?.[1]?.trim() || 'N/A'

      const payload = {
        order_no: displayOrderNo,
        batch_id: batch.id,
        total_master_codes: totalMasters?.toString() || '0',
        total_unique_codes: ((totalMasters || 0) * 110).toString(),
        production_completed_at: new Date().toLocaleString('en-GB'),
        completed_by: user.email || 'Manufacturer',
        customer_name: customerName,
        balance_document_no: balanceDocumentNo || 'N/A',
        order_url: `${request.nextUrl.origin}/supply-chain`
      }

      const queueResult = await queueNotificationEvent(adminSupabase, {
        orgId: orderDetail?.buyer_org_id || orderDetail?.company_id,
        eventCode: 'manufacturer_scan_complete',
        payload,
        dedupePayload: { order_no: displayOrderNo },
      })
      console.log('📨 Manufacturer scan complete notification queued', queueResult)
    } catch (notifErr) {
      console.warn('⚠️ Failed to queue notification (non-blocking):', notifErr)
    }

    // Fire-and-forget: trigger notification outbox worker
    const baseUrl = request.nextUrl.origin
    fetch(`${baseUrl}/api/cron/notification-outbox-worker`).catch(() => { })

    return NextResponse.json({
      success: true,
      message: 'Production completed successfully. Batch is now ready for warehouse shipment.',
      batchId: batch.id,
      order_no: orderInfo?.order_no,
      warehouseOrgId: orderInfo.warehouse_org_id,
      casesUpdated: casesUpdated,
      total_master_codes: totalMasters,
      packed_master_codes: packedMasters,
      progress_percentage: progressPercentage,
      production_completed_at: new Date().toISOString(),
      balance_payment_created: balancePaymentCreated,
      balance_document_no: balanceDocumentNo
    })
  } catch (error: any) {
    console.error('❌ Complete production error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to complete production' },
      { status: 500 }
    )
  }
}
