import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isAdminUser } from '@/app/api/settings/whatsapp/_utils'
import { sendSmsWithActiveProvider, recordSmsDelivery } from '@/lib/notifications/sms-send'
import { normalizeManualPhone } from '@/lib/notifications/manualPhoneNumbers'
import { loadOrgSmsTemplateBody } from '@/lib/notifications/resolveSmsTemplate'
import {
  REQUIRED_NOTIFICATION_TYPES,
  SYSTEM_SMS_CHECK_EVENT,
  SYSTEM_SMS_CHECK_MESSAGE,
} from '@/lib/notifications/notificationEventCatalog'

async function requireAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  if (!await isAdminUser(supabase, user.id)) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }

  const { data: profile } = await supabase
    .from('users')
    .select('organization_id, phone')
    .eq('id', user.id)
    .single()
  if (!profile?.organization_id) {
    return { error: NextResponse.json({ error: 'Organization not found' }, { status: 404 }) }
  }

  return { supabase, user, profile }
}

export async function GET() {
  try {
    const auth = await requireAdmin()
    if ('error' in auth) return auth.error

    const admin = createAdminClient()
    const message = await loadOrgSmsTemplateBody(admin, auth.profile.organization_id, SYSTEM_SMS_CHECK_EVENT)
      || SYSTEM_SMS_CHECK_MESSAGE

    return NextResponse.json({
      event_code: SYSTEM_SMS_CHECK_EVENT,
      message,
    })
  } catch (error: any) {
    console.error('SMS check template error:', error)
    return NextResponse.json({ error: error.message || 'Failed to load SMS check message' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAdmin()
    if ('error' in auth) return auth.error
    const { user, profile } = auth

    const body = await request.json().catch(() => ({}))
    const requestedTo = typeof body?.to === 'string' ? body.to.trim() : ''
    const requestedMessage = typeof body?.message === 'string' ? body.message.trim() : ''
    const phone = normalizeManualPhone(requestedTo || profile.phone || '')
    if (!('normalized' in phone)) {
      return NextResponse.json({
        error: requestedTo
          ? `Invalid phone number: ${phone.reason}`
          : 'Enter a phone number to send the SMS check',
      }, { status: 400 })
    }

    const admin = createAdminClient()
    const message = requestedMessage
      || await loadOrgSmsTemplateBody(admin, profile.organization_id, SYSTEM_SMS_CHECK_EVENT)
      || SYSTEM_SMS_CHECK_MESSAGE
    if (!message) {
      return NextResponse.json({ error: 'SMS check message is empty' }, { status: 400 })
    }

    await (admin as any)
      .from('notification_types')
      .upsert(REQUIRED_NOTIFICATION_TYPES.filter((type) => type.event_code === SYSTEM_SMS_CHECK_EVENT), {
        onConflict: 'event_code',
      })

    const now = new Date().toISOString()
    const recentSince = new Date(Date.now() - 20_000).toISOString()
    const { data: recent } = await admin
      .from('notifications_outbox')
      .select('id, status, provider_message_id')
      .eq('org_id', profile.organization_id)
      .eq('event_code', SYSTEM_SMS_CHECK_EVENT)
      .eq('channel', 'sms')
      .eq('to_phone', phone.normalized)
      .gte('created_at', recentSince)
      .order('created_at', { ascending: false })
      .limit(1)

    if (recent?.[0]?.id) {
      return NextResponse.json({
        success: true,
        message: 'SMS check already sent',
        event_code: SYSTEM_SMS_CHECK_EVENT,
        outbox_id: recent[0].id,
        to: phone.normalized,
        provider_id: recent[0].provider_message_id || null,
      })
    }

    // Record first as sent (never queued) so the outbox worker cannot send a
    // second SMS, then call the gateway once.
    const { data: queued, error: queueError } = await admin
      .from('notifications_outbox')
      .insert({
        org_id: profile.organization_id,
        event_code: SYSTEM_SMS_CHECK_EVENT,
        channel: 'sms',
        to_phone: phone.normalized,
        to_email: null,
        template_code: null,
        payload_json: {
          checked_by: user.id,
          checked_at: now,
          _sms_body: message,
        },
        priority: 'high',
        provider_name: 'local_my',
        status: 'sent',
        sent_at: now,
        retry_count: 0,
        max_retries: 3,
      })
      .select('id')
      .single()

    if (queueError || !queued) {
      return NextResponse.json({
        error: queueError?.message || 'Failed to record SMS check event',
      }, { status: 500 })
    }

    const sent = await sendSmsWithActiveProvider(
      admin,
      profile.organization_id,
      phone.normalized,
      message,
    )

    await recordSmsDelivery(admin, {
      orgId: profile.organization_id,
      outboxId: queued.id,
      to: phone.normalized,
      eventCode: SYSTEM_SMS_CHECK_EVENT,
      result: sent,
    })

    if (!sent.success) {
      return NextResponse.json({
        error: sent.error || 'SMS check failed',
        event_code: SYSTEM_SMS_CHECK_EVENT,
        outbox_id: queued.id,
        data: sent.providerResponse,
      }, { status: 400 })
    }

    return NextResponse.json({
      success: true,
      message: 'SMS check sent via Local Malaysian Provider',
      event_code: SYSTEM_SMS_CHECK_EVENT,
      outbox_id: queued.id,
      to: phone.normalized,
      provider_id: sent.messageId || null,
    })
  } catch (error: any) {
    console.error('SMS check error:', error)
    return NextResponse.json({ error: error.message || 'SMS check failed' }, { status: 500 })
  }
}
