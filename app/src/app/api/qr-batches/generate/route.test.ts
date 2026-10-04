import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// S&A in legacy mode: this suite tests the route's own rules.
vi.mock('@/lib/security-access/operation', async () => (await import('@/test-support/sa-legacy-mode')).operationModule)
vi.mock('@/lib/security-access/resource-context', async () => (await import('@/test-support/sa-legacy-mode')).resourceContextModule)

const MFG_A = 'org-mfg-a'
const MFG_B = 'org-mfg-b'
const HQ = 'org-hq'

const authGetUser = vi.fn()
const profileSingle = vi.fn()
const sessionFrom = vi.fn()

/** In-memory stand-in for the service-role client: orders + qr_batches. */
type Batch = { id: string; order_id: string; status: string; created_at: string; [k: string]: unknown }
const db: { order: any; batches: Batch[]; insertError: any; seq: number; onInsert?: () => void } = {
  order: null,
  batches: [],
  insertError: null,
  seq: 0,
}

function batchesQuery() {
  const filters: Array<[string, unknown]> = []
  const rows = () =>
    db.batches
      .filter((b) => filters.every(([k, v]) => (b as any)[k] === v))
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
  const q: any = {
    eq: (k: string, v: unknown) => (filters.push([k, v]), q),
    order: () => q,
    then: (resolve: any) => resolve({ data: rows(), error: null }),
  }
  return q
}

const admin = {
  from: (table: string) => {
    if (table === 'orders') {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: db.order, error: null }) }) }) }
    }
    if (table !== 'qr_batches') throw new Error(`unexpected admin table ${table}`)
    return {
      select: () => batchesQuery(),
      insert: (row: any) => ({
        select: () => ({
          single: async () => {
            if (db.insertError) return { data: null, error: db.insertError }
            db.onInsert?.()
            const batch = { ...row, id: `batch-new-${++db.seq}`, created_at: `2026-10-03T10:00:0${db.seq}Z` }
            db.batches.push(batch)
            return { data: batch, error: null }
          },
        }),
      }),
      update: (patch: any) => {
        const filters: Array<[string, unknown]> = []
        const q: any = {
          eq: (k: string, v: unknown) => (filters.push([k, v]), q),
          select: async () => {
            const hit = db.batches.filter((b) => filters.every(([k, v]) => (b as any)[k] === v))
            hit.forEach((b) => Object.assign(b, patch))
            return { data: hit, error: null }
          },
        }
        return q
      },
      delete: () => {
        const filters: Array<[string, unknown]> = []
        const q: any = {
          eq: (k: string, v: unknown) => (filters.push([k, v]), q),
          then: (resolve: any) => {
            db.batches = db.batches.filter((b) => !filters.every(([k, v]) => (b as any)[k] === v))
            resolve({ error: null })
          },
        }
        return q
      },
    }
  },
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: authGetUser },
    from: (table: string) => {
      sessionFrom(table)
      if (table !== 'users') throw new Error(`session client must not touch ${table}`)
      return { select: () => ({ eq: () => ({ single: profileSingle }) }) }
    },
  })),
}))

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => admin) }))

const line = (code: string, qty: number) => ({
  id: `item-${code}`,
  qty,
  product_id: 'p-1',
  variant_id: `v-${code}`,
  units_per_case: null,
  product: { id: 'p-1', product_code: 'CEL', product_name: 'Cellera Hero' },
  variant: { id: `v-${code}`, variant_code: code, variant_name: code },
})

function h2mOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-106',
    order_no: 'ORD26000106',
    order_type: 'H2M',
    status: 'approved',
    company_id: HQ,
    buyer_org_id: HQ,
    seller_org_id: MFG_A,
    units_per_case: 100,
    qr_buffer_percent: 1,
    seller_org: { id: MFG_A, org_name: 'Manufacturer A', org_code: 'MFGA' },
    buyer_org: { id: HQ, org_name: 'Serapod', org_code: 'HQ' },
    order_items: [line('HONEYDEW', 1000)],
    ...overrides,
  }
}

function signedInAs(orgType: string | null, orgId: string | null) {
  authGetUser.mockResolvedValue({ data: { user: { id: 'user-manu' } }, error: null })
  profileSingle.mockResolvedValue({
    data: { is_active: true, organization_id: orgId, organizations: orgType ? { org_type_code: orgType } : null },
    error: null,
  })
}

