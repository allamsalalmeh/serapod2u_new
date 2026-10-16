import { guardUserOperation } from '@/lib/security-access/operation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { canAccessBatchForOrder } from '@/lib/qr-batch-access'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/qr/batches/[batchId]/progress
 * 
 * ⭐ FULLY DATABASE-DRIVEN PROGRESS ENDPOINT ⭐
 * 
 * Returns PURE database-driven progress for a QR batch.
 * 
 * KEY FEATURES:
 * - ✅ NO session state - all data from DB queries
 * - ✅ Survives logout/login and browser refresh
 * - ✅ Works across multiple devices simultaneously
 * - ✅ Real-time accurate - reflects actual DB state
 * - ✅ Optimized with database indexes for fast performance
 * 
 * PERFORMANCE OPTIMIZATION (Nov 2025):
 * Uses these indexes for fast counting:
 * - idx_qr_master_codes_batch_status on qr_master_codes(batch_id, status)
 * - idx_qr_codes_batch_status_buffer on qr_codes(batch_id, status, is_buffer)
 * - idx_qr_codes_batch_case_buffer_seq on qr_codes(batch_id, case_number, is_buffer, sequence_number)
 * 
 * This endpoint aggregates data from:
 * - qr_batches (batch metadata)
 * - qr_master_codes (master cases with status and counts)
 * - qr_codes (individual QR codes with status and linkage)
 * 
 * STATELESS DESIGN:
 * Every API call recalculates ALL metrics from scratch by counting
 * database rows. No cached values. No temporary state. No session dependencies.
 * 
 * USAGE:
 * Frontend should:
 * 1. Call this endpoint on page mount
 * 2. Poll this endpoint every 3-5 seconds while active
 * 3. Call after any mutation (mark-case-perfect, mark-all-perfect, etc.)
 * 4. NEVER maintain local progress counters - always fetch from this endpoint
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> }
) {
  try {
    const supabase = await createClient()
    const { data: { user: saUser } } = await supabase.auth.getUser()
    if (!saUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const saDenied = await guardUserOperation(saUser.id, 'qr.batch.manage')
    if (saDenied) return saDenied
    const { batchId } = await params

    if (!batchId) {
      return NextResponse.json(
        { error: 'Batch ID is required' },
        { status: 400 }
      )
    }

    // A partner (manufacturer) only sees batches of the orders placed with it;
    // qr_batches.company_id is the HQ, so ownership comes from the order.
    {
      const admin = createAdminClient() as any
      const { data: actorRow } = await admin.from('users').select('organization_id, organizations:organization_id(org_type_code)').eq('id', saUser.id).maybeSingle()
      const { data: scoped } = await admin.from('qr_batches')
        .select('id, order:orders!qr_batches_order_id_fkey(seller_org_id, buyer_org_id, company_id)').eq('id', batchId).maybeSingle()
      if (!scoped || !canAccessBatchForOrder(String(actorRow?.organizations?.org_type_code || '').toUpperCase(), String(actorRow?.organization_id || ''), scoped.order)) {
        return NextResponse.json({ error: 'Batch not found' }, { status: 404 })
      }
    }

    // ====================================================================
    // GET BATCH AND ORDER METADATA
    // ====================================================================

    const { data: batch, error: batchError } = await supabase
      .from('qr_batches')
      .select(`
        id,
        order_id,
        status,
        created_at,
        total_master_codes,
        total_unique_codes,
        buffer_percent,
        orders (
          id,
          order_no,
          display_doc_no,
          status,
          organizations!orders_buyer_org_id_fkey (
            org_name
          )
        )
      `)
      .eq('id', batchId)
      .single()

    if (batchError || !batch) {
      console.error('❌ Batch not found:', batchError)
      return NextResponse.json(
        { error: 'Batch not found' },
        { status: 404 }
      )
    }

    // ====================================================================
    // MASTER CASES AGGREGATION - PURE DB COUNTS
    // Uses idx_qr_master_codes_batch_status index for fast counting
    // ====================================================================

    // Total master cases in this batch
    // Index used: idx_qr_master_codes_batch_status (batch_id column)
    const { count: totalMasterCases, error: totalMasterError } = await supabase
      .from('qr_master_codes')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', batchId)

    if (totalMasterError) {
      console.error('❌ Error counting total master cases:', totalMasterError)
      return NextResponse.json(
        { error: 'Failed to fetch master cases count' },
        { status: 500 }
      )
    }

    // Packed master cases (status = 'packed')
    // Index used: idx_qr_master_codes_batch_status (batch_id, status)
    const { count: packedMasterCases, error: packedMasterError } = await supabase
      .from('qr_master_codes')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', batchId)
      .eq('status', 'packed')

    if (packedMasterError) {
      console.error('❌ Error counting packed master cases:', packedMasterError)
      return NextResponse.json(
        { error: 'Failed to fetch packed master cases count' },
        { status: 500 }
      )
    }

    // Get master codes detail for case-by-case tracking (optional extended data)
    // Index used: idx_qr_master_codes_batch_status for efficient filtering
    const { data: masterCodesData, error: masterDataError } = await supabase
      .from('qr_master_codes')
      .select('id, case_number, expected_unit_count, actual_unit_count, status')
      .eq('batch_id', batchId)
      .order('case_number', { ascending: true })

    if (masterDataError) {
      console.error('❌ Error fetching master codes:', masterDataError)
      return NextResponse.json(
        { error: 'Failed to fetch master codes' },
        { status: 500 }
      )
    }

    // Count linked QR codes per master case (for cases without actual_unit_count)
    // Index used: idx_qr_codes_batch_status_buffer for efficient filtering
    const { data: linkedQRCodes, error: linkedError } = await supabase
      .from('qr_codes')
      .select('master_code_id, status')
      .eq('batch_id', batchId)
      .in('status', ['packed', 'buffer_used', 'ready_to_ship', 'received_warehouse', 'shipped_distributor', 'opened'])
      .not('master_code_id', 'is', null)
      .limit(100000)

    if (linkedError) {
      console.error('❌ Error counting linked codes:', linkedError)
    }

    // Build map of master_code_id -> count of linked codes
    const masterLinkedCounts = new Map<string, number>()
      ; (linkedQRCodes || []).forEach((qr) => {
        const masterId = qr.master_code_id as string
        masterLinkedCounts.set(masterId, (masterLinkedCounts.get(masterId) || 0) + 1)
      })

    // Calculate case-by-case details
    const caseDetails = (masterCodesData || []).map((mc) => {
      const expected = Number(mc.expected_unit_count || 0)

      // Prioritize actual_unit_count (set by mark-case-perfect and Mode C worker)
      // Fall back to counting linked QR codes if actual_unit_count not set
      const actualCount = Number(mc.actual_unit_count || 0)
      const linkedCount = actualCount > 0 ? actualCount : (masterLinkedCounts.get(mc.id) || 0)

      // A case is packed if it has reached expected count OR status is 'packed'
      const isPacked = (expected > 0 && linkedCount >= expected) || mc.status === 'packed'

      return {
        case_number: mc.case_number,
        expected_units: expected,
        actual_units: linkedCount,
        status: mc.status,
        is_packed: isPacked,
        percentage: expected > 0 ? Math.round((linkedCount / expected) * 100) : 0
      }
    })

    // Group cases by completion status for quick UI display
    const packedCases = caseDetails.filter(c => c.is_packed).map(c => c.case_number)
    const partialCases = caseDetails.filter(c => !c.is_packed && c.actual_units > 0).map(c => c.case_number)
    const emptyCases = caseDetails.filter(c => c.actual_units === 0).map(c => c.case_number)

    // Calculate packed cases count from DB-driven master case status
    // (This uses the count from the earlier query, not derived from case details)
    const packedCasesCount = packedMasterCases ?? 0

    // ====================================================================
    // UNIQUE CODES AGGREGATION (non-buffer) - PURE DB COUNTS
    // Uses idx_qr_codes_batch_status_buffer index for fast counting
    // ====================================================================

    // Calculate planned vs total (accounting for buffer)
    const totalUniqueWithBuffer = batch.total_unique_codes || 0
    const bufferPercent = Number(batch.buffer_percent ?? 0)
    const plannedUniqueCodes = bufferPercent > 0
      ? Math.round(totalUniqueWithBuffer / (1 + bufferPercent / 100))
      : totalUniqueWithBuffer

    // Total unique codes (is_buffer = false)
    // Index used: idx_qr_codes_batch_status_buffer (batch_id, status, is_buffer)
    const { count: totalUniqueCodes, error: totalUniqueError } = await supabase
      .from('qr_codes')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', batchId)
      .eq('is_buffer', false)

    if (totalUniqueError) {
      console.error('❌ Error counting total unique codes:', totalUniqueError)
      return NextResponse.json(
        { error: 'Failed to fetch unique codes count' },
        { status: 500 }
      )
    }

    // Packed unique codes (includes all packed statuses)
    // Index used: idx_qr_codes_batch_status_buffer (batch_id, status, is_buffer)
    // NOTE: Must include all statuses beyond 'packed' to count codes that have moved to warehouse/distributor
    const { count: packedUniqueCodes, error: packedUniqueError } = await supabase
      .from('qr_codes')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', batchId)
      .in('status', ['packed', 'buffer_used', 'ready_to_ship', 'received_warehouse', 'shipped_distributor', 'opened'])
      .eq('is_buffer', false)

    if (packedUniqueError) {
      console.error('❌ Error counting packed unique codes:', packedUniqueError)
      return NextResponse.json(
        { error: 'Failed to fetch packed unique codes count' },
        { status: 500 }
      )
    }

    // Cap displayed packed count at planned (excess goes to buffer)
    const packedUniquesForProgress = Math.min(packedUniqueCodes || 0, plannedUniqueCodes)

    // ====================================================================
    // BUFFER CODES AGGREGATION - PURE DB COUNTS
    // Uses idx_qr_codes_batch_status_buffer index for fast counting
    // ====================================================================

    // Total buffer codes (is_buffer = true)
    // Index used: idx_qr_codes_batch_status_buffer (batch_id, status, is_buffer)
    const { count: totalBufferCodes, error: totalBufferError } = await supabase
      .from('qr_codes')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', batchId)
      .eq('is_buffer', true)

    if (totalBufferError) {
      console.error('❌ Error counting total buffer codes:', totalBufferError)
      return NextResponse.json(
        { error: 'Failed to fetch buffer codes count' },
        { status: 500 }
      )
    }

    // Used buffer codes (is_buffer = true AND status = 'packed' or 'buffer_used')
    // Index used: idx_qr_codes_batch_status_buffer (batch_id, status, is_buffer)
    const { count: usedBufferCodesMarked, error: usedBufferError1 } = await supabase
      .from('qr_codes')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', batchId)
      .eq('status', 'buffer_used')
      .eq('is_buffer', true)

    const { count: usedBufferCodesPacked, error: usedBufferError2 } = await supabase
      .from('qr_codes')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', batchId)
      .eq('status', 'packed')
      .eq('is_buffer', true)

    if (usedBufferError1 || usedBufferError2) {
      console.error('❌ Error counting used buffer codes:', usedBufferError1 || usedBufferError2)
      return NextResponse.json(
        { error: 'Failed to fetch used buffer codes count' },
        { status: 500 }
      )
    }

    const usedBufferCodes = (usedBufferCodesMarked || 0) + (usedBufferCodesPacked || 0)

    // Calculate available buffers
    const availableBufferCodes = Math.max((totalBufferCodes || 0) - usedBufferCodes, 0)

    // ====================================================================
    // WAREHOUSE STATUS - PURE DB COUNTS
    // Uses idx_qr_master_codes_batch_status index for fast counting
    // ====================================================================

    // Count cases that have been received at warehouse or beyond
    // Index used: idx_qr_master_codes_batch_status (batch_id, status)
    const { count: warehouseReceivedCases, error: warehouseError } = await supabase
      .from('qr_master_codes')
      .select('*', { count: 'exact', head: true })
      .eq('batch_id', batchId)
      .in('status', ['received_warehouse', 'shipped_distributor', 'opened'])

    if (warehouseError) {
      console.error('❌ Error counting warehouse received cases:', warehouseError)
    }

    // ====================================================================
    // CALCULATE PROGRESS PERCENTAGES
    // ====================================================================

    const masterProgress = totalMasterCases ? (packedCasesCount / totalMasterCases * 100) : 0
    const uniqueProgress = plannedUniqueCodes ? (packedUniquesForProgress / plannedUniqueCodes * 100) : 0
    const overallProgress = (masterProgress + uniqueProgress) / 2

    // ====================================================================
    // LATEST ACTIVITY - PURE DB QUERY
    // ====================================================================

    const { data: latestScans } = await supabase
      .from('qr_codes')
      .select('last_scanned_at, last_scanned_by')
      .eq('batch_id', batchId)
      .not('last_scanned_at', 'is', null)
      .order('last_scanned_at', { ascending: false })
      .limit(5)

    // ====================================================================
    // BUILD RESPONSE - ALL DATA FROM DB QUERIES
    // ====================================================================

    const orderData = Array.isArray(batch.orders) ? batch.orders[0] : batch.orders
    const orgData = orderData ? (Array.isArray(orderData.organizations) ? orderData.organizations[0] : orderData.organizations) : null
    const batchCode = orderData?.order_no ? `BATCH-${orderData.order_no}` : `BATCH-${batch.id.substring(0, 8).toUpperCase()}`

    console.log(`📊 [DB-DRIVEN + INDEXED] Progress for batch ${batchId}:`, {
      master_cases: `${packedCasesCount} / ${totalMasterCases ?? 0}`,
      unique_codes: `${packedUniquesForProgress} / ${plannedUniqueCodes}`,
      buffer_codes: `${usedBufferCodes} / ${totalBufferCodes ?? 0}`,
      source: 'PURE_DATABASE_AGGREGATION',
      indexes_used: [
        'idx_qr_master_codes_batch_status',
        'idx_qr_codes_batch_status_buffer'
      ]
    })

    return NextResponse.json({
      // Batch metadata
      batch_id: batch.id,
      batch_code: batchCode,
      batch_status: batch.status,
      order_id: batch.order_id,
      order_no: orderData?.order_no || '',
      display_doc_no: orderData?.display_doc_no || '',
      buyer_org_name: orgData?.org_name || 'Unknown',
      created_at: batch.created_at,

      // Master cases progress
      total_master_codes: totalMasterCases ?? 0,
      packed_master_codes: packedCasesCount,
      master_progress_percentage: Math.round(masterProgress),

      // Unique codes progress
      total_unique_codes: plannedUniqueCodes,
      planned_unique_codes: plannedUniqueCodes,
      packed_unique_codes: packedUniquesForProgress,
      actual_packed_unique_codes: packedUniqueCodes ?? 0,
      total_unique_with_buffer: totalUniqueWithBuffer,
      unique_progress_percentage: Math.round(uniqueProgress),

      // Buffer codes
      total_buffer_codes: totalBufferCodes ?? 0,
      used_buffer_codes: usedBufferCodes,
      available_buffer_codes: availableBufferCodes,

      // Overall progress
      overall_progress_percentage: Math.round(overallProgress),
      is_complete: (packedMasterCases === totalMasterCases) && (packedUniquesForProgress === plannedUniqueCodes),

      // Warehouse status
      warehouse_started: (warehouseReceivedCases || 0) > 0,
      warehouse_received_cases: warehouseReceivedCases || 0,

      // Case-by-case breakdown
      case_details: caseDetails,
      packed_case_numbers: packedCases,
      partial_case_numbers: partialCases,
      empty_case_numbers: emptyCases,

      // Latest activity
      latest_scans: latestScans || []
    })

  } catch (error: any) {
    console.error('❌ Progress fetch error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch batch progress' },
      { status: 500 }
    )
  }
}
