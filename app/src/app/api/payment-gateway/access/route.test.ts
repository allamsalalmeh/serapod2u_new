import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
const m = vi.hoisted(() => ({ session: vi.fn(), guard: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: m.session } }) }))
vi.mock('@/lib/security-access/operation', () => ({ guardUserOperation: m.guard }))
import { POST } from './route'
beforeEach(() => { vi.clearAllMocks(); m.session.mockResolvedValue({ data: { user: { id: 'verified-actor' } }, error: null }); m.guard.mockResolvedValue(null) })
describe('gateway action preflight', () => {
  it('preserves the authoritative 403 reference without accessing credentials or changing access', async () => {
    m.guard.mockResolvedValue(NextResponse.json({ code: 'sa_forbidden', reason: 'MISSING_PERMISSION', referenceId: 'SA-persisted123' }, { status: 403 }))
    const response = await POST()
    expect(response.status).toBe(403); expect((await response.json()).referenceId).toBe('SA-persisted123')
    expect(m.guard).toHaveBeenCalledWith('verified-actor', 'ecommerce.channel.manage', { resourceType: 'payment_gateway_settings' })
  })
  it('allows only a successful server authorization decision', async () => {
    expect(await (await POST()).json()).toEqual({ allowed: true })
  })
  it('keeps expired sessions separate from service failures', async () => {
    m.session.mockResolvedValue({ data: { user: null }, error: { status: 401 } })
    expect((await POST()).status).toBe(401)
    m.session.mockResolvedValue({ data: { user: null }, error: { status: 503 } })
    expect((await POST()).status).toBe(503); expect(m.guard).not.toHaveBeenCalled()
  })
})
