import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), report: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }))
vi.mock('@/lib/cron/auth', () => ({ requireCronAuth: () => null }))
vi.mock('@/lib/cron/lease', () => ({
  WORKER_NAMES: { systemLogRetention: 'system-log-retention' },
  withWorkerLease: async (_c: unknown, _w: string, fn: () => Promise<unknown>) => ({ status: 'ran', result: await fn() }),
}))
vi.mock('@/lib/system-logs/server', () => ({ reportWorkerFailure: mocks.report }))

import { GET } from './route'

const run = async () => { const res = await GET(new NextRequest('http://localhost/api/cron/system-log-retention')); return { status: res.status, body: await res.json() } }

beforeEach(() => {
  mocks.rpc.mockReset(); mocks.report.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/cron/system-log-retention', () => {
  it('purges in bounded batches until nothing remains (at most 10 per run)', async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { status: 'completed', deleted_events: 5000, deleted_groups: 2, more_remaining: true }, error: null })
      .mockResolvedValueOnce({ data: { status: 'completed', deleted_events: 12, deleted_groups: 0, more_remaining: false }, error: null })
    const { status, body } = await run()
    expect(status).toBe(200)
    expect(body).toMatchObject({ status: 'OK', deletedEvents: 5012, deletedGroups: 2, batches: 2 })
    expect(mocks.rpc).toHaveBeenCalledWith('system_log_purge_expired', { p_batch_limit: 5000 })
    mocks.rpc.mockReset()
    mocks.rpc.mockResolvedValue({ data: { status: 'completed', deleted_events: 5000, deleted_groups: 0, more_remaining: true }, error: null })
    expect((await run()).body.batches).toBe(10)
  })

  it('reports "not installed" when the migration is pending, without failing', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
    expect(await run()).toEqual({ status: 200, body: { status: 'RETENTION_NOT_INSTALLED', deletedEvents: 0 } })
    expect(mocks.report).not.toHaveBeenCalled()
  })

  it('a failed purge answers 500 and is recorded as a worker failure', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '57014' } })
    const { status } = await run()
    expect(status).toBe(500)
    expect(mocks.report).toHaveBeenCalledWith('system-log-retention', expect.objectContaining({ message: expect.stringContaining('57014') }))
  })

  it('stops when a concurrent run holds the purge lock', async () => {
    mocks.rpc.mockResolvedValue({ data: { status: 'locked', deleted_events: 0, deleted_groups: 0 }, error: null })
    expect((await run()).body).toMatchObject({ status: 'OK', deletedEvents: 0, batches: 1 })
  })
})
