import { guardUserOperation } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { WORKER_NAMES, withWorkerLease } from '@/lib/cron/lease'
import { resolveTrackingBaseUrl } from '@/lib/excel-generator'
import { runQRBatchGeneration } from '@/lib/qr-batch-generation'
import { PROCESSING_ORG_TYPES, canProcessBatchForOrder } from '@/lib/qr-batch-access'

/**
 * POST /api/qr-batches/process  { batch_id }
 *
 * User-triggered processing of ONE QR batch - the dashboard's fast path and
 * debug fallback. The scheduled cron (/api/cron/qr-generation-worker) remains
 * the normal operating path.
 *
 * Unlike the cron route this never touches the global queue: the caller must
 * be an active HQ/MFG user whose organization owns the batch's order, and only
 * that batch is processed. Batches outside the caller's organization respond
 * 404 so their existence is not revealed.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(request: NextRequest) {
  let batchId: unknown
  try {
    ;({ batch_id: batchId } = await request.json())
  } catch {
    batchId = undefined
  }
  if (typeof batchId !== 'string' || batchId.trim() === '') {
    return NextResponse.json({ error: 'batch_id is required' }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
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
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // qr_batches RLS is open to every authenticated user, so ownership is
  // checked here against the order rather than trusted from RLS.
  const admin = createAdminClient()
  const { data: batch, error: batchError } = await (admin as any)
    .from('qr_batches')
    .select('id, status, order:orders!qr_batches_order_id_fkey(seller_org_id, buyer_org_id, company_id)')
    .eq('id', batchId)
    .maybeSingle()

  if (batchError) {
    console.error('[qr-batches/process] batch lookup failed:', batchError.message)
    return NextResponse.json({ error: 'Failed to load batch', details: batchError.message }, { status: 500 })
  }
  if (!batch || !canProcessBatchForOrder(orgType, orgId, batch.order)) {
    return NextResponse.json({ error: 'Batch not found' }, { status: 404 })
  }

  if (!['queued', 'processing'].includes(batch.status)) {
    return NextResponse.json({ success: true, message: `Batch is already ${batch.status}`, status: batch.status, hasMore: false })
  }

  const outcome = await withWorkerLease(admin, WORKER_NAMES.qrGeneration, () =>
    runQRBatchGeneration(admin, { batchId: batch.id, notificationBaseUrl: resolveTrackingBaseUrl() })
  )
  if (outcome.status === 'blocked') {
    // The remote-DB guard refused to run a worker in THIS process. The batch itself is untouched and still
    // queued for the deployed worker: say so explicitly (with the batch state the server just read) so the
    // UI can show "waiting" instead of a failure. The guard stays on; no override is applied here.
    const body = await outcome.response.json().catch(() => ({}))
    return NextResponse.json({ ...body, batch_id: batch.id, batch_status: batch.status }, { status: outcome.response.status })
  }
  return outcome.status === 'ran' ? outcome.result : outcome.response
}
