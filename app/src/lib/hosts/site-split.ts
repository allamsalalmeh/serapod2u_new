/**
 * One app, three addresses: the main site (company page, QR /track, /app, Outdoor),
 * the customer store and the staff/distributor portal. Pure and browser-safe; the
 * middleware, server routes and client components share it.
 *
 * A group only takes effect while `active` is true. Hosts outside an active group keep
 * the app's behaviour from before the split.
 */
export type SiteRole = 'main' | 'admin' | 'store'

export interface SiteGroup {
  main: readonly string[]
  admin: string
  store: string
  active: boolean
}

export const SITE_GROUPS: readonly SiteGroup[] = [
  { main: ['stg.serapod2u.com'], admin: 'stg-admin.serapod2u.com', store: 'stg-store.serapod2u.com', active: true },
  { main: ['serapod2u.com', 'www.serapod2u.com'], admin: 'admin.serapod2u.com', store: 'store.serapod2u.com', active: false },
]

export interface SiteHost {
  group: SiteGroup
  role: SiteRole
}

function normalizeHost(hostname: string | null | undefined) {
  return String(hostname || '').trim().toLowerCase().split(':')[0]
}

export function siteForHost(hostname: string | null | undefined): SiteHost | null {
  const host = normalizeHost(hostname)
  if (!host) return null
  for (const group of SITE_GROUPS) {
    if (!group.active) continue
    if (group.admin === host) return { group, role: 'admin' }
    if (group.store === host) return { group, role: 'store' }
    if (group.main.includes(host)) return { group, role: 'main' }
  }
  return null
}

export function siteHostFor(group: SiteGroup, role: SiteRole) {
  return role === 'admin' ? group.admin : role === 'store' ? group.store : group.main[0]
}

/** Served on every address: APIs, sign-in plumbing, legal pages and static files. */
const SHARED_PREFIXES = [
  '/api', '/auth', '/_next', '/login', '/forgot-password',
  '/privacy-policy', '/terms-of-service', '/data-deletion',
  '/brand', '/icons', '/images', '/sounds',
]

/** Public consumer pages on the main site. Printed QR codes and shared links point here. */
const MAIN_PREFIXES = [
  '/track', '/app', '/scan', '/verify', '/s', '/rt', '/event', '/lp', '/help', '/outdoor', '/corporate',
]

const STORE_PREFIXES = ['/store', '/signup']

/** Installed phone apps (SerApp, HR) keep working on the main site as well as the portal. */
const PHONE_APP_PREFIXES = ['/serapp', '/hr']

function underPrefix(pathname: string, prefixes: readonly string[]) {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

function isStaticFile(pathname: string) {
  const last = pathname.split('/').pop() || ''
  return last.includes('.')
}

function isPublicRoadtourScan(pathname: string) {
  return /^\/roadtour\/\d{4}\//.test(pathname)
}

export type PathOwner = 'shared' | 'main' | 'store' | 'admin' | 'phone-app'

export function pathOwner(pathname: string): PathOwner {
  if (isStaticFile(pathname) || underPrefix(pathname, SHARED_PREFIXES)) return 'shared'
  if (underPrefix(pathname, MAIN_PREFIXES) || isPublicRoadtourScan(pathname)) return 'main'
  if (underPrefix(pathname, STORE_PREFIXES)) return 'store'
  if (underPrefix(pathname, PHONE_APP_PREFIXES)) return 'phone-app'
  return 'admin'
}

/** Where a sign-in or sign-up that started on the main site belongs, from its ?next= / ?mode=. */
function mainSiteAuthTarget(search: URLSearchParams): SiteRole {
  const next = search.get('next') || search.get('redirect') || ''
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next.split('?')[0] : ''
  if (search.get('mode') === 'store' || underPrefix(safeNext, STORE_PREFIXES)) return 'store'
  if (safeNext && (underPrefix(safeNext, MAIN_PREFIXES) || underPrefix(safeNext, PHONE_APP_PREFIXES) || isPublicRoadtourScan(safeNext))) return 'main'
  return 'admin'
}

export type SiteDecision =
  | { type: 'redirect'; host: string; pathname: string }
  | { type: 'rewrite'; pathname: string }
  | null

/** What the request should do on this address; null keeps the app's normal handling. */
export function decideSiteRoute(
  hostname: string | null | undefined,
  pathname: string,
  search: URLSearchParams,
): SiteDecision {
  const site = siteForHost(hostname)
  if (!site) return null
  const { group, role } = site
  const to = (target: SiteRole, path = pathname): SiteDecision =>
    target === role && path === pathname ? null : { type: 'redirect', host: siteHostFor(group, target), pathname: path }

  if (role === 'main') {
    if (pathname === '/') return { type: 'rewrite', pathname: '/corporate/serapod2u' }
    if (pathname === '/login' || pathname === '/signup') {
      const target = pathname === '/signup' && mainSiteAuthTarget(search) === 'admin' ? 'store' : mainSiteAuthTarget(search)
      return to(target)
    }
    const owner = pathOwner(pathname)
    if (owner === 'shared' || owner === 'main' || owner === 'phone-app') return null
    return to(owner)
  }

  if (role === 'admin') {
    if (pathname === '/') return to('admin', '/login')
    const owner = pathOwner(pathname)
    if (owner === 'shared' || owner === 'admin' || owner === 'phone-app') return null
    return to(owner)
  }

  const owner = pathOwner(pathname)
  if (pathname === '/' || owner === 'shared' || owner === 'store') return null
  return to(owner === 'phone-app' ? 'admin' : owner)
}

/** The login page's mode on this address: business on the portal, store on the store, unchanged elsewhere. */
export function loginModeForHost(hostname: string | null | undefined): 'business' | 'store' | null {
  const site = siteForHost(hostname)
  if (!site || site.role === 'main') return null
  return site.role === 'admin' ? 'business' : 'store'
}

/** True on the customer store address of an active group. */
export function isStoreSiteHost(hostname: string | null | undefined) {
  return siteForHost(hostname)?.role === 'store'
}

/** The store or portal address this request came to, kept for sign-in and payment returns. */
export function splitSiteOrigin(hostname: string | null | undefined): string | null {
  const site = siteForHost(hostname)
  if (!site || site.role === 'main') return null
  return `https://${siteHostFor(site.group, site.role)}`
}
