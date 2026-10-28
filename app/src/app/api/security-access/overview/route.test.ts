import { describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

// The permission catalogue behind Roles & Policies → Policies and the Root Access breakdown comes from this read model.
const requireSecurityActor = vi.fn(async (..._a: any[]): Promise<any> => NextResponse.json({ error: 'Forbidden' }, { status: 403 }))
vi.mock('@/lib/security-access/admin-api', () => ({
  requireSecurityActor: (...a: any[]) => requireSecurityActor(...a),
  actorAlsoHolds: vi.fn(async () => false),
  finishTrace: (_t: any, res: any) => res,
  unavailableResponse: () => NextResponse.json({ error: 'unavailable' }, { status: 503 }),
}))

describe('GET /api/security-access/overview (permission catalogue source)', () => {
  it('requires security.access.view and returns no catalogue to an unauthorized viewer', async () => {
    const { GET } = await import('./route')
    const res = await GET()
    expect(res.status).toBe(403)
    expect(requireSecurityActor).toHaveBeenCalledWith('security.access.view', expect.anything())
    const body = await res.json()
    expect(body).not.toHaveProperty('permissions')
  })
})
