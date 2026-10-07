import { NextRequest, NextResponse } from 'next/server'
import { requireMarketingUser } from '@/app/api/event-management/_lib'
import { listStaff, assignStaff, removeStaff } from '@/modules/event-management/lib/staff-qr'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const auth = await requireMarketingUser()
  if (!auth.ok) return auth.response
  const { eventId } = await params

  try {
    const staff = await listStaff(auth.orgId, eventId)
    return NextResponse.json({ success: true, data: staff })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'Failed to list staff.' }, { status: 500 })
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
    const userId = String(body?.user_id ?? '').trim()
    if (!userId) return NextResponse.json({ success: false, error: 'A staff member is required.' }, { status: 400 })

    const staff = await assignStaff(auth.orgId, eventId, userId)
    if (!staff) return NextResponse.json({ success: false, error: 'Staff could not be assigned (must belong to this organization).' }, { status: 400 })
    return NextResponse.json({ success: true, data: staff }, { status: 201 })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'Failed to assign staff.' }, { status: 500 })
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
    const userId = request.nextUrl.searchParams.get('user_id') ?? ''
    if (!userId) return NextResponse.json({ success: false, error: 'A staff member is required.' }, { status: 400 })

    const removed = await removeStaff(auth.orgId, eventId, userId)
    if (!removed) return NextResponse.json({ success: false, error: 'Staff not found.' }, { status: 404 })
    return NextResponse.json({ success: true })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'Failed to remove staff.' }, { status: 500 })
  }
}
