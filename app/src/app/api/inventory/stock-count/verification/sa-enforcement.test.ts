import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { createWorld, fakeClient, legacyPermission, ORG, USER, type FakeWorld } from '@/lib/security-access/test-world'

/**
 * Stock Count verification through the real S&A enforcement helper.
 * Only Supabase transport, email and the preflight are faked; authorize(),
 * requireAuthorization(), the policy engine and the resource-context
 * resolver run for real against the fixture world.
 */
let world: FakeWorld
let actorId: string
let sessionWarehouse: string
let userRpcCalls: string[]
let emailsSent: number
/** Users whose legacy post_stock_count key is withheld (S&A grants unchanged). */
let legacyPostWithheld: Set<string>

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => fakeClient(world) }))
vi.mock('@/lib/server/permissions', () => ({
  checkPermissionForUser: async (userId: string, key: string) => {
    const legacy = legacyPermission(userId, key)
    return key === 'post_stock_count' && legacyPostWithheld.has(userId) ? { ...legacy, allowed: false } : legacy
  },
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: actorId } } }) },
    from: () => {
      const builder: any = {
        select: () => builder, eq: () => builder,
        maybeSingle: async () => ({ data: { id: 'session-1', status: 'draft', count_type: 'full_count', warehouse_organization_id: sessionWarehouse }, error: null }),
      }
      return builder
    },
    rpc: async (fn: string) => {
      userRpcCalls.push(fn)
      if (fn === 'prepare_stock_count_verification') return { data: { request_id: 'request-1', expires_at: new Date(Date.now() + 900_000).toISOString() }, error: null }
      if (fn === 'verify_and_post_stock_count') return { data: { status: 'posted', session_id: 'session-1' }, error: null }
      return { data: null, error: null }
    },
  }),
}))
vi.mock('@/lib/inventory/stock-count-verification-preflight', () => ({
  createStockCountPreflightDependencies: () => ({}),
  evaluateStockCountPreflight: async (_deps: unknown, userId: string) => {
    const legacy = legacyPermission(userId, 'post_stock_count')
    if (!legacy.allowed || !legacy.context?.organization_id) return { ok: false, code: 'permission_denied' }
    return {
      ok: true, organizationId: legacy.context.organization_id, recipients: ['approver@fixture.test'],
      session: { id: 'session-1', warehouse_organization_id: sessionWarehouse, count_type: 'full_count', status: 'draft' },
      summary: { totalVariantsCounted: 1, varianceItems: 1, netQuantityAdjustment: -1, estimatedAdjustmentValue: -10 },
    }
  },
}))
vi.mock('@/lib/inventory/stock-count-verification-email', () => ({ buildStockCountEmail: () => ({ subject: 's', text: 't', html: 'h' }) }))
vi.mock('@/lib/email/transactional-html-email', () => ({
  sendTransactionalHtmlEmail: async () => { emailsSent += 1; return { success: true } },
}))
vi.mock('@/lib/inventory/stock-count-verification-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/inventory/stock-count-verification-server')>()),
  finalizeStockCountVerificationDelivery: async () => undefined,
}))

process.env.STOCK_COUNT_VERIFICATION_SECRET = 'test-secret'
const requestRoute = await import('./request/route')
const verifyRoute = await import('./verify/route')

const post = (body: unknown) => new NextRequest('http://localhost/api', { method: 'POST', body: JSON.stringify(body) })
const callRequest = () => requestRoute.POST(post({ sessionId: 'session-1' }))
const callVerify = () => verifyRoute.POST(post({ requestId: '00000000-0000-4000-8000-0000000000aa', sessionId: 'session-1', code: '12345678' }))
const verifyRows = () => world.decisions.filter(d => d.permission_key === 'inventory.stock_count.verify')

beforeEach(() => {
  world = createWorld()
  userRpcCalls = []
  emailsSent = 0
  sessionWarehouse = ORG.whA1
  legacyPostWithheld = new Set()
})

