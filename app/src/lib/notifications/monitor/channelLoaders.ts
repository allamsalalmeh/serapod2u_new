/**
 * Notification Monitor — per-channel loaders (server only, admin client).
 *
 * Each loader is the row-building logic its channel's activity endpoint has
 * always used, moved here so the legacy endpoints and the unified Monitor
 * share one implementation. The only addition is that the date range and a
 * per-source cap are applied in the database, so filtering covers the whole
 * range instead of only the latest few hundred rows.
 */
import { emailProviderBlockedByUiTest } from '@/lib/notifications/emailProviderReady'
import {
    emailOrderFields,
    extractEmailBody,
    extractEmailReceiver,
    extractEmailSubject,
    overlayEmailStatusForFailedProvider,
    passwordResetEventAlreadyLogged,
    toEmailMonitorStatus,
} from '@/lib/notifications/emailActivity'
import type { MonitorScope } from '@/lib/notifications/monitorScope'
import { extractOrderRef, type NotificationOrderRef } from '@/lib/notifications/orderRef'
import { isMonitoringDismissed, normalizeActivityMetadata, RECOVERY_PURPOSES } from '@/lib/wa-recovery/activity-status'
import { resolveRecoveryContacts } from '@/lib/wa-recovery/contact-resolver'
import { loadRecoveryTemplates, pickRecoveryTemplate } from '@/lib/wa-recovery/template-store'
import { buildRecoveryMessageVariables, renderTemplate } from '@/lib/wa-recovery/templates'
import { normalizePhoneE164 } from '@/utils/phone'
import {
    normalizeWhatsAppStatus,
    referenceFrom,
    type MonitorRecord,
} from './monitorCore'

export interface LoadWindow {
    sinceIso?: string
    untilIso?: string
    /** Max rows per source query. */
    limit: number
}

/** Legacy endpoints keep their original "latest 500" behavior. */
export const LEGACY_LIMIT = 500
/** Monitor: per source, inside the selected date range. */
export const MONITOR_SOURCE_LIMIT = 2000

function windowed<T>(query: any, window: LoadWindow, column = 'created_at'): T {
    let q = query
    if (window.sinceIso) q = q.gte(column, window.sinceIso)
    if (window.untilIso) q = q.lte(column, window.untilIso)
    return q.order(column, { ascending: false }).limit(window.limit)
}

const hitLimit = (rows: unknown[] | null | undefined, window: LoadWindow) => (rows?.length || 0) >= window.limit

function asString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

function truncate(value: unknown, max = 2000): string | null {
    if (value == null) return null
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (!text) return null
    return text.length > max ? `${text.slice(0, max)}…` : text
}

// ---------------------------------------------------------------------------
// SMS

export type SmsMonitorStatus = 'pending' | 'sent' | 'delivered' | 'failed'

export function toSmsMonitorStatus(raw: string): SmsMonitorStatus {
    const status = raw.toLowerCase()
    if (['failed', 'error', 'cancelled', 'canceled', 'undelivered', 'rejected', 'bounced'].includes(status)) return 'failed'
    if (['delivered', 'success', 'completed'].includes(status)) return 'delivered'
    if (['sent', 'accepted', 'processed'].includes(status)) return 'sent'
    return 'pending'
}

