import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.fn()
const createUser = vi.fn()
const deleteUser = vi.fn()

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({ rpc, auth: { admin: { createUser, deleteUser } } })),
}))

type RpcHandlers = Record<string, (args: any) => { data?: any; error?: any }>
function routeRpc(handlers: RpcHandlers) {
  rpc.mockImplementation(async (name: string, args: any) => {
    const handler = handlers[name]
    if (!handler) throw new Error(`unexpected rpc ${name}`)
    return { data: null, error: null, ...handler(args) }
  })
}

const base = {
  actorId: 'admin-1',
  email: ' New.Hire@Example.com ',
  phone: '012-345 6789',
  fullName: 'New Hire',
  organizationId: 'org-hq',
  source: 'user_management' as const,
}

describe('provisionIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createUser.mockResolvedValue({ data: { user: { id: 'new-user' } }, error: null })
    deleteUser.mockResolvedValue({ error: null })
  })

  it('creates exactly one identity when nothing matches, with normalized identifiers', async () => {
    routeRpc({
      identity_resolve: () => ({ data: { outcome: 'NO_MATCH' } }),
      identity_provision: () => ({ data: { status: 'ok', outcome: 'CREATED', user_id: 'new-user', principal_type: 'INTERNAL_EMPLOYEE', membership_id: 'm-1', legacy_role_code: 'USER' } }),
    })
    const { provisionIdentity } = await import('./provisioning')
    const result = await provisionIdentity(base)

    expect(result).toMatchObject({ ok: true, userId: 'new-user', outcome: 'CREATED', principalType: 'INTERNAL_EMPLOYEE', membershipId: 'm-1' })
    expect(rpc).toHaveBeenCalledWith('identity_resolve', { p_email: 'new.hire@example.com', p_phone: '+60123456789' })
    expect(createUser).toHaveBeenCalledTimes(1)
    expect(createUser.mock.calls[0][0]).toMatchObject({ email: 'new.hire@example.com', phone: '+60123456789' })
    const provisionCall = rpc.mock.calls.find(c => c[0] === 'identity_provision')!
    expect(provisionCall[1]).toMatchObject({ p_actor: 'admin-1', p_user: 'new-user' })
    expect(provisionCall[1].p_payload).toMatchObject({ created_identity: true, email: 'new.hire@example.com', account_scope: 'portal', authorizing_permission: 'platform.user.manage' })
    // A generated temporary password is returned only because this request created the login.
    expect(result.ok && result.tempPassword).toMatch(/^.{14}$/)
    expect(deleteUser).not.toHaveBeenCalled()
  })

  it('without legacy access: checks the database support first, then sends no legacy role', async () => {
    routeRpc({
      identity_provision_capabilities: () => ({ data: { no_legacy_access: true } }),
      identity_resolve: () => ({ data: { outcome: 'NO_MATCH' } }),
      identity_provision: () => ({ data: { status: 'ok', outcome: 'CREATED', user_id: 'new-user', principal_type: 'MANUFACTURER_USER', legacy_role_code: 'GUEST' } }),
    })
    const { provisionIdentity } = await import('./provisioning')
    const result = await provisionIdentity({ ...base, noLegacyAccess: true })
    expect(result).toMatchObject({ ok: true, legacyRoleCode: 'GUEST' })
    const payload = rpc.mock.calls.find(c => c[0] === 'identity_provision')![1].p_payload
    expect(payload).toMatchObject({ no_legacy_access: true, legacy_role_code: null })
  })

  it('fails closed before creating any login when the database support is missing (never a silent USER default)', async () => {
    routeRpc({ identity_provision_capabilities: () => ({ error: { code: 'PGRST202', message: 'function not found' } }) })
    const { provisionIdentity } = await import('./provisioning')
    const result = await provisionIdentity({ ...base, noLegacyAccess: true })
    expect(result).toMatchObject({ ok: false, code: 'PROVISIONING_FAILED', status: 503 })
    expect(createUser).not.toHaveBeenCalled()
    expect(rpc.mock.calls.some(c => c[0] === 'identity_provision')).toBe(false)
  })

  it('refuses to combine "no legacy access" with an explicit legacy role', async () => {
    routeRpc({})
    const { provisionIdentity } = await import('./provisioning')
    expect(await provisionIdentity({ ...base, noLegacyAccess: true, legacyRoleCode: 'SA' })).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(createUser).not.toHaveBeenCalled()
  })

  it('reuses an existing identity: no second login, no password returned', async () => {
    routeRpc({
      identity_resolve: () => ({ data: { outcome: 'MATCH', user_id: 'existing', matched_by: 'email', has_profile: true } }),
      identity_provision: (args) => ({ data: { status: 'ok', outcome: 'REUSED', user_id: args.p_user, principal_type: 'INTERNAL_EMPLOYEE' } }),
    })
    const { provisionIdentity } = await import('./provisioning')
    const result = await provisionIdentity({ ...base, password: 'Chosen-Password-1' })

    expect(result).toMatchObject({ ok: true, userId: 'existing', outcome: 'REUSED' })
    expect(createUser).not.toHaveBeenCalled()
    expect((result as any).tempPassword).toBeUndefined()
    expect(rpc.mock.calls.find(c => c[0] === 'identity_provision')![1].p_payload.created_identity).toBe(false)
  })

  describe('Add User guards (requireNewIdentity / linkUserId)', () => {
    const match = { data: { outcome: 'MATCH', user_id: 'existing', matched_by: 'email', has_profile: true } }
    const noRpcWrites = () => {
      expect(createUser).not.toHaveBeenCalled()
      expect(rpc.mock.calls.some(c => c[0] === 'identity_provision')).toBe(false)
    }

    it('stops instead of silently reusing an existing account when no link was chosen', async () => {
      routeRpc({ identity_resolve: () => match })
      const { provisionIdentity } = await import('./provisioning')
      const result = await provisionIdentity({ ...base, requireNewIdentity: true })
      expect(result).toMatchObject({ ok: false, code: 'IDENTITY_ALREADY_EXISTS', status: 409 })
      noRpcWrites()
    })

    it('still completes a login that has no profile yet (a retry never creates a second account)', async () => {
      routeRpc({
        identity_resolve: () => ({ data: { outcome: 'MATCH', user_id: 'orphan', has_profile: false } }),
        identity_provision: (args) => ({ data: { status: 'ok', outcome: 'CREATED', user_id: args.p_user, principal_type: 'INTERNAL_EMPLOYEE' } }),
      })
      const { provisionIdentity } = await import('./provisioning')
      const result = await provisionIdentity({ ...base, requireNewIdentity: true })
      expect(result).toMatchObject({ ok: true, userId: 'orphan' })
      expect(createUser).not.toHaveBeenCalled()
    })

    it('links exactly the chosen identity: the same id proceeds without creating a login', async () => {
      routeRpc({ identity_resolve: () => match, identity_provision: (args) => ({ data: { status: 'ok', outcome: 'REUSED', user_id: args.p_user, principal_type: 'INTERNAL_EMPLOYEE' } }) })
      const { provisionIdentity } = await import('./provisioning')
      const result = await provisionIdentity({ ...base, requireNewIdentity: true, linkUserId: 'existing' })
      expect(result).toMatchObject({ ok: true, outcome: 'REUSED', userId: 'existing' })
      expect(createUser).not.toHaveBeenCalled()
    })

    it.each([
      ['another person', { data: { outcome: 'MATCH', user_id: 'someone-else', has_profile: true } }],
      ['nobody any more', { data: { outcome: 'NO_MATCH' } }],
    ])('rejects a link when the email/phone now resolve to %s', async (_label, resolved) => {
      routeRpc({ identity_resolve: () => resolved })
      const { provisionIdentity } = await import('./provisioning')
      const result = await provisionIdentity({ ...base, requireNewIdentity: true, linkUserId: 'existing' })
      expect(result).toMatchObject({ ok: false, code: 'IDENTITY_LINK_MISMATCH', status: 409 })
      noRpcWrites()
    })
  })

  it('blocks an email/phone conflict before creating anything and records it', async () => {
    routeRpc({
      identity_resolve: () => ({ data: { outcome: 'IDENTITY_CONFLICT', email_user_id: 'a', phone_user_id: 'b', matched_user_ids: ['a', 'b'] } }),
      identity_record_conflict: () => ({ data: 'conflict-1' }),
    })
    const { provisionIdentity } = await import('./provisioning')
    const result = await provisionIdentity(base)

    expect(result).toMatchObject({ ok: false, code: 'IDENTITY_CONFLICT', status: 409, matchedUserIds: ['a', 'b'] })
    expect(createUser).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith('identity_record_conflict', expect.objectContaining({ p_code: 'IDENTITY_CONFLICT', p_source: 'user_management', p_actor: 'admin-1' }))
    expect(rpc.mock.calls.some(c => c[0] === 'identity_provision')).toBe(false)
  })

  it.each(['IDENTITY_VERIFICATION_REQUIRED', 'IDENTITY_AMBIGUOUS_PHONE', 'IDENTITY_ARCHIVED'])('never creates a duplicate on %s', async (outcome) => {
    routeRpc({ identity_resolve: () => ({ data: { outcome } }), identity_record_conflict: () => ({ data: 'c' }) })
    const { provisionIdentity } = await import('./provisioning')
    const result = await provisionIdentity(base)
    expect(result).toMatchObject({ ok: false, code: outcome })
    expect(createUser).not.toHaveBeenCalled()
  })

  it('leaves no orphan login when the database transaction fails', async () => {
    routeRpc({
      identity_resolve: () => ({ data: { outcome: 'NO_MATCH' } }),
      identity_provision: () => ({ error: { code: '42501', message: 'identity_role_grant_not_allowed' } }),
    })
    const { provisionIdentity } = await import('./provisioning')
    const result = await provisionIdentity({ ...base, legacyRoleCode: 'SA' })

    expect(result).toMatchObject({ ok: false, code: 'ROLE_GRANT_NOT_ALLOWED', status: 403 })
    expect(deleteUser).toHaveBeenCalledWith('new-user')
  })

  it('leaves no orphan login when the transaction reports a race conflict', async () => {
    routeRpc({
      identity_resolve: () => ({ data: { outcome: 'NO_MATCH' } }),
      identity_provision: () => ({ data: { status: 'blocked', code: 'IDENTITY_CONFLICT', matched_user_ids: ['new-user', 'other'] } }),
    })
    const { provisionIdentity } = await import('./provisioning')
    const result = await provisionIdentity(base)
    expect(result).toMatchObject({ ok: false, code: 'IDENTITY_CONFLICT' })
    expect(deleteUser).toHaveBeenCalledWith('new-user')
  })

  it('never deletes an identity it did not create', async () => {
    routeRpc({
      identity_resolve: () => ({ data: { outcome: 'MATCH', user_id: 'existing' } }),
      identity_provision: () => ({ data: { status: 'blocked', code: 'IDENTITY_ORG_MOVE_REQUIRED' } }),
    })
    const { provisionIdentity } = await import('./provisioning')
    const result = await provisionIdentity(base)
    expect(result).toMatchObject({ ok: false, code: 'IDENTITY_ORG_MOVE_REQUIRED' })
    expect(deleteUser).not.toHaveBeenCalled()
  })

  it('rejects an invalid phone before any lookup (no guessing)', async () => {
    routeRpc({})
    const { provisionIdentity } = await import('./provisioning')
    const result = await provisionIdentity({ ...base, phone: '123456789' })
    expect(result).toMatchObject({ ok: false, code: 'INVALID_INPUT', status: 400 })
    expect(rpc).not.toHaveBeenCalled()
    expect(createUser).not.toHaveBeenCalled()
  })

  it('passes the HR authorizing permission and employment facts, never the role unless requested', async () => {
    routeRpc({
      identity_resolve: () => ({ data: { outcome: 'NO_MATCH' } }),
      identity_provision: () => ({ data: { status: 'ok', outcome: 'CREATED', user_id: 'new-user', principal_type: 'INTERNAL_EMPLOYEE' } }),
    })
    const { provisionIdentity } = await import('./provisioning')
    await provisionIdentity({ ...base, source: 'hr', authorizingPermission: 'hr.employee.manage', hr: { departmentId: 'd-1', joinDate: '2026-10-01' } })
    const payload = rpc.mock.calls.find(c => c[0] === 'identity_provision')![1].p_payload
    expect(payload).toMatchObject({ authorizing_permission: 'hr.employee.manage', department_id: 'd-1', join_date: '2026-10-01', legacy_role_code: null, source: 'hr' })
  })
})

