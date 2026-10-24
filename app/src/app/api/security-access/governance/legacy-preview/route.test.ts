import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
const mocks = vi.hoisted(() => ({ actor: vi.fn(), rpc: vi.fn() }))
vi.mock('@/lib/security-access/admin-api', () => ({ requireSecurityActor: mocks.actor }))
import { GET } from './route'
const req = (q = '') => new NextRequest(`http://localhost/api/security-access/governance/legacy-preview${q}`)
beforeEach(() => { mocks.rpc.mockReset(); mocks.actor.mockReset().mockResolvedValue({ userId: 'owner', admin: { rpc: mocks.rpc } }) })
describe('owner-only legacy preview', () => {
  it.each([401, 403, 503])('stops before data access when the existing guard returns %i', async status => {
    mocks.actor.mockResolvedValue(NextResponse.json({ error: 'Denied' }, { status }))
    expect((await GET(req())).status).toBe(status); expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('requires Root Access independently of ordinary security policies', async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null })
    expect((await GET(req())).status).toBe(403); expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })
  it('fails closed when Root evaluation is unavailable', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'timeout' } })
    expect((await GET(req())).status).toBe(503)
  })
  it('validates role and page before heavyweight preview queries', async () => {
    mocks.rpc.mockResolvedValue({ data: true, error: null })
    expect((await GET(req('?role=all'))).status).toBe(400)
    expect((await GET(req('?page=-1'))).status).toBe(400)
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
  })
  it('paginates a read-only report and marks the old scope calculation advisory', async () => {
    const range = vi.fn().mockResolvedValue({ data: [{ permission_key: 'inventory.stock.view' }], count: 101, error: null })
    mocks.rpc.mockImplementation((name: string) => name === 'sa_actor_is_root' ? Promise.resolve({ data: true, error: null }) : name === 'sa_legacy_cutover_impact' ? { range } : name === 'sa_legacy_compat_overview' ? Promise.resolve({ data: [], error: null }) : Promise.resolve({ data: null, error: { code: 'PGRST202' } }))
    const response = await GET(req('?role=legacy-user&page=1'))
    expect(response.status).toBe(200); expect(range).toHaveBeenCalledWith(100, 199)
    expect(await response.json()).toMatchObject({ total: 101, page: 1, scopeCoverageVerified: false })
    expect(mocks.rpc.mock.calls.every(([name]) => ['sa_actor_is_root', 'sa_legacy_cutover_impact', 'sa_legacy_compat_overview', 'sa_legacy_preview_version'].includes(name))).toBe(true)
  })
})
