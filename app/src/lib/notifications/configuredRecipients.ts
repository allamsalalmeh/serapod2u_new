/**
 * Recipients configured in Notification Types, resolved for one channel.
 *
 * This is the outbox worker's recipient rule set, shared so the Configure
 * drawer's "Find recipients" preview and the worker cannot disagree. Keep the
 * order below: the worker sends the first address on the original row and fans
 * the rest out, so insertion order is behavior.
 */
import { expandNotificationRoleCodes } from '@/lib/notifications/recipientRoleCodes'
import { normalizeAndDedupeManualEmails } from '@/lib/notifications/manualEmailAddresses'
import { normalizeAndDedupeManualPhones, toSmsE164 } from '@/lib/notifications/manualPhoneNumbers'
import { isSingleCreatorSource, ownerEmailFromPayload, ownerPhoneFromPayload, resolveRecipientTargets } from '@/lib/notifications/orderOwnerNotify'

/** Order events whose payload can be rebuilt from an order (buildOrderEventPayload). */
export const RESOLVABLE_ORDER_EVENTS = ['order_submitted', 'order_approved', 'order_rejected', 'order_closed'] as const
export type ResolvableOrderEvent = typeof RESOLVABLE_ORDER_EVENTS[number]

export type RecipientSource =
    | 'order_creator'
    | 'users'
    | 'roles'
    | 'saved_list'
    | 'manual_email'
    | 'consumer'
    | 'manual_whatsapp'
    | 'event_address'

export interface ResolvedRecipient {
    address: string
    source: RecipientSource
    name?: string | null
    userId?: string | null
}

export interface ConfiguredRecipientInput {
    orgId: string
    eventCode: string
    channel: string
    recipientConfig: Record<string, any> | null | undefined
    /** Legacy columns on the notification_settings row. */
    setting?: { recipient_users?: string[] | null; recipient_roles?: string[] | null; recipient_custom?: string[] | null } | null
    payload: Record<string, any>
}

export function splitConfiguredRecipients(value?: string | null): string[] {
    return String(value || '')
        .split(/[\n,;]+/)
        .map((entry) => entry.trim())
        .filter(Boolean)
}

/** Phone channels store E.164 where parseable; email is kept as entered. */
export function normalizeRecipientAddress(channel: string, value: unknown): string {
    let normalized = String(value || '').trim()
    if (!normalized) return ''
    if (channel !== 'email') {
        const parsed = toSmsE164(normalized)
        if ('e164' in parsed) normalized = parsed.e164
    }
    return normalized
}

class RecipientList {
    private readonly byAddress = new Map<string, ResolvedRecipient>()
    constructor(private readonly channel: string) {}
    add(values: Array<string | null | undefined>, source: RecipientSource, meta: Array<{ name?: string | null; userId?: string | null }> = []) {
        values.forEach((value, index) => {
            const address = normalizeRecipientAddress(this.channel, value)
            if (!address || this.byAddress.has(address)) return
            this.byAddress.set(address, { address, source, name: meta[index]?.name ?? null, userId: meta[index]?.userId ?? null })
        })
    }
    list() { return Array.from(this.byAddress.values()) }
}

/**
 * Every configured source except the creator-only shortcut. Roles are always
 * limited to `orgId`, the organization that owns the notification setting.
 */