function smsPayloadMessage(payload: unknown, eventCode?: string): string {
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

/** A non-HQ viewer without an organization sees nothing (fail closed). */
const emptyScope = (scope: MonitorScope) => scope.kind === 'orgs' && scope.orgIds.length === 0

function scoped(query: any, scope: MonitorScope) {
    return scope.kind === 'orgs' ? query.in('org_id', scope.orgIds) : query
}

/** HQ sees several organizations at once, so each row says whose it is. */
async function attachOrgNames(admin: any, messages: any[]) {
    const ids = Array.from(new Set(messages.map((row) => row.orgId).filter(Boolean))) as string[]
    const names = new Map<string, string>()
    if (ids.length) {
        const { data } = await admin.from('organizations').select('id, org_name').in('id', ids)
        for (const row of data || []) if (row?.id) names.set(row.id, asString(row.org_name))
    }
    for (const row of messages) row.orgName = row.orgId ? names.get(row.orgId) || null : null
}

const SMS_OUTBOX_COLUMNS = 'id, org_id, created_at, scheduled_for, sent_at, status, to_phone, event_code, provider_name, provider_message_id, error, retry_count, max_retries, payload_json, template_code, priority'

export async function loadSmsMessages(admin: any, scope: MonitorScope, window: LoadWindow) {
    if (emptyScope(scope)) return { messages: [] as any[], truncated: false }
    const logsQuery = scoped(admin
        .from('notification_logs')
        .select('id, org_id, created_at, queued_at, sent_at, delivered_at, failed_at, status, recipient_value, recipient_type, event_code, provider_name, provider_message_id, error_message, retry_count, provider_response, outbox_id')
        .eq('channel', 'sms'), scope)
    const outboxQuery = scoped(admin.from('notifications_outbox').select(SMS_OUTBOX_COLUMNS).eq('channel', 'sms'), scope)

    const [logsRes, outboxRes] = await Promise.all([windowed<any>(logsQuery, window), windowed<any>(outboxQuery, window)])
    if (logsRes.error) throw new Error(logsRes.error.message)
    if (outboxRes.error) throw new Error(outboxRes.error.message)

    const outboxById = new Map((outboxRes.data || []).map((row: any) => [row.id, row]))
    const missingOutboxIds = Array.from(new Set(
        (logsRes.data || []).map((log: any) => log.outbox_id).filter((id: string | null) => id && !outboxById.has(id)),
    ))
    if (missingOutboxIds.length > 0) {
        const { data: extraOutbox } = await admin.from('notifications_outbox').select(SMS_OUTBOX_COLUMNS).in('id', missingOutboxIds)
        for (const row of extraOutbox || []) outboxById.set(row.id, row)
    }
    const loggedOutboxIds = new Set<string>()
    const messages: any[] = []

    for (const log of logsRes.data || []) {
        if (log.outbox_id && loggedOutboxIds.has(log.outbox_id)) continue
        const outbox: any = log.outbox_id ? outboxById.get(log.outbox_id) : null
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
            deliveredAt: log.delivered_at || (toSmsMonitorStatus(rawStatus) === 'delivered' ? log.sent_at : null),
            failedAt: log.failed_at || null,
            status: toSmsMonitorStatus(rawStatus),
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
            messageBody: smsPayloadMessage(outbox?.payload_json, asString(log.event_code) || asString(outbox?.event_code)),
            ...extractOrderRef(outbox?.payload_json),
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
            deliveredAt: toSmsMonitorStatus(rawStatus) === 'delivered' ? outbox.sent_at : null,
            failedAt: toSmsMonitorStatus(rawStatus) === 'failed' ? outbox.sent_at || outbox.created_at : null,
            status: toSmsMonitorStatus(rawStatus),
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
            messageBody: smsPayloadMessage(outbox.payload_json, asString(outbox.event_code)),
            ...extractOrderRef(outbox.payload_json),
            providerResponse: null,
            statusDetails: null,
        })
    }

    messages.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    await attachOrgNames(admin, messages)
    return { messages, truncated: hitLimit(logsRes.data, window) || hitLimit(outboxRes.data, window) }
}

export function smsToMonitorRecord(message: any): MonitorRecord {
    return {
        id: `sms-${message.source}-${message.id}`,
        channel: 'sms',
        kind: 'original',
        createdAt: message.createdAt,
        queuedAt: message.queuedAt,
        sentAt: message.sentAt,
        deliveredAt: message.deliveredAt,
        failedAt: message.failedAt,
        status: message.status,
        rawStatus: message.rawStatus,
        recipient: message.phone,
        organizationName: message.orgName || null,
        eventCode: message.eventCode,
        provider: message.providerName,
        providerMessageId: message.providerMessageId,
        message: message.messageBody || null,
        errorMessage: message.errorMessage,
        retryCount: message.retryCount,
        maxRetries: message.maxRetries,
        reference: referenceFrom(message.payload, { orderId: message.orderId, orderNo: message.orderNo }),
        statusDetails: message.statusDetails,
        // What PATCH /sms-activity (edit & resend) needs.
        action: { id: message.id, source: message.source, outboxId: message.outboxId, eventCode: message.eventCode, phone: message.phone, messageBody: message.messageBody },
    }
}

