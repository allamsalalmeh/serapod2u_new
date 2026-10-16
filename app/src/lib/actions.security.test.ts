import { beforeEach, describe, expect, it, vi } from 'vitest'

// S&A in legacy mode: this suite tests the Phase 0A rules themselves.
vi.mock('@/lib/security-access/operation', async () => (await import('@/test-support/sa-legacy-mode')).operationModule)
vi.mock('@/lib/security-access/scope', async () => (await import('@/test-support/sa-legacy-mode')).scopeModule)

const authGetUser = vi.fn()
const checkPermissionForUser = vi.fn()
const usersUpdateEq = vi.fn()
const usersUpdate = vi.fn(() => ({ eq: usersUpdateEq }))
const usersSelectRow = vi.fn()
const updateUserById = vi.fn()
const createAuthUser = vi.fn()
const deleteAuthUser = vi.fn()
const adminRpc = vi.fn()
const adminFromTables: string[] = []
// Active Root Access rows of the edited person (sa_root_access_grants); a read error when set.
let rootGrantRows: any[] = []
let rootGrantError: any = null

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: authGetUser } })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    auth: { admin: { updateUserById, createUser: createAuthUser, deleteUser: deleteAuthUser } },
    rpc: adminRpc,
    from: (table: string) => {
      adminFromTables.push(table)
      if (table === 'sa_root_access_grants') {
        return { select: () => ({ eq: () => ({ eq: async () => ({ data: rootGrantError ? null : rootGrantRows, error: rootGrantError }) }) }) }
      }
      if (table === 'organizations') {
        // Add User reads the organization's STORED type (ESS intent, HQ-only employment/reference fields).
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { org_type_code: 'HQ' }, error: null }) }) }) }
      }
      if (table !== 'users') throw new Error(`Unexpected table: ${table}`)
      return {
        update: usersUpdate,
        select: () => ({ eq: () => ({ maybeSingle: usersSelectRow, single: usersSelectRow }) }),
      }
    },
  })),
}))
vi.mock('@/lib/server/permissions', () => ({ checkPermissionForUser }))

function rpcRoutes(handlers: Record<string, (args: any) => any>) {
  adminRpc.mockImplementation(async (name: string, args: any) => {
    // The database support for creating accounts without a legacy level (installed by the pending migration) is present unless a test says otherwise.
    const h = handlers[name] ?? (name === 'identity_provision_capabilities' ? () => ({ data: { no_legacy_access: true } }) : undefined)
    return h ? { data: null, error: null, ...h(args) } : { data: null, error: null }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  adminFromTables.length = 0
  rootGrantRows = []
  rootGrantError = null
  usersUpdateEq.mockResolvedValue({ error: null })
  usersSelectRow.mockResolvedValue({ data: { role_code: 'USER', organization_id: 'org-a', is_active: true }, error: null })
  updateUserById.mockResolvedValue({ data: { user: {} }, error: null })
  createAuthUser.mockResolvedValue({ data: { user: { id: 'new-user' } }, error: null })
  deleteAuthUser.mockResolvedValue({ error: null })
  rpcRoutes({})
})

describe('updateUserWithAuth Root Access target protection', () => {
  const asAdmin = () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'admin' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 1 } })
  }

  it('a non-root administrator (even level 1) cannot change a Root Administrator\'s login phone, status or profile', async () => {
    asAdmin()
    rootGrantRows = [{ effective_until: null }]
    rpcRoutes({ sa_actor_is_root: () => ({ data: false }) })
    const { updateUserWithAuth } = await import('./actions')
    for (const change of [{ phone: '+60123456789' }, { is_active: false }, { full_name: 'Renamed' }, { role_code: 'USER' }]) {
      const result = await updateUserWithAuth('root-target', change as any)
      expect(result).toEqual({ success: false, error: 'This account holds Root Access. Only another Root Administrator can change it.' })
    }
    expect(updateUserById).not.toHaveBeenCalled()
    expect(usersUpdate).not.toHaveBeenCalled()
    expect(adminRpc).not.toHaveBeenCalledWith('identity_set_account_status', expect.anything())
  })

  it('another Root Administrator may change it; an expired Root Access no longer protects the account', async () => {
    asAdmin()
    rootGrantRows = [{ effective_until: null }]
    rpcRoutes({ sa_actor_is_root: () => ({ data: true }) })
    const { updateUserWithAuth } = await import('./actions')
    expect(await updateUserWithAuth('root-target', { full_name: 'Ok' })).toEqual({ success: true })
    rootGrantRows = [{ effective_until: '2000-01-01T00:00:00Z' }]
    rpcRoutes({ sa_actor_is_root: () => ({ data: false }) })
    expect(await updateUserWithAuth('former-root', { full_name: 'Ok' })).toEqual({ success: true })
  })

  it('fails closed when Root Access status cannot be read (but not when the feature is not installed)', async () => {
    asAdmin()
    rootGrantError = { code: '57014', message: 'timeout' }
    const { updateUserWithAuth } = await import('./actions')
    expect((await updateUserWithAuth('target', { full_name: 'Ok' })).success).toBe(false)
    expect(usersUpdate).not.toHaveBeenCalled()
    rootGrantError = { code: 'PGRST205', message: 'relation not found' }
    expect(await updateUserWithAuth('target', { full_name: 'Ok' })).toEqual({ success: true })
  })
})

