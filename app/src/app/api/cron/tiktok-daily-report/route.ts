import { NextRequest, NextResponse } from 'next/server'
import { requireCronAuth } from '@/lib/cron/auth'
import { remoteDbWorkerBlockedResponse } from '@/lib/cron/remote-db-guard'
import { createAdminClient } from '@/lib/supabase/admin'
import { runTikTokDailyReport } from '@/lib/marketplace/tiktok-daily-report-server'
import type { DailyReportSlot } from '@/lib/marketplace/tiktok-daily-report'

/**
 * CRON: TikTok Shop daily shipping report. Runs hourly at :35 (after the :23
 * sync) and sends only at the scheduled Malaysia hours. `?slot=packing|shipped`
 * runs one now (a manual run is never treated as a duplicate).
 * Auth: Authorization Bearer CRON_SECRET.
 */
const WORKER = 'tiktok-daily-report'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const unauthorized = requireCronAuth(request, WORKER)
  if (unauthorized) return unauthorized
  const blocked = remoteDbWorkerBlockedResponse(WORKER)
  if (blocked) return blocked

  const raw = request.nextUrl.searchParams.get('slot')
  const slot: DailyReportSlot | undefined = raw === 'packing' || raw === 'shipped' ? raw : undefined
  try {
    const result = await runTikTokDailyReport(createAdminClient(), { slot, force: Boolean(slot) })
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    console.error(`[${WORKER}]`, error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'TikTok daily report failed' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
