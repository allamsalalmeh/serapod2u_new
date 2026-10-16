import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeDb, schemaProblems, schemaSnapshot, type FakeDb, type Row } from '@/test-support/postgrest-fake'

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

const SCANNED_AT = '2026-10-16T01:00:00.000Z'

const variants: Record<string, Row> = {
  v1: { id: 'v1', variant_name: '20ml', image_url: 'https://img/v1.png', products: { product_name: 'Sera' } },
  v2: { id: 'v2', variant_name: '50ml', image_url: null, products: [{ product_name: 'Sera' }] },
  v3: { id: 'v3', variant_name: 'Mint 20ml', image_url: null, products: { product_name: 'Sera Mint' } },
  v9: { id: 'v9', variant_name: 'Buffer only', image_url: null, products: { product_name: 'Buffer' } },
}

const units = (master_code_id: string, variant_id: string, count: number, is_buffer = false): Row[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `${master_code_id}-${variant_id}-${is_buffer ? 'b' : 'u'}${String(i).padStart(5, '0')}`,
    master_code_id,
    variant_id,
    is_buffer,
  }))

const masterRow = (id: string, case_number: number, actual_unit_count: number, expected_unit_count: number): Row =>
  ({ id, master_code: `MC-${id}`, case_number, actual_unit_count, expected_unit_count })

const sessionRow = (master: string[], unique: string[] = []): Row => ({
  id: 's-1',
  master_codes_scanned: master,
  unique_codes_scanned: unique,
  scanned_quantities: { per_variant: { v1: { units: 2, cases: 1 } } },
  created_at: SCANNED_AT,
})

// Visible rows only: MC-hidden belongs to another organization, so RLS hides it.
const fixture = (session: Row = sessionRow(['MC-a', 'MC-b', 'MC-mix', 'MC-same', 'MC-empty', 'MC-hidden'])): Record<string, Row[]> => ({
  qr_validation_reports: [session],
  qr_master_codes: [
    masterRow('a', 1, 10, 10),
    masterRow('b', 2, 0, 12),
    masterRow('mix', 3, 5, 5),
    masterRow('same', 4, 4, 4),
    masterRow('empty', 5, 0, 0),
  ],
  qr_codes: [
    ...units('a', 'v1', 10),
    ...units('a', 'v9', 1, true), // buffer: never decides a case's variant
    ...units('b', 'v2', 12),
    ...units('mix', 'v1', 3),
    ...units('mix', 'v3', 2),
    ...units('same', 'v1', 2),
    ...units('same', 'v2', 2),
    { id: 'u-1', code: 'SERA-U001', variant_id: 'v1', master_code_id: null, is_buffer: false, product_variants: { variant_name: '20ml', image_url: 'https://img/v1.png', products: { product_name: 'Sera' } } },
    { id: 'u-2', code: 'SERA-U002', variant_id: 'v1', master_code_id: null, is_buffer: false, product_variants: [{ variant_name: '20ml', image_url: null, products: [{ product_name: 'Sera' }] }] },
  ],
  product_variants: Object.values(variants),
})

const run = async (query = '?session_id=s-1') => {
  const { GET } = await import('./route')
  const response = await GET({ nextUrl: new URL(`http://localhost/api/warehouse/scanned-codes${query}`) } as any)
  return { response, body: await response.json() }
}

const masterDetails = (body: { scanned_codes: Array<{ codeType: string }> }) =>
  body.scanned_codes.filter(detail => detail.codeType === 'master')

