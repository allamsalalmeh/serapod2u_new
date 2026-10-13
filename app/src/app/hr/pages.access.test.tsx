import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

const redirect = vi.fn((to: string) => { throw new Error(`REDIRECT:${to}`) })
let user: any
const resolveDestinationAccess = vi.fn()
const getOwnOnboardingState = vi.fn()
const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

vi.mock('next/navigation', () => ({ redirect, useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('next/link', () => ({ default: () => null }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user }, error: user ? null : new Error('none') }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({
      data: {
        id: 'u-1', organization_id: 'org-hq', role_code: 'GUEST', full_name: 'Supply User',
        organizations: { id: 'org-hq', org_name: 'HQ', org_type_code: 'HQ', org_code: 'HQ' },
        roles: { role_name: 'Guest', role_level: 50 },
      }, error: null }) }) }) }),
  }),
}))
vi.mock('@/lib/server/nav-access', () => ({
  loadNavActor: vi.fn(),
  resolveDestinationAccess: (...args: unknown[]) => resolveDestinationAccess(...args),
  navActorFromProfile: vi.fn(),
}))
vi.mock('@/lib/hr/onboarding', () => ({ getOwnOnboardingState }))
vi.mock('@/components/dashboard/DashboardContent', () => ({ default: () => null }))
vi.mock('@/components/hr/mobile/HrEntryRouter', () => ({ default: () => null }))
vi.mock('@/components/hr/mobile/HrMobileShell', () => ({ default: () => null }))

/** What the canonical evaluation answers per destination for a person (the server's own decisions are tested elsewhere). */
const person = (allowedDestinations: string[], unavailable = false) =>
  resolveDestinationAccess.mockImplementation(async (_actor: unknown, ids: string | string[]) => {
    if (unavailable) return { state: 'unavailable' }
    const list = Array.isArray(ids) ? ids : [ids]
    const hit = list.find(id => allowedDestinations.includes(id))
    return hit ? { state: 'allowed', destination: hit } : { state: 'denied' }
  })

const props = (el: ReactElement) => (el as any).props
const kindOf = (el: ReactElement) => props(props(el).children).kind

beforeEach(() => {
  vi.clearAllMocks()
  user = { id: 'u-1' }
  getOwnOnboardingState.mockResolvedValue('completed')
})

describe('/hr entry', () => {
  it('opens My Workspace for an employee-only user (never the administrative dashboard)', async () => {
    person(['hr/my-workspace'])
    const { default: HrPage } = await import('./page')
    const el = await HrPage()
    expect(props(el).initialView).toBe('hr/my-workspace')
  })

  it('opens the administrative landing for an HR administrator', async () => {
    person(['hr', 'hr/my-workspace'])
    const { default: HrPage } = await import('./page')
    expect(props(await HrPage()).initialView).toBe('hr')
  })

  it('shows the ordinary denial inside the shell, with a way back, and loads no HR view', async () => {
    person([])
    const { default: HrPage } = await import('./page')
    const el = await HrPage()
    expect(props(el).initialView).toBe('dashboard')
    expect(kindOf(el)).toBe('denied')
    expect(props(props(el).children)).toMatchObject({ homeHref: '/dashboard', homeLabel: 'Back to Dashboard' })
  })

  it('reports an unavailable permission check as such, not as a denial', async () => {
    person([], true)
    const { default: HrPage } = await import('./page')
    expect(kindOf(await HrPage())).toBe('unavailable')
  })

  it('an expired login redirects to /login instead of showing a denial', async () => {
    user = null
    person([])
    const { default: HrPage } = await import('./page')
    await expect(HrPage()).rejects.toThrow('REDIRECT:/login')
  })

  it('keeps technical detail out of the page: diagnostics go to the server log only', async () => {
    person([])
    const { default: HrPage } = await import('./page')
    const el = await HrPage()
    expect(JSON.stringify(props(el).children.props)).not.toMatch(/Level|Guest|50|admin/i)
    expect(warn).toHaveBeenCalledWith('[hr-access]', 'denied', expect.objectContaining({ userId: 'u-1' }))
  })
})

