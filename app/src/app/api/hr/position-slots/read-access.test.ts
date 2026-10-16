import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

// Every Position Management read uses the service role, so the route's S&A check is the only gate.
const hrCan = vi.fn()
const adminFrom = vi.fn()
const adminRpc = vi.fn()
let authed = true
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: adminFrom, rpc: adminRpc }) }))
vi.mock('@/lib/server/hrAccess', () => ({
  getHrAuthContext: async () => authed
    ? { success: true, data: { userId: 'u-1', organizationId: 'org-a', roleCode: null, roleLevel: null } }
    : { success: false, error: 'Not authenticated' },
  hrCan: (...a: unknown[]) => hrCan(...a),
}))
const listPositionSlots = vi.fn()
const getPositionSlot = vi.fn()
const listJobClassifications = vi.fn()
vi.mock('@/lib/server/hr/position-management', () => ({ listPositionSlots, getPositionSlot, listJobClassifications }))
const loadChangeRequest = vi.fn()
vi.mock('@/lib/server/hr/position-workflow', () => ({ loadChangeRequest, createPositionChangeRequest: vi.fn() }))

const req = (path: string) => new NextRequest(`http://localhost${path}`)
const params = { params: Promise.resolve({ id: 'x' }) }

const ROUTES: Array<[string, string, () => Promise<Response>]> = [
  ['position-slots', 'hr.employee.view', async () => (await import('./route')).GET(req('/api/hr/position-slots'))],
  ['position-slots/[id]', 'hr.employee.view', async () => (await import('./[id]/route')).GET(req('/api/hr/position-slots/x'), params)],
  ['position-slots/org-chart', 'hr.employee.view', async () => (await import('./org-chart/route')).GET(req('/api/hr/position-slots/org-chart'))],
  ['job-classifications', 'hr.employee.view', async () => (await import('../job-classifications/route')).GET()],
  ['position-change-requests', 'hr.employee.manage', async () => (await import('../position-change-requests/route')).GET(req('/api/hr/position-change-requests'))],
  ['position-change-requests/[id]', 'hr.employee.manage', async () => (await import('../position-change-requests/[id]/route')).GET(req('/api/hr/position-change-requests/x'), params)],
]

describe('Position Management reads require an HR permission', () => {
  beforeEach(() => { vi.clearAllMocks(); authed = true })

  it.each(ROUTES)('%s: 401 without a login, nothing read', async (_r, _p, call) => {
    authed = false
    expect((await call()).status).toBe(401)
    expect(hrCan).not.toHaveBeenCalled()
  })

  it.each(ROUTES)('%s: 403 without %s, and no service-role read happens', async (_r, permission, call) => {
    hrCan.mockResolvedValue(false)
    expect((await call()).status).toBe(403)
    expect(hrCan).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-a' }), permission)
    for (const fn of [adminFrom, adminRpc, listPositionSlots, getPositionSlot, listJobClassifications, loadChangeRequest]) expect(fn).not.toHaveBeenCalled()
  })
})
