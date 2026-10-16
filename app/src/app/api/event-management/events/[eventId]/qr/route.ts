import { NextRequest, NextResponse } from 'next/server'
import { requireMarketingUser } from '@/app/api/event-management/_lib'
import { listQrTokens, createQrToken, revokeQrToken } from '@/modules/event-management/lib/staff-qr'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const auth = await requireMarketingUser()
  if (!auth.ok) return auth.response
  const { eventId } = await params

  try {
    const tokens = await listQrTokens(auth.orgId, eventId)
    return NextResponse.json({ success: true, data: tokens })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'Failed to list QR codes.' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const auth = await requireMarketingUser()
  if (!auth.ok) return auth.response
  const { eventId } = await params

  try {
    const body = await request.json().catch(() => ({}))
    const kind = body?.kind === 'staff' ? 'staff' : 'booth'
    const staffUserId = body?.staff_user_id ? String(body.staff_user_id) : null

    const token = await createQrToken(auth.orgId, eventId, kind, staffUserId, auth.userId)
    return NextResponse.json({ success: true, data: token }, { status: 201 })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'Failed to create QR code.' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const auth = await requireMarketingUser()
  if (!auth.ok) return auth.response
  const { eventId } = await params

  try {
    const tokenId = request.nextUrl.searchParams.get('token_id') ?? ''
    if (!tokenId) return NextResponse.json({ success: false, error: 'A token is required.' }, { status: 400 })

    const revoked = await revokeQrToken(auth.orgId, eventId, tokenId)
    if (!revoked) return NextResponse.json({ success: false, error: 'Token not found.' }, { status: 404 })
    return NextResponse.json({ success: true })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'Failed to revoke QR code.' }, { status: 500 })
  }
}
