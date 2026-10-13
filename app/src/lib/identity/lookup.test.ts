import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const rpc = vi.fn()
const preview = vi.fn()
let userRow: any
let orgType = 'HQ'
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc,
    from: (table: string) => table === 'users'
      ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: userRow }) }) }) }
      : { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { org_type_code: orgType } }) }) }) },
  }),
}))
vi.mock('@/lib/hr/onboarding', () => ({ previewOnboardingCandidate: preview, ONBOARDING_BLOCK_MESSAGES: { EMPLOYMENT_ENDED: 'Employment ended.' } }))

const ORG = 'org-hq'
const match = (userId: string, hasProfile = true) => ({ data: { outcome: 'MATCH', user_id: userId, has_profile: hasProfile } })
const none = { data: { outcome: 'NO_MATCH' } }
/** identity_resolve is called once per identifier: email only, then phone only. */
function resolves(byEmail: any, byPhone: any) {
  rpc.mockImplementation(async (_n: string, a: any) => (a.p_email ? byEmail : byPhone))
}
const candidate = (extra: any = {}) => ({ ok: true, candidate: { found: true, user_id: 'u1', full_name: 'Aisyah Rahman', organization_name: 'Serapod HQ', eligible: true, employment: { employee_no: 7 }, ...extra } })

beforeEach(() => { vi.clearAllMocks(); orgType = 'HQ'; userRow = { id: 'u1', full_name: 'Aisyah Rahman', organization_id: ORG, organizations: { org_name: 'Serapod HQ' } } })

describe('lookupIdentity', () => {
  it('finds nothing for incomplete or unknown identifiers (no call for an invalid email/phone)', async () => {
    const { lookupIdentity } = await import('./lookup')
    expect(await lookupIdentity({ actorId: 'a', organizationId: ORG, email: 'half@', phone: '12' })).toEqual({ status: 'none' })
    expect(rpc).not.toHaveBeenCalled()
    resolves(none, none)
    expect(await lookupIdentity({ actorId: 'a', organizationId: ORG, email: 'New@Example.com', phone: '0123456789' })).toEqual({ status: 'none' })
    expect(rpc).toHaveBeenCalledWith('identity_resolve', { p_email: 'new@example.com', p_phone: null })
    expect(rpc).toHaveBeenCalledWith('identity_resolve', { p_email: null, p_phone: '+60123456789' })
  })

  it('reports an eligible HQ employee with exactly the basic fields it would fill (no contact, salary or bank data)', async () => {
    resolves(match('u1'), none)
    preview.mockResolvedValue(candidate())
    const { lookupIdentity } = await import('./lookup')
    const result = await lookupIdentity({ actorId: 'admin', organizationId: ORG, email: 'a@x.test', phone: null })
    expect(result).toEqual({ status: 'employee', matchedBy: 'email', userId: 'u1', name: 'Aisyah Rahman', organizationName: 'Serapod HQ', employeeNo: 7,
      fills: [{ field: 'full_name', label: 'Full name', value: 'Aisyah Rahman' }] })
    expect(preview).toHaveBeenCalledWith('admin', ORG, 'u1')
  })

  it('treats the same person found by email and phone as one match', async () => {
    resolves(match('u1'), match('u1'))
    preview.mockResolvedValue(candidate())
    const { lookupIdentity } = await import('./lookup')
    expect(await lookupIdentity({ actorId: 'admin', organizationId: ORG, email: 'a@x.test', phone: '0123456789' })).toMatchObject({ status: 'employee', matchedBy: 'both' })
  })

  it('requires resolution when the email and the phone belong to different people — nothing is offered for linking', async () => {
    resolves(match('u1'), match('u2'))
    const { lookupIdentity } = await import('./lookup')
    const result = await lookupIdentity({ actorId: 'admin', organizationId: ORG, email: 'a@x.test', phone: '0123456789' })
    expect(result).toMatchObject({ status: 'conflict' })
    expect(preview).not.toHaveBeenCalled()
  })

  it('never links by name: only identifier matches are looked up', async () => {
    resolves(none, none)
    const { lookupIdentity } = await import('./lookup')
    await lookupIdentity({ actorId: 'admin', organizationId: ORG, email: 'a@x.test', phone: '0123456789' })
    expect(rpc.mock.calls.every(c => c[0] === 'identity_resolve')).toBe(true)
  })

  it.each(['IDENTITY_AMBIGUOUS_EMAIL', 'IDENTITY_VERIFICATION_REQUIRED', 'IDENTITY_ARCHIVED'])('reports the resolver refusal %s without any personal data', async (outcome) => {
    resolves({ data: { outcome } }, none)
    const { lookupIdentity } = await import('./lookup')
    expect(await lookupIdentity({ actorId: 'admin', organizationId: ORG, email: 'a@x.test' })).toMatchObject({ status: 'blocked', code: outcome })
  })

  it('does not treat a login without a profile as an account (a retry completes it)', async () => {
    resolves(match('orphan', false), none)
    const { lookupIdentity } = await import('./lookup')
    expect(await lookupIdentity({ actorId: 'admin', organizationId: ORG, email: 'a@x.test' })).toEqual({ status: 'none' })
  })

  it('offers no employee link outside HQ: an existing partner account is only reported', async () => {
    orgType = 'DIST'
    resolves(match('u1'), none)
    const { lookupIdentity } = await import('./lookup')
    const result = await lookupIdentity({ actorId: 'admin', organizationId: ORG, email: 'a@x.test' })
    expect(result).toMatchObject({ status: 'account_exists', openUserId: 'u1' })
    expect(preview).not.toHaveBeenCalled()
  })

  it('does not disclose a person in another organization (no name, organization or open link)', async () => {
    userRow = { ...userRow, organization_id: 'other-org', organizations: { org_name: 'Other Org' } }
    resolves(match('u1'), none)
    const { lookupIdentity } = await import('./lookup')
    const result: any = await lookupIdentity({ actorId: 'admin', organizationId: ORG, email: 'a@x.test' })
    expect(result).toMatchObject({ status: 'account_exists', openUserId: null, name: null, organizationName: null })
    expect(JSON.stringify(result)).not.toContain('Aisyah')
  })

  it('respects HR permissions: an administrator without hr.employee.manage only learns that an account exists', async () => {
    resolves(match('u1'), none)
    preview.mockResolvedValue({ ok: false, code: 'FORBIDDEN', status: 403, message: 'no' })
    const { lookupIdentity } = await import('./lookup')
    expect(await lookupIdentity({ actorId: 'admin', organizationId: ORG, email: 'a@x.test' })).toMatchObject({ status: 'account_exists', openUserId: 'u1' })
  })

  it('explains an ineligible employee (ended employment, yourself) instead of offering a link', async () => {
    resolves(match('u1'), none)
    preview.mockResolvedValue(candidate({ eligible: false, block_code: 'EMPLOYMENT_ENDED' }))
    const { lookupIdentity } = await import('./lookup')
    expect(await lookupIdentity({ actorId: 'admin', organizationId: ORG, email: 'a@x.test' })).toMatchObject({ status: 'account_exists', message: 'Employment ended.' })
  })
})
