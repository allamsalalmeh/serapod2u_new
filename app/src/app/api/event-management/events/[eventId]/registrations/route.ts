import { NextRequest, NextResponse } from 'next/server'
import { requireMarketingUser } from '@/app/api/event-management/_lib'
import { listRegistrations } from '@/modules/event-management/lib/registrations'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const auth = await requireMarketingUser()
  if (!auth.ok) return auth.response
  const { eventId } = await params

  try {
    const q = request.nextUrl.searchParams.get('q')?.trim() || undefined
    const registrations = await listRegistrations(auth.orgId, eventId, q)
    return NextResponse.json({ success: true, data: registrations })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'Failed to list registrations.' }, { status: 500 })
  }
}
