import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const PASSWORD = 'Sup3r-secret-pw!'

const mocks = vi.hoisted(() => ({
  authGetUser: vi.fn(),
  updateUserById: vi.fn(),
  auditInsert: vi.fn(),
  authorize: vi.fn(),
  protect: vi.fn(),
  currentProfile: { id: 'admin-1', email: 'admin@example.com', organization_id: 'org-hq', roles: { role_level: 20 } } as any,
  targetProfile: { id: 'target-1', email: 'target@example.com', full_name: 'Target User', role_code: 'USER', organization_id: 'org-shop', roles: { role_level: 40 } } as any,
  targetMissing: false,
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mocks.authGetUser } }) }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    auth: { admin: { updateUserById: mocks.updateUserById } },
    from: (table: string) => {
      if (table === 'audit_logs') return { insert: mocks.auditInsert }
      if (table === 'users') {
        let id = ''
        const query: any = {
          select: () => query,
          eq: (_c: string, value: string) => { id = value; return query },
          single: async () => id === 'admin-1'
            ? { data: mocks.currentProfile, error: null }
            : mocks.targetMissing ? { data: null, error: { message: 'not found' } } : { data: mocks.targetProfile, error: null },
        }
        return query
      }
      throw new Error(`Unexpected table ${table}`)
    },
  }),
}))
vi.mock('@/lib/security-access/operation', () => ({
  authorizeOperation: (req: any) => mocks.authorize(req),
  organizationResource: (type: string, organizationId: string | null | undefined, extra = {}) => ({ type, organizationId: organizationId ?? null, ...extra }),
}))
vi.mock('@/lib/security-access/scope', () => ({ targetProtectionAllows: (...args: any[]) => mocks.protect(...args) }))

import { POST } from './route'

const request = (userId = 'target-1') => new NextRequest('http://localhost/api/users/reset-password', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'user-agent': 'vitest' },
  body: JSON.stringify({ user_id: userId, new_password: PASSWORD }),
})

const allow = { decision: 'ALLOW', decisionId: 'd1', reasonCode: 'ALLOWED_BY_ASSIGNMENT' }
const deny = { decision: 'DENY', decisionId: 'd2', reasonCode: 'SCOPE_MISMATCH' }

describe('POST /api/users/reset-password — Security & Access authority', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.targetMissing = false
    mocks.authGetUser.mockResolvedValue({ data: { user: { id: 'admin-1', email: 'admin@example.com' } }, error: null })
    mocks.currentProfile = { id: 'admin-1', email: 'admin@example.com', organization_id: 'org-hq', roles: { role_level: 20 } }
    mocks.updateUserById.mockResolvedValue({ error: null })
    mocks.auditInsert.mockResolvedValue({ error: null })
    mocks.authorize.mockResolvedValue(allow)
    mocks.protect.mockResolvedValue(true)
  })

  it('asks for the dedicated reset permission in the TARGET organization, not platform.user.manage', async () => {
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(mocks.authorize).toHaveBeenCalledTimes(1)
    const asked = mocks.authorize.mock.calls[0][0]
    expect(asked.permission).toBe('platform.user.password_reset')
    expect(asked.resource.organizationId).toBe('org-shop')
    expect(asked.actorId).toBe('admin-1')
  })

  it('keeps the historical rule as the legacy evaluator: exactly role level 10', async () => {
    mocks.authorize.mockImplementation(async (req: any) => ({ ...(await req.legacy() ? allow : deny) }))
    for (const [level, expected] of [[10, 200], [1, 403], [20, 403], [30, 403]] as const) {
      mocks.currentProfile = { ...mocks.currentProfile, roles: { role_level: level } }
      mocks.updateUserById.mockClear()
      expect((await POST(request())).status, `level ${level}`).toBe(expected)
      expect(mocks.updateUserById).toHaveBeenCalledTimes(expected === 200 ? 1 : 0)
    }
  })

  it('refuses a profile editor who holds no reset authority, and a cross-organization reset', async () => {
    mocks.authorize.mockResolvedValue(deny)
    const response = await POST(request())
    expect(response.status).toBe(403)
    expect(mocks.updateUserById).not.toHaveBeenCalled()
    const body = await response.json()
    expect(body.permission).toBe('platform.user.password_reset')
    expect(JSON.stringify(mocks.auditInsert.mock.calls)).not.toContain(PASSWORD)
  })

  it('rejects at submission when authority was revoked after the button was shown', async () => {
    expect((await POST(request())).status).toBe(200)
    mocks.authorize.mockResolvedValue(deny)
    mocks.updateUserById.mockClear()
    expect((await POST(request())).status).toBe(403)
    expect(mocks.updateUserById).not.toHaveBeenCalled()
  })

  it('does not reveal whether a missing target exists to someone without authority', async () => {
    mocks.targetMissing = true
    mocks.authorize.mockResolvedValue(deny)
    expect((await POST(request('ghost'))).status).toBe(403)
    mocks.authorize.mockResolvedValue(allow)
    expect((await POST(request('ghost'))).status).toBe(404)
    // The missing target is judged in the administrator's own organization.
    expect(mocks.authorize.mock.calls[0][0].resource.organizationId).toBe('org-hq')
  })

  it('keeps the privileged-account restriction', async () => {
    mocks.protect.mockResolvedValue(false)
    const response = await POST(request())
    expect(response.status).toBe(403)
    expect(mocks.protect).toHaveBeenCalledWith('admin-1', 'target-1', 'platform.identity_access.manage', expect.any(Function))
    expect(mocks.updateUserById).not.toHaveBeenCalled()
    expect(mocks.auditInsert.mock.calls[0][0]).toMatchObject({ action: 'PASSWORD_RESET_FAILED', new_values: { reason: 'target_protected' } })
  })

  it('fails closed (503) when the authorization service is unavailable', async () => {
    mocks.authorize.mockRejectedValue(new Error('down'))
    expect((await POST(request())).status).toBe(503)
    expect(mocks.updateUserById).not.toHaveBeenCalled()
  })

  it('never puts the password in the audit row, the response or the logs — on success or failure', async () => {
    const spies = [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {})]
    const ok = await POST(request())
    expect(mocks.auditInsert.mock.calls[0][0]).toMatchObject({ action: 'PASSWORD_RESET', entity_id: 'target-1', changed_fields: ['password'] })
    mocks.updateUserById.mockResolvedValue({ error: { message: 'Auth unavailable', status: 500, code: 'unexpected_failure' } })
    const failed = await POST(request())
    expect(failed.status).toBe(500)
    expect(mocks.auditInsert.mock.calls[1][0]).toMatchObject({ action: 'PASSWORD_RESET_FAILED', new_values: { reset_by_admin: true, reason: 'auth_update_failed' } })
    const everything = JSON.stringify([mocks.auditInsert.mock.calls, await ok.clone().text(), await failed.clone().text(), ...spies.map(s => s.mock.calls)])
    expect(everything).not.toContain(PASSWORD)
    spies.forEach(s => s.mockRestore())
  })

  it('validates the password only after authorization', async () => {
    mocks.authorize.mockResolvedValue(deny)
    const short = new NextRequest('http://localhost/api/users/reset-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 'target-1', new_password: 'short' }) })
    expect((await POST(short)).status).toBe(403)
    mocks.authorize.mockResolvedValue(allow)
    const again = new NextRequest('http://localhost/api/users/reset-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: 'target-1', new_password: 'short' }) })
    expect((await POST(again)).status).toBe(400)
  })
})
