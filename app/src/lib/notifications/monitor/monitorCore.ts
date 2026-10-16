/**
 * Notification Monitor — shared, pure logic for every channel.
 *
 * Records from WhatsApp, SMS and Email are normalized into one shape, then
 * filtered, counted and paginated here on the server so the table, the status
 * counts and the summary cards always describe the same set of rows.
 *
 * Modules come from the Notification Types grouping (category → S&A module);
 * anything that grouping cannot place is kept under "Other / Unmapped".
 */
import { categoryModule, moduleName } from '@/lib/notifications/notificationTypeModules'
import { formatNotificationAction } from '@/lib/notifications/emailActivity'
import { OTHER_MODULE } from '@/lib/security-access/modules'

export type MonitorChannel = 'whatsapp' | 'sms' | 'email'
export const MONITOR_CHANNELS: MonitorChannel[] = ['whatsapp', 'sms', 'email']

/** Normalized delivery state of the message a row represents. */
export type MonitorStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'resolved' | 'other'

/** WhatsApp keeps recovery messages apart from the notifications they recover. */
export type MonitorKind = 'original' | 'recovery'

export const STATUS_LABELS: Record<MonitorStatus, string> = {
    pending: 'Pending',
    sent: 'Sent',
    delivered: 'Delivered',
    read: 'Read',
    failed: 'Failed',
    resolved: 'Resolved',
    other: 'Other',
}

export const STATUS_MEANINGS: Record<MonitorStatus, string> = {
    pending: 'Queued or retrying',
    sent: 'Accepted by the provider',
    delivered: 'Delivery confirmed',
    read: 'Read by the recipient',
    failed: 'Not sent, or the provider reported failure',
    resolved: 'The recipient completed the verification flow',
    other: 'A provider status without a standard meaning',
}

/** Statuses each channel can actually report (Read and Resolved are WhatsApp only). */
export const CHANNEL_STATUSES: Record<MonitorChannel, MonitorStatus[]> = {
    whatsapp: ['pending', 'sent', 'delivered', 'read', 'failed', 'resolved', 'other'],
    sms: ['pending', 'sent', 'delivered', 'failed'],
    email: ['pending', 'sent', 'delivered', 'failed'],
}

/** What the provider can confirm — shown so zero "Delivered" is not read as failure. */
export const CHANNEL_CAPABILITY_NOTES: Record<MonitorChannel, string> = {
    whatsapp: 'Delivered and Read appear only when the WhatsApp gateway reports receipts. A recovery message never counts as delivery of the original notification.',
    sms: 'Delivered appears only when the SMS gateway returns a delivery report; until then a message stays Sent.',
    email: 'The email provider confirms acceptance only. Delivered is not reported, so Sent is the final success state.',
}

const FAILED = ['failed', 'send_failed', 'error', 'cancelled', 'canceled', 'undelivered', 'rejected', 'bounced']
const PENDING = ['pending', 'queued', 'processing', 'retrying', 'scheduled', 'requested']

/** WhatsApp raw statuses. recovery_sent means the gateway accepted the recovery message. */
export function normalizeWhatsAppStatus(raw: string | null | undefined): MonitorStatus {
    const status = String(raw || '').trim().toLowerCase()
    if (FAILED.includes(status)) return 'failed'
    if (status === 'read') return 'read'
    if (status === 'delivered') return 'delivered'
    if (['sent', 'accepted', 'recovery_sent'].includes(status)) return 'sent'
    if (['resolved', 'verified', 'completed'].includes(status)) return 'resolved'
    if (PENDING.includes(status)) return 'pending'
    return 'other'
}

// ---------------------------------------------------------------------------
// Dates — the app runs on Malaysia time (UTC+8, no daylight saving).

export const MONITOR_TIMEZONE = 'Asia/Kuala_Lumpur'
const TZ_OFFSET_MS = 8 * 3600_000
const DAY_MS = 24 * 3600_000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** YYYY-MM-DD in Malaysia time. */
export function appDate(at: Date = new Date()): string {
    return new Date(at.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10)
}

export function shiftDate(date: string, days: number): string {
    const [y, m, d] = date.split('-').map(Number)
    return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10)
}

