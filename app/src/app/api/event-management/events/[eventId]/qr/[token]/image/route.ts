/**
 * Admin QR PNG render for an Event Management QR token.
 * GET /api/event-management/events/[eventId]/qr/[token]/image
 *
 * Gated by the Marketing parent gate and org-scoped: the token must belong to
 * the event, and the event to the caller's organization. The encoded URL is
 * the public registration form (/event/{token}) and contains no personal data.
 */

import { NextRequest, NextResponse } from 'next/server'
import QRCode from 'qrcode'
import { requireMarketingUser } from '@/app/api/event-management/_lib'
import { getEvent } from '@/modules/event-management/lib/events'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ eventId: string; token: string }> },
) {
  const auth = await requireMarketingUser()
  if (!auth.ok) return auth.response
  const { eventId, token } = await params

  try {
    // Ownership check: event must belong to the caller's org.
    const event = await getEvent(auth.orgId, eventId)
    if (!event) return NextResponse.json({ error: 'Event not found.' }, { status: 404 })

    const admin = createAdminClient() as any
    const { data: tokenRow } = await admin
      .from('event_qr_tokens')
      .select('id')
      .eq('token', token)
      .eq('event_id', eventId)
      .maybeSingle()
    if (!tokenRow) return NextResponse.json({ error: 'Token not found.' }, { status: 404 })

    const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://stg.serapod2u.com'
    const scanUrl = `${appBaseUrl.replace(/\/$/, '')}/event/${token}`

    const qrBuffer = await QRCode.toBuffer(scanUrl, {
      type: 'png',
      width: 400,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    })

    return new NextResponse(qrBuffer, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Failed to render QR.' }, { status: 500 })
  }
}
