import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { queueNotificationEvent } from '@/lib/notifications/supplyChainEventQueue'
import { markWarrantyBufferReceived, promoteModeCBufferUsedForReceivedCases } from '@/lib/warehouse/qrEligibility'
import { requireCronOrSessionAuth } from '@/lib/cron/auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes max

// ============================================================================
// CONFIGURATION - Optimized for large batches (1500+ master codes)
// ============================================================================
const CHUNK_SIZE = parseInt(process.env.RECEIVE_CHUNK_SIZE || '500', 10) // Lowered to 500
const IN_CLAUSE_SIZE = parseInt(process.env.RECEIVE_IN_CLAUSE_SIZE || '50', 10) // Keep small to avoid URL length limits with UUID .in() filters
const MAX_RUNTIME_MS = parseInt(process.env.MAX_RUNTIME_PER_RUN_MS || '270000', 10) // 4.5 minutes default
const STALE_THRESHOLD_MS = 120 * 1000 // 2 minutes - more tolerance for large batches
const HEARTBEAT_INTERVAL = 1 // Update heartbeat every chunk (more frequent for large batches)
const CANCEL_CHECK_INTERVAL = 3 // Check for cancellation every 3 chunks
const MAX_RETRIES = 3 // Maximum retries for transient errors
const RETRY_DELAY_MS = 1000 // Base delay between retries (exponential backoff)

// Generate short unique worker ID
function generateWorkerId(): string {
  return Math.random().toString(36).substring(2, 10)
}

/**
 * Warehouse Receiving Worker
 * 
 * Processes QR code status updates in chunks with:
 * - Heartbeat tracking for stale detection  
 * - Resumable processing
 * - Proper claim/release logic
 * - High throughput via larger batches
 */