/** Inclusive Malaysia-time days → UTC instants: [from 00:00:00.000, to 23:59:59.999]. */
export function dateRangeBounds(from: string, to: string): { sinceIso: string; untilIso: string } {
    const start = (date: string) => {
        const [y, m, d] = date.split('-').map(Number)
        return Date.UTC(y, m - 1, d) - TZ_OFFSET_MS
    }
    return {
        sinceIso: new Date(start(from)).toISOString(),
        untilIso: new Date(start(to) + DAY_MS - 1).toISOString(),
    }
}

// ---------------------------------------------------------------------------
// Filters

export const DEFAULT_RANGE_DAYS = 7
export const MAX_RANGE_DAYS = 366
export const DEFAULT_PAGE_SIZE = 25
export const UNMAPPED_MODULE_ID = 'unmapped'
export const UNMAPPED_MODULE_LABEL = 'Other / Unmapped'

export interface MonitorFilters {
    channel: MonitorChannel
    q: string
    module: string
    type: string
    from: string
    to: string
    status: MonitorStatus | 'all'
    provider: string
    kind: MonitorKind
    page: number
    pageSize: number
}

export function parseMonitorFilters(params: URLSearchParams, now: Date = new Date()): MonitorFilters {
    const channel = MONITOR_CHANNELS.includes(params.get('channel') as MonitorChannel) ? params.get('channel') as MonitorChannel : 'whatsapp'
    const today = appDate(now)
    let to = DATE_RE.test(params.get('to') || '') ? params.get('to')! : today
    let from = DATE_RE.test(params.get('from') || '') ? params.get('from')! : shiftDate(to, -(DEFAULT_RANGE_DAYS - 1))
    if (from > to) [from, to] = [to, from]
    if (from < shiftDate(to, -(MAX_RANGE_DAYS - 1))) from = shiftDate(to, -(MAX_RANGE_DAYS - 1))
    const status = params.get('status') as MonitorStatus | 'all' | null
    const page = Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1)
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(params.get('pageSize') || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE))
    return {
        channel,
        q: (params.get('q') || '').trim().slice(0, 200),
        module: params.get('module') || 'all',
        type: params.get('type') || 'all',
        from,
        to,
        status: status && status !== 'all' && CHANNEL_STATUSES[channel].includes(status) ? status : 'all',
        provider: params.get('provider') || 'all',
        kind: channel === 'whatsapp' && params.get('kind') === 'recovery' ? 'recovery' : 'original',
        page,
        pageSize,
    }
}

// ---------------------------------------------------------------------------
// Records

export interface MonitorReference {
    kind: 'order' | 'qr_batch' | 'return' | 'document' | 'shop' | 'campaign'
    label: string
    id?: string | null
}

export interface MonitorRecoveryInfo {
    status: string
    at: string | null
    template: string | null
    message: string | null
    error: string | null
}

export interface MonitorRecord {
    id: string
    channel: MonitorChannel
    kind: MonitorKind
    createdAt: string | null
    queuedAt?: string | null
    sentAt?: string | null
    deliveredAt?: string | null
    failedAt?: string | null
    status: MonitorStatus
    rawStatus: string
    recipient: string | null
    recipientName?: string | null
    recipientSource?: string | null
    /** Owning organization, when a viewer can see several (SMS / Email). */
    organizationName?: string | null
    /** Stored identifier, never rewritten: event_code / event_type. */
    eventCode: string | null
    /** WhatsApp purpose, used for unmapped names and recovery templates. */
    purpose?: string | null
    provider: string | null
    providerMessageId?: string | null
    subject?: string | null
    message?: string | null
    errorMessage?: string | null
    retryCount?: number | null
    maxRetries?: number | null
    reference: MonitorReference | null
    recovery?: MonitorRecoveryInfo | null
    statusDetails?: string | null
    /** Channel-specific fields the existing actions need (recovery send, SMS edit). */
    action?: Record<string, unknown>
}

export interface TypeCatalogEntry { event_code: string; event_name: string; category: string }

export interface AnnotatedRecord extends MonitorRecord {
    notificationName: string
    moduleId: string
    moduleName: string
}

const WHATSAPP_PURPOSE_LABELS: Record<string, string> = {
    password_reset: 'Password reset',
    registration_verification: 'Registration',
    phone_verification: 'Phone verification',
    qr_consumer: 'QR claim',
    system: 'System message',
    recovery_notice: 'System restored (recovery)',
    password_reset_recovery: 'Password reset recovery',
    registration_recovery: 'Registration recovery',
    qr_claim_recovery: 'QR claim recovery',
}

