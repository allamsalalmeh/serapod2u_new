import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createWorld, fakeClient, ORG, USER, type FakeWorld } from './test-world'
import type { MigrationMode } from './types'

let world: FakeWorld
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => fakeClient(world) }))
vi.mock('@/lib/server/permissions', () => ({ checkPermissionForUser: async () => ({ allowed: false }) }))

const authorization = await import('./authorization')
const { authorize } = authorization
// Present once the navigation-snapshot change is in the tree.
const explainMany = (authorization as Record<string, unknown>).explainMany as
  | ((actorId: string, items: Array<{ permission: string; resource: any; legacy?: () => boolean }>) => Promise<string[]>)
  | undefined
const { loadRootAccess, rootAccessCapability, withRootAccess } = await import('./root-access')
const { ROOT_ACCESS_CONFIRMATION, ROOT_ACCESS_REFUSALS, rootAccessCurrent, rootRefusal } = await import('./root-access-shared')
const { reasonLabel } = await import('./labels')

const MODES: MigrationMode[] = ['LEGACY_ENFORCED', 'SHADOW', 'NEW_ENFORCED', 'LEGACY_RETIRED']
const PERMISSION = 'finance.payment.approve'
const rootDecision = { decision: 'ALLOW', reason_code: 'ALLOWED_BY_ROOT_ACCESS', matched_assignments: [{ rootAccessGrantId: 'g1', effectiveUntil: null }], resolved_scopes: [{ scopeType: 'global', scopeValue: '*', matched: true }] }

beforeEach(() => { world = createWorld() })

describe('Root Access through the central authorization path', () => {
  // The evaluator answers ALLOWED_BY_ROOT_ACCESS; the legacy rule says no. Only the modes where S&A is authoritative
  // may follow the Root decision: Root Access never widens a legacy-mode (LEGACY_ENFORCED / SHADOW) answer.
  for (const mode of MODES) {
    const authoritative = mode === 'NEW_ENFORCED' || mode === 'LEGACY_RETIRED'
    it(`${mode}: ${authoritative ? 'Root Access decides' : 'legacy keeps deciding (no escalation)'}`, async () => {
      world.modes[PERMISSION] = mode
      world.rpc.sa_evaluate_permission = () => ({ data: rootDecision, error: null })
      const decision = await authorize({ actorId: USER.user, permission: PERMISSION, resource: { type: 'payment', organizationId: ORG.distA } }, { legacy: () => false })
      expect(decision.decision).toBe(authoritative ? 'ALLOW' : 'DENY')
      expect(decision.reasonCode).toBe(authoritative ? 'ALLOWED_BY_ROOT_ACCESS' : 'LEGACY_DENIED')
      expect(decision.newReasonCode).toBe('ALLOWED_BY_ROOT_ACCESS')
      // Audited like any other decision, with the Root grant as the matched "assignment".
      expect(world.decisions.at(-1)).toMatchObject({ decision: decision.decision, reason_code: decision.reasonCode, new_decision: 'ALLOW' })
      expect(world.decisions.at(-1)!.matched_assignments).toEqual(rootDecision.matched_assignments)
    })
  }

  it('revocation/expiry is immediate: the next decision follows the evaluator, nothing is cached', async () => {
    world.modes[PERMISSION] = 'LEGACY_RETIRED'
    world.rpc.sa_evaluate_permission = () => ({ data: rootDecision, error: null })
    const req = { actorId: USER.user, permission: PERMISSION, resource: { type: 'payment', organizationId: ORG.hqA } }
    expect((await authorize(req)).decision).toBe('ALLOW')
    world.rpc.sa_evaluate_permission = () => ({ data: { decision: 'DENY', reason_code: 'MISSING_ASSIGNMENT', matched_assignments: [], resolved_scopes: [] }, error: null })
    expect((await authorize(req)).decision).toBe('DENY')
  })

  // explainMany ships with the navigation-snapshot change; where it exists it must follow the same rule.
  it.runIf(typeof explainMany === 'function')('navigation snapshots (explainMany) honour Root Access the same way', async () => {
    world.modes[PERMISSION] = 'LEGACY_RETIRED'
    world.modes['hr.employee.view'] = 'SHADOW'
    world.rpc.sa_evaluate_permission = () => ({ data: rootDecision, error: null })
    const answers = await explainMany!(USER.user, [
      { permission: PERMISSION, resource: { type: 'nav', organizationId: ORG.hqA } },
      { permission: 'hr.employee.view', resource: { type: 'nav', organizationId: ORG.hqA }, legacy: () => false },
    ])
    expect(answers).toEqual(['ALLOW', 'DENY'])
  })

  it('an inactive account is denied before any Root decision', async () => {
    world.modes[PERMISSION] = 'LEGACY_RETIRED'
    world.rpc.sa_evaluate_permission = () => ({ data: rootDecision, error: null })
    const decision = await authorize({ actorId: USER.inactive, permission: PERMISSION, resource: { type: 'payment', organizationId: ORG.hqA } })
    expect(decision).toMatchObject({ decision: 'DENY', reasonCode: 'ACCOUNT_INACTIVE' })
  })

  it('explains the reason code', () => {
    expect(reasonLabel('ALLOWED_BY_ROOT_ACCESS')).toMatch(/Root Access/)
  })
})