export async function GET(request: NextRequest) {
  // This worker is triggered BOTH by server-side callers and by the warehouse
  // dashboard in the browser (WarehouseReceiveView2), which cannot hold
  // CRON_SECRET. Accept a cron credential OR an authenticated session; reject
  // anonymous callers.
  const unauthorized = await requireCronOrSessionAuth(request, 'warehouse-receiving-worker')
  if (unauthorized) return unauthorized

  const workerId = generateWorkerId()
  const startTime = Date.now()
  const supabase = createAdminClient(120_000) // 2-minute timeout for batch operations

  // DB-based logging since container stdout doesn't capture API route logs
  let _dbLogBatchId: string | null = null
  const dbLog = async (msg: string) => {
    console.log(msg)
    if (_dbLogBatchId) {
      await supabase.from('qr_batches').update({ last_error: `[${workerId}] ${msg} [${new Date().toISOString()}]` }).eq('id', _dbLogBatchId)
    }
  }

  console.log(`🚀 [${workerId}] Warehouse Receiving Worker started (chunk=${CHUNK_SIZE}, in_clause=${IN_CLAUSE_SIZE}, heartbeat_interval=${HEARTBEAT_INTERVAL})`)

  try {
    // Step 1: Diagnostic - show top batches for debugging
    await logDiagnostics(supabase, workerId)

    // Step 2: Find and claim a batch to process  
    const claimResult = await claimBatch(supabase, workerId)

    if (!claimResult.batch) {
      if (claimResult.reason === 'active_worker') {
        console.log(`⏳ [${workerId}] Batch being processed by another worker (${claimResult.activeWorker})`)
        return NextResponse.json({
          message: 'Batch being processed by another worker',
          worker_id: workerId,
          active_worker: claimResult.activeWorker
        })
      }
      console.log(`📭 [${workerId}] No batches to process`)
      return NextResponse.json({ message: 'No batches to process', worker_id: workerId })
    }

    const batch = claimResult.batch
    _dbLogBatchId = batch.id as string
    await dbLog(`Claimed batch ${batch.id}`)

    const order = batch.orders as any
    const warehouseOrgId = await resolveWarehouseOrgId(supabase, order?.buyer_org_id)
    await dbLog(`resolveWarehouseOrgId: ${warehouseOrgId}`)
    const manufacturerOrgId = order?.seller_org_id
    const companyId = order?.company_id
    const orderId = order?.id
    const orderNo = order?.order_no

    // Get received_by from metadata or created_by
    let receivedBy = batch.created_by
    try {
      if (batch.last_error && batch.last_error.includes('received_by')) {
        const meta = JSON.parse(batch.last_error)
        if (meta.received_by) receivedBy = meta.received_by
      }
    } catch (e) { /* ignore */ }

    // Get variant price map for inventory
    const variantPriceMap = new Map<string, number>()
    if (order?.order_items) {
      order.order_items.forEach((item: any) => {
        if (item.variant_id && item.unit_price != null) {
          variantPriceMap.set(item.variant_id, Number(item.unit_price))
        }
      })
    }

    // Get warranty bonus
    let warrantyBonusPercent = 0
    if (manufacturerOrgId) {
      const { data: mfgOrg } = await supabase
        .from('organizations')
        .select('*')
        .eq('id', manufacturerOrgId)
        .single()
      if ((mfgOrg as any)?.warranty_bonus) warrantyBonusPercent = Number((mfgOrg as any).warranty_bonus)
    }

    // For resumable processing: get ACTUAL count of already-received codes from DB
    // This handles scenarios where progress counter is out of sync (e.g., worker crash)
    const { count: actualReceivedCount } = await supabase
      .from('qr_codes')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', batch.id)
      .eq('status', 'received_warehouse')
      .eq('is_buffer', false)

    let totalProcessed = actualReceivedCount || 0

    // Log if there's a mismatch between stored and actual progress
    if (batch.receiving_progress && Math.abs(totalProcessed - batch.receiving_progress) > 100) {
      console.log(`⚠️ [${workerId}] Progress mismatch detected: stored=${batch.receiving_progress}, actual=${totalProcessed}`)
    }

    console.log(`📊 [${workerId}] Starting with actual progress: ${totalProcessed} already received`)

    // Step 3: Process Master Codes (if not done)
    await dbLog('Starting processMasterCodes...')
    const masterResult = await processMasterCodes(supabase, batch.id, warehouseOrgId, manufacturerOrgId, companyId, orderId, receivedBy)
    await dbLog(`Master codes done: ${masterResult.processed}`)

    // Step 4: Process Unique Codes in chunks (optimized for high throughput)
    await dbLog(`Starting unique code loop. Progress: ${totalProcessed}`)

    const cumulativeVariantCounts = new Map<string, number>()
    let chunksProcessed = 0
    let consecutiveZeroChunks = 0

    while (true) {
      // Check for cancellation periodically (not every iteration to reduce DB calls)
      if (chunksProcessed % CANCEL_CHECK_INTERVAL === 0 && chunksProcessed > 0) {
        const { data: statusCheck } = await supabase
          .from('qr_batches')
          .select('receiving_status')
          .eq('id', batch.id)
          .single()

        if (statusCheck?.receiving_status === 'cancelled') {
          console.log(`🛑 [${workerId}] Job cancelled, stopping`)
          return NextResponse.json({
            message: 'Job cancelled',
            worker_id: workerId,
            processed: totalProcessed
          })
        }
      }

      // Check time limit
      const elapsed = Date.now() - startTime
      if (elapsed > MAX_RUNTIME_MS) {
        console.log(`⏱️ [${workerId}] Time limit reached (${Math.round(elapsed / 1000)}s). Processed: ${totalProcessed}. Will continue next run.`)
        await updateHeartbeat(supabase, batch.id, workerId, totalProcessed)
        return NextResponse.json({
          message: 'Partial processing, will continue',
          worker_id: workerId,
          processed: totalProcessed,
          hasMore: true
        })
      }

      // Fetch next chunk of unique codes (only IDs and variant_id for counting)
      // Retry logic for transient errors (e.g., statement timeouts)
      let uniqueCodes: any[] | null = null
      let fetchError: any = null

      for (let fetchRetry = 0; fetchRetry < MAX_RETRIES; fetchRetry++) {
        if (fetchRetry > 0) {
          const delay = RETRY_DELAY_MS * Math.pow(2, fetchRetry - 1)
          console.log(`  🔄 [${workerId}] Fetch retry ${fetchRetry}/${MAX_RETRIES} after ${delay}ms delay...`)
          await new Promise(resolve => setTimeout(resolve, delay))
        }

        const result = await supabase
          .from('qr_codes')
          .select('id, variant_id')
          .eq('batch_id', batch.id)
          .eq('status', 'ready_to_ship')
          .eq('is_buffer', false)
          .order('id', { ascending: true })
          .limit(CHUNK_SIZE)

        if (!result.error) {
          uniqueCodes = result.data
          fetchError = null
          break
        }

        fetchError = result.error

        // For statement timeout, retry; for other errors, break
        if (fetchError.code !== '57014' && !fetchError.message?.includes('timeout')) {
          break
        }
        console.warn(`  ⚠️ [${workerId}] Statement timeout on fetch (retry ${fetchRetry + 1}/${MAX_RETRIES})`)
      }

      if (fetchError) {
        console.error(`❌ [${workerId}] Error fetching codes after ${MAX_RETRIES} retries:`, fetchError)
        // Update progress before marking failed so we don't lose track
        await updateHeartbeat(supabase, batch.id, workerId, totalProcessed)
        await markFailed(supabase, batch.id, `Fetch error: ${fetchError.message}`)
        return NextResponse.json({ error: fetchError.message }, { status: 500 })
      }

      if (!uniqueCodes || uniqueCodes.length === 0) {
        consecutiveZeroChunks++
        if (consecutiveZeroChunks >= 2) {
          console.log(`✅ [${workerId}] No more unique codes to process (confirmed)`)
          break
        }
        // First zero might be a race condition, try once more
        continue
      }

      consecutiveZeroChunks = 0
      await dbLog(`Fetched ${uniqueCodes.length} codes, updating...`)

      // Update this chunk using sub-batches with retry logic
      const chunkIds = uniqueCodes.map(c => c.id)
      let updateError: any = null
      let updatedInChunk = 0

      for (let i = 0; i < chunkIds.length; i += IN_CLAUSE_SIZE) {
        const batchIds = chunkIds.slice(i, i + IN_CLAUSE_SIZE)

        // Retry logic with exponential backoff
        let lastError: any = null
        let success = false

        for (let retry = 0; retry < MAX_RETRIES && !success; retry++) {
          if (retry > 0) {
            const delay = RETRY_DELAY_MS * Math.pow(2, retry - 1)
            console.log(`  🔄 [${workerId}] Retry ${retry}/${MAX_RETRIES} after ${delay}ms delay...`)
            await new Promise(resolve => setTimeout(resolve, delay))
          }

          const { error } = await supabase
            .from('qr_codes')
            .update({ status: 'received_warehouse' })
            .in('id', batchIds)

          if (!error) {
            success = true
            break
          }

          lastError = error
          await dbLog(`Update error at offset ${i}, batch size ${batchIds.length}: ${JSON.stringify(lastError)}`)

          // Check if it's a statement timeout - this is recoverable
          if (error.code === '57014' || error.message?.includes('timeout')) {
            console.warn(`  ⚠️ [${workerId}] Statement timeout at offset ${i} (retry ${retry + 1}/${MAX_RETRIES})`)
            // Continue to retry
            continue
          }

          // For non-timeout errors, don't retry
          break
        }

        if (!success && lastError) {
          // If still failing after retries on timeout, yield for next run
          if (lastError.code === '57014' || lastError.message?.includes('timeout')) {
            console.warn(`  ⚠️ [${workerId}] Statement timeout persists after ${MAX_RETRIES} retries, yielding for next run`)
            await updateHeartbeat(supabase, batch.id, workerId, totalProcessed + updatedInChunk)
            return NextResponse.json({
              message: 'Statement timeout, yielding for retry',
              worker_id: workerId,
              processed: totalProcessed + updatedInChunk,
              hasMore: true
            })
          }

          console.error(`  ❌ Update error at offset ${i}:`, JSON.stringify(lastError, null, 2))
          updateError = lastError
          break
        }

        updatedInChunk += batchIds.length

        // Update heartbeat more frequently during large batch processing
        if (updatedInChunk % (IN_CLAUSE_SIZE * 5) === 0) {
          await updateHeartbeat(supabase, batch.id, workerId, totalProcessed + updatedInChunk)
        }
      }

      if (updateError) {
        // Don't mark as failed for transient errors, just yield
        console.error(`  ❌ [${workerId}] Update error, yielding for retry`)
        await updateHeartbeat(supabase, batch.id, workerId, totalProcessed)
        return NextResponse.json({ error: updateError.message || 'Update failed' }, { status: 500 })
      }

      // Accumulate variant counts for inventory
      uniqueCodes.forEach(c => {
        if (c.variant_id) {
          cumulativeVariantCounts.set(c.variant_id, (cumulativeVariantCounts.get(c.variant_id) || 0) + 1)
        }
      })

      totalProcessed += updatedInChunk
      chunksProcessed++

      // Update heartbeat periodically (not every chunk to reduce DB calls)
      if (chunksProcessed % HEARTBEAT_INTERVAL === 0) {
        await updateHeartbeat(supabase, batch.id, workerId, totalProcessed)
      }

      const rate = Math.round(totalProcessed / ((Date.now() - startTime) / 1000))
      console.log(`✅ [${workerId}] Chunk ${chunksProcessed}: +${updatedInChunk} (total: ${totalProcessed}, rate: ${rate}/s)`)
    }

    // Step 5a: QR ELIGIBILITY for warranty buffer codes — BOTH modes.
    // ------------------------------------------------------------------------
    // Buffer/warranty QR codes are part of QR eligibility: for both full and
    // partial first-receipts they must transition to received_warehouse so the
    // codes are scannable (mirrors the full-receive QR flow). This is a pure QR
    // status change; it never creates inventory. Inventory for the buffer is
    // recorded only by the full-receive path below.
    // ------------------------------------------------------------------------
    const orderVariantIds: string[] = (order?.order_items || [])
      .map((i: any) => i.variant_id)
      .filter(Boolean)

    let bufferMarked = new Map<string, number>()
    if (warrantyBonusPercent > 0 && orderVariantIds.length > 0) {
      bufferMarked = await markWarrantyBufferReceived(supabase, batch.id, orderVariantIds, warrantyBonusPercent)
      await dbLog(`Buffer eligibility marked: ${Array.from(bufferMarked.values()).reduce((a, b) => a + b, 0)} codes`)
    }

    // Mode C replacements linked to received cases must become scannable.
    try {
      const modeCPromoted = await promoteModeCBufferUsedForReceivedCases(supabase, batch.id, {
        warehouseOrgId,
      })
      if (modeCPromoted > 0) {
        await dbLog(`Mode C buffer_used promoted: ${modeCPromoted}`)
        console.log(`🔁 [${workerId}] Mode C buffer_used promoted to received_warehouse: ${modeCPromoted}`)
      }
    } catch (modeCErr: any) {
      console.warn(`⚠️ [${workerId}] Mode C buffer promote failed (non-blocking):`, modeCErr?.message || modeCErr)
    }

    // Step 5b: Inventory movements.
    // ------------------------------------------------------------------------
    // BACKEND SEPARATION (partial receiving):
    // When receiving_mode === 'partial', the worker is responsible ONLY for QR /
    // master / buffer status transitions (eligibility). Inventory for partial
    // receipts is posted separately from the physically-counted quantities via
    // the post_warehouse_receipt RPC (see /api/warehouse/confirm-receipt). We
    // must NOT derive inventory from the number of received QR codes here, and we
    // must NOT auto-add the warranty buffer to inventory.
    //
    // For 'full' mode (Receive All) or legacy batches (receiving_mode null) we
    // preserve the original behaviour: post full order + configured buffer.
    // ------------------------------------------------------------------------
    if (batch.receiving_mode === 'partial') {
      console.log(`🧾 [${workerId}] Partial mode: buffer marked for eligibility only; skipping QR-derived inventory (handled by receipt posting)`)
    } else {
      console.log(`📊 [${workerId}] Querying actual variant counts from received codes...`)

      const actualVariantCounts = await getActualReceivedCounts(supabase, batch.id)

      if (warehouseOrgId && actualVariantCounts.size > 0) {
        console.log(`📊 [${workerId}] Recording inventory for ${actualVariantCounts.size} variants (total units: ${Array.from(actualVariantCounts.values()).reduce((a, b) => a + b, 0)})`)
        await recordInventoryMovements(
          supabase, batch.id, warehouseOrgId, manufacturerOrgId,
          companyId, orderId, orderNo, receivedBy,
          actualVariantCounts, variantPriceMap, bufferMarked
        )
      } else {
        console.log(`⚠️ [${workerId}] No variant counts found to record`)
      }
    }

    // Step 6: Mark as completed
    await supabase
      .from('qr_batches')
      .update({
        receiving_status: 'completed',
        receiving_completed_at: new Date().toISOString(),
        receiving_progress: totalProcessed,
        last_error: null
      })
      .eq('id', batch.id)

    const totalTime = Math.round((Date.now() - startTime) / 1000)
    console.log(`🎉 [${workerId}] Batch ${batch.id} completed! Processed: ${totalProcessed} in ${totalTime}s`)

    // Queue notification for warehouse received
    try {
      const displayOrderNo = order?.display_doc_no || order?.order_no || orderNo
      const warehouseName = warehouseOrgId
        ? (await supabase.from('organizations').select('org_name').eq('id', warehouseOrgId).single()).data?.org_name || 'Warehouse'
        : 'Warehouse'
      const notifPayload = {
        order_id: orderId,
        order_no: displayOrderNo,
        warehouse_org_id: warehouseOrgId || null,
        batch_id: batch.id,
        total_received: totalProcessed.toString(),
        warehouse_name: warehouseName,
        received_at: new Date().toLocaleString('en-GB'),
        order_url: `${request.nextUrl.origin}/supply-chain`
      }
      const queueResult = await queueNotificationEvent(supabase, {
        orgId: order?.buyer_org_id || companyId,
        eventCode: 'warehouse_received',
        payload: notifPayload,
        dedupePayload: { order_no: displayOrderNo },
      })
      console.log(`📨 [${workerId}] Warehouse received notification queued`, queueResult)
    } catch (notifErr) {
      console.warn(`⚠️ [${workerId}] Failed to queue warehouse notification (non-blocking):`, notifErr)
    }

    return NextResponse.json({
      success: true,
      message: 'Batch receiving completed',
      worker_id: workerId,
      processed: totalProcessed,
      duration_seconds: totalTime,
      batch_id: batch.id
    })

  } catch (error: any) {
    console.error(`❌ [${workerId}] Worker error:`, error)
    // Mark batch as failed so it doesn't stay stuck in 'processing'
    try {
      const { data: stuckBatch } = await supabase
        .from('qr_batches')
        .select('id')
        .eq('receiving_worker_id', workerId)
        .eq('receiving_status', 'processing')
        .single()
      if (stuckBatch) {
        await markFailed(supabase, stuckBatch.id, `Worker crash: ${error.message || error}`)
      }
    } catch (cleanupErr) {
      console.error(`❌ [${workerId}] Failed to mark batch as failed:`, cleanupErr)
    }
    return NextResponse.json({
      error: error.message || 'Worker failed',
      worker_id: workerId
    }, { status: 500 })
  }
}

