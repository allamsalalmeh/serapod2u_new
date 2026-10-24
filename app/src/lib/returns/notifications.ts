/**
 * Return Product notifications.
 *
 * Reuses the shared notification pipeline (notification_types /
 * notification_settings / notifications_outbox + the outbox worker). We do NOT
 * call WhatsApp/email providers directly from here — events are queued and the
 * cron worker delivers them, so a provider outage never rolls back a return
 * status transition.
 *
 * Recipient model: routing config + providers live under the HQ/company org
 * (where the admin configures Settings → Notifications). Delivery targets the
 * *source* organization's Master Data contact (Shop or Distributor), so we queue
 * under the config org but pin `to_phone` / `to_email` to the source contact.
 */
import { RETURN_STATUS_LABELS, RETURN_SOURCE_LABELS, normalizeReturnSourceType, type ReturnStatus } from './constants'
import { deliveryChainForPreset, isFallbackRoutingPreset, resolveNotificationRoutingPreset, type NotificationRoutingPreset } from '@/lib/notifications/routing'
import { itemsTotalQty, itemsTotalValue } from './compute'
import { RETURN_ORG_SELECT } from './server'

type Admin = any

/** Maps a return status to the notification event fired when it is reached. */
export const RETURN_STATUS_EVENT: Partial<Record<ReturnStatus, string>> = {
    return_draft: 'return_draft_created',
    return_submitted: 'return_submitted',
    return_received: 'return_received',
    return_processing: 'return_processing',
    return_completed: 'return_completed',
}

export const RETURN_NOTIFICATION_EVENT_CODES = new Set(Object.values(RETURN_STATUS_EVENT))

export interface QueueReturnNotificationResult {
    queued: number
    skippedReason?: 'disabled' | 'duplicate' | 'no_source' | 'no_config_org'
    /** Friendly, non-blocking warnings (e.g. missing contact email/phone). */
    warnings: string[]
}

