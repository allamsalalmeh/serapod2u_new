import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ access: vi.fn(), rpc: vi.fn(), from: vi.fn(), authority: vi.fn(), diagnostics: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'viewer' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: mocks.rpc, from: mocks.from }) }))
vi.mock('@/lib/system-logs/access', () => ({ resolveSystemLogAccess: mocks.access, scopeArgs: (scope: any) => ({ p_all_orgs: scope.all, p_orgs: scope.organizationIds }) }))
vi.mock('@/lib/security-access/operation', () => ({ authorizeOperation: mocks.authority, organizationResource: (_type: string, organizationId: string) => ({ organizationId }) }))
vi.mock('@/lib/security-access/delegation', () => ({ legacyOrDelegatedSecurityAccess: vi.fn() }))
vi.mock('@/lib/security-access/denial-diagnostics', () => ({ denialDiagnostics: mocks.diagnostics }))
import { GET } from './route'
const params = { params: Promise.resolve({ id: '11111111-1111-4111-8111-111111111111' }) }
const run = () => GET({} as any, params)
beforeEach(() => {
  vi.clearAllMocks()
  mocks.access.mockResolvedValue({ allowed: true, scope: { all: false, organizationIds: ['org-a'] } })
  mocks.rpc.mockResolvedValue({ data: { event: { source: 'server', http_status: 403, actor_id: 'target', organization_id: 'org-a', details: { event: 'security.authorization.denied' } } }, error: null })
  mocks.from.mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { org_name: 'Fixture HQ' } }) }) }) })
  mocks.authority.mockResolvedValue({ decision: 'DENY' })
  mocks.diagnostics.mockResolvedValue({ requiredPermission: 'inventory.stock.view', candidates: [] })
})
describe('protected log diagnostic details', () => {
  it.each([401, 403, 503])('prevents all diagnostic reads after a %i viewer refusal', async status => {
    mocks.access.mockResolvedValue({ allowed: false, status })
    expect((await run()).status).toBe(status); expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.diagnostics).not.toHaveBeenCalled()
  })
  it('passes tenant scope into the database and hides out-of-scope IDs', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null })
    expect((await run()).status).toBe(404)
    expect(mocks.rpc).toHaveBeenCalledWith('system_log_event_detail', expect.objectContaining({ p_orgs: ['org-a'], p_all_orgs: false }))
    expect(mocks.authority).not.toHaveBeenCalled()
  })
  it('does not disclose policy candidates to a log viewer without grant authority', async () => {
    expect((await (await run()).json()).authorizationDiagnostics).toBeNull()
    expect(mocks.diagnostics).not.toHaveBeenCalled()
    expect(mocks.authority).toHaveBeenCalledWith(expect.objectContaining({ permission: 'security.role.assign', resource: { organizationId: 'org-a' }, explainOnly: true }))
  })
  it('loads candidates only on demand for an in-scope administrator without granting anything', async () => {
    mocks.authority.mockResolvedValue({ decision: 'ALLOW' })
    const body = await (await run()).json()
    expect(body.authorizationDiagnostics.requiredPermission).toBe('inventory.stock.view')
    expect(mocks.rpc).toHaveBeenCalledTimes(1); expect(mocks.diagnostics).toHaveBeenCalledTimes(1)
  })
})
