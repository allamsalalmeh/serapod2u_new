import { existsSync, readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authGetUser = vi.fn()
const guardUserOperation = vi.fn()
const createAdminClient = vi.fn()

type Call = { table: string; method: string; args: unknown[] }
let calls: Call[] = []
let results: Record<string, { data: unknown; error: unknown }> = {}

// Records every builder call; awaiting the chain (or maybeSingle) resolves the
// table's canned result.
const builder = (table: string) => {
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'in', 'insert', 'update', 'upsert', 'delete']) {
    chain[method] = (...args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
  }
  const resolve = () => Promise.resolve(results[table] ?? { data: null, error: null })
  chain.maybeSingle = () => resolve()
  chain.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
    resolve().then(onFulfilled, onRejected)
  return chain
}

const rpc = vi.fn()

vi.mock('@/lib/security-access/operation', () => ({ guardUserOperation }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: authGetUser },
    from: (table: string) => builder(table),
    rpc,
  })),
}))

const request = (query: string) =>
  ({ nextUrl: new URL(`http://localhost/api/warehouse/scanned-codes${query}`) }) as any

const session = (unique: string[], master: string[] = []) => ({
  data: {
    master_codes_scanned: master,
    unique_codes_scanned: unique,
    scanned_quantities: { per_variant: { 'variant-1': { units: 2, cases: 0 } } },
    created_at: '2026-10-16T01:00:00.000Z',
  },
  error: null,
})

const callsFor = (table: string, method?: string) =>
  calls.filter(c => c.table === table && (!method || c.method === method))

describe('GET /api/warehouse/scanned-codes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    calls = []
    results = {}
    authGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
    guardUserOperation.mockResolvedValue(null)
  })

  it('rejects anonymous callers before reading anything', async () => {
    authGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'missing' } })
    const { GET } = await import('./route')
    const response = await GET(request('?session_id=s-1'))
    expect(response.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('returns the S&A denial and reads nothing when inventory.report.view is denied', async () => {
    const denied = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })
    guardUserOperation.mockResolvedValue(denied)
    const { GET } = await import('./route')
    const response = await GET(request('?session_id=s-1'))
    expect(guardUserOperation).toHaveBeenCalledWith('user-1', 'inventory.report.view')
    expect(response.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('requires session_id', async () => {
    const { GET } = await import('./route')
    const response = await GET(request(''))
    expect(response.status).toBe(400)
  })

  it('returns 404 for an unknown or RLS-hidden session', async () => {
    results.qr_validation_reports = { data: null, error: null }
    const { GET } = await import('./route')
    const response = await GET(request('?session_id=00000000-0000-0000-0000-000000000000'))
    expect(response.status).toBe(404)
    expect(callsFor('qr_codes')).toHaveLength(0)
  })

  it('looks up unique codes by qr_codes.code and variant_id, keeping the response contract', async () => {
    results.qr_validation_reports = session(['SERA-ORD-1-U001', 'SERA-ORD-1-U002'])
    results.qr_codes = {
      data: [
        {
          code: 'SERA-ORD-1-U001',
          variant_id: 'variant-1',
          product_variants: { variant_name: '20ml', image_url: 'https://img/1.png', products: { product_name: 'Sera' } },
        },
        {
          code: 'SERA-ORD-1-U002',
          variant_id: 'variant-1',
          product_variants: [{ variant_name: '20ml', image_url: null, products: [{ product_name: 'Sera' }] }],
        },
      ],
      error: null,
    }
    const { GET } = await import('./route')
    const response = await GET(request('?session_id=s-1'))
    expect(response.status).toBe(200)

    const select = String(callsFor('qr_codes', 'select')[0].args[0])
    expect(select).toMatch(/\bcode,/)
    expect(select).toMatch(/\bvariant_id,/)
    expect(select).not.toMatch(/qr_code|product_variant_id/)
    expect(callsFor('qr_codes', 'in')[0].args).toEqual(['code', ['SERA-ORD-1-U001', 'SERA-ORD-1-U002']])

    expect(await response.json()).toEqual({
      session_id: 's-1',
      scanned_codes: [
        {
          code: 'SERA-ORD-1-U001',
          codeType: 'unique',
          productName: 'Sera',
          variantName: '20ml',
          variantId: 'variant-1',
          imageUrl: 'https://img/1.png',
          quantity: 1,
          scannedAt: '2026-10-16T01:00:00.000Z',
        },
        {
          code: 'SERA-ORD-1-U002',
          codeType: 'unique',
          productName: 'Sera',
          variantName: '20ml',
          variantId: 'variant-1',
          imageUrl: null,
          quantity: 1,
          scannedAt: '2026-10-16T01:00:00.000Z',
        },
      ],
      summary: {
        total_master: 0,
        total_unique: 2,
        total_codes: 2,
        per_variant: { 'variant-1': { units: 2, cases: 0 } },
      },
    })
  })

  it('returns an empty list without querying qr_codes when the session scanned nothing', async () => {
    results.qr_validation_reports = session([])
    const { GET } = await import('./route')
    const response = await GET(request('?session_id=s-1'))
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.scanned_codes).toEqual([])
    expect(body.summary).toMatchObject({ total_master: 0, total_unique: 0, total_codes: 0 })
    expect(callsFor('qr_codes')).toHaveLength(0)
  })

  it('stays read-only and RLS-scoped: user client only, no writes, no RPCs', async () => {
    results.qr_validation_reports = session(['SERA-ORD-1-U001'], ['SERA-ORD-1-M001'])
    results.qr_codes = { data: [], error: null }
    results.qr_master_codes = { data: [], error: null }
    const { GET } = await import('./route')
    await GET(request('?session_id=s-1'))
    expect(createAdminClient).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
    expect(calls.filter(c => ['insert', 'update', 'upsert', 'delete'].includes(c.method))).toEqual([])
  })
})

// The staging schema snapshot is a local, untracked file; check it when present.
const snapshotUrl = new URL('../../../../../../supabase/schemas/current_schema.sql', import.meta.url)
const snapshot = existsSync(snapshotUrl) ? readFileSync(snapshotUrl, 'utf8') : null

describe.skipIf(!snapshot)('scanned-codes unique-code columns exist in the schema snapshot', () => {
  const tableBody = (table: string) => {
    const start = snapshot!.indexOf(`CREATE TABLE public.${table} (`)
    return start < 0 ? '' : snapshot!.slice(start, snapshot!.indexOf('\n);', start))
  }

  it('qr_codes has code and variant_id (not qr_code / product_variant_id)', () => {
    const qrCodes = tableBody('qr_codes')
    expect(qrCodes).toMatch(/\n    code text NOT NULL,/)
    expect(qrCodes).toMatch(/\n    variant_id uuid/)
    expect(qrCodes).not.toMatch(/\n    qr_code /)
    expect(qrCodes).not.toMatch(/\n    product_variant_id /)
  })

  it('qr_codes.variant_id is the foreign key the product_variants embed follows', () => {
    expect(snapshot).toMatch(/qr_codes_variant_id_fkey FOREIGN KEY \(variant_id\) REFERENCES public\.product_variants\(id\)/)
  })
})
