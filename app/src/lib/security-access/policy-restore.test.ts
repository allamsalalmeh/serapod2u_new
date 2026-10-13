import { beforeEach, describe, expect, it, vi } from 'vitest'

let check: any = { ok: true, sensitiveChecked: true }
const checkGrant = vi.fn(async (..._a: any[]) => check)
vi.mock('./grant-check', () => ({ checkGrant: (...a: any[]) => checkGrant(...a) }))

import { RESTORE_UNAVAILABLE_MESSAGE, restorePolicyGrant, withRestoreStatus } from './policy-restore'
import { RESTORE_BLOCKER_TEXT, restoreBlockerText, restoreStatusFromRow } from './policy-restore-shared'

const ORIGINAL = { id: 'a-old', user_id: 'u-target', role_id: 'r-policy', status: 'revoked', membership: { organization_id: 'o-hq' }, scopes: [{ scope_id: 's-hq' }] }

function fakeAdmin(over: { original?: any; readError?: any; restore?: { data?: any; error?: any }; status?: { data?: any; error?: any } } = {}) {
  const rpc = vi.fn(async (fn: string, _args: any) => fn === 'sa_restore_policy_grant'
    ? (over.restore ?? { data: 'a-new', error: null })
    : fn === 'sa_policy_restore_status' ? (over.status ?? { data: [], error: null }) : { data: null, error: { message: 'unexpected ' + fn } })
  const from = vi.fn(() => {
    const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: over.readError ? null : ('original' in over ? over.original : ORIGINAL), error: over.readError ?? null }) }
    return chain
  })
  return { rpc, from }
}

beforeEach(() => { check = { ok: true, sensitiveChecked: true }; checkGrant.mockClear() })

