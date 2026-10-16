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
const batchMaybeSingle = vi.fn()
const createSignedUrl = vi.fn()
const rpc = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: authGetUser },
    from: (table: string) => {
      if (table !== 'users') throw new Error(`session client must not read ${table}`)
      return { select: () => ({ eq: () => ({ single: profileSingle }) }) }
    },
  })),
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    from: (table: string) => {
      if (table !== 'qr_batches') throw new Error(`unexpected admin table ${table}`)
      return { select: () => ({ eq: () => ({ maybeSingle: batchMaybeSingle }) }) }
    },
    storage: { from: () => ({ createSignedUrl }) },
    rpc,
  })),
}))

function post(body: unknown): NextRequest {
  return new NextRequest('https://stg.serapod2u.com/api/qr-batches/download', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

function signedInAs(orgType: string | null, orgId: string | null) {
  authGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  profileSingle.mockResolvedValue({
    data: { is_active: true, organization_id: orgId, organizations: orgType ? { org_type_code: orgType } : null },
    error: null,
  })
}

const EXCEL_URL = 'https://supabase.example/storage/v1/object/public/qr-codes/batches/batch-1.xlsx'
const ORDER = { order_no: 'ORD-HM-1026-02', seller_org_id: MFG_A, buyer_org_id: HQ, company_id: HQ }

function batchFor(status: string, excelUrl: string | null = EXCEL_URL) {
  batchMaybeSingle.mockResolvedValue({ data: { id: 'batch-1', status, excel_file_url: excelUrl, order: ORDER }, error: null })
}

async function call() {
  const { POST } = await import('./route')
  return POST(post({ batch_id: 'batch-1' }))
}

describe('POST /api/qr-batches/download', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    authGetUser.mockResolvedValue({ data: { user: null }, error: null })
    createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://supabase.example/signed?token=t' }, error: null })
    rpc.mockResolvedValue({ data: { success: true }, error: null })
  })

  it('rejects anonymous callers with 401', async () => {
    expect((await call()).status).toBe(401)
    expect(batchMaybeSingle).not.toHaveBeenCalled()
  })

  it('forbids non HQ/MFG organizations', async () => {
    signedInAs('SHOP', MFG_A)
    batchFor('generated')

    expect((await call()).status).toBe(403)
    expect(createSignedUrl).not.toHaveBeenCalled()
  })

  it('gives the selling manufacturer the file and marks a generated batch as printed server-side', async () => {
    signedInAs('MFG', MFG_A)
    batchFor('generated')

    const res = await call()

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      filename: 'QR_Batch_ORD-HM-1026-02.xlsx',
      marked_printed: true,
    })
    expect(createSignedUrl).toHaveBeenCalledWith('batches/batch-1.xlsx', 3600, { download: 'QR_Batch_ORD-HM-1026-02.xlsx' })
    expect(rpc).toHaveBeenCalledWith('mark_batch_as_printed', { p_batch_id: 'batch-1' })
  })

  it('does not mark a batch that is already past generated', async () => {
    signedInAs('MFG', MFG_A)
    batchFor('printing')

    const res = await call()

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ marked_printed: false })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('still returns the download link when marking as printed fails', async () => {
    signedInAs('MFG', MFG_A)
    batchFor('generated')
    rpc.mockResolvedValue({ data: null, error: { message: 'rpc failed' } })

    const res = await call()

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ success: true, marked_printed: false })
  })

  it('hides another manufacturer’s batch', async () => {
    signedInAs('MFG', MFG_B)
    batchFor('generated')

    const res = await call()

    expect(res.status).toBe(404)
    expect(createSignedUrl).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns 404 when the batch has no Excel file yet', async () => {
    signedInAs('MFG', MFG_A)
    batchFor('queued', null)

    expect((await call()).status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })
})