describe('updateUserWithAuth Phase 0A authorization', () => {
  it('allows a legitimate self-service personal profile change', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'self' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: false, context: { role_level: 50 } })
    const { updateUserWithAuth } = await import('./actions')

    const result = await updateUserWithAuth('self', { full_name: 'Liza', address: 'KL' })

    expect(result).toEqual({ success: true })
    expect(usersUpdate).toHaveBeenCalledWith(expect.objectContaining({ full_name: 'Liza', address: 'KL' }))
  })

  it.each(['role_code', 'organization_id', 'is_active', 'department_id', 'employment_status'])(
    'denies a self-service %s change',
    async (field) => {
      authGetUser.mockResolvedValue({ data: { user: { id: 'self' } }, error: null })
      checkPermissionForUser.mockResolvedValue({ allowed: false, context: { role_level: 50 } })
      const { updateUserWithAuth } = await import('./actions')

      const result = await updateUserWithAuth('self', { [field]: 'attacker-value' } as any)

      expect(result.success).toBe(false)
      expect(result.error).toContain(field)
      expect(usersUpdate).not.toHaveBeenCalled()
    },
  )

  it('routes an authorized role change through the identity access function (never a direct write)', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'admin' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 10 } })
    rpcRoutes({ identity_admin_update_access: () => ({ data: { role_code: 'MANAGER', organization_id: 'org-a', account_scope: 'portal' } }) })
    const { updateUserWithAuth } = await import('./actions')

    const result = await updateUserWithAuth('target', { role_code: 'MANAGER' })

    expect(result).toEqual({ success: true })
    expect(adminRpc).toHaveBeenCalledWith('identity_admin_update_access', expect.objectContaining({
      p_actor: 'admin', p_user: 'target', p_role_code: 'MANAGER', p_change_org: false,
    }))
    expect(usersUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ role_code: expect.anything() }))
  })

  it('employee management (level 20/30) does not imply changing roles or organizations', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'manager' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 30 } })
    const { updateUserWithAuth } = await import('./actions')

    const result = await updateUserWithAuth('target', { role_code: 'SA', full_name: 'X' })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/access-administration/)
    expect(adminRpc).not.toHaveBeenCalledWith('identity_admin_update_access', expect.anything())
    expect(usersUpdate).not.toHaveBeenCalled()
  })

  it('surfaces the database refusal of an escalation', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'admin' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 10 } })
    rpcRoutes({ identity_admin_update_access: () => ({ error: { code: '42501', message: 'identity_role_grant_not_allowed' } }) })
    const { updateUserWithAuth } = await import('./actions')

    const result = await updateUserWithAuth('target', { role_code: 'SA' })

    expect(result.success).toBe(false)
    expect(usersUpdate).not.toHaveBeenCalled()
  })

  it('does not call the access function when role and organization are unchanged', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'manager' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 30 } })
    const { updateUserWithAuth } = await import('./actions')

    const result = await updateUserWithAuth('target', { role_code: 'USER', organization_id: 'org-a', is_active: true, full_name: 'Same Access' })

    expect(result).toEqual({ success: true })
    expect(adminRpc).not.toHaveBeenCalled()
    expect(usersUpdate).toHaveBeenCalledWith({ full_name: 'Same Access' })
  })

  it('applies an account status change through the lifecycle function', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'admin' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 10 } })
    rpcRoutes({ identity_set_account_status: () => ({ data: 'DISABLED' }) })
    const { updateUserWithAuth } = await import('./actions')

    const result = await updateUserWithAuth('target', { is_active: false })

    expect(result).toEqual({ success: true })
    expect(adminRpc).toHaveBeenCalledWith('identity_set_account_status', expect.objectContaining({ p_status: 'DISABLED', p_user: 'target' }))
    expect(usersUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ is_active: expect.anything() }))
  })

  it('drops non-profile fields (email, password, arbitrary columns) from an administrator edit', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'admin' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 10 } })
    const { updateUserWithAuth } = await import('./actions')

    const result = await updateUserWithAuth('target', { full_name: 'Ok', email: 'hijack@x.test', password: 'x', account_status: 'ACTIVE', phone_verified_at: 'now' } as any)

    expect(result).toEqual({ success: true })
    expect(usersUpdate).toHaveBeenCalledWith({ full_name: 'Ok' })
  })

  it('an edited phone number is never marked verified', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'self' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: false, context: { role_level: 50 } })
    updateUserById.mockResolvedValue({ data: { user: { phone: '60123456789' } }, error: null })
    const { updateUserWithAuth } = await import('./actions')

    const result = await updateUserWithAuth('self', { phone: '0123456789' })

    expect(result).toEqual({ success: true })
    expect(usersUpdate).toHaveBeenCalledWith(expect.objectContaining({ phone: '+60123456789' }))
    expect(usersUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ phone_verified_at: expect.any(String) }))
  })

  it('denies an unauthorized cross-user update', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'ordinary' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: false, context: { role_level: 50 } })
    const { updateUserWithAuth } = await import('./actions')

    const result = await updateUserWithAuth('target', { role_code: 'SA' })

    expect(result.success).toBe(false)
    expect(usersUpdate).not.toHaveBeenCalled()
  })

  it('does not trust callerInfo when there is no authenticated session', async () => {
    authGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'missing session' } })
    const { updateUserWithAuth } = await import('./actions')

    const result = await updateUserWithAuth(
      'target',
      { role_code: 'SA' },
      { id: 'spoofed-super-admin', role_code: 'SA' },
    )

    expect(result.success).toBe(false)
    expect(checkPermissionForUser).not.toHaveBeenCalled()
    expect(usersUpdate).not.toHaveBeenCalled()
  })
})

