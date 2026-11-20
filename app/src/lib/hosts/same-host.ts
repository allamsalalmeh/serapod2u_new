import { splitSiteOrigin } from '@/lib/hosts/site-split'

/**
 * The app answers on both example.com and www.example.com. A sign-in has to finish on the host it
 * started on, because its cookies (PKCE verifier, OAuth state, session) belong to one host only.
 * Returns `origin` moved to `currentHost` when that host is its www / bare twin, otherwise `origin`.
 * On the store or portal address of an active split group, returns that address.
 */
export function sameHostOrigin(origin: string, currentHost: string | null | undefined) {
  const host = String(currentHost || '').trim().toLowerCase().split(':')[0]
  const split = splitSiteOrigin(host)
  if (split) return split
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return origin
  }
  if (!host || host === url.hostname) return url.origin
  const bare = url.hostname.replace(/^www\./, '')
  if (host !== bare && host !== `www.${bare}`) return url.origin
  url.hostname = host
  return url.origin
}
