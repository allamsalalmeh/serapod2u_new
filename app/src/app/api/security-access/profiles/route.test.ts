import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

let actor: any
const requireSecurityActor = vi.fn(async (_p: string) => actor)
const runProfileAction = vi.fn()
const loadProfiles = vi.fn()
vi.mock('@/lib/security-access/admin-api', () => ({ requireSecurityActor: (p: string) => requireSecurityActor(p) }))
vi.mock('@/lib/security-access/profiles', async () => ({ ...(await vi.importActual<any>('@/lib/security-access/profiles')), runProfileAction: (...a: any[]) => runProfileAction(...a), loadProfiles: (...a: any[]) => loadProfiles(...a) }))
const post = async (body: unknown) => { const { POST } = await import('./route'); return POST({ json: async () => body } as any) }
const ROLE = '11111111-1111-4111-8111-111111111111'

describe('/api/security-access/profiles', () => {
  beforeEach(() => { actor = { userId: 'admin-1', admin: {} }; requireSecurityActor.mockClear(); runProfileAction.mockReset(); loadProfiles.mockReset() })

  it('requires role-management authority for changes and view authority only for holders', async () => {
    runProfileAction.mockResolvedValue({ ok: true, value: {} })
    await post({ action: 'submit', roleId: ROLE })
    expect(requireSecurityActor).toHaveBeenLastCalledWith('security.role.manage')
    await post({ action: 'holders', roleId: ROLE })
    expect(requireSecurityActor).toHaveBeenLastCalledWith('security.access.view')
  })
  it('does nothing for an unauthorized caller or an invalid/forged request', async () => {
    actor = NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    expect((await post({ action: 'publish', roleId: ROLE, impactHash: 'a'.repeat(32) })).status).toBe(403)
    actor = { userId: 'admin-1', admin: {} }
    for (const body of [null, { action: 'delete', roleId: ROLE }, { action: 'create', roleKey: 'k', name: 'n', permissionKeys: ['inventory.*'] }, { action: 'save_draft', roleId: ROLE, name: 'n', permissionKeys: [], source: 'template' }]) {
      expect((await post(body)).status).toBe(400)
    }
    expect(runProfileAction).not.toHaveBeenCalled()
  })
  it('acts as the authenticated administrator and relays typed failures', async () => {
    runProfileAction.mockResolvedValue({ ok: false, status: 409, code: 'standard_protected', error: 'protected' })
    const res = await post({ action: 'save_draft', roleId: ROLE, name: 'Std', permissionKeys: [] })
    expect(runProfileAction).toHaveBeenCalledWith(actor.admin, 'admin-1', expect.objectContaining({ action: 'save_draft' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'protected', code: 'standard_protected' })
  })
  it('lists profiles for anyone with view authority', async () => {
    loadProfiles.mockResolvedValue({ ok: true, value: { migrationReady: true, profiles: [] } })
    const { GET } = await import('./route')
    expect((await GET()).status).toBe(200)
    expect(requireSecurityActor).toHaveBeenLastCalledWith('security.access.view')
  })
})
