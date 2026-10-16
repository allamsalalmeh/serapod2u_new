import { guardUserOperation } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { PROCESSING_ORG_TYPES, canProcessBatchForOrder } from '@/lib/qr-batch-access'

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

    // Supply partners may read but not write QR tables under RLS, so the batch
    // is read and marked printed with the service role once ownership is shown.
    const adminSupabase = createAdminClient() as any

    const { data: batch, error: batchError } = await adminSupabase
      .from('qr_batches')
      .select('id, status, excel_file_url, order:orders!qr_batches_order_id_fkey(order_no, seller_org_id, buyer_org_id, company_id)')
      .eq('id', batchId)
      .maybeSingle()

    if (batchError) {
      console.error('Failed to load batch for download:', batchError)
      return NextResponse.json({ error: 'Failed to load batch', details: batchError.message }, { status: 500 })
    }

    if (!batch || !canProcessBatchForOrder(orgType, orgId, batch.order)) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 })
    }

    if (!batch.excel_file_url) {
      return NextResponse.json({ error: 'Excel file not available for this batch' }, { status: 404 })
    }

    const orderNo: string | null = batch.order?.order_no ?? null

    const storagePath = extractStoragePath(batch.excel_file_url)

    if (!storagePath) {
      return NextResponse.json({ error: 'Invalid storage path for Excel file' }, { status: 500 })
    }

    const downloadName = `QR_Batch_${orderNo || batch.id}.xlsx`

    // Storage also uses the admin client — the qr-codes bucket has no RLS
    // policies for authenticated users, so the session client cannot create
    // signed URLs.
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

    // The first download moves the batch to 'printing' and its codes to
    // 'printed'. A failure here must not block the download itself.
    let markedPrinted = false
    if (batch.status === 'generated') {
      const { data: printed, error: printedError } = await adminSupabase.rpc('mark_batch_as_printed', {
        p_batch_id: batch.id
      })
      if (printedError || printed?.success === false) {
        console.error('Failed to mark QR batch as printed:', printedError?.message || printed?.error)
      } else {
        markedPrinted = true
      }
    }

    // Return with proper CORS and download headers for Vercel
    return NextResponse.json(
      { success: true, url: finalUrl, filename: downloadName, marked_printed: markedPrinted },
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
