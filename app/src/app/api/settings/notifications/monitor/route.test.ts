import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/security-access/operation', async () => (await import('@/test-support/sa-legacy-mode')).operationModule)
vi.mock('@/lib/notifications/smsMonitorAccess', () => ({ canViewSmsMonitor: async () => smsAllowed }))
vi.mock('@/lib/notifications/emailMonitorAccess', () => ({ canViewEmailMonitor: async () => true }))
vi.mock('@/lib/notifications/monitorScope', async (original) => ({
  ...(await original<any>()),
  loadMonitorViewer: async () => viewer,
}))
vi.mock('@/app/api/settings/whatsapp/_utils', () => ({ isAdminUser: async () => waAdmin }))
vi.mock('@/lib/wa-recovery/contact-resolver', () => ({ resolveRecoveryContacts: async () => ({}) }))
vi.mock('@/lib/wa-recovery/template-store', () => ({
  loadRecoveryTemplates: async () => [],
  pickRecoveryTemplate: () => ({ key: 'recovery_notice', name: 'System restored', body: 'Hi' }),
}))

let smsAllowed = true
let viewer: any = { organizationId: 'org-1', orgTypeCode: 'HQ', roleCode: 'admin', roleLevel: 10 }
let waAdmin = true
const calls: Array<{ table: string; op: string; args: unknown[] }> = []
let tables: Record<string, any[]> = {}

function query(table: string) {
  const q: any = {}
  for (const op of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'limit']) {
    q[op] = (...args: unknown[]) => { calls.push({ table, op, args }); return q }
  }
  q.single = async () => ({ data: { organization_id: 'org-1' }, error: null })
  q.then = (resolve: (value: any) => void) => resolve({ data: tables[table] || [], error: null })
  return q
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: query }) }))

async function get(params: Record<string, string>) {
  const { GET } = await import('./route')
  const response = await GET(new NextRequest(`http://localhost/api/settings/notifications/monitor?${new URLSearchParams(params)}`))
  return { status: response.status, response }
}

const log = (id: string, eventCode: string, status: string, createdAt: string, extra: Record<string, unknown> = {}) => ({ id, event_code: eventCode, status, created_at: createdAt, recipient_value: '+60123456789', provider_name: 'local_my', outbox_id: null, ...extra })

beforeEach(() => {
  smsAllowed = true
  waAdmin = true
  viewer = { organizationId: 'org-1', orgTypeCode: 'HQ', roleCode: 'admin', roleLevel: 10 }
  calls.length = 0
  tables = {
    notification_types: [
      { event_code: 'order_submitted', event_name: 'Order Submitted', category: 'order' },
      { event_code: 'user_created_shop', event_name: 'User Create New Shop', category: 'user' },
    ],
    notification_logs: [
      log('1', 'order_submitted', 'failed', '2026-10-01T03:00:00Z', { error_message: 'Gateway timeout' }),
      log('2', 'order_submitted', 'delivered', '2026-10-01T02:00:00Z'),
      log('3', 'user_created_shop', 'sent', '2026-10-01T01:00:00Z'),
      log('4', 'old_sms_event', 'failed', '2026-10-01T00:30:00Z'),
    ],
    notifications_outbox: [],
    organizations: [],
    notification_provider_configs: [{ provider_name: 'local_my', is_active: true, last_test_status: 'success', last_test_at: null, last_test_error: null }],
  }
})

