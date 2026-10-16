import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), userOrg: 'org-1' as string | null, adminThrows: false }))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    if (mocks.adminThrows) throw new Error('Missing Supabase admin environment variables')
    return {
      rpc: mocks.rpc,
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { organization_id: mocks.userOrg }, error: null }) }) }) }),
    }
  },
}))

import { __resetReporterForTests, buildServerPayload, referenceHeaders, reportRequestError, reportServerError, reportWorkerFailure, storeDiagnostic } from './server'
import { resetRateLimitsForTests } from '@/lib/security/rate-limit'

beforeEach(() => {
  __resetReporterForTests()
  resetRateLimitsForTests()
  mocks.rpc.mockReset()
  mocks.rpc.mockResolvedValue({ data: { stored: true }, error: null })
  mocks.adminThrows = false
  mocks.userOrg = 'org-1'
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('server reporter payload', () => {
  it('builds a sanitized, fingerprinted error with server-side environment and the request id as reference', () => {
    const p = buildServerPayload({
      error: Object.assign(new Error('duplicate key for alice@example.com token=abcdefghijk'), { code: '23505', details: 'Key (email)=(alice@example.com)' }),
      module: 'Supply Chain', action: 'Create order', apiRoute: '/api/orders?secret=1', method: 'post', status: 500,
      actorId: 'u-1', organizationId: 'org-1', referenceId: 'REQ-ABCDEFGHJKMN',
    })!
    expect(p.reference_id).toBe('REQ-ABCDEFGHJKMN')
    expect(p.environment).toBe('test')
    expect(p.source).toBe('server')
    expect(p.message).not.toMatch(/alice|abcdefghijk/)
    expect(JSON.stringify(p.details)).not.toMatch(/alice/)
    expect(p.api_route).toBe('/api/orders')
    expect(p.http_method).toBe('POST')
    // The database code wins over the generic 500: a duplicate key is a conflict (a warning, not an outage).
    expect(p.category).toBe('conflict')
    expect(p.severity).toBe('warning')
    expect(p.code).toBe('23505')
    expect(p.fingerprint).toMatch(/^[a-f0-9]{16}$/)
  })

  it('drops cancellations and Next.js control-flow signals', () => {
    expect(buildServerPayload({ error: Object.assign(new Error('aborted'), { name: 'AbortError' }) })).toBeNull()
    expect(buildServerPayload({ error: Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/login;307;' }) })).toBeNull()
  })

  it('links a render failure by its digest and a worker run by the route request id', () => {
    expect(buildServerPayload({ error: Object.assign(new Error('render failed'), { digest: '2468013579' }) })!.correlation_id).toBe('DIG-2468013579')
    const w = buildServerPayload({ source: 'worker', message: 'x responded 500', status: 500, serverReferenceId: 'REQ-ABCDEFGHJKMN' })!
    expect(w.reference_id).toMatch(/^JOB-/)
    expect(w.server_reference_id).toBe('REQ-ABCDEFGHJKMN')
  })

  it('exposes the server reference as a response header only when there is one', () => {
    expect(referenceHeaders('REQ-ABCDEFGHJKMN')).toEqual({ 'x-request-id': 'REQ-ABCDEFGHJKMN' })
    expect(referenceHeaders(null)).toEqual({})
  })
})

describe('server reporter delivery never changes the caller outcome', () => {
  it('stores through the service-role ingest function and resolves the actor organization on the server', async () => {
    const ref = await reportServerError({ error: new Error('boom'), status: 500, actorId: 'u-1' })
    expect(ref).toMatch(/^REQ-/)
    expect(mocks.rpc).toHaveBeenCalledWith('system_log_ingest', { p: expect.objectContaining({ actor_id: 'u-1', organization_id: 'org-1', source: 'server' }) })
  })

  it('returns a reference and does not throw when the database refuses, is missing or the client cannot be created', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: '23514', message: 'check' } })
    await expect(reportServerError({ error: new Error('a') })).resolves.toMatch(/^REQ-/)
    mocks.rpc.mockRejectedValueOnce(new Error('socket hang up'))
    await expect(reportServerError({ error: new Error('b') })).resolves.toMatch(/^REQ-/)
    mocks.adminThrows = true
    await expect(reportServerError({ error: new Error('c') })).resolves.toMatch(/^REQ-/)
  })

  it('backs off for 5 minutes when the storage is not installed (migration pending)', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } })
    await reportServerError({ error: new Error('first') })
    await reportServerError({ error: new Error('second') })
    await reportServerError({ error: new Error('third') })
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })

  it('rate-limits a repeating failure in-process (30/min per fingerprint)', async () => {
    const payload = buildServerPayload({ error: new Error('same failure'), organizationId: 'o' })!
    const results = []
    for (let i = 0; i < 35; i++) results.push(await storeDiagnostic({ ...payload, reference_id: `REQ-RATE${String(i).padStart(4, '0')}` }))
    expect(results.filter(r => r.stored)).toHaveLength(30)
    expect(results.at(-1)!.reason).toBe('rate_limited')
  })

  it('reports worker failures without inventing a user', async () => {
    await reportWorkerFailure('qr-generation-worker', { message: '/api/cron/qr-generation-worker responded 500', status: 500 })
    expect(mocks.rpc).toHaveBeenCalledWith('system_log_ingest', { p: expect.objectContaining({ source: 'worker', actor_id: null, module: 'Background jobs', action: 'qr-generation-worker' }) })
  })

  it('onRequestError hook: records uncaught route errors (ignoring any client-supplied request id), skips control flow, never throws', async () => {
    await reportRequestError(new Error('route crashed'), { path: '/api/orders/1', method: 'POST', headers: { 'x-request-id': 'REQ-FORGEDFORGED', 'user-agent': 'Mozilla/5.0 Chrome/129.0' } },
      { routerKind: 'App Router', routePath: '/api/orders/[id]', routeType: 'route' })
    expect(mocks.rpc).toHaveBeenCalledWith('system_log_ingest', { p: expect.objectContaining({ api_route: '/api/orders/1', module: 'Supply Chain', category: 'unexpected' }) })
    const ref = (mocks.rpc.mock.calls[0][1] as any).p.reference_id
    expect(ref).toMatch(/^REQ-[0-9A-Z]{12}$/)
    expect(ref).not.toBe('REQ-FORGEDFORGED')
    mocks.rpc.mockClear()
    await reportRequestError(Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }), { path: '/x' }, {})
    expect(mocks.rpc).not.toHaveBeenCalled()
    mocks.adminThrows = true
    await expect(reportRequestError(new Error('y'), { path: '/x' }, {})).resolves.toBeUndefined()
  })
})
