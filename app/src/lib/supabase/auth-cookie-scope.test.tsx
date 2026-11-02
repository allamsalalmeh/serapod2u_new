import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authCookieOptionsForHost, isSharedAuthCookie, sharedAuthCookieForHost } from './auth-cookie-scope'

describe('shared shopper login cookie', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://supabase-stg-serapod.getouch.cloud')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('main site and store of a live group share one cookie on the parent domain', () => {
    const shared = { name: 'sb-supabase-stg-serapod-shop-auth-token', domain: '.serapod2u.com' }
    expect(sharedAuthCookieForHost('stg.serapod2u.com')).toEqual(shared)
    expect(sharedAuthCookieForHost('STG-STORE.serapod2u.com:443')).toEqual(shared)
    expect(authCookieOptionsForHost('stg-store.serapod2u.com')).toEqual({ cookieOptions: shared })
  })

  it('the admin site and hosts outside a live group keep Supabase defaults', () => {
    for (const host of ['stg-admin.serapod2u.com', 'www.serapod2u.com', 'serapod2u.com', 'store.serapod2u.com', 'admin.serapod2u.com', 'outdoor.serapod2u.com', 'localhost', '', null]) {
      expect(sharedAuthCookieForHost(host), String(host)).toBeNull()
      expect(authCookieOptionsForHost(host), String(host)).toEqual({})
    }
  })

  it('recognises the shared cookie and its chunks only', () => {
    const shared = sharedAuthCookieForHost('stg-store.serapod2u.com')
    expect(isSharedAuthCookie('sb-supabase-stg-serapod-shop-auth-token', shared)).toBe(true)
    expect(isSharedAuthCookie('sb-supabase-stg-serapod-shop-auth-token.1', shared)).toBe(true)
    expect(isSharedAuthCookie('sb-supabase-stg-serapod-shop-auth-token-code-verifier', shared)).toBe(true)
    expect(isSharedAuthCookie('sb-supabase-stg-serapod-auth-token', shared)).toBe(false)
    expect(isSharedAuthCookie('sb-supabase-stg-serapod-shop-auth-token', null)).toBe(false)
  })
})
