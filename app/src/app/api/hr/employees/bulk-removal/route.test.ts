import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  plan: vi.fn(),
  execute: vi.fn(),
  auditInsert: vi.fn(async () => ({ error: null })),
  session: { id: 'actor-1' } as { id: string } | null,
  profile: { id: 'actor-1', organization_id: '11111111-1111-1111-1111-111111111111' } as any,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: mocks.session }, error: mocks.session ? null : { message: 'no session' } }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: mocks.profile, error: mocks.profile ? null : { message: 'no profile' } }) }) }) }),
  })),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: () => ({ insert: mocks.auditInsert }) }),
}))
vi.mock('@/lib/identity/bulk-removal', () => ({
  bulkRemovalPreview: mocks.preview,
  bulkRemovalReviewPlan: mocks.plan,
  bulkRemovalExecute: mocks.execute,
}))

import { POST as previewPOST } from './preview/route'
import { POST as planPOST } from './plan/route'
import { POST as executePOST } from './route'

const ORG = '11111111-1111-1111-1111-111111111111'
const OTHER_ORG = '22222222-2222-2222-2222-222222222222'
const U1 = '00000000-0000-0000-0000-000000000001'
const REQ = '00000000-0000-0000-0000-0000000000f1'
const post = (path: string, body: Record<string, unknown>) =>
  new NextRequest(`http://localhost/api/hr/employees/bulk-removal${path}`, { method: 'POST', body: JSON.stringify(body) })
const target = { user_id: U1, full_name: 'Tess Tester', classification: 'DELETE_ELIGIBLE', delete_allowed: true, archive_allowed: true }
const plan = [{ user_id: U1, action: 'delete', employment_end: 'resigned', release_identifiers: false }]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.session = { id: 'actor-1' }
  mocks.profile = { id: 'actor-1', organization_id: ORG }
})

