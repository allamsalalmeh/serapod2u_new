import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticated: true,
  requesterOrgId: 'mfg-1',
  requesterOrgType: 'MFG',
  requesterRoleLevel: 30,
  order: {
    id: 'order-1',
    company_id: 'company-1',
    buyer_org_id: 'hq-1',
    seller_org_id: 'mfg-1',
    warehouse_org_id: null,
  } as any,
}))

function query(result: () => any) {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    single: async () => result(),
    maybeSingle: async () => result(),
  }
  return builder
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => mocks.authenticated
        ? { data: { user: { id: 'requester-1' } }, error: null }
        : { data: { user: null }, error: new Error('not authenticated') },
    },
    from: (table: string) => query(() => table === 'users'
      ? {
          data: {
            organization_id: mocks.requesterOrgId,
            organizations: { org_type_code: mocks.requesterOrgType },
            roles: { role_level: mocks.requesterRoleLevel },
          },
          error: null,
        }
      : { data: mocks.order, error: null }),
  }),
}))

// S&A decision (supply_chain.order.view). Default: a legacy migration mode, where the route's own legacy rule
// (role level <= 40) decides — the state staging runs in today.
const authorize = vi.hoisted(() => ({ mode: 'legacy' as 'legacy' | 'deny' | 'unavailable', calls: [] as any[] }))
vi.mock('@/lib/security-access/operation', () => ({
  organizationResource: (type: string, organizationId: string, extra: object) => ({ type, organizationId, ...extra }),
  authorizeOperation: async (input: { permission: string; resource: any; legacy: () => boolean | Promise<boolean> }) => {
    authorize.calls.push(input)
    if (authorize.mode === 'unavailable') return { decision: 'DENY', unavailable: true }
    if (authorize.mode === 'deny') return { decision: 'DENY' }
    return { decision: (await input.legacy()) ? 'ALLOW' : 'DENY' }
  },
}))

import { GET } from './route'

const request = () => new Request('http://localhost/api/orders/order-1/access') as any
const context = () => ({ params: Promise.resolve({ orderId: 'order-1' }) })

describe('order detail access', () => {
  beforeEach(() => {
    authorize.mode = 'legacy'
    authorize.calls.length = 0
    mocks.authenticated = true
    mocks.requesterOrgId = 'mfg-1'
    mocks.requesterOrgType = 'MFG'
    mocks.requesterRoleLevel = 30
    mocks.order = {
      id: 'order-1',
      company_id: 'company-1',
      buyer_org_id: 'hq-1',
      seller_org_id: 'mfg-1',
      warehouse_org_id: null,
    }
  })

  it('allows a Manufacturer user to view its own organization order', async () => {
    const response = await GET(request(), context())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, order_id: 'order-1' })
  })

  it('returns 403 when a Manufacturer requests another manufacturer order', async () => {
    mocks.order.seller_org_id = 'mfg-2'
    const response = await GET(request(), context())
    expect(response.status).toBe(403)
  })

  it('returns 403 when RLS does not expose the requested order', async () => {
    mocks.order = null
    const response = await GET(request(), context())
    expect(response.status).toBe(403)
  })

  it('retains authorized order visibility for HQ Admin level 10', async () => {
    mocks.requesterOrgType = 'HQ'
    mocks.requesterRoleLevel = 10
    mocks.order.seller_org_id = 'mfg-2'
    const response = await GET(request(), context())
    expect(response.status).toBe(200)
  })

  it('asks S&A for supply_chain.order.view on the order\'s own parties', async () => {
    await GET(request(), context())
    expect(authorize.calls[0].permission).toBe('supply_chain.order.view')
    // Non-H2M: the seller (approval organization) is asked first; the company is never a party.
    expect(authorize.calls[0].resource.organizationId).toBe('mfg-1')
    expect(authorize.calls.map(c => c.resource.organizationId)).not.toContain('company-1')
    expect(authorize.calls.every(c => c.resource.id === 'order-1')).toBe(true)
  })

  it('returns 403 when S&A denies View Orders', async () => {
    authorize.mode = 'deny'
    const response = await GET(request(), context())
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe('sa_forbidden')
  })

  it('returns 503 (never an implicit allow) when S&A is unavailable', async () => {
    authorize.mode = 'unavailable'
    const response = await GET(request(), context())
    expect(response.status).toBe(503)
  })

  it('denies a legacy role above level 40 in legacy mode', async () => {
    mocks.requesterOrgType = 'HQ'
    mocks.requesterRoleLevel = 50
    const response = await GET(request(), context())
    expect(response.status).toBe(403)
  })

  it('returns 401 for an unauthenticated direct API request', async () => {
    mocks.authenticated = false
    const response = await GET(request(), context())
    expect(response.status).toBe(401)
  })
})
