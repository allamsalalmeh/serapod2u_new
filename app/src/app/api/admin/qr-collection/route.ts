import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadQrCollectionInfo, requireQrCollectionViewer } from '@/lib/consumer/qr-collection-info'

export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/qr-collection?code=xxx
 * Who collected points for a scanned QR code. HQ staff only.
 */
export async function GET(request: NextRequest) {
  const viewer = await requireQrCollectionViewer()
  if (viewer.status !== 200) {
    return NextResponse.json({ error: viewer.status === 401 ? 'Unauthorized' : 'Forbidden' }, { status: viewer.status })
  }

  const code = request.nextUrl.searchParams.get('code')?.trim()
  if (!code || code.length > 200) {
    return NextResponse.json({ error: 'code is required' }, { status: 400 })
  }

  try {
    const info = await loadQrCollectionInfo(createAdminClient() as any, code)
    if (!info) return NextResponse.json({ error: 'QR code not found' }, { status: 404 })
    return NextResponse.json({ success: true, ...info }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('[qr-collection] lookup failed:', error)
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 })
  }
}
