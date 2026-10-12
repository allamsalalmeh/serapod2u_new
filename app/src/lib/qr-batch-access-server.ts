import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { PROCESSING_ORG_TYPES, canProcessBatchForOrder } from '@/lib/qr-batch-access'

type ProcessableBatch =
  | { admin: any; batch: any; response?: undefined }
  | { response: NextResponse; admin?: undefined; batch?: undefined }

/**
 * Loads a batch for a dashboard user who may process it: the manufacturer that sells
 * the order, or the HQ that owns it. Supply partners can read but not write QR tables
 * under RLS (and the warehouse propagation RPC requires a staff actor), so the caller
 * does its writes with the returned service-role client once ownership is shown here.
 */
export async function loadProcessableBatch(supabase: any, userId: string, batchId: string, columns: string): Promise<ProcessableBatch> {
  const { data: profile, error: profileError } = await supabase
    .from('users')
    .select('is_active, organization_id, organizations:organization_id(org_type_code)')
    .eq('id', userId)
    .single()

  const orgType = String(profile?.organizations?.org_type_code || '').toUpperCase()
  const orgId = String(profile?.organization_id || '')
  if (profileError || !profile || profile.is_active === false || !orgId || !PROCESSING_ORG_TYPES.includes(orgType)) {
    return { response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }

  const admin = createAdminClient() as any
  const { data: batch, error: batchError } = await admin
    .from('qr_batches')
    .select(`${columns}, order:orders!qr_batches_order_id_fkey(id, order_no, seller_org_id, buyer_org_id, company_id, warehouse_org_id)`)
    .eq('id', batchId)
    .maybeSingle()

  if (batchError) {
    return { response: NextResponse.json({ error: 'Failed to load batch', details: batchError.message }, { status: 500 }) }
  }
  if (!batch || !canProcessBatchForOrder(orgType, orgId, batch.order)) {
    return { response: NextResponse.json({ error: 'Batch not found' }, { status: 404 }) }
  }
  return { admin, batch }
}
