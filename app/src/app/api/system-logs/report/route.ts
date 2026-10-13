import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkRateLimit, clientIpFromHeaders } from '@/lib/security/rate-limit'
import { LIMITS, isNoise } from '@/lib/system-logs/contract'
import { describeUserAgent } from '@/lib/system-logs/sanitize'
import { browserEventSchema, reportBodySchema, toBrowserPayload, type ReportBody } from '@/lib/system-logs/ingest'
import { appBuild, resolveRuntimeEnvironment } from '@/lib/system-logs/environment'
import { storeDiagnostic } from '@/lib/system-logs/server'

/**
 * POST /api/system-logs/report — browser diagnostics (SELF: the caller reports its own failures).
 *
 * Browser input is untrusted:
 *   - a signed-in session is required (no anonymous reporting path exists);
 *   - actor = the session user, organization = that user's organization (server lookup), environment/build/source/kind
 *     = server-side values; any identity or environment field in the body is ignored (schema strips unknown keys);
 *   - body ≤ 32 KB, ≤ 10 events, every string bounded, metadata depth/size bounded, everything sanitized before storage;
 *   - rate limits: 30 events/minute per user, 120 requests/minute per IP; the database adds per-group bounds;
 *   - only kind=error can be written here: user activity comes from server-side audit sources, never from a browser.
 */
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const raw = await request.text().catch(() => '')
  if (raw.length > LIMITS.batchBytes) return NextResponse.json({ error: 'Payload too large' }, { status: 413 })

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ip = clientIpFromHeaders(request.headers)
  const ipLimit = checkRateLimit(`system-logs:report:ip:${ip}`, 120, 60_000)
  if (!ipLimit.allowed) return tooMany(ipLimit.retryAfterSeconds)

  let parsed: ReportBody
  try {
    parsed = reportBodySchema.parse(JSON.parse(raw))
  } catch {
    return NextResponse.json({ error: 'Invalid report' }, { status: 400 })
  }

  let organizationId: string | null = null
  try {
    const admin = createAdminClient(3_000) as any
    const { data } = await admin.from('users').select('organization_id').eq('id', user.id).maybeSingle()
    organizationId = data?.organization_id ?? null
  } catch { /* organization unknown: stored without one (visible only to every-organization viewers) */ }

  const environment = resolveRuntimeEnvironment()
  const serverBuild = appBuild()
  const ua = describeUserAgent(request.headers.get('user-agent'))
  const accepted: string[] = []
  let rejected = 0
  let limited = false

  for (const candidate of parsed.events) {
    const result = browserEventSchema.safeParse(candidate)
    if (!result.success) { rejected++; continue }
    const ev = result.data
    if (ev.category === 'cancelled' || isNoise(ev.message, ev.stack)) { rejected++; continue }
    const userLimit = checkRateLimit(`system-logs:report:user:${user.id}`, 30, 60_000)
    if (!userLimit.allowed) { limited = true; break }
    const payload = toBrowserPayload(ev, { actorId: user.id, organizationId, environment, serverBuild, ua })
    const stored = await storeDiagnostic(payload)
    if (stored.stored || stored.result?.suppressed) accepted.push(ev.referenceId)
    else rejected++
  }
  if (limited && accepted.length === 0) return tooMany(60)
  return NextResponse.json({ accepted, rejected, limited })
}

function tooMany(retryAfter: number) {
  return NextResponse.json({ error: 'Too many reports' }, { status: 429, headers: { 'Retry-After': String(retryAfter) } })
}