describe('createUserWithAuth canonical provisioning', () => {
  it('rolls back the Auth identity when privileged profile provisioning fails', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'admin' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 10 } })
    rpcRoutes({
      identity_resolve: () => ({ data: { outcome: 'NO_MATCH' } }),
      identity_provision: () => ({ error: { message: 'sa_authorization_required' } }),
    })
    const { createUserWithAuth } = await import('./actions')

    const result = await createUserWithAuth({
      email: 'new@example.com',
      password: 'temporary-password',
      full_name: 'New User',
    })

    expect(result.success).toBe(false)
    expect(deleteAuthUser).toHaveBeenCalledWith('new-user')
  })

  it('never creates a second identity for a person who already exists', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'admin' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 10 } })
    rpcRoutes({
      identity_resolve: () => ({ data: { outcome: 'MATCH', user_id: 'existing' } }),
      identity_provision: () => ({ data: { status: 'ok', outcome: 'REUSED', user_id: 'existing', principal_type: 'INTERNAL_EMPLOYEE' } }),
    })
    const { createUserWithAuth } = await import('./actions')

    const result = await createUserWithAuth({
      email: 'Existing@Example.com', password: 'whatever-123', full_name: 'Existing', organization_id: 'org-a',
      bank_account_number: '123',
    })

    // Add User never reuses an account silently: without an explicit employee link the request stops (no duplicate, no change).
    expect(result).toMatchObject({ success: false, code: 'IDENTITY_ALREADY_EXISTS' })
    expect(createAuthUser).not.toHaveBeenCalled()
    // The existing identity's profile (e.g. banking) is not overwritten.
    expect(usersUpdate).not.toHaveBeenCalled()
  })

  it('blocks conflicting identifiers without creating anything', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'admin' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 10 } })
    rpcRoutes({ identity_resolve: () => ({ data: { outcome: 'IDENTITY_CONFLICT', matched_user_ids: ['a', 'b'] } }) })
    const { createUserWithAuth } = await import('./actions')

    const result = await createUserWithAuth({ email: 'a@example.com', password: 'p-123456', full_name: 'A', phone: '0123456789' })

    expect(result).toMatchObject({ success: false, code: 'IDENTITY_CONFLICT' })
    expect(createAuthUser).not.toHaveBeenCalled()
    expect(adminRpc).toHaveBeenCalledWith('identity_record_conflict', expect.anything())
  })
})