/**
 * Log diagnostic info about batches for debugging
 */
async function logDiagnostics(supabase: any, workerId: string) {
  const { data: batches } = await supabase
    .from('qr_batches')
    .select(`
      id,
      receiving_status,
      receiving_heartbeat,
      receiving_worker_id,
      receiving_progress,
      total_unique_codes,
      orders!inner (order_no)
    `)
    .in('receiving_status', ['queued', 'processing', 'failed'])
    .order('created_at', { ascending: false })
    .limit(3)

  if (batches && batches.length > 0) {
    console.log(`📊 [${workerId}] Top batches:`)
    for (const b of batches) {
      const heartbeatAge = b.receiving_heartbeat
        ? Math.round((Date.now() - new Date(b.receiving_heartbeat).getTime()) / 1000)
        : 'never'
      console.log(`   - ${(b.orders as any)?.order_no}: status=${b.receiving_status}, heartbeat=${heartbeatAge}s ago, progress=${b.receiving_progress}/${b.total_unique_codes}`)
    }
  }
}

/**
 * Claim a batch for processing with proper stale detection
 * Returns: { batch, reason, activeWorker }
 */
async function claimBatch(supabase: any, workerId: string): Promise<{
  batch: any | null,
  reason?: 'active_worker' | 'no_batches',
  activeWorker?: string
}> {
  const now = new Date()
  const staleThreshold = new Date(now.getTime() - STALE_THRESHOLD_MS)

  // Strategy 1: Try to claim a 'queued' batch first (highest priority)
  const { data: queuedBatches } = await supabase
    .from('qr_batches')
    .select('id')
    .eq('receiving_status', 'queued')
    .order('created_at', { ascending: true })
    .limit(1)

  if (queuedBatches && queuedBatches.length > 0) {
    const batchId = queuedBatches[0].id

    const { data: claimed } = await supabase
      .from('qr_batches')
      .update({
        receiving_status: 'processing',
        receiving_worker_id: workerId,
        receiving_heartbeat: now.toISOString(),
        receiving_started_at: now.toISOString(),
        receiving_progress: 0,
        last_error: null
      })
      .eq('id', batchId)
      .eq('receiving_status', 'queued')
      .select(`
        id, receiving_status, receiving_progress, receiving_mode, created_by, last_error, order_id, total_unique_codes,
        orders (id, order_no, buyer_org_id, seller_org_id, company_id, order_items (variant_id, unit_price))
      `)
      .single()

    if (claimed) {
      console.log(`📥 [${workerId}] Claimed queued batch ${batchId}`)
      return { batch: claimed }
    }
  }

  // Strategy 2: Resume a 'processing' batch (either stale or same worker)
  const { data: processingBatches } = await supabase
    .from('qr_batches')
    .select(`
      id, receiving_status, receiving_progress, receiving_mode, receiving_worker_id, receiving_heartbeat,
      created_by, last_error, order_id, total_unique_codes,
      orders (id, order_no, buyer_org_id, seller_org_id, company_id, order_items (variant_id, unit_price))
    `)
    .eq('receiving_status', 'processing')
    .order('created_at', { ascending: true })
    .limit(5)

  if (processingBatches && processingBatches.length > 0) {
    for (const batch of processingBatches) {
      const heartbeat = batch.receiving_heartbeat ? new Date(batch.receiving_heartbeat) : null
      const isStale = !heartbeat || heartbeat < staleThreshold
      const isMine = batch.receiving_worker_id === workerId

      if (isStale || isMine) {
        // Re-claim this batch.
        // CAS on the previous owner so two workers that both observe the same
        // stale batch cannot both take it - only the first re-claim matches.
        const { data: reclaimed } = await supabase
          .from('qr_batches')
          .update({
            receiving_worker_id: workerId,
            receiving_heartbeat: now.toISOString(),
            last_error: isStale ? `Re-claimed from stale worker ${batch.receiving_worker_id}` : null
          })
          .eq('id', batch.id)
          .eq('receiving_worker_id', batch.receiving_worker_id)
          .select('id')

        if (!reclaimed || reclaimed.length === 0) {
          console.log(`⏭️  [${workerId}] Batch ${batch.id} re-claimed by another worker first - skipping`)
          return { batch: null, reason: 'active_worker', activeWorker: batch.receiving_worker_id }
        }

        console.log(`🔄 [${workerId}] ${isStale ? 'Re-claimed stale' : 'Resumed'} batch ${batch.id}`)
        return { batch }
      } else {
        // There's an active worker on this batch
        return {
          batch: null,
          reason: 'active_worker',
          activeWorker: batch.receiving_worker_id
        }
      }
    }
  }

  // Strategy 3: Retry a 'failed' batch that still has pending codes
  const { data: failedBatches } = await supabase
    .from('qr_batches')
    .select(`
      id, receiving_status, receiving_progress, receiving_mode, created_by, last_error, order_id, total_unique_codes,
      orders (id, order_no, buyer_org_id, seller_org_id, company_id, order_items (variant_id, unit_price))
    `)
    .eq('receiving_status', 'failed')
    .order('created_at', { ascending: true })
    .limit(3)

  if (failedBatches && failedBatches.length > 0) {
    for (const batch of failedBatches) {
      // Check if there are still pending codes
      const { count: pendingCount } = await supabase
        .from('qr_codes')
        .select('*', { count: 'exact', head: true })
        .eq('batch_id', batch.id)
        .eq('status', 'ready_to_ship')
        .eq('is_buffer', false)

      if (pendingCount && pendingCount > 0) {
        // Re-queue this failed batch
        await supabase
          .from('qr_batches')
          .update({
            receiving_status: 'processing',
            receiving_worker_id: workerId,
            receiving_heartbeat: now.toISOString(),
            last_error: `Auto-retrying failed batch (was: ${batch.last_error})`
          })
          .eq('id', batch.id)

        console.log(`🔁 [${workerId}] Auto-retrying failed batch ${batch.id} (${pendingCount} pending codes)`)
        return { batch }
      }
    }
  }

  return { batch: null, reason: 'no_batches' }
}