describe('provisionIdentity — initial Group Policy audit context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createUser.mockResolvedValue({ data: { user: { id: 'new-user' } }, error: null })
    routeRpc({
      identity_resolve: () => ({ data: { outcome: 'NO_MATCH' } }),
      identity_provision: () => ({ data: { status: 'ok', outcome: 'CREATED', user_id: 'new-user', principal_type: 'INTERNAL_EMPLOYEE' } }),
    })
  })
  const payload = () => rpc.mock.calls.find(c => c[0] === 'identity_provision')![1].p_payload

  it('stamps every selected policy with the server-generated reason, ignoring any client-supplied one', async () => {
    const { provisionIdentity, INITIAL_POLICY_AUDIT_REASON } = await import('./provisioning')
    await provisionIdentity({ ...base, initialProfiles: [
      { roleId: 'r1', scopeIds: ['s1'], reason: 'typed by client' } as any, { roleId: 'r2', scopeIds: ['s2'] },
    ] })
    expect(INITIAL_POLICY_AUDIT_REASON).toBe('Group Policy assigned during user creation.')
    expect(payload().initial_access).toEqual([
      { role_id: 'r1', scope_ids: ['s1'], reason: INITIAL_POLICY_AUDIT_REASON },
      { role_id: 'r2', scope_ids: ['s2'], reason: INITIAL_POLICY_AUDIT_REASON },
    ])
  })

  it('sends no policy-assignment context at all when no Group Policy is chosen', async () => {
    const { provisionIdentity } = await import('./provisioning')
    await provisionIdentity({ ...base })
    expect(payload().initial_access).toEqual([])
    expect(payload().initial_reason).toBeNull()
    expect(payload().initial_role_id).toBeNull()
  })
})

describe('mapIdentityDbError', () => {
  it('maps database refusals to caller-safe errors', async () => {
    const { mapIdentityDbError } = await import('./provisioning')
    expect(mapIdentityDbError({ message: 'sa_authorization_required' })).toMatchObject({ code: 'FORBIDDEN', status: 403 })
    expect(mapIdentityDbError({ message: 'identity_role_grant_not_allowed' })).toMatchObject({ code: 'ROLE_GRANT_NOT_ALLOWED', status: 403 })
    expect(mapIdentityDbError({ message: 'identity_principal_type_mismatch' })).toMatchObject({ code: 'INVALID_ORGANIZATION', status: 400 })
    expect(mapIdentityDbError({ message: 'something unexpected' })).toMatchObject({ code: 'PROVISIONING_FAILED', status: 500 })
  })
})

describe('generateTemporaryPassword', () => {
  it('uses a cryptographic source and the unambiguous alphabet', async () => {
    const { generateTemporaryPassword } = await import('./provisioning')
    const values = new Set(Array.from({ length: 50 }, () => generateTemporaryPassword()))
    expect(values.size).toBe(50)
    for (const v of values) expect(v).toMatch(/^[A-HJ-NP-Za-km-z2-9@#$%]{14}$/)
  })
})
