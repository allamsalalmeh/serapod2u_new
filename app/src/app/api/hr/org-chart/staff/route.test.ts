import { beforeEach, describe, expect, it, vi } from 'vitest'

let user: any
const loadNavActor = vi.fn()
const resolveDestinationAccess = vi.fn()
const loadStaffChart = vi.fn()
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user }, error: user ? null : new Error('x') }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/server/nav-access', () => ({ loadNavActor, resolveDestinationAccess }))
vi.mock('@/lib/server/hr/staff-org-chart', () => ({ loadStaffChart }))

const get = async () => (await import('./route')).GET()

describe('GET /api/hr/org-chart/staff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    user = { id: 'u-1' }
    loadNavActor.mockResolvedValue({ userId: 'u-1', organizationId: 'org-hq' })
    resolveDestinationAccess.mockResolvedValue({ state: 'allowed', destination: 'hr/people/org-chart/staff' })
    loadStaffChart.mockResolvedValue([{ key: 'n1', name: 'A', jobTitle: null, department: null, managerKey: null, isSelf: true }])
  })

  it('401 for an expired login', async () => {
    user = null
    expect((await get()).status).toBe(401)
  })
  it('403 without the chart permissions, and nothing is read', async () => {
    resolveDestinationAccess.mockResolvedValue({ state: 'denied' })
    expect((await get()).status).toBe(403)
    expect(loadStaffChart).not.toHaveBeenCalled()
  })
  it('503 (not 403) when the permission check itself failed', async () => {
    resolveDestinationAccess.mockResolvedValue({ state: 'unavailable' })
    expect((await get()).status).toBe(503)
    expect(loadStaffChart).not.toHaveBeenCalled()
  })
  it('decides on the administrative OR staff chart destination and reads only the caller\'s own organization', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(resolveDestinationAccess).toHaveBeenCalledWith(expect.anything(), ['hr/people/org-chart', 'hr/people/org-chart/staff'])
    expect(loadStaffChart).toHaveBeenCalledWith(expect.anything(), 'org-hq', 'u-1')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect((await res.json()).nodes).toHaveLength(1)
  })
  it('500 with no detail when the projection read fails', async () => {
    loadStaffChart.mockRejectedValue(new Error('staff_chart_unavailable'))
    const res = await get()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('staff_chart_unavailable')
  })
})