describe('restorePolicyGrant', () => {
  it('runs the ordinary grant checks on the ORIGINAL grant (person, policy, organization, scopes), then the database restore', async () => {
    const admin = fakeAdmin()
    expect(await restorePolicyGrant(admin, 'admin', 'a-old')).toEqual({ ok: true, assignmentId: 'a-new', restoredFrom: 'a-old' })
    expect(checkGrant).toHaveBeenCalledWith(admin, 'admin', { userId: 'u-target', roleId: 'r-policy', organizationId: 'o-hq', scopeIds: ['s-hq'] })
    expect(admin.rpc).toHaveBeenCalledWith('sa_restore_policy_grant', { p_actor: 'admin', p_assignment: 'a-old' })
  })

  it('a refused grant check (self, already held, scope authority, sensitive policy) never reaches the database', async () => {
    for (const refusal of [
      { ok: false, code: 'SELF_GRANT', message: 'You cannot grant access to yourself.', status: 403 },
      { ok: false, code: 'ROLE_ALREADY_HELD', message: 'already holds', status: 409 },
      { ok: false, code: 'GRANT_BEYOND_AUTHORITY', message: 'sensitive', status: 403 },
    ]) {
      check = refusal
      const admin = fakeAdmin()
      expect(await restorePolicyGrant(admin, 'admin', 'a-old')).toEqual({ ok: false, status: refusal.status, code: refusal.code, message: refusal.message })
      expect(admin.rpc).not.toHaveBeenCalled()
    }
  })

  it('refuses a missing or still-active grant before any check', async () => {
    let admin = fakeAdmin({ original: null })
    expect(await restorePolicyGrant(admin, 'admin', 'a-x')).toMatchObject({ ok: false, status: 404, code: 'sa_assignment_not_found' })
    admin = fakeAdmin({ original: { ...ORIGINAL, status: 'active' } })
    expect(await restorePolicyGrant(admin, 'admin', 'a-old')).toMatchObject({ ok: false, status: 409, code: 'sa_restore_not_revoked' })
    expect(checkGrant).not.toHaveBeenCalled()
    admin = fakeAdmin({ readError: { message: 'timeout' } })
    expect(await restorePolicyGrant(admin, 'admin', 'a-old')).toMatchObject({ ok: false, status: 503 })
  })

  it('maps every database refusal reason to its explanation; nothing is reported as success', async () => {
    for (const code of ['sa_restore_validity_expired', 'sa_restore_not_explicit_revoke', 'sa_role_not_assignable', 'sa_target_inactive', 'sa_profile_not_applicable', 'sa_scope_outside_membership', 'sa_role_already_held']) {
      const admin = fakeAdmin({ restore: { data: null, error: { message: code } } })
      expect(await restorePolicyGrant(admin, 'admin', 'a-old')).toEqual({ ok: false, status: 409, code, message: `${RESTORE_BLOCKER_TEXT[code]} Nothing was changed.` })
    }
    // Authority and other governance errors go to the shared mapping (403 Forbidden, SoD 409 …).
    const admin = fakeAdmin({ restore: { data: null, error: { message: 'sa_authorization_required' } } })
    expect(await restorePolicyGrant(admin, 'admin', 'a-old')).toEqual({ ok: false, databaseError: { message: 'sa_authorization_required' } })
  })

  it('before the migration: 503 with Grant Policy as the way forward', async () => {
    const admin = fakeAdmin({ restore: { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.sa_restore_policy_grant' } } })
    expect(await restorePolicyGrant(admin, 'admin', 'a-old')).toEqual({ ok: false, status: 503, code: 'RESTORE_UNAVAILABLE', message: RESTORE_UNAVAILABLE_MESSAGE })
  })
})

describe('withRestoreStatus', () => {
  const people = [{ id: 'u', membership: [{ id: 'm', assignments: [
    { id: 'active-1', status: 'active' }, { id: 'rev-ok', status: 'revoked' }, { id: 'rev-expired', status: 'revoked' }, { id: 'rev-auto', status: 'revoked' },
  ] }] }]

  it('asks the database only about revoked grants and attaches its answer', async () => {
    const admin = fakeAdmin({ status: { data: [
      { assignment_id: 'rev-ok', blocker: null, effective_from: null, effective_until: '2099-01-01T00:00:00Z' },
      { assignment_id: 'rev-expired', blocker: 'sa_restore_validity_expired', effective_from: null, effective_until: '2020-01-01T00:00:00Z' },
      { assignment_id: 'rev-auto', blocker: 'sa_restore_automatic', effective_from: null, effective_until: null },
    ], error: null } })
    const out = await withRestoreStatus(admin, people)
    expect(admin.rpc).toHaveBeenCalledWith('sa_policy_restore_status', { p_assignments: ['rev-ok', 'rev-expired', 'rev-auto'] })
    const byId = new Map(out.people[0].membership[0].assignments.map((a: any) => [a.id, a]))
    expect(out.available).toBe(true)
    expect(byId.get('rev-ok').restore).toEqual({ eligible: true, code: null, message: null, effectiveFrom: null, effectiveUntil: '2099-01-01T00:00:00Z' })
    expect(byId.get('rev-expired').restore).toMatchObject({ eligible: false, code: 'sa_restore_validity_expired', message: RESTORE_BLOCKER_TEXT.sa_restore_validity_expired })
    expect(byId.get('rev-auto').restore).toBeUndefined() // automatic access keeps its own Restore
    expect(byId.get('active-1').restore).toBeUndefined()
  })

  it('an unreadable status (migration not applied) offers no Restore and never fails the directory', async () => {
    const out = await withRestoreStatus(fakeAdmin({ status: { data: null, error: { code: 'PGRST202' } } }), people)
    expect(out.available).toBe(false)
    expect(out.people[0].membership[0].assignments.every((a: any) => !('restore' in a))).toBe(true)
    const admin = fakeAdmin()
    expect((await withRestoreStatus(admin, [{ membership: [{ assignments: [{ id: 'x', status: 'active' }] }] }])).available).toBe(true)
    expect(admin.rpc).not.toHaveBeenCalled()
  })
})

describe('restore status wording', () => {
  it('directs expired, non-revoked and unknown cases to Grant Policy and keeps a future start only', () => {
    expect(restoreBlockerText('sa_restore_validity_expired')).toMatch(/never extends it\. Use Grant Policy/)
    expect(restoreBlockerText('sa_restore_not_explicit_revoke')).toMatch(/expired, or was ended by an access review/)
    expect(restoreBlockerText('something_new')).toMatch(/cannot be restored\. Use Grant Policy/)
    expect(restoreStatusFromRow({ blocker: null, effective_from: '2000-01-01T00:00:00Z', effective_until: null })?.effectiveFrom).toBeNull()
    expect(restoreStatusFromRow({ blocker: null, effective_from: '2999-01-01T00:00:00Z', effective_until: null })?.effectiveFrom).toBe('2999-01-01T00:00:00Z')
  })
})
