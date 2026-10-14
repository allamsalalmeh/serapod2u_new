import { describe, expect, it } from 'vitest'
import { queueNotificationEvent } from './supplyChainEventQueue'

function fakeDb(setting: Record<string, any>) {
  const queued: string[] = []
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: setting }),
  }
  return {
    queued,
    from: () => chain,
    rpc: async (_name: string, args: any) => {
      queued.push(args.p_channel)
      return { data: 'id', error: null }
    },
  }
}

describe('queueNotificationEvent allowedChannels', () => {
  const smsSetting = { enabled: true, channels_enabled: ['sms'], recipient_config: null }

  it('drops an SMS-only setting when SMS is not allowed', async () => {
    const db = fakeDb(smsSetting)
    const outcome = await queueNotificationEvent(db, { orgId: 'org', eventCode: 'tiktok_shop_daily_report', payload: {}, allowedChannels: ['email', 'whatsapp'] })
    expect(db.queued).toEqual([])
    expect(outcome.queuedCount).toBe(0)
  })

  it('still sends an allowed channel', async () => {
    const db = fakeDb({ enabled: true, channels_enabled: ['email'], recipient_config: null })
    await queueNotificationEvent(db, { orgId: 'org', eventCode: 'tiktok_shop_daily_report', payload: {}, allowedChannels: ['email', 'whatsapp'] })
    expect(db.queued).toEqual(['email'])
  })

  it('changes nothing when no restriction is given', async () => {
    const db = fakeDb(smsSetting)
    await queueNotificationEvent(db, { orgId: 'org', eventCode: 'tiktok_shop_daily_report_sms', payload: {} })
    expect(db.queued).toEqual(['sms'])
  })
})
