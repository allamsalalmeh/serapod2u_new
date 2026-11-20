import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies, headers } from 'next/headers'
import { Database } from '@/types/database'
import { authCookieOptionsForHost } from '@/lib/supabase/auth-cookie-scope'

/** This request's host, as the middleware reads it. */
export async function requestHostname() {
  try {
    const h = await headers()
    const raw = h.get('x-forwarded-host') || h.get('host') || ''
    return raw.split(',')[0]?.trim().split(':')[0]?.toLowerCase() || ''
  } catch {
    return ''
  }
}

/** Cookie name/domain for Supabase clients built in this request (shared shopper login on split hosts). */
export async function requestAuthCookieOptions() {
  return authCookieOptionsForHost(await requestHostname())
}

export async function createClient() {
  const cookieStore = await cookies()
  const cookieScope = await requestAuthCookieOptions()

  // Get environment variables with validation
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  // Log environment for debugging (only in development or when debugging)
  if (process.env.NODE_ENV !== 'production' || process.env.DEBUG_SUPABASE) {
    console.log('[Supabase Server] URL:', supabaseUrl?.substring(0, 30) + '...')
  }

  // Validate environment variables are present
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'Missing Supabase environment variables. ' +
      'Please ensure NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are set.'
    )
  }

  return createServerClient<Database>(
    supabaseUrl,
    supabaseAnonKey,
    {
      ...cookieScope,
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value
        },
        set(name: string, value: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value, ...options })
          } catch (error) {
            // The `set` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
        remove(name: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value: '', ...options })
          } catch (error) {
            // The `delete` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    }
  )
}