describe('setUserAccountStatus', () => {
  it('changes status through the lifecycle function for an authorized administrator', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'admin' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 10 } })
    rpcRoutes({ identity_set_account_status: () => ({ data: 'SUSPENDED' }) })
    const { setUserAccountStatus } = await import('./actions')

    const result = await setUserAccountStatus('target', 'SUSPENDED', 'Investigation')

    expect(result).toEqual({ success: true, status: 'SUSPENDED' })
    expect(adminRpc).toHaveBeenCalledWith('identity_set_account_status', { p_actor: 'admin', p_user: 'target', p_status: 'SUSPENDED', p_reason: 'Investigation' })
  })

  it('refuses self changes and unauthorized callers', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'admin' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 10 } })
    const { setUserAccountStatus } = await import('./actions')
    expect((await setUserAccountStatus('admin', 'DISABLED', 'self')).success).toBe(false)

    authGetUser.mockResolvedValue({ data: { user: { id: 'ordinary' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: false, context: { role_level: 50 } })
    expect((await setUserAccountStatus('target', 'DISABLED', 'nope')).success).toBe(false)
    expect(adminRpc).not.toHaveBeenCalledWith('identity_set_account_status', expect.anything())
  })
  it('a non-root administrator cannot suspend or disable a Root Administrator (Root would end in effect)', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'admin' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 1 } })
    rootGrantRows = [{ effective_until: null }]
    rpcRoutes({ sa_actor_is_root: () => ({ data: false }), identity_set_account_status: () => ({ data: 'SUSPENDED' }) })
    const { setUserAccountStatus } = await import('./actions')
    for (const status of ['SUSPENDED', 'DISABLED'] as const) {
      expect(await setUserAccountStatus('root-target', status, 'Investigation')).toEqual({ success: false, error: 'This account holds Root Access. Only another Root Administrator can change it.' })
    }
    expect(adminRpc).not.toHaveBeenCalledWith('identity_set_account_status', expect.anything())
  })

  it('another Root Administrator may (the database still protects the last one); a read failure fails closed', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'admin' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 10 } })
    rootGrantRows = [{ effective_until: null }]
    rpcRoutes({ sa_actor_is_root: () => ({ data: true }), identity_set_account_status: () => ({ data: 'SUSPENDED' }) })
    const { setUserAccountStatus } = await import('./actions')
    expect(await setUserAccountStatus('root-target', 'SUSPENDED', 'Investigation')).toEqual({ success: true, status: 'SUSPENDED' })
    adminRpc.mockClear()
    rootGrantError = { code: '57014', message: 'timeout' }
    expect((await setUserAccountStatus('root-target', 'SUSPENDED', 'Investigation')).success).toBe(false)
    expect(adminRpc).not.toHaveBeenCalledWith('identity_set_account_status', expect.anything())
  })
})

