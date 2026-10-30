import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  deletionPreview: vi.fn(),
  deletionExecute: vi.fn(),
  deletionActorCheck: vi.fn(),
  archivePreview: vi.fn(),
  archiveExecute: vi.fn(),
  actorRow: { data: null as any, error: null as any },
}))

vi.mock('server-only', () => ({}))
vi.mock('./permanent-deletion', () => ({
  deletionPreview: mocks.deletionPreview,
  deletionExecute: mocks.deletionExecute,
  deletionActorCheck: mocks.deletionActorCheck,
}))
vi.mock('./archive', () => ({
  archivePreview: mocks.archivePreview,
  archiveExecute: mocks.archiveExecute,
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => mocks.actorRow }) }) }),
  }),
}))

import { bulkRemovalExecute, bulkRemovalPreview, bulkRemovalReviewPlan } from './bulk-removal'
import { verifyBulkPlanToken } from './bulk-removal-plan'

const SECRET = 'test-bulk-secret'
const ORG = '11111111-1111-1111-1111-111111111111'
const OTHER_ORG = '22222222-2222-2222-2222-222222222222'
const ACTOR = '00000000-0000-0000-0000-000000000090'
const u = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const U1 = u(1)
const U2 = u(2)
const U3 = u(3)

const deletionPreviewPayload = (userId: string, over: Record<string, unknown> = {}) => ({
  target: {
    user_id: userId, full_name: `Employee ${userId.slice(-1)}`, email: `e${userId.slice(-1)}@example.test`, phone: null,
    organization_id: ORG, organization_name: 'HQ', role_code: 'USER', employee_no: 100, account_status: 'ACTIVE',
    has_identity: true, has_login: true,
  },
  employment: [{ employment_id: 'e-1', organization_id: ORG, employee_no: 100, onboarding_status: 'completed', status: 'active' }],
  cleanup: [{ table: 'hr_employees', column: 'user_id', count: 1 }], retained: [],
  blockers: [], confirmation_phrase: `e${userId.slice(-1)}@example.test`, preview_token: `del-${userId}`,
  entry_point: 'hr', allowed: true, ...over,
})

const archivePreviewPayload = (userId: string, over: Record<string, unknown> = {}) => ({
  target: {
    user_id: userId, full_name: `Employee ${userId.slice(-1)}`, email: `e${userId.slice(-1)}@example.test`, phone: null,
    organization_id: ORG, organization_name: 'HQ', account_status: 'ACTIVE', employee_no: 100,
  },
  employment: [{ employment_id: 'e-1', organization_id: ORG, employee_no: 100, onboarding_status: 'completed', status: 'active' }],
  archived: false, identifiers_released: false, releasable: true, blockers: [],
  warnings: [{ code: 'SESSIONS_REVOKED', count: 1, message: '1 active sign-in session(s) will be ended immediately.' }],
  confirmation_phrase: `e${userId.slice(-1)}@example.test`, preview_token: `arc-${userId}`,
  entry_point: 'hr', archive_allowed: true, release_allowed: false, ...over,
})

const planFor = (entries: Array<{ user_id: string; action: 'delete' | 'archive'; employment_end?: 'resigned' | 'terminated'; release_identifiers?: boolean }>) =>
  entries.map(item => ({ employment_end: 'resigned' as const, release_identifiers: false, ...item }))

beforeEach(() => {
  vi.clearAllMocks()
  process.env.IDENTITY_BULK_REMOVAL_SECRET = SECRET
  mocks.actorRow = { data: { id: ACTOR, organization_id: ORG, is_active: true }, error: null }
  mocks.deletionActorCheck.mockResolvedValue({ ok: true, check: { permission: true } })
  mocks.deletionPreview.mockImplementation(async (_actor: string, userId: string) => ({ ok: true, preview: deletionPreviewPayload(userId) }))
  mocks.archivePreview.mockImplementation(async (_actor: string, userId: string) => ({ ok: true, preview: archivePreviewPayload(userId) }))
  mocks.deletionExecute.mockResolvedValue({
    ok: true, outcome: { status: 'completed', deletionId: 'd-1', replayed: false, removed: [], authVerified: true },
  })
  mocks.archiveExecute.mockResolvedValue({
    ok: true, outcome: { status: 'completed', actionId: 'a-1', replayed: false, released: true },
  })
})

