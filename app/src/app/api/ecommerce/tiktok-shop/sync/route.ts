import { NextResponse } from 'next/server'
import { loadMarketplaceContext } from '@/lib/marketplace/access'
import { isTikTokShopApiConfigured } from '@/lib/marketplace/tiktok-api'
import { CONNECTION_COLUMNS, claimSyncRun, syncTikTokShop } from '@/lib/marketplace/tiktok-sync'

/** POST /api/ecommerce/tiktok-shop/sync — { shop_id }: reads new orders, settlements and payouts from the TikTok Shop API now. */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const BUDGET_MS = 45_000

export async function POST(request: Request) {
  try {
    const ctx = await loadMarketplaceContext()
    if (ctx.error) return ctx.error
    if (!isTikTokShopApiConfigured()) return NextResponse.json({ error: 'The TikTok Shop app is not set up on this server yet.' }, { status: 503 })

    const body = await request.json().catch(() => null)
    const shopId = typeof body?.shop_id === 'string' ? body.shop_id : ''
    const { data: conn, error } = await ctx.db.from('marketplace_shop_connections').select(CONNECTION_COLUMNS)
      .eq('company_id', ctx.orgId).eq('shop_id', shopId).maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!conn) return NextResponse.json({ error: 'This shop is not connected to TikTok.' }, { status: 404 })

    if (!(await claimSyncRun(ctx.db, shopId))) return NextResponse.json({ error: 'A sync for this shop is already running. Try again in a few minutes.' }, { status: 409 })
    const result = await syncTikTokShop(ctx.db, conn, Date.now() + BUDGET_MS)
    if (!result.ok) return NextResponse.json({ error: result.error, counts: result.counts }, { status: 502 })
    return NextResponse.json(result)
  } catch (error) {
    console.error('Error syncing TikTok Shop:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
