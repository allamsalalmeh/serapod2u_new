import { describe, expect, it, vi } from 'vitest'
import { reconcileEssBaseline, resolveEssIntent } from './ess-baseline'

describe('resolveEssIntent', () => {
  it('defaults an HQ account to ESS and honours an explicit exclusion', () => {
    expect(resolveEssIntent({ organizationTypeCode: 'HQ' })).toEqual({ ok: true, wanted: true })
    expect(resolveEssIntent({ organizationTypeCode: 'HQ', includeEss: true })).toEqual({ ok: true, wanted: true })
    expect(resolveEssIntent({ organizationTypeCode: 'HQ', includeEss: false })).toEqual({ ok: true, wanted: false })
  })
  it.each(['MFG', 'DIST', 'SHOP', 'WH', null])('never wants ESS for %s and rejects a tampered include_ess=true', (type) => {
    expect(resolveEssIntent({ organizationTypeCode: type as any })).toEqual({ ok: true, wanted: false })
    expect(resolveEssIntent({ organizationTypeCode: type as any, includeEss: false })).toEqual({ ok: true, wanted: false })
    expect(resolveEssIntent({ organizationTypeCode: type as any, includeEss: true })).toMatchObject({ ok: false, code: 'ESS_HQ_ONLY' })
  })
  it('refuses to exclude ESS for a linked HR employee', () => {
    expect(resolveEssIntent({ organizationTypeCode: 'HQ', includeEss: false, linkedUserId: 'u' })).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
  })
})

function fakeAdmin(opts: { role?: any; roleError?: boolean; rows?: any[]; rowsError?: boolean; revokeError?: boolean }) {
  const rpc = vi.fn(async () => ({ error: opts.revokeError ? { message: 'x' } : null }))
  const from = (table: string) => table === 'sa_business_roles'
    ? { select: () => ({ eq: () => ({ maybeSingle: async () => (opts.roleError ? { data: null, error: { message: 'x' } } : { data: 'role' in opts ? opts.role : { id: 'ess' }, error: null }) }) }) }
    : { select: () => ({ eq: () => ({ eq: async () => (opts.rowsError ? { data: null, error: { message: 'x' } } : { data: opts.rows ?? [], error: null }) }) }) }
  return { admin: { from, rpc }, rpc }
}
const base = { actorId: 'a', userId: 'u', hq: true, verifyAssigned: true }

describe('reconcileEssBaseline', () => {
  it('confirms the lifecycle baseline for an HQ account and never writes a second grant', async () => {
    const { admin, rpc } = fakeAdmin({ rows: [{ id: 'r1', status: 'active' }] })
    expect(await reconcileEssBaseline(admin, { ...base, wanted: true })).toEqual({ state: 'assigned' })
    expect(rpc).not.toHaveBeenCalled()
  })
  it('reports a missing baseline truthfully instead of claiming success', async () => {
    expect(await reconcileEssBaseline(fakeAdmin({ rows: [] }).admin, { ...base, wanted: true })).toMatchObject({ state: 'failed' })
    expect(await reconcileEssBaseline(fakeAdmin({ role: null }).admin, { ...base, wanted: true })).toMatchObject({ state: 'failed' })
    expect(await reconcileEssBaseline(fakeAdmin({ rowsError: true }).admin, { ...base, wanted: true })).toMatchObject({ state: 'failed' })
  })
  it('does not demand ESS for an account created inactive', async () => {
    expect(await reconcileEssBaseline(fakeAdmin({ rows: [] }).admin, { ...base, wanted: true, verifyAssigned: false })).toEqual({ state: 'skipped' })
  })
  it('revokes the automatic baseline through the audited S&A revoke for an excluded HQ account', async () => {
    const { admin, rpc } = fakeAdmin({ rows: [{ id: 'r1', status: 'active' }, { id: 'r0', status: 'revoked' }] })
    expect(await reconcileEssBaseline(admin, { ...base, wanted: false })).toEqual({ state: 'excluded' })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('sa_revoke_assignment', { p_actor: 'a', p_assignment: 'r1', p_reason: expect.stringMatching(/excluded/) })
  })
  it('removes a non-HQ baseline and is a no-op once the migration stops creating one', async () => {
    expect(await reconcileEssBaseline(fakeAdmin({ rows: [{ id: 'r1', status: 'active' }] }).admin, { ...base, hq: false, wanted: false })).toEqual({ state: 'not_applicable' })
    const none = fakeAdmin({ rows: [] })
    expect(await reconcileEssBaseline(none.admin, { ...base, hq: false, wanted: false })).toEqual({ state: 'not_applicable' })
    expect(none.rpc).not.toHaveBeenCalled()
  })
  it('reports a failed revoke instead of claiming exclusion', async () => {
    expect(await reconcileEssBaseline(fakeAdmin({ rows: [{ id: 'r1', status: 'active' }], revokeError: true }).admin, { ...base, wanted: false })).toMatchObject({ state: 'failed' })
  })
})
