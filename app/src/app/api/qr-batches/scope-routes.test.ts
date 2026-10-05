import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// S&A decision itself is covered elsewhere; these tests are about the ownership rule that follows it.
vi.mock('@/lib/security-access/operation', async () => (await import('@/test-support/sa-legacy-mode')).operationModule)
vi.mock('@/lib/security-access/resource-context', async () => (await import('@/test-support/sa-legacy-mode')).resourceContextModule)
vi.mock('@/lib/security-access/legacy-rules', () => ({ legacyRoleLevelAtMost: async () => true }))

const authGetUser = vi.fn()
let actor: { org: string; type: string }
let batchOrder: any
const signedUrl = vi.fn(async () => ({ data: { signedUrl: 'https://x/y' }, error: null }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: authGetUser },
    from: (table: string) => {
      const chain: any = { select: () => chain, eq: () => chain, single: async () => ({ data: null, error: { message: 'x' } }), maybeSingle: async () => ({ data: table === 'qr_batches' ? { id: 'b1', order_id: 'o1', excel_file_url: 'https://s.test/storage/v1/object/public/qr-codes/a.xlsx' } : { order_no: 'ORD-1' }, error: null }) }
      return chain
    },
  })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    storage: { from: () => ({ createSignedUrl: signedUrl }) },
    from: (table: string) => {
      const chain: any = { select: () => chain, eq: () => chain, limit: () => chain, maybeSingle: async () => ({ data: table === 'users' ? { organization_id: actor.org, organizations: { org_type_code: actor.type } } : { id: 'b1', order: batchOrder }, error: null }) }
      return chain
    },
  })),
}))

const order = (seller: string) => ({ seller_org_id: seller, buyer_org_id: 'hq', company_id: 'hq' })
beforeEach(() => { authGetUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null }); signedUrl.mockClear() })

describe('POST /api/qr-batches/download', () => {
  const call = async () => { const { POST } = await import('./download/route'); return POST(new NextRequest('https://x/api/qr-batches/download', { method: 'POST', body: JSON.stringify({ batch_id: 'b1' }) })) }
  it('a manufacturer cannot download another manufacturer\'s batch (and no signed URL is created)', async () => {
    actor = { org: 'mfg-b', type: 'MFG' }; batchOrder = order('mfg-a')
    expect((await call()).status).toBe(404)
    expect(signedUrl).not.toHaveBeenCalled()
  })
  it('a manufacturer downloads the batch of its own order; HQ is unchanged', async () => {
    actor = { org: 'mfg-a', type: 'MFG' }; batchOrder = order('mfg-a')
    expect((await call()).status).toBe(200)
    actor = { org: 'hq', type: 'HQ' }
    expect((await call()).status).toBe(200)
  })
})

describe('GET /api/qr/batches/[batchId]/progress', () => {
  const call = async () => { const { GET } = await import('../qr/batches/[batchId]/progress/route'); return GET(new NextRequest('https://x/api/qr/batches/b1/progress'), { params: Promise.resolve({ batchId: 'b1' }) }) }
  it('answers 404 for a batch that is not the manufacturer\'s own order', async () => {
    actor = { org: 'mfg-b', type: 'MFG' }; batchOrder = order('mfg-a')
    expect((await call()).status).toBe(404)
  })
})

describe('GET /api/qr-monitoring/stats', () => {
  it('is system-wide, so partners are refused even when they hold qr.batch.manage', async () => {
    actor = { org: 'mfg-a', type: 'MFG' }
    const { GET } = await import('../qr-monitoring/stats/route')
    expect((await GET(new NextRequest('https://x/api/qr-monitoring/stats'))).status).toBe(403)
  })
})
