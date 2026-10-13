import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const USER = '22222222-2222-4222-8222-222222222222'
let actor: any
const requireSecurityActor = vi.fn(async (_p: string) => actor)
vi.mock('@/lib/security-access/admin-api', () => ({ requireSecurityActor: (p: string) => requireSecurityActor(p) }))

const get = async (id = USER) => { const { GET } = await import('./route'); return GET({} as any, { params: Promise.resolve({ userId: id }) }) }

const admin = (membership: any[], visible: any[], rowError: any = null, missing = false) => ({
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: missing ? null : { id: USER, full_name: 'T', membership }, error: rowError }) }) }) }),
  rpc: async (fn: string, args: any) => { expect(fn).toBe('sa_directory_visible_memberships'); expect(args.p_user_ids).toEqual([USER]); return { data: visible, error: null } },
})

describe('GET /api/security-access/people/[userId]', () => {
  beforeEach(() => { requireSecurityActor.mockClear(); actor = { userId: 'admin-1', admin: admin([], []) } })

  it('requires security.access.view and validates the id before any read', async () => {
    actor = NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    expect((await get()).status).toBe(403)
    expect(requireSecurityActor).toHaveBeenCalledWith('security.access.view')
    actor = { userId: 'admin-1', admin: admin([], []) }
    expect((await get('not-a-uuid')).status).toBe(400)
  })

  it('returns only memberships the administrator may see, each with its own grant eligibility, no-store', async () => {
    actor = { userId: 'admin-1', admin: admin(
      [{ id: 'm1', organization_id: 'o1', assignments: [{ id: 'a1' }] }, { id: 'm2', organization_id: 'o2', assignments: [{ id: 'a2' }] }],
      [{ membership_id: 'm1', grantable: false, blocked_reason: 'no_authority' }]) }
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = await res.json()
    expect(body.person.membership.map((m: any) => m.id)).toEqual(['m1'])
    expect(body.person.membership[0]).toMatchObject({ grantable: false, grant_blocked_reason: 'no_authority' })
    expect(JSON.stringify(body)).not.toContain('a2')
  })

  it('answers 404 for a missing person', async () => {
    actor = { userId: 'admin-1', admin: admin([], [], null, true) }
    expect((await get()).status).toBe(404)
  })
})