describe('Root Access status read model', () => {
  const NOW = new Date('2026-10-08T12:00:00Z')
  const client = (rows: any[] | null, error: any = null) => {
    const calls: any[] = []
    const builder: any = {
      select: (s: string) => { calls.push(['select', s]); return builder },
      in: (c: string, v: any) => { calls.push(['in', c, v]); return builder },
      eq: (c: string, v: any) => { calls.push(['eq', c, v]); return Promise.resolve({ data: rows, error }) },
    }
    return { calls, from: (t: string) => { calls.push(['from', t]); return builder } }
  }

  it('returns active, unexpired grants only, with who granted them', async () => {
    const admin = client([
      { id: 'g1', user_id: 'u1', grant_method: 'grant', granted_at: '2026-10-01T00:00:00Z', effective_until: null, reason: 'Platform owner', granted_by_user: { id: 'a', full_name: 'Ada', email: 'ada@x' } },
      { id: 'g2', user_id: 'u2', grant_method: 'grant', granted_at: '2026-10-01T00:00:00Z', effective_until: '2026-10-08T11:59:00Z', reason: 'Expired one', granted_by_user: null },
      { id: 'g3', user_id: 'u3', grant_method: 'bootstrap', granted_at: '2026-10-01T00:00:00Z', effective_until: '2026-10-09T00:00:00Z', reason: 'Bootstrap', granted_by_user: null },
    ])
    const { available, byUser } = await loadRootAccess(admin, ['u1', 'u2', 'u3'], NOW)
    expect(available).toBe(true)
    expect([...byUser.keys()]).toEqual(['u1', 'u3'])
    expect(byUser.get('u1')).toMatchObject({ grantId: 'g1', method: 'grant', grantedBy: { id: 'a', name: 'Ada', email: 'ada@x' }, effectiveUntil: null })
    expect(byUser.get('u3')).toMatchObject({ method: 'bootstrap', grantedBy: null })
    expect(admin.calls).toContainEqual(['eq', 'status', 'active'])
    expect(withRootAccess([{ id: 'u1' }, { id: 'u2' }], byUser).map(p => !!p.root_access)).toEqual([true, false])
  })

  it('fails soft: a missing migration or failed read shows no Root status (never breaks the directory)', async () => {
    expect((await loadRootAccess(client(null, { code: '42P01' }), ['u1'])).available).toBe(false)
    const throwing = { from: () => { throw new Error('boom') } }
    expect((await loadRootAccess(throwing, ['u1'])).available).toBe(false)
    expect((await loadRootAccess(client([]), [])).available).toBe(true)
  })

  it('reports the viewer capability from the database, unavailable on error', async () => {
    const ok = { rpc: async (fn: string) => ({ data: fn === 'sa_actor_is_root' ? true : 2, error: null }) }
    expect(await rootAccessCapability(ok, 'v')).toEqual({ available: true, viewerIsRoot: true, activeCount: 2 })
    const missing = { rpc: async () => ({ data: null, error: { code: 'PGRST202' } }) }
    expect(await rootAccessCapability(missing, 'v')).toEqual({ available: false, viewerIsRoot: false, activeCount: null })
  })

  it('maps every database refusal to a safe message and status', () => {
    for (const code of ['root_authority_required', 'root_self_grant_prohibited', 'root_self_revoke_prohibited', 'root_last_administrator',
      'root_target_not_internal', 'root_already_active', 'root_reason_required', 'root_expiry_invalid']) {
      expect(ROOT_ACCESS_REFUSALS[code], code).toBeTruthy()
    }
    expect(rootRefusal('root_authority_required').status).toBe(403)
    expect(rootRefusal('root_last_administrator').status).toBe(409)
    expect(rootRefusal('something_else')).toEqual({ status: 400, message: 'Root Access could not be changed.' })
    expect(rootAccessCurrent({ effectiveUntil: null })).toBe(true)
    expect(rootAccessCurrent({ effectiveUntil: '2000-01-01T00:00:00Z' })).toBe(false)
    expect(ROOT_ACCESS_CONFIRMATION).toBe('GRANT ROOT ACCESS')
  })
})