// ---------------------------------------------------------------------------
// Email

type ProviderBlock = { error: string; lastTestAt: string | null }

function applyProviderTestFailure(
    orgId: string | null | undefined,
    rawStatus: string,
    createdAt: string | null,
    sentAt: string | null,
    existingError: string | null,
    providerBlockByOrg: Map<string, ProviderBlock>,
) {
    const mapped = toEmailMonitorStatus(rawStatus)
    const block = orgId ? providerBlockByOrg.get(orgId) : undefined
    const overlay = overlayEmailStatusForFailedProvider({
        status: mapped,
        createdAt,
        sentAt,
        lastTestAt: block?.lastTestAt,
        providerBlockError: block?.error,
        existingError,
    })
    return {
        status: overlay.status,
        rawStatus: overlay.status === 'failed' && mapped !== 'failed' ? 'failed' : rawStatus,
        errorMessage: overlay.errorMessage,
        failedAt: overlay.status === 'failed' ? sentAt || createdAt : null,
    }
}

const EMAIL_OUTBOX_COLUMNS = 'id, org_id, created_at, scheduled_for, sent_at, status, to_email, event_code, provider_name, provider_message_id, error, retry_count, max_retries, payload_json, template_code, priority'
const EMAIL_OTP_EVENT_TYPES = [
    'shop_contact_otp_sent',
    'shop_contact_otp_resend_sent',
    'shop_contact_otp_send_failed',
    'registration_otp_sent',
    'registration_otp_resend_sent',
    'password_reset_otp_sent',
    'password_reset_otp_resend_sent',
]

