import { afterEach, expect, it, vi } from 'vitest'
import { activateInventoryTransport, clearInventoryTransport, createInventoryTrace, inventoryDiagnosticFetch, inventorySpan, timeInventoryOperation } from './inventory-timing'
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('is silent in production and returns the actual operation result', async () => {
  vi.stubEnv('NODE_ENV', 'production')
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  expect(createInventoryTrace()).toBeUndefined()
  const value = { data: [{ private: 'SECRET' }], error: null }
  expect(await timeInventoryOperation(undefined, 'test', () => Promise.resolve(value))).toBe(value)
  expect(log).not.toHaveBeenCalled()
})
it('logs correlated starts, pending and one completion without error or row contents', async () => {
  vi.stubEnv('NODE_ENV', 'development'); vi.useFakeTimers()
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  const trace = createInventoryTrace('inv-test')!
  const end = inventorySpan(trace, 'balances.page', { page: 1 })
  vi.advanceTimersByTime(20000)
  end({ rows: 136, ok: true }); end({ rows: 0 })
  expect(log.mock.calls.filter(([text]) => String(text).includes('"event":"pending"'))).toHaveLength(2)
  expect(log.mock.calls.filter(([text]) => String(text).includes('"event":"end"'))).toHaveLength(1)
  await timeInventoryOperation(trace, 'test', () => Promise.resolve({ data: [{ token: 'SECRET' }], error: { message: 'PRIVATE' } }))
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/SECRET|PRIVATE/)
  expect(vi.getTimerCount()).toBe(0)
})
it('measures the real fetch and existing body read without changing URL, headers, data or consumption', async () => {
  vi.stubEnv('NODE_ENV', 'development')
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  const trace = createInventoryTrace('inv-test')!
  activateInventoryTransport(trace)
  const response = new Response('[{"quantity":12}]', { status: 200 })
  const fetchMock = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  const url = 'https://example.invalid/rest/v1/vw_inventory_on_hand?organization_id=eq.PRIVATE'
  const init = { headers: { Authorization: 'Bearer SECRET' } }
  expect(await inventoryDiagnosticFetch(url, init)).toBe(response)
  expect(response.bodyUsed).toBe(false)
  expect(await response.text()).toBe('[{"quantity":12}]')
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url, init)
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/PRIVATE|SECRET|example.invalid|quantity/)
  expect(JSON.stringify(log.mock.calls)).toContain('http.vw_inventory_on_hand.body.text')
  clearInventoryTransport(trace)
})
it('preserves thrown failures without logging error messages', async () => {
  vi.stubEnv('NODE_ENV', 'development')
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  const failure = new Error('PRIVATE credentials')
  await expect(timeInventoryOperation(createInventoryTrace(), 'test', () => Promise.reject(failure))).rejects.toBe(failure)
  expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE')
})
