import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorld, fakeClient, legacyPermission, ORG, USER, type FakeWorld } from './test-world'

let world: FakeWorld
let session: { user: { id: string } | null; error: any } = { user: null, error: null }

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => fakeClient(world) }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: session.user }, error: session.error }) } }) }))
vi.mock('@/lib/server/permissions', () => ({ checkPermissionForUser: async (userId: string, key: string) => legacyPermission(userId, key) }))
vi.mock('./delegation', () => ({ legacyOrDelegatedSecurityAccess: async () => false }))

const { requireSecurityActor, actorAlsoHolds } = await import('./admin-api')
const { NextResponse } = await import('next/server')

const PERM = 'inventory.stock_count.verify'
const status = (r: any) => (r instanceof NextResponse ? r.status : 200)

beforeEach(() => {
  world = createWorld()
  world.modes[PERM] = 'LEGACY_RETIRED'
  // An organization-wide assignment of the fixture's permission for the "sa" actor in HQ A.
  world.rpc.sa_evaluate_permission = ({ p_actor }: any) => ({
    data: { decision: p_actor === USER.sa ? 'ALLOW' : 'DENY', reason_code: p_actor === USER.sa ? 'ALLOWED_BY_ASSIGNMENT' : 'MISSING_PERMISSION', matched_assignments: [], resolved_scopes: [] },
    error: null,
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})

describe('requireSecurityActor keeps unauthenticated, denied and unavailable distinct', () => {
  it('no session → 401', async () => {
    session = { user: null, error: { name: 'AuthSessionMissingError', status: 400 } }
    expect(status(await requireSecurityActor(PERM))).toBe(401)
  })

  it('auth service unreachable → 503, not "signed out"', async () => {
    session = { user: null, error: { name: 'AuthRetryableFetchError', status: 0 } }
    const r: any = await requireSecurityActor(PERM)
    expect(r.status).toBe(503)
    expect((await r.json()).code).toBe('sa_unavailable')
  })

  it('authorized actor → actor with a correlation id; the audit row carries it', async () => {
    session = { user: { id: USER.sa }, error: null }
    const actor: any = await requireSecurityActor(PERM)
    expect(actor.userId).toBe(USER.sa)
    expect(actor.organizationId).toBe(ORG.hqA)
    expect(world.decisions.at(-1)?.correlation_id).toBe(actor.trace.id)
  })

  it('recorded policy denial → 403 with a stable reason', async () => {
    session = { user: { id: USER.user }, error: null }
    const r: any = await requireSecurityActor(PERM)
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ code: 'sa_forbidden', reason: 'MISSING_PERMISSION' })
  })

  it('inactive account → 403', async () => {
    session = { user: { id: USER.inactive }, error: null }
    expect(status(await requireSecurityActor(PERM))).toBe(403)
  })

  it('actor lookup failure → 503 (fail closed, not a denial)', async () => {
    session = { user: { id: USER.sa }, error: null }
    world.failAccountLookup = true
    expect(status(await requireSecurityActor(PERM))).toBe(503)
  })

  it('enforced ALLOW whose audit write fails → 503, never 200 and never 403', async () => {
    session = { user: { id: USER.sa }, error: null }
    world.failDecisionInsert = true
    world.decisionInsertError = { code: '', message: 'AbortError: The operation was aborted due to timeout' }
    const r: any = await requireSecurityActor(PERM)
    expect(r.status).toBe(503)
    expect((await r.json()).reason).toBe('audit_write_failed')
  })

  it('evaluator failure → 503', async () => {
    session = { user: { id: USER.sa }, error: null }
    world.rpc.sa_evaluate_permission = () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })
    expect(status(await requireSecurityActor(PERM))).toBe(503)
  })
})

describe('actorAlsoHolds shapes read models without writing audit rows', () => {
  it('is explain-only', async () => {
    session = { user: { id: USER.sa }, error: null }
    const actor: any = await requireSecurityActor(PERM)
    const before = world.decisions.length
    expect(await actorAlsoHolds(actor, PERM)).toBe(true)
    expect(world.decisions.length).toBe(before)
  })
})