export async function loadEmailMessages(admin: any, scope: MonitorScope, window: LoadWindow) {
    if (emptyScope(scope)) return { messages: [] as any[], truncated: false }
    const logsQuery = scoped(admin
        .from('notification_logs')
        .select('id, org_id, created_at, queued_at, sent_at, delivered_at, failed_at, status, recipient_value, recipient_type, event_code, provider_name, provider_message_id, error_message, retry_count, provider_response, outbox_id')
        .eq('channel', 'email'), scope)
    const outboxQuery = scoped(admin.from('notifications_outbox').select(EMAIL_OUTBOX_COLUMNS).eq('channel', 'email'), scope)

    // OTP events were capped at 200 (vs 500 for logs/outbox) by the original endpoint.
    const otpWindow = { ...window, limit: window.limit === LEGACY_LIMIT ? 200 : window.limit }
    const [logsRes, outboxRes, providersRes, otpRes] = await Promise.all([
        windowed<any>(logsQuery, window),
        windowed<any>(outboxQuery, window),
        admin.from('notification_provider_configs').select('org_id, last_test_status, last_test_error, last_test_at').eq('channel', 'email').eq('is_active', true),
        // notification_events rows carry no organization, so only all-org viewers may see them.
        scope.kind === 'all'
            ? windowed<any>(
                admin.from('notification_events')
                    .select('id, created_at, sent_at, status, event_type, recipient_email, provider, provider_message_id, error_message, meta')
                    .eq('channel', 'email')
                    .in('event_type', EMAIL_OTP_EVENT_TYPES),
                otpWindow,
            )
            : Promise.resolve({ data: [] as any[], error: null }),
    ])
    if (logsRes.error) throw new Error(logsRes.error.message)
    if (outboxRes.error) throw new Error(outboxRes.error.message)
    if (otpRes.error) console.warn('[email-activity] notification_events:', otpRes.error.message)

    const providerBlockByOrg = new Map<string, ProviderBlock>()
    for (const provider of providersRes.data || []) {
        const blocked = emailProviderBlockedByUiTest(provider)
        if (!blocked || !provider.org_id) continue
        providerBlockByOrg.set(provider.org_id, { error: blocked, lastTestAt: provider.last_test_at || null })
    }

    const outboxById = new Map((outboxRes.data || []).map((row: any) => [row.id, row]))
    const missingOutboxIds = Array.from(new Set(
        (logsRes.data || []).map((log: any) => log.outbox_id).filter((id: string | null) => id && !outboxById.has(id)),
    ))
    if (missingOutboxIds.length > 0) {
        const { data: extraOutbox } = await admin.from('notifications_outbox').select(EMAIL_OUTBOX_COLUMNS).in('id', missingOutboxIds)
        for (const row of extraOutbox || []) outboxById.set(row.id, row)
    }

    const loggedOutboxIds = new Set<string>()
    const messages: any[] = []

    for (const log of logsRes.data || []) {
        if (log.outbox_id && loggedOutboxIds.has(log.outbox_id)) continue
        const outbox: any = log.outbox_id ? outboxById.get(log.outbox_id) : null
        if (log.outbox_id) loggedOutboxIds.add(log.outbox_id)
        const rawStatus = asString(log.status) || asString(outbox?.status)
        const eventCode = asString(log.event_code) || asString(outbox?.event_code) || null
        const payload = outbox?.payload_json || null
        const createdAt = log.created_at || log.queued_at || outbox?.created_at || null
        const sentAt = log.sent_at || outbox?.sent_at || null
        const overlay = applyProviderTestFailure(log.org_id || outbox?.org_id, rawStatus, createdAt, sentAt, asString(log.error_message) || asString(outbox?.error) || null, providerBlockByOrg)
        messages.push({
            id: log.id,
            source: 'log',
            outboxId: log.outbox_id || null,
            orgId: asString(log.org_id) || asString(outbox?.org_id) || null,
            createdAt,
            queuedAt: log.queued_at || outbox?.created_at || null,
            sentAt,
            deliveredAt: overlay.status === 'delivered' ? (log.delivered_at || sentAt) : log.delivered_at,
            failedAt: overlay.status === 'failed' ? (log.failed_at || overlay.failedAt) : log.failed_at,
            status: overlay.status,
            rawStatus: overlay.rawStatus,
            receiver: extractEmailReceiver(log.recipient_value, outbox, payload),
            eventCode,
            providerName: asString(log.provider_name) || asString(outbox?.provider_name) || 'email',
            providerMessageId: asString(log.provider_message_id) || asString(outbox?.provider_message_id) || null,
            errorMessage: overlay.errorMessage,
            retryCount: Number(log.retry_count ?? outbox?.retry_count ?? 0),
            maxRetries: outbox?.max_retries != null ? Number(outbox.max_retries) : null,
            templateCode: asString(outbox?.template_code) || null,
            priority: asString(outbox?.priority) || null,
            payload,
            subject: extractEmailSubject(payload, eventCode),
            messageBody: extractEmailBody(payload),
            ...emailOrderFields(payload),
            providerResponse: log.provider_response || null,
            statusDetails: truncate(log.provider_response),
        })
    }

    for (const outbox of outboxRes.data || []) {
        if (loggedOutboxIds.has(outbox.id)) continue
        const rawStatus = asString(outbox.status)
        const eventCode = asString(outbox.event_code) || null
        const payload = outbox.payload_json || null
        const createdAt = outbox.created_at || null
        const sentAt = outbox.sent_at || null
        const overlay = applyProviderTestFailure(outbox.org_id, rawStatus, createdAt, sentAt, asString(outbox.error) || null, providerBlockByOrg)
        messages.push({
            id: outbox.id,
            source: 'outbox',
            outboxId: outbox.id,
            orgId: asString(outbox.org_id) || null,
            createdAt,
            queuedAt: outbox.created_at || outbox.scheduled_for || null,
            sentAt,
            deliveredAt: overlay.status === 'delivered' ? sentAt : null,
            failedAt: overlay.status === 'failed' ? overlay.failedAt || createdAt : null,
            status: overlay.status,
            rawStatus: overlay.rawStatus,
            receiver: extractEmailReceiver(outbox.to_email, payload),
            eventCode,
            providerName: asString(outbox.provider_name) || 'email',
            providerMessageId: asString(outbox.provider_message_id) || null,
            errorMessage: overlay.errorMessage,
            retryCount: Number(outbox.retry_count || 0),
            maxRetries: outbox.max_retries != null ? Number(outbox.max_retries) : null,
            templateCode: asString(outbox.template_code) || null,
            priority: asString(outbox.priority) || null,
            payload,
            subject: extractEmailSubject(payload, eventCode),
            messageBody: extractEmailBody(payload),
            ...emailOrderFields(payload),
            providerResponse: null,
            statusDetails: null,
        })
    }

    for (const event of otpRes.data || []) {
        if (passwordResetEventAlreadyLogged(event, logsRes.data || [])) continue
        const eventCode = asString(event.event_type) || 'shop_contact_otp_sent'
        const rawStatus = eventCode.includes('failed') ? 'failed' : (asString(event.status) || 'sent')
        const createdAt = event.created_at || event.sent_at || null
        const sentAt = event.sent_at || createdAt
        const overlay = applyProviderTestFailure(null, rawStatus, createdAt, sentAt, asString(event.error_message) || null, providerBlockByOrg)
        const payload = event.meta && typeof event.meta === 'object' ? event.meta : null
        messages.push({
            id: event.id,
            source: 'log',
            outboxId: null,
            orgId: null,
            createdAt,
            queuedAt: createdAt,
            sentAt,
            deliveredAt: overlay.status === 'delivered' ? sentAt : null,
            failedAt: overlay.status === 'failed' ? sentAt || createdAt : null,
            status: overlay.status,
            rawStatus: overlay.rawStatus,
            receiver: extractEmailReceiver(event.recipient_email, payload),
            eventCode,
            providerName: asString(event.provider) || 'email',
            providerMessageId: asString(event.provider_message_id) || null,
            errorMessage: overlay.errorMessage,
            retryCount: 0,
            maxRetries: null,
            templateCode: null,
            priority: null,
            payload,
            subject: extractEmailSubject(payload, eventCode),
            messageBody: extractEmailBody(payload),
            ...emailOrderFields(payload),
            providerResponse: null,
            statusDetails: null,
        })
    }

    messages.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    await attachOrgNames(admin, messages)
    return {
        messages,
        truncated: hitLimit(logsRes.data, window) || hitLimit(outboxRes.data, window) || hitLimit(otpRes.data, otpWindow),
    }
}