/** Module and readable name for a stored event key, from the Notification Types mapping. */
export function classifyEvent(eventCode: string | null, purpose: string | null | undefined, catalog: Map<string, TypeCatalogEntry>) {
    const entry = eventCode ? catalog.get(eventCode) : undefined
    const moduleId = entry ? categoryModule(entry.category) : UNMAPPED_MODULE_ID
    const mapped = Boolean(entry) && moduleId !== OTHER_MODULE.id
    const purposeLabel = purpose ? WHATSAPP_PURPOSE_LABELS[purpose] : undefined
    const readableKey = eventCode ? formatNotificationAction(eventCode) : ''
    const notificationName = entry?.event_name
        || purposeLabel
        || (readableKey ? readableKey.charAt(0).toUpperCase() + readableKey.slice(1) : 'Unknown notification')
    return {
        moduleId: mapped ? moduleId : UNMAPPED_MODULE_ID,
        moduleName: mapped ? moduleName(moduleId) : UNMAPPED_MODULE_LABEL,
        notificationName,
    }
}

/** The key the Notification Type filter uses: the stored event key, or the purpose when there is none. */
export const typeKeyOf = (record: Pick<MonitorRecord, 'eventCode' | 'purpose'>) => record.eventCode || record.purpose || 'unknown'

const digits = (value: string) => value.replace(/\D/g, '')

function matchesSearch(record: AnnotatedRecord, q: string) {
    if (!q) return true
    const needle = q.toLowerCase()
    const needleDigits = digits(q)
    const fields = [
        record.recipient, record.recipientName, record.notificationName, record.eventCode, record.purpose,
        record.reference?.label, record.providerMessageId, record.errorMessage, record.subject, record.moduleName, record.organizationName,
    ]
    if (fields.some((field) => String(field || '').toLowerCase().includes(needle))) return true
    return needleDigits.length >= 3 && digits(String(record.recipient || '')).includes(needleDigits)
}

export interface FacetOption { value: string; label: string; count: number }
export interface TypeFacetOption extends FacetOption { moduleId: string }

export interface MonitorResult {
    filters: MonitorFilters
    rows: AnnotatedRecord[]
    /** Rows matching every filter, before pagination. */
    total: number
    totalPages: number
    /** Every status for the current search/module/type/provider/date/kind, ignoring the status filter. */
    statusCounts: Record<MonitorStatus, number>
    /** Same filters, both kinds (WhatsApp). */
    kindCounts: Record<MonitorKind, number>
    /** Rows before the status filter (equals the sum of statusCounts). */
    matchingBeforeStatus: number
    facets: { modules: FacetOption[]; types: TypeFacetOption[]; providers: FacetOption[] }
}

const emptyStatusCounts = (): Record<MonitorStatus, number> => ({ pending: 0, sent: 0, delivered: 0, read: 0, failed: 0, resolved: 0, other: 0 })

export function annotateRecords(records: MonitorRecord[], catalog: Map<string, TypeCatalogEntry>): AnnotatedRecord[] {
    return records.map((record) => ({ ...record, ...classifyEvent(record.eventCode, record.purpose, catalog) }))
}

/**
 * Records are already limited to the channel and date range by the loader.
 * Order: facets (date + kind) → search/module/type/provider → counts → status → page.
 */
