import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const hrCan = vi.fn()
vi.mock('@/lib/server/hrAccess', () => ({ hrCan: (...a: unknown[]) => hrCan(...a) }))
const resolveApprovers = vi.fn()
vi.mock('./position-management', () => ({ resolveApprovers: (...a: unknown[]) => resolveApprovers(...a), writeAudit: vi.fn() }))

/** Minimal in-memory stand-in for the service-role client: eq/in filters, insert/update/delete, single/maybeSingle. */
function fakeDb(seed: Record<string, any[]>) {
  const tables: Record<string, any[]> = JSON.parse(JSON.stringify(seed))
  const log: Array<{ table: string; op: string; filters: Array<[string, unknown]> }> = []
  let seq = 0
  const builder = (table: string) => {
    const filters: Array<[string, (r: any) => boolean, unknown]> = []
    let op: 'select' | 'update' | 'insert' | 'delete' = 'select'
    let values: any = null
    const rows = () => (tables[table] ??= []).filter(r => filters.every(([, f]) => f(r)))
    const run = () => {
      log.push({ table, op, filters: filters.map(([c, , v]) => [c, v]) })
      if (op === 'insert') {
        const list = (Array.isArray(values) ? values : [values]).map(v => ({ id: `${table}-${++seq}`, ...v }))
        tables[table].push(...list)
        return list
      }
      const hit = rows()
      if (op === 'update') hit.forEach(r => Object.assign(r, values))
      if (op === 'delete') tables[table] = tables[table].filter(r => !hit.includes(r))
      return hit
    }
    const q: any = {
      select: () => q,
      order: () => q,
      eq: (c: string, v: unknown) => (filters.push([c, r => r[c] === v, v]), q),
      in: (c: string, v: unknown[]) => (filters.push([c, r => v.includes(r[c]), v]), q),
      insert: (v: any) => ((op = 'insert'), (values = v), (tables[table] ??= []), q),
      update: (v: any) => ((op = 'update'), (values = v), q),
      delete: () => ((op = 'delete'), q),
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      single: async () => { const r = run()[0]; return r ? { data: r, error: null } : { data: null, error: { message: 'no row' } } },
      then: (ok: any, ko: any) => Promise.resolve({ data: run(), error: null }).then(ok, ko),
    }
    return q
  }
  return { client: { from: builder }, tables, log }
}

const ORG = 'org-a'
const OTHER = 'org-b'
const seed = () => ({
  hr_position_slots: [{ id: 'pos-a', organization_id: ORG }, { id: 'pos-a2', organization_id: ORG }, { id: 'pos-b', organization_id: OTHER }],
  users: [{ id: 'emp-a', organization_id: ORG }, { id: 'emp-b', organization_id: OTHER }],
  hr_job_classifications: [{ id: 'jc-a', organization_id: ORG }, { id: 'jc-b', organization_id: OTHER }],
  departments: [{ id: 'dept-a', organization_id: ORG }, { id: 'dept-b', organization_id: OTHER }],
  hr_position_change_requests: [] as any[],
  hr_position_approval_steps: [] as any[],
  hr_position_assignments: [] as any[],
})

const ctx = (userId: string) => ({ userId, organizationId: ORG, roleCode: null, roleLevel: null })

