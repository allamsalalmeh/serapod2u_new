import { guardUserOperation } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { canViewSmsMonitor } from '@/lib/notifications/smsMonitorAccess'
import { LEGACY_LIMIT, loadSmsMessages } from '@/lib/notifications/monitor/channelLoaders'
import { canViewMonitor, loadMonitorViewer, resolveMonitorScope } from '@/lib/notifications/monitorScope'

export const dynamic = 'force-dynamic'

export type { SmsMonitorStatus } from '@/lib/notifications/monitor/channelLoaders'

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export async function GET(_request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const saDenied = await guardUserOperation(user.id, 'platform.settings.manage')
    if (saDenied) return saDenied
    if (!await canViewSmsMonitor(supabase, user.id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const admin = createAdminClient()
    const viewer = await loadMonitorViewer(admin, user.id)
    if (!viewer || !canViewMonitor(viewer)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    // HQ staff oversee every organization; everyone else sees only their own.
    const scope = resolveMonitorScope(viewer)
    // Never calls the SMS gateway: this reads what the outbox worker last wrote,
    // so the page stays fast even when the gateway is unreachable.
    const { messages } = await loadSmsMessages(admin, scope, { limit: LEGACY_LIMIT })

    const kpis = {
      pending: messages.filter((row) => row.status === 'pending').length,
      sent: messages.filter((row) => row.status === 'sent').length,
      delivered: messages.filter((row) => row.status === 'delivered').length,
      failed: messages.filter((row) => row.status === 'failed').length,
      total: messages.length,
    }
    return NextResponse.json({ success: true, kpis, messages })
  } catch (error: any) {
    console.error('[sms-activity]', error)
    return NextResponse.json({ error: error.message || 'Failed to load SMS activity' }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const saDenied = await guardUserOperation(user.id, 'platform.settings.manage')
    if (saDenied) return saDenied
    if (!await canViewSmsMonitor(supabase, user.id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const source = asString(body.source)
    const id = asString(body.id)
    if (!id) {
      return NextResponse.json({ error: 'Message id is required' }, { status: 400 })
    }
    const outboxId = asString(body.outboxId) || (source === 'outbox' ? id : '')
    const eventCode = asString(body.eventCode) || 'sms_edit'
    const message = asString(body.message)
    const send = Boolean(body.send)

    const { normalizeManualPhone } = await import('@/lib/notifications/manualPhoneNumbers')
    const phone = normalizeManualPhone(asString(body.phone))
    if (!('normalized' in phone)) {
      return NextResponse.json({ error: `Invalid phone number${phone.reason ? `: ${phone.reason}` : ''}` }, { status: 400 })
    }
    if (send && !message) {
      return NextResponse.json({ error: 'Message text is required to send' }, { status: 400 })
    }

    const admin = createAdminClient()
    const { data: profile } = await admin
      .from('users')
      .select('organization_id')
      .eq('id', user.id)
      .single()
    const orgId = profile?.organization_id
    if (!orgId) return NextResponse.json({ error: 'Organization not found' }, { status: 404 })

    const { sendSmsWithActiveProvider, recordSmsDelivery } = await import('@/lib/notifications/sms-send')

    let targetOutboxId = outboxId || null
    let resolvedEvent = eventCode

    if (targetOutboxId) {
      const { data: outbox } = await admin
        .from('notifications_outbox')
        .select('id, event_code, payload_json, status')
        .eq('id', targetOutboxId)
        .maybeSingle()

      if (outbox) {
        resolvedEvent = asString(outbox.event_code) || resolvedEvent
        const payload = {
          ...((outbox.payload_json && typeof outbox.payload_json === 'object' && !Array.isArray(outbox.payload_json))
            ? outbox.payload_json as Record<string, unknown>
            : {}),
          _sms_body: message,
          customer_phone: phone.normalized,
        }
        const outboxUpdate: Record<string, unknown> = {
          to_phone: phone.normalized,
          payload_json: payload,
        }
        if (send) outboxUpdate.error = null
        await admin.from('notifications_outbox').update(outboxUpdate).eq('id', targetOutboxId)
      }
    }

    if (source === 'log' && id) {
      await admin.from('notification_logs').update({
        recipient_value: phone.normalized,
      }).eq('id', id)
    }

    if (!send) {
      return NextResponse.json({ success: true, saved: true, to: phone.normalized, outbox_id: targetOutboxId })
    }

    if (targetOutboxId) {
      // Claim the row so the outbox worker cannot send it a second time.
      await admin.from('notifications_outbox').update({
        status: 'sent',
        error: null,
        to_phone: phone.normalized,
      }).eq('id', targetOutboxId)
    }

    const sent = await sendSmsWithActiveProvider(admin, orgId, phone.normalized, message)

    if (!targetOutboxId) {
      const now = new Date().toISOString()
      const { data: queued, error: queueError } = await admin
        .from('notifications_outbox')
        .insert({
          org_id: orgId,
          event_code: resolvedEvent,
          channel: 'sms',
          to_phone: phone.normalized,
          payload_json: { _sms_body: message, customer_phone: phone.normalized, edited_from: id },
          priority: 'high',
          provider_name: 'local_my',
          provider_message_id: sent.messageId || null,
          status: sent.success ? 'sent' : 'failed',
          sent_at: sent.success ? now : null,
          error: sent.success ? null : (sent.error || 'SMS send failed'),
          retry_count: 0,
          max_retries: 3,
        })
        .select('id')
        .single()
      if (queueError || !queued) {
        return NextResponse.json({ error: queueError?.message || 'Failed to record SMS' }, { status: 500 })
      }
      targetOutboxId = queued.id
    }

    await recordSmsDelivery(admin, {
      orgId,
      outboxId: targetOutboxId,
      to: phone.normalized,
      eventCode: resolvedEvent,
      result: sent,
    })

    if (!sent.success) {
      return NextResponse.json({
        error: sent.error || 'SMS send failed',
        outbox_id: targetOutboxId,
        to: phone.normalized,
      }, { status: 400 })
    }

    return NextResponse.json({
      success: true,
      sent: true,
      to: phone.normalized,
      outbox_id: targetOutboxId,
      provider_id: sent.messageId || null,
    })
  } catch (error: any) {
    console.error('[sms-activity:edit]', error)
    return NextResponse.json({ error: error.message || 'Failed to edit SMS' }, { status: 500 })
  }
}

