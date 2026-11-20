import { SITE_GROUPS } from '@/lib/hosts/site-split'

export type SharedAuthCookie = { name: string; domain: string }

function projectRef() {
  return String(process.env.NEXT_PUBLIC_SUPABASE_URL || '').split('//')[1]?.split('.')[0] || ''
}

/** Cookie of the shopper login shared by the main site and the store. */
export function sharedAuthCookieName() {
  return `sb-${projectRef()}-shop-auth-token`
}

/**
 * The main site and the store of a live split group share one shopper login: one cookie on the
 * parent domain under its own name. The admin site, and every host outside a live group, keeps
 * Supabase's default host-only cookie, so it never reads that login.
 */
export function sharedAuthCookieForHost(hostname: string | null | undefined): SharedAuthCookie | null {
  const host = String(hostname || '').trim().toLowerCase().split(':')[0]
  if (!host || !projectRef()) return null
  const group = SITE_GROUPS.find((g) => g.active && (g.store === host || g.main.includes(host)))
  if (!group) return null
  const labels = group.store.split('.')
  if (labels.length < 3) return null
  return { name: sharedAuthCookieName(), domain: `.${labels.slice(-2).join('.')}` }
}

/** Options for createServerClient / createBrowserClient on this host ({} = Supabase defaults). */
export function authCookieOptionsForHost(hostname: string | null | undefined) {
  const shared = sharedAuthCookieForHost(hostname)
  return shared ? { cookieOptions: { name: shared.name, domain: shared.domain } } : {}
}

/** The shared cookie (and its chunks) among these cookie names. */
export function isSharedAuthCookie(name: string, shared: SharedAuthCookie | null) {
  return Boolean(shared) && (name === shared!.name || name.startsWith(`${shared!.name}.`) || name.startsWith(`${shared!.name}-`))
}