function formatDate(value: string | null | undefined): string {
    if (!value) return ''
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return String(value)
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

function formatAmount(value: number): string {
    return Number(value || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * Resolve the org that owns notification routing + providers (the HQ/company
 * org where Settings → Notifications is configured). Prefers an active HQ org,
 * then any org with an active provider, so delivery uses real credentials.
 */
export async function resolveNotificationConfigOrgId(admin: Admin): Promise<string | null> {
    const { data: hq } = await admin
        .from('organizations')
        .select('id')
        .eq('org_type_code', 'HQ')
        .eq('is_active', true)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
    if (hq?.id) return hq.id

    const { data: provider } = await admin
        .from('notification_provider_configs')
        .select('org_id')
        .eq('is_active', true)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
    return provider?.org_id || null
}

async function hasActiveProvider(admin: Admin, orgId: string, channel: string): Promise<boolean> {
    const { data } = await admin
        .from('notification_provider_configs')
        .select('id')
        .eq('org_id', orgId)
        .eq('channel', channel)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle()
    return Boolean(data?.id)
}

/** Channels to queue for a routing preset (mirrors supplyChainEventQueue). */
async function channelsForPreset(
    admin: Admin,
    configOrgId: string,
    preset: NotificationRoutingPreset,
): Promise<string[]> {
    if (preset === 'whatsapp_only') return ['whatsapp']
    if (preset === 'email_only') return ['email']
    if (preset === 'sms_only') return ['sms']
    // Fallback presets start on the first hop that has an active provider.
    if (isFallbackRoutingPreset(preset)) {
        const chain = deliveryChainForPreset(preset)
        for (const channel of chain) {
            if (await hasActiveProvider(admin, configOrgId, channel)) return [channel]
        }
        return [chain[0]]
    }
    return ['whatsapp']
}

interface ReturnNotificationContext {
    returnCase: any
    sourceOrg: any
    warehouse: any
    payload: Record<string, any>
}

/** Load the return + source/warehouse orgs and build the template payload. */
export async function buildReturnNotificationContext(
    admin: Admin,
    returnCaseId: string,
): Promise<ReturnNotificationContext | null> {
    const { data: rc } = await admin
        .from('return_cases')
        .select('*')
        .eq('id', returnCaseId)
        .maybeSingle()
    if (!rc) return null

    const sourceOrgId = rc.return_source_organization_id || rc.shop_org_id
    const orgIds = [sourceOrgId, rc.return_warehouse_id].filter(Boolean)
    const { data: orgs } = orgIds.length
        ? await admin.from('organizations').select(RETURN_ORG_SELECT).in('id', orgIds)
        : { data: [] as any[] }
    const orgMap = Object.fromEntries((orgs || []).map((o: any) => [o.id, o]))
    const sourceOrg = orgMap[sourceOrgId] || null
    const warehouse = rc.return_warehouse_id ? orgMap[rc.return_warehouse_id] || null : null

    const { data: items } = await admin
        .from('return_case_items')
        .select('total_units, quantity, unit_cost, unit_price, units_per_case_snapshot')
        .eq('return_case_id', returnCaseId)

    const sourceType = normalizeReturnSourceType(rc.return_source_type)
    const status = rc.status as ReturnStatus
    const contactName = sourceOrg?.contact_name || rc.contact_person || ''

    const payload: Record<string, any> = {
        return_no: rc.return_no || '',
        return_status: RETURN_STATUS_LABELS[status] || status,
        return_source_type: RETURN_SOURCE_LABELS[sourceType],
        return_source_name: sourceOrg?.org_name || '',
        return_source_code: sourceOrg?.org_code || '',
        return_warehouse_name: warehouse?.org_name || '',
        reported_date: formatDate(rc.reported_date),
        total_quantity: String(itemsTotalQty(items as any)),
        total_value: formatAmount(itemsTotalValue(items as any)),
        contact_name: contactName || '',
        updated_at: formatDate(rc.updated_at),
        // Internal markers (not shown to users) for idempotency + tracing.
        _return_id: rc.id,
    }

    return { returnCase: rc, sourceOrg, warehouse, payload }
}

/**
 * Queue a Return Product notification for a status transition. Fully guarded:
 * returns a result rather than throwing so callers never roll back the status.
 *
 * Idempotency: a return reaches each status once, so we skip if an outbox row
 * already exists for (event_code, return_no) — protecting against double-clicks,
 * retries and page refreshes.
 */
export async function queueReturnNotification(
    admin: Admin,
    input: { returnCaseId: string; eventCode: string },
): Promise<QueueReturnNotificationResult> {
    const { returnCaseId, eventCode } = input
    const warnings: string[] = []

    const configOrgId = await resolveNotificationConfigOrgId(admin)
    if (!configOrgId) return { queued: 0, skippedReason: 'no_config_org', warnings }

    // Respect the admin's per-event configuration. The Return Product events
    // default to disabled, so we only send when a settings row is enabled.
    const { data: setting } = await admin
        .from('notification_settings')
        .select('enabled, channels_enabled, recipient_config')
        .eq('org_id', configOrgId)
        .eq('event_code', eventCode)
        .maybeSingle()

    if (!setting || setting.enabled !== true) {
        return { queued: 0, skippedReason: 'disabled', warnings }
    }

    const ctx = await buildReturnNotificationContext(admin, returnCaseId)
    if (!ctx || !ctx.sourceOrg) return { queued: 0, skippedReason: 'no_source', warnings }

    const returnNo = ctx.payload.return_no

    // Idempotency guard — one notification per (event, return).
    const { data: existing } = await admin
        .from('notifications_outbox')
        .select('id')
        .eq('org_id', configOrgId)
        .eq('event_code', eventCode)
        .contains('payload_json', { _return_id: returnCaseId })
        .limit(1)
    if (existing && existing.length > 0) {
        return { queued: 0, skippedReason: 'duplicate', warnings }
    }

    const preset = resolveNotificationRoutingPreset(setting)
    const channels = await channelsForPreset(admin, configOrgId, preset)

    const contactEmail = String(ctx.sourceOrg.contact_email || '').trim()
    const contactPhone = String(ctx.sourceOrg.contact_phone || '').trim()
    const sourceLabel = RETURN_SOURCE_LABELS[normalizeReturnSourceType(ctx.returnCase.return_source_type)].toLowerCase()

    let queued = 0
    for (const channel of channels) {
        const wantsEmail = channel === 'email'
        const recipient = wantsEmail ? contactEmail : contactPhone

        if (!recipient) {
            // Record a clear, non-blocking skip in the notification logs.
            const reason = wantsEmail
                ? `Return status updated, but the notification was not sent because the ${sourceLabel} has no contact email.`
                : `Return status updated, but the notification was not sent because the ${sourceLabel} has no contact phone.`
            warnings.push(reason)
            await admin.from('notifications_outbox').insert({
                org_id: configOrgId,
                event_code: eventCode,
                channel,
                to_phone: null,
                to_email: null,
                template_code: null,
                payload_json: { ...ctx.payload, _skipped_reason: reason },
                priority: 'normal',
                status: 'failed',
                error: reason,
                retry_count: 0,
                max_retries: 0,
            })
            continue
        }

        const { error } = await admin.from('notifications_outbox').insert({
            org_id: configOrgId,
            event_code: eventCode,
            channel,
            to_phone: wantsEmail ? null : recipient,
            to_email: wantsEmail ? recipient : null,
            payload_json: ctx.payload,
            priority: 'normal',
            status: 'queued',
            retry_count: 0,
            max_retries: 3,
        })
        if (!error) queued += 1
    }

    return { queued, warnings }
}

/**
 * Fire a Return Product notification after a successful status transition, then
 * nudge the outbox worker. Never throws — logs and returns instead — so the API
 * response for the transition itself is unaffected.
 */
export async function triggerReturnNotification(
    admin: Admin,
    origin: string,
    input: { returnCaseId: string; status: ReturnStatus },
): Promise<QueueReturnNotificationResult> {
    const eventCode = RETURN_STATUS_EVENT[input.status]
    if (!eventCode) return { queued: 0, warnings: [] }

    try {
        const result = await queueReturnNotification(admin, { returnCaseId: input.returnCaseId, eventCode })
        if (result.queued > 0 && origin) {
            // Nudge the worker (fire-and-forget) so delivery is prompt.
            fetch(`${origin}/api/cron/notification-outbox-worker`).catch(() => {})
        }
        return result
    } catch (error: any) {
        console.error('[ReturnNotifications] Failed to queue return notification:', error?.message || error)
        return { queued: 0, warnings: [] }
    }
}
