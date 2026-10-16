import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const ORG = '00000000-0000-4000-8000-0000000000aa'
const loadScopeChoices = vi.fn()
let ownMembership = true
let holdsView = false
const admin = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: ownMembership ? [{ id: 'm' }] : [] }) }) }) }) }) }) }
vi.mock('@/lib/security-access/scope-grant', () => ({ loadScopeChoices: (...a: any[]) => loadScopeChoices(...a) }))
vi.mock('@/lib/security-access/admin-api', () => ({
  requireSecurityActor: vi.fn(async () => ({ userId: 'admin', organizationId: 'o', admin })),
  requireSelfServiceActor: vi.fn(async () => ({ userId: 'self', organizationId: 'o', admin })),
  actorAlsoHolds: vi.fn(async () => holdsView),
}))

const get = (qs: string) => new NextRequest(`http://t/api/security-access/scope-choices?${qs}`)
const loaded = { organization: { id: ORG, name: 'Serapod HQ', typeCode: 'HQ' }, orgNames: { [ORG]: 'Serapod HQ' }, choices: [{ scopeId: 's1', targetOrganizationId: ORG, scopeType: 'organization', kind: 'hq', name: 'Serapod HQ', label: 'Serapod HQ — HQ and all its warehouses', coverage: 'HQ and all its warehouses' }] }

beforeEach(() => { loadScopeChoices.mockReset(); loadScopeChoices.mockResolvedValue(loaded); ownMembership = true; holdsView = false })

describe('GET /api/security-access/scope-choices', () => {
  it('grant: returns canonical choices filtered by the administrator’s authority', async () => {
    const { GET } = await import('./route')
    const res = await GET(get(`organizationId=${ORG}`))
    expect(res.status).toBe(200)
    expect(loadScopeChoices).toHaveBeenCalledWith(admin, ORG, 'admin')
    expect((await res.json()).choices[0]).toMatchObject({ id: 's1', kind: 'hq', label: 'Serapod HQ — HQ and all its warehouses' })
  })
  it('request: no grant authority is needed for the requester’s own organization, and no authority filter is applied', async () => {
    const { GET } = await import('./route')
    expect((await GET(get(`organizationId=${ORG}&purpose=request`))).status).toBe(200)
    expect(loadScopeChoices).toHaveBeenCalledWith(admin, ORG, null)
  })
  it('request: another organization needs security.access.view', async () => {
    ownMembership = false
    const { GET } = await import('./route')
    expect((await GET(get(`organizationId=${ORG}&purpose=request`))).status).toBe(403)
    holdsView = true
    expect((await GET(get(`organizationId=${ORG}&purpose=request`))).status).toBe(200)
  })
  it('rejects a malformed organization and reports an unavailable read as 503, never as an empty list', async () => {
    const { GET } = await import('./route')
    expect((await GET(get('organizationId=nope'))).status).toBe(400)
    loadScopeChoices.mockRejectedValueOnce(new Error('x'))
    expect((await GET(get(`organizationId=${ORG}`))).status).toBe(503)
  })
})
void NextResponse