export function emailToMonitorRecord(message: any): MonitorRecord {
    return {
        id: `email-${message.source}-${message.id}`,
        channel: 'email',
        kind: 'original',
        createdAt: message.createdAt,
        queuedAt: message.queuedAt,
        sentAt: message.sentAt,
        deliveredAt: message.deliveredAt,
        failedAt: message.failedAt,
        status: message.status,
        rawStatus: message.rawStatus,
        recipient: message.receiver,
        organizationName: message.orgName || null,
        eventCode: message.eventCode,
        provider: message.providerName,
        providerMessageId: message.providerMessageId,
        subject: message.subject || null,
        message: message.messageBody || null,
        errorMessage: message.errorMessage,
        retryCount: message.retryCount,
        maxRetries: message.maxRetries,
        reference: referenceFrom(message.payload, { orderId: message.orderId, orderNo: message.orderNo }),
        statusDetails: message.statusDetails,
    }
}

// ---------------------------------------------------------------------------
// WhatsApp

const RECOVERY_PURPOSE_SET = new Set<string>(RECOVERY_PURPOSES)

function parseProviderResponse(value: unknown): Record<string, any> | null {
    const parsed = normalizeActivityMetadata(value)
    return Object.keys(parsed).length > 0 ? parsed : null
}

function resolveLogRecipientPhone(recipient: unknown, providerResponse: unknown) {
    const direct = String(recipient || '').trim()
    if (direct && direct.toLowerCase() !== 'unknown') return direct
    const parsed = parseProviderResponse(providerResponse)
    const gatewayTarget = String(parsed?.to || parsed?.jid || '').trim()
    return gatewayTarget.replace(/@s\.whatsapp\.net$/i, '')
}

