import { Suspense } from 'react'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import ForgotPasswordPageClient from '@/components/auth/ForgotPasswordPageClient'
import { asJsonObject } from '@/lib/supabase/json'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function ForgotPasswordPage() {
  let branding = {
    copyrightText: '© 2025 Serapod2U. All rights reserved.',
  }

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (supabaseUrl && supabaseServiceKey) {
      const supabaseAdmin = createAdminClient(supabaseUrl, supabaseServiceKey)
      const { data: orgData } = await supabaseAdmin
        .from('organizations')
        .select('settings')
        .eq('org_type_code', 'HQ')
        .maybeSingle()
      const settings = (orgData?.settings as any) || {}
      if (settings.copyrightText) branding.copyrightText = settings.copyrightText
    } else {
      const supabase = await createClient()
      const { data: brandingData } = await supabase.rpc('get_public_branding')
      // copyrightText comes from settings->>'copyrightText': text or null.
      const copyrightText = asJsonObject(brandingData).copyrightText
      if (typeof copyrightText === 'string' && copyrightText) branding.copyrightText = copyrightText
    }
  } catch {
    // keep defaults
  }

  return (
    <Suspense>
      <ForgotPasswordPageClient branding={branding} />
    </Suspense>
  )
}
