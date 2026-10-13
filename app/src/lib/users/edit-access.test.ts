import { describe, expect, it, vi } from 'vitest'
import {
  applyPlan, classifyAccess, classifyAssignment, computePlan, initialItems, moverImpact, normalizeSnapshot, offeredProfiles, summarizeOutcome,
  type AccessOptions, type SnapshotAssignment,
} from './edit-access'

const FUTURE = new Date(Date.now() + 7 * 864e5).toISOString()
const PAST = new Date(Date.now() - 864e5).toISOString()

const assignment = (over: Partial<SnapshotAssignment> & { id: string }): SnapshotAssignment => ({
  status: 'active', source: 'manual', effectiveFrom: null, effectiveUntil: null, reason: null, roleId: `role-${over.id}`, roleKey: `key-${over.id}`, roleName: `Policy ${over.id}`,
  roleSource: 'template', scopes: [{ id: 'sc-hq', scopeType: 'organization', scopeValue: 'org-hq', name: 'HQ' }], membershipId: 'm-hq', organizationId: 'org-hq', organizationName: 'HQ',
  membershipSource: 'derived', membershipStatus: 'active', ...over,
})
const options: AccessOptions = {
  profiles: [{ id: 'role-a', name: 'Policy a' }, { id: 'role-b', name: 'Policy b' }, { id: 'role-c', name: 'Policy c' }, { id: 'role-t', name: 'Temp' }],
  scopes: [
    { id: 'sc-hq', organization_id: 'org-hq', scope_type: 'organization', display_name: 'HQ' },
    { id: 'sc-wh', organization_id: 'wh-1', scope_type: 'organization', display_name: 'Warehouse 1' },
  ],
}
const snapshot = (assignments: SnapshotAssignment[]) => ({
  assignments,
  memberships: [
    { id: 'm-hq', organizationId: 'org-hq', organizationName: 'HQ', status: 'active', isPrimary: true, source: 'derived', grantable: true, blockedReason: null },
    { id: 'm-x', organizationId: 'org-x', organizationName: 'Other Org', status: 'active', isPrimary: false, source: 'manual', grantable: true, blockedReason: null },
  ],
})

describe('classifyAssignment', () => {
  it('separates explicit, managed (incl. ESS), legacy-migration and historical grants', () => {
    expect(classifyAssignment(assignment({ id: 'a' }))).toBe('explicit')
    expect(classifyAssignment(assignment({ id: 'a', source: 'access_request' }))).toBe('explicit')
    expect(classifyAssignment(assignment({ id: 'e', source: 'derived', roleKey: 'employee-self-service' }))).toBe('managed')
    expect(classifyAssignment(assignment({ id: 'e', source: 'manual', roleKey: 'employee-self-service' }))).toBe('managed')
    expect(classifyAssignment(assignment({ id: 'b', source: 'backfill' }))).toBe('managed')
    expect(classifyAssignment(assignment({ id: 'l', roleSource: 'legacy', source: 'backfill' }))).toBe('legacy')
    expect(classifyAssignment(assignment({ id: 'l', roleKey: 'legacy-hq' }))).toBe('legacy')
    expect(classifyAssignment(assignment({ id: 'r', status: 'revoked' }))).toBe('historical')
    expect(classifyAssignment(assignment({ id: 'r', status: 'suspended' }))).toBe('historical')
    expect(classifyAssignment(assignment({ id: 'x', effectiveUntil: PAST }))).toBe('historical')
    expect(classifyAssignment(assignment({ id: 'x', effectiveUntil: FUTURE }))).toBe('explicit')
  })
})

describe('normalizeSnapshot', () => {
  it('reads the People & Access shape (arrays or objects, nested scopes)', () => {
    const snap = normalizeSnapshot({ membership: [{ id: 'm1', organization_id: 'o1', status: 'active', is_primary: true, source: 'derived', grantable: false, grant_blocked_reason: 'x',
      organization: [{ org_name: 'HQ' }], assignments: [{ id: 'a1', status: 'active', source: 'manual', effective_until: null, role: [{ id: 'r1', role_key: 'k', name: 'N', source: 'template' }],
        scopes: [{ scope: [{ id: 's1', scope_type: 'organization', scope_value: 'o1', display_name: 'HQ' }] }] }] }] })
    expect(snap.memberships[0]).toMatchObject({ organizationId: 'o1', organizationName: 'HQ', source: 'derived', grantable: false })
    expect(snap.assignments[0]).toMatchObject({ id: 'a1', roleId: 'r1', roleName: 'N', scopes: [{ id: 's1', name: 'HQ' }], organizationName: 'HQ' })
  })
})