function inferPurpose(rawPurpose: unknown, rawEventType: unknown) {
    const explicitPurpose = String(rawPurpose || '').trim()
    if (explicitPurpose) return explicitPurpose
    const probe = String(rawEventType || '').toLowerCase()
    if (probe.includes('password_reset')) return 'password_reset'
    if (probe.includes('registration')) return 'registration_verification'
    if (probe.includes('phone_verification')) return 'phone_verification'
    if (probe.includes('qr') || probe.includes('claim')) return 'qr_consumer'
    return 'system'
}

function toRecoverySnapshot(row: any) {
    return {
        id: String(row.id),
        status: String(row.status || ''),
        createdAt: String(row.created_at || ''),
        sentAt: row.sent_at ? String(row.sent_at) : null,
        purpose: String(row.purpose || ''),
        messageBody: row.message_body ? String(row.message_body) : null,
        messageTemplate: row.message_template ? String(row.message_template) : null,
        errorMessage: row.error_message ? String(row.error_message) : null,
    }
}

function orderRefFromEvent(row: any): NotificationOrderRef {
    const relatedType = String(row.related_entity_type || '').toLowerCase()
    const relatedId = relatedType === 'order' ? String(row.related_entity_id || '').trim() || null : null
    const fromMeta = extractOrderRef(row.meta)
    return { orderId: fromMeta.orderId || relatedId, orderNo: fromMeta.orderNo }
}

async function resolveMissingOrderNumbers(admin: any, refs: NotificationOrderRef[]): Promise<Map<string, string>> {
    const missing = Array.from(new Set(refs.filter((ref) => ref.orderId && !ref.orderNo).map((ref) => ref.orderId as string)))
    if (missing.length === 0) return new Map()
    const { data } = await admin.from('orders').select('id, display_doc_no, order_no').in('id', missing)
    const labels = new Map<string, string>()
    for (const order of data || []) {
        const label = String(order.display_doc_no || order.order_no || '').trim()
        if (order?.id && label) labels.set(String(order.id), label)
    }
    return labels
}

/**
 * WhatsApp activity: notification_events (platform-wide OTP/system messages,
 * which have no organization) plus this organization's notification_logs.
 */
