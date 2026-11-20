import type { NextRequest } from 'next/server'
import { isOutdoorHost } from '@/lib/hosts/outdoor-hosts'
import { sameHostOrigin } from '@/lib/hosts/same-host'
import { splitSiteOrigin } from '@/lib/hosts/site-split'

/** A request that arrived on the Outdoor store host keeps that host, so sign-in and payment returns stay on it. */
function outdoorOriginFromRequest(request?: NextRequest) {
  if (!request) return null
  const host = (request.headers.get('x-forwarded-host') || request.headers.get('host') || '').split(',')[0]?.trim().split(':')[0]?.toLowerCase()
  if (!host || !isOutdoorHost(host) || host === 'outdoor.localhost') return null
  return `https://${host}`
}

export function publicOriginFromRequest(request?: NextRequest) {
  const outdoor = outdoorOriginFromRequest(request)
  if (outdoor) return outdoor
  if (request) {
    const split = splitSiteOrigin((request.headers.get('x-forwarded-host') || request.headers.get('host') || '').split(',')[0])
    if (split) return split
  }
  const env = String(process.env.NEXT_PUBLIC_APP_URL || '').trim().replace(/\/+$/, '')
  if (env && !/0\.0\.0\.0|127\.0\.0\.1/i.test(env)) return env
  if (request) {
    const xfHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
    const xfProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'https'
    if (xfHost && !/0\.0\.0\.0|127\.0\.0\.1/i.test(xfHost)) return `${xfProto}://${xfHost}`
    try {
      const url = new URL(request.url)
      if (!/0\.0\.0\.0|127\.0\.0\.1/i.test(url.hostname)) return url.origin
    } catch {
      // ignore
    }
  }
  return 'https://stg.serapod2u.com'
}

/** Public origin on the host this request came to, for sign-in flows that must end where they began. */
export function sameHostOriginFromRequest(request: NextRequest) {
  const host = (request.headers.get('x-forwarded-host') || request.headers.get('host') || '').split(',')[0]
  return sameHostOrigin(publicOriginFromRequest(request), host)
}
