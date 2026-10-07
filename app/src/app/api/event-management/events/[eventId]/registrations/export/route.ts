import { NextRequest, NextResponse } from 'next/server'
import { requireMarketingUser } from '@/app/api/event-management/_lib'
import { listRegistrations } from '@/modules/event-management/lib/registrations'
import { buildRegistrationsCsv, buildRegistrationsExcel } from '@/modules/event-management/lib/export'
import { getEvent } from '@/modules/event-management/lib/events'

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const auth = await requireMarketingUser()
  if (!auth.ok) return auth.response
  const { eventId } = await params

  try {
    // Ownership check: the export must only contain the caller's org rows.
    const event = await getEvent(auth.orgId, eventId)
    if (!event) return NextResponse.json({ success: false, error: 'Event not found.' }, { status: 404 })

    const format = request.nextUrl.searchParams.get('format') === 'xlsx' ? 'xlsx' : 'csv'
    const registrations = await listRegistrations(auth.orgId, eventId)

    if (format === 'xlsx') {
      const buffer = await buildRegistrationsExcel(registrations)
      const filename = `event-${event.slug}-registrations.xlsx`
      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      })
    }

    const csv = buildRegistrationsCsv(registrations)
    const filename = `event-${event.slug}-registrations.csv`
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || 'Failed to export registrations.' }, { status: 500 })
  }
}
