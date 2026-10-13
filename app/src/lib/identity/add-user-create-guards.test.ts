import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/security-access/operation', async () => (await import('@/test-support/sa-legacy-mode')).operationModule)

const authGetUser = vi.fn()
const checkPermissionForUser = vi.fn()
const provisionIdentity = vi.fn()
const preview = vi.fn()
let orgType = 'HQ'
let essRows: any[] | null = null            // null = the lifecycle default (HQ has an active ESS row, others none)
let revokeError: any = null
const rpc = vi.fn(async (..._a: any[]) => ({ error: revokeError }))
let scopeResult: any = { ok: true }
const validateScopeGrant = vi.fn(async (..._a: any[]) => scopeResult)
vi.mock('@/lib/security-access/scope-grant', () => ({ loadScopeChoices: vi.fn(), validateScopeGrant: (...a: any[]) => validateScopeGrant(...a) }))
const ESS_ID = '00000000-0000-4000-8000-000000000003'
const WH_ID = '00000000-0000-4000-8000-000000000001'
const SCOPE = '00000000-0000-4000-8000-000000000011'

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => ({ auth: { getUser: authGetUser } })) }))
vi.mock('@/lib/server/permissions', () => ({ checkPermissionForUser }))
vi.mock('@/lib/hr/onboarding', () => ({ previewOnboardingCandidate: preview }))
vi.mock('@/lib/identity/provisioning', () => ({ provisionIdentity, setIdentityAccountStatus: vi.fn(), updateIdentityAccess: vi.fn(), identityHistoryReferences: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({
    rpc: (...a: any[]) => rpc(...a),
    from: (table: string) => {
      if (table === 'organizations') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { org_type_code: orgType } }) }) }) }
      if (table === 'sa_business_roles') return { select: () => ({
        in: async () => ({ data: [{ id: ESS_ID, role_key: 'employee-self-service', status: 'active', source: 'template', applicable_org_types: ['HQ'] }, { id: WH_ID, role_key: 'warehouse-operator', status: 'active', source: 'template', applicable_org_types: ['HQ', 'WH'] }] }),
        eq: (_c: string, id: string) => ({ maybeSingle: async () => ({ data: id === ESS_ID ? { role_key: 'employee-self-service', applicable_org_types: ['HQ'] } : { role_key: 'warehouse-operator', applicable_org_types: ['HQ', 'WH'] } }) }),
      }) }
      if (table === 'sa_role_assignments') return { select: () => ({ eq: () => ({ eq: async () => ({ data: essRows ?? (orgType === 'HQ' ? [{ id: 'a-ess', status: 'active' }] : []), error: null }) }) }) }
      return { update: () => ({ eq: async () => ({ error: null }) }), select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }
    },
  })),
}))

const base: any = { email: 'x@y.test', password: 'p-123456', full_name: 'X', organization_id: 'org-1' }
beforeEach(() => {
  vi.clearAllMocks(); orgType = 'HQ'; essRows = null; revokeError = null; scopeResult = { ok: true }
  authGetUser.mockResolvedValue({ data: { user: { id: 'admin' } }, error: null })
  checkPermissionForUser.mockResolvedValue({ allowed: true, context: { role_level: 1 } })
  provisionIdentity.mockResolvedValue({ ok: true, userId: 'u-1', outcome: 'CREATED', principalType: 'INTERNAL_EMPLOYEE' })
})