/**
 * Update heartbeat and progress
 */
async function updateHeartbeat(supabase: any, batchId: string, workerId: string, progress: number) {
  await supabase
    .from('qr_batches')
    .update({
      receiving_heartbeat: new Date().toISOString(),
      receiving_progress: progress,
      receiving_worker_id: workerId
    })
    .eq('id', batchId)
}

/**
 * Mark batch as failed with error message
 * Preserves progress and heartbeat for debugging
 */
async function markFailed(supabase: any, batchId: string, error: string) {
  await supabase
    .from('qr_batches')
    .update({
      receiving_status: 'failed',
      receiving_heartbeat: new Date().toISOString(), // Update heartbeat on failure for tracking
      last_error: `${error.substring(0, 450)} [${new Date().toISOString()}]`
    })
    .eq('id', batchId)
}

/**
 * Resolve warehouse org ID (handle HQ -> WH mapping)
 */
async function resolveWarehouseOrgId(supabase: any, buyerOrgId: string): Promise<string> {
  if (!buyerOrgId) return buyerOrgId

  const { data: buyerOrg } = await supabase
    .from('organizations')
    .select('org_type_code')
    .eq('id', buyerOrgId)
    .single()

  if (buyerOrg?.org_type_code === 'HQ') {
    const { data: whOrg } = await supabase
      .from('organizations')
      .select('id')
      .eq('parent_org_id', buyerOrgId)
      .eq('org_type_code', 'WH')
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .single()

    if (whOrg) {
      console.log(`📍 Resolved Warehouse: ${whOrg.id} (from HQ: ${buyerOrgId})`)
      return whOrg.id
    }
  }

  return buyerOrgId
}