describe('position change requests stay inside the caller organization', () => {
  beforeEach(() => { vi.clearAllMocks(); hrCan.mockResolvedValue(true) })

  it('accepts references that all belong to the organization', async () => {
    const { createPositionChangeRequest } = await import('./position-workflow')
    const db = fakeDb(seed())
    const res = await createPositionChangeRequest(db.client, ORG, 'hr-1', {
      requestType: 'CHANGE_REPORTING', positionId: 'pos-a', changePayload: { parent_position_id: 'pos-a2' },
    })
    expect(res.success).toBe(true)
    expect(db.tables.hr_position_change_requests).toHaveLength(1)
  })

  it.each([
    ['a position of another organization', { requestType: 'UPDATE_POSITION', positionId: 'pos-b', changePayload: { name: 'x' } }, 'Position not found'],
    ['a missing position', { requestType: 'CHANGE_LIFECYCLE', positionId: 'nope', changePayload: {} }, 'Position not found'],
    ['a reports-to position of another organization', { requestType: 'CHANGE_REPORTING', positionId: 'pos-a', changePayload: { parent_position_id: 'pos-b' } }, 'Reports-to position not found'],
    ['an employee of another organization', { requestType: 'ASSIGN_EMPLOYEE', positionId: 'pos-a', changePayload: { employee_user_id: 'emp-b' } }, 'Employee not found in this organization'],
    ['a job classification of another organization', { requestType: 'CREATE_POSITION', changePayload: { job_classification_id: 'jc-b' } }, 'Job classification not found'],
    ['a department of another organization', { requestType: 'CREATE_POSITION', changePayload: { department_id: 'dept-b' } }, 'Department not found'],
  ])('refuses %s and stores nothing', async (_label, input, message) => {
    const { createPositionChangeRequest } = await import('./position-workflow')
    const db = fakeDb(seed())
    const res = await createPositionChangeRequest(db.client, ORG, 'hr-1', input as any)
    expect(res).toMatchObject({ success: false, error: message, status: 400 })
    expect(db.tables.hr_position_change_requests).toHaveLength(0)
  })

  it('re-checks references before activation (requests stored before the check existed)', async () => {
    const { approveChangeRequest } = await import('./position-workflow')
    const s = seed()
    s.hr_position_change_requests.push({ id: 'r1', organization_id: ORG, status: 'pending', submitted_by: 'hr-1', request_type: 'ASSIGN_EMPLOYEE', position_id: 'pos-a', change_payload: { employee_user_id: 'emp-b' } })
    s.hr_position_approval_steps.push({ id: 's1', change_request_id: 'r1', status: 'pending', approver_type: 'POLICY', approver_ref: 'hr.employee.manage', step_no: 1 })
    const db = fakeDb(s)
    const res = await approveChangeRequest(db.client, ctx('hr-2') as any, 'r1')
    expect(res).toMatchObject({ success: false, status: 409 })
    expect(db.tables.hr_position_assignments).toHaveLength(0)
    expect(db.tables.hr_position_change_requests[0].status).toBe('pending')
  })
})

describe('deciding a pending request', () => {
  beforeEach(() => { vi.clearAllMocks(); hrCan.mockResolvedValue(true) })

  const pendingWithUserStep = () => {
    const s = seed()
    s.hr_position_change_requests.push({ id: 'r1', organization_id: ORG, status: 'pending', submitted_by: 'hr-1', request_type: 'CHANGE_LIFECYCLE', position_id: 'pos-a', change_payload: { lifecycle_status: 'frozen' } })
    s.hr_position_approval_steps.push({ id: 's1', change_request_id: 'r1', status: 'pending', approver_type: 'USER', approver_ref: 'approver-1', step_no: 1 })
    return s
  }

  it.each(['rejectChangeRequest', 'returnChangeRequest'] as const)('%s refuses an HR manager who is not a resolved approver', async (fn) => {
    const mod = await import('./position-workflow')
    const db = fakeDb(pendingWithUserStep())
    const res = await mod[fn](db.client, ctx('hr-other') as any, 'r1', 'no')
    expect(res).toMatchObject({ success: false, status: 403 })
    expect(db.tables.hr_position_change_requests[0].status).toBe('pending')
  })

  it.each([['rejectChangeRequest', 'rejected'], ['returnChangeRequest', 'returned']] as const)('%s lets the resolved approver decide', async (fn, status) => {
    const mod = await import('./position-workflow')
    const db = fakeDb(pendingWithUserStep())
    const res = await mod[fn](db.client, ctx('approver-1') as any, 'r1', 'reason')
    expect(res.success).toBe(true)
    expect(db.tables.hr_position_change_requests[0].status).toBe(status)
  })

  it('still refuses the submitter and anyone without hr.employee.manage', async () => {
    const { rejectChangeRequest } = await import('./position-workflow')
    const db = fakeDb(pendingWithUserStep())
    expect(await rejectChangeRequest(db.client, ctx('hr-1') as any, 'r1', 'x')).toMatchObject({ status: 403 })
    hrCan.mockResolvedValue(false)
    expect(await rejectChangeRequest(db.client, ctx('approver-1') as any, 'r1', 'x')).toMatchObject({ status: 403 })
  })
})

describe('END_ASSIGNMENT activation', () => {
  it('only ends assignments of the request organization', async () => {
    const { activateAssignment } = await import('./position-activation')
    const db = fakeDb({ hr_position_assignments: [
      { id: 'as-b', organization_id: OTHER, position_id: 'pos-x', employee_user_id: 'emp-x', status: 'active' },
    ] })
    await activateAssignment(db.client, ctx('hr-2') as any, {
      organization_id: ORG, request_type: 'END_ASSIGNMENT', position_id: 'pos-x', change_payload: { employee_user_id: 'emp-x' },
    })
    expect(db.tables.hr_position_assignments[0].status).toBe('active')
    const update = db.log.find(l => l.table === 'hr_position_assignments' && l.op === 'update')
    expect(update?.filters).toContainEqual(['organization_id', ORG])
  })
})
