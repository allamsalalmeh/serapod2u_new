// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REPORT_ENDPOINT, __clientQueueForTests, __resetClientReporterForTests, buildClientReport, flush, installGlobalErrorListeners,
  referenceSuffix, reportClientError,
} from './client'

const fetchMock = vi.fn()
const sent = () => fetchMock.mock.calls.filter(c => c[0] === REPORT_ENDPOINT).map(c => JSON.parse(c[1].body).events).flat()

beforeEach(() => {
  __resetClientReporterForTests()
  window.sessionStorage.clear()
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ accepted: [] }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('browser report contents', () => {
  it('sends no identity, organization or environment — the server derives them', () => {
    const r = buildClientReport(new TypeError('Failed to fetch'), { module: 'Orders', action: 'Save' })!
    expect(r.category).toBe('network')
    expect(Object.keys(r)).not.toEqual(expect.arrayContaining(['actorId', 'organizationId', 'environment', 'source', 'kind']))
    expect(r.referenceId).toMatch(/^ERR-/)
  })

  it('links a failed API response to the server report through X-Request-ID or the body reference', () => {
    const res = new Response('{}', { status: 500, headers: { 'x-request-id': 'REQ-ABCDEFGHJKMN' } })
    Object.defineProperty(res, 'url', { value: 'http://localhost/api/admin/shop-staff-performance?x=1' })
    const r = buildClientReport(new Error('Failed to load shop staff performance'), { response: res })!
    expect(r.serverReferenceId).toBe('REQ-ABCDEFGHJKMN')
    expect(r.apiRoute).toBe('/api/admin/shop-staff-performance')
    expect(r.httpStatus).toBe(500)
    expect(r.category).toBe('server')
    expect(buildClientReport(new Error('x'), { status: 500, body: { error: 'x', referenceId: 'REQ-ZZZZZZZZZZZZ' } })!.serverReferenceId).toBe('REQ-ZZZZZZZZZZZZ')
  })

  it('does not report cancellations, routine validation/permission outcomes or dev hot-reload noise', () => {
    expect(reportClientError(Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }))).toBeNull()
    expect(reportClientError(new Error('Quantity is required'), { status: 422 })).toBeNull()
    expect(reportClientError({ code: '42501', message: 'permission denied for table orders' })).toBeNull()
    expect(reportClientError(new Error('[HMR] Invalid message'))).toBeNull()
    expect(__clientQueueForTests()).toHaveLength(0)
    expect(reportClientError(new Error('Quantity is required'), { status: 422, reportWarnings: true })).toMatch(/^ERR-/)
  })

  it('formats a reference for toasts', () => {
    expect(referenceSuffix('ERR-ABCDEFGHJKMN')).toBe(' (Reference: ERR-ABCDEFGHJKMN)')
    expect(referenceSuffix(null)).toBe('')
  })
})

describe('bounded buffering and delivery', () => {
  it('batches, de-duplicates repeats within 10 s and returns the first reference', async () => {
    const a = reportClientError(new TypeError('Failed to fetch'), { module: 'Orders', action: 'Save' })
    const b = reportClientError(new TypeError('Failed to fetch'), { module: 'Orders', action: 'Save' })
    expect(b).toBe(a)
    reportClientError(new Error('Something else broke'), { module: 'Orders', action: 'Save' })
    await flush()
    expect(sent().map((e: any) => e.referenceId)).toHaveLength(2)
    expect(__clientQueueForTests()).toHaveLength(0)
  })

  it('keeps at most 20 queued reports and at most 10 per request', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    for (let i = 0; i < 30; i++) reportClientError(new Error(`distinct failure ${'x'.repeat(i)}`), { action: `a${i}` })
    expect(__clientQueueForTests()).toHaveLength(20)
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    await flush()
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body).events).toHaveLength(10)
  })

  it('retries network/5xx failures three times, then gives up (no delivery promise)', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 503 }))
    reportClientError(new TypeError('Failed to fetch'), { action: 'retry me' })
    for (let i = 0; i < 4; i++) await flush()
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(__clientQueueForTests()).toHaveLength(0)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('stops after 401/403 (signed out) instead of retrying', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }))
    reportClientError(new TypeError('Failed to fetch'), { action: 'one' })
    await flush()
    reportClientError(new Error('later failure'), { action: 'two' })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not send while offline and keeps a bounded, expiring copy for a reload', async () => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false })
    reportClientError(new Error('Unexpected render state'), { action: 'offline' })
    await flush()
    expect(fetchMock).not.toHaveBeenCalled()
    const stored = JSON.parse(window.sessionStorage.getItem('system-logs:pending')!)
    expect(stored).toHaveLength(1)
    expect(stored[0].expiresAt - Date.now()).toBeLessThanOrEqual(15 * 60_000)
    // A reload restores it; an expired copy is discarded.
    __resetClientReporterForTests()
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true })
    window.sessionStorage.setItem('system-logs:pending', JSON.stringify([...stored, { ...stored[0], report: { ...stored[0].report, referenceId: 'ERR-EXPIRED00000' }, expiresAt: Date.now() - 1 }]))
    reportClientError(new Error('after reload'), { action: 'reload' })
    await flush()
    const refs = sent().map((e: any) => e.referenceId)
    expect(refs).toContain(stored[0].report.referenceId)
    expect(refs).not.toContain('ERR-EXPIRED00000')
  })

  it('a reporting failure never throws into the caller', () => {
    fetchMock.mockImplementation(() => { throw new Error('fetch exploded') })
    expect(() => reportClientError(new TypeError('Failed to fetch'))).not.toThrow()
    return expect(flush()).resolves.toBeUndefined()
  })
})

describe('global listeners (uncaught only)', () => {
  it('captures uncaught errors and unhandled rejections once installed, and can be removed', async () => {
    const remove = installGlobalErrorListeners()
    expect(installGlobalErrorListeners()).toBeTypeOf('function') // idempotent
    window.dispatchEvent(new ErrorEvent('error', { error: new TypeError("Cannot read properties of undefined (reading 'id')"), message: 'x' }))
    const rejection = new Event('unhandledrejection') as any
    rejection.reason = new Error('Unhandled async failure')
    window.dispatchEvent(rejection)
    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }))
    await flush()
    const actions = sent().map((e: any) => e.action)
    expect(actions).toEqual(expect.arrayContaining(['Uncaught error', 'Unhandled promise rejection']))
    expect(sent()).toHaveLength(2)
    remove()
  })
})