/**
 * Process master codes (bulk update)
 */
async function processMasterCodes(
  supabase: any, batchId: string, warehouseOrgId: string,
  manufacturerOrgId: string, companyId: string, orderId: string, receivedBy: string
): Promise<{ processed: number }> {
  // Use direct filter update instead of fetching IDs first
  const { error, count } = await supabase
    .from('qr_master_codes')
    .update({ status: 'received_warehouse' })
    .eq('batch_id', batchId)
    .eq('status', 'ready_to_ship')

  if (error) {
    console.error('Error updating master codes:', error)
    return { processed: 0 }
  }

  const processed = count || 0

  // Log movements for master codes if any were updated
  if (processed > 0 && warehouseOrgId && manufacturerOrgId) {
    const { data: masterCodes } = await supabase
      .from('qr_master_codes')
      .select('id, master_code')
      .eq('batch_id', batchId)
      .eq('status', 'received_warehouse')
      .limit(processed)

    if (masterCodes && masterCodes.length > 0) {
      const movements = masterCodes.map((m: any) => ({
        company_id: companyId,
        qr_master_code_id: m.id,
        movement_type: 'warehouse_receive',
        from_org_id: manufacturerOrgId,
        to_org_id: warehouseOrgId,
        current_status: 'received_warehouse',
        scanned_at: new Date().toISOString(),
        scanned_by: receivedBy,
        related_order_id: orderId,
        notes: `Warehouse receive: ${m.master_code}`
      }))

      // Insert in batches of 500
      for (let i = 0; i < movements.length; i += 500) {
        await supabase.from('qr_movements').insert(movements.slice(i, i + 500))
      }
    }
  }

  return { processed }
}