describe('verification request (OTP issue) — inventory.stock_count.verify', () => {
  it('SHADOW: legacy ALLOW + new DENY proceeds exactly as before and logs the comparison', async () => {
    actorId = USER.hqB
    const response = await callRequest()
    expect(response.status).toBe(200)
    expect(userRpcCalls).toContain('prepare_stock_count_verification')
    expect(emailsSent).toBe(1)
    expect(verifyRows()).toEqual([expect.objectContaining({
      migration_mode: 'SHADOW', decision: 'ALLOW', legacy_decision: 'ALLOW', new_decision: 'DENY', comparison: 'LEGACY_ALLOW_NEW_DENY', audit_class: 'ORDINARY_SHADOW',
    })])
  })

  it('NEW_ENFORCED: legacy ALLOW + new DENY stops before any mutation', async () => {
    world.modes['inventory.stock_count.verify'] = 'NEW_ENFORCED'
    actorId = USER.hqB
    const response = await callRequest()
    const body = await response.json()
    expect(response.status).toBe(403)
    expect(body.code).toBe('permission_denied')
    expect(body.reference).toBe(verifyRows()[0].id)
    expect(userRpcCalls).toEqual([])
    expect(emailsSent).toBe(0)
  })

  it('NEW_ENFORCED: warehouse-scoped user is denied on another warehouse and allowed on its own', async () => {
    world.modes['inventory.stock_count.verify'] = 'NEW_ENFORCED'
    actorId = USER.wh1
    sessionWarehouse = ORG.whA2
    expect((await callRequest()).status).toBe(403)
    expect(userRpcCalls).toEqual([])
    sessionWarehouse = ORG.whA1
    expect((await callRequest()).status).toBe(200)
    expect(userRpcCalls).toContain('prepare_stock_count_verification')
    expect(verifyRows().at(-1)).toMatchObject({ decision: 'ALLOW', audit_class: 'ENFORCED_DECISION' })
  })

  it('NEW_ENFORCED: inactive account never reaches the mutation', async () => {
    world.modes['inventory.stock_count.verify'] = 'NEW_ENFORCED'
    actorId = USER.inactive
    expect((await callRequest()).status).toBe(403)
    expect(userRpcCalls).toEqual([])
  })
})

describe('verification (OTP consume + atomic post)', () => {
  it('SHADOW: legacy ALLOW + new DENY posts as before; post stays SHADOW diagnostic', async () => {
    actorId = USER.hqB
    const response = await callVerify()
    expect(response.status).toBe(200)
    expect(userRpcCalls).toEqual(['verify_and_post_stock_count'])
    expect(world.decisions.map(d => [d.permission_key, d.migration_mode, d.comparison])).toEqual([
      ['inventory.stock_count.verify', 'SHADOW', 'LEGACY_ALLOW_NEW_DENY'],
      ['inventory.stock_count.post', 'SHADOW', 'LEGACY_ALLOW_NEW_DENY'],
    ])
  })

  it('NEW_ENFORCED: new DENY blocks the verify-and-post RPC entirely', async () => {
    world.modes['inventory.stock_count.verify'] = 'NEW_ENFORCED'
    actorId = USER.hqB
    const response = await callVerify()
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe('permission_denied')
    expect(userRpcCalls).toEqual([])
    expect(world.decisions.filter(d => d.permission_key === 'inventory.stock_count.post')).toHaveLength(0)
  })

  it('NEW_ENFORCED: authorized SA verifies; post remains SHADOW', async () => {
    world.modes['inventory.stock_count.verify'] = 'NEW_ENFORCED'
    actorId = USER.sa
    const response = await callVerify()
    expect(response.status).toBe(200)
    expect(userRpcCalls).toEqual(['verify_and_post_stock_count'])
    expect(world.decisions.map(d => [d.permission_key, d.migration_mode, d.decision])).toEqual([
      ['inventory.stock_count.verify', 'NEW_ENFORCED', 'ALLOW'],
      ['inventory.stock_count.post', 'SHADOW', 'ALLOW'],
    ])
  })

  it('ordinary USER is denied in every mode before the RPC', async () => {
    actorId = USER.user
    for (const mode of ['LEGACY_ENFORCED', 'SHADOW', 'NEW_ENFORCED', 'LEGACY_RETIRED'] as const) {
      world.modes['inventory.stock_count.verify'] = mode
      expect((await callVerify()).status, mode).toBe(403)
    }
    expect(userRpcCalls).toEqual([])
  })
})