export async function loadWhatsAppRecords(admin: any, orgId: string | null, window: LoadWindow) {
    const [eventRowsRes, logRowsRes, templates] = await Promise.all([
        windowed<any>(
            admin.from('notification_events')
                .select('id, created_at, requested_at, sent_at, status, recipient_phone, event_type, purpose, provider, error_message, provider_message_id, user_id, message_template, message_body, meta, related_entity_id, related_entity_type')
                .eq('channel', 'whatsapp'),
            window,
        ),
        orgId
            ? windowed<any>(
                admin.from('notification_logs')
                    .select('id, created_at, sent_at, delivered_at, failed_at, status, recipient_value, event_code, provider_name, error_message, provider_response, outbox_id, retry_count')
                    .eq('channel', 'whatsapp')
                    .eq('org_id', orgId),
                window,
            )
            : Promise.resolve({ data: [], error: null }),
        orgId ? loadRecoveryTemplates(admin, orgId) : Promise.resolve([]),
    ])
    if (eventRowsRes.error) throw new Error(eventRowsRes.error.message)
    if (logRowsRes.error) throw new Error(logRowsRes.error.message)

    const eventRows = ((eventRowsRes.data || []) as any[]).filter((row) => !isMonitoringDismissed(row.meta))
    const logRows = ((logRowsRes.data || []) as any[]).filter((row) => !isMonitoringDismissed(row.provider_response))
    const recoveryBySourceKey = new Map<string, ReturnType<typeof toRecoverySnapshot>>()
    const recoveryByPhoneAndPurpose = new Map<string, ReturnType<typeof toRecoverySnapshot>>()

    const outboxIds = Array.from(new Set(logRows.map((row) => String(row.outbox_id || '')).filter(Boolean)))
    const outboxById = new Map<string, any>()
    if (outboxIds.length > 0) {
        const { data: outboxRows } = await admin.from('notifications_outbox').select('id, payload_json, max_retries').in('id', outboxIds)
        for (const row of outboxRows || []) outboxById.set(String(row.id), row)
    }

    for (const row of eventRows) {
        if (!RECOVERY_PURPOSE_SET.has(String(row.purpose || ''))) continue
        const meta = normalizeActivityMetadata(row.meta)
        const snapshot = toRecoverySnapshot(row)
        const sourceKey = String(meta.source_key || '').trim()
        if (sourceKey && !recoveryBySourceKey.has(sourceKey)) recoveryBySourceKey.set(sourceKey, snapshot)
        const normalizedPhone = normalizePhoneE164(String(row.recipient_phone || '').trim())
        if (normalizedPhone) {
            const fallbackKey = `${normalizedPhone}:${String(row.purpose || '')}`
            if (!recoveryByPhoneAndPurpose.has(fallbackKey)) recoveryByPhoneAndPurpose.set(fallbackKey, snapshot)
        }
    }

    const records = [
        ...eventRows.map((row) => {
            const normalizedPhone = normalizePhoneE164(String(row.recipient_phone || '').trim()) || String(row.recipient_phone || '').trim()
            const order = orderRefFromEvent(row)
            return {
                id: `event-${row.id}`,
                sourceType: 'notification_event',
                sourceRecordId: String(row.id),
                sourceKey: `notification_event:${row.id}`,
                createdAt: String(row.created_at || row.requested_at || ''),
                recipientPhone: normalizedPhone,
                eventType: String(row.event_type || ''),
                purpose: inferPurpose(row.purpose, row.event_type),
                status: String(row.status || 'unknown'),
                provider: String(row.provider || ''),
                errorMessage: String(row.error_message || ''),
                userId: row.user_id ? String(row.user_id) : null,
                providerMessageId: row.provider_message_id ? String(row.provider_message_id) : null,
                messageTemplate: row.message_template ? String(row.message_template) : null,
                messageBody: row.message_body ? String(row.message_body) : null,
                meta: normalizeActivityMetadata(row.meta),
                orderId: order.orderId,
                orderNo: order.orderNo,
                payload: null as unknown,
                retryCount: null as number | null,
                maxRetries: null as number | null,
            }
        }),
        ...logRows.map((row) => {
            const normalizedPhone = normalizePhoneE164(resolveLogRecipientPhone(row.recipient_value, row.provider_response))
            const outbox = row.outbox_id ? outboxById.get(String(row.outbox_id)) : null
            const order = extractOrderRef(outbox?.payload_json)
            return {
                id: `log-${row.id}`,
                sourceType: 'notification_log',
                sourceRecordId: String(row.id),
                sourceKey: `notification_log:${row.id}`,
                createdAt: String(row.sent_at || row.delivered_at || row.failed_at || row.created_at || ''),
                recipientPhone: normalizedPhone,
                eventType: String(row.event_code || ''),
                purpose: inferPurpose(null, row.event_code),
                status: String(row.status || 'unknown'),
                provider: String(row.provider_name || ''),
                errorMessage: String(row.error_message || ''),
                userId: null,
                providerMessageId: null,
                messageTemplate: null,
                messageBody: null,
                meta: normalizeActivityMetadata(row.provider_response),
                orderId: order.orderId,
                orderNo: order.orderNo,
                payload: outbox?.payload_json || null,
                retryCount: row.retry_count != null ? Number(row.retry_count) : null,
                maxRetries: outbox?.max_retries != null ? Number(outbox.max_retries) : null,
            }
        }),
    ].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())

    const orderLabels = await resolveMissingOrderNumbers(admin, records)
    for (const record of records) {
        if (!record.orderNo && record.orderId) record.orderNo = orderLabels.get(record.orderId) || record.orderNo
    }

    const contacts = await resolveRecoveryContacts(admin, records.map((record) => ({ key: record.sourceKey, phone: record.recipientPhone, userId: record.userId })))

    const enriched = records.map((record) => {
        const contact = contacts[record.sourceKey] || {
            normalizedPhone: record.recipientPhone,
            displayName: 'Unknown contact',
            sourceLabel: 'Unknown',
            userId: null,
            organizationId: null,
            matchedBy: 'none',
        }
        const selectedTemplate = pickRecoveryTemplate(templates, record.purpose)
        const previewBody = record.messageBody || renderTemplate(
            selectedTemplate.body,
            buildRecoveryMessageVariables({
                failedPurpose: record.purpose,
                failedAt: record.createdAt,
                recipientName: contact.displayName === 'Unknown contact' ? null : contact.displayName,
            }),
        )
        const latestRecovery = RECOVERY_PURPOSE_SET.has(record.purpose)
            ? null
            : recoveryBySourceKey.get(record.sourceKey) || recoveryByPhoneAndPurpose.get(`${contact.normalizedPhone}:${selectedTemplate.key}`) || null
        return {
            ...record,
            recipientPhone: contact.normalizedPhone || record.recipientPhone,
            contactName: contact.displayName,
            contactSource: contact.sourceLabel,
            resolvedUserId: contact.userId,
            resolvedOrganizationId: contact.organizationId,
            suggestedTemplateKey: selectedTemplate.key,
            suggestedTemplateName: selectedTemplate.name,
            suggestedMessagePreview: previewBody,
            latestRecovery,
        }
    })

    return {
        records: enriched,
        truncated: hitLimit(eventRowsRes.data, window) || hitLimit(logRowsRes.data, window),
    }
}

