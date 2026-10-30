import { describe, expect, it } from 'vitest'
import { RESOLVED_RECIPIENT_KEY, fanoutChildPayload, fanoutScope, keepsQueuedAddress, selectFanoutRecipients } from './outboxFanout'
import { fetchRecipientUsers, idsToHydrate, recipientUserChips, recipientUserSearchTerm, type RecipientUser } from './recipientUsers'
import { CATEGORY_MODULE, DISPLAY_GROUPS, EVENT_DISPLAY_GROUP, allowsMultiChannelDelivery, groupByModule, resolveEventDelivery } from './notificationTypeModules'
import { asksReaderToApprove, partnerDefaultTemplate } from './partnerTemplates'

describe('retries and fan-out keep an auditable destination', () => {
  it('a row being retried keeps the address it was resolved to', () => {
    expect(keepsQueuedAddress({ payload: {}, channel: 'sms', toPhone: '+60123456001', retryCount: 1 })).toBe(true)
    expect(keepsQueuedAddress({ payload: {}, channel: 'email', toEmail: 'a@b.test', retryCount: 2 })).toBe(true)
    // First attempt (or nothing resolved yet): resolve from current settings.
    expect(keepsQueuedAddress({ payload: {}, channel: 'sms', toPhone: '+60123456001', retryCount: 0 })).toBe(false)
    expect(keepsQueuedAddress({ payload: {}, channel: 'sms', toPhone: null, retryCount: 3 })).toBe(false)
    // A fan-out child keeps its own address even on its first attempt.
    expect(keepsQueuedAddress({ payload: fanoutChildPayload({}), channel: 'whatsapp', toPhone: '+60123456002', retryCount: 0 })).toBe(true)
  })

  it('fan-out children record who they were resolved to and never inherit the origin audit', () => {
    const origin = { order_no: 'SO1', [RESOLVED_RECIPIENT_KEY]: { source: 'users', name: 'Sam' } }
    const child = fanoutChildPayload(origin, { source: 'related_org', name: 'Eariel Distributor', org_id: 'dist-eariel', user_id: null })
    expect(child[RESOLVED_RECIPIENT_KEY]).toMatchObject({ source: 'related_org', org_id: 'dist-eariel' })
    expect(typeof child[RESOLVED_RECIPIENT_KEY].resolved_at).toBe('string')
    expect(fanoutChildPayload(origin)[RESOLVED_RECIPIENT_KEY]).toBeUndefined()
  })

  it('does not queue a recipient twice, including after a re-run', () => {
    const list = ['+60123456001', '+60128888888', '0123456001']
    expect(selectFanoutRecipients({ recipientList: list, channel: 'whatsapp', payload: {} })).toEqual(['+60128888888'])
    expect(selectFanoutRecipients({ recipientList: list, channel: 'whatsapp', payload: {}, existingSiblings: [{ to_phone: '+60128888888' }] })).toEqual([])
    expect(selectFanoutRecipients({ recipientList: list, channel: 'whatsapp', payload: fanoutChildPayload({}) })).toEqual([])
  })

  it('two documents of one order are separate notifications', () => {
    expect(fanoutScope({ order_no: 'ORD-1', doc_no: 'PAY-1-DEP' })).toEqual({ order_no: 'ORD-1', doc_no: 'PAY-1-DEP' })
    expect(fanoutScope({ order_no: 'ORD-1' })).toEqual({ order_no: 'ORD-1' })
  })
})

describe('Specific users show names, not UUIDs', () => {
  const A = '11111111-1111-4111-8111-111111111111'
  const B = '22222222-2222-4222-8222-222222222222'
  const GONE = '33333333-3333-4333-8333-333333333333'

  it('after reopening the drawer every saved ID is looked up and shown by name', async () => {
    // Reopening mounts fresh: nothing is known yet, so all saved IDs need a lookup.
    const known = new Map<string, RecipientUser>()
    const unavailable = new Set<string>()
    expect(idsToHydrate([A, B, GONE], known, unavailable)).toEqual([A, B, GONE])
    expect(recipientUserChips([A], known, unavailable)[0]).toMatchObject({ state: 'loading', label: 'Loading…' })

    const urls: string[] = []
    const result = await fetchRecipientUsers([A, B, GONE], async (url) => {
      urls.push(url)
      return { ok: true, json: async () => ({ users: [{ id: A, full_name: 'Aina Abdullah', email: 'aina@serapod.test', phone: '+60121111111' }, { id: B, full_name: '', email: 'ben@serapod.test', phone: null, is_active: false }], unavailable: [GONE] }) }
    })
    // Hydration uses the notifications lookup, not the user-management API.
    expect(urls[0]).toMatch(/^\/api\/notifications\/recipient-users\?ids=/)
    result.users.forEach((user) => known.set(user.id, user))
    result.unavailable.forEach((id) => unavailable.add(id))

    const chips = recipientUserChips([A, B, GONE], known, unavailable)
    expect(chips.map((chip) => [chip.state, chip.label])).toEqual([
      ['loaded', 'Aina Abdullah'],
      ['loaded', 'ben'],
      ['unavailable', 'Unavailable user'],
    ])
    expect(chips[0].detail).toBe('aina@serapod.test · +60121111111')
    expect(chips[1].detail).toContain('inactive')
    expect(JSON.stringify(chips.map((chip) => chip.label))).not.toMatch(/[0-9a-f]{8}-/)
    expect(idsToHydrate([A, B, GONE], known, unavailable)).toEqual([])
  })

  it('a failed or forbidden lookup keeps the selection and invents nothing', async () => {
    const denied = await fetchRecipientUsers(['x'], async () => ({ ok: false, json: async () => ({ error: 'Forbidden' }) }))
    expect(denied).toEqual({ users: [], unavailable: [], error: 'Forbidden' })
  })

  it('search text cannot change the filter', () => {
    expect(recipientUserSearchTerm('ali),role_code.eq.SUPER')).toBe('alirole_code.eq.SUPER')
    expect(recipientUserSearchTerm('  Siti % *  ')).toBe('Siti')
  })
})

