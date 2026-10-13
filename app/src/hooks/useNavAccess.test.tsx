// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NAV_ACCESS_CHANGED_EVENT, NavAccessProvider, clearNavAccessCache, notifyNavAccessChanged, useNavAccess } from './useNavAccess'

const snapshot = (userId: string, organizationId: string | null, destinations: Record<string, boolean>) => ({ userId, organizationId, destinations, sidebar: { users: false, securityAccess: false }, policies: [] })
const respond = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

function Probe({ ids = ['hr/my-workspace', 'hr'] }: { ids?: string[] }) {
  const nav = useNavAccess()
  return (
    <div>
      <span data-testid="status">{nav.status}</span>
      {ids.map(id => <span key={id} data-testid={id}>{String(nav.allows(id))}</span>)}
      <button onClick={nav.refresh}>refresh</button>
    </div>
  )
}
const mount = (userId: string, organizationId: string | null) =>
  <NavAccessProvider userId={userId} organizationId={organizationId}><Probe /></NavAccessProvider>

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { cleanup(); clearNavAccessCache(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('NavAccessProvider', () => {
  it('shows nothing gated while the first answer is pending (no flash of unauthorized navigation)', () => {
    fetchMock.mockReturnValue(new Promise(() => undefined))
    render(mount('nu-1', 'o-1'))
    expect(screen.getByTestId('status').textContent).toBe('loading')
    expect(screen.getByTestId('hr/my-workspace').textContent).toBe('false')
  })

  it('exposes the server\'s answers once ready', async () => {
    fetchMock.mockResolvedValue(respond(200, { status: 'ready', snapshot: snapshot('u-ready', 'o-1', { 'hr/my-workspace': true, hr: false }) }))
    render(mount('u-ready', 'o-1'))
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'))
    expect(screen.getByTestId('hr/my-workspace').textContent).toBe('true')
    expect(screen.getByTestId('hr').textContent).toBe('false')
    expect(fetchMock).toHaveBeenCalledWith('/api/security-access/me/navigation', { cache: 'no-store', signal: expect.any(AbortSignal) })
  })

  it.each([
    [503, 'unavailable'],
    [500, 'unavailable'],
    [401, 'signed_out'],
    [403, 'denied'],
  ])('keeps a failed check (%i) distinct from a confirmed denial and shows nothing', async (status, expected) => {
    fetchMock.mockResolvedValue(respond(status))
    render(mount(`u-${status}`, 'o-1'))
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe(expected))
    expect(screen.getByTestId('hr/my-workspace').textContent).toBe('false')
  })

  it('treats a network failure as unavailable, not as a denial', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'))
    render(mount('u-net', 'o-1'))
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('unavailable'))
  })

  it('gives up on a request that never answers: unavailable (Retry), not an endless skeleton', async () => {
    let signal: AbortSignal | undefined
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal?.reason)))
    })
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController()
      queueMicrotask(() => controller.abort(new DOMException('timed out', 'TimeoutError')))
      return controller.signal
    })
    render(mount('u-slow', 'o-1'))
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('unavailable'))
    expect(timeout).toHaveBeenCalledWith(20_000)
    timeout.mockRestore()
  })

  it('discards a response that names another account or organization', async () => {
    fetchMock.mockResolvedValue(respond(200, { status: 'ready', snapshot: snapshot('someone-else', 'o-1', { 'hr/my-workspace': true }) }))
    render(mount('u-mismatch', 'o-1'))
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('unavailable'))
    expect(screen.getByTestId('hr/my-workspace').textContent).toBe('false')
  })

  it('never lets a different account or organization inherit the previous answers', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { status: 'ready', snapshot: snapshot('u-a', 'o-1', { 'hr/my-workspace': true }) }))
    const { rerender } = render(mount('u-a', 'o-1'))
    await waitFor(() => expect(screen.getByTestId('hr/my-workspace').textContent).toBe('true'))

    // Another user in the same shell (account switch): immediately nothing, until its own answer arrives.
    let resolveB: (v: unknown) => void = () => undefined
    fetchMock.mockReturnValueOnce(new Promise(r => { resolveB = r }))
    rerender(mount('u-b', 'o-1'))
    expect(screen.getByTestId('status').textContent).toBe('loading')
    expect(screen.getByTestId('hr/my-workspace').textContent).toBe('false')
    await act(async () => { resolveB(respond(200, { status: 'ready', snapshot: snapshot('u-b', 'o-1', { 'hr/my-workspace': false, hr: true }) })) })
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'))
    expect(screen.getByTestId('hr/my-workspace').textContent).toBe('false')
    expect(screen.getByTestId('hr').textContent).toBe('true')

    // Same user, other organization: also not reused.
    fetchMock.mockReturnValueOnce(new Promise(() => undefined))
    rerender(mount('u-b', 'o-2'))
    expect(screen.getByTestId('status').textContent).toBe('loading')
    expect(screen.getByTestId('hr').textContent).toBe('false')
  })

  it('ignores a late answer for an identity that is no longer current', async () => {
    let resolveA: (v: unknown) => void = () => undefined
    fetchMock.mockReturnValueOnce(new Promise(r => { resolveA = r }))
    const { rerender } = render(mount('u-late-a', 'o-1'))
    fetchMock.mockReturnValueOnce(new Promise(() => undefined))
    rerender(mount('u-late-b', 'o-1'))
    await act(async () => { resolveA(respond(200, { status: 'ready', snapshot: snapshot('u-late-a', 'o-1', { 'hr/my-workspace': true }) })) })
    expect(screen.getByTestId('status').textContent).toBe('loading')
    expect(screen.getByTestId('hr/my-workspace').textContent).toBe('false')
  })

  it('re-reads access when it changes anywhere in the app (assignment, revocation, organization change)', async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { status: 'ready', snapshot: snapshot('u-rev', 'o-1', { 'hr/my-workspace': true }) }))
    render(mount('u-rev', 'o-1'))
    await waitFor(() => expect(screen.getByTestId('hr/my-workspace').textContent).toBe('true'))

    fetchMock.mockResolvedValueOnce(respond(200, { status: 'ready', snapshot: snapshot('u-rev', 'o-1', { 'hr/my-workspace': false }) }))
    act(() => notifyNavAccessChanged())
    await waitFor(() => expect(screen.getByTestId('hr/my-workspace').textContent).toBe('false'))
    expect(NAV_ACCESS_CHANGED_EVENT).toBe('sa:nav-access-changed')
  })

  it('outside a provider nothing gated is shown', () => {
    render(<Probe />)
    expect(screen.getByTestId('status').textContent).toBe('loading')
    expect(screen.getByTestId('hr').textContent).toBe('false')
  })
})

