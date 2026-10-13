import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * System Logs must never change a business outcome: with the diagnostic store broken (throwing client, missing
 * function), the reset route answers exactly as before and its audit_logs outcome is still written.
 */
const mocks = vi.hoisted(() => ({
  updateUserById: vi.fn(),
  auditInsert: vi.fn(),
  rpc: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'admin-1', email: 'admin@example.com' } }, error: null }) } }),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    auth: { admin: { updateUserById: mocks.updateUserById } },
    rpc: mocks.rpc,
    from: (table: string) => {
      if (table === 'audit_logs') return { insert: mocks.auditInsert }
      let id = ''
      const query: any = {
        select: () => query,
        eq: (_c: string, v: string) => { id = v; return query },
        single: async () => ({ data: id === 'admin-1' ? { id: 'admin-1', email: 'admin@example.com', roles: { role_level: 10 } } : { id: 'target-1', full_name: 'Target', roles: { role_level: 40 } }, error: null }),
        maybeSingle: async () => { throw new Error('users lookup exploded') },
      }
      return query
    },
  }),
}))
vi.mock('@/lib/security-access/operation', async () => (await import('@/test-support/sa-legacy-mode')).operationModule)
vi.mock('@/lib/security-access/resource-context', async () => (await import('@/test-support/sa-legacy-mode')).resourceContextModule)
vi.mock('@/lib/security-access/scope', async () => (await import('@/test-support/sa-legacy-mode')).scopeModule)

import { POST } from './route'
import { __resetReporterForTests } from '@/lib/system-logs/server'

const request = () => new NextRequest('http://localhost/api/users/reset-password', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': 'REQ-FORGEDFORGED' },
  body: JSON.stringify({ user_id: 'target-1', new_password: 'new-password' }),
})

describe('reset-password with a broken diagnostic store', () => {
  beforeEach(() => {
    __resetReporterForTests()
    vi.clearAllMocks()
    mocks.auditInsert.mockResolvedValue({ error: null })
    mocks.rpc.mockImplementation(() => { throw new Error('diagnostic store down') })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('a failed reset still answers 500 with the same error, audits the failure, and carries a reference', async () => {
    mocks.updateUserById.mockResolvedValue({ error: { message: 'Auth service unavailable', status: 503, code: 'unexpected_failure' } })
    const res = await POST(request())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toMatchObject({ success: false, error: 'Failed to reset password: Auth service unavailable' })
    // A server-generated reference (a client-supplied X-Request-ID is never adopted), also returned as a header.
    expect(body.referenceId).toMatch(/^REQ-[0-9A-Z]{12}$/)
    expect(body.referenceId).not.toBe('REQ-FORGEDFORGED')
    expect(res.headers.get('x-request-id')).toBe(body.referenceId)
    expect(mocks.auditInsert).toHaveBeenCalledWith(expect.objectContaining({ action: 'PASSWORD_RESET_FAILED' }))
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain('new-password')
  })

  it('a successful reset is unaffected', async () => {
    mocks.updateUserById.mockResolvedValue({ error: null })
    const res = await POST(request())
    expect(res.status).toBe(200)
    expect(mocks.auditInsert).toHaveBeenCalledWith(expect.objectContaining({ action: 'PASSWORD_RESET' }))
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
})
