import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { extractOrderRef } from '@/lib/notifications/orderRef'
import { canViewSmsMonitor } from '@/lib/notifications/smsMonitorAccess'
import {
  canViewMonitor,
  loadMonitorViewer,
  resolveMonitorScope,
  type MonitorScope,
} from '@/lib/notifications/monitorScope'

export const dynamic = 'force-dynamic'

export type SmsMonitorStatus = 'pending' | 'sent' | 'delivered' | 'failed'

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function toMonitorStatus(raw: string): SmsMonitorStatus {
  const status = raw.toLowerCase()
  if (['failed', 'error', 'cancelled', 'canceled', 'undelivered', 'rejected', 'bounced'].includes(status)) {
    return 'failed'
  }
  if (['delivered', 'success', 'completed'].includes(status)) {
    return 'delivered'
  }
  if (['sent', 'accepted', 'processed'].includes(status)) {
    return 'sent'
  }
  return 'pending'
}

function truncate(value: unknown, max = 2000): string | null {
  if (value == null) return null
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (!text) return null
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function orderFields(payload: unknown) {
  const ref = extractOrderRef(payload)
  return { orderId: ref.orderId, orderNo: ref.orderNo }
}

function payloadMessage(payload: unknown, eventCode?: string): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const row = payload as Record<string, unknown>
    const stored = asString(row._sms_body) || asString(row.message) || asString(row.message_body)
    if (stored) return stored
  }
  if (eventCode === 'system_sms_check') {
    return 'Serapod2U SMS check. If you received this, Local Malaysian SMS is working.'
  }
  return ''
}

async function orgNamesById(admin: any, orgIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (!orgIds.length) return names
  const { data } = await admin
    .from('organizations')
    .select('id, org_name')
    .in('id', orgIds)
  for (const row of data || []) if (row?.id) names.set(row.id, asString(row.org_name))
  return names
}