describe('bulkRemovalPreview', () => {
  it('classifies each identity from the authoritative previews', async () => {
    mocks.deletionPreview.mockImplementation(async (_actor: string, userId: string) => {
      if (userId === U2) {
        return { ok: true, preview: deletionPreviewPayload(U2, {
          allowed: false, blockers: [{ code: 'PROTECTED_RECORDS', category: 'supply_chain', count: 2, message: 'Referenced by 2 Supply Chain records' }],
        }) }
      }
      if (userId === U3) {
        return { ok: true, preview: deletionPreviewPayload(U3, { allowed: false, blockers: [{ code: 'PROTECTED_ROOT' }] }) }
      }
      return { ok: true, preview: deletionPreviewPayload(userId) }
    })
    mocks.archivePreview.mockImplementation(async (_actor: string, userId: string) => {
      if (userId === U3) {
        return { ok: true, preview: archivePreviewPayload(U3, { archive_allowed: false, blockers: [{ code: 'PROTECTED_ROOT' }] }) }
      }
      return { ok: true, preview: archivePreviewPayload(userId) }
    })

    const result = await bulkRemovalPreview({ actorId: ACTOR, organizationId: ORG, userIds: [U1, U2, U3] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.targets.map(target => target.classification)).toEqual(['DELETE_ELIGIBLE', 'ARCHIVE_ELIGIBLE', 'BLOCKED'])
    expect(result.summary).toEqual({ total: 3, deleteEligible: 1, archiveEligible: 1, blocked: 1, unverified: 0 })
    expect(result.targets[1].blockers[0].message).toContain('Supply Chain')
  })

  it('reports an unverified identity instead of inferring eligibility', async () => {
    mocks.deletionPreview.mockResolvedValue({ ok: false, code: 'NOT_INSTALLED', status: 503, message: 'Permanent deletion is not installed.' })
    mocks.archivePreview.mockResolvedValue({ ok: false, code: 'NOT_INSTALLED', status: 503, message: 'Archive is not installed.' })
    const result = await bulkRemovalPreview({ actorId: ACTOR, organizationId: ORG, userIds: [U1] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.targets[0].classification).toBe('UNVERIFIED')
  })

  it('blocks and masks a target outside the organization', async () => {
    mocks.deletionPreview.mockResolvedValue({ ok: true, preview: deletionPreviewPayload(U1, {
      target: { ...deletionPreviewPayload(U1).target, organization_id: OTHER_ORG },
    }) })
    mocks.archivePreview.mockResolvedValue({ ok: true, preview: archivePreviewPayload(U1, {
      target: { ...archivePreviewPayload(U1).target, organization_id: OTHER_ORG },
    }) })
    const result = await bulkRemovalPreview({ actorId: ACTOR, organizationId: ORG, userIds: [U1] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.targets[0].classification).toBe('BLOCKED')
    expect(result.targets[0].full_name).toBeNull()
    expect(result.targets[0].delete_allowed).toBe(false)
    expect(result.targets[0].archive_allowed).toBe(false)
  })

  it('refuses without the canonical permission or outside the actor organization', async () => {
    mocks.deletionActorCheck.mockResolvedValue({ ok: true, check: { permission: false } })
    const denied = await bulkRemovalPreview({ actorId: ACTOR, organizationId: ORG, userIds: [U1] })
    expect(denied).toMatchObject({ ok: false, code: 'FORBIDDEN', status: 403 })
    expect(mocks.deletionPreview).not.toHaveBeenCalled()

    mocks.deletionActorCheck.mockResolvedValue({ ok: true, check: { permission: true } })
    const wrongOrg = await bulkRemovalPreview({ actorId: ACTOR, organizationId: OTHER_ORG, userIds: [U1] })
    expect(wrongOrg).toMatchObject({ ok: false, code: 'OUT_OF_SCOPE', status: 403 })
  })

  it('validates the selection and never accepts duplicates', async () => {
    expect(await bulkRemovalPreview({ actorId: ACTOR, organizationId: ORG, userIds: [] }))
      .toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(await bulkRemovalPreview({ actorId: ACTOR, organizationId: ORG, userIds: ['nope'] }))
      .toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(await bulkRemovalPreview({ actorId: ACTOR, organizationId: ORG, userIds: [U1, U1] }))
      .toMatchObject({ ok: false, code: 'INVALID_INPUT' })
  })
})


describe('bulkRemovalReviewPlan (confirmation contract)', () => {
  it('issues a server phrase, plan reference and a token bound to the exact targets, actions and preview state', async () => {
    const result = await bulkRemovalReviewPlan({
      actorId: ACTOR, organizationId: ORG,
      plan: planFor([
        { user_id: U1, action: 'delete' },
        { user_id: U2, action: 'archive', employment_end: 'terminated', release_identifiers: true },
      ]),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.phrase).toBe('REMOVE 2 EMPLOYEES')
    expect(result.plan_ref).toHaveLength(8)
    expect(result.targets.map(target => target.user_id)).toEqual([U1, U2])
    const verified = verifyBulkPlanToken(result.token, SECRET)
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.payload.actor).toBe(ACTOR)
    expect(verified.payload.organization).toBe(ORG)
    expect(verified.payload.request_id).toBe(result.request_id)
    expect(verified.payload.plan).toEqual([
      { user_id: U1, action: 'delete', state: expect.any(String) },
      { user_id: U2, action: 'archive', state: expect.any(String) },
    ])
  })

  it('refuses to turn a blocked permanent deletion into an archive automatically', async () => {
    mocks.deletionPreview.mockImplementation(async (_actor: string, userId: string) => ({
      ok: true, preview: deletionPreviewPayload(userId, { allowed: false, blockers: [{ code: 'PROTECTED_RECORDS', category: 'finance', count: 3 }] }),
    }))
    const result = await bulkRemovalReviewPlan({
      actorId: ACTOR, organizationId: ORG, plan: planFor([{ user_id: U1, action: 'delete' }]),
    })
    expect(result).toMatchObject({ ok: false, code: 'PLAN_NOT_ALLOWED', status: 409 })
    if (!result.ok) {
      expect(result.problems?.[0]?.message).toContain('Permanent deletion is not allowed')
      expect(result.targets?.[0]?.classification).toBe('ARCHIVE_ELIGIBLE')
    }
  })

  it('allows an archive-only plan but still requires an explicit archive action', async () => {
    mocks.deletionPreview.mockImplementation(async (_actor: string, userId: string) => ({
      ok: true, preview: deletionPreviewPayload(userId, { allowed: false, blockers: [{ code: 'PROTECTED_RECORDS', category: 'supply_chain', count: 1 }] }),
    }))
    const archive = await bulkRemovalReviewPlan({
      actorId: ACTOR, organizationId: ORG, plan: planFor([{ user_id: U1, action: 'archive' }]),
    })
    expect(archive.ok).toBe(true)
    if (archive.ok) expect(archive.phrase).toBe('REMOVE 1 EMPLOYEE')
  })

  it('refuses a target from another organization and an unverified target', async () => {
    mocks.deletionPreview.mockResolvedValue({ ok: true, preview: deletionPreviewPayload(U1, {
      target: { ...deletionPreviewPayload(U1).target, organization_id: OTHER_ORG },
    }) })
    const crossOrg = await bulkRemovalReviewPlan({
      actorId: ACTOR, organizationId: ORG, plan: planFor([{ user_id: U1, action: 'delete' }]),
    })
    expect(crossOrg).toMatchObject({ ok: false, code: 'PLAN_NOT_ALLOWED' })

    mocks.deletionPreview.mockResolvedValue({ ok: false, code: 'FAILED', status: 500, message: 'Preview failed.' })
    mocks.archivePreview.mockResolvedValue({ ok: false, code: 'FAILED', status: 500, message: 'Preview failed.' })
    const unverified = await bulkRemovalReviewPlan({
      actorId: ACTOR, organizationId: ORG, plan: planFor([{ user_id: U1, action: 'delete' }]),
    })
    expect(unverified).toMatchObject({ ok: false, code: 'PLAN_NOT_ALLOWED' })
    if (!unverified.ok) expect(unverified.problems?.[0]?.message).toContain('could not be verified')
  })

  it('refuses when the actor is not authorized', async () => {
    mocks.deletionActorCheck.mockResolvedValue({ ok: true, check: { permission: false } })
    const result = await bulkRemovalReviewPlan({
      actorId: ACTOR, organizationId: ORG, plan: planFor([{ user_id: U1, action: 'delete' }]),
    })
    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN', status: 403 })
    expect(mocks.deletionPreview).not.toHaveBeenCalled()
  })
})


describe('bulkRemovalExecute', () => {
  const reviewed = async (entries: Parameters<typeof planFor>[0]) => {
    const review = await bulkRemovalReviewPlan({ actorId: ACTOR, organizationId: ORG, plan: planFor(entries) })
    if (!review.ok) throw new Error(review.message)
    return review
  }

  /** Single permanent-deletion plan used by the guard tests. */
  const execute = (review: Awaited<ReturnType<typeof reviewed>>, over: Record<string, unknown> = {}) => bulkRemovalExecute({
    actorId: ACTOR, organizationId: ORG, requestId: review.request_id, token: review.token,
    confirmation: review.phrase, plan: planFor([{ user_id: U1, action: 'delete' }]),
    reason: 'Batch clean-up of test accounts', ...over,
  })

  it('requires the exact server phrase and never executes on a mismatch', async () => {
    const review = await reviewed([{ user_id: U1, action: 'delete' }])
    const result = await execute(review, { confirmation: 'REMOVE 9 EMPLOYEES' })
    expect(result).toMatchObject({ ok: false, code: 'CONFIRMATION_MISMATCH', status: 400 })
    expect(mocks.deletionExecute).not.toHaveBeenCalled()
  })

  it('invalidates the confirmation when the plan changed after review', async () => {
    const review = await reviewed([{ user_id: U1, action: 'delete' }])
    const result = await execute(review, {
      plan: planFor([{ user_id: U1, action: 'archive', release_identifiers: true }]),
    })
    expect(result).toMatchObject({ ok: false, code: 'PLAN_CHANGED', status: 409 })
    expect(mocks.archiveExecute).not.toHaveBeenCalled()
    expect(mocks.deletionExecute).not.toHaveBeenCalled()
  })

  it('invalidates a stale preview before mutating anything', async () => {
    const review = await reviewed([{ user_id: U1, action: 'delete' }])
    mocks.deletionPreview.mockImplementation(async (_actor: string, userId: string) => ({
      ok: true, preview: deletionPreviewPayload(userId, { preview_token: 'del-changed' }),
    }))
    const result = await execute(review)
    expect(result).toMatchObject({ ok: false, code: 'PREVIEW_STALE', status: 409 })
    expect(mocks.deletionExecute).not.toHaveBeenCalled()
  })

  it('re-checks authorization at execution time', async () => {
    const review = await reviewed([{ user_id: U1, action: 'delete' }])
    mocks.deletionActorCheck.mockResolvedValue({ ok: true, check: { permission: false } })
    const result = await execute(review)
    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN', status: 403 })
    expect(mocks.deletionExecute).not.toHaveBeenCalled()
  })

  it('rejects a token issued for another actor or organization', async () => {
    const review = await reviewed([{ user_id: U1, action: 'delete' }])
    expect(await execute(review, { actorId: u(91) })).toMatchObject({ ok: false, code: 'INVALID_TOKEN' })
    expect(await execute(review, { organizationId: OTHER_ORG })).toMatchObject({ ok: false, code: 'INVALID_TOKEN' })
    expect(mocks.deletionExecute).not.toHaveBeenCalled()
  })

  it('requires a reason for permanent deletion and keeps it optional for archive', async () => {
    const deletion = await reviewed([{ user_id: U1, action: 'delete' }])
    expect(await execute(deletion, { reason: '' })).toMatchObject({ ok: false, code: 'REASON_REQUIRED' })
    expect(mocks.deletionExecute).not.toHaveBeenCalled()

    mocks.deletionPreview.mockImplementation(async (_actor: string, userId: string) => ({
      ok: true, preview: deletionPreviewPayload(userId, {
        allowed: false, blockers: [{ code: 'PROTECTED_RECORDS', category: 'finance', count: 1 }],
      }),
    }))
    const archive = await reviewed([{ user_id: U1, action: 'archive' }])
    const result = await bulkRemovalExecute({
      actorId: ACTOR, organizationId: ORG, requestId: archive.request_id, token: archive.token,
      confirmation: archive.phrase, plan: planFor([{ user_id: U1, action: 'archive' }]), reason: '',
    })
    expect(result.ok).toBe(true)
    expect(mocks.archiveExecute).toHaveBeenCalledWith(expect.objectContaining({ reason: '', userId: U1 }))
  })

  it('executes a mixed plan through the canonical services and reports every identity', async () => {
    const review = await reviewed([
      { user_id: U1, action: 'delete' },
      { user_id: U2, action: 'archive', employment_end: 'terminated', release_identifiers: true },
    ])
    const result = await bulkRemovalExecute({
      actorId: ACTOR, organizationId: ORG, requestId: review.request_id, token: review.token,
      confirmation: review.phrase, plan: planFor([
        { user_id: U1, action: 'delete' },
        { user_id: U2, action: 'archive', employment_end: 'terminated', release_identifiers: true },
      ]), reason: 'Batch clean-up of test accounts',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.summary).toEqual({ total: 2, deleted: 1, archived: 1, blocked: 0, failed: 0, stale: 0, conflict: 0, unconfirmed: 0 })
    expect(result.complete).toBe(true)
    expect(result.results.map(item => item.outcome)).toEqual(['deleted', 'archived'])
    expect(mocks.deletionExecute).toHaveBeenCalledWith(expect.objectContaining({
      actorId: ACTOR, userId: U1, entry: 'hr', previewToken: `del-${U1}`, confirmation: 'e1@example.test',
      reason: 'Batch clean-up of test accounts',
    }))
    expect(mocks.archiveExecute).toHaveBeenCalledWith(expect.objectContaining({
      actorId: ACTOR, userId: U2, entry: 'hr', previewToken: `arc-${U2}`, confirmation: 'e2@example.test',
      releaseIdentifiers: true, employmentEnd: 'terminated', reason: 'Batch clean-up of test accounts',
    }))
  })



  it('reports a blocked identity without affecting the others and never claims false success', async () => {
    mocks.archiveExecute.mockResolvedValue({
      ok: true,
      outcome: { status: 'blocked', replayed: false, blockers: [{ code: 'TARGET_MORE_PRIVILEGED', message: 'More privileged' }] },
    })
    const review = await reviewed([
      { user_id: U1, action: 'delete' },
      { user_id: U2, action: 'archive' },
    ])
    const result = await bulkRemovalExecute({
      actorId: ACTOR, organizationId: ORG, requestId: review.request_id, token: review.token,
      confirmation: review.phrase, plan: planFor([{ user_id: U1, action: 'delete' }, { user_id: U2, action: 'archive' }]),
      reason: 'Batch clean-up of test accounts',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.complete).toBe(false)
    expect(result.summary).toMatchObject({ total: 2, deleted: 1, archived: 0, blocked: 1, failed: 0 })
    expect(result.results.find(item => item.user_id === U2)).toMatchObject({ outcome: 'blocked', detail: 'More privileged' })
  })

  it('never falls back from a failed permanent deletion to an archive', async () => {
    mocks.deletionExecute.mockResolvedValue({ ok: false, code: 'FAILED', status: 500, message: 'The deletion did not complete.' })
    const review = await reviewed([{ user_id: U1, action: 'delete' }])
    const result = await execute(review)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.results[0]).toMatchObject({ outcome: 'failed', action: 'delete' })
    expect(result.complete).toBe(false)
    expect(mocks.archiveExecute).not.toHaveBeenCalled()
  })

  it('is idempotent for a retry: the same batch reuses the same per-identity request id', async () => {
    const review = await reviewed([{ user_id: U1, action: 'delete' }])
    const args = {
      actorId: ACTOR, organizationId: ORG, requestId: review.request_id, token: review.token,
      confirmation: review.phrase, plan: planFor([{ user_id: U1, action: 'delete' }]), reason: 'Batch clean-up of test accounts',
    }
    await bulkRemovalExecute(args)
    await bulkRemovalExecute(args)
    const ids = mocks.deletionExecute.mock.calls.map(call => (call[0] as { requestId: string }).requestId)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
    expect(mocks.deletionExecute.mock.calls[1][0]).toMatchObject({ previewToken: `del-${U1}` })
  })

  it('serializes destructive execution: a batch never runs two canonical transactions at once', async () => {
    const review = await reviewed([
      { user_id: U1, action: 'delete' },
      { user_id: U2, action: 'delete' },
    ])
    let inFlight = 0
    let maxInFlight = 0
    mocks.deletionExecute.mockImplementation(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise(resolve => setTimeout(resolve, 15))
      inFlight -= 1
      return { ok: true, outcome: { status: 'completed', deletionId: 'd', replayed: false, removed: [], authVerified: true } }
    })
    const result = await bulkRemovalExecute({
      actorId: ACTOR, organizationId: ORG, requestId: review.request_id, token: review.token,
      confirmation: review.phrase, plan: planFor([
        { user_id: U1, action: 'delete' },
        { user_id: U2, action: 'delete' },
      ]), reason: 'Batch clean-up of test accounts',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.summary.deleted).toBe(2)
    expect(result.complete).toBe(true)
    expect(maxInFlight).toBe(1)
  })

  it('retries a proven transient lock conflict with the same idempotency identity', async () => {
    mocks.deletionExecute
      .mockResolvedValueOnce({ ok: false, code: 'BUSY', status: 409, message: 'This person\'s records are being changed right now.' })
      .mockResolvedValueOnce({ ok: true, outcome: { status: 'completed', deletionId: 'd-1', replayed: false, removed: [], authVerified: true } })
    const review = await reviewed([{ user_id: U1, action: 'delete' }])
    const result = await execute(review)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.results[0].outcome).toBe('deleted')
    expect(result.complete).toBe(true)
    expect(mocks.deletionExecute).toHaveBeenCalledTimes(2)
    const ids = mocks.deletionExecute.mock.calls.map(call => (call[0] as { requestId: string }).requestId)
    expect(ids[0]).toBe(ids[1])
  })

  it('reports a persistent conflict as unchanged/retryable and never substitutes an archive', async () => {
    mocks.deletionExecute.mockResolvedValue({ ok: false, code: 'BUSY', status: 409, message: 'lock timeout' })
    const review = await reviewed([{ user_id: U1, action: 'delete' }])
    const result = await execute(review)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.results[0]).toMatchObject({ outcome: 'conflict', retryable: true, action: 'delete' })
    expect(result.complete).toBe(false)
    expect(mocks.deletionExecute).toHaveBeenCalledTimes(3)
    expect(mocks.archiveExecute).not.toHaveBeenCalled()
  })

  it('never retries an uncertain authentication outcome and labels it unconfirmed', async () => {
    mocks.deletionExecute.mockResolvedValue({
      ok: false, code: 'AUTH_CLEANUP_REQUIRED', status: 502,
      message: 'The person\'s records were deleted, but the login could not be confirmed as removed. Retry the deletion to finish; it is recorded and safe to repeat.',
    })
    const review = await reviewed([{ user_id: U1, action: 'delete' }])
    const result = await execute(review)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.results[0]).toMatchObject({ outcome: 'unconfirmed', retryable: false })
    expect(result.complete).toBe(false)
    expect(mocks.deletionExecute).toHaveBeenCalledTimes(1)
    expect(mocks.archiveExecute).not.toHaveBeenCalled()
  })

  it('never retries a dependency blocker or a stale preview', async () => {
    mocks.deletionExecute.mockResolvedValue({
      ok: true, outcome: { status: 'blocked', replayed: false, blockers: [{ code: 'PROTECTED_RECORDS', message: 'Protected history' }] },
    })
    const blockedReview = await reviewed([{ user_id: U1, action: 'delete' }])
    const blocked = await execute(blockedReview)
    expect(blocked.ok).toBe(true)
    if (blocked.ok) expect(blocked.results[0].outcome).toBe('blocked')
    expect(mocks.deletionExecute).toHaveBeenCalledTimes(1)

    mocks.deletionExecute.mockClear()
    const staleReview = await reviewed([{ user_id: U1, action: 'delete' }])
    mocks.deletionExecute.mockResolvedValue({ ok: true, outcome: { status: 'stale' } })
    const stale = await execute(staleReview)
    expect(stale.ok).toBe(true)
    if (stale.ok) expect(stale.results[0].outcome).toBe('stale')
    expect(mocks.deletionExecute).toHaveBeenCalledTimes(1)
  })


  it('labels an unexpected execution exception as unconfirmed and never retries it automatically', async () => {
    mocks.deletionExecute.mockRejectedValue(new Error('socket closed'))
    const review = await reviewed([{ user_id: U1, action: 'delete' }])
    const result = await execute(review)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.results[0]).toMatchObject({ outcome: 'unconfirmed', retryable: false })
    expect(result.summary.unconfirmed).toBe(1)
    expect(result.complete).toBe(false)
    expect(mocks.deletionExecute).toHaveBeenCalledTimes(1)
  })

})