describe('createUserWithAuth — no legacy role/level on creation', () => {
  it.each(['HQ', 'MFG', 'DIST', 'SHOP'])('creates a %s account with no legacy role, the organization deciding the scope', async (type) => {
    orgType = type
    const { createUserWithAuth } = await import('@/lib/actions')
    const out: any = await createUserWithAuth({ ...base, initial_role_id: null })
    expect(out.success).toBe(true)
    const call = provisionIdentity.mock.calls.at(-1)![0]
    expect(call).toMatchObject({ noLegacyAccess: true, accountScope: 'portal', organizationId: 'org-1' })
    expect(call.legacyRoleCode).toBeUndefined()
    expect(call.initialAccess).toBeUndefined()
    expect(call.initialProfiles).toBeUndefined()      // "No Group Policy for now": nothing is granted silently
  })

  it.each(['SA', 'SUPER', 'HQ', 'MANAGER', 'USER', 'GUEST'])('rejects an injected legacy role %s before any side effect', async (role) => {
    const { createUserWithAuth } = await import('@/lib/actions')
    const out: any = await createUserWithAuth({ ...base, role_code: role })
    expect(out).toMatchObject({ success: false, code: 'LEGACY_ROLE_NOT_ALLOWED' })
    expect(provisionIdentity).not.toHaveBeenCalled()
    expect(validateScopeGrant).not.toHaveBeenCalled()
  })

  it.each([['legacy_role_code', 'SA'], ['role_level', 1]])('rejects an injected %s field', async (key, value) => {
    const { createUserWithAuth } = await import('@/lib/actions')
    expect(await createUserWithAuth({ ...base, [key]: value } as any)).toMatchObject({ success: false, code: 'LEGACY_ROLE_NOT_ALLOWED' })
    expect(provisionIdentity).not.toHaveBeenCalled()
  })

  it('still sends one or several policies, each with its scope, and no legacy role', async () => {
    const SCOPE2 = '00000000-0000-4000-8000-000000000012'
    const { createUserWithAuth } = await import('@/lib/actions')
    await createUserWithAuth({ ...base, initial_profiles: [{ role_id: WH_ID, scope_id: SCOPE }, { role_id: ESS_ID, scope_id: SCOPE2 }] })
    const call = provisionIdentity.mock.calls.at(-1)![0]
    expect(call.initialProfiles).toEqual([{ roleId: WH_ID, scopeIds: [SCOPE] }, { roleId: ESS_ID, scopeIds: [SCOPE2] }])
    expect(call).toMatchObject({ noLegacyAccess: true })
    expect(call.legacyRoleCode).toBeUndefined()
  })

  it('keeps the organization-type rules: ESS stays HQ-only and a non-authorized actor stays denied', async () => {
    orgType = 'MFG'
    const { createUserWithAuth } = await import('@/lib/actions')
    expect(await createUserWithAuth({ ...base, initial_profiles: [{ role_id: ESS_ID, scope_id: SCOPE }] })).toMatchObject({ success: false, code: 'ESS_HQ_ONLY' })
    expect(provisionIdentity).not.toHaveBeenCalled()
  })
})

