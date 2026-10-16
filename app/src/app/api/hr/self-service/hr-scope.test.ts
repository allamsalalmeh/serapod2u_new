import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const hrCan = vi.fn()
const hrSelfCan = vi.fn()
const getHrAuthContext = vi.fn()
const db: Array<[string, ...unknown[]]> = []
let inserted: any = null
const chain = (table: string): any => new Proxy({}, {
  get: (_t, prop: string) => {
    if (prop === 'then') return (resolve: any) => resolve({ data: [], error: null })
    if (prop === 'single') return async () => ({ data: inserted, error: null })
    return (...args: unknown[]) => {
      if (prop === 'insert') inserted = args[0]
      db.push([`${table}.${prop}`, ...args])
      return chain(table)
    }
  },
})
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ from: (t: string) => chain(t) }) }))
vi.mock('@/lib/server/hrAccess', () => ({ hrCan, hrSelfCan, getHrAuthContext, canManageHr: vi.fn() }))

const ctx = { userId: 'u-me', organizationId: 'org-hq', roleCode: 'GUEST', roleLevel: 50 }
const post = (url: string, body: object) => new NextRequest(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body) })

beforeEach(() => {
  vi.clearAllMocks()
  db.length = 0
  inserted = null
  getHrAuthContext.mockResolvedValue({ success: true, data: ctx })
  hrCan.mockResolvedValue(false)
  hrSelfCan.mockResolvedValue(true)
})

describe.each([
  ['document-requests', '/api/hr/self-service/document-requests', 'hr_document_requests', { document_type: 'Employment Letter' }],
  ['profile-change-requests', '/api/hr/self-service/profile-change-requests', 'hr_profile_change_requests', { change_payload: { full_name: 'New Name' } }],
])('%s', (_name, url, table, payload) => {
  it('lists only the employee\'s own requests (an ESS user never sees the organization\'s)', async () => {
    const { GET } = await import(`${url.replace('/api/hr/self-service', './')}/route`)
    await GET()
    expect(db).toContainEqual([`${table}.eq`, 'employee_user_id', 'u-me'])
  })

  it('lists the organization\'s requests for an HR administrator', async () => {
    hrCan.mockResolvedValue(true)
    const { GET } = await import(`${url.replace('/api/hr/self-service', './')}/route`)
    await GET()
    expect(db.some(c => c[0] === `${table}.eq` && c[1] === 'employee_user_id')).toBe(false)
  })

  it('refuses the list to someone with neither Employee Self-Service nor HR administration', async () => {
    hrSelfCan.mockResolvedValue(false)
    const { GET } = await import(`${url.replace('/api/hr/self-service', './')}/route`)
    expect((await GET()).status).toBe(403)
    expect(db).toHaveLength(0)
  })

  it('files a request for the authenticated employee even when the body names someone else', async () => {
    const { POST } = await import(`${url.replace('/api/hr/self-service', './')}/route`)
    await POST(post(url, { ...payload, employee_user_id: 'u-victim', status: 'approved', reviewed_by: 'u-x', fulfilled_by: 'u-x', fulfilled_at: 'now' }))
    expect(inserted.employee_user_id).toBe('u-me')
    expect(inserted.status).toBe('pending')
    expect(inserted.reviewed_by ?? null).toBeNull()
    expect(inserted.fulfilled_by ?? null).toBeNull()
  })

  it('lets an HR administrator file on behalf of an employee', async () => {
    hrCan.mockResolvedValue(true)
    const { POST } = await import(`${url.replace('/api/hr/self-service', './')}/route`)
    await POST(post(url, { ...payload, employee_user_id: 'u-emp' }))
    expect(inserted.employee_user_id).toBe('u-emp')
  })
})

describe('payslip-access log', () => {
  it('shows an employee only their own access entries', async () => {
    const { GET } = await import('./payslip-access/route')
    await GET()
    expect(db).toContainEqual(['hr_payslip_access_logs.eq', 'employee_user_id', 'u-me'])
  })
  it('refuses to log an access for another employee unless the caller has payroll view', async () => {
    const { POST } = await import('./payslip-access/route')
    expect((await POST(post('/x', { employee_user_id: 'u-victim' }))).status).toBe(403)
    expect(inserted).toBeNull()
  })
  it('requires Employee Self-Service even for the caller\'s own entry', async () => {
    hrSelfCan.mockResolvedValue(false)
    const { POST } = await import('./payslip-access/route')
    expect((await POST(post('/x', {}))).status).toBe(403)
  })
})
