import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

const redirect = vi.fn((to: string) => { throw new Error(`REDIRECT:${to}`) })
let user: any
const resolveDestinationAccess = vi.fn()
vi.mock('next/navigation', () => ({ redirect, useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('next/link', () => ({ default: () => null }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user }, error: user ? null : new Error('none') }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({
      data: { id: 'u-1', organization_id: 'org-hq', role_code: 'GUEST', organizations: { id: 'org-hq', org_type_code: 'HQ' }, roles: { role_name: 'Guest', role_level: 50 } },
      error: null }) }) }) }),
  }),
}))
vi.mock('@/lib/server/nav-access', async () => {
  const { customerGrowthDestinationForView } = await import('@/lib/security-access/nav-access')
  return {
    resolveDestinationAccess: (...args: unknown[]) => resolveDestinationAccess(...args),
    navActorFromProfile: (profile: any) => ({ userId: profile.id }),
    // Same shape as the real guard's first decision (own functions first, the shared catalog last).
    resolveCustomerGrowthLandingAccess: (actor: unknown) => resolveDestinationAccess(actor, ['crm', 'mktg', 'roadtour', 'loyalty', 'ecommerce', 'catalog']),
    resolveChildViewAccess: (_p: unknown, view: string, moduleDestination: string) =>
      resolveDestinationAccess({}, customerGrowthDestinationForView(view, moduleDestination)),
  }
})
vi.mock('@/components/dashboard/DashboardContent', () => ({ default: () => null }))

const person = (allowed: string[], state: 'ok' | 'unavailable' = 'ok') =>
  resolveDestinationAccess.mockImplementation(async (_a: unknown, ids: string | string[]) => {
    if (state === 'unavailable') return { state: 'unavailable' }
    const list = Array.isArray(ids) ? ids : [ids]
    const hit = list.find(id => allowed.includes(id))
    return hit ? { state: 'allowed', destination: hit } : { state: 'denied' }
  })
const props = (el: ReactElement) => (el as any).props

beforeEach(() => { vi.clearAllMocks(); user = { id: 'u-1' } })

describe('Customer & Growth entry', () => {
  it('opens only when at least one child destination is accessible', async () => {
    const { default: Page } = await import('./customer-growth/page')
    person(['catalog'])
    expect(props(await Page()).initialView).toBe('customer-growth')
    person([])
    expect((await Page() as any).props.kind).toBe('denied')
    person([], 'unavailable')
    expect((await Page() as any).props.kind).toBe('unavailable')
  })
  it('asks about every child module, so a parent never opens on its own', async () => {
    person(['crm'])
    const { default: Page } = await import('./customer-growth/page')
    await Page()
    expect(resolveDestinationAccess.mock.calls[0][1]).toEqual(['crm', 'mktg', 'roadtour', 'loyalty', 'ecommerce', 'catalog'])
  })
})

describe('child module entries use the same canonical decision', () => {
  it.each([
    ['./crm/page', 'crm'],
    ['./marketing/page', 'mktg'],
    ['./catalog/page', 'catalog'],
    ['./ecommerce/page', 'ecommerce'],
    ['./loyalty/page', 'loyalty'],
  ])('%s decides destination %s', async (modulePath, destination) => {
    person([])
    const { default: Page } = await import(modulePath)
    expect((await Page() as any).props.kind).toBe('denied')
    expect(resolveDestinationAccess.mock.calls.map(c => c[1])).toContain(destination)
    person([destination])
    expect(props(await Page()).initialView).toBeTruthy()
  })
})

describe('RoadTour', () => {
  it('has a server guard on the landing and every admin sub-page: no permission, no Field campaigns page', async () => {
    person([])
    const { default: Landing } = await import('./roadtour/page')
    expect((await Landing() as any).props.kind).toBe('denied')
    const { RoadtourAdminView } = await import('./roadtour/_RoadtourAdminView')
    expect((await RoadtourAdminView({ view: 'roadtour-campaigns' }) as any).props.kind).toBe('denied')
    expect(resolveDestinationAccess.mock.calls.every(c => c[1] === 'roadtour')).toBe(true)
  })
  it('opens for a person holding a RoadTour permission', async () => {
    person(['roadtour', 'roadtour:campaigns'])
    const { default: Landing } = await import('./roadtour/page')
    expect(props(await Landing()).initialView).toBe('roadtour')
    const { RoadtourAdminView } = await import('./roadtour/_RoadtourAdminView')
    expect(props(await RoadtourAdminView({ view: 'roadtour-campaigns' })).initialView).toBe('roadtour-campaigns')
  })
  it('reports a failed permission check as unavailable', async () => {
    person([], 'unavailable')
    const { default: Landing } = await import('./roadtour/page')
    expect((await Landing() as any).props.kind).toBe('unavailable')
  })
})

describe('deep links need the child permission, not only the module entry', () => {
  it('/crm/support-inbox and /crm/activity are decided with their own destinations', async () => {
    const { default: Page } = await import('./crm/[...slug]/page')
    // Module entry open (e.g. through the legacy HQ rule + one CRM function), but not this child:
    person(['crm'])
    expect((await Page({ params: Promise.resolve({ slug: ['support-inbox'] }) }) as any).props.kind).toBe('denied')
    expect((await Page({ params: Promise.resolve({ slug: ['activity'] }) }) as any).props.kind).toBe('denied')
    person(['crm', 'support-inbox'])
    expect(props(await Page({ params: Promise.resolve({ slug: ['support-inbox'] }) })).initialView).toBe('support-inbox')
    expect((await Page({ params: Promise.resolve({ slug: ['activity'] }) }) as any).props.kind).toBe('denied')
    person(['crm', 'consumer-activations'])
    expect(props(await Page({ params: Promise.resolve({ slug: ['activity'] }) })).initialView).toBe('consumer-activations')
  })
  it('reports a failed check on a deep link as unavailable', async () => {
    const { default: Page } = await import('./crm/[...slug]/page')
    person(['crm'])
    resolveDestinationAccess.mockImplementationOnce(async () => ({ state: 'allowed', destination: 'crm' }))
      .mockImplementationOnce(async () => ({ state: 'unavailable' }))
    expect((await Page({ params: Promise.resolve({ slug: ['support-inbox'] }) }) as any).props.kind).toBe('unavailable')
  })
  it('RoadTour sections are decided with their own destination', async () => {
    const { RoadtourAdminView } = await import('./roadtour/_RoadtourAdminView')
    person(['roadtour', 'roadtour:reporting'])
    expect(props(await RoadtourAdminView({ view: 'roadtour-monthly-overview' })).initialView).toBe('roadtour-monthly-overview')
    expect((await RoadtourAdminView({ view: 'roadtour-kpi-settings' }) as any).props.kind).toBe('denied')
    expect((await RoadtourAdminView({ view: 'roadtour-campaigns' }) as any).props.kind).toBe('denied')
  })
})