describe('createUserWithAuth — direct API submissions are validated server-side before any side effect', () => {
  it.each(['DIST', 'SHOP', 'MFG', 'WH'])('rejects an ESS policy for a %s organization, whatever the UI sent', async (type) => {
    orgType = type
    const { createUserWithAuth } = await import('@/lib/actions')
    const result: any = await createUserWithAuth({ ...base, initial_profiles: [{ role_id: ESS_ID, scope_id: SCOPE }] })
    expect(result).toMatchObject({ success: false, code: 'ESS_HQ_ONLY' })
    expect(provisionIdentity).not.toHaveBeenCalled()
  })

  it('rejects the single-role compatibility path for ESS outside HQ as well', async () => {
    orgType = 'SHOP'
    const { createUserWithAuth } = await import('@/lib/actions')
    expect(await createUserWithAuth({ ...base, initial_role_id: ESS_ID })).toMatchObject({ success: false, code: 'ESS_HQ_ONLY' })
    expect(provisionIdentity).not.toHaveBeenCalled()
  })

  it('groups the same policy with two scopes into one grant and always asks provisioning to refuse an existing account', async () => {
    const SCOPE2 = '00000000-0000-4000-8000-000000000012'
    const { createUserWithAuth } = await import('@/lib/actions')
    await createUserWithAuth({ ...base, initial_profiles: [{ role_id: WH_ID, scope_id: SCOPE }, { role_id: WH_ID, scope_id: SCOPE2 }] })
    const call = provisionIdentity.mock.calls.at(-1)![0]
    expect(call.initialProfiles).toEqual([{ roleId: WH_ID, scopeIds: [SCOPE, SCOPE2] }])
    expect(call.requireNewIdentity).toBe(true)
    expect(call.linkUserId).toBeNull()
  })

  it('judges every policy\'s scopes (eligibility, policy compatibility, administrator authority) before anything is created', async () => {
    const { createUserWithAuth } = await import('@/lib/actions')
    await createUserWithAuth({ ...base, initial_profiles: [{ role_id: WH_ID, scope_id: SCOPE }] })
    expect(validateScopeGrant).toHaveBeenCalledWith(expect.anything(), { actorId: 'admin', roleId: WH_ID, organizationId: 'org-1', scopeIds: [SCOPE] })
  })

  it.each([
    [{ ok: false, code: 'SCOPE_NOT_ELIGIBLE', message: 'A selected scope is not available for an HQ account. Nothing was changed.', status: 400 }],
    [{ ok: false, code: 'WAREHOUSE_SCOPE_UNSUPPORTED', message: 'No warehouse. Nothing was changed.', status: 400 }],
    [{ ok: false, code: 'SCOPE_BEYOND_AUTHORITY', message: 'Beyond authority. Nothing was changed.', status: 403 }],
  ])('refuses a direct submission whose scope fails the picker rules (%j) with nothing created', async (result) => {
    scopeResult = result
    const { createUserWithAuth } = await import('@/lib/actions')
    const out: any = await createUserWithAuth({ ...base, initial_profiles: [{ role_id: WH_ID, scope_id: SCOPE }] })
    expect(out).toMatchObject({ success: false, code: (result as any).code })
    expect(out.error).toMatch(/Nothing was created\./)
    expect(provisionIdentity).not.toHaveBeenCalled()
  })

  it('refuses a duplicate policy-and-scope pair before creating anything', async () => {
    const { createUserWithAuth } = await import('@/lib/actions')
    const result: any = await createUserWithAuth({ ...base, initial_profiles: [{ role_id: WH_ID, scope_id: SCOPE }, { role_id: WH_ID, scope_id: SCOPE }] })
    expect(result).toMatchObject({ success: false, code: 'INVALID_INPUT' })
    expect(provisionIdentity).not.toHaveBeenCalled()
  })

  it('links an eligible HQ employee: verified through the HR eligibility check, then passed on explicitly', async () => {
    preview.mockResolvedValue({ ok: true, candidate: { found: true, user_id: 'emp-1', eligible: true } })
    provisionIdentity.mockResolvedValue({ ok: true, userId: 'emp-1', outcome: 'REUSED', principalType: 'INTERNAL_EMPLOYEE' })
    const { createUserWithAuth } = await import('@/lib/actions')
    const result: any = await createUserWithAuth({ ...base, password: '', linked_user_id: 'emp-1' })
    expect(preview).toHaveBeenCalledWith('admin', 'org-1', 'emp-1')
    expect(provisionIdentity.mock.calls[0][0]).toMatchObject({ linkUserId: 'emp-1', requireNewIdentity: true })
    expect(result).toMatchObject({ success: true, reused: true, linked: true, user_id: 'emp-1' })
  })

  it.each(['DIST', 'SHOP', 'MFG', 'WH'])('rejects an employee link for a %s organization (direct API)', async (type) => {
    orgType = type
    const { createUserWithAuth } = await import('@/lib/actions')
    expect(await createUserWithAuth({ ...base, linked_user_id: 'emp-1' })).toMatchObject({ success: false, code: 'ESS_HQ_ONLY' })
    expect(preview).not.toHaveBeenCalled()
    expect(provisionIdentity).not.toHaveBeenCalled()
  })

  it.each(['DIST', 'SHOP', 'MFG', 'WH'])('rejects HQ-only employment values for a %s organization before any side effect (direct API)', async (type) => {
    orgType = type
    const { createUserWithAuth } = await import('@/lib/actions')
    for (const extra of [{ department_id: 'd1' }, { position_id: 'p1' }, { manager_user_id: 'm1' }, { employment_type: 'Full-time' }, { join_date: '2026-01-01' }, { employment_status: 'resigned' }]) {
      const out: any = await createUserWithAuth({ ...base, ...extra })
      expect(out).toMatchObject({ success: false, code: 'EMPLOYMENT_HQ_ONLY' })
      expect(out.error).toMatch(/Nothing was created\./)
    }
    expect(provisionIdentity).not.toHaveBeenCalled()
  })

  it('judges employment eligibility on the stored organization type, not a client-supplied one', async () => {
    orgType = 'MFG'
    const { createUserWithAuth } = await import('@/lib/actions')
    expect(await createUserWithAuth({ ...base, department_id: 'd1', organization_type: 'HQ' } as any)).toMatchObject({ success: false, code: 'EMPLOYMENT_HQ_ONLY' })
    expect(provisionIdentity).not.toHaveBeenCalled()
  })

  it('does not depend on HR fields for a non-HQ account (default status and empty values are fine) and still accepts HQ employment values', async () => {
    const { createUserWithAuth } = await import('@/lib/actions')
    orgType = 'MFG'
    expect(await createUserWithAuth({ ...base, employment_status: 'active', department_id: '', join_date: null })).toMatchObject({ success: true })
    orgType = 'HQ'
    expect(await createUserWithAuth({ ...base, department_id: 'd1', position_id: 'p1', employment_type: 'Full-time' })).toMatchObject({ success: true })
    expect(provisionIdentity.mock.calls.at(-1)![0].hr).toMatchObject({ departmentId: 'd1', positionId: 'p1', employmentType: 'Full-time' })
  })

  it('rejects a link that is no longer eligible, or whose HR check the administrator may not run', async () => {
    const { createUserWithAuth } = await import('@/lib/actions')
    preview.mockResolvedValue({ ok: true, candidate: { found: true, user_id: 'emp-1', eligible: false } })
    expect(await createUserWithAuth({ ...base, linked_user_id: 'emp-1' })).toMatchObject({ success: false, code: 'IDENTITY_LINK_MISMATCH' })
    preview.mockResolvedValue({ ok: false, code: 'FORBIDDEN', status: 403, message: 'not allowed' })
    expect(await createUserWithAuth({ ...base, linked_user_id: 'emp-1' })).toMatchObject({ success: false, code: 'FORBIDDEN' })
    expect(provisionIdentity).not.toHaveBeenCalled()
  })

  it('reports an existing account honestly and creates nothing', async () => {
    provisionIdentity.mockResolvedValue({ ok: false, code: 'IDENTITY_ALREADY_EXISTS', status: 409, message: 'An account already exists' })
    const { createUserWithAuth } = await import('@/lib/actions')
    expect(await createUserWithAuth({ ...base })).toMatchObject({ success: false, code: 'IDENTITY_ALREADY_EXISTS' })
  })
})

