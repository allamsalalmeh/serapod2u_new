export type NotificationRoutingPreset =
    | 'whatsapp_only'
    | 'email_only'
    | 'sms_only'
    | 'whatsapp_email_fallback'
    | 'whatsapp_sms_email_fallback'
    // Independent channels: every listed channel is sent, none waits for another to fail.
    | 'whatsapp_sms'
    | 'whatsapp_email'
    | 'sms_email'
    | 'whatsapp_sms_email'

export type NotificationDeliveryChannel = 'whatsapp' | 'sms' | 'email'

export const DELETE_USER_OTP_DEFAULT_PRESET: NotificationRoutingPreset = 'whatsapp_sms_email_fallback'

const VALID_PRESETS: NotificationRoutingPreset[] = [
    'whatsapp_only',
    'email_only',
    'sms_only',
    'whatsapp_email_fallback',
    'whatsapp_sms_email_fallback',
    'whatsapp_sms',
    'whatsapp_email',
    'sms_email',
    'whatsapp_sms_email',
]

const MULTI_CHANNEL_PRESETS: Record<string, NotificationDeliveryChannel[]> = {
    whatsapp_sms: ['whatsapp', 'sms'],
    whatsapp_email: ['whatsapp', 'email'],
    sms_email: ['sms', 'email'],
    whatsapp_sms_email: ['whatsapp', 'sms', 'email'],
}

/**
 * Independent multi-channel presets ("WhatsApp + SMS"): the same event is sent on
 * every listed channel. This is not a fallback — no channel waits for another to
 * fail — and a saved fallback preset is never read as one of these.
 */
export function isMultiChannelPreset(preset: unknown): preset is NotificationRoutingPreset {
    return typeof preset === 'string' && preset in MULTI_CHANNEL_PRESETS
}

/** Channels a preset sends on independently (empty for single-channel and fallback presets). */
export function independentChannelsForPreset(preset: NotificationRoutingPreset): NotificationDeliveryChannel[] {
    return [...(MULTI_CHANNEL_PRESETS[preset] || [])]
}

export function isNotificationRoutingPreset(value: unknown): value is NotificationRoutingPreset {
    return typeof value === 'string' && VALID_PRESETS.includes(value as NotificationRoutingPreset)
}

/**
 * Full send order. Outbox queueing starts at the first hop; the worker
 * advances to later hops only after the current hop fails.
 */
export function deliveryChainForPreset(preset: NotificationRoutingPreset): NotificationDeliveryChannel[] {
    // Multi-channel presets list their channels; they are all sent, not tried in turn.
    if (isMultiChannelPreset(preset)) return independentChannelsForPreset(preset)
    if (preset === 'email_only') return ['email']
    if (preset === 'sms_only') return ['sms']
    if (preset === 'whatsapp_only') return ['whatsapp']
    if (preset === 'whatsapp_email_fallback') return ['whatsapp', 'email']
    return ['whatsapp', 'sms', 'email']
}

const EXCLUSIVE_PRESETS: NotificationRoutingPreset[] = ['sms_only', 'email_only', 'whatsapp_only']

export function isFallbackRoutingPreset(preset: NotificationRoutingPreset): boolean {
    return preset === 'whatsapp_email_fallback' || preset === 'whatsapp_sms_email_fallback'
}

export function isRoutingFallbackPayload(payload: Record<string, unknown> | null | undefined): boolean {
    const row = payload || {}
    return Boolean(row._routing_fallback || row._routing_fallback_for || row._routing_fallback_reason)
}

export function nextFallbackChannels(
    preset: NotificationRoutingPreset,
    failedChannel: NotificationDeliveryChannel,
): NotificationDeliveryChannel[] {
    // Independent channels already have their own rows; a failure never adds another channel.
    if (isMultiChannelPreset(preset)) return []
    const chain = deliveryChainForPreset(preset)
    const index = chain.indexOf(failedChannel)
    if (index < 0) return []
    return chain.slice(index + 1)
}

export function firstAvailableDeliveryChannel(
    preset: NotificationRoutingPreset,
    activeChannels: Iterable<string>,
): NotificationDeliveryChannel | null {
    const available = new Set(activeChannels)
    return deliveryChainForPreset(preset).find((channel) => available.has(channel)) || null
}

/** Queue the next hop when this attempt is terminal, or the provider is missing. */
export function shouldAdvanceFallback(input: {
    retryCount?: number | null
    maxRetries?: number | null
    outboxStatus?: string | null
    providerMissing?: boolean
}): boolean {
    if (input.providerMissing) return true
    const status = String(input.outboxStatus || '')
    if (status === 'failed' || status === 'cancelled') return true
    const retryCount = Number(input.retryCount || 0)
    const maxRetries = Number(input.maxRetries ?? 3)
    return retryCount + 1 >= maxRetries
}

/**
 * Destructive OTP routing. Prefer an explicit saved preset.
 * Do not infer from channels_enabled — the Types UI stores only the first hop there.
 *
 * Effective order matches Notification Types: event override, then category
 * (e.g. Security & OTP = SMS Only), then Default Delivery.
 * A leftover catalog 3-step event override must not hide an exclusive category.
 */
export function resolveDeleteUserOtpPreset(setting: unknown): NotificationRoutingPreset {
    const routing = (setting as {
        recipient_config?: {
            routing?: {
                preset?: unknown
                source?: unknown
                default_preset?: unknown
                category_preset?: unknown
            }
        }
    } | null)?.recipient_config?.routing

    const eventPreset = isNotificationRoutingPreset(routing?.preset) ? routing.preset : null
    const defaultPreset = isNotificationRoutingPreset(routing?.default_preset) ? routing.default_preset : null
    const categoryPreset = isNotificationRoutingPreset(routing?.category_preset) ? routing.category_preset : null
    const source = routing?.source

    if (source === 'event' && eventPreset && EXCLUSIVE_PRESETS.includes(eventPreset)) {
        return eventPreset
    }
    if (
        eventPreset === DELETE_USER_OTP_DEFAULT_PRESET
        && categoryPreset
        && EXCLUSIVE_PRESETS.includes(categoryPreset)
    ) {
        return categoryPreset
    }
    if (source === 'event' && eventPreset) {
        if (defaultPreset && EXCLUSIVE_PRESETS.includes(defaultPreset)) return defaultPreset
        return eventPreset
    }
    if (categoryPreset) return categoryPreset
    if (defaultPreset) return defaultPreset
    if (eventPreset) return eventPreset
    return DELETE_USER_OTP_DEFAULT_PRESET
}

export function resolveNotificationRoutingPreset(setting: any, useSavedDefault = false): NotificationRoutingPreset {
    const routing = setting?.recipient_config?.routing
    const preset = useSavedDefault ? routing?.default_preset || routing?.preset : routing?.preset
    if (
        preset === 'whatsapp_only'
        || preset === 'email_only'
        || preset === 'sms_only'
        || preset === 'whatsapp_email_fallback'
        || preset === 'whatsapp_sms_email_fallback'
        || isMultiChannelPreset(preset)
    ) {
        return preset
    }

    const channels = Array.isArray(setting?.channels_enabled) ? setting.channels_enabled : []
    if (channels.includes('whatsapp') && channels.includes('email')) return 'whatsapp_email_fallback'
    if (channels.includes('email')) return 'email_only'
    if (channels.includes('sms')) return 'sms_only'
    return 'whatsapp_only'
}
