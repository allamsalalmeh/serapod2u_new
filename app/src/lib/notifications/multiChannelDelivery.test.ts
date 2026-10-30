import { describe, expect, it } from 'vitest'
import {
  deliveryChainForPreset,
  independentChannelsForPreset,
  isFallbackRoutingPreset,
  isMultiChannelPreset,
  nextFallbackChannels,
  resolveNotificationRoutingPreset,
} from './routing'
import { channelFanoutTargets } from './channelFanout'
import { PRESET_LABELS } from './notificationTypeModules'

const providers = (...channels: string[]) => channels.map((channel) => ({ channel, providerName: `${channel}-provider` }))

describe('independent channels versus ordered fallback', () => {
  it('a fallback preset tries channels in turn; a multi-channel preset sends each', () => {
    expect(isFallbackRoutingPreset('whatsapp_sms_email_fallback')).toBe(true)
    expect(isMultiChannelPreset('whatsapp_sms_email_fallback')).toBe(false)
    expect(nextFallbackChannels('whatsapp_sms_email_fallback', 'whatsapp')).toEqual(['sms', 'email'])

    expect(isMultiChannelPreset('whatsapp_sms')).toBe(true)
    expect(isFallbackRoutingPreset('whatsapp_sms')).toBe(false)
    expect(independentChannelsForPreset('whatsapp_sms')).toEqual(['whatsapp', 'sms'])
    // A failed WhatsApp send never adds another channel for an independent preset.
    expect(nextFallbackChannels('whatsapp_sms', 'whatsapp')).toEqual([])
    expect(deliveryChainForPreset('whatsapp_sms')).toEqual(['whatsapp', 'sms'])
  })

  it('labels fallbacks with arrows and independent channels with plus', () => {
    expect(PRESET_LABELS.whatsapp_sms_email_fallback).toBe('WhatsApp → SMS → Email')
    expect(PRESET_LABELS.whatsapp_sms).toBe('WhatsApp + SMS')
  })

  it('never converts a saved fallback preset into a multi-channel send', () => {
    const fallback = { recipient_config: { routing: { preset: 'whatsapp_email_fallback' } }, channels_enabled: ['whatsapp'] }
    expect(resolveNotificationRoutingPreset(fallback)).toBe('whatsapp_email_fallback')
    // Legacy rows without a saved preset keep their old inference.
    expect(resolveNotificationRoutingPreset({ channels_enabled: ['whatsapp', 'email'] })).toBe('whatsapp_email_fallback')
    expect(isMultiChannelPreset(resolveNotificationRoutingPreset({ channels_enabled: ['whatsapp', 'sms'] }))).toBe(false)
    expect(channelFanoutTargets({ preset: 'whatsapp_email_fallback', currentChannel: 'whatsapp', existingChannels: [], activeProviders: providers('whatsapp', 'email') })).toEqual([])
    expect(channelFanoutTargets({ preset: 'sms_only', currentChannel: 'sms', existingChannels: [], activeProviders: providers('sms', 'whatsapp') })).toEqual([])
  })

  it('a multi-channel preset queues each missing channel once, only where a provider is active', () => {
    const preset = 'whatsapp_sms_email' as const
    expect(channelFanoutTargets({ preset, currentChannel: 'whatsapp', existingChannels: [], activeProviders: providers('whatsapp', 'sms', 'email') }))
      .toEqual([{ channel: 'sms', providerName: 'sms-provider' }, { channel: 'email', providerName: 'email-provider' }])
    // The producer already queued SMS: only Email is added.
    expect(channelFanoutTargets({ preset, currentChannel: 'whatsapp', existingChannels: ['whatsapp', 'sms'], activeProviders: providers('whatsapp', 'sms', 'email') }))
      .toEqual([{ channel: 'email', providerName: 'email-provider' }])
    // No email provider: email is skipped, not substituted.
    expect(channelFanoutTargets({ preset, currentChannel: 'whatsapp', existingChannels: [], activeProviders: providers('whatsapp', 'sms') }))
      .toEqual([{ channel: 'sms', providerName: 'sms-provider' }])
    // A row on a channel outside the preset never fans out.
    expect(channelFanoutTargets({ preset: 'whatsapp_sms', currentChannel: 'email', existingChannels: [], activeProviders: providers('whatsapp', 'sms', 'email') })).toEqual([])
  })
})
