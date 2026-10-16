import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDb, schemaProblems, schemaSnapshot, type FakeDb, type QueryCall, type Row } from '@/test-support/postgrest-fake'

const authGetUser = vi.fn()
const guardUserOperation = vi.fn()
const createAdminClient = vi.fn()
const rpc = vi.fn()
let db: FakeDb

vi.mock('@/lib/security-access/operation', () => ({ guardUserOperation }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: authGetUser }, from: (table: string) => db.from(table), rpc })),
}))

const D2H = '11111111-1111-4111-8111-111111111111'
const D2H_EMPTY = '11111111-1111-4111-8111-222222222222'
const D2H_OTHER = '11111111-1111-4111-8111-333333333333'
const H2M = '22222222-2222-4222-8222-222222222222'
const HIDDEN = '33333333-3333-4333-8333-333333333333'
const WH = '44444444-4444-4444-8444-444444444444'
const WH2 = '55555555-5555-4555-8555-555555555555'

const movement = (reference_id: string, from_organization_id: string, quantity_change: number, movement_type = 'order_fulfillment'): Row =>
  ({ movement_type, reference_type: 'order', reference_id, from_organization_id, quantity_change })
const session = (id: string, source_order_id: string | null, warehouse_org_id: string, master_codes_scanned: string[], validation_status = 'approved'): Row =>
  ({ id, source_order_id, warehouse_org_id, validation_status, master_codes_scanned })
const master = (id: string, batch_id: string, status: string, units: number, warehouse_org_id = WH): Row =>
  ({ id, master_code: `MC-${id}`, batch_id, status, warehouse_org_id, actual_unit_count: units, expected_unit_count: units })
const units = (master_code_id: string, count: number, status = 'shipped_distributor', is_buffer = false): Row[] =>
  Array.from({ length: count }, (_, i) => ({ id: `${master_code_id}-${is_buffer ? 'b' : 'u'}${String(i).padStart(5, '0')}`, master_code_id, status, is_buffer }))

// Visible rows only: anything RLS would hide from the caller is absent.
const fixture = (): Record<string, Row[]> => ({
  orders: [
    { id: D2H, order_type: 'D2H' },
    { id: D2H_EMPTY, order_type: 'D2H' },
    { id: D2H_OTHER, order_type: 'D2H' },
    { id: H2M, order_type: 'H2M' },
  ],
  v_stock_movements_display: [
    movement(D2H, WH, -30),
    movement(D2H, WH, -20),
    movement(D2H, WH, 5), // positive rows are not shipments
    movement(D2H, WH2, -7), // another warehouse
    movement(H2M, WH, -999), // QR-path movement against the H2M production order
    movement(D2H, WH, -4, 'allocation'),
  ],
  qr_validation_reports: [
    session('s1', D2H, WH, ['MC-m1', 'MC-m2']),
    session('s2', D2H, WH, ['MC-m2', 'MC-m3']), // m2 re-listed: counted once
    session('s3', D2H, WH, ['MC-m4'], 'pending'), // not confirmed
    session('s4', D2H, WH2, ['MC-m5']), // other warehouse
    session('s5', null, WH, ['MC-m6']), // phone order: no D2H link
    session('s6', D2H_OTHER, WH, ['MC-m7']), // another D2H order
  ],
  qr_master_codes: [
    master('m1', 'batch-a', 'shipped_distributor', 10),
    master('m2', 'batch-b', 'opened', 10), // second H2M batch; shipped via all its units
    master('m3', 'batch-b', 'warehouse_packed', 10), // 9 units + 1 buffer shipped: not a full case
    master('m4', 'batch-a', 'shipped_distributor', 10),
    master('m5', 'batch-a', 'shipped_distributor', 10, WH2),
    master('m6', 'batch-a', 'shipped_distributor', 10),
    master('m7', 'batch-a', 'shipped_distributor', 10),
  ],
  qr_codes: [
    ...units('m2', 10),
    ...units('m3', 9),
    ...units('m3', 1, 'shipped_distributor', true),
    ...units('m3', 1, 'warehouse_packed'),
  ],
})

