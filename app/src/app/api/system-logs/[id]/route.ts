import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveSystemLogAccess, scopeArgs } from '@/lib/system-logs/access'

/**
 * GET /api/system-logs/[id] — one stored occurrence with its group (first/last seen, count) and the events linked to
 * it by recorded ids. Authorized by platform.system_logs.view; an out-of-scope id answers 404 (existence not revealed).
 */
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STORAGE_MISSING = new Set(['PGRST202', '42883', 'PGRST205', '42P01'])

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const access = await resolveSystemLogAccess(user?.id)
  if (!access.allowed) {
    return NextResponse.json({ error: access.status === 401 ? 'Unauthorized' : access.status === 503 ? 'Authorization service unavailable' : 'Forbidden' }, { status: access.status })
  }
  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const admin = createAdminClient() as any
  const { data, error } = await admin.rpc('system_log_event_detail', { p_id: id, ...scopeArgs(access.scope) })
  if (error) {
    if (STORAGE_MISSING.has(error.code)) return NextResponse.json({ state: 'not_installed' }, { status: 404 })
    console.error('[system-logs] detail failed', { code: error.code })
    return NextResponse.json({ error: 'System Logs unavailable' }, { status: 503 })
  }
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // Display-only organization name (optional; a failure leaves the id).
  const orgId = data?.event?.organization_id
  let organizationName: string | null = null
  if (orgId) {
    const { data: org } = await admin.from('organizations').select('org_name').eq('id', orgId).maybeSingle()
    organizationName = org?.org_name ?? null
  }
  return NextResponse.json({ state: 'ok', detail: data, organizationName })
}
