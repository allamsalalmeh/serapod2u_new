import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { loadMarketplaceContext } from '@/lib/marketplace/access'
import { isTikTokShopApiConfigured, tiktokAuthorizeUrl } from '@/lib/marketplace/tiktok-api'
import { tiktokPublicOrigin, tiktokStateCookie } from '@/lib/marketplace/tiktok-oauth'

/** GET /api/ecommerce/tiktok-shop/connect?shop_id=… — sends the user to TikTok to authorize the app for this shop. */
export async function GET(request: Request) {
  const back = (error: string) => {
    const url = new URL('/ecommerce/tiktok-shop', tiktokPublicOrigin(request.url))
    url.searchParams.set('tiktok', error)
    return NextResponse.redirect(url)
  }

  const ctx = await loadMarketplaceContext()
  if (ctx.error) return back('unauthorized')
  if (!isTikTokShopApiConfigured()) return back('not_configured')

  const shopId = new URL(request.url).searchParams.get('shop_id') || ''
  const { data: shop, error } = await ctx.db.from('marketplace_shops').select('id, is_active')
    .eq('company_id', ctx.orgId).eq('platform', 'tiktok_shop').eq('id', shopId).maybeSingle()
  if (error || !shop || !shop.is_active) return back('invalid')

  const state = randomBytes(24).toString('hex')
  const res = NextResponse.redirect(tiktokAuthorizeUrl(state))
  res.headers.append('Set-Cookie', tiktokStateCookie(state, shop.id))
  return res
}
