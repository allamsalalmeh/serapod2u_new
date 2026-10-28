import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import SignupPageClient from '@/components/auth/SignupPageClient'
import { listLoginHeroBanners } from '@/lib/storefront/banners'
import { headers } from 'next/headers'
import type { Metadata } from 'next'
import { isStoreSiteHost } from '@/lib/hosts/site-split'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers()
  const host = (requestHeaders.get('x-forwarded-host') || requestHeaders.get('host') || '').split(',')[0]
  return isStoreSiteHost(host) ? { title: 'Create account | Serapod2U Store' } : {}
}

export default async function SignupPage() {
  let branding = {
    logoUrl: null as string | null,
    loginTitle: 'Welcome to Serapod2U',
    loginSubtitle: 'Supply Chain Management System',
    copyrightText: '© 2025 Serapod2U. All rights reserved.'
  }

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (supabaseUrl && supabaseServiceKey) {
      const supabaseAdmin = createAdminClient(supabaseUrl, supabaseServiceKey)
      const { data: orgData } = await supabaseAdmin
        .from('organizations')
        .select('logo_url, settings, updated_at')
        .eq('org_type_code', 'HQ')
        .maybeSingle()

      if (orgData) {
        const settings = (orgData.settings as any) || {}
        if (settings.loginTitle) branding.loginTitle = settings.loginTitle
        if (settings.loginSubtitle) branding.loginSubtitle = settings.loginSubtitle
        if (settings.copyrightText) branding.copyrightText = settings.copyrightText
        if (orgData.logo_url) {
          const v = orgData.updated_at ? new Date(orgData.updated_at).getTime() : Date.now()
          branding.logoUrl = `${orgData.logo_url.split('?')[0]}?t=${v}`
        }
      }
    }
  } catch (error) {
    console.warn('Failed to load branding:', error)
  }

  let loginBanners: any[] = []
  try {
    loginBanners = await listLoginHeroBanners()
  } catch {}

  return <SignupPageClient branding={branding} loginBanners={loginBanners} />
}