/**
 * Get ACTUAL counts of received codes from the database.
 * This is critical for multi-run scenarios where in-memory counts would be lost between runs.
 * Uses efficient SQL aggregation to avoid fetching all rows.
 */
async function getActualReceivedCounts(supabase: any, batchId: string): Promise<Map<string, number>> {
  const variantCounts = new Map<string, number>()

  // Use RPC for efficient GROUP BY aggregation
  // This avoids fetching 100k+ rows just to count them
  const { data, error } = await supabase.rpc('get_batch_variant_counts', {
    p_batch_id: batchId,
    p_status: 'received_warehouse'
  })

  if (error) {
    // Fallback: If RPC doesn't exist, use direct query (less efficient but works)
    console.warn('RPC get_batch_variant_counts not available, using fallback query:', error.message)
    return await getActualReceivedCountsFallback(supabase, batchId)
  }

  if (data && data.length > 0) {
    let totalUnits = 0
    for (const row of data) {
      if (row.variant_id && row.count) {
        const count = parseInt(row.count, 10)
        variantCounts.set(row.variant_id, count)
        totalUnits += count
      }
    }

    console.log(`📊 Found ${totalUnits} received codes across ${variantCounts.size} variants`)
    for (const [variantId, count] of variantCounts.entries()) {
      console.log(`   - Variant ${variantId}: ${count} units`)
    }
  }

  return variantCounts
}

