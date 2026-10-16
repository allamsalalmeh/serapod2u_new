import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const getUser = vi.fn()
const explain = vi.fn()
const lookup = vi.fn()
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser } }) }))
vi.mock('@/lib/server/permissions', () => ({ checkPermissionForUser: async () => ({ allowed: false, context: { role_level: 1 } }) }))
vi.mock('@/lib/security-access/preflight', () => ({ explainOperation: (...a: any[]) => explain(...a) }))
vi.mock('@/lib/identity/lookup', () => ({ lookupIdentity: (...a: any[]) => lookup(...a) }))

const ORG = '00000000-0000-4000-8000-000000000001'
const post = (body: unknown) => new NextRequest('http://t/api/users/identity-lookup', { method: 'POST', body: JSON.stringify(body) })
beforeEach(() => { vi.clearAllMocks(); getUser.mockResolvedValue({ data: { user: { id: 'admin' } } }); explain.mockResolvedValue({ allowed: true }); lookup.mockResolvedValue({ status: 'none' }) })

describe('POST /api/users/identity-lookup', () => {
  it('needs a session and a valid organization', async () => {
    const { POST } = await import('./route')
    getUser.mockResolvedValue({ data: { user: null } })
    expect((await POST(post({ organizationId: ORG }))).status).toBe(401)
    getUser.mockResolvedValue({ data: { user: { id: 'admin' } } })
    expect((await POST(post({ organizationId: 'x' }))).status).toBe(400)
  })

  it('asks the same decision creation takes (platform.user.manage in the selected organization) and returns the result', async () => {
    const { POST } = await import('./route')
    const res = await POST(post({ organizationId: ORG, email: 'a@x.test' }))
    expect(explain).toHaveBeenCalledWith('admin', 'platform.user.manage', ORG, expect.any(Function))
    expect(await res.json()).toEqual({ result: { status: 'none' } })
  })

  it('a confirmed denial is 403 DENIED with the reason; the lookup never runs', async () => {
    explain.mockResolvedValue({ allowed: false, code: 'MISSING_MEMBERSHIP', reason: 'Outside your hierarchy.' })
    const { POST } = await import('./route')
    const res = await POST(post({ organizationId: ORG, email: 'a@x.test' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'DENIED', reason: 'Outside your hierarchy.' })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('an unavailable permission service is 503 (not a denial), a failing lookup is 500 FAILED', async () => {
    const { POST } = await import('./route')
    explain.mockRejectedValue(new Error('down'))
    const unavailable = await POST(post({ organizationId: ORG, email: 'a@x.test' }))
    expect(unavailable.status).toBe(503)
    expect((await unavailable.json()).code).toBe('UNAVAILABLE')
    explain.mockResolvedValue({ allowed: true }); lookup.mockRejectedValue(new Error('db'))
    const failed = await POST(post({ organizationId: ORG, email: 'a@x.test' }))
    expect(failed.status).toBe(500)
    expect((await failed.json()).code).toBe('FAILED')
  })
})