describe('bulk removal API routes', () => {
  it('refuse every step without a verified session', async () => {
    mocks.session = null
    expect((await previewPOST(post('/preview', { user_ids: [U1] }))).status).toBe(401)
    expect((await planPOST(post('/plan', { plan }))).status).toBe(401)
    expect((await executePOST(post('', { request_id: REQ, plan }))).status).toBe(401)
    expect(mocks.preview).not.toHaveBeenCalled()
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('uses the organization loaded for the session actor, never a body-supplied one', async () => {
    mocks.preview.mockResolvedValue({ ok: true, targets: [target], summary: { total: 1, deleteEligible: 1, archiveEligible: 0, blocked: 0, unverified: 0 } })
    const res = await previewPOST(post('/preview', { user_ids: [U1], organization_id: OTHER_ORG }))
    expect(res.status).toBe(200)
    expect(mocks.preview).toHaveBeenCalledWith({ actorId: 'actor-1', organizationId: ORG, userIds: [U1] })
    expect(await res.json()).toMatchObject({ success: true, data: { targets: [expect.objectContaining({ user_id: U1 })] } })
  })

  it('maps a preview refusal to its status without target details', async () => {
    mocks.preview.mockResolvedValue({ ok: false, code: 'OUT_OF_SCOPE', status: 403, message: 'Only your own organization.' })
    const res = await previewPOST(post('/preview', { user_ids: [U1] }))
    expect(res.status).toBe(403)
    const json = await res.json()
    expect(json).toMatchObject({ success: false, code: 'OUT_OF_SCOPE' })
    expect(json.data).toBeUndefined()
  })

  it('returns the confirmation contract from the plan step', async () => {
    mocks.plan.mockResolvedValue({
      ok: true, token: 'signed', request_id: REQ, phrase: 'REMOVE 1 EMPLOYEE', plan_ref: 'ABCDEF12',
      expires_at: '2026-10-24T10:00:00.000Z', targets: [target], summary: { total: 1, deleteEligible: 1, archiveEligible: 0, blocked: 0, unverified: 0 },
    })
    const res = await planPOST(post('/plan', { plan }))
    expect(res.status).toBe(200)
    expect(mocks.plan).toHaveBeenCalledWith({ actorId: 'actor-1', organizationId: ORG, plan })
    const json = await res.json()
    expect(json.data).toMatchObject({ phrase: 'REMOVE 1 EMPLOYEE', request_id: REQ, plan_ref: 'ABCDEF12' })
  })

  it('passes plan problems back for re-review with a 409', async () => {
    mocks.plan.mockResolvedValue({
      ok: false, code: 'PLAN_NOT_ALLOWED', status: 409, message: 'Not allowed.',
      problems: [{ user_id: U1, message: 'Permanent deletion is not allowed for this person.' }], targets: [target],
    })
    const res = await planPOST(post('/plan', { plan }))
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.data.problems[0].message).toContain('not allowed')
    expect(json.data.targets).toHaveLength(1)
  })
})

describe('bulk removal execution route', () => {
  const body = {
    request_id: REQ, batch_token: 'signed', confirmation: 'REMOVE 1 EMPLOYEE',
    reason: 'Batch clean-up of test accounts', plan, organization_id: OTHER_ORG,
  }

  it('executes the confirmed plan through the canonical bulk service for the session actor', async () => {
    mocks.execute.mockResolvedValue({
      ok: true, request_id: REQ, complete: true,
      summary: { total: 1, deleted: 1, archived: 0, blocked: 0, failed: 0, stale: 0 },
      results: [{ user_id: U1, name: 'Tess Tester', action: 'delete', outcome: 'deleted', detail: null }],
    })
    const res = await executePOST(post('', body))
    expect(res.status).toBe(200)
    expect(mocks.execute).toHaveBeenCalledWith({
      actorId: 'actor-1', organizationId: ORG, requestId: REQ, token: 'signed',
      confirmation: 'REMOVE 1 EMPLOYEE', plan, reason: 'Batch clean-up of test accounts',
    })
    expect(await res.json()).toMatchObject({ success: true, complete: true, data: { summary: { deleted: 1 } } })
    expect(mocks.auditInsert).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'hr_bulk_employee_removal', user_id: 'actor-1', allowed: true,
    }))
  })

  it('never reports a mixed batch as fully successful but still returns every per-user result', async () => {
    mocks.execute.mockResolvedValue({
      ok: true, request_id: REQ, complete: false,
      summary: { total: 2, deleted: 1, archived: 0, blocked: 1, failed: 0, stale: 0 },
      results: [
        { user_id: U1, name: 'Tess Tester', action: 'delete', outcome: 'deleted', detail: null },
        { user_id: '00000000-0000-0000-0000-000000000002', name: 'Protected Person', action: 'archive', outcome: 'blocked', detail: 'More privileged' },
      ],
    })
    const res = await executePOST(post('', body))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.success).toBe(false)
    expect(json.complete).toBe(false)
    expect(json.data.results).toHaveLength(2)
    expect(json.data.summary.blocked).toBe(1)
    expect(mocks.auditInsert).toHaveBeenCalledWith(expect.objectContaining({ allowed: false }))
  })

  it('maps refusals (stale plan, blocked plan, missing reason) to their status and audits the attempt', async () => {
    mocks.execute.mockResolvedValue({ ok: false, code: 'PREVIEW_STALE', status: 409, message: 'Changed.', targets: [target] })
    const stale = await executePOST(post('', body))
    expect(stale.status).toBe(409)
    const staleJson = await stale.json()
    expect(staleJson).toMatchObject({ success: false, code: 'PREVIEW_STALE' })
    expect(staleJson.data.targets).toHaveLength(1)
    expect(mocks.auditInsert).toHaveBeenCalledWith(expect.objectContaining({ allowed: false }))

    mocks.execute.mockResolvedValue({ ok: false, code: 'REASON_REQUIRED', status: 400, message: 'Reason required.' })
    expect((await executePOST(post('', body))).status).toBe(400)

    mocks.execute.mockResolvedValue({ ok: false, code: 'FORBIDDEN', status: 403, message: 'Forbidden.' })
    expect((await executePOST(post('', body))).status).toBe(403)
  })

  it('reports an unconfirmed outcome without claiming success', async () => {
    mocks.execute.mockRejectedValue(new Error('server exploded'))
    const res = await executePOST(post('', body))
    expect(res.status).toBe(500)
    const json = await res.json()
    expect(json).toMatchObject({ success: false, code: 'UNCONFIRMED' })
    expect(mocks.auditInsert).toHaveBeenCalledWith(expect.objectContaining({
      allowed: false, reason: expect.stringContaining('UNCONFIRMED'),
    }))
  })
})