/**
 * Fallback method for counting received codes when RPC is not available.
 * Less efficient but handles the case where the RPC hasn't been deployed.
 */
async function getActualReceivedCountsFallback(supabase: any, batchId: string): Promise<Map<string, number>> {
  const variantCounts = new Map<string, number>()

  // Paginate through results to handle large batches
  const PAGE_SIZE = 10000
  let offset = 0
  let hasMore = true

  while (hasMore) {
    const { data, error } = await supabase
      .from('qr_codes')
      .select('variant_id')
      .eq('batch_id', batchId)
      .eq('status', 'received_warehouse')
      .eq('is_buffer', false)
      .range(offset, offset + PAGE_SIZE - 1)

    if (error) {
      console.error('Error fetching received code counts:', error)
      break
    }

    if (!data || data.length === 0) {
      hasMore = false
    } else {
      for (const code of data) {
        if (code.variant_id) {
          variantCounts.set(code.variant_id, (variantCounts.get(code.variant_id) || 0) + 1)
        }
      }
      offset += PAGE_SIZE

      if (data.length < PAGE_SIZE) {
        hasMore = false
      }
    }
  }

  const totalUnits = Array.from(variantCounts.values()).reduce((a, b) => a + b, 0)
  console.log(`📊 Fallback: Found ${totalUnits} received codes across ${variantCounts.size} variants`)

  return variantCounts
}

