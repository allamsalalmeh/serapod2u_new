import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  order: null as any,
  settings: null as any,
  sent: [] as any[],
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const data = () => (table === 'outdoor_customer_message_settings' ? state.settings : state.order)
      const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: data() }) }
      return chain
    },
  }),
}))
vi.mock('@/server/auth/passwordResetService', () => ({ resolveOrgForEmail: async () => 'hq' }))
vi.mock('@/lib/outdoor/auth-return', () => ({ outdoorPublicOrigin: () => 'https://stg.serapod2u.com' }))
vi.mock('@/lib/email/transactional-html-email', () => ({
  sendTransactionalHtmlEmail: async (_admin: any, _org: string, input: any) => {
    state.sent.push(input)
    return { success: true }
  },
}))

import { notifyOutdoorOrderPaid } from './order-paid-email'
import { OUTDOOR_INBOX } from './order-email-shell'

describe('notifyOutdoorOrderPaid', () => {
  beforeEach(() => {
    state.order = {
      order_ref: 'SO-1',
      sales_channel: 'outdoor',
      customer_name: 'Aina',
      customer_email: 'aina@example.com',
      total_amount: 100,
      currency: 'MYR',
      storefront_order_items: [],
    }
    state.settings = null
    state.sent = []
  })

  it('emails the customer and the Outdoor inbox by default', async () => {
    await notifyOutdoorOrderPaid('o1')
    expect(state.sent.map((m) => m.to)).toEqual(['aina@example.com', OUTDOOR_INBOX, 'store@serapod.com'])
  })

  it('still tells the Outdoor inbox when staff switched the customer email off', async () => {
    state.settings = { email_enabled: false, sms_enabled: true }
    await notifyOutdoorOrderPaid('o1')
    expect(state.sent.map((m) => m.to)).toEqual([OUTDOOR_INBOX, 'store@serapod.com'])
  })
})
