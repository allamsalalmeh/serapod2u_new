import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveSystemLogAccess } from '@/lib/system-logs/access'
import { resolveRuntimeEnvironment } from '@/lib/system-logs/environment'

/**
 * GET /api/system-logs/access — may the caller open System Logs? Drives the Settings card / top-nav entry and the
 * S&A shortcut only (hiding is never authorization; the page and data APIs decide again). Decides without writing an
 * authorization audit row.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ allowed: false }, { status: 401 })
  const access = await resolveSystemLogAccess(user.id, { probe: true })
  return NextResponse.json({ allowed: access.allowed, environment: access.allowed ? resolveRuntimeEnvironment() : undefined })
}