describe('createUserWithAuth — Employee Self Service baseline', () => {
  it('HQ default: ESS is the lifecycle baseline (confirmed, not re-granted) and no revoke is made', async () => {
    const { createUserWithAuth } = await import('@/lib/actions')
    expect(await createUserWithAuth({ ...base })).toMatchObject({ success: true })
    expect(rpc).not.toHaveBeenCalled()
    expect(provisionIdentity.mock.calls[0][0].initialAccess).toBeUndefined()
  })

  it('HQ with several additional policies keeps ESS: the policies go through initialProfiles and ESS is untouched', async () => {
    const { createUserWithAuth } = await import('@/lib/actions')
    const out: any = await createUserWithAuth({ ...base, include_ess: true, initial_profiles: [{ role_id: WH_ID, scope_id: SCOPE }] })
    expect(out.success).toBe(true)
    expect(provisionIdentity.mock.calls[0][0].initialProfiles).toEqual([{ roleId: WH_ID, scopeIds: [SCOPE] }])
    expect(rpc).not.toHaveBeenCalled()
  })

  it('reports a missing HQ baseline as a partial failure, never as success', async () => {
    essRows = []
    const { createUserWithAuth } = await import('@/lib/actions')
    expect(await createUserWithAuth({ ...base })).toMatchObject({ success: false, partial: true, user_id: 'u-1' })
  })

  it('HQ exclusion revokes the baseline through the audited revoke', async () => {
    const { createUserWithAuth } = await import('@/lib/actions')
    expect(await createUserWithAuth({ ...base, include_ess: false })).toMatchObject({ success: true })
    expect(rpc).toHaveBeenCalledWith('sa_revoke_assignment', expect.objectContaining({ p_actor: 'admin', p_assignment: 'a-ess' }))
  })

  it('a failed exclusion is a truthful partial failure', async () => {
    revokeError = { message: 'boom' }
    const { createUserWithAuth } = await import('@/lib/actions')
    expect(await createUserWithAuth({ ...base, include_ess: false })).toMatchObject({ success: false, partial: true })
  })

  it('exclusion cannot be combined with the ESS policy or an employee link', async () => {
    const { createUserWithAuth } = await import('@/lib/actions')
    expect(await createUserWithAuth({ ...base, include_ess: false, initial_profiles: [{ role_id: ESS_ID, scope_id: SCOPE }] })).toMatchObject({ success: false, code: 'INVALID_INPUT' })
    expect(await createUserWithAuth({ ...base, include_ess: false, linked_user_id: 'emp-1' })).toMatchObject({ success: false, code: 'INVALID_INPUT' })
    expect(provisionIdentity).not.toHaveBeenCalled()
  })

  it.each(['DIST', 'SHOP', 'MFG', 'WH'])('rejects a tampered include_ess=true for a %s organization before any side effect', async (type) => {
    orgType = type
    const { createUserWithAuth } = await import('@/lib/actions')
    expect(await createUserWithAuth({ ...base, include_ess: true })).toMatchObject({ success: false, code: 'ESS_HQ_ONLY' })
    expect(provisionIdentity).not.toHaveBeenCalled()
  })

  it.each(['DIST', 'SHOP', 'MFG', 'WH'])('a %s account never keeps an automatic ESS baseline', async (type) => {
    orgType = type
    essRows = [{ id: 'a-ess', status: 'active' }]
    const { createUserWithAuth } = await import('@/lib/actions')
    expect(await createUserWithAuth({ ...base })).toMatchObject({ success: true })
    expect(rpc).toHaveBeenCalledWith('sa_revoke_assignment', expect.objectContaining({ p_assignment: 'a-ess' }))
  })

  it('a linked (existing) employee is not touched', async () => {
    preview.mockResolvedValue({ ok: true, candidate: { found: true, user_id: 'emp-1', eligible: true } })
    provisionIdentity.mockResolvedValue({ ok: true, userId: 'emp-1', outcome: 'REUSED', principalType: 'INTERNAL_EMPLOYEE' })
    const { createUserWithAuth } = await import('@/lib/actions')
    expect(await createUserWithAuth({ ...base, password: '', linked_user_id: 'emp-1' })).toMatchObject({ success: true, reused: true })
    expect(rpc).not.toHaveBeenCalled()
  })
})
