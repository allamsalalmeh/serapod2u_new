import { NextRequest, NextResponse } from 'next/server'
import { requireMarketingUser } from '@/app/api/event-management/_lib'
import { createEvent, listEvents, EVENT_STATUSES } from '@/modules/event-management/lib/events'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const auth = await requireMarketingUser()
  if (!auth.ok) return auth.response

  try {
    const events = await listEvents(auth.orgId)
    return NextResponse.json({ success: true, data: events })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'Failed to list events.' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireMarketingUser()
  if (!auth.ok) return auth.response

  try {
    const body = await request.json().catch(() => ({}))
    const name = String(body?.name ?? '').trim()
    const startsAt = String(body?.starts_at ?? '').trim()
    const endsAt = String(body?.ends_at ?? '').trim()
    const status = String(body?.status ?? 'draft').trim()
    const brandId = body?.brand_id ? String(body.brand_id) : null

    if (!name || !startsAt || !endsAt) {
      return NextResponse.json({ success: false, error: 'Name, start date and end date are required.' }, { status: 400 })
    }
    if (endsAt < startsAt) {
      return NextResponse.json({ success: false, error: 'End date must be on or after start date.' }, { status: 400 })
    }
    if (!EVENT_STATUSES.includes(status as any)) {
      return NextResponse.json({ success: false, error: 'Invalid event status.' }, { status: 400 })
    }

    const event = await createEvent(auth.orgId, auth.userId, {
      name,
      starts_at: startsAt,
      ends_at: endsAt,
      status: status as any,
      brand_id: brandId,
      timezone: String(body?.timezone ?? 'Asia/Kuala_Lumpur'),
      registration_opens_at: body?.registration_opens_at ? String(body.registration_opens_at) : null,
      registration_closes_at: body?.registration_closes_at ? String(body.registration_closes_at) : null,
      form_config: body?.form_config ?? undefined,
    })

    return NextResponse.json({ success: true, data: event }, { status: 201 })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'Failed to create event.' }, { status: 500 })
  }
}