const request = (orderId: string, query = `?warehouseId=${WH}`) => [
  { nextUrl: new URL(`http://localhost/api/orders/${orderId}/ship-metrics${query}`) } as any,
  { params: Promise.resolve({ orderId }) },
] as const

const run = async (orderId: string, query?: string) => {
  const { GET } = await import('./route')
  const response = await GET(...request(orderId, query))
  return { response, body: await response.json() }
}

const tablesQueried = () => db.calls.map(call => call.table)

describe('GET /api/orders/[orderId]/ship-metrics (D2H)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db = createFakeDb(fixture())
    authGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    guardUserOperation.mockResolvedValue(null)
  })

  it('rejects anonymous callers before any query', async () => {
    authGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'missing' } })
    const { response } = await run(D2H)
    expect(response.status).toBe(401)
    expect(db.calls).toHaveLength(0)
  })

  it('returns the S&A denial for callers without inventory.report.view', async () => {
    guardUserOperation.mockResolvedValue(new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }))
    const { response } = await run(D2H)
    expect(guardUserOperation).toHaveBeenCalledWith('user-1', 'inventory.report.view')
    expect(response.status).toBe(403)
    expect(db.calls).toHaveLength(0)
  })

  it('rejects a malformed order id', async () => {
    const { response } = await run('not-a-uuid')
    expect(response.status).toBe(400)
    expect(db.calls).toHaveLength(0)
  })

  it('returns 403 for an order the caller cannot see and reads nothing else', async () => {
    const { response } = await run(HIDDEN)
    expect(response.status).toBe(403)
    expect(tablesQueried()).toEqual(['orders'])
  })

  it('refuses H2M orders instead of mixing production into D2H shipping', async () => {
    const { response, body } = await run(H2M)
    expect(response.status).toBe(422)
    expect(body.error).toMatch(/D2H/)
    expect(tablesQueried()).toEqual(['orders'])
  })

  it('requires a valid warehouseId', async () => {
    expect((await run(D2H, '')).response.status).toBe(400)
    expect((await run(D2H, '?warehouseId=x')).response.status).toBe(400)
  })

  it('attributes cases through approved D2H sessions and units through D2H fulfilment movements', async () => {
    const { response, body } = await run(D2H)
    expect(response.status).toBe(200)
    expect(body).toEqual({
      order_id: D2H,
      warehouse_id: WH,
      cases_shipped: 2, // m1 (shipped) + m2 (all units shipped); m3 incomplete without its buffer
      units_shipped: 50, // -30 + -20 from this warehouse; H2M, other warehouse, positive and allocation rows excluded
      cases_received: null,
      units_received: null,
      received_metrics_available: false,
    })

    const sessions = db.calls.find(call => call.table === 'qr_validation_reports')!
    expect(sessions.filters).toEqual([
      { op: 'eq', column: 'source_order_id', value: D2H },
      { op: 'eq', column: 'warehouse_org_id', value: WH },
      { op: 'eq', column: 'validation_status', value: 'approved' },
    ])
    const masters = db.calls.filter(call => call.table === 'qr_master_codes')
    expect(masters).toHaveLength(1)
    expect(masters[0].filters).toContainEqual({ op: 'in', column: 'master_code', value: ['MC-m1', 'MC-m2', 'MC-m3'] })
    expect(masters[0].filters).toContainEqual({ op: 'eq', column: 'warehouse_org_id', value: WH })
    const unitQuery = db.calls.find(call => call.table === 'qr_codes')!
    expect(unitQuery.filters).toContainEqual({ op: 'eq', column: 'is_buffer', value: false })
    // QR batches (H2M production) are never used to attribute D2H shipments.
    expect(tablesQueried()).not.toContain('qr_batches')
  })

  it('returns zeros for a D2H order with no shipments without querying cases or units', async () => {
    const { response, body } = await run(D2H_EMPTY)
    expect(response.status).toBe(200)
    expect(body).toMatchObject({ cases_shipped: 0, units_shipped: 0, cases_received: null, units_received: null })
    expect(tablesQueried()).not.toContain('qr_master_codes')
    expect(tablesQueried()).not.toContain('qr_codes')
  })

  it('reads every page of shipped units so large cases are not cut off at the row cap', async () => {
    const tables = fixture()
    tables.qr_validation_reports = [session('big', D2H, WH, ['MC-big'])]
    tables.qr_master_codes = [master('big', 'batch-a', 'warehouse_packed', 1500)]
    tables.qr_codes = units('big', 1500)
    db = createFakeDb(tables)
    const { body } = await run(D2H)
    expect(body.cases_shipped).toBe(1)
    expect(db.calls.filter(call => call.table === 'qr_codes').map(call => call.range)).toEqual([[0, 999], [1000, 1999]])
  })

  it('chunks large master-code lists into bounded in() filters', async () => {
    const tables = fixture()
    const codes = Array.from({ length: 150 }, (_, i) => `m${i}`)
    tables.qr_validation_reports = [session('many', D2H, WH, codes.map(code => `MC-${code}`))]
    tables.qr_master_codes = codes.map(code => master(code, 'batch-a', 'shipped_distributor', 10))
    tables.qr_codes = []
    db = createFakeDb(tables)
    const { body } = await run(D2H)
    expect(body.cases_shipped).toBe(150)
    const inSizes = db.calls
      .filter(call => call.table === 'qr_master_codes')
      .map(call => (call.filters.find(f => f.column === 'master_code')!.value as string[]).length)
    expect(inSizes).toEqual([100, 50])
  })

  it.each(['v_stock_movements_display', 'qr_validation_reports', 'qr_master_codes', 'qr_codes'])(
    'fails loudly with a generic 500 when %s cannot be read',
    async (table) => {
      db.failOn(table, { message: 'permission denied for table secret_internal', code: '42501' })
      const { response, body } = await run(D2H)
      expect(response.status).toBe(500)
      expect(JSON.stringify(body)).not.toMatch(/secret_internal|42501/)
    },
  )

  it('is read-only and stays on the RLS-scoped user client', async () => {
    await run(D2H)
    expect(createAdminClient).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
    expect(db.calls.flatMap(call => call.writes)).toEqual([])
  })
})

