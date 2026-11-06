import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { issueAffiliateRefToken } from '@/lib/affiliate/ref-token'
import { normalizeSubId } from '@/lib/affiliate/program'
import { normalizeAffiliateCode } from '@/lib/outdoor/sales-tools'

export const dynamic = 'force-dynamic'

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

/** Turns a public ?ref= click into a short, server-signed checkout claim. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const code = normalizeAffiliateCode(body?.code)
    if (!code) return json({ error: 'Invalid referral link.' }, 400)

    const admin: any = createAdminClient()
    const { data, error } = await admin
      .from('outdoor_affiliates')
      .select('code')
      .eq('code', code)
      .eq('is_active', true)
      .maybeSingle()
    if (error) {
      console.error('[affiliate/ref] lookup', error)
      return json({ error: 'Referral service temporarily unavailable.' }, 503)
    }
    if (!data) return json({ error: 'Referral link is not active.' }, 404)

    const issued = issueAffiliateRefToken(data.code, normalizeSubId(body?.sub))
    if (!issued) {
      console.error('[affiliate/ref] no strong signing secret configured')
      return json({ error: 'Referral service temporarily unavailable.' }, 503)
    }
    return json({ token: issued.token, code: issued.claims.code, sub: issued.claims.sub, issuedAt: issued.claims.issuedAt })
  } catch (error) {
    console.error('[affiliate/ref]', error)
    return json({ error: 'Referral service temporarily unavailable.' }, 503)
  }
}
