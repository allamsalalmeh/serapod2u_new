import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

/** Archive Identities on the OTP request step, against isolated in-memory rows (never Supabase). */
type Row = Record<string, any>
const mocks = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  authorize: vi.fn(),
  protect: vi.fn(),
  send: vi.fn(),
}))

function table(name: string) {
  const filters: Array<(r: Row) => boolean> = []
  let op: { kind: string; values?: any } = { kind: 'select' }
  const rows = () => (mocks.db[name] ||= [])
  const run = () => {
    const hit = rows().filter(r => filters.every(f => f(r)))
    if (op.kind === 'update') hit.forEach(r => Object.assign(r, op.values))
    if (op.kind === 'insert') { const v = { id: `${name}-${rows().length + 1}`, ...op.values }; rows().push(v); return [v] }
    return hit
  }
  const q: any = {
    select: () => q, or: () => q, gte: () => q,
    eq: (c: string, v: any) => { filters.push(r => r[c] === v); return q },
    is: (c: string, v: any) => { filters.push(r => (r[c] ?? null) === v); return q },
    update: (values: any) => { op = { kind: 'update', values }; return q },
    insert: (values: any) => { op = { kind: 'insert', values }; return q },
    single: async () => { const r = run(); return r.length === 1 ? { data: r[0], error: null } : { data: null, error: { message: 'no rows' } } },
    maybeSingle: async () => { const r = run(); return { data: r[0] ?? null, error: null } },
    then: (resolve: any, reject: any) => Promise.resolve().then(() => ({ data: run(), error: null, count: 0 })).then(resolve, reject),
  }
  return q
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'admin-1', email: 'admin@example.com' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: table }) }))
vi.mock('@/lib/security-access/operation', () => ({
  guardUserOperation: async () => null,
  authorizeOperation: (req: any) => mocks.authorize(req),
  organizationResource: (type: string, organizationId: string | null | undefined, extra = {}) => ({ type, organizationId: organizationId ?? null, ...extra }),
}))
vi.mock('@/lib/security-access/scope', () => ({ targetProtectionAllows: (...args: any[]) => mocks.protect(...args) }))
vi.mock('@/lib/security-access/authorization', () => ({ currentMigrationMode: async () => 'SHADOW' }))
vi.mock('@/lib/identity/provisioning', () => ({ identityHistoryReferences: async () => ['orders.created_by'], setIdentityAccountStatus: vi.fn() }))
vi.mock('@/server/auth/passwordResetService', () => ({ generateOtp: () => '1234', hashOtp: (c: string) => `h:${c}` }))
vi.mock('@/lib/notifications/transactional-otp-router', () => ({
  OTP_EXPIRY_MINUTES: 10,
  describeOtpSendFailure: () => 'failed',
  sendTransactionalOtp: (...args: any[]) => mocks.send(...args),
}))

import { POST } from './route'

const allow = { decision: 'ALLOW', decisionId: 'd1', reasonCode: 'ALLOWED_BY_ASSIGNMENT' }
const deny = { decision: 'DENY', decisionId: 'd2', reasonCode: 'SCOPE_MISMATCH' }
const request = (targetUserId: string) => new NextRequest('http://localhost/api/admin/delete-user-otp/request', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetUserId }),
})

describe('POST /api/admin/delete-user-otp/request — Archive Identities authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.db = {
      users: [
        { id: 'admin-1', email: 'admin@example.com', organization_id: 'org-hq', roles: { role_level: 10 } },
        { id: 'target-1', email: 't@example.com', full_name: 'Shop Target', organization_id: 'org-shop', account_status: 'ACTIVE', roles: { role_level: 40 } },
      ],
      organizations: [{ id: 'org-hq', contact_phone: '+60123456789', contact_email: 'ops@example.com', org_name: 'HQ' }],
      notification_settings: [{ org_id: 'org-hq', event_code: 'delete_user_otp', enabled: true, channels_enabled: ['email'], templates: {}, recipient_config: { preset: 'email_only' } }],
      auth_verification_codes: [], notification_events: [], destructive_ops_audit_log: [],
    }
    mocks.authorize.mockResolvedValue(allow)
    mocks.protect.mockResolvedValue(true)
    mocks.send.mockResolvedValue({ success: true, channel: 'email', preset: 'email_only', fallbackUsed: false, errors: {} })
  })

  it('asks for platform.identity.delete in the TARGET organization before any code is created', async () => {
    mocks.authorize.mockImplementation(async (req: any) => (req.resource.organizationId === 'org-hq' ? allow : deny))
    const res = await POST(request('target-1'))
    expect(res.status).toBe(403)
    expect(mocks.authorize.mock.calls[0][0]).toMatchObject({ permission: 'platform.identity.delete', resource: { organizationId: 'org-shop' } })
    expect(mocks.db.auth_verification_codes).toHaveLength(0)
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.db.destructive_ops_audit_log.at(-1)).toMatchObject({ operation: 'delete_user_otp_request', allowed: false })
  })

  it('protected targets and self are refused before any code is created', async () => {
    mocks.protect.mockResolvedValue(false)
    expect((await POST(request('target-1'))).status).toBe(403)
    expect((await POST(request('admin-1'))).status).toBe(400)
    expect(mocks.db.auth_verification_codes).toHaveLength(0)
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('an authorized request binds the code to the target and requester', async () => {
    const res = await POST(request('target-1'))
    expect(res.status).toBe(200)
    expect((await res.json()).removalMode).toBe('archive')
    expect(mocks.db.auth_verification_codes[0]).toMatchObject({ user_id: 'admin-1', meta: { target_user_id: 'target-1' } })
  })
})
