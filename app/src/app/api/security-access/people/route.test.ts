import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const ACTOR = 'actor-1'
const ORG = '11111111-1111-4111-8111-111111111111'
let actor: any
const requireSecurityActor = vi.fn(async (_p: string) => actor)
const loadDirectory = vi.fn()
const actorAlsoHolds = vi.fn(async (..._a: any[]) => true)
vi.mock('@/lib/security-access/admin-api', () => ({ requireSecurityActor: (p: string) => requireSecurityActor(p), actorAlsoHolds: (...a: any[]) => actorAlsoHolds(...a) }))
vi.mock('@/lib/security-access/directory', async () => ({ ...(await vi.importActual<any>('@/lib/security-access/directory')), loadDirectory: (...a: any[]) => loadDirectory(...a) }))

const get = async (qs = '') => { const { GET } = await import('./route'); return GET({ url: `http://localhost/api/security-access/people?${qs}` } as any) }

describe('GET /api/security-access/people', () => {
  beforeEach(() => { loadDirectory.mockReset(); requireSecurityActor.mockClear(); actor = { userId: ACTOR, admin: {} } })

  it('requires security.access.view, validates input and never queries for an unauthorized or forged request', async () => {
    actor = NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    expect((await get()).status).toBe(403)
    expect(requireSecurityActor).toHaveBeenCalledWith('security.access.view')
    actor = { userId: ACTOR, admin: {} }
    expect((await get('org=not-a-uuid')).status).toBe(400)
    expect((await get('limit=9999')).status).toBe(400)
    expect(loadDirectory).not.toHaveBeenCalled()
  })

  it('passes the parsed query and the authenticated actor (never a client-named one) and sets no-store', async () => {
    loadDirectory.mockResolvedValue({ ok: true, value: { people: [], total: 0, counts: {}, organizations: [] } })
    const res = await get(`q=manu&org=${ORG}&actor=someone-else&userId=x`)
    expect(loadDirectory).toHaveBeenCalledWith(actor.admin, ACTOR, expect.objectContaining({ q: 'manu', org: ORG }))
    expect(JSON.stringify(loadDirectory.mock.calls[0])).not.toContain('someone-else')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('reports whether this administrator may open User Management (so a link is only offered when allowed)', async () => {
    loadDirectory.mockResolvedValue({ ok: true, value: { people: [], total: 0, counts: {}, organizations: [] } })
    actorAlsoHolds.mockResolvedValueOnce(false)
    expect((await (await get()).json()).capabilities).toEqual({ userManagement: false })
    actorAlsoHolds.mockResolvedValueOnce(true)
    expect((await (await get()).json()).capabilities).toEqual({ userManagement: true })
    expect(actorAlsoHolds).toHaveBeenLastCalledWith(actor, 'platform.user.manage')
  })

  it('rejects forged filter values before any query', async () => {
    for (const qs of ['category=GUEST', 'orgType=ALL', 'status=online', 'membership=maybe']) expect((await get(qs)).status).toBe(400)
    expect(loadDirectory).not.toHaveBeenCalled()
  })

  it('returns the typed failure for an organization the administrator may not view', async () => {
    loadDirectory.mockResolvedValue({ ok: false, status: 403, code: 'org_forbidden', error: 'You are not authorized to view that organization.' })
    const res = await get(`org=${ORG}`)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'You are not authorized to view that organization.', code: 'org_forbidden' })
  })
})