describe('classifyAccess', () => {
  const base = [
    assignment({ id: 'a' }),
    assignment({ id: 'ess', source: 'derived', roleKey: 'employee-self-service', roleId: 'role-ess' }),
    assignment({ id: 'leg', roleSource: 'legacy', source: 'backfill', roleId: 'role-leg' }),
    assignment({ id: 'other', organizationId: 'org-x', membershipId: 'm-x', organizationName: 'Other Org' }),
    assignment({ id: 'hidden', roleId: 'role-not-offered' }),
    assignment({ id: 'badscope', roleId: 'role-b', scopes: [{ id: 'sc-gone', scopeType: 'organization', scopeValue: 'z', name: 'Gone' }] }),
    assignment({ id: 'old', status: 'revoked' }),
  ]
  const access = classifyAccess(snapshot(base), 'org-hq', options)
  it('only explicit, offered, in-scope grants in the current organization are manageable', () => {
    expect(access.manageable.map(g => g.assignment.id)).toEqual(['a'])
    expect(Object.fromEntries(access.held.map(h => [h.assignment.id, h.reason ?? h.kind]))).toEqual({
      ess: 'managed', leg: 'legacy', other: 'other_organization', hidden: 'policy_not_offered', badscope: 'scope_not_available',
    })
    expect(access.historical.map(a => a.id)).toEqual(['old'])
  })
  it('does not offer a policy again that is already held here, but keeps the manageable one selectable', () => {
    expect(offeredProfiles(access, options).map(p => p.id)).toEqual(['role-a', 'role-c', 'role-t'])
    const withManagedB = classifyAccess(snapshot([assignment({ id: 'b', source: 'backfill' }), assignment({ id: 'a' })]), 'org-hq', options)
    expect(offeredProfiles(withManagedB, options).map(p => p.id)).toEqual(['role-a', 'role-c', 'role-t'])
  })
  it('a membership the administrator cannot grant in keeps every explicit grant read-only', () => {
    const snap = snapshot([assignment({ id: 'a' })]); snap.memberships[0].grantable = false
    const a = classifyAccess(snap, 'org-hq', options)
    expect(a.manageable).toEqual([]); expect(a.held[0].reason).toBe('membership_not_grantable')
  })
  it('an existing grant of a policy no longer eligible for the organization type is flagged for review, never removed or offered', () => {
    const withIneligible: AccessOptions = { ...options, ineligibleProfiles: [{ id: 'role-gl', name: 'GL Clerk', message: 'This Group Policy is not available for Shop accounts.' }] }
    const a = classifyAccess(snapshot([assignment({ id: 'gl', roleId: 'role-gl' }), assignment({ id: 'a' })]), 'org-hq', withIneligible)
    expect(a.held.find(h => h.assignment.id === 'gl')?.reason).toBe('not_eligible')
    expect(a.manageable.map(g => g.assignment.id)).toEqual(['a'])
    // The picker starts from manageable grants only, so saving never revokes the ineligible grant.
    expect(initialItems(a).map(i => i.roleId)).toEqual(['role-a'])
    expect(computePlan(a, initialItems(a)).ops).toEqual([])
    expect(offeredProfiles(a, withIneligible).map(p => p.id)).not.toContain('role-gl')
  })
})

describe('computePlan', () => {
  const access = classifyAccess(snapshot([
    assignment({ id: 'a' }), assignment({ id: 't', roleId: 'role-t', effectiveUntil: FUTURE }),
    assignment({ id: 'ess', source: 'derived', roleKey: 'employee-self-service', roleId: 'role-ess' }),
    assignment({ id: 'leg', roleSource: 'legacy', source: 'backfill', roleId: 'role-leg' }),
  ]), 'org-hq', options)

  it('an unchanged save produces no access change at all', () => {
    expect(computePlan(access, initialItems(access)).empty).toBe(true)
  })
  it('unticking removes only the explicit grant; managed ESS, legacy and temporary validity elsewhere are untouched', () => {
    const plan = computePlan(access, initialItems(access).filter(i => i.roleId !== 'role-a'))
    expect(plan.removes.map(r => r.assignment.id)).toEqual(['a'])
    expect(plan.adds).toEqual([]); expect(plan.scopeChanges).toEqual([])
  })
  it('a newly ticked policy is an addition with its explicit scope', () => {
    const plan = computePlan(access, [...initialItems(access), { roleId: 'role-b', scopeId: 'sc-hq' }])
    expect(plan.adds).toEqual([{ kind: 'add', roleId: 'role-b', scopeIds: ['sc-hq'] }])
    expect(plan.removes).toEqual([])
  })
  it('a different scope set is a scope change carrying the original assignment (and so its validity)', () => {
    const items = initialItems(access).map(i => (i.roleId === 'role-t' ? { ...i, scopeId: 'sc-wh' } : i))
    const plan = computePlan(access, items)
    expect(plan.scopeChanges).toHaveLength(1)
    expect(plan.scopeChanges[0]).toMatchObject({ from: ['sc-hq'], to: ['sc-wh'], assignment: { id: 't', effectiveUntil: FUTURE } })
    expect(plan.adds).toEqual([]); expect(plan.removes).toEqual([])
  })
  it('a policy without a chosen scope makes the plan incomplete, never a broader grant', () => {
    const plan = computePlan(access, [...initialItems(access), { roleId: 'role-b', scopeId: '' }])
    expect(plan.incomplete).toMatch(/scope/i); expect(plan.adds).toEqual([])
  })
})