// Lock-step guard on the migration's security properties (the behaviour itself is proven by
// supabase/tests/security/sa_root_access/run.sh against the real S&A functions).
describe('20261026100000_sa_root_access.sql', () => {
  const sql = readFileSync(path.resolve(__dirname, '../../../../supabase/migrations/20261026100000_sa_root_access.sql'), 'utf8')
  const code = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n')

  it('keeps Root Access writes out of every API role', () => {
    expect(code).toMatch(/revoke all on table public\.sa_root_access_grants from public, anon, authenticated, service_role;/)
    expect(code).toMatch(/grant select on table public\.sa_root_access_grants to service_role;/)
    expect(code).not.toMatch(/grant (insert|update|delete|all)[^;]*sa_root_access_grants/i)
    expect(code).toMatch(/revoke all on function public\.sa_bootstrap_root_access\(uuid,text\) from public, anon, authenticated, service_role;/)
    expect(code).not.toMatch(/grant execute on function public\.sa_bootstrap_root_access/)
    expect(code).not.toMatch(/to authenticated|to anon/)
  })

  it('takes authority only from active Root Access (never legacy level 1) and forbids self-changes', () => {
    const grant = code.slice(code.indexOf('function public.sa_grant_root_access'), code.indexOf('function public.sa_revoke_root_access'))
    expect(grant).toMatch(/when not public\.sa_actor_is_root\(p_actor\) then 'root_authority_required'/)
    expect(grant).toMatch(/when p_actor = p_target then 'root_self_grant_prohibited'/)
    expect(grant).not.toMatch(/if public\.sa_legacy_is_super_admin/)
    const revoke = code.slice(code.indexOf('function public.sa_revoke_root_access'), code.indexOf('function public.sa_bootstrap_root_access'))
    expect(revoke).toMatch(/root_self_revoke_prohibited/)
    expect(revoke).toMatch(/sa_active_root_count\(p_target\) < 1 then 'root_last_administrator'/)
    for (const body of [grant, revoke]) expect(body).toMatch(/pg_advisory_xact_lock\(hashtextextended\('sa_root_access', 0\)\)/)
  })

  it('evaluator: Root covers only active catalogue permissions and real organizations', () => {
    const core = code.slice(code.indexOf('function public.sa_evaluate_permission_core'), code.indexOf('function public.sa_actor_holds_permission'))
    expect(core).toMatch(/p\.permission_key = p_permission and p\.status = 'active'/)
    expect(core).toMatch(/v_org is null or exists \(select 1 from public\.organizations o where o\.id = v_org\)/)
    expect(core).toMatch(/'ALLOWED_BY_ROOT_ACCESS'/)
    // Mode-awareness lives outside the evaluator and is untouched.
    expect(code).not.toMatch(/function public\.sa_is_new_authoritative|function public\.sa_rls_gate|function public\.sa_require_operation|update public\.sa_migration_modes/)
  })

  it('converts nobody automatically and changes no mode', () => {
    expect(code).not.toMatch(/insert into public\.sa_root_access_grants[\s\S]{0,200}select/i)
    expect(code).not.toMatch(/role_level\s*=\s*1/)
  })
})
