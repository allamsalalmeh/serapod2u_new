import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { callGateway, isAdminUser, isBaileysProvider } from '@/app/api/settings/whatsapp/_utils'
import { getWhatsAppProviderReadiness } from '@/lib/notifications/whatsapp-provider-readiness'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!await isAdminUser(supabase, user.id)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { data: profile } = await supabase.from('users').select('organization_id').eq('id', user.id).single()
  if (!profile?.organization_id) return NextResponse.json({ error: 'Organization not found' }, { status: 404 })

  const body = await request.json().catch(() => ({}))
  const providerName = typeof body.providerName === 'string' ? body.providerName.trim() : ''
  if (!providerName) return NextResponse.json({ error: 'Provider name is required' }, { status: 400 })

  const { data: provider, error: readError } = await supabase
    .from('notification_provider_configs')
    .select('id,provider_name,is_active,config_public,config_encrypted,last_test_status')
    .eq('org_id', profile.organization_id)
    .eq('channel', 'whatsapp')
    .eq('provider_name', providerName)
    .maybeSingle()

  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 })
  if (!provider) return NextResponse.json({ error: 'WhatsApp provider is not configured' }, { status: 400 })
  const publicConfig = (provider.config_public || {}) as Record<string, any>
  let secrets: Record<string, any> = {}
  try { secrets = typeof provider.config_encrypted === 'string' ? JSON.parse(provider.config_encrypted) : (provider.config_encrypted || {}) as Record<string, any> } catch { /* invalid secrets remain unconfigured */ }

  const configuredReadiness = getWhatsAppProviderReadiness({
    id: provider.id,
    providerName: provider.provider_name,
    isActive: provider.is_active ?? undefined,
    lastTestStatus: provider.last_test_status,
    publicConfig,
    sensitiveConfig: secrets,
  })
  if (!configuredReadiness.eligible) {
    return NextResponse.json({ error: configuredReadiness.reason }, { status: 400 })
  }

  if (provider.provider_name === 'whatsapp_business') {
    try {
      const response = await fetch(
        `https://graph.facebook.com/v23.0/${encodeURIComponent(String(publicConfig.phone_number_id))}?fields=id`,
        { headers: { Authorization: `Bearer ${String(secrets.access_token)}` }, cache: 'no-store' }
      )
      if (!response.ok) {
        return NextResponse.json({ error: 'The saved Meta API connection could not be verified. Test the connection and try again.' }, { status: 400 })
      }
    } catch {
      return NextResponse.json({ error: 'The saved Meta API connection could not be verified. Test the connection and try again.' }, { status: 400 })
    }
  } else if (isBaileysProvider(provider.provider_name)) {
    try {
      const gatewayStatus = await callGateway(
        String(publicConfig.base_url),
        String(secrets.api_key),
        'GET',
        '/status',
        undefined,
        String(publicConfig.tenant_id || 'serapod2u')
      )
      const connected = gatewayStatus?.state !== undefined
        ? gatewayStatus.state === 'open' && gatewayStatus.authenticated === true
        : gatewayStatus?.connected === true
      if (!connected) {
        return NextResponse.json({ error: 'Connect the Baileys WhatsApp session before setting this provider as default.' }, { status: 400 })
      }
    } catch {
      return NextResponse.json({ error: 'The Baileys gateway connection could not be verified. Connect the session and try again.' }, { status: 400 })
    }
  }

  const { error: setError } = await (supabase as any).rpc('set_default_whatsapp_provider', {
    p_org_id: profile.organization_id,
    p_provider_name: provider.provider_name,
  })
  if (setError) return NextResponse.json({ error: setError.message }, { status: 500 })

  return NextResponse.json({ success: true, providerName: provider.provider_name })
}