export async function GET(_request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const admin = createAdminClient()
    const viewer = await loadMonitorViewer(admin, user.id)
    if (!viewer || !canViewMonitor(viewer)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // HQ staff oversee every organization; everyone else sees only their own.
    const scope: MonitorScope = resolveMonitorScope(viewer)
    if (scope.kind === 'orgs' && scope.orgIds.length === 0) {
      return NextResponse.json({
        success: true,
        kpis: { pending: 0, sent: 0, delivered: 0, failed: 0, total: 0 },
        messages: [],
      })
    }

    // NOTE: Do NOT call refreshOpenSmsStatuses() here. This route must always return the
    // page's data straight from the database, independent of the local SMS gateway's
    // availability. The gateway can be unreachable (e.g. an expired trycloudflare tunnel),
    // and refreshOpenSmsStatuses() checks each open message sequentially with a 15s timeout
    // per message -- with the gateway down that blocked this endpoint for minutes while the
    // UI sat on "Loading SMS messages...".
    //
    // Status refresh already runs safely in the background via
    // app/api/cron/notification-outbox-worker/route.ts (refreshOpenSmsStatuses call there is
    // wrapped in .catch() and doesn't block anything else). This page just reads whatever
    // that worker last wrote, so it stays fast no matter what the gateway is doing.

    let logsQuery = admin
      .from('notification_logs')
      .select('id, org_id, created_at, queued_at, sent_at, delivered_at, failed_at, status, recipient_value, recipient_type, event_code, provider_name, provider_message_id, error_message, retry_count, provider_response, outbox_id')
      .eq('channel', 'sms')
      .order('created_at', { ascending: false })
      .limit(500)

    let outboxQuery = admin
      .from('notifications_outbox')
      .select('id, org_id, created_at, scheduled_for, sent_at, status, to_phone, event_code, provider_name, provider_message_id, error, retry_count, max_retries, payload_json, template_code, priority')
      .eq('channel', 'sms')
      .order('created_at', { ascending: false })
      .limit(500)

    if (scope.kind === 'orgs') {
      logsQuery = logsQuery.in('org_id', scope.orgIds)
      outboxQuery = outboxQuery.in('org_id', scope.orgIds)
    }

    const [logsRes, outboxRes] = await Promise.all([logsQuery, outboxQuery])

    if (logsRes.error) return NextResponse.json({ error: logsRes.error.message }, { status: 500 })
    if (outboxRes.error) return NextResponse.json({ error: outboxRes.error.message }, { status: 500 })

    const outboxById = new Map((outboxRes.data || []).map((row: any) => [row.id, row]))
    const missingOutboxIds = Array.from(new Set(
      (logsRes.data || [])
        .map((log: any) => log.outbox_id)
        .filter((id: string | null) => id && !outboxById.has(id)),
    ))
    if (missingOutboxIds.length > 0) {
      const { data: extraOutbox } = await admin
        .from('notifications_outbox')
        .select('id, org_id, created_at, scheduled_for, sent_at, status, to_phone, event_code, provider_name, provider_message_id, error, retry_count, max_retries, payload_json, template_code, priority')
        .in('id', missingOutboxIds)
      for (const row of extraOutbox || []) outboxById.set(row.id, row)
    }
    const loggedOutboxIds = new Set<string>()
    const messages = []

    for (const log of logsRes.data || []) {
      if (log.outbox_id && loggedOutboxIds.has(log.outbox_id)) continue
      const outbox = log.outbox_id ? outboxById.get(log.outbox_id) : null
      if (log.outbox_id) loggedOutboxIds.add(log.outbox_id)
      const rawStatus = asString(log.status) || asString(outbox?.status)
      messages.push({
        id: log.id,
        source: 'log',
        outboxId: log.outbox_id || null,
        orgId: asString(log.org_id) || asString(outbox?.org_id) || null,
        createdAt: log.created_at || log.queued_at || outbox?.created_at || null,
        queuedAt: log.queued_at || outbox?.created_at || null,
        sentAt: log.sent_at || outbox?.sent_at || null,
        deliveredAt: log.delivered_at || (toMonitorStatus(rawStatus) === 'delivered' ? log.sent_at : null),
        failedAt: log.failed_at || null,
        status: toMonitorStatus(rawStatus),
        rawStatus,
        phone: asString(log.recipient_value) || asString(outbox?.to_phone) || null,
        eventCode: asString(log.event_code) || asString(outbox?.event_code) || null,
        providerName: asString(log.provider_name) || asString(outbox?.provider_name) || 'local_my',
        providerMessageId: asString(log.provider_message_id) || asString(outbox?.provider_message_id) || null,
        errorMessage: asString(log.error_message) || asString(outbox?.error) || null,
        errorCode: null,
        retryCount: Number(log.retry_count ?? outbox?.retry_count ?? 0),
        maxRetries: outbox?.max_retries != null ? Number(outbox.max_retries) : null,
        templateCode: asString(outbox?.template_code) || null,
        priority: asString(outbox?.priority) || null,
        payload: outbox?.payload_json || null,
        messageBody: payloadMessage(outbox?.payload_json, asString(log.event_code) || asString(outbox?.event_code)),
        ...orderFields(outbox?.payload_json),
        providerResponse: log.provider_response || null,
        statusDetails: truncate(log.provider_response),
      })
    }

    for (const outbox of outboxRes.data || []) {
      if (loggedOutboxIds.has(outbox.id)) continue
      const rawStatus = asString(outbox.status)
      messages.push({
        id: outbox.id,
        source: 'outbox',
        outboxId: outbox.id,
        orgId: asString(outbox.org_id) || null,
        createdAt: outbox.created_at || null,
        queuedAt: outbox.created_at || outbox.scheduled_for || null,
        sentAt: outbox.sent_at || null,
        deliveredAt: toMonitorStatus(rawStatus) === 'delivered' ? outbox.sent_at : null,
        failedAt: toMonitorStatus(rawStatus) === 'failed' ? outbox.sent_at || outbox.created_at : null,
        status: toMonitorStatus(rawStatus),
        rawStatus,
        phone: asString(outbox.to_phone) || null,
        eventCode: asString(outbox.event_code) || null,
        providerName: asString(outbox.provider_name) || 'local_my',
        providerMessageId: asString(outbox.provider_message_id) || null,
        errorMessage: asString(outbox.error) || null,
        errorCode: null,
        retryCount: Number(outbox.retry_count || 0),
        maxRetries: outbox.max_retries != null ? Number(outbox.max_retries) : null,
        templateCode: asString(outbox.template_code) || null,
        priority: asString(outbox.priority) || null,
        payload: outbox.payload_json || null,
        messageBody: payloadMessage(outbox.payload_json, asString(outbox.event_code)),
        ...orderFields(outbox.payload_json),
        providerResponse: null,
        statusDetails: null,
      })
    }

    messages.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))

    // HQ sees several organizations at once, so each row has to say whose it is.
    const names = await orgNamesById(admin, Array.from(new Set(
      messages.map((row) => row.orgId).filter((id): id is string => Boolean(id)),
    )))
    for (const row of messages) {
      (row as Record<string, unknown>).orgName = row.orgId ? names.get(row.orgId) || null : null
    }

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