/**
 * Record inventory movements after processing (FULL receive only).
 *
 * Posts the order additions per variant plus the warranty-bonus movement for the
 * buffer codes that were already transitioned by markWarrantyBufferReceived()
 * (passed in via bufferMarked). This function no longer touches QR statuses —
 * buffer eligibility is handled separately so both full and partial modes share
 * the same QR transition logic.
 */
async function recordInventoryMovements(
  supabase: any, batchId: string, warehouseOrgId: string, manufacturerOrgId: string,
  companyId: string, orderId: string, orderNo: string, receivedBy: string,
  variantCounts: Map<string, number>, variantPriceMap: Map<string, number>,
  bufferMarked: Map<string, number>
) {
  for (const [variantId, quantity] of Array.from(variantCounts.entries())) {
    const unitCost = variantPriceMap.get(variantId) || 0
    const { data: ordConfig } = await supabase.from('inventory_stock_configurations')
      .select('id')
      .eq('variant_id', variantId)
      .eq('default_for_ord', true)
      .eq('allow_ord', true)
      .eq('status', 'active')
      .maybeSingle()
    const resolvedConfig = ordConfig || (await supabase.from('inventory_stock_configurations')
      .select('id')
      .eq('variant_id', variantId)
      .eq('is_variant_default', true)
      .single()).data
    if (!resolvedConfig?.id) throw new Error(`No ORD stock configuration for variant ${variantId}`)

    const { error: movementError } = await supabase.rpc('record_stock_movement', {
        p_movement_type: 'addition',
        p_variant_id: variantId,
        p_organization_id: warehouseOrgId,
        p_quantity_change: quantity,
        p_unit_cost: unitCost,
        p_manufacturer_id: manufacturerOrgId,
        p_warehouse_location: null,
        p_reason: 'warehouse_receive',
        p_notes: `Batch receive ${batchId}`,
        p_reference_type: 'order',
        p_reference_id: orderId,
        p_reference_no: orderNo,
        p_company_id: companyId,
        p_created_by: receivedBy,
        p_stock_config_id: resolvedConfig.id,
      })
    if (movementError) throw new Error(`Inventory posting failed for variant ${variantId}: ${movementError.message}`)

    // Warranty-bonus inventory for the buffer codes already marked eligible.
    const bonusQuantity = bufferMarked.get(variantId) || 0
    if (bonusQuantity > 0) {
      const { error: warrantyError } = await supabase.rpc('record_stock_movement', {
          p_movement_type: 'warranty_bonus',
          p_variant_id: variantId,
          p_organization_id: warehouseOrgId,
          p_quantity_change: bonusQuantity,
          p_unit_cost: 0,
          p_manufacturer_id: manufacturerOrgId,
          p_warehouse_location: null,
          p_reason: 'manufacturer_warranty',
          p_notes: `Warranty bonus for ${orderNo}`,
          p_reference_type: 'order',
          p_reference_id: orderId,
          p_reference_no: orderNo,
          p_company_id: companyId,
          p_created_by: receivedBy,
          p_stock_config_id: resolvedConfig.id,
        })
      if (warrantyError) throw new Error(`Warranty inventory posting failed for variant ${variantId}: ${warrantyError.message}`)
    }
  }
}
