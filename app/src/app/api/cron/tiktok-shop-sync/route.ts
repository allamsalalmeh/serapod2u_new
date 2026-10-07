import { NextRequest, NextResponse } from 'next/server'
import { requireCronAuth } from '@/lib/cron/auth'
import { remoteDbWorkerBlockedResponse } from '@/lib/cron/remote-db-guard'
import { createAdminClient } from '@/lib/supabase/admin'
import { isTikTokShopApiConfigured } from '@/lib/marketplace/tiktok-api'
import { CONNECTION_COLUMNS, claimSyncRun, syncTikTokShop } from '@/lib/marketplace/tiktok-sync'

/**
 * CRON: hourly TikTok Shop API sync of every connected shop (orders,
 * settlements, payouts). Auth: Authorization Bearer CRON_SECRET.
 */
const WORKER = 'tiktok-shop-sync'
const BUDGET_MS = 50_000

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const unauthorized = requireCronAuth(request, WORKER)
  if (unauthorized) return unauthorized
  const blocked = remoteDbWorkerBlockedResponse(WORKER)
  if (blocked) return blocked
  if (!isTikTokShopApiConfigured()) return NextResponse.json({ ok: true, skipped: 'not_configured' })

  try {
    const db = createAdminClient() as any
    const { data: connections, error } = await db.from('marketplace_shop_connections').select(CONNECTION_COLUMNS).order('last_sync_at', { ascending: true, nullsFirst: true })
    if (error) {
      if (error.code === '42P01' || error.code === 'PGRST205') return NextResponse.json({ ok: true, skipped: 'not_migrated' })
      throw error
    }
    const deadline = Date.now() + BUDGET_MS
    const results: { shop_id: string; ok: boolean; done: boolean; error?: string }[] = []
    for (const conn of connections || []) {
      const remaining = deadline - Date.now()
      if (remaining < 5_000) break
      if (!(await claimSyncRun(db, conn.shop_id))) continue
      const share = Math.max(5_000, Math.floor(remaining / Math.max(1, (connections.length - results.length))))
      const result = await syncTikTokShop(db, conn, Date.now() + share)
      results.push({ shop_id: conn.shop_id, ok: result.ok, done: result.done, error: result.error })
      if (!result.ok) console.warn(`[${WORKER}] shop ${conn.shop_id}: ${result.error}`)
    }
    return NextResponse.json({ ok: true, shops: results.length, results })
  } catch (error) {
    console.error(`[${WORKER}]`, error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'TikTok Shop sync failed' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
