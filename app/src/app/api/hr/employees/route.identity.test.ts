import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const provisionIdentity = vi.fn()
const hrCan = vi.fn()
const usersInsert = vi.fn()
const resolveForOnboarding = vi.fn()
const completeOnboarding = vi.fn()

vi.mock('@/lib/identity/provisioning', () => ({ provisionIdentity }))
vi.mock('@/lib/server/hrAccess', () => ({ hrCan }))
vi.mock('@/lib/hr/onboarding', () => ({
  resolveForOnboarding,
  completeOnboarding,
  ONBOARDING_BLOCK_MESSAGES: { IDENTITY_ORG_MOVE_REQUIRED: 'other organization' },
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'hr-1' } }, error: null }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { id: 'u-1', organization_id: 'org-a', roles: { role_level: 20 }, full_name: 'New', email: 'new@x.test', employee_no: 7 }, error: null }),
        }),
      }),
      insert: usersInsert,
    }),
  })),
}))

const post = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/hr/employees', { method: 'POST', body: JSON.stringify(body) })

describe('POST /api/hr/employees (HR onboarding over one central identity)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    hrCan.mockResolvedValue(true)
    completeOnboarding.mockResolvedValue({ ok: true, outcome: 'ONBOARDED', userId: 'u-1', employeeNo: 7 })
  })

  it('creates a genuinely new person through canonical provisioning, then completes onboarding', async () => {
    resolveForOnboarding.mockResolvedValue({ ok: true, outcome: 'NEW_PERSON' })
    provisionIdentity.mockResolvedValue({ ok: true, userId: 'u-1', outcome: 'CREATED', tempPassword: 'Temp-Pass-1234' })
    const { POST } = await import('./route')

    const res = await POST(post({ full_name: 'New', email: 'new@x.test', role_code: 'staff', department_id: 'd-1', hire_date: '2026-10-01' }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.data).toMatchObject({ outcome: 'CREATED', onboarding: 'ONBOARDED', temp_password: 'Temp-Pass-1234', employee_no: 7 })
    expect(provisionIdentity).toHaveBeenCalledWith(expect.objectContaining({
      actorId: 'hr-1', organizationId: 'org-a', authorizingPermission: 'hr.employee.manage', source: 'hr',
      legacyRoleCode: null, hr: expect.objectContaining({ departmentId: 'd-1', joinDate: '2026-10-01' }),
    }))
    expect(completeOnboarding).toHaveBeenCalledWith('hr-1', 'org-a', 'u-1', expect.objectContaining({ hireDate: '2026-10-01', departmentId: 'd-1' }), 'hr_add_employee')
  })

  it('reuses an existing identity found by email: no provisioning, no new user row', async () => {
    resolveForOnboarding.mockResolvedValue({ ok: true, outcome: 'EXISTING', candidate: { found: true, user_id: 'u-9', eligible: true } })
    const { POST } = await import('./route')

    const res = await POST(post({ full_name: 'Existing', email: 'existing@x.test', hire_date: '2024-01-01' }))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.data).toMatchObject({ outcome: 'REUSED', temp_password: null })
    expect(provisionIdentity).not.toHaveBeenCalled()
    expect(usersInsert).not.toHaveBeenCalled()
    expect(completeOnboarding).toHaveBeenCalledWith('hr-1', 'org-a', 'u-9', expect.anything(), 'hr_add_employee')
  })

  it('onboards a person selected after an authorized preview by user id', async () => {
    const { POST } = await import('./route')
    const res = await POST(post({ user_id: 'u-9', hire_date: '2024-01-01' }))
    expect(res.status).toBe(200)
    expect(resolveForOnboarding).not.toHaveBeenCalled()
    expect(completeOnboarding).toHaveBeenCalledWith('hr-1', 'org-a', 'u-9', expect.objectContaining({ hireDate: '2024-01-01' }), 'hr_add_employee')
  })

  it('refuses a person of another organization instead of moving them', async () => {
    resolveForOnboarding.mockResolvedValue({ ok: true, outcome: 'EXISTING', candidate: { found: true, user_id: 'u-5', eligible: false, block_code: 'IDENTITY_ORG_MOVE_REQUIRED' } })
    const { POST } = await import('./route')
    const res = await POST(post({ full_name: 'Other', email: 'other@x.test', hire_date: '2024-01-01' }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('IDENTITY_ORG_MOVE_REQUIRED')
    expect(completeOnboarding).not.toHaveBeenCalled()
    expect(provisionIdentity).not.toHaveBeenCalled()
  })

  it('returns an identity conflict instead of creating anything', async () => {
    resolveForOnboarding.mockResolvedValue({ ok: false, code: 'IDENTITY_CONFLICT', status: 409, message: 'conflict' })
    const { POST } = await import('./route')

    const res = await POST(post({ full_name: 'Dup', email: 'dup@x.test', phone: '0123456789', hire_date: '2024-01-01' }))

    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('IDENTITY_CONFLICT')
    expect(provisionIdentity).not.toHaveBeenCalled()
    expect(completeOnboarding).not.toHaveBeenCalled()
  })

  it('requires the actual hire date (a login creation date is not a hire date)', async () => {
    const { POST } = await import('./route')
    const res = await POST(post({ full_name: 'X', email: 'x@x.test' }))
    expect(res.status).toBe(400)
    expect(completeOnboarding).not.toHaveBeenCalled()
  })

  it('is refused without HR employee-management authority', async () => {
    hrCan.mockResolvedValue(false)
    const { POST } = await import('./route')

    const res = await POST(post({ full_name: 'X', email: 'x@x.test', hire_date: '2024-01-01' }))

    expect(res.status).toBe(403)
    expect(provisionIdentity).not.toHaveBeenCalled()
    expect(completeOnboarding).not.toHaveBeenCalled()
  })
})