describe('GET /api/settings/notifications/monitor', () => {
  it('limits every source to the Malaysia-time date range in the database', async () => {
    await get({ channel: 'sms', from: '2026-10-01', to: '2026-10-01' })
    const logBounds = calls.filter((call) => call.table === 'notification_logs' && (call.op === 'gte' || call.op === 'lte')).map((call) => [call.op, ...call.args])
    expect(logBounds).toEqual([['gte', 'created_at', '2026-09-30T16:00:00.000Z'], ['lte', 'created_at', '2026-10-01T15:59:59.999Z']])
    expect(calls.some((call) => call.table === 'notifications_outbox' && call.op === 'gte')).toBe(true)
  })

  it('returns counts for the same filters as the table, before the status filter', async () => {
    const { response } = await get({ channel: 'sms', from: '2026-10-01', to: '2026-10-01', module: 'supply_chain', status: 'failed' })
    const body = await response.json()
    expect(body.total).toBe(1)
    expect(body.rows.map((row: any) => row.notificationName)).toEqual(['Order Submitted'])
    expect(body.statusCounts).toMatchObject({ failed: 1, delivered: 1, sent: 0, pending: 0 })
    expect(body.matchingBeforeStatus).toBe(2)
    expect(body.statuses).not.toContain('read')
    expect(body.capabilityNote).toMatch(/delivery report/)
    expect(body.facets.modules.map((m: any) => m.label)).toEqual(['Platform & Security', 'Supply Chain', 'Other / Unmapped'])
  })

  it('keeps historical unmapped events reachable', async () => {
    const body = await (await get({ channel: 'sms', from: '2026-10-01', to: '2026-10-01', module: 'unmapped' })).response.json()
    expect(body.rows.map((row: any) => [row.eventCode, row.moduleName])).toEqual([['old_sms_event', 'Other / Unmapped']])
  })

  it('exports every matching row as CSV, ignoring pagination', async () => {
    const { response } = await get({ channel: 'sms', from: '2026-10-01', to: '2026-10-01', pageSize: '1', format: 'csv' })
    const csv = await response.text()
    expect(response.headers.get('content-type')).toContain('text/csv')
    expect(csv.trim().split('\n')).toHaveLength(5)
  })

  it('applies each channel\'s existing access rule', async () => {
    smsAllowed = false
    expect((await get({ channel: 'sms' })).status).toBe(403)
    waAdmin = false
    expect((await get({ channel: 'whatsapp' })).status).toBe(403)
  })

  it('lists failed WhatsApp recovery targets across all pages, never recovery messages that are not failed', async () => {
    tables.notification_events = [
      { id: 'e1', created_at: '2026-10-01T03:00:00Z', status: 'failed', recipient_phone: '+60111111111', event_type: 'password_reset_otp_sent', purpose: 'password_reset', meta: {} },
      { id: 'e2', created_at: '2026-10-01T02:00:00Z', status: 'recovery_sent', recipient_phone: '+60111111111', event_type: 'wa_recovery', purpose: 'password_reset_recovery', meta: {} },
    ]
    tables.notification_logs = []
    const body = await (await get({ channel: 'whatsapp', from: '2026-10-01', to: '2026-10-01', targets: 'failed', pageSize: '1' })).response.json()
    expect(body.targets.map((target: any) => target.action.sourceRecordId)).toEqual(['e1'])
    const view = await (await get({ channel: 'whatsapp', from: '2026-10-01', to: '2026-10-01' })).response.json()
    expect(view.kindCounts).toEqual({ original: 1, recovery: 1 })
    expect(view.statusCounts.sent).toBe(0)
  })
})

describe('monitor scope (ported from the staging delivery-monitor fix)', () => {
  it('limits a non-HQ viewer to their own organization and labels rows with it', async () => {
    viewer = { organizationId: 'shop-1', orgTypeCode: 'SHOP', roleCode: 'org_admin', roleLevel: 30 }
    tables.organizations = [{ id: 'shop-1', org_name: 'Kedai Alma' }]
    tables.notification_logs = [log('9', 'order_submitted', 'sent', '2026-10-01T03:00:00Z', { org_id: 'shop-1' })]
    const body = await (await get({ channel: 'sms', from: '2026-10-01', to: '2026-10-01' })).response.json()
    expect(calls.some((call) => call.table === 'notification_logs' && call.op === 'in' && call.args[0] === 'org_id' && JSON.stringify(call.args[1]) === '["shop-1"]')).toBe(true)
    expect(body.rows[0].organizationName).toBe('Kedai Alma')
  })

  it('lets an HQ viewer see every organization and denies viewers without monitor rights', async () => {
    await get({ channel: 'email', from: '2026-10-01', to: '2026-10-01' })
    expect(calls.some((call) => call.table === 'notification_logs' && call.op === 'in' && call.args[0] === 'org_id')).toBe(false)
    viewer = { organizationId: 'shop-1', orgTypeCode: 'SHOP', roleCode: 'staff', roleLevel: 60 }
    expect((await get({ channel: 'email' })).status).toBe(403)
  })
})
