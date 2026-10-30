import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { decideSiteRoute, isStoreSiteHost, loginModeForHost, pathOwner, phoneAppSignInKeepsMainSite, splitSiteOrigin } from './site-split'
import { sameHostOrigin } from './same-host'
import { publicOriginFromRequest } from '@/lib/http/public-origin'

const MAIN = 'stg.serapod2u.com'
const ADMIN = 'stg-admin.serapod2u.com'
const STORE = 'stg-store.serapod2u.com'

const decide = (host: string, path: string, query = '') => decideSiteRoute(host, path, new URLSearchParams(query))
const redirectTo = (host: string, pathname: string) => ({ type: 'redirect', host, pathname })

describe('site split: production and other hosts are untouched', () => {
  it('does nothing on the production, Outdoor, serapod.com and local hosts', () => {
    for (const host of ['serapod2u.com', 'www.serapod2u.com', 'admin.serapod2u.com', 'store.serapod2u.com', 'outdoor.serapod2u.com', 'serapod.com', 'localhost']) {
      for (const path of ['/', '/store', '/login', '/dashboard', '/track/product/X', '/signup', '/serapp/conversation']) {
        expect(decide(host, path)).toBeNull()
      }
    }
    expect(loginModeForHost('www.serapod2u.com')).toBeNull()
    expect(isStoreSiteHost('serapod2u.com')).toBe(false)
    expect(splitSiteOrigin('www.serapod2u.com')).toBeNull()
  })
})

describe('site split: main site', () => {
  it('shows the company page at /', () => {
    expect(decide(MAIN, '/')).toEqual({ type: 'rewrite', pathname: '/corporate/serapod2u' })
  })

  it('keeps QR codes, /app, Outdoor, short links, legal pages, APIs and phone apps', () => {
    for (const path of ['/track/product/PROD-1', '/app', '/scan', '/s/abc', '/rt/2026/a/b', '/roadtour/2026/x', '/event/t', '/lp/x', '/help/collect-points',
      '/outdoor', '/outdoor/shop', '/privacy-policy', '/api/storefront/checkout', '/auth/callback', '/forgot-password', '/manifest.json', '/serapp/conversation', '/hr/mobile/home']) {
      expect(decide(MAIN, path)).toBeNull()
    }
  })

  it('sends store pages to the store address, keeping the path', () => {
    expect(decide(MAIN, '/store')).toEqual(redirectTo(STORE, '/store'))
    expect(decide(MAIN, '/store/orders/success')).toEqual(redirectTo(STORE, '/store/orders/success'))
    expect(decide(MAIN, '/signup')).toEqual(redirectTo(STORE, '/signup'))
  })

  it('sends staff pages to the portal address, keeping the path', () => {
    for (const path of ['/dashboard', '/supply-chain/orders', '/ecommerce/store-orders', '/finance', '/settings', '/crm', '/reporting', '/roadtour', '/catalog', '/users/1']) {
      expect(decide(MAIN, path)).toEqual(redirectTo(ADMIN, path))
    }
  })

  it('sends /login to the portal, or to the store / stays for shopper and Outdoor returns', () => {
    expect(decide(MAIN, '/login')).toEqual(redirectTo(ADMIN, '/login'))
    expect(decide(MAIN, '/login', 'next=/dashboard')).toEqual(redirectTo(ADMIN, '/login'))
    expect(decide(MAIN, '/login', 'next=/store/checkout')).toEqual(redirectTo(STORE, '/login'))
    expect(decide(MAIN, '/login', 'mode=store')).toEqual(redirectTo(STORE, '/login'))
    expect(decide(MAIN, '/login', 'next=/outdoor/account')).toBeNull()
    expect(decide(MAIN, '/login', 'next=/serapp/conversation')).toBeNull()
    expect(decide(MAIN, '/login', 'next=/hr/mobile/home')).toBeNull()
    expect(decide(MAIN, '/signup', 'next=/outdoor')).toBeNull()
  })
})