describe('NavAccessProvider requests and cache', () => {
  const ready = (uid: string, org = 'o-1', destinations: Record<string, boolean> = { hr: true }) =>
    respond(200, { status: 'ready', snapshot: snapshot(uid, org, destinations) })

  it('sends ONE request for equivalent callers in flight (two shells, StrictMode double effect)', async () => {
    fetchMock.mockResolvedValue(ready('u-dedupe'))
    render(<><div>{mount('u-dedupe', 'o-1')}</div><div>{mount('u-dedupe', 'o-1')}</div></>)
    await waitFor(() => expect(screen.getAllByTestId('status')[0].textContent).toBe('ready'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not refetch on an ordinary route change (remount) and shows the held answer immediately', async () => {
    fetchMock.mockResolvedValue(ready('u-route'))
    const first = render(mount('u-route', 'o-1'))
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'))
    first.unmount()
    render(mount('u-route', 'o-1'))
    expect(screen.getByTestId('status').textContent).toBe('ready') // no loading stage, no blink
    expect(screen.getByTestId('hr').textContent).toBe('true')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('revalidates in the background after the freshness window while still showing the held answer', async () => {
    fetchMock.mockResolvedValueOnce(ready('u-stale'))
    const first = render(mount('u-stale', 'o-1'))
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'))
    first.unmount()
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 2 * 60_000)
    fetchMock.mockResolvedValueOnce(ready('u-stale', 'o-1', { hr: false }))
    render(mount('u-stale', 'o-1'))
    expect(screen.getByTestId('hr').textContent).toBe('true')
    await waitFor(() => expect(screen.getByTestId('hr').textContent).toBe('false')) // revocation is reflected
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never shows a remembered answer past its bounded lifetime', async () => {
    fetchMock.mockResolvedValueOnce(ready('u-old'))
    const first = render(mount('u-old', 'o-1'))
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'))
    first.unmount()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000)
    fetchMock.mockReturnValueOnce(new Promise(() => undefined))
    render(mount('u-old', 'o-1'))
    expect(screen.getByTestId('status').textContent).toBe('loading')
    vi.restoreAllMocks()
  })

  it('does not carry the previous account\'s answers across a sign-out (cache cleared)', async () => {
    fetchMock.mockResolvedValueOnce(ready('u-out'))
    const first = render(mount('u-out', 'o-1'))
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'))
    first.unmount()
    clearNavAccessCache()
    fetchMock.mockReturnValueOnce(new Promise(() => undefined))
    render(mount('u-out', 'o-1'))
    expect(screen.getByTestId('status').textContent).toBe('loading')
  })

  it('ignores a response that arrives after sign-out / identity reset (obsolete session)', async () => {
    let resolveOld: (v: unknown) => void = () => undefined
    fetchMock.mockReturnValueOnce(new Promise(r => { resolveOld = r }))
    const first = render(mount('u-obsolete', 'o-1'))
    first.unmount()
    clearNavAccessCache()
    await act(async () => { resolveOld(ready('u-obsolete')) })
    fetchMock.mockReturnValueOnce(new Promise(() => undefined))
    render(mount('u-obsolete', 'o-1'))
    expect(screen.getByTestId('status').textContent).toBe('loading') // the late answer was not stored
  })

  it('retries after a failure from loading (not from a stale menu) and recovers', async () => {
    fetchMock.mockResolvedValueOnce(respond(503, { status: 'unavailable' }))
    render(mount('u-retry', 'o-1'))
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('unavailable'))
    fetchMock.mockResolvedValueOnce(ready('u-retry'))
    act(() => screen.getByText('refresh').click())
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('a failed check is not remembered: the next shell asks again instead of reusing a denial', async () => {
    fetchMock.mockResolvedValueOnce(respond(503, { status: 'unavailable' }))
    const first = render(mount('u-fail', 'o-1'))
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('unavailable'))
    first.unmount()
    fetchMock.mockResolvedValueOnce(ready('u-fail'))
    render(mount('u-fail', 'o-1'))
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'))
  })

  it('a grant/revocation event forces a fresh request even while one is in flight', async () => {
    let resolveOld: (v: unknown) => void = () => undefined
    fetchMock.mockReturnValueOnce(new Promise(r => { resolveOld = r }))
    render(mount('u-event', 'o-1'))
    fetchMock.mockResolvedValueOnce(ready('u-event', 'o-1', { hr: false }))
    act(() => notifyNavAccessChanged())
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'))
    await act(async () => { resolveOld(ready('u-event', 'o-1', { hr: true })) }) // the older answer must not win
    expect(screen.getByTestId('hr').textContent).toBe('false')
  })
})