export function applyMonitorQuery(annotated: AnnotatedRecord[], filters: MonitorFilters): MonitorResult {
    const sorted = [...annotated].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))

    const ofKind = sorted.filter((record) => record.kind === filters.kind)
    const moduleFacet = new Map<string, FacetOption>()
    const typeFacet = new Map<string, TypeFacetOption>()
    const providerFacet = new Map<string, FacetOption>()
    for (const record of ofKind) {
        const mod = moduleFacet.get(record.moduleId) || { value: record.moduleId, label: record.moduleName, count: 0 }
        mod.count += 1
        moduleFacet.set(record.moduleId, mod)
        const key = typeKeyOf(record)
        const type = typeFacet.get(key) || { value: key, label: record.notificationName, count: 0, moduleId: record.moduleId }
        type.count += 1
        typeFacet.set(key, type)
        if (record.provider) {
            const provider = providerFacet.get(record.provider) || { value: record.provider, label: record.provider, count: 0 }
            provider.count += 1
            providerFacet.set(record.provider, provider)
        }
    }

    const passesSharedFilters = (record: AnnotatedRecord) =>
        (filters.module === 'all' || record.moduleId === filters.module)
        && (filters.type === 'all' || typeKeyOf(record) === filters.type)
        && (filters.provider === 'all' || record.provider === filters.provider)
        && matchesSearch(record, filters.q)

    const shared = sorted.filter(passesSharedFilters)
    const kindCounts: Record<MonitorKind, number> = { original: 0, recovery: 0 }
    shared.forEach((record) => { kindCounts[record.kind] += 1 })

    const base = shared.filter((record) => record.kind === filters.kind)
    const statusCounts = emptyStatusCounts()
    base.forEach((record) => { statusCounts[record.status] += 1 })

    const matching = filters.status === 'all' ? base : base.filter((record) => record.status === filters.status)
    const totalPages = Math.max(1, Math.ceil(matching.length / filters.pageSize))
    const page = Math.min(filters.page, totalPages)
    const byLabel = (a: FacetOption, b: FacetOption) => a.label.localeCompare(b.label)
    const modules = Array.from(moduleFacet.values()).sort((a, b) => (a.value === UNMAPPED_MODULE_ID ? 1 : b.value === UNMAPPED_MODULE_ID ? -1 : byLabel(a, b)))

    return {
        filters: { ...filters, page },
        rows: matching.slice((page - 1) * filters.pageSize, page * filters.pageSize),
        total: matching.length,
        totalPages,
        statusCounts,
        kindCounts,
        matchingBeforeStatus: base.length,
        facets: {
            modules,
            types: Array.from(typeFacet.values()).sort(byLabel),
            providers: Array.from(providerFacet.values()).sort(byLabel),
        },
    }
}

/** All rows matching the filters (no pagination), for export. */
export function allMatchingRows(annotated: AnnotatedRecord[], filters: MonitorFilters): AnnotatedRecord[] {
    return applyMonitorQuery(annotated, { ...filters, page: 1, pageSize: Number.MAX_SAFE_INTEGER }).rows
}

const csvCell = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`

export function monitorCsv(rows: AnnotatedRecord[]): string {
    const header = ['time', 'channel', 'recipient', 'recipient_name', 'organization', 'notification', 'notification_key', 'module', 'reference', 'status', 'raw_status', 'provider', 'provider_message_id', 'error']
    const lines = rows.map((row) => [
        row.createdAt, row.channel, row.recipient, row.recipientName, row.organizationName, row.notificationName, typeKeyOf(row), row.moduleName,
        row.reference?.label, STATUS_LABELS[row.status], row.rawStatus, row.provider, row.providerMessageId, row.errorMessage,
    ].map(csvCell).join(','))
    return [header.map(csvCell).join(','), ...lines].join('\n')
}

/** Short, readable error for the table; the full text stays in details. */
export function errorSummary(error: string | null | undefined): string | null {
    const text = String(error || '').trim()
    if (!text) return null
    const lower = text.toLowerCase()
    if (lower.includes('timeout') || lower.includes('timed out')) return 'Provider timed out'
    if (lower.includes('not configured') || lower.includes('no default')) return 'Provider not configured'
    if (lower.includes('not connected') || lower.includes('disconnected')) return 'Gateway disconnected'
    if (lower.includes('invalid') && lower.includes('phone')) return 'Invalid phone number'
    if (lower.includes('rate')) return 'Rate limited'
    const firstLine = text.split('\n')[0]
    return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine
}

/** Reference from an outbox payload: order, QR batch, return, document, shop or campaign. */
export function referenceFrom(payload: unknown, order?: { orderId?: string | null; orderNo?: string | null }): MonitorReference | null {
    if (order?.orderNo || order?.orderId) return { kind: 'order', label: order.orderNo || String(order.orderId), id: order.orderId || null }
    const row = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, any> : {}
    const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '')
    if (text(row.batch_id)) return { kind: 'qr_batch', label: `QR batch ${text(row.batch_id).slice(0, 8)}`, id: text(row.batch_id) }
    if (text(row.return_no)) return { kind: 'return', label: text(row.return_no), id: text(row._return_id) || null }
    if (text(row.doc_no)) return { kind: 'document', label: text(row.doc_no) }
    if (text(row.shop_name)) return { kind: 'shop', label: text(row.shop_name) }
    if (text(row.campaign_name)) return { kind: 'campaign', label: text(row.campaign_name) }
    return null
}
