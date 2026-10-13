import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireCronAuth } from '@/lib/cron/auth'
import { WORKER_NAMES, withWorkerLease } from '@/lib/cron/lease'
import { reportWorkerFailure } from '@/lib/system-logs/server'

/**
 * CRON: System Logs diagnostic retention (30 days).
 *
 * Calls the service-only public.system_log_purge_expired(), which deletes only diagnostic error occurrences
 * (system_log_events.kind = 'error') and idle error groups older than 30 days, in bounded batches. It never touches
 * order activity rows, audit_logs or sa_access_change_log. The endpoint takes no parameters.
 */
const WORKER = WORKER_NAMES.systemLogRetention
const BATCH_LIMIT = 5000
const MAX_BATCHES_PER_RUN = 10

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(request: NextRequest) {
  const unauthorized = requireCronAuth(request, WORKER)
  if (unauthorized) return unauthorized

  const supabase = createAdminClient()
  const outcome = await withWorkerLease(supabase, WORKER, () => runRetention(supabase))
  return outcome.status === 'ran' ? outcome.result : outcome.response
}

async function runRetention(supabase: ReturnType<typeof createAdminClient>): Promise<NextResponse> {
  let deletedEvents = 0
  let deletedGroups = 0
  let batches = 0
  let moreRemaining = true
  while (moreRemaining && batches < MAX_BATCHES_PER_RUN) {
    const { data, error } = await (supabase as any).rpc('system_log_purge_expired', { p_batch_limit: BATCH_LIMIT })
    if (error) {
      if (error.code === 'PGRST202' || error.code === '42883') {
        console.warn(`[${WORKER}] retention function not installed; skipping`)
        return NextResponse.json({ status: 'RETENTION_NOT_INSTALLED', deletedEvents: 0 })
      }
      console.error(`[${WORKER}] purge failed`, { code: error.code, batches, deletedEvents })
      void reportWorkerFailure(WORKER, { error, message: `System log retention failed (${error.code ?? 'unknown'})`, details: { batches, deleted_events: deletedEvents } })
      return NextResponse.json({ status: 'FAILED', deletedEvents, batches }, { status: 500 })
    }
    batches += 1
    if (data?.status !== 'completed') break // a concurrent run holds the purge lock
    deletedEvents += Number(data.deleted_events || 0)
    deletedGroups += Number(data.deleted_groups || 0)
    moreRemaining = data.more_remaining === true
  }
  console.log(`[${WORKER}] deleted ${deletedEvents} diagnostic event(s) and ${deletedGroups} group(s) in ${batches} batch(es)`)
  return NextResponse.json({ status: 'OK', deletedEvents, deletedGroups, batches, moreRemaining })
}
