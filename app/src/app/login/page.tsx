import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import type { Metadata } from 'next'
import LoginPageClient from '@/components/auth/LoginPageClient'
import { isStoreSiteHost, loginModeForHost } from '@/lib/hosts/site-split'
import { listLoginHeroBanners } from '@/lib/storefront/banners'
import { getStorageUrl } from '@/lib/utils'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers()
  const host = (requestHeaders.get('x-forwarded-host') || requestHeaders.get('host') || '').split(',')[0]
  return isStoreSiteHost(host) ? { title: 'Sign in | Serapod2U Store' } : {}
}

export default async function LoginPage() {
  // Load branding settings from HQ organization
  let branding = {
    logoUrl: null as string | null,
    loginTitle: 'Welcome to Serapod2U',
    loginSubtitle: 'Supply Chain Management System',
    copyrightText: '© 2025 Serapod2U. All rights reserved.'
  }

  const applyBranding = (data: any) => {
    if (!data) return
    const { logoUrl, loginTitle, loginSubtitle, copyrightText, updatedAt } = data as {
      logoUrl?: string | null; loginTitle?: string | null;
      loginSubtitle?: string | null; copyrightText?: string | null;
      updatedAt?: string | null;
    }
    if (loginTitle) branding.loginTitle = loginTitle
    if (loginSubtitle) branding.loginSubtitle = loginSubtitle
    if (copyrightText) branding.copyrightText = copyrightText
    if (logoUrl) {
      const trimmedLogo = logoUrl.trim()
      if (trimmedLogo) {
        const resolvedLogoUrl = getStorageUrl(trimmedLogo) || trimmedLogo

        if (/^https?:/i.test(resolvedLogoUrl)) {
          const version = updatedAt ? new Date(updatedAt).getTime() : Date.now()
          const parsedLogoUrl = new URL(resolvedLogoUrl)
          parsedLogoUrl.searchParams.set('t', String(version))
          branding.logoUrl = parsedLogoUrl.toString()
        } else {
          branding.logoUrl = resolvedLogoUrl
        }
      }
    }
  }

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (supabaseUrl && supabaseServiceKey) {
      const supabaseAdmin = createAdminClient(supabaseUrl, supabaseServiceKey)
      const { data: orgData, error: orgError } = await supabaseAdmin
        .from('organizations')
        .select('logo_url, settings, updated_at')
        .eq('org_type_code', 'HQ')
        .maybeSingle()

      if (!orgError && orgData) {
        const settings = (orgData.settings as any) || {}
        applyBranding({
          logoUrl: orgData.logo_url,
          loginTitle: settings.loginTitle,
          loginSubtitle: settings.loginSubtitle,
          copyrightText: settings.copyrightText,
          updatedAt: orgData.updated_at
        })
      }
    } else {
      const supabase = await createClient()
      const { data: brandingData } = await supabase.rpc('get_public_branding')
      applyBranding(brandingData)
    }
  } catch (error) {
    console.warn('Failed to load branding settings, using defaults:', error instanceof Error ? error.message : 'Unknown error')
  }

  // Fetch login hero banners
  let loginBanners: any[] = []
  try {
    loginBanners = await listLoginHeroBanners()
  } catch (err) {
    console.warn('Failed to load login banners:', err)
  }

  const requestHeaders = await headers()
  const hostMode = loginModeForHost((requestHeaders.get('x-forwarded-host') || requestHeaders.get('host') || '').split(',')[0])

  return (
    <LoginPageClient
      branding={branding}
      loginBanners={loginBanners}
      hostMode={hostMode}
    />
  )
}