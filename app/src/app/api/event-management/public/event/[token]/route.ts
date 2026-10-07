/**
 * Public Event Management form config endpoint.
 * GET /api/event-management/public/event/[token]
 *
 * Resolves the opaque QR token server-side (service-role RPC) and returns only
 * the non-sensitive form config: event name, brand, required/optional field
 * flags and consent text. It NEVER returns staff or contact data.
 */

import { NextRequest, NextResponse } from 'next/server'
import { validateEventToken } from '@/modules/event-management/lib/staff-qr'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  if (!token) return NextResponse.json({ error: 'Invalid QR code.' }, { status: 400 })

  const data = await validateEventToken(token)
  if (!data || data.valid !== true) {
    const status = data?.status
    if (status === 'revoked' || status === 'expired' || status === 'event_not_active') {
      return NextResponse.json({ error: 'Registration is closed.' }, { status: 410 })
    }
    return NextResponse.json({ error: 'Invalid QR code.' }, { status: 404 })
  }

  // Sanitised: only non-sensitive config. No staff, no contact records.
  return NextResponse.json({
    event_name: data.event_name ?? null,
    brand_name: data.brand_name ?? null,
    timezone: data.timezone ?? 'Asia/Kuala_Lumpur',
    opens_at: data.opens_at ?? null,
    closes_at: data.closes_at ?? null,
    kind: data.kind ?? null,
    form_config: data.form_config ?? {},
  })
}
