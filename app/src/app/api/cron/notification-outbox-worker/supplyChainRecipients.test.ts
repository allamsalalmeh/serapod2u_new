import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { notificationDb, supplyChainWorld, u } from '@/test-support/notificationDb'

/**
 * Outbox worker end to end with mocked providers: no WhatsApp, SMS or email is
 * sent anywhere. Each test queues outbox rows the way the producers do and runs
 * the worker until nothing is pending.
 */

let db: ReturnType<typeof notificationDb>
let world: ReturnType<typeof supplyChainWorld>
const whatsappSends: Array<{ to: string; text: string }> = []
const smsSends: Array<{ to: string; text: string }> = []

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => client() }))
vi.mock('@/lib/cron/auth', () => ({ requireCronAuth: () => null }))
vi.mock('@/lib/cron/lease', () => ({
  WORKER_NAMES: { notificationOutbox: 'notification-outbox' },
  withWorkerLease: async (_db: any, _name: string, run: () => Promise<any>) => ({ status: 'ran', result: await run() }),
}))
vi.mock('@/app/api/settings/whatsapp/_utils', () => ({
  getWhatsAppConfig: async () => ({ provider: 'mock' }),
  callGateway: async () => ({}),
  sendWhatsAppMessage: async (_db: any, _org: string, message: { to: string; text: string }) => {
    whatsappSends.push(message)
    return { response: { ok: true, messageId: `wa-${whatsappSends.length}` } }
  },
}))
vi.mock('@/lib/notifications/sms-send', () => ({
  refreshOpenSmsStatuses: async () => ({ checked: 0, updated: 0, timedOut: false }),
  sendSmsWithActiveProvider: async (_db: any, _org: string, to: string, text: string) => {
    smsSends.push({ to, text })
    return { success: true, messageId: `sms-${smsSends.length}` }
  },
  recordSmsDelivery: async (_db: any, input: { outboxId: string; result: { success: boolean } }) => {
    const row = db.tables.notifications_outbox.find((item) => item.id === input.outboxId)
    if (row) row.status = input.result.success ? 'sent' : 'failed'
  },
}))

/** The db double plus the two RPCs the worker calls. */
function client() {
  return {
    from: db.from,
    rpc: async (name: string, args: any) => {
      if (name === 'get_pending_notifications') {
        return { data: db.tables.notifications_outbox.filter((row) => row.status === 'queued').map((row) => ({ ...row })), error: null }
      }
      if (name === 'log_notification_attempt') {
        const row = db.tables.notifications_outbox.find((item) => item.id === args.p_outbox_id)
        if (row) {
          row.status = args.p_status
          row.error = args.p_error_message || null
          if (args.p_provider_message_id) row.provider_message_id = args.p_provider_message_id
        }
        return { data: null, error: null }
      }
      return { data: null, error: null }
    },
  }
}

const relatedAndUsers = (preset: string, extra: Record<string, any> = {}) => ({
  enabled: true,
  channels_enabled: preset === 'whatsapp_sms' ? ['whatsapp', 'sms'] : ['whatsapp'],
  templates: {},
  recipient_config: {
    dynamic_target: 'transaction_counterparty',
    recipient_users: [u('u-sales')],
    recipient_targets: { dynamic_org: true, users: true, order_creator: false, roles: false, consumer: false },
    routing: { preset, source: 'event' },
    ...extra,
  },
})

function setup(setting: Record<string, any>) {
  world = supplyChainWorld()
  db = notificationDb({
    organizations: world.organizations,
    orders: world.orders,
    documents: world.documents,
    users: world.users,
    notification_settings: [{ id: 'ns-1', org_id: u('hq'), event_code: 'order_submitted', ...setting }],
    notification_provider_configs: [
      { org_id: u('hq'), channel: 'whatsapp', provider_name: 'mock-wa', is_active: true },
      { org_id: u('hq'), channel: 'sms', provider_name: 'mock-sms', is_active: true },
    ],
    notifications_outbox: [],
    message_templates: [],
  })
  whatsappSends.length = 0
  smsSends.length = 0
}

function queue(row: Record<string, any>) {
  db.tables.notifications_outbox.push({
    id: `out-${db.tables.notifications_outbox.length + 1}`, org_id: u('hq'), event_code: 'order_submitted', channel: 'whatsapp',
    to_phone: null, to_email: null, template_code: null, priority: 'normal', provider_name: 'mock-wa', status: 'queued',
    retry_count: 0, max_retries: 3, provider_message_id: null, ...row,
  })
}

async function runWorker() {
  const { GET } = await import('./route')
  for (let pass = 0; pass < 5; pass++) {
    if (!db.tables.notifications_outbox.some((row) => row.status === 'queued')) return
    await GET(new NextRequest('http://localhost/api/cron/notification-outbox-worker'))
  }
}

beforeEach(() => setup(relatedAndUsers('whatsapp_only')))

