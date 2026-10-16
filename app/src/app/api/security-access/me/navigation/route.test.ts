import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

let actor: any
const loadNavActor = vi.fn()
const evaluateNavSnapshot = vi.fn()
vi.mock('@/lib/security-access/admin-api', () => ({ requireSelfServiceActor: async () => actor }))
vi.mock('@/lib/server/nav-access', () => ({ loadNavActor, evaluateNavSnapshot }))

const get = async () => (await import('./route')).GET()

describe('GET /api/security-access/me/navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    actor = { userId: 'u-1', organizationId: 'org-a', admin: {} }
    loadNavActor.mockResolvedValue({ userId: 'u-1', organizationId: 'org-a' })
  })

  it('passes an expired login (401) and an inactive account (403) through, as distinct states', async () => {
    actor = NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    expect((await get()).status).toBe(401)
    actor = NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    expect((await get()).status).toBe(403)
    expect(evaluateNavSnapshot).not.toHaveBeenCalled()
  })

  it('returns the caller\'s own snapshot, uncached', async () => {
    evaluateNavSnapshot.mockResolvedValue({ userId: 'u-1', organizationId: 'org-a', destinations: { 'hr/my-workspace': true }, sidebar: { users: false, securityAccess: true }, policies: [] })
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toMatchObject({ status: 'ready', snapshot: { userId: 'u-1', destinations: { 'hr/my-workspace': true }, sidebar: { securityAccess: true } } })
    expect(loadNavActor).toHaveBeenCalledWith('u-1')
  })

  it('reports a failed permission check as 503 unavailable, not as a denial or an empty allow-list', async () => {
    evaluateNavSnapshot.mockRejectedValue(new Error('policy_data_unavailable'))
    const res = await get()
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'unavailable' })
  })

  it('reports an unreadable account as unavailable', async () => {
    loadNavActor.mockResolvedValue(null)
    expect((await get()).status).toBe(503)
  })
})