async function call(body: unknown = { order_id: 'order-106' }) {
  const { POST } = await import('./route')
  return POST(
    new NextRequest('https://stg.serapod2u.com/api/qr-batches/generate', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

describe('POST /api/qr-batches/generate', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    authGetUser.mockResolvedValue({ data: { user: null }, error: null })
    db.order = h2mOrder()
    db.batches = []
    db.insertError = null
    db.seq = 0
    db.onInsert = undefined
  })

  it('requires an order_id and a signed-in user', async () => {
    signedInAs('MFG', MFG_A)
    expect((await call({})).status).toBe(400)
    expect((await call('not json')).status).toBe(400)
    authGetUser.mockResolvedValue({ data: { user: null }, error: null })
    expect((await call()).status).toBe(401)
  })

  it('queues one batch for the order manufacturer: 1,000 cases -> 1,010 case QR, 10 master QR, 1% buffer', async () => {
    signedInAs('MFG', MFG_A)

    const res = await call()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ success: true, status: 'queued', total_unique_codes: 1010, total_master_codes: 10 })
    expect(db.batches).toHaveLength(1)
    expect(db.batches[0]).toMatchObject({
      order_id: 'order-106',
      company_id: HQ,
      status: 'queued',
      buffer_percent: 1,
      total_unique_codes: 1010,
      total_master_codes: 10,
      created_by: 'user-manu',
    })
    // The row is written by the server after its own checks, never through the
    // manufacturer's session (whose RLS no longer admits the insert).
    expect(sessionFrom).not.toHaveBeenCalledWith('qr_batches')
  })

  it('a repeated click returns the existing batch instead of creating another', async () => {
    signedInAs('MFG', MFG_A)
    await call()
    const res = await call()
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ existing: true, batch_id: 'batch-new-1' })
    expect(db.batches).toHaveLength(1)
  })

  it('re-queues a failed batch rather than creating a duplicate', async () => {
    signedInAs('MFG', MFG_A)
    db.batches = [{ id: 'batch-old', order_id: 'order-106', status: 'failed', last_error: 'boom', created_at: '2026-10-02T00:00:00Z', total_unique_codes: 1010 }]

    const body = await (await call()).json()

    expect(body).toMatchObject({ resumed: true, batch_id: 'batch-old', status: 'queued' })
    expect(db.batches).toHaveLength(1)
    expect(db.batches[0]).toMatchObject({ status: 'queued', last_error: null, total_unique_codes: 1010 })
  })

  it('two concurrent requests settle on the oldest batch', async () => {
    signedInAs('MFG', MFG_A)
    // Another request's row lands between this request's check and its insert.
    db.onInsert = () => {
      db.batches.push({ id: 'batch-other', order_id: 'order-106', status: 'queued', created_at: '2026-10-03T09:59:59Z' })
    }

    const body = await (await call()).json()

    expect(body).toMatchObject({ existing: true, batch_id: 'batch-other' })
    expect(db.batches.map((b) => b.id)).toEqual(['batch-other'])
  })

  it('returns the existing batch when the unique index rejects a duplicate', async () => {
    signedInAs('MFG', MFG_A)
    db.insertError = { code: '23505', message: 'duplicate key value violates unique constraint "qr_batches_one_per_order"' }
    db.onInsert = undefined
    // Simulate the winner existing only once the insert has been rejected.
    const origFrom = admin.from
    let lookups = 0
    ;(admin as any).from = (table: string) => {
      const api: any = origFrom(table)
      if (table === 'qr_batches') {
        const select = api.select
        api.select = () => {
          lookups++
          if (lookups === 2) db.batches = [{ id: 'batch-winner', order_id: 'order-106', status: 'queued', created_at: '2026-10-03T00:00:00Z' }]
          return select()
        }
      }
      return api
    }
    try {
      const body = await (await call()).json()
      expect(body).toMatchObject({ existing: true, batch_id: 'batch-winner' })
    } finally {
      ;(admin as any).from = origFrom
    }
  })

  it('reports a database failure with a useful message', async () => {
    signedInAs('MFG', MFG_A)
    db.insertError = { code: '42501', message: 'new row violates row-level security policy for table "qr_batches"' }

    const res = await call()
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error).toBe('Failed to create the QR batch record.')
    expect(body.details).toContain('row-level security')
  })

  it('keeps an order of another manufacturer hidden', async () => {
    signedInAs('MFG', MFG_B)
    expect((await call()).status).toBe(404)
    expect(db.batches).toHaveLength(0)
  })

  it('lets the HQ that owns the order generate, and forbids other org types', async () => {
    signedInAs('HQ', HQ)
    expect((await call()).status).toBe(200)

    db.batches = []
    signedInAs('DIST', MFG_A)
    expect((await call()).status).toBe(403)
    expect(db.batches).toHaveLength(0)
  })

  it('only approved or closed H2M orders are eligible', async () => {
    signedInAs('MFG', MFG_A)
    db.order = h2mOrder({ status: 'submitted' })
    expect((await call()).status).toBe(404)
    db.order = h2mOrder({ order_type: 'D2H' })
    expect((await call()).status).toBe(404)
    expect(db.batches).toHaveLength(0)
  })

  it('rejects lines without product/variant codes before writing anything', async () => {
    signedInAs('MFG', MFG_A)
    db.order = h2mOrder({ order_items: [{ ...line('X', 10), variant: null }] })

    const res = await call()

    expect(res.status).toBe(422)
    expect((await res.json()).error).toContain('missing a product or variant code')
    expect(db.batches).toHaveLength(0)
  })

  it('keeps the buffer an order was saved with (10% stays 1,100)', async () => {
    signedInAs('MFG', MFG_A)
    db.order = h2mOrder({ qr_buffer_percent: 10 })
    expect((await (await call()).json()).total_unique_codes).toBe(1100)
  })
})