describe('outbox worker — Related organization and Specific users', () => {
  it('a D2H order reaches its distributor and the selected user, once each', async () => {
    queue({ payload_json: { order_id: u('o-d2h-eariel'), order_no: 'SO26000001', order_type: 'D2H' } })
    await runWorker()
    expect(whatsappSends.map((send) => send.to).sort()).toEqual(['+60123456001', '+60128888888'])
    // The distributor gets the partner wording (approval belongs to HQ); the HQ user gets the normal default.
    const toEariel = whatsappSends.find((send) => send.to === '+60123456001')!
    expect(toEariel.text).toContain('awaiting approval by HQ')
    expect(toEariel.text).not.toMatch(/requires your review and approval/)
    expect(whatsappSends.find((send) => send.to === '+60128888888')!.text).toMatch(/requires your review and approval/)
    // Every row records who it was resolved to.
    const audits = db.tables.notifications_outbox.map((row) => row.payload_json._resolved_recipient?.source).sort()
    expect(audits).toEqual(['related_org', 'users'])
  })

  it('H2M orders to Manufacturer A and B reach A and B respectively', async () => {
    db.tables.notification_settings[0].recipient_config.recipient_targets.users = false
    queue({ payload_json: { order_id: u('o-h2m-a'), order_no: 'PO26000001' } })
    queue({ payload_json: { order_id: u('o-h2m-b'), order_no: 'PO26000002' } })
    await runWorker()
    expect(whatsappSends.map((send) => send.to)).toEqual(['+60123456101', '+60123456102'])
  })

  it('missing organization contact: the selected user still gets it, the reason is recorded, nobody else is substituted', async () => {
    world.organizations.find((org) => org.id === u('dist-eariel'))!.contact_phone = null as any
    queue({ payload_json: { order_id: u('o-d2h-eariel'), order_no: 'SO26000001' } })
    await runWorker()
    expect(whatsappSends.map((send) => send.to)).toEqual(['+60128888888'])
    expect(db.tables.notifications_outbox[0].payload_json._recipient_notes.join(' ')).toMatch(/Eariel Distributor has no contact phone/)
  })

  it('no recipient at all fails with an understandable reason', async () => {
    db.tables.notification_settings[0].recipient_config.recipient_targets.users = false
    world.organizations.find((org) => org.id === u('dist-eariel'))!.contact_phone = null as any
    queue({ payload_json: { order_id: u('o-d2h-eariel'), order_no: 'SO26000001' } })
    await runWorker()
    expect(whatsappSends).toEqual([])
    expect(db.tables.notifications_outbox[0]).toMatchObject({ status: 'failed' })
    expect(db.tables.notifications_outbox[0].error).toMatch(/No recipient resolved\. Eariel Distributor has no contact phone/)
  })

  it('a disabled notification is cancelled, not sent', async () => {
    db.tables.notification_settings[0].enabled = false
    queue({ payload_json: { order_id: u('o-d2h-eariel'), order_no: 'SO26000001' } })
    await runWorker()
    expect(whatsappSends).toEqual([])
    expect(db.tables.notifications_outbox[0]).toMatchObject({ status: 'cancelled' })
  })

  it('a retried row keeps its queued destination even if master data changed', async () => {
    db.tables.notification_settings[0].recipient_config.recipient_targets.users = false
    world.organizations.find((org) => org.id === u('dist-eariel'))!.contact_phone = '+60123450999'
    queue({ to_phone: '+60123456001', retry_count: 1, payload_json: { order_id: u('o-d2h-eariel'), order_no: 'SO26000001', _resolved_recipient: { source: 'related_org', org_id: u('dist-eariel') } } })
    await runWorker()
    expect(whatsappSends.map((send) => send.to)).toEqual(['+60123456001'])
    expect(db.tables.notifications_outbox).toHaveLength(1)
  })

  it('running the worker again sends nothing more', async () => {
    queue({ payload_json: { order_id: u('o-d2h-eariel'), order_no: 'SO26000001' } })
    await runWorker()
    const sent = whatsappSends.length
    await runWorker()
    expect(whatsappSends.length).toBe(sent)
    expect(db.tables.notifications_outbox.filter((row) => row.status === 'sent')).toHaveLength(2)
  })
})

describe('outbox worker — independent channels', () => {
  it('WhatsApp + SMS sends the event on both channels, each recipient once per channel', async () => {
    setup(relatedAndUsers('whatsapp_sms'))
    queue({ payload_json: { order_id: u('o-d2h-eariel'), order_no: 'SO26000001' } })
    await runWorker()
    expect(whatsappSends.map((send) => send.to).sort()).toEqual(['+60123456001', '+60128888888'])
    expect(smsSends.map((send) => send.to).sort()).toEqual(['+60123456001', '+60128888888'])
  })

  it('a fallback preset sends only the first channel when it succeeds', async () => {
    setup(relatedAndUsers('whatsapp_sms_email_fallback'))
    queue({ payload_json: { order_id: u('o-d2h-eariel'), order_no: 'SO26000001' } })
    await runWorker()
    expect(whatsappSends).toHaveLength(2)
    expect(smsSends).toEqual([])
  })

  it('order_approved under WhatsApp + SMS keeps both channels instead of cancelling SMS', async () => {
    setup(relatedAndUsers('whatsapp_sms'))
    db.tables.notification_settings[0].event_code = 'order_approved'
    queue({ event_code: 'order_approved', payload_json: { order_id: u('o-h2m-a'), order_no: 'PO26000001' } })
    await runWorker()
    expect(whatsappSends.map((send) => send.to).sort()).toEqual(['+60123456101', '+60128888888'])
    expect(smsSends.map((send) => send.to).sort()).toEqual(['+60123456101', '+60128888888'])
  })
})