describe('GET /api/warehouse/scanned-codes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db = createFakeDb(fixture())
    authGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    guardUserOperation.mockResolvedValue(null)
  })

  it('rejects anonymous callers before reading anything', async () => {
    authGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'missing' } })
    const { response } = await run()
    expect(response.status).toBe(401)
    expect(db.calls).toHaveLength(0)
  })

  it('returns the S&A denial and reads nothing when inventory.report.view is denied', async () => {
    guardUserOperation.mockResolvedValue(new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 }))
    const { response } = await run()
    expect(guardUserOperation).toHaveBeenCalledWith('user-1', 'inventory.report.view')
    expect(response.status).toBe(403)
    expect(db.calls).toHaveLength(0)
  })

  it('requires session_id', async () => {
    expect((await run('')).response.status).toBe(400)
  })

  it('returns 404 for an unknown or RLS-hidden session', async () => {
    const { response } = await run('?session_id=00000000-0000-0000-0000-000000000000')
    expect(response.status).toBe(404)
    expect(db.calls.map(call => call.table)).toEqual(['qr_validation_reports'])
  })

  it('looks up unique codes by qr_codes.code and variant_id, keeping the response contract', async () => {
    db = createFakeDb(fixture(sessionRow([], ['SERA-U001', 'SERA-U002'])))
    const { response, body } = await run()
    expect(response.status).toBe(200)
    const uniqueQuery = db.calls.find(call => call.table === 'qr_codes')!
    expect(uniqueQuery.filters).toEqual([{ op: 'in', column: 'code', value: ['SERA-U001', 'SERA-U002'] }])
    expect(body).toEqual({
      session_id: 's-1',
      scanned_codes: [
        { code: 'SERA-U001', codeType: 'unique', productName: 'Sera', variantName: '20ml', variantId: 'v1', imageUrl: 'https://img/v1.png', quantity: 1, scannedAt: SCANNED_AT },
        { code: 'SERA-U002', codeType: 'unique', productName: 'Sera', variantName: '20ml', variantId: 'v1', imageUrl: null, quantity: 1, scannedAt: SCANNED_AT },
      ],
      summary: { total_master: 0, total_unique: 2, total_codes: 2, per_variant: { v1: { units: 2, cases: 1 } } },
    })
  })

  it('resolves a master case through its own unit codes: one row per case, never per unit', async () => {
    db = createFakeDb(fixture(sessionRow(['MC-a'])))
    const { body } = await run()
    expect(body.scanned_codes).toEqual([
      {
        code: 'MC-a',
        codeType: 'master',
        productName: 'Sera',
        variantName: '20ml',
        variantId: 'v1', // the v9 buffer unit is ignored
        imageUrl: 'https://img/v1.png',
        quantity: 10,
        scannedAt: SCANNED_AT,
        variantStatus: 'single',
      },
    ])
    const unitQuery = db.calls.find(call => call.table === 'qr_codes')!
    expect(unitQuery.filters).toEqual([
      { op: 'in', column: 'master_code_id', value: ['a'] },
      { op: 'eq', column: 'is_buffer', value: false },
    ])
    expect(db.calls.map(call => call.table)).not.toContain('qr_batches')
  })

  it('handles several cases in one session, falling back to expected units and flagging mixed or empty cases', async () => {
    const { body } = await run()
    const byCode = Object.fromEntries(masterDetails(body).map((detail: any) => [detail.code, detail]))
    expect(Object.keys(byCode).sort()).toEqual(['MC-a', 'MC-b', 'MC-empty', 'MC-mix', 'MC-same'])
    expect(byCode['MC-b']).toMatchObject({ productName: 'Sera', variantName: '50ml', variantId: 'v2', quantity: 12, variantStatus: 'single' })
    // Different products: no product or variant is picked.
    expect(byCode['MC-mix']).toMatchObject({ productName: null, variantName: 'Case 3', variantId: null, imageUrl: null, variantStatus: 'mixed', variantIds: ['v1', 'v3'] })
    // Same product, two variants: the shared product is still named.
    expect(byCode['MC-same']).toMatchObject({ productName: 'Sera', variantName: 'Case 4', variantId: null, variantStatus: 'mixed', variantIds: ['v1', 'v2'] })
    expect(byCode['MC-empty']).toMatchObject({ productName: null, variantName: 'Case 5', variantId: null, quantity: 0, variantStatus: 'missing' })
    expect(byCode['MC-empty']).not.toHaveProperty('variantIds')
    // MC-hidden is not visible to this caller and is not invented; the summary still counts the session's scans.
    expect(body.summary).toMatchObject({ total_master: 6, total_unique: 0, total_codes: 5 })
  })

  it('returns an empty list without querying codes when the session scanned nothing', async () => {
    db = createFakeDb(fixture(sessionRow([])))
    const { response, body } = await run()
    expect(response.status).toBe(200)
    expect(body.scanned_codes).toEqual([])
    expect(body.summary).toMatchObject({ total_master: 0, total_unique: 0, total_codes: 0 })
    expect(db.calls.map(call => call.table)).toEqual(['qr_validation_reports'])
  })

  it('reads every page of unit codes for a large case', async () => {
    const tables = fixture(sessionRow(['MC-big']))
    tables.qr_master_codes = [masterRow('big', 9, 1500, 1500)]
    tables.qr_codes = [...units('big', 'v1', 1499), ...units('big', 'v3', 1)]
    db = createFakeDb(tables)
    const { body } = await run()
    // The one v3 unit sits on the second page; missing it would wrongly report a single variant.
    expect(masterDetails(body)[0]).toMatchObject({ variantStatus: 'mixed', variantIds: ['v1', 'v3'] })
    expect(db.calls.filter(call => call.table === 'qr_codes').map(call => call.range)).toEqual([[0, 999], [1000, 1999]])
  })

  it.each([
    ['qr_master_codes', ['MC-a']],
    ['product_variants', ['MC-a']],
    ['qr_codes', ['MC-a']],
  ])('fails loudly with a generic 500 when %s cannot be read', async (table, masters) => {
    db = createFakeDb(fixture(sessionRow(masters as string[])))
    db.failOn(table, { message: 'permission denied for table secret_internal', code: '42501' })
    const { response, body } = await run()
    expect(response.status).toBe(500)
    expect(JSON.stringify(body)).not.toMatch(/secret_internal|42501/)
  })

  it('fails loudly when the unique-code lookup errors', async () => {
    db = createFakeDb(fixture(sessionRow([], ['SERA-U001'])))
    db.failOn('qr_codes')
    const { response } = await run()
    expect(response.status).toBe(500)
  })

  it('stays read-only and RLS-scoped: user client only, no writes, no RPCs', async () => {
    db = createFakeDb(fixture(sessionRow(['MC-a', 'MC-mix'], ['SERA-U001'])))
    await run()
    expect(createAdminClient).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
    expect(db.calls.flatMap(call => call.writes)).toEqual([])
  })
})

describe.skipIf(!schemaSnapshot)('scanned-codes queries fit the staging schema snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    guardUserOperation.mockResolvedValue(null)
  })

  it('every column, filter and embed used for master cases and unique codes exists', async () => {
    db = createFakeDb(fixture(sessionRow(['MC-a', 'MC-mix'], ['SERA-U001'])))
    await run()
    expect(new Set(db.calls.map(call => call.table))).toEqual(new Set(['qr_validation_reports', 'qr_master_codes', 'qr_codes', 'product_variants']))
    expect(db.calls.flatMap(call => schemaProblems(schemaSnapshot!, call))).toEqual([])
  })
})
