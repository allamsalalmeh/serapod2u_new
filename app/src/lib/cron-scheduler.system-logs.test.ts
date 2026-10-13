import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Worker failures seen by the existing scheduler are recorded in System Logs (5xx and timeouts only). */
const scheduleMock = vi.fn()
const report = vi.fn(async () => 'JOB-ABCDEFGHJKMN')
vi.mock('node-cron', () => ({ default: { schedule: (...args: unknown[]) => scheduleMock(...args) } }))
vi.mock('@/lib/system-logs/server', () => ({ reportWorkerFailure: report }))

const REGISTRY_KEY = Symbol.for('serapod2u.cron.scheduler.registry')
const originalEnv = { ...process.env }
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetModules()
  scheduleMock.mockReset(); report.mockClear()
  delete (globalThis as any)[REGISTRY_KEY]
  process.env.INTERNAL_CRON_BASE_URL = 'http://127.0.0.1:3000'
  process.env.CRON_SECRET = 'test-secret'
  delete process.env.DISABLE_INTERNAL_CRON_WORKERS
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllGlobals(); process.env = { ...originalEnv } })

const tick = async (status: number | 'timeout', headers: Record<string, string> = {}) => {
  fetchMock = vi.fn(async () => {
    if (status === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    return new Response('{}', { status, headers })
  })
  vi.stubGlobal('fetch', fetchMock)
  const mod = await import('./cron-scheduler')
  mod.startCronScheduler()
  ;(scheduleMock.mock.calls[0][1] as () => void)()
  await new Promise(r => setTimeout(r, 10))
}

describe('scheduler → System Logs worker reports', () => {
  it('records a 5xx run with the route\'s X-Request-ID so it links to the route\'s own report', async () => {
    await tick(500, { 'x-request-id': 'REQ-ABCDEFGHJKMN' })
    expect(report).toHaveBeenCalledWith('qr-reverse-worker', expect.objectContaining({ status: 500, serverReferenceId: 'REQ-ABCDEFGHJKMN', apiRoute: '/api/cron/qr-reverse-worker' }))
  })

  it('records timeouts', async () => {
    await tick('timeout')
    expect(report).toHaveBeenCalledWith('qr-reverse-worker', expect.objectContaining({ message: expect.stringContaining('timed out') }))
  })

  it('does not record configuration states (409 remote-DB guard, 401) or successes', async () => {
    for (const status of [200, 401, 409]) {
      vi.resetModules(); scheduleMock.mockReset(); delete (globalThis as any)[REGISTRY_KEY]
      await tick(status)
    }
    expect(report).not.toHaveBeenCalled()
  })
})
