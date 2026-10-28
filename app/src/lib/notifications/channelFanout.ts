import { independentChannelsForPreset, isMultiChannelPreset, type NotificationRoutingPreset } from '@/lib/notifications/routing'

/** Marks an outbox row queued by the worker for another independently selected channel. */
export const CHANNEL_FANOUT_MARKER = '_channel_fanout_from'

/**
 * Channels still to queue for an independent multi-channel preset
 * ("WhatsApp + SMS"): selected channels with no row yet for this notification
 * and an active provider. Fallback and single-channel presets never fan out,
 * so a saved fallback is never turned into a multi-channel send.
 */
export function channelFanoutTargets(input: {
    preset: NotificationRoutingPreset
    currentChannel: string
    existingChannels: string[]
    activeProviders: { channel: string; providerName?: string | null }[]
}): { channel: string; providerName: string | null }[] {
    if (!isMultiChannelPreset(input.preset)) return []
    const selected = independentChannelsForPreset(input.preset)
    if (!selected.includes(input.currentChannel as any)) return []
    const present = new Set([input.currentChannel, ...input.existingChannels])
    const providers = new Map(input.activeProviders.map((provider) => [provider.channel, provider.providerName ?? null]))
    return selected
        .filter((channel) => !present.has(channel) && providers.has(channel))
        .map((channel) => ({ channel, providerName: providers.get(channel) ?? null }))
}