describe('deleteUserWithAuth history protection', () => {
  // targetUserOrganization, then the Archive Identities decision (lib/identity/removal-authorization.ts): actor row, target row.
  const removalRows = (actorLevel: number, targetLevel: number) => {
    usersSelectRow
      .mockResolvedValueOnce({ data: { organization_id: 'org-a' }, error: null })
      .mockResolvedValueOnce({ data: { organization_id: 'org-hq', roles: { role_level: actorLevel } }, error: null })
      .mockResolvedValueOnce({ data: { id: 'target', organization_id: 'org-a', account_status: 'ACTIVE', roles: { role_level: targetLevel } }, error: null })
  }

  it('refuses to hard-delete an identity with business or audit history, before any cleanup', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'admin' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 1 } })
    removalRows(1, 40)
    rpcRoutes({ identity_history_references: () => ({ data: ['stock_movements.created_by'] }) })
    const { deleteUserWithAuth } = await import('./actions')

    const result = await deleteUserWithAuth('target')

    expect(result).toMatchObject({ success: false, code: 'IDENTITY_HAS_HISTORY' })
    expect(adminFromTables.filter(t => t !== 'users')).toEqual([])
    expect(deleteAuthUser).not.toHaveBeenCalled()
  })

  it('fails closed when history cannot be verified', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'admin' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 1 } })
    removalRows(1, 40)
    rpcRoutes({ identity_history_references: () => ({ error: { message: 'unavailable' } }) })
    const { deleteUserWithAuth } = await import('./actions')

    const result = await deleteUserWithAuth('target')

    expect(result.success).toBe(false)
    expect(deleteAuthUser).not.toHaveBeenCalled()
  })

  it('managing users alone does not authorize removal: Archive Identities and target protection decide first', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'admin' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 20 } })
    removalRows(20, 40) // legacy Archive Identities rule: HQ Admin / Super Admin (<= 10)
    const { deleteUserWithAuth } = await import('./actions')
    expect((await deleteUserWithAuth('target')).success).toBe(false)

    removalRows(10, 1) // a Super Admin account needs a Super Admin
    expect((await deleteUserWithAuth('target')).success).toBe(false)

    expect(adminFromTables.filter(t => t !== 'users')).toEqual([])
    expect(adminRpc).not.toHaveBeenCalledWith('identity_history_references', expect.anything())
    expect(deleteAuthUser).not.toHaveBeenCalled()
  })
})

describe('setUserAccountStatus cannot archive', () => {
  it('refuses ARCHIVED (or any other value) sent directly to the server action; nothing reaches the database', async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: 'admin' } }, error: null })
    checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 1 } })
    const { setUserAccountStatus } = await import('./actions')
    for (const status of ['ARCHIVED', 'archived', 'DELETED']) {
      expect(await setUserAccountStatus('target', status as any, 'direct call')).toEqual({ success: false, error: 'Invalid account status' })
    }
    expect(adminRpc).not.toHaveBeenCalledWith('identity_set_account_status', expect.anything())
    expect(updateUserById).not.toHaveBeenCalled()
  })
})