describe('moverImpact', () => {
  it('lists the active grants on derived memberships left behind by an organization change', () => {
    const snap = snapshot([assignment({ id: 'a' }), assignment({ id: 'old', status: 'revoked' }), assignment({ id: 'm', organizationId: 'org-x', membershipId: 'm-x' })])
    const impact = moverImpact(snap, 'org-new')
    expect(impact.memberships).toEqual(['HQ'])
    expect(impact.assignments.map(a => a.id)).toEqual(['a'])
    expect(moverImpact(snap, 'org-hq').assignments).toEqual([])
    expect(moverImpact(snap, null).assignments).toEqual([])
  })
})

describe('applyPlan', () => {
  const access = classifyAccess(snapshot([assignment({ id: 'a' }), assignment({ id: 't', roleId: 'role-t', effectiveUntil: FUTURE })]), 'org-hq', options)
  const input = { userId: 'u1', organizationId: 'org-hq', reason: 'Access review' }
  const ok = { ok: true, data: {} }

  it('uses the shared assignments endpoint with the reason, and preserves validity on a scope change', async () => {
    const calls: any[] = []
    const call = vi.fn(async (_u: string, init: any) => { calls.push(init.body); return ok })
    const plan = computePlan(access, [{ roleId: 'role-t', scopeId: 'sc-wh' }, { roleId: 'role-b', scopeId: 'sc-hq' }])
    const out = await applyPlan(plan, input, call)
    expect(out.allApplied).toBe(true)
    expect(call.mock.calls.every(c => c[0] === '/api/security-access/assignments')).toBe(true)
    expect(calls).toEqual([
      { action: 'revoke', assignmentId: 't', reason: 'Access review' },
      { action: 'grant', userId: 'u1', roleId: 'role-t', organizationId: 'org-hq', scopeIds: ['sc-wh'], effectiveUntil: FUTURE, reason: 'Access review' },
      { action: 'revoke', assignmentId: 'a', reason: 'Access review' },
      { action: 'grant', userId: 'u1', roleId: 'role-b', organizationId: 'org-hq', scopeIds: ['sc-hq'], effectiveUntil: null, reason: 'Access review' },
    ])
  })

  it('never reports full success when only part succeeds', async () => {
    const call = vi.fn(async (_u: string, init: any) => init.body.action === 'grant' ? { ok: false, error: 'This conflicts with a segregation-of-duties rule.' } : ok)
    const plan = computePlan(access, [{ roleId: 'role-a', scopeId: 'sc-hq' }, { roleId: 'role-b', scopeId: 'sc-hq' }])
    const out = await applyPlan(plan, { ...input, names: id => (id === 'role-b' ? 'Policy b' : 'x') }, call)
    expect(out.allApplied).toBe(false); expect(out.applied).toBe(1); expect(out.failed).toBe(1)
    expect(out.message).toMatch(/1 of 2/); expect(out.message).toMatch(/could not add Policy b/); expect(out.message).toMatch(/segregation/)
  })

  it('restores the previous grant when the new scope is refused, and says so', async () => {
    let grants = 0
    const call = vi.fn(async (_u: string, init: any) => {
      if (init.body.action === 'grant') { grants += 1; return grants === 1 ? { ok: false, error: 'Scope refused' } : ok }
      return ok
    })
    const plan = computePlan(access, [{ roleId: 'role-a', scopeId: 'sc-wh' }, { roleId: 'role-t', scopeId: 'sc-hq' }])
    const out = await applyPlan(plan, input, call)
    expect(out.results[0]).toMatchObject({ ok: false, restored: true })
    expect(out.message).toMatch(/previous grant is still in place/)
    expect(call.mock.calls.filter(c => (c[1] as any).body.action === 'grant')[1][1]).toMatchObject({ body: { scopeIds: ['sc-hq'] } })
  })

  it('reports an unrecoverable scope change plainly', () => {
    const op = computePlan(access, [{ roleId: 'role-a', scopeId: 'sc-wh' }, { roleId: 'role-t', scopeId: 'sc-hq' }]).scopeChanges[0]
    expect(summarizeOutcome([{ op, ok: false, error: 'No', restored: false }], 0, 1)).toMatch(/could not be restored/)
    expect(summarizeOutcome([{ op, ok: false, error: 'No', restored: null }], 0, 1)).toMatch(/nothing changed/)
  })

  it('does nothing for an empty plan', async () => {
    const call = vi.fn()
    const out = await applyPlan(computePlan(access, initialItems(access)), input, call)
    expect(call).not.toHaveBeenCalled(); expect(out.message).toBe('No Group Policy changes.')
  })
})
