import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'

// /hr/attendance/public-holidays existed only as an in-memory view before 2026-10-26: the HR setup checklist and the
// UAT guide pointed at a URL that returned 404. The page follows the same S&A destination gate as every HR page.
const redirect = vi.fn((to: string) => { throw new Error(`REDIRECT:${to}`) })
const resolveDestinationAccess = vi.fn()
vi.mock('next/navigation', () => ({ redirect }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u-1' } }, error: null }) },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({
      data: {
        id: 'u-1', organization_id: 'org-hq', role_code: 'HR', full_name: 'HR One',
        organizations: { id: 'org-hq', org_name: 'HQ', org_type_code: 'HQ', org_code: 'HQ' },
        roles: { role_name: 'Staff', role_level: 50 },
      }, error: null }) }) }) }),
  }),
}))
vi.mock('@/lib/server/nav-access', () => ({
  loadNavActor: vi.fn(),
  resolveDestinationAccess: (...args: unknown[]) => resolveDestinationAccess(...args),
  navActorFromProfile: vi.fn(),
}))
vi.mock('@/components/dashboard/DashboardContent', () => ({ default: () => null }))
vi.spyOn(console, 'warn').mockImplementation(() => undefined)

const props = (el: ReactElement) => (el as any).props

beforeEach(() => vi.clearAllMocks())

describe('/hr/attendance/public-holidays', () => {
  it('opens the holiday calendar for a person allowed the destination', async () => {
    resolveDestinationAccess.mockImplementation(async (_a: unknown, ids: string | string[]) =>
      (Array.isArray(ids) ? ids : [ids]).includes('hr/attendance/public-holidays') ? { state: 'allowed', destination: 'hr/attendance/public-holidays' } : { state: 'denied' })
    const { default: Page } = await import('./page')
    const el = await Page()
    expect(props(el).initialView).toBe('hr/attendance/public-holidays')
    expect(resolveDestinationAccess.mock.calls.some(([, ids]) => ids === 'hr/attendance/public-holidays')).toBe(true)
  })

  it('shows the shared denial (no holiday view) to everyone else', async () => {
    resolveDestinationAccess.mockResolvedValue({ state: 'denied' })
    const { default: Page } = await import('./page')
    const el = await Page()
    expect(props(el).initialView).toBe('dashboard')
    expect(props(props(el).children).kind).toBe('denied')
  })
})