export function whatsAppToMonitorRecord(record: any): MonitorRecord {
    const isRecovery = RECOVERY_PURPOSE_SET.has(record.purpose)
    const recovery = record.latestRecovery
    return {
        id: `wa-${record.id}`,
        channel: 'whatsapp',
        kind: isRecovery ? 'recovery' : 'original',
        createdAt: record.createdAt || null,
        status: normalizeWhatsAppStatus(record.status),
        rawStatus: record.status,
        recipient: record.recipientPhone || null,
        recipientName: record.contactName && record.contactName !== 'Unknown contact' ? record.contactName : null,
        recipientSource: record.contactSource || null,
        // The stored key: event_type for events, event_code for logs.
        eventCode: record.eventType || null,
        purpose: record.purpose,
        provider: record.provider || null,
        providerMessageId: record.providerMessageId,
        message: record.messageBody,
        errorMessage: record.errorMessage || null,
        retryCount: record.retryCount,
        maxRetries: record.maxRetries,
        reference: referenceFrom(record.payload, { orderId: record.orderId, orderNo: record.orderNo }),
        recovery: recovery
            ? { status: recovery.status, at: recovery.sentAt || recovery.createdAt || null, template: recovery.messageTemplate, message: recovery.messageBody, error: recovery.errorMessage }
            : null,
        // What the recovery send / clear endpoints need (same fields the old UI serialized).
        action: {
            sourceType: record.sourceType,
            sourceRecordId: record.sourceRecordId,
            sourceKey: record.sourceKey,
            phone: record.recipientPhone,
            failedPurpose: record.purpose,
            failedAt: record.createdAt,
            provider: record.provider,
            userId: record.resolvedUserId || record.userId,
            resolvedName: record.contactName,
            resolvedSource: record.contactSource,
            suggestedTemplateKey: record.suggestedTemplateKey,
            suggestedTemplateName: record.suggestedTemplateName,
            suggestedMessagePreview: record.suggestedMessagePreview,
        },
    }
}

