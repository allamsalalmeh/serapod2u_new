import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// S&A in legacy mode: this suite tests the routes' own rules.
vi.mock('@/lib/security-access/operation', async () => (await import('@/test-support/sa-legacy-mode')).operationModule)
vi.mock('@/lib/security-access/resource-context', async () => (await import('@/test-support/sa-legacy-mode')).resourceContextModule)

const MFG_A = 'org-mfg-a'
const MFG_B = 'org-mfg-b'
const HQ = 'org-hq'
const WH = 'org-wh'

const authGetUser = vi.fn()
const profileSingle = vi.fn()
const queueNotificationEvent = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: authGetUser },
    from: (table: string) => {
      if (table !== 'users') throw new Error(`session client must not touch ${table}`)
      return { select: () => ({ eq: () => ({ single: profileSingle }) }) }
    },
    rpc: () => { throw new Error('session client must not call RPCs') },
  })),
}))

vi.mock('@/lib/notifications/supplyChainEventQueue', () => ({ queueNotificationEvent }))

type Batch = { id: string; status: string; packing_status: string; total_master_codes: number; order_id: string; order: any }
let batch: Batch | null
let updatedRows = 1
const updates: Array<{ table: string; patch: Record<string, unknown> }> = []
const rpcCalls: string[] = []

function builder(table: string) {
  const state = { update: false, head: false }
  const resolve = (mode: 'one' | 'many') => {
    if (state.update) {
      return table === 'qr_batches' ? { data: Array.from({ length: updatedRows }, () => ({ id: batch?.id })), error: null } : { data: null, error: null, count: 0 }
    }
    if (table === 'qr_batches') return { data: batch, error: null }
    if (table === 'qr_master_codes' && state.head) return { count: 195, error: null }
    if (table === 'documents') return { data: { doc_no: 'BP-1' }, error: null }
    if (table === 'orders') return { data: { display_doc_no: 'ORD26000022', order_no: 'ORD-HM-0826-02', buyer_org_id: HQ, company_id: HQ, notes: '' }, error: null }
    return { data: mode === 'one' ? null : [], error: null }
  }
  const chain: any = {
    select: (_columns?: string, options?: { head?: boolean }) => { if (options?.head) state.head = true; return chain },
    update: (patch: Record<string, unknown>) => { state.update = true; updates.push({ table, patch }); return chain },
    eq: () => chain,
    in: () => chain,
    maybeSingle: async () => resolve('one'),
    single: async () => resolve('one'),
    then: (onFulfilled: any, onRejected: any) => Promise.resolve(resolve('many')).then(onFulfilled, onRejected),
  }
  return chain
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    from: (table: string) => builder(table),
    rpc: async (name: string) => {
      rpcCalls.push(name)
      if (name === 'propagate_warehouse_to_master_codes') return { data: [{ cases_updated: 195, warehouse_org_id: WH }], error: null }
      if (name === 'fn_create_balance_payment_request') return { data: 'doc-1', error: null }
      return { data: null, error: { message: `unexpected rpc ${name}` } }
    },
  })),
}))

function post(path: string): NextRequest {
  return new NextRequest(`https://serapod2u.com/api/manufacturer/${path}`, {
    method: 'POST',
    body: JSON.stringify({ batch_id: 'batch-1' }),
    headers: { 'Content-Type': 'application/json' },
  })
}

function signedInAs(orgType: string, orgId: string, isActive = true) {
  authGetUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'mfg@example.com' } }, error: null })
  profileSingle.mockResolvedValue({ data: { is_active: isActive, organization_id: orgId, organizations: { org_type_code: orgType } }, error: null })
}

const ORDER = { id: 'order-1', order_no: 'ORD-HM-0826-02', seller_org_id: MFG_A, buyer_org_id: HQ, company_id: HQ, warehouse_org_id: WH }

async function startPacking() {
  const { POST } = await import('./start-packing/route')
  return POST(post('start-packing'))
}

async function completeProduction() {
  const { POST } = await import('./complete-production/route')
  return POST(post('complete-production'))
}

describe('Manufacturer Scan: Completed Manufacture Process', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    updates.length = 0
    rpcCalls.length = 0
    updatedRows = 1
    batch = { id: 'batch-1', status: 'printing', packing_status: 'idle', total_master_codes: 195, order_id: 'order-1', order: ORDER }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
  })

  it('queues packing for the manufacturer that sells the order', async () => {
    signedInAs('MFG', MFG_A)
    const res = await startPacking()
    expect(res.status).toBe(200)
    expect(updates).toEqual([{ table: 'qr_batches', patch: { packing_status: 'queued' } }])
  })

  it('reports an error instead of claiming success when no row was queued', async () => {
    signedInAs('MFG', MFG_A)
    updatedRows = 0
    expect((await startPacking()).status).toBe(409)
  })

  it('does not let another manufacturer start or complete the batch', async () => {
    signedInAs('MFG', MFG_B)
    expect((await startPacking()).status).toBe(404)
    expect((await completeProduction()).status).toBe(404)
    expect(updates).toEqual([])
    expect(rpcCalls).toEqual([])
  })

  it('forbids an inactive user and a user outside HQ/manufacturer orgs', async () => {
    signedInAs('MFG', MFG_A, false)
    expect((await startPacking()).status).toBe(403)
    signedInAs('WH', WH)
    expect((await completeProduction()).status).toBe(403)
    expect(updates).toEqual([])
  })

  it('leaves an already running batch alone', async () => {
    signedInAs('MFG', MFG_A)
    batch!.packing_status = 'processing'
    const res = await startPacking()
    expect((await res.json()).message).toBe('Packing already in progress')
    expect(updates).toEqual([])
  })

  it('completes production for the selling manufacturer: warehouse propagated, batch completed, balance requested', async () => {
    signedInAs('MFG', MFG_A)
    const res = await completeProduction()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(rpcCalls).toEqual(['propagate_warehouse_to_master_codes', 'fn_create_balance_payment_request'])
    expect(updates.find((u) => u.table === 'qr_batches')?.patch).toMatchObject({ status: 'completed', production_completed_by: 'user-1' })
    expect(queueNotificationEvent).toHaveBeenCalledTimes(1)
  })

  it('fails loudly when the batch row is not updated', async () => {
    signedInAs('MFG', MFG_A)
    updatedRows = 0
    const res = await completeProduction()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('Batch could not be marked as completed')
  })

  it('lets the owning HQ complete it too', async () => {
    signedInAs('HQ', HQ)
    expect((await completeProduction()).status).toBe(200)
  })
})
