import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveSystemLogAccess, scopeArgs } from '@/lib/system-logs/access'
import { resolveRuntimeEnvironment } from '@/lib/system-logs/environment'
import { decodeCursor, encodeCursor, listQuerySchema, resolveWindow } from '@/lib/system-logs/query'

/**
 * GET /api/system-logs — Errors (default, last 24 h) or User Activity, server-side paginated (keyset), bounded.
 * Authorized by platform.system_logs.view (lib/system-logs/access.ts); rows limited to readable organizations.
 */
export const dynamic = 'force-dynamic'

const STORAGE_MISSING = new Set(['PGRST202', '42883', 'PGRST205', '42P01'])

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const access = await resolveSystemLogAccess(user?.id)
  if (!access.allowed) {
    return NextResponse.json({ error: access.status === 401 ? 'Unauthorized' : access.status === 503 ? 'Authorization service unavailable' : 'Forbidden', code: access.status === 403 ? 'sa_forbidden' : undefined, permission: 'platform.system_logs.view' }, { status: access.status })
  }

  const parsed = listQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid filters' }, { status: 400 })
  const q = parsed.data
  const { from, to } = resolveWindow(q)
  const cursor = decodeCursor(q.cursor)
  const environment = resolveRuntimeEnvironment()
  const base = { environment, window: { from: from.toISOString(), to: to.toISOString() }, retentionDays: 30 }
  if (!access.scope.all && access.scope.organizationIds.length === 0) {
    return NextResponse.json({ ...base, state: 'ok', items: [], nextCursor: null, scope: 'none' })
  }

  const admin = createAdminClient() as any
  const scope = scopeArgs(access.scope)
  const fetchLimit = q.limit + 1
  let result
  if (q.tab === 'errors') {
    result = await admin.rpc('system_log_list_errors', {
      ...scope, p_from: from.toISOString(), p_to: to.toISOString(), p_environment: q.environment ?? null, p_actor: q.user ?? null,
      p_module: q.module ?? null, p_severity: q.severity ?? null, p_category: q.category ?? null, p_search: q.q ?? null,
      p_limit: fetchLimit, p_cursor_time: cursor?.t ?? null, p_cursor_id: cursor?.k && /^[0-9a-f-]{36}$/i.test(cursor.k) ? cursor.k : null,
    })
  } else {
    result = await admin.rpc('system_log_list_activity', {
      ...scope, p_from: from.toISOString(), p_to: to.toISOString(), p_actor: q.user ?? null, p_module: q.module ?? null,
      p_outcome: q.outcome ?? null, p_search: q.q ?? null, p_limit: fetchLimit, p_cursor_time: cursor?.t ?? null, p_cursor_key: cursor?.k ?? null,
    })
  }
  if (result.error) {
    if (STORAGE_MISSING.has(result.error.code)) {
      return NextResponse.json({ ...base, state: 'not_installed', items: [], nextCursor: null })
    }
    console.error('[system-logs] list failed', { tab: q.tab, code: result.error.code })
    return NextResponse.json({ ...base, state: 'unavailable', items: [], nextCursor: null }, { status: 503 })
  }
  const rows: any[] = Array.isArray(result.data) ? result.data : []
  const items = rows.slice(0, q.limit)
  const last = items[items.length - 1]
  const nextCursor = rows.length > q.limit && last
    ? encodeCursor({ t: last.occurred_at, k: q.tab === 'errors' ? last.id : last.sort_key })
    : null
  return NextResponse.json({ ...base, state: 'ok', scope: access.scope.all ? 'all' : 'organizations', items, nextCursor })
}