describe.skipIf(!schemaSnapshot)('ship-metrics queries fit the staging schema snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    guardUserOperation.mockResolvedValue(null)
  })

  it('every column, filter and embed the route uses exists', async () => {
    db = createFakeDb(fixture())
    await run(D2H)
    expect(db.calls.length).toBeGreaterThan(4)
    expect(db.calls.flatMap(call => schemaProblems(schemaSnapshot!, call))).toEqual([])
  })

  it('the contract check rejects the assumptions the old query relied on', () => {
    const call = (table: string, select: string): QueryCall =>
      ({ table, select, filters: [], order: null, range: null, writes: [] })
    expect(schemaProblems(schemaSnapshot!, call('qr_master_codes', 'id, receive_order_id'))).toEqual(['qr_master_codes.receive_order_id does not exist'])
    expect(schemaProblems(schemaSnapshot!, call('qr_codes', 'qr_code, product_variant_id'))).toEqual([
      'qr_codes.qr_code does not exist',
      'qr_codes.product_variant_id does not exist',
    ])
    expect(schemaProblems(schemaSnapshot!, call('qr_master_codes', 'qr_batches ( product_variant_id, products ( product_name ) )'))).toEqual([
      'qr_batches.product_variant_id does not exist',
      'qr_batches: no foreign key to products',
    ])
  })
})
