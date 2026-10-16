import { exchangeTikTokAuthCode, getAuthorizedShops, tiktokAppForShop, type TikTokAuthorizedShop } from './tiktok-api'
import { computeDataFrom } from './tiktok-sync'

const STATE_COOKIE = 'tts_oauth_state'

/** Public site origin; inside the container the request origin is 0.0.0.0. */
export function tiktokPublicOrigin(requestUrl: string) {
  const env = String(process.env.NEXT_PUBLIC_APP_URL || '').trim().replace(/\/+$/, '')
  if (env && !/0\.0\.0\.0|127\.0\.0\.1|localhost/i.test(env)) return env
  try {
    const origin = new URL(requestUrl).origin
    if (!/0\.0\.0\.0/.test(origin)) return origin
  } catch {
    // fall through
  }
  return 'https://stg.serapod2u.com'
}

/** Cookie value "<state>.<shop id>": the callback checks the state and knows which shop to link. */
export function tiktokStateCookie(state: string, shopId: string) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${STATE_COOKIE}=${encodeURIComponent(`${state}.${shopId}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`
}

export function clearTikTokStateCookie() {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `${STATE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
}

export function readTikTokStateCookie(cookieHeader: string | null): { state: string; shopId: string } | null {
  const match = String(cookieHeader || '').split(';').map(p => p.trim()).find(p => p.startsWith(`${STATE_COOKIE}=`))
  if (!match) return null
  const value = decodeURIComponent(match.slice(STATE_COOKIE.length + 1))
  const dot = value.indexOf('.')
  if (dot <= 0) return null
  return { state: value.slice(0, dot), shopId: value.slice(dot + 1) }
}

const normalizeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * Picks the TikTok shop of this authorization for the selected Serapod shop.
 * Refuses when the TikTok shop's name is exactly another Serapod shop's name
 * (the user is logged into the wrong TikTok account).
 */
export function pickTikTokShop(
  tiktokShops: TikTokAuthorizedShop[],
  selected: { id: string; shop_name: string },
  companyShops: { id: string; shop_name: string }[],
): { shop: TikTokAuthorizedShop } | { error: string } {
  const usable = tiktokShops.filter(s => s.id && s.cipher)
  if (usable.length === 0) return { error: 'no_shop' }
  const wanted = normalizeName(selected.shop_name)
  const shop = usable.length === 1
    ? usable[0]
    : usable.find(s => normalizeName(s.name) === wanted) ?? usable.find(s => normalizeName(s.name).includes(wanted) || wanted.includes(normalizeName(s.name)))
  if (!shop) return { error: 'multiple_shops' }
  if (companyShops.some(s => s.id !== selected.id && normalizeName(s.shop_name) === normalizeName(shop.name))) return { error: 'wrong_shop' }
  return { shop }
}

/** Exchanges the code, finds the TikTok shop and stores the connection. Returns an error key on failure. */
export async function saveTikTokConnection(db: any, ctx: { orgId: string; userId: string }, shopId: string, authCode: string): Promise<string | null> {
  const { data: shops, error: shopsError } = await db.from('marketplace_shops').select('id, shop_name, is_active')
    .eq('company_id', ctx.orgId).eq('platform', 'tiktok_shop')
  if (shopsError) throw shopsError
  const selected = (shops || []).find((s: any) => s.id === shopId)
  if (!selected) return 'invalid'
  const app = tiktokAppForShop(selected)
  if (!app) return 'not_configured'

  let tokens
  try {
    tokens = await exchangeTikTokAuthCode(app, authCode)
  } catch (error) {
    console.error('[tiktok-shop/oauth] token', (error as Error).message)
    return 'token'
  }
  if (tokens.userType !== null && tokens.userType !== 0) return 'not_seller'

  const picked = pickTikTokShop(await getAuthorizedShops(app, tokens.accessToken), selected, shops || [])
  if ('error' in picked) return picked.error

  const { data: elsewhere, error: elsewhereError } = await db.from('marketplace_shop_connections').select('shop_id')
    .eq('platform', 'tiktok_shop').eq('external_shop_id', picked.shop.id).neq('shop_id', shopId).maybeSingle()
  if (elsewhereError) throw elsewhereError
  if (elsewhere) return 'already_connected'

  const { data: existing, error: existingError } = await db.from('marketplace_shop_connections').select('data_from, external_shop_id')
    .eq('shop_id', shopId).maybeSingle()
  if (existingError) throw existingError
  const sameShop = existing && existing.external_shop_id === picked.shop.id

  const now = new Date().toISOString()
  const row: Record<string, unknown> = {
    shop_id: shopId,
    company_id: ctx.orgId,
    platform: 'tiktok_shop',
    open_id: tokens.openId,
    seller_name: tokens.sellerName,
    seller_base_region: tokens.sellerBaseRegion,
    external_shop_id: picked.shop.id,
    external_shop_code: picked.shop.code || null,
    external_shop_name: picked.shop.name || null,
    shop_cipher: picked.shop.cipher,
    access_token: tokens.accessToken,
    access_token_expires_at: tokens.accessTokenExpiresAt,
    refresh_token: tokens.refreshToken,
    refresh_token_expires_at: tokens.refreshTokenExpiresAt,
    granted_scopes: tokens.grantedScopes,
    authorized_by: ctx.userId,
    authorized_at: now,
    updated_at: now,
    last_sync_error: null,
  }
  if (!sameShop) {
    Object.assign(row, {
      data_from: await computeDataFrom(db, shopId),
      orders_synced_to: null,
      statements_synced_to: null,
      payouts_synced_to: null,
      last_sync_status: null,
      last_sync_at: null,
    })
  }
  const { error } = await db.from('marketplace_shop_connections').upsert(row, { onConflict: 'shop_id' })
  if (error) {
    if (error.code === '23505') return 'already_connected'
    throw error
  }
  await db.from('marketplace_shops').update({ external_shop_id: picked.shop.id }).eq('id', shopId)
  return null
}