describe('Notification Types display groups', () => {
  const type = (category: string, event_code: string) => ({ category, event_code, event_name: event_code, event_description: '' })
  const events = [
    type('order', 'order_submitted'), type('order', 'order_approved'), type('order', 'order_rejected'), type('order', 'order_closed'),
    type('order', 'qr_batch_generated'), type('order', 'manufacturer_scan_complete'), type('order', 'warehouse_received'),
    type('document', 'po_created'), type('document', 'po_acknowledged'), type('document', 'invoice_created'), type('document', 'payment_received'), type('document', 'receipt_issued'),
    type('inventory', 'low_stock_alert'), type('return', 'return_submitted'),
  ]

  it('splits Supply Chain into the agreed groups, keeps Inventory and Returns, lists every event once', () => {
    const [supply] = groupByModule(events)
    expect(supply.categories.map((group) => group.label)).toEqual(['Sales Orders', 'Purchase Orders', 'Production & Receiving', 'Documents & Payments', 'Inventory & Stock', 'Returns'])
    const listed = supply.categories.flatMap((group) => group.types.map((t) => t.event_code))
    expect(listed.sort()).toEqual(events.map((t) => t.event_code).sort())
    expect(new Set(listed).size).toBe(listed.length)
  })

  it('every group routes through the stored category, so regrouping keeps saved routes', () => {
    const [supply] = groupByModule(events)
    const byLabel = Object.fromEntries(supply.categories.map((group) => [group.label, group]))
    expect(byLabel['Sales Orders'].routingCategory).toBe('order')
    expect(byLabel['Production & Receiving'].routingCategory).toBe('order')
    expect(byLabel['Purchase Orders'].routingCategory).toBe('document')
    expect(byLabel['Documents & Payments'].routingCategory).toBe('document')
    expect(byLabel['Sales Orders'].sharesRoutingWith).toEqual(['Production & Receiving'])

    // Saved routing before the change: Order Status = SMS, Order Document = Email, one custom event.
    const saved = { defaultPreset: 'whatsapp_email_fallback' as const, categoryPresets: { order: 'sms_only' as const, document: 'email_only' as const }, eventPresets: { po_acknowledged: 'whatsapp_only' as const } }
    const effective = Object.fromEntries(events.map((t) => [t.event_code, resolveEventDelivery(t, saved)]))
    expect(effective.order_submitted).toEqual({ preset: 'sms_only', source: 'category' })
    expect(effective.warehouse_received).toEqual({ preset: 'sms_only', source: 'category' })
    expect(effective.po_created).toEqual({ preset: 'email_only', source: 'category' })
    expect(effective.receipt_issued).toEqual({ preset: 'email_only', source: 'category' })
    expect(effective.po_acknowledged).toEqual({ preset: 'whatsapp_only', source: 'custom' })
    expect(effective.low_stock_alert).toEqual({ preset: 'whatsapp_email_fallback', source: 'default' })
  })

  it('an event whose stored category differs from its usual group stays under its own category', () => {
    const sections = groupByModule([type('inventory', 'warehouse_received')])
    expect(sections[0].categories.map((group) => [group.label, group.routingCategory])).toEqual([['Inventory & Stock', 'inventory']])
  })

  it('every display group belongs to Supply Chain and only order/document routing offers multi-channel', () => {
    Object.values(DISPLAY_GROUPS).forEach((group) => expect(CATEGORY_MODULE[group.routingCategory]).toBe('supply_chain'))
    Object.values(EVENT_DISPLAY_GROUP).forEach((group) => expect(DISPLAY_GROUPS[group]).toBeDefined())
    expect(allowsMultiChannelDelivery('order')).toBe(true)
    expect(allowsMultiChannelDelivery('document')).toBe(true)
    expect(allowsMultiChannelDelivery('security')).toBe(false)
  })
})

describe('external-facing wording', () => {
  it('the partner default for Order Submitted does not ask a distributor/manufacturer to approve', () => {
    for (const channel of ['whatsapp', 'sms', 'email']) {
      const body = partnerDefaultTemplate('order_submitted', channel)!
      expect(body).toContain('HQ')
      expect(asksReaderToApprove(body)).toBe(false)
    }
    expect(partnerDefaultTemplate('order_approved', 'whatsapp')).toBeNull()
  })

  it('flags approval wording in a saved template', () => {
    expect(asksReaderToApprove('Order #{{order_no}} — Pending Your Approval')).toBe(true)
    expect(asksReaderToApprove('This order requires your review and approval.')).toBe(true)
    expect(asksReaderToApprove('Order #{{order_no}} approved by {{approved_by}}.')).toBe(false)
  })
})