describe('verification (OTP consume + atomic post) — inventory.stock_count.post', () => {
  const postRows = () => world.decisions.filter(d => d.permission_key === 'inventory.stock_count.post')
  const enforce = (mode: 'NEW_ENFORCED' | 'LEGACY_RETIRED') => {
    world.modes['inventory.stock_count.verify'] = 'NEW_ENFORCED'
    world.modes['inventory.stock_count.post'] = mode
  }

  it.each(['NEW_ENFORCED', 'LEGACY_RETIRED'] as const)('%s: legacy ALLOW + new DENY (other organization) stops before the posting RPC', async (mode) => {
    enforce(mode)
    world.modes['inventory.stock_count.verify'] = 'SHADOW' // isolate the post decision
    actorId = USER.hqB
    const response = await callVerify()
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.code).toBe('permission_denied')
    expect(body.reference).toBe(postRows()[0].id)
    expect(postRows()[0]).toMatchObject({ migration_mode: mode, decision: 'DENY', new_decision: 'DENY' })
    expect(userRpcCalls).toEqual([])
  })

  it.each(['NEW_ENFORCED', 'LEGACY_RETIRED'] as const)('%s: warehouse-scoped poster is denied on another warehouse and allowed on its own', async (mode) => {
    enforce(mode)
    actorId = USER.wh1
    sessionWarehouse = ORG.whA2
    expect((await callVerify()).status).toBe(403)
    expect(userRpcCalls).toEqual([])
    sessionWarehouse = ORG.whA1
    expect((await callVerify()).status).toBe(200)
    expect(userRpcCalls).toEqual(['verify_and_post_stock_count'])
    expect(postRows().at(-1)).toMatchObject({ migration_mode: mode, decision: 'ALLOW', audit_class: 'ENFORCED_DECISION' })
  })

  it.each(['NEW_ENFORCED', 'LEGACY_RETIRED'] as const)('%s: an S&A grant decides even without the legacy key (legacy no longer decides)', async (mode) => {
    enforce(mode)
    actorId = USER.hq
    legacyPostWithheld.add(USER.hq)
    expect((await callVerify()).status).toBe(200)
    expect(userRpcCalls).toEqual(['verify_and_post_stock_count'])
  })

  it('SHADOW: the legacy key still decides — withheld legacy key is denied even with an S&A grant', async () => {
    world.modes['inventory.stock_count.verify'] = 'NEW_ENFORCED' // verify passes through S&A; post stays SHADOW
    actorId = USER.hq
    legacyPostWithheld.add(USER.hq)
    const response = await callVerify()
    expect(response.status).toBe(403)
    expect(userRpcCalls).toEqual([])
    expect(postRows()[0]).toMatchObject({ migration_mode: 'SHADOW', decision: 'DENY', legacy_decision: 'DENY', new_decision: 'ALLOW' })
  })

  it('a user without any posting authority is denied in every mode', async () => {
    actorId = USER.user
    for (const mode of ['LEGACY_ENFORCED', 'SHADOW', 'NEW_ENFORCED', 'LEGACY_RETIRED'] as const) {
      world.modes['inventory.stock_count.post'] = mode
      expect((await callVerify()).status, mode).toBe(403)
    }
    expect(userRpcCalls).toEqual([])
  })
})

describe('route wiring contract', () => {
  it('both verification routes use the central helper, not an ad-hoc mode check', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    for (const route of ['request/route.ts', 'verify/route.ts']) {
      const source = readFileSync(resolve(__dirname, route), 'utf8')
      expect(source).toContain("permission: 'inventory.stock_count.verify'")
      expect(source).toContain('await requireAuthorization(')
      expect(source).toContain('resolveWarehouseResourceContext(')
      expect(source).not.toMatch(/[=!]==\s*'(NEW_ENFORCED|LEGACY_RETIRED|SHADOW|LEGACY_ENFORCED)'|migrationMode\s*[=!]==/)
    }
    // Posting is enforced (not a SHADOW-only diagnostic) on the verify route.
    const verify = readFileSync(resolve(__dirname, 'verify/route.ts'), 'utf8')
    expect(verify).toMatch(/requireAuthorization\(\{\s*actorId: user\.id,\s*permission: 'inventory\.stock_count\.post'/)
  })
})
