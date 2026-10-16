/**
 * Public Event Management registration endpoint.
 * POST /api/event-management/public/register
 *
 * Anonymous (no login). Rate-limited before any expensive token/database work.
 * Body = token + form fields; staff attribution is resolved server-side from
 * the token only. Returns a generic confirmation — never personal data, never
 * staff attribution, never a previous confirmation identifier.
 */

import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit, clientIpFromHeaders } from '@/lib/security/rate-limit'
import { publicRegistrationSchema } from '@/modules/event-management/validation/registration'
import { registerVisitor } from '@/modules/event-management/lib/registrations'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  // 1) Rate-limit by client IP before any token/database operation.
  const ip = clientIpFromHeaders(request.headers)
  const limit = checkRateLimit(`event-register:${ip}`, 30, 60 * 1000)
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please try again shortly.', retryAfterSeconds: limit.retryAfterSeconds },
      { status: 429 },
    )
  }

  const body = await request.json().catch(() => ({}))
  const parsed = publicRegistrationSchema.safeParse(body)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return NextResponse.json({ error: first?.message ?? 'Invalid input.' }, { status: 400 })
  }

  const input = parsed.data
  const result = await registerVisitor({
    token: input.token,
    name: input.name,
    phone: input.phone,
    email: input.email ?? null,
    cat_name: input.cat_name ?? null,
    cat_breed: input.cat_breed ?? null,
    current_cat_food: input.current_cat_food ?? null,
    marketing_consent: input.marketing_consent === true,
    ip,
  })

  if (!result.confirmed) {
    const status = result.status
    if (status === 'not_open' || status === 'closed' || status === 'event_not_active' || status === 'revoked' || status === 'expired') {
      return NextResponse.json({ error: result.message ?? 'Registration is closed.' }, { status: 410 })
    }
    if (status === 'invalid_token') {
      return NextResponse.json({ error: result.message ?? 'Invalid QR code.' }, { status: 404 })
    }
    return NextResponse.json({ error: result.message ?? 'Invalid input.' }, { status: 400 })
  }

  // Generic confirmation: identical for new and duplicate submissions.
  return NextResponse.json({ confirmed: true })
}
