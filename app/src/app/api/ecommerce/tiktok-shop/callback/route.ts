import { NextResponse } from 'next/server'
import { loadMarketplaceContext } from '@/lib/marketplace/access'
import { isTikTokShopApiConfigured } from '@/lib/marketplace/tiktok-api'
import {
  clearTikTokStateCookie,
  readTikTokStateCookie,
  saveTikTokConnection,
  tiktokPublicOrigin,
} from '@/lib/marketplace/tiktok-oauth'

/** GET /api/ecommerce/tiktok-shop/callback?code=…&state=… — TikTok redirects here after the seller approves. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const cookie = readTikTokStateCookie(request.headers.get('cookie'))
  const back = (result: string) => {
    const url = new URL('/ecommerce/tiktok-shop', tiktokPublicOrigin(request.url))
    url.searchParams.set('tiktok', result)
    if (cookie?.shopId) url.searchParams.set('shop', cookie.shopId)
    const res = NextResponse.redirect(url)
    res.headers.append('Set-Cookie', clearTikTokStateCookie())
    return res
  }

  const ctx = await loadMarketplaceContext()
  if (ctx.error) return back('unauthorized')
  if (!isTikTokShopApiConfigured()) return back('not_configured')

  const state = params.get('state') || ''
  if (!cookie || !state || state !== cookie.state) return back('invalid')
  const code = params.get('code') || ''
  if (params.get('error') || !code || code === 'null') return back('denied')

  try {
    const failure = await saveTikTokConnection(ctx.db, { orgId: ctx.orgId, userId: ctx.userId }, cookie.shopId, code)
    return back(failure ?? 'connected')
  } catch (error) {
    console.error('[tiktok-shop/callback]', (error as Error)?.message || error)
    return back('error')
  }
}
