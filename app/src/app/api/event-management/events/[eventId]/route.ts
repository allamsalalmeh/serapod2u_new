import { NextRequest, NextResponse } from 'next/server'
import { requireMarketingUser } from '@/app/api/event-management/_lib'
import { getEvent, updateEvent, EVENT_STATUSES } from '@/modules/event-management/lib/events'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const auth = await requireMarketingUser()
  if (!auth.ok) return auth.response
  const { eventId } = await params

  try {
    const event = await getEvent(auth.orgId, eventId)
    if (!event) return NextResponse.json({ success: false, error: 'Event not found.' }, { status: 404 })
    return NextResponse.json({ success: true, data: event })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'Failed to load event.' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const auth = await requireMarketingUser()
  if (!auth.ok) return auth.response
  const { eventId } = await params

  try {
    const body = await request.json().catch(() => ({}))
    const patch: Record<string, any> = {}

    if (body.name !== undefined) patch.name = String(body.name).trim()
    if (body.brand_id !== undefined) patch.brand_id = body.brand_id
    if (body.status !== undefined) {
      if (!EVENT_STATUSES.includes(body.status)) {
        return NextResponse.json({ success: false, error: 'Invalid event status.' }, { status: 400 })
      }
      patch.status = body.status
    }
    if (body.starts_at !== undefined) patch.starts_at = String(body.starts_at)
    if (body.ends_at !== undefined) patch.ends_at = String(body.ends_at)
    if (body.timezone !== undefined) patch.timezone = String(body.timezone)
    if (body.registration_opens_at !== undefined) patch.registration_opens_at = body.registration_opens_at
    if (body.registration_closes_at !== undefined) patch.registration_closes_at = body.registration_closes_at
    if (body.form_config !== undefined) patch.form_config = body.form_config

    if (patch.ends_at && patch.starts_at && patch.ends_at < patch.starts_at) {
      return NextResponse.json({ success: false, error: 'End date must be on or after start date.' }, { status: 400 })
    }

    const event = await updateEvent(auth.orgId, eventId, patch)
    if (!event) return NextResponse.json({ success: false, error: 'Event not found.' }, { status: 404 })
    return NextResponse.json({ success: true, data: event })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'Failed to update event.' }, { status: 500 })
  }
}
