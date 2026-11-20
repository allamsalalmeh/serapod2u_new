import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { ensureUserRow } from '@/server/auth/ensureUserRow'
import { getPostLoginRedirect } from '@/server/auth/getPostLoginRedirect'
import { createAdminClient } from '@/lib/supabase/admin'
import { requestAuthCookieOptions } from '@/lib/supabase/server'
import { OUTDOOR_OAUTH_NEXT_COOKIE, sanitizeOutdoorReturnPath } from '@/lib/outdoor/auth-return'
import { sameHostOriginFromRequest } from '@/lib/http/public-origin'

export const dynamic = 'force-dynamic'

// ── Portal email domains ─────────────────────────────────────────
const PORTAL_EMAIL_DOMAINS = ['serapod.com', 'serapod2u.com']

/**
 * OAuth callback handler for social login (Google, Facebook).
 * Supabase redirects here after the user authenticates with the provider.
 *
 * Flow:
 *   1. Exchange auth code for session
 *   2. Ensure public.users row exists (via centralized ensureUserRow)
 *   3. Redirect based on account_scope (single redirect path)
 */
export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url)
  const code = requestUrl.searchParams.get('code')
  const errorParam = requestUrl.searchParams.get('error')
  const errorDescription = requestUrl.searchParams.get('error_description')
  const rawNext = requestUrl.searchParams.get('next') || request.cookies.get(OUTDOOR_OAUTH_NEXT_COOKIE)?.value || null
  const nextPath = rawNext?.startsWith('/outdoor') ? sanitizeOutdoorReturnPath(rawNext) : rawNext
  const origin = sameHostOriginFromRequest(request)
  const failLoginPath = nextPath?.startsWith('/outdoor') ? '/outdoor/login' : '/login'
  const successRedirect = (path: string) => {
    const res = NextResponse.redirect(new URL(path, origin))
    res.cookies.set(OUTDOOR_OAUTH_NEXT_COOKIE, '', { path: '/', maxAge: 0 })
    return res
  }
  const failRedirect = (errorCode: string, message?: string) => {
    const url = new URL(failLoginPath, origin)
    url.searchParams.set('error', errorCode)
    if (message) url.searchParams.set('message', message)
    if (nextPath?.startsWith('/outdoor')) url.searchParams.set('next', nextPath)
    return NextResponse.redirect(url)
  }

  if (errorParam) {
    console.error('[auth/callback] OAuth error:', errorParam, errorDescription)
    return failRedirect('oauth_failed', errorDescription || errorParam)
  }

  if (!code) {
    console.error('[auth/callback] No code parameter received')
    return failRedirect('no_code')
  }

  try {
    const cookieStore = await cookies()

    // Create server-side Supabase client with cookie handling
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        ...(await requestAuthCookieOptions()),
        cookies: {
          get(name: string) {
            return cookieStore.get(name)?.value
          },
          set(name: string, value: string, options: CookieOptions) {
            try { cookieStore.set({ name, value, ...options }) } catch {}
          },
          remove(name: string, options: CookieOptions) {
            try { cookieStore.set({ name, value: '', ...options }) } catch {}
          },
        },
      }
    )

    // 1. Exchange the code for a session
    const { data: sessionData, error: sessionError } = await supabase.auth.exchangeCodeForSession(code)

    if (sessionError) {
      console.error('[auth/callback] Session exchange error:', sessionError.message)
      return failRedirect('session_failed', sessionError.message)
    }

    const user = sessionData?.user
    if (!user) {
      console.error('[auth/callback] No user after session exchange')
      return failRedirect('no_user')
    }

    // 2. Determine provider info
    const provider = user.app_metadata?.provider || 'email'
    const fullName = user.user_metadata?.full_name || user.user_metadata?.name || ''
    const avatarUrl = user.user_metadata?.avatar_url || user.user_metadata?.picture || ''
    const email = user.email || ''
    const phone = user.phone || ''

    console.log(`[auth/callback] User authenticated: ${email} via ${provider}`)

    // 3. Ensure public.users row exists (centralized logic)
    const { user: ensuredUser, wasCreated, warnings } = await ensureUserRow(
      user.id,
      email,
      { fullName, avatarUrl, provider, phone: phone || undefined }
    )

    if (warnings.length > 0) {
      console.warn('[auth/callback] ensureUserRow warnings:', warnings)
    }

    if (wasCreated) {
      console.log(`[auth/callback] New user row created for ${email}, scope=${ensuredUser.account_scope}`)

      // If new store user needs phone, still honour Outdoor/Store return path when provided
      if (ensuredUser.account_scope === 'store' && !phone) {
        const welcomeBase =
          nextPath && nextPath.startsWith('/') && !nextPath.startsWith('//')
            ? nextPath
            : '/store'
        const welcomeUrl = new URL(welcomeBase, origin)
        welcomeUrl.searchParams.set('welcome', 'true')
        const welcomeRes = NextResponse.redirect(welcomeUrl)
        welcomeRes.cookies.set(OUTDOOR_OAUTH_NEXT_COOKIE, '', { path: '/', maxAge: 0 })
        return welcomeRes
      }
    } else {
      // Existing user — update avatar & last_login
      try {
        const admin = createAdminClient()
        await admin
          .from('users')
          .update({
            avatar_url: avatarUrl || undefined,
            auth_provider: provider,
            last_login_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', user.id)
      } catch (err) {
        console.warn('[auth/callback] Profile update error:', err)
      }
    }

    // 4. Redirect based on account_scope (honour ?next= for Outdoor/Store return)
    const { redirectTo } = await getPostLoginRedirect(nextPath)
    return successRedirect(redirectTo)
  } catch (error) {
    console.error('[auth/callback] Unexpected error:', error)
    return failRedirect('unexpected')
  }
}
