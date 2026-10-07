import { NextRequest, NextResponse } from 'next/server'
import { requireMarketingUser } from '@/app/api/event-management/_lib'
import { getEventStats } from '@/modules/event-management/lib/registrations'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const auth = await requireMarketingUser()
  if (!auth.ok) return auth.response
  const { eventId } = await params

  try {
    const stats = await getEventStats(auth.orgId, eventId)
    if (!stats) return NextResponse.json({ success: false, error: 'Event not found.' }, { status: 404 })
    return NextResponse.json({ success: true, data: stats })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'Failed to load stats.' }, { status: 500 })
  }
}
