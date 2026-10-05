import { guardUserOperation } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { canAccessBatchForOrder } from '@/lib/qr-batch-access'

const BUCKET_NAME = 'qr-codes'

const extractStoragePath = (publicUrl: string): string | null => {
  if (!publicUrl) return null
  try {
    const parsed = new URL(publicUrl)
    const parts = parsed.pathname.split(`/object/public/${BUCKET_NAME}/`)
    if (parts.length < 2) {
      return null
    }
    return decodeURIComponent(parts[1])
  } catch (error) {
    console.error('Failed to parse storage path from URL:', publicUrl, error)
    return null
  }
}

export async function POST(request: NextRequest) {
  try {
    const { batch_id: batchId } = await request.json()

    if (!batchId) {
      return NextResponse.json({ error: 'batch_id is required' }, { status: 400 })
    }

    const supabase = await createClient()
    const {
      data: { user },
      error: authError
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const saDenied = await guardUserOperation(user.id, 'qr.batch.manage')
    if (saDenied) return saDenied

    // The signed URL is created with the service role below, so ownership is
    // decided here from trusted rows: a partner (manufacturer) only reaches
    // batches of the orders placed with it.
    const adminForScope = createAdminClient() as any
    const { data: actorRow } = await adminForScope.from('users').select('organization_id, organizations:organization_id(org_type_code)').eq('id', user.id).maybeSingle()
    const actorOrgType = String(actorRow?.organizations?.org_type_code || '').toUpperCase()
    const actorOrgId = String(actorRow?.organization_id || '')
    const { data: scoped } = await adminForScope.from('qr_batches')
      .select('id, order:orders!qr_batches_order_id_fkey(seller_org_id, buyer_org_id, company_id)').eq('id', batchId).maybeSingle()
    if (!scoped || !canAccessBatchForOrder(actorOrgType, actorOrgId, scoped.order)) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 })
    }

    const { data: batch, error: batchError } = await supabase
      .from('qr_batches')
      .select('id, order_id, excel_file_url')
      .eq('id', batchId)
      .maybeSingle()

    if (batchError) {
      console.error('Failed to load batch for download:', batchError)
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 })
    }

    if (!batch || !batch.excel_file_url) {
      return NextResponse.json({ error: 'Excel file not available for this batch' }, { status: 404 })
    }

    let orderNo: string | null = null
    if (batch.order_id) {
      const { data: orderRecord } = await supabase
        .from('orders')
        .select('order_no')
        .eq('id', batch.order_id)
        .maybeSingle()

      orderNo = orderRecord?.order_no ?? null
    }

    const storagePath = extractStoragePath(batch.excel_file_url)

    if (!storagePath) {
      return NextResponse.json({ error: 'Invalid storage path for Excel file' }, { status: 500 })
    }

  const downloadName = `QR_Batch_${orderNo || batch.id}.xlsx`

    // Use admin client for storage operations — the qr-codes bucket has no
    // RLS policies for authenticated users, so the session client cannot
    // create signed URLs. Service-role bypasses storage RLS.
    const adminSupabase = createAdminClient()

    const { data: signedUrlData, error: signedUrlError } = await adminSupabase.storage
      .from(BUCKET_NAME)
      .createSignedUrl(storagePath, 3600, {
        download: downloadName
      })

    if (signedUrlError || !signedUrlData?.signedUrl) {
      console.error('Failed to create signed URL:', signedUrlError)
      return NextResponse.json({ error: 'Unable to create download link' }, { status: 500 })
    }

    // Self-hosted Supabase uses Kong as API gateway which requires an apikey
    // query param on direct browser requests. Append the public anon key.
    let finalUrl = signedUrlData.signedUrl
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (anonKey) {
      const sep = finalUrl.includes('?') ? '&' : '?'
      finalUrl = `${finalUrl}${sep}apikey=${anonKey}`
    }

    // Return with proper CORS and download headers for Vercel
    return NextResponse.json(
      { success: true, url: finalUrl, filename: downloadName },
      { 
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        }
      }
    )
  } catch (error: any) {
    console.error('QR batch download API error:', error)
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
  }
}