describe('site split: portal address', () => {
  it('opens the staff login at /', () => {
    expect(decide(ADMIN, '/')).toEqual(redirectTo(ADMIN, '/login'))
  })

  it('serves staff pages, login, phone apps and APIs', () => {
    for (const path of ['/login', '/dashboard', '/supply-chain', '/serapp/conversation', '/hr', '/api/admin/redemptions/status', '/forgot-password']) {
      expect(decide(ADMIN, path)).toBeNull()
    }
  })

  it('sends store and consumer pages to their addresses', () => {
    expect(decide(ADMIN, '/store/products')).toEqual(redirectTo(STORE, '/store/products'))
    expect(decide(ADMIN, '/signup')).toEqual(redirectTo(STORE, '/signup'))
    expect(decide(ADMIN, '/track/product/X')).toEqual(redirectTo(MAIN, '/track/product/X'))
    expect(decide(ADMIN, '/outdoor')).toEqual(redirectTo(MAIN, '/outdoor'))
  })
})

describe('site split: store address', () => {
  it('serves the store, sign-in and sign-up', () => {
    for (const path of ['/', '/store', '/store/checkout', '/login', '/signup', '/forgot-password', '/api/storefront/checkout', '/auth/callback']) {
      expect(decide(STORE, path)).toBeNull()
    }
  })

  it('sends staff pages and phone apps to the portal, consumer pages to the main site', () => {
    expect(decide(STORE, '/dashboard')).toEqual(redirectTo(ADMIN, '/dashboard'))
    expect(decide(STORE, '/serapp/conversation')).toEqual(redirectTo(ADMIN, '/serapp/conversation'))
    expect(decide(STORE, '/app')).toEqual(redirectTo(MAIN, '/app'))
  })
})

describe('site split: helpers', () => {
  it('SerApp / HR sign-in on the split main site keeps its page; nowhere else', () => {
    expect(phoneAppSignInKeepsMainSite(MAIN, '/serapp/conversation')).toBe(true)
    expect(phoneAppSignInKeepsMainSite(MAIN, '/hr/mobile/home')).toBe(true)
    expect(phoneAppSignInKeepsMainSite(MAIN, '/dashboard')).toBe(false)
    expect(phoneAppSignInKeepsMainSite(ADMIN, '/serapp/conversation')).toBe(false)
    expect(phoneAppSignInKeepsMainSite('www.serapod2u.com', '/serapp/conversation')).toBe(false)
  })

  it('classifies paths', () => {
    expect(pathOwner('/storefront')).toBe('admin')
    expect(pathOwner('/store')).toBe('store')
    expect(pathOwner('/apple-touch-icon.png')).toBe('shared')
    expect(pathOwner('/roadtour/campaigns')).toBe('admin')
  })

  it('login mode and origins follow the address', () => {
    expect(loginModeForHost(ADMIN)).toBe('business')
    expect(loginModeForHost(STORE)).toBe('store')
    expect(loginModeForHost(MAIN)).toBeNull()
    expect(splitSiteOrigin(STORE)).toBe('https://stg-store.serapod2u.com')
    expect(splitSiteOrigin(`${ADMIN}:443`)).toBe('https://stg-admin.serapod2u.com')
    expect(splitSiteOrigin(MAIN)).toBeNull()
  })

  it('payment and request links built on the store address stay on it; production keeps its origin', () => {
    const at = (host: string) => new NextRequest(`https://${host}/api/storefront/checkout`, { headers: { host } })
    expect(publicOriginFromRequest(at(STORE))).toBe('https://stg-store.serapod2u.com')
    expect(publicOriginFromRequest(at('outdoor.serapod2u.com'))).toBe('https://outdoor.serapod2u.com')
    const before = process.env.NEXT_PUBLIC_APP_URL
    process.env.NEXT_PUBLIC_APP_URL = 'https://www.serapod2u.com'
    try {
      expect(publicOriginFromRequest(at('www.serapod2u.com'))).toBe('https://www.serapod2u.com')
      expect(publicOriginFromRequest(at('serapod2u.com'))).toBe('https://www.serapod2u.com')
    } finally {
      process.env.NEXT_PUBLIC_APP_URL = before
    }
  })

  it('sign-in returns stay on the store / portal address; other hosts keep the twin rule', () => {
    expect(sameHostOrigin('https://stg.serapod2u.com', STORE)).toBe('https://stg-store.serapod2u.com')
    expect(sameHostOrigin('https://stg.serapod2u.com', ADMIN)).toBe('https://stg-admin.serapod2u.com')
    expect(sameHostOrigin('https://stg.serapod2u.com', MAIN)).toBe('https://stg.serapod2u.com')
    expect(sameHostOrigin('https://www.serapod2u.com', 'serapod2u.com')).toBe('https://serapod2u.com')
    expect(sameHostOrigin('https://www.serapod2u.com', 'store.serapod2u.com')).toBe('https://www.serapod2u.com')
  })
})