export async function collectConfiguredRecipients(supabase: any, input: ConfiguredRecipientInput): Promise<ResolvedRecipient[]> {
    const { orgId, eventCode, channel, payload, setting } = input
    const recipientConfig = input.recipientConfig || {}
    const targets = resolveRecipientTargets(eventCode, recipientConfig)
    const recipientTargets = recipientConfig.recipient_targets || {}
    const list = new RecipientList(channel)
    const contactOf = (user: { phone?: string | null; email?: string | null }) => (channel === 'email' ? user.email : user.phone)

    if (targets.order_creator) {
        list.add([channel === 'email' ? ownerEmailFromPayload(payload) : ownerPhoneFromPayload(payload)], 'order_creator', [{ name: payload.created_by || null, userId: payload.created_by_id || null }])
    }

    const configUsers = recipientConfig.recipient_users
    const legacyUsers = setting?.recipient_users
    const userIds = configUsers?.length ? configUsers : legacyUsers?.length ? legacyUsers : []
    if (targets.users && userIds.length) {
        const { data: users } = await supabase.from('users').select('id, full_name, phone, email').in('id', userIds).eq('is_active', true)
        if (users) list.add(users.map(contactOf), 'users', users.map((user: any) => ({ name: user.full_name, userId: user.id })))
    }

    const configuredRoles = Array.isArray(recipientConfig.roles) && recipientConfig.roles.length > 0
        ? recipientConfig.roles
        : Array.isArray(setting?.recipient_roles) && setting!.recipient_roles!.length > 0
            ? setting!.recipient_roles!
            : []
    const resolvedRoleCodes = expandNotificationRoleCodes(configuredRoles)
    const hasExplicitRecipientTargets = Object.keys(recipientTargets).length > 0
    const rolesEnabled = targets.roles && configuredRoles.length > 0 && (
        hasExplicitRecipientTargets
            ? recipientTargets.roles === true
            : recipientConfig.type === 'roles' || Boolean(setting?.recipient_roles?.length)
    )
    if (rolesEnabled && resolvedRoleCodes.length > 0) {
        const { data: roleUsers } = await supabase
            .from('users')
            .select('id, full_name, phone, email')
            .eq('organization_id', orgId)
            .in('role_code', resolvedRoleCodes)
            .eq('is_active', true)
        if (roleUsers) list.add(roleUsers.map(contactOf), 'roles', roleUsers.map((user: any) => ({ name: user.full_name, userId: user.id })))
    }

    if (setting?.recipient_custom?.length) list.add(setting.recipient_custom, 'saved_list')

    if (channel === 'email') {
        list.add(splitConfiguredRecipients(recipientConfig.custom_emails), 'saved_list')
        if (Array.isArray(recipientConfig.manual_email_addresses)) {
            list.add(normalizeAndDedupeManualEmails(recipientConfig.manual_email_addresses), 'manual_email')
        }
    } else {
        list.add(splitConfiguredRecipients(recipientConfig.custom_phones), 'saved_list')
    }

    if (channel === 'sms' && targets.consumer) {
        list.add([payload.customer_phone, payload.contact_phone, payload.phone, payload.phone_number], 'consumer')
    }

    if (channel === 'whatsapp' && Array.isArray(recipientConfig.manual_whatsapp_numbers)) {
        list.add(normalizeAndDedupeManualPhones(recipientConfig.manual_whatsapp_numbers), 'manual_whatsapp')
    }

    return list.list()
}

export interface PreviewRecipientInput extends ConfiguredRecipientInput {
    /** The address the producer queues on the outbox row itself. */
    eventAddress?: { phone?: string | null; email?: string | null }
}

/**
 * Who the worker would send this channel to: the creator-only shortcut, or
 * every configured source plus the row's own queued address.
 */
export async function previewNotificationRecipients(supabase: any, input: PreviewRecipientInput): Promise<ResolvedRecipient[]> {
    const { channel, eventCode, payload } = input
    const eventAddress = channel === 'email' ? input.eventAddress?.email : input.eventAddress?.phone
    if (isSingleCreatorSource(eventCode, input.recipientConfig)) {
        const list = new RecipientList(channel)
        const owner = channel === 'email' ? ownerEmailFromPayload(payload) || eventAddress : ownerPhoneFromPayload(payload)
        list.add([owner], 'order_creator', [{ name: payload.created_by || null, userId: payload.created_by_id || null }])
        return list.list()
    }
    const configured = await collectConfiguredRecipients(supabase, input)
    const list = new RecipientList(channel)
    configured.forEach((recipient) => list.add([recipient.address], recipient.source, [recipient]))
    list.add([eventAddress], 'event_address')
    return list.list()
}

/** Configured sources that no sender uses, so a preview must not imply them. */
export function sourcesNotUsedWhenSending(recipientConfig: Record<string, any> | null | undefined): string[] {
    const targets = recipientConfig?.recipient_targets || {}
    return targets.dynamic_org ? ['dynamic_org'] : []
}
