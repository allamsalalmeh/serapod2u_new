import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.fn()
const createUser = vi.fn()
const deleteUser = vi.fn()

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: vi.fn(() => ({ rpc, auth: { admin: { createUser, deleteUser } } })),
}))

const base = { actorId: 'admin-1', email: 'former@example.com', fullName: 'New Person', organizationId: 'org-hq', source: 'user_management' as const }
const released = { outcome: 'IDENTITY_PREVIOUSLY_RELEASED', matched_user_ids: [], released_user_ids: ['archived-1'] }

describe('provisionIdentity: an email/phone released by an archived former user', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createUser.mockResolvedValue({ data: { user: { id: 'new-uuid' } }, error: null })
    rpc.mockImplementation(async (name: string) => {
      if (name === 'identity_resolve') return { data: released, error: null }
      if (name === 'identity_record_conflict') return { data: null, error: null }
      if (name === 'identity_provision') return { data: { status: 'ok', outcome: 'CREATED', user_id: 'new-uuid', principal_type: 'INTERNAL_EMPLOYEE' }, error: null }
      throw new Error(`unexpected rpc ${name}`)
    })
  })

  it('stops for a decision: never creates or attaches anything silently', async () => {
    const { provisionIdentity } = await import('./provisioning')
    const result = await provisionIdentity(base)
    expect(result).toMatchObject({ ok: false, code: 'IDENTITY_PREVIOUSLY_RELEASED', status: 409, matchedUserIds: ['archived-1'] })
    expect(createUser).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalledWith('identity_provision', expect.anything())
    expect(rpc).toHaveBeenCalledWith('identity_record_conflict', expect.objectContaining({ p_code: 'IDENTITY_PREVIOUSLY_RELEASED' }))
  })

  it('"different person" creates a NEW login and identity (new UUID) and records the decision', async () => {
    const { provisionIdentity } = await import('./provisioning')
    const result = await provisionIdentity({ ...base, releasedIdentifierDecision: 'new_person' })
    expect(result).toMatchObject({ ok: true, userId: 'new-uuid', outcome: 'CREATED' })
    expect(createUser).toHaveBeenCalledTimes(1)
    const provision = rpc.mock.calls.find(c => c[0] === 'identity_provision')!
    expect(provision[1].p_user).toBe('new-uuid')
    expect(provision[1].p_user).not.toBe('archived-1')
    expect(provision[1].p_payload).toMatchObject({ created_identity: true })
    expect(rpc).toHaveBeenCalledWith('identity_record_conflict', expect.objectContaining({
      p_code: 'IDENTITY_PREVIOUSLY_RELEASED', p_details: { stage: 'resolve', decision: 'new_person' } }))
  })

  it('the decision never overrides any other block (archived, conflict …)', async () => {
    rpc.mockImplementation(async (name: string) => (name === 'identity_resolve'
      ? { data: { outcome: 'IDENTITY_ARCHIVED', matched_user_ids: ['archived-2'] }, error: null } : { data: null, error: null }))
    const { provisionIdentity } = await import('./provisioning')
    const result = await provisionIdentity({ ...base, releasedIdentifierDecision: 'new_person' })
    expect(result).toMatchObject({ ok: false, code: 'IDENTITY_ARCHIVED' })
    expect(createUser).not.toHaveBeenCalled()
  })
})
