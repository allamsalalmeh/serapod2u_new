import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'
import { requestAuthCookieOptions } from '@/lib/supabase/server'
import { ensureUserRow } from '@/server/auth/ensureUserRow'
import { getPostLoginRedirect } from '@/server/auth/getPostLoginRedirect'
import { syntheticSocialEmail } from '@/lib/auth/social-oauth'

export async function createSessionForSocialProfile(profile: {
  provider: string
  providerUserId: string
  email?: string | null
  username?: string
  fullName?: string
  avatarUrl?: string
}) {
  const admin = createAdminClient()
  const email = profile.email?.trim() || syntheticSocialEmail(profile.provider, profile.providerUserId)
  const username = String(profile.username || '').replace(/^@/, '').trim()
  const metadata = {
    full_name: profile.fullName || '',
    username,
    avatar_url: profile.avatarUrl || '',
    auth_provider: profile.provider,
    [`${profile.provider}_id`]: profile.providerUserId,
  }

  const created = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: metadata,
  })
  if (created.error && !/already|registered|exists/i.test(created.error.message || '')) {
    throw new Error(created.error.message)
  }

  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  const hashedToken = link?.properties?.hashed_token
  if (linkError || !hashedToken) {
    throw new Error(linkError?.message || 'Could not start a session')
  }

  const cookieStore = await cookies()
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
    },
  )

  const { data: sessionData, error: otpError } = await supabase.auth.verifyOtp({
    type: 'magiclink',
    token_hash: hashedToken,
  })
  if (otpError || !sessionData.user) {
    throw new Error(otpError?.message || 'Could not verify social login')
  }

  await admin.auth.admin.updateUserById(sessionData.user.id, {
    user_metadata: {
      ...sessionData.user.user_metadata,
      ...metadata,
    },
  })

  await ensureUserRow(sessionData.user.id, sessionData.user.email || email, {
    fullName: profile.fullName,
    avatarUrl: profile.avatarUrl,
    provider: profile.provider,
  })

  return { user: sessionData.user, email }
}

export async function socialPostLoginPath(nextPath?: string | null) {
  const { redirectTo } = await getPostLoginRedirect(nextPath)
  return redirectTo
}
