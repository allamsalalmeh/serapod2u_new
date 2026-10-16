import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { resolvePortalHomePath } from '@/lib/serapp/access'
import { resolveMarketingHostRewrite } from '@/lib/hosts/site-hosts'
import {
  extractQRCodeFromPath,
  extractTokenFromQRCode,
  replaceTokenInQRCode,
  splitSecurityToken,
  writeSecurityMappingCookie
} from './src/utils/qrSecurity'

const QR_TRACK_PREFIX = "/track/product/";

/**
 * Handle QR security redirect for journeys that require security codes
 * Only redirects if journey has require_security_code = true
 * Keeps existing journeys unaffected (NON-BREAKING)
 */
async function handleQRSecurityRedirect(
  request: NextRequest
): Promise<NextResponse | null> {
  const pathname = request.nextUrl.pathname;

  const qrCode = extractQRCodeFromPath(pathname);
  if (!qrCode) return null; // not QR route

  const fullToken = extractTokenFromQRCode(qrCode);

  // 1) Lookup QR + journey to see if this order uses security
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get: () => undefined,
        set: () => undefined,
        remove: () => undefined
      }
    }
  );

  // Resolve whether this QR's journey requires a security code through a
  // narrow RPC (same resolution as before: order-linked active journey, then
  // the company's default/any active journey). Anonymous clients no longer
  // read qr_codes / journey tables directly. Unknown codes resolve to false.
  const { data: requiresSecurityCode, error } = await supabase.rpc(
    "get_qr_security_requirement",
    { p_code: qrCode }
  );

  if (error) {
    // DB problem → don't touch, let existing flow handle
    return null;
  }

  const requireSecurity = requiresSecurityCode === true;

  // If journey does NOT require security → do nothing, keep existing behaviour
  if (!requireSecurity) {
    return null;
  }

  // Already short? (no security code)
  const { publicToken, secretCode, hasSecurityCode } = splitSecurityToken(fullToken);
  if (!hasSecurityCode) {
    return null; // nothing to hide
  }

  // Build short QR code (same format, last segment replaced)
  const shortQRCode = replaceTokenInQRCode(qrCode, publicToken);

  // If already short (user came direct to short URL), no redirect needed
  if (shortQRCode === qrCode) {
    return null;
  }

  // Prepare redirect response
  const url = request.nextUrl.clone();
  url.pathname = QR_TRACK_PREFIX + encodeURIComponent(shortQRCode);

  const response = NextResponse.redirect(url, 302);

  // Save secretCode in cookie mapping for later Lucky Draw / Redeem checks
  writeSecurityMappingCookie(request, response, publicToken, secretCode);

  return response;
}

export async function middleware(request: NextRequest) {
  // 1) QR security redirect – may return a redirect response
  const qrRedirect = await handleQRSecurityRedirect(request);
  if (qrRedirect) return qrRedirect;

  // 2) Marketing hosts (serapod.com / outdoor.serapod2u.com) → isolated trees.
  // Default app hosts keep `/` → `/store` behaviour unchanged.
  const marketingRewrite = resolveMarketingHostRewrite(request)
  if (marketingRewrite) return marketingRewrite

  const pathname = request.nextUrl.pathname

  const isPublicRoadtourScanPath =
    /^\/roadtour\/\d{4}\//.test(pathname) ||
    /^\/rt\/\d{4}\//.test(pathname)

  // Public paths that don't require authentication
  const PUBLIC_PATHS = ['/', '/auth', '/verify', '/track', '/api/verify', '/api/consumer', '/api/scratch-card', '/app', '/api/journey/default', '/api/master-banner', '/store', '/cart', '/checkout', '/orders/success', '/orders/failed', '/api/storefront', '/lp', '/api/landing-pages/events', '/signup', '/api/export/ellbow', '/api/orders/from-ellbow', '/api/cron', '/api/auth/password-reset', '/api/auth/register', '/api/auth/oauth', '/api/outdoor/newsletter', '/api/outdoor/contact', '/api/outdoor/password-reset', '/api/outdoor/register', '/api/reference/search', '/api/shops/search', '/api/shops/locations', '/api/shops/prepare-registration', '/api/shops/contact-verification', '/api/health', '/scan', '/api/roadtour/claim-reward', '/api/roadtour/qr-image', '/event', '/api/event-management/public', '/api/support/whatsapp/ingest', '/api/webhooks/whatsapp/meta', '/api/webhooks/sms-gateway', '/api/telegram/webhook', '/privacy-policy', '/terms-of-service', '/data-deletion', '/help', '/outdoor', '/corporate', '/forgot-password', '/login']

  // Check if current path is public
  const isPublicPath = isPublicRoadtourScanPath || PUBLIC_PATHS.some((path) =>
    path === '/' ? request.nextUrl.pathname === '/' : request.nextUrl.pathname.startsWith(path)
  )

  // Allow public paths to proceed without auth check
  if (isPublicPath) {
    return NextResponse.next({
      request: {
        headers: request.headers,
      },
    })
  }

  let response = NextResponse.next({
    request: {
      headers: request.headers,
    },
  })

  // Add no-cache headers to prevent caching
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  response.headers.set('Pragma', 'no-cache')
  response.headers.set('Expires', '0')

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value
        },
        set(name: string, value: string, options: CookieOptions) {
          request.cookies.set({
            name,
            value,
            ...options,
          })
          response = NextResponse.next({
            request: {
              headers: request.headers,
            },
          })
          response.cookies.set({
            name,
            value,
            ...options,
          })
        },
        remove(name: string, options: CookieOptions) {
          request.cookies.set({
            name,
            value: '',
            ...options,
          })
          response = NextResponse.next({
            request: {
              headers: request.headers,
            },
          })
          response.cookies.set({
            name,
            value: '',
            ...options,
          })
        },
      },
    }
  )

  try {
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    // Debug logging
    if (user && request.nextUrl.pathname.startsWith('/dashboard')) {
      console.log('🔍 Middleware - User ID:', user.id)
      console.log('🔍 Middleware - User Email:', user.email)
    }

    // Handle authentication errors
    if (authError) {
      console.error('🔴 Auth Error in Middleware:', authError.message, authError.status)

      // Check for rate limit error
      if (authError.status === 429 || authError.message?.toLowerCase().includes('rate limit')) {
        console.error('⚠️ Rate limit reached - too many requests')
        // Don't redirect on rate limit, just continue
        // The session might still be valid
        if (request.nextUrl.pathname === '/login' || request.nextUrl.pathname === '/forgot-password') {
          return response // Allow access to login page
        }
      }

      // Handle token errors
      if (
        authError.message?.includes('refresh_token_not_found') ||
        authError.message?.includes('Invalid Refresh Token') ||
        authError.message?.includes('Refresh Token Not Found') ||
        authError.message?.includes('Token has expired') ||
        authError.status === 400
      ) {
        // Public API routes that don't require authentication
        const isPublicApi = request.nextUrl.pathname.startsWith('/api/auth/password-reset/') || request.nextUrl.pathname.startsWith('/api/auth/register/') || request.nextUrl.pathname.startsWith('/api/auth/oauth/') || request.nextUrl.pathname.startsWith('/api/outdoor/newsletter') || request.nextUrl.pathname.startsWith('/api/outdoor/contact') || request.nextUrl.pathname.startsWith('/api/outdoor/password-reset') || request.nextUrl.pathname.startsWith('/api/outdoor/register')

        // Return 401 for API routes instead of redirecting (except public ones)
        if (request.nextUrl.pathname.startsWith('/api/') && !isPublicApi) {
          return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        console.log('🔴 Invalid/expired token - clearing session and redirecting to login')

        // Only redirect if not already on login page
        if (request.nextUrl.pathname !== '/login' && request.nextUrl.pathname !== '/forgot-password') {
          response = NextResponse.redirect(new URL('/login', request.url))

          // Clear ALL session cookies
          const cookieNames = [
            'sb-access-token',
            'sb-refresh-token',
            `sb-${process.env.NEXT_PUBLIC_SUPABASE_URL?.split('//')[1]?.split('.')[0]}-auth-token`,
            `sb-${process.env.NEXT_PUBLIC_SUPABASE_URL?.split('//')[1]?.split('.')[0]}-auth-token-code-verifier`
          ]

          cookieNames.forEach(name => {
            if (name) {
              response.cookies.delete(name)
              request.cookies.delete(name)
            }
          })

          return response
        }
      }
    }

    // ── Business routes: /dashboard, /hr, /finance, /settings, /serapp, /supply-chain ──
    const BUSINESS_PREFIXES = ['/dashboard', '/hr', '/finance', '/settings', '/serapp', '/supply-chain']
    const isBusinessRoute = BUSINESS_PREFIXES.some(p =>
      request.nextUrl.pathname === p || request.nextUrl.pathname.startsWith(p + '/')
    )

    // No session on any business route → /login (preserve intended target).
    if (!user && isBusinessRoute) {
      const loginUrl = new URL('/login', request.url)
      const intended = `${request.nextUrl.pathname}${request.nextUrl.search || ''}`
      loginUrl.searchParams.set('next', intended)
      return NextResponse.redirect(loginUrl)
    }

    // Authenticated user on business route → check account_scope
    if (user && isBusinessRoute) {
      // Lightweight check: fetch account_scope + organization_id only
      const { data: scopeRow, error: scopeErr } = await supabase
        .from('users')
        .select('account_scope, organization_id')
        .eq('id', user.id)
        .maybeSingle()

      if (scopeErr) {
        console.error('🔴 Middleware scope check error:', scopeErr.message)
        // On error, allow through (don't break existing users midway)
      } else if (scopeRow) {
        const isPortal = scopeRow.account_scope === 'portal' && scopeRow.organization_id != null
        if (!isPortal) {
          // Non-portal user tried /dashboard → bounce to /store
          return NextResponse.redirect(new URL('/store', request.url))
        }
      }

      // Update last_login_at — fire and forget
      if (request.nextUrl.pathname.startsWith('/dashboard')) {
        supabase.rpc('update_last_login', { user_id: user.id }).then(({ error: updateError }) => {
          if (updateError) {
            console.error('🔍 Failed to update last_login_at:', updateError)
          }
        }, (error: unknown) => {
          console.error('🔍 Exception updating last_login_at:', error)
        })
      }
    }

    // Handle login redirect for authenticated users
    if (user && request.nextUrl.pathname === '/login') {
      const requestedNext = request.nextUrl.searchParams.get('next') || ''
      const isSafeNext = requestedNext.startsWith('/')
        && !requestedNext.startsWith('//')
        && !requestedNext.startsWith('/api/')

      const { data: profile } = await supabase
        .from('users')
        .select(`
          account_scope,
          organization_id,
          organizations:organization_id (
            org_type_code
          )
        `)
        .eq('id', user.id)
        .maybeSingle()

      if (profile?.account_scope === 'portal' && profile?.organization_id) {
        const org = Array.isArray(profile.organizations)
          ? profile.organizations[0]
          : profile.organizations
        const destination = isSafeNext
          ? requestedNext
          : resolvePortalHomePath({
              accountScope: profile.account_scope,
              orgTypeCode: org?.org_type_code,
              organizationId: profile.organization_id,
              roleLevel: null,
            })
        return NextResponse.redirect(new URL(destination, request.url))
      }
      // Non-portal users (storefront/consumer): let them through to /login
      // so they can access Business Login from the store page.
      // The login page will handle sign-out / account switching if needed.
    }

    // Portal users should not land on the consumer storefront after auth.
    if (user && request.nextUrl.pathname === '/store') {
      const { data: profile } = await supabase
        .from('users')
        .select(`
          account_scope,
          organization_id,
          organizations:organization_id (
            org_type_code
          )
        `)
        .eq('id', user.id)
        .maybeSingle()

      if (profile?.account_scope === 'portal' && profile?.organization_id) {
        const org = Array.isArray(profile.organizations)
          ? profile.organizations[0]
          : profile.organizations
        const destination = resolvePortalHomePath({
          accountScope: profile.account_scope,
          orgTypeCode: org?.org_type_code,
          organizationId: profile.organization_id,
          roleLevel: null,
        })
        return NextResponse.redirect(new URL(destination, request.url))
      }
    }
  } catch (error) {
    console.error('Middleware error:', error)
    // On error, redirect to login for protected routes
    if (request.nextUrl.pathname.startsWith('/dashboard')) {
      return NextResponse.redirect(new URL('/login', request.url))
    }
  }

  return response
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - images, icons, brand, sounds (public static assets — must stay
     *   reachable without auth; otherwise <img src="/brand/..."> gets a
     *   307 → /login HTML response and renders as a broken image)
     */
    '/((?!_next/static|_next/image|favicon.ico|images/|icons/|brand/|sounds/|manifest\\.json|sw\\.js|hr-sw\\.js|serapp-manifest\\.json|serapp-sw\\.js|serapp/sw\\.js).*)',
  ],
}