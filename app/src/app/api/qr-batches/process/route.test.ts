import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

// S&A in legacy mode: this suite tests the route's own rules.
vi.mock('@/lib/security-access/operation', async () => (await import('@/test-support/sa-legacy-mode')).operationModule)
vi.mock('@/lib/security-access/resource-context', async () => (await import('@/test-support/sa-legacy-mode')).resourceContextModule)

const MFG_A = 'org-mfg-a'
const MFG_B = 'org-mfg-b'
const HQ = 'org-hq'
const OTHER_HQ = 'org-hq-other'

const authGetUser = vi.fn()
const profileSingle = vi.fn()
const batchMaybeSingle = vi.fn()
const batchEq = vi.fn()
const withWorkerLeaseMock = vi.fn()
const runQRBatchGenerationMock = vi.fn()

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
      return {
        select: () => ({
          eq: (column: string, value: string) => {
            batchEq(column, value)
            return { maybeSingle: batchMaybeSingle }
          },
        }),
      }
    },
  })),
}))

vi.mock('@/lib/cron/lease', () => ({
  WORKER_NAMES: { qrGeneration: 'qr-generation-worker' },
  withWorkerLease: withWorkerLeaseMock,
}))

vi.mock('@/lib/qr-batch-generation', () => ({
  runQRBatchGeneration: runQRBatchGenerationMock,
}))

vi.mock('@/lib/excel-generator', () => ({
  resolveTrackingBaseUrl: () => 'https://stg.serapod2u.com',
}))

function post(body: unknown): NextRequest {
  return new NextRequest('https://stg.serapod2u.com/api/qr-batches/process', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  })
}

function signedInAs(orgType: string | null, orgId: string | null, isActive = true) {
  authGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  profileSingle.mockResolvedValue({
    data: { is_active: isActive, organization_id: orgId, organizations: orgType ? { org_type_code: orgType } : null },
    error: null,
  })
}

function batchFor(order: { seller_org_id: string; buyer_org_id: string; company_id: string } | null, status = 'queued') {
  batchMaybeSingle.mockResolvedValue({ data: { id: 'batch-1', status, order }, error: null })
}

const H2M_ORDER = { seller_org_id: MFG_A, buyer_org_id: HQ, company_id: HQ }

async function call(body: unknown = { batch_id: 'batch-1' }) {
  const { POST } = await import('./route')
  return POST(post(body))
}

describe('POST /api/qr-batches/process', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    authGetUser.mockResolvedValue({ data: { user: null }, error: null })
    runQRBatchGenerationMock.mockResolvedValue(
      NextResponse.json({ success: true, message: 'Batch processing COMPLETED!', hasMore: false })
    )
    withWorkerLeaseMock.mockImplementation(async (_client, _name, fn) => ({ status: 'ran', result: await fn() }))
  })

  it('requires a batch_id', async () => {
    signedInAs('MFG', MFG_A)
    expect((await call({})).status).toBe(400)
    expect((await call('not json')).status).toBe(400)
  })

  it('rejects anonymous callers with 401', async () => {
    const res = await call()

    expect(res.status).toBe(401)
    expect(batchMaybeSingle).not.toHaveBeenCalled()
    expect(withWorkerLeaseMock).not.toHaveBeenCalled()
  })

  it.each([
    ['SHOP', MFG_A],
    ['DIST', MFG_A],
    ['WH', MFG_A],
    [null, MFG_A],
  ])('forbids org type %s even for a batch its organization id matches', async (orgType, orgId) => {
    signedInAs(orgType, orgId)
    batchFor(H2M_ORDER)

    const res = await call()

    expect(res.status).toBe(403)
    expect(withWorkerLeaseMock).not.toHaveBeenCalled()
  })

  it('forbids an inactive manufacturer user', async () => {
    signedInAs('MFG', MFG_A, false)
    batchFor(H2M_ORDER)

    expect((await call()).status).toBe(403)
    expect(withWorkerLeaseMock).not.toHaveBeenCalled()
  })

  it('a blocked local worker answers 409 with the confirmed batch state, runs nothing and never overrides the guard', async () => {
    signedInAs('MFG', MFG_A)
    batchFor(H2M_ORDER)
    withWorkerLeaseMock.mockResolvedValue({
      status: 'blocked',
      response: NextResponse.json({ error: 'Background worker disabled for a local process connected to a remote database', status: 'REMOTE_DB_WORKER_BLOCKED' }, { status: 409 }),
    })

    const res = await call()

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ status: 'REMOTE_DB_WORKER_BLOCKED', batch_id: 'batch-1', batch_status: 'queued' })
    expect(runQRBatchGenerationMock).not.toHaveBeenCalled()
  })

  it('processes only the requested batch for the manufacturer that owns the order', async () => {
    signedInAs('MFG', MFG_A)
    batchFor(H2M_ORDER)

    const res = await call()

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ hasMore: false })
    expect(batchEq).toHaveBeenCalledWith('id', 'batch-1')
    expect(withWorkerLeaseMock).toHaveBeenCalledWith(expect.anything(), 'qr-generation-worker', expect.any(Function))
    expect(runQRBatchGenerationMock).toHaveBeenCalledWith(expect.anything(), {
      batchId: 'batch-1',
      notificationBaseUrl: 'https://stg.serapod2u.com',
    })
  })

  it('does not let manufacturer B process manufacturer A’s batch, and hides that it exists', async () => {
    signedInAs('MFG', MFG_B)
    batchFor(H2M_ORDER)

    const res = await call()

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'Batch not found' })
    expect(withWorkerLeaseMock).not.toHaveBeenCalled()
    expect(runQRBatchGenerationMock).not.toHaveBeenCalled()
  })

  it('lets the owning HQ process the batch but not a different HQ', async () => {
    signedInAs('HQ', HQ)
    batchFor(H2M_ORDER)
    expect((await call()).status).toBe(200)
    expect(runQRBatchGenerationMock).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    withWorkerLeaseMock.mockImplementation(async (_client, _name, fn) => ({ status: 'ran', result: await fn() }))
    signedInAs('HQ', OTHER_HQ)
    batchFor(H2M_ORDER)
    expect((await call()).status).toBe(404)
    expect(runQRBatchGenerationMock).not.toHaveBeenCalled()
  })

  it('returns 404 for an unknown batch or one with no order', async () => {
    signedInAs('MFG', MFG_A)
    batchMaybeSingle.mockResolvedValue({ data: null, error: null })
    expect((await call()).status).toBe(404)

    batchFor(null)
    expect((await call()).status).toBe(404)
    expect(withWorkerLeaseMock).not.toHaveBeenCalled()
  })

  it('reports an already-generated batch as complete without taking the lease', async () => {
    signedInAs('MFG', MFG_A)
    batchFor(H2M_ORDER, 'generated')

    const res = await call()

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ status: 'generated', hasMore: false })
    expect(withWorkerLeaseMock).not.toHaveBeenCalled()
  })

  it('passes through lease skip and remote-DB block responses', async () => {
    signedInAs('MFG', MFG_A)
    batchFor(H2M_ORDER)

    withWorkerLeaseMock.mockResolvedValueOnce({
      status: 'skipped',
      response: NextResponse.json({ status: 'SKIPPED_ALREADY_RUNNING', processed: 0 }),
    })
    expect(await (await call()).json()).toMatchObject({ status: 'SKIPPED_ALREADY_RUNNING' })

    withWorkerLeaseMock.mockResolvedValueOnce({
      status: 'blocked',
      response: NextResponse.json({ status: 'REMOTE_DB_WORKER_BLOCKED' }, { status: 409 }),
    })
    expect((await call()).status).toBe(409)
    expect(runQRBatchGenerationMock).not.toHaveBeenCalled()
  })
})
