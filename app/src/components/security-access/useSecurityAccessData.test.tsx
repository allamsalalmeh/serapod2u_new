// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useReadModel } from './useSecurityAccessData'

type Pending = { url: string; resolve: (r: any) => void; signal: AbortSignal }
let pending: Pending[] = []
const res = (status: number, body: any) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(status === 503 ? { 'x-correlation-id': 'corr-9' } : {}), json: async () => body })

beforeEach(() => {
  pending = []
  global.fetch = vi.fn((url: string, init: any) => new Promise(resolve => pending.push({ url, resolve, signal: init.signal }))) as any
})
const settle = async (i: number, status: number, body: any) => { await act(async () => { pending[i].resolve(res(status, body)) }) }

describe('useReadModel', () => {
  it('a late response from a superseded request never replaces newer state', async () => {
    const { result } = renderHook(() => useReadModel('/x', 'u1:o1'))
    act(() => result.current.reload())
    expect(pending).toHaveLength(2)
    expect(pending[0].signal.aborted).toBe(true)
    await settle(1, 200, { v: 'new' })
    await settle(0, 200, { v: 'old' })
    expect(result.current).toMatchObject({ status: 'ready', data: { v: 'new' } })
  })

  it('a successful empty response is "ready" (a real empty), distinct from a failure', async () => {
    const { result } = renderHook(() => useReadModel('/x', 'u1:o1'))
    await settle(0, 200, { items: [] })
    expect(result.current).toMatchObject({ status: 'ready', data: { items: [] } })
    const failed = renderHook(() => useReadModel('/x', 'u1:o1'))
    await settle(1, 503, { error: 'Security & Access is temporarily unavailable. Please retry.' })
    expect(failed.result.current).toMatchObject({ status: 'unavailable', data: null, correlationId: 'corr-9' })
  })

  it('keeps verified data through a transient refresh failure (stale), clears it on a confirmed denial', async () => {
    const { result } = renderHook(() => useReadModel('/x', 'u1:o1'))
    await settle(0, 200, { v: 1 })
    act(() => result.current.reload())
    expect(result.current.refreshing).toBe(true)
    await settle(1, 503, { error: 'down' })
    expect(result.current).toMatchObject({ status: 'ready', data: { v: 1 }, stale: true, refreshing: false })
    act(() => result.current.reload())
    await settle(2, 403, { error: 'Forbidden' })
    expect(result.current).toMatchObject({ status: 'denied', data: null })
  })

  it('session expiry is its own state and clears data', async () => {
    const { result } = renderHook(() => useReadModel('/x', 'u1:o1'))
    await settle(0, 200, { v: 1 })
    act(() => result.current.reload())
    await settle(1, 401, { error: 'Your session has expired. Sign in again.' })
    expect(result.current).toMatchObject({ status: 'unauthenticated', data: null })
  })

  it('switching account or organization clears data immediately and ignores the old account\'s response', async () => {
    const { result, rerender } = renderHook(({ key }) => useReadModel('/x', key), { initialProps: { key: 'u1:o1' } })
    await settle(0, 200, { who: 'u1' })
    act(() => result.current.reload())
    rerender({ key: 'u2:o2' })
    expect(result.current).toMatchObject({ status: 'loading', data: null })
    await settle(1, 200, { who: 'u1-late' })
    expect(result.current.data).toBeNull()
    await settle(2, 200, { who: 'u2' })
    expect(result.current.data).toEqual({ who: 'u2' })
  })

  it('verified schema-not-ready is reported only when the response says so', async () => {
    const { result } = renderHook(() => useReadModel('/x', 'k', { isSchemaMissing: b => b.schemaReady === false }))
    await settle(0, 200, { schemaReady: false, missingDependency: ['permissions'] })
    expect(result.current.status).toBe('schema_missing')
  })

  it('network failure is unavailable; there is no automatic retry', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as any
    const { result } = renderHook(() => useReadModel('/x', 'k'))
    await waitFor(() => expect(result.current.status).toBe('unavailable'))
    await new Promise(r => setTimeout(r, 20))
    expect((global.fetch as any).mock.calls.length).toBe(1)
  })
})