describe('administrative HR routes for an ESS-only user (the four screenshot routes and more)', () => {
  it.each([
    ['./people/employees/page', 'hr/people/employees'],
    ['./people/departments/page', 'hr/people/departments'],
    ['./leave/requests/page', 'hr/leave/requests'],
    ['./payroll/payslips/page', 'hr/payroll/payslips'],
    ['./settings/configuration/page', 'hr/settings/configuration'],
    ['./recruitment/jobs/page', 'hr/recruitment/jobs'],
  ])('%s is denied and renders the shared state with a way back to My Workspace', async (modulePath, destination) => {
    person(['hr/my-workspace'])
    // The guard asks for exactly this route's destination, so the ESS permission alone cannot open it.
    resolveDestinationAccess.mockImplementation(async (_a: unknown, ids: string | string[]) => {
      const list = Array.isArray(ids) ? ids : [ids]
      return list.includes('hr/my-workspace') ? { state: 'allowed', destination: 'hr/my-workspace' } : { state: 'denied' }
    })
    const mod = await import(modulePath)
    const el = await mod.default()
    expect(props(el).initialView).toBe('dashboard')
    expect(kindOf(el)).toBe('denied')
    expect(resolveDestinationAccess.mock.calls.some(([, ids]) => ids === destination)).toBe(true)
    expect(props(props(el).children)).toMatchObject({ homeHref: '/hr/my-workspace', homeLabel: 'Back to My Workspace' })
  })

  it('an HR administrator with the matching permission still opens them', async () => {
    person(['hr/people/employees'])
    const { default: Page } = await import('./people/employees/page')
    expect(props(await Page()).initialView).toBe('hr/people/employees')
  })
})

describe('organization chart', () => {
  it('gives staff with the directory permission the limited read-only chart', async () => {
    person(['hr/people/org-chart/staff'])
    const { default: Page } = await import('./people/org-chart/page')
    const el = await Page()
    expect(props(el).initialView).toBe('hr/people/org-chart')
    expect((props(el).children as any).type.name).toBe('HrStaffOrgChartView')
  })
  it('gives HR administrators the administrative chart', async () => {
    person(['hr/people/org-chart', 'hr/people/org-chart/staff'])
    const { default: Page } = await import('./people/org-chart/page')
    const el = await Page()
    expect(props(el).children).toBeUndefined()
  })
  it('denies everyone else', async () => {
    person(['hr/my-workspace'])
    const { default: Page } = await import('./people/org-chart/page')
    expect(kindOf(await Page())).toBe('denied')
  })
})

describe('mobile employee screens layout', () => {
  const layout = async () => (await import('./mobile/layout')).default({ children: null })

  it('is open to Employee Self-Service (not only HR administrators) and passes no legacy-level privileges', async () => {
    person(['hr/my-workspace'])
    const el = await layout()
    expect(props(el)).toMatchObject({ pendingSetup: false, canApproveLeave: false, canAdministerHr: false })
  })
  it('gives manager affordances only from Security & Access decisions', async () => {
    person(['hr/my-workspace', 'hr/leave/requests', 'hr'])
    expect(props(await layout())).toMatchObject({ canApproveLeave: true, canAdministerHr: true })
  })
  it.each(['pending', 'reset', 'none'])('shows the pending setup state when the employee record is %s', async state => {
    person(['hr/my-workspace'])
    getOwnOnboardingState.mockResolvedValue(state)
    expect(props(await layout()).pendingSetup).toBe(true)
  })
  it('reports an unreadable employee state as unavailable, not as pending', async () => {
    person(['hr/my-workspace'])
    getOwnOnboardingState.mockResolvedValue('unknown')
    expect(props(await layout()).kind).toBe('unavailable')
  })
  it('denies a user with neither self-service nor HR administration', async () => {
    person([])
    expect(props(await layout()).kind).toBe('denied')
  })
})
