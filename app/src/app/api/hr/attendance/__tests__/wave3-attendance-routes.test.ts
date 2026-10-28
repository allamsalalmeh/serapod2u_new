import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { ess, hrSelfCanMock, resetEss, resetWave2, sessionClient, wave2 } from '@/lib/hr/test-support/wave3Mocks'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => sessionClient()) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: wave2.rpc }) }))
vi.mock('@/lib/server/hrAccess', () => ({ hrSelfCan: (...a: unknown[]) => hrSelfCanMock(...a) }))

const E = '00000000-0000-0000-0000-00000000e001'
const ENTRY = '00000000-0000-0000-0000-0000000000f1'
const ID = '00000000-0000-0000-0000-0000000000c1'
const OTHER_ORG = '00000000-0000-0000-0000-000000000003'
const post = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: 'POST', body: JSON.stringify(body) })
const get = (url: string) => new NextRequest(`http://localhost${url}`)
const json = async (res: Response) => ({ status: res.status, body: await res.json() })

beforeEach(() => { resetWave2(); resetEss() })

describe('POST /api/hr/attendance/clock (Wave 3: server time in the database)', () => {
  const call = async (body: unknown) => (await import('../clock/route')).POST(post('/api/hr/attendance/clock', body))
  it('passes only the SESSION actor, channel and the device time as information', async () => {
    wave2.rpc.mockResolvedValue({ data: { status: 'clocked_in', entry_id: ENTRY }, error: null })
    const r = await json(await call({ action: 'clock_in', source: 'mobile', client_at: '2026-10-25T01:00:00.000Z', user_id: E, clock_in_at: '2020-01-01T00:00:00Z' }))
    expect(r.status).toBe(200)
    expect(wave2.rpc).toHaveBeenCalledWith('hr_attendance_clock', {
      p_actor: wave2.sessionUser!.id, p_action: 'clock_in', p_shift: null, p_source: 'mobile', p_client_at: '2026-10-25T01:00:00.000Z', p_note: null,
    })
  })
  it('requires Employee Self-Service', async () => {
    ess.allowed = false
    expect((await call({ action: 'clock_in' })).status).toBe(403)
    expect(wave2.rpc).not.toHaveBeenCalled()
  })
  it('refuses unknown actions and malformed shifts before the database', async () => {
    expect((await call({ action: 'delete' })).status).toBe(400)
    expect((await call({ action: 'clock_in', shift_id: 'not-a-uuid' })).status).toBe(400)
    expect(wave2.rpc).not.toHaveBeenCalled()
  })
  it('maps refusals to clear messages (no false success)', async () => {
    wave2.rpc.mockResolvedValue({ data: null, error: { message: 'hr_attendance_already_clocked_in' } })
    const r = await json(await call({ action: 'clock_in' }))
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ success: false, code: 'ALREADY_CLOCKED_IN' })
  })
  it('reports "not installed" when the Wave 3 migration is missing', async () => {
    wave2.rpc.mockResolvedValue({ data: null, error: { message: 'Could not find the function public.hr_attendance_clock' } })
    expect((await call({ action: 'clock_out' })).status).toBe(503)
  })
  it('401 without a session', async () => {
    wave2.sessionUser = null
    expect((await call({ action: 'clock_in' })).status).toBe(401)
  })
})

describe('/api/hr/attendance/corrections', () => {
  const call = async (body: unknown) => (await import('../corrections/route')).POST(post('/api/hr/attendance/corrections', body))
  it('employee correction of an own entry: times of day, reason, ESS checked', async () => {
    wave2.rpc.mockResolvedValue({ data: { status: 'pending' }, error: null })
    expect((await call({ action: 'request', entry_id: ENTRY, clock_in: '09:05', reason: 'Reader delay' })).status).toBe(200)
    expect(hrSelfCanMock).toHaveBeenCalled()
    expect(wave2.rpc).toHaveBeenCalledWith('hr_attendance_request_correction', {
      p_actor: wave2.sessionUser!.id, p_entry: ENTRY, p_work_date: null, p_clock_in: '09:05', p_clock_out: null, p_break_minutes: null,
      p_reason: 'Reader delay', p_on_behalf_of: null,
    })
  })
  it('missing day needs a date; HR on behalf skips the ESS gate (the database checks HR authority)', async () => {
    wave2.rpc.mockResolvedValue({ data: { status: 'pending' }, error: null })
    ess.allowed = false
    expect((await call({ action: 'request', work_date: '2026-10-20', clock_in: '09:00', clock_out: '18:00', reason: 'Forgot', employee_user_id: E })).status).toBe(200)
    expect(wave2.rpc.mock.calls[0][1]).toMatchObject({ p_on_behalf_of: E, p_work_date: '2026-10-20', p_entry: null })
    expect((await call({ action: 'request', clock_in: '09:00', reason: 'No date given' })).status).toBe(400)
  })
  it('reason is mandatory; invalid times refused', async () => {
    expect((await json(await call({ action: 'request', entry_id: ENTRY, clock_in: '09:00', reason: '' }))).body.code).toBe('REASON_REQUIRED')
    expect((await call({ action: 'request', entry_id: ENTRY, clock_in: '9am', reason: 'Valid reason' })).status).toBe(400)
    expect(wave2.rpc).not.toHaveBeenCalled()
  })
  it('a duplicate pending correction is reported, not hidden', async () => {
    wave2.rpc.mockResolvedValue({ data: null, error: { message: 'hr_attendance_correction_pending' } })
    expect((await json(await call({ action: 'request', entry_id: ENTRY, clock_in: '09:00', reason: 'Second try' }))).body.code).toBe('ALREADY_PENDING')
  })
  it('queue: caller organization by default; another organization only as the database scope allows', async () => {
    wave2.rpc.mockResolvedValue({ data: [], error: null })
    const { GET } = await import('../corrections/route')
    await GET(get('/api/hr/attendance/corrections?status=pending'))
    expect(wave2.rpc).toHaveBeenCalledWith('hr_attendance_review_queue', expect.objectContaining({ p_org: wave2.organizationId, p_kind: 'corrections', p_status: 'pending' }))
    wave2.rpc.mockResolvedValue({ data: null, error: { message: 'sa_authorization_required' } })
    expect((await GET(get(`/api/hr/attendance/corrections?organization_id=${OTHER_ORG}`))).status).toBe(403)
  })
  it('review: approve/reject with the session actor; self-review refused by the database', async () => {
    const review = async (body: unknown) => (await import('../corrections/[id]/review/route')).POST(post(`/api/hr/attendance/corrections/${ID}/review`, body), { params: Promise.resolve({ id: ID }) })
    wave2.rpc.mockResolvedValue({ data: { status: 'approved' }, error: null })
    expect((await review({ action: 'approved', note: ' ok ' })).status).toBe(200)
    expect(wave2.rpc).toHaveBeenCalledWith('hr_attendance_decide_correction', { p_actor: wave2.sessionUser!.id, p_correction: ID, p_decision: 'approved', p_comment: 'ok' })
    wave2.rpc.mockResolvedValue({ data: null, error: { message: 'hr_attendance_self_review' } })
    expect((await json(await review({ action: 'approved' }))).body.code).toBe('SELF_REVIEW')
    expect((await review({ action: 'maybe' })).status).toBe(400)
  })
})

describe('HR manual entry, exceptions, board, report, import', () => {
  it('manual entry validates input and passes the reason', async () => {
    const { POST } = await import('../manual-entry/route')
    wave2.rpc.mockResolvedValue({ data: { status: 'recorded' }, error: null })
    const ok = await POST(post('/api/hr/attendance/manual-entry', { employee_user_id: E, work_date: '2026-10-20', clock_in: '09:30', clock_out: '18:00', break_minutes: 60, reason: 'Reader offline' }))
    expect(ok.status).toBe(200)
    expect(wave2.rpc).toHaveBeenCalledWith('hr_attendance_manual_entry', {
      p_actor: wave2.sessionUser!.id, p_employee: E, p_work_date: '2026-10-20', p_clock_in: '09:30', p_clock_out: '18:00', p_break_minutes: 60, p_shift: null, p_reason: 'Reader offline',
    })
    expect((await POST(post('/api/hr/attendance/manual-entry', { employee_user_id: E, work_date: '2026-10-20', clock_in: '09:30', reason: 'x' }))).status).toBe(400)
    wave2.rpc.mockResolvedValue({ data: null, error: { message: 'hr_self_change_prohibited' } })
    expect((await POST(post('/api/hr/attendance/manual-entry', { employee_user_id: E, work_date: '2026-10-20', clock_in: '09:30', reason: 'Own record' }))).status).toBe(403)
  })
  it('exceptions: resolve + detect; maker-checker refusal surfaced', async () => {
    const { GET, POST } = await import('../exceptions/route')
    wave2.rpc.mockResolvedValue({ data: [], error: null })
    await GET(get('/api/hr/attendance/exceptions?status=open&from=2026-10-01&to=2026-10-20'))
    expect(wave2.rpc).toHaveBeenCalledWith('hr_attendance_review_queue', { p_actor: wave2.sessionUser!.id, p_org: wave2.organizationId, p_kind: 'exceptions', p_status: 'open', p_from: '2026-10-01', p_to: '2026-10-20' })
    wave2.rpc.mockResolvedValue({ data: null, error: { message: 'hr_attendance_maker_checker' } })
    expect((await json(await POST(post('/api/hr/attendance/exceptions', { action: 'resolve', id: ID, resolution: 'acknowledged' })))).body.code).toBe('MAKER_CHECKER')
    expect((await POST(post('/api/hr/attendance/exceptions', { action: 'resolve', id: ID, resolution: 'deleted' }))).status).toBe(400)
    wave2.rpc.mockResolvedValue({ data: { new_exceptions: 3 }, error: null })
    expect((await POST(post('/api/hr/attendance/exceptions', { action: 'detect', from: '2026-10-01', to: '2026-10-20' }))).status).toBe(200)
    expect(wave2.rpc).toHaveBeenLastCalledWith('hr_attendance_run_detection', { p_actor: wave2.sessionUser!.id, p_org: wave2.organizationId, p_from: '2026-10-01', p_to: '2026-10-20' })
  })
  it('board and report need valid dates', async () => {
    const board = (await import('../board/route')).GET
    const report = (await import('../report/route')).GET
    expect((await board(get('/api/hr/attendance/board'))).status).toBe(400)
    expect((await report(get('/api/hr/attendance/report?from=2026-10-01'))).status).toBe(400)
    wave2.rpc.mockResolvedValue({ data: [], error: null })
    expect((await board(get('/api/hr/attendance/board?date=2026-10-20'))).status).toBe(200)
    expect(wave2.rpc).toHaveBeenCalledWith('hr_attendance_day_board', { p_actor: wave2.sessionUser!.id, p_org: wave2.organizationId, p_date: '2026-10-20' })
  })
  it('import: preview → commit with expected count; file identity and size checked', async () => {
    const { POST } = await import('../import/route')
    const sha = 'a'.repeat(64)
    wave2.rpc.mockResolvedValue({ data: { batch: { id: ID, valid_count: 2 } }, error: null })
    expect((await POST(post('/api/hr/attendance/import', { action: 'preview', file_name: 'att.xlsx', file_sha256: sha, rows: [{ row_no: 2 }] }))).status).toBe(200)
    expect(wave2.rpc).toHaveBeenCalledWith('hr_attendance_import_preview', { p_actor: wave2.sessionUser!.id, p_org: wave2.organizationId, p_file_name: 'att.xlsx', p_file_sha256: sha, p_rows: [{ row_no: 2 }] })
    expect((await POST(post('/api/hr/attendance/import', { action: 'preview', file_name: 'att.xlsx', file_sha256: 'xyz', rows: [{}] }))).status).toBe(400)
    expect((await json(await POST(post('/api/hr/attendance/import', { action: 'preview', file_name: 'att.xlsx', file_sha256: sha, rows: Array(5001).fill({}) })))).body.code).toBe('TOO_MANY_ROWS')
    wave2.rpc.mockResolvedValue({ data: { status: 'committed', imported: 2 }, error: null })
    expect((await POST(post('/api/hr/attendance/import', { action: 'commit', batch_id: ID, expected_valid: 2 }))).status).toBe(200)
    expect(wave2.rpc).toHaveBeenLastCalledWith('hr_attendance_import_commit', { p_actor: wave2.sessionUser!.id, p_batch: ID, p_expected_valid: 2 })
    wave2.rpc.mockResolvedValue({ data: null, error: { message: 'hr_import_file_already_committed' } })
    expect((await json(await POST(post('/api/hr/attendance/import', { action: 'preview', file_name: 'a.xlsx', file_sha256: sha, rows: [{}] })))).body.code).toBe('ALREADY_IMPORTED')
  })
})

describe('/api/hr/attendance/overtime/requests (Wave 3, B5)', () => {
  const call = async (body: unknown) => (await import('../overtime/requests/route')).POST(post('/api/hr/attendance/overtime/requests', body))
  it('submit: always for independent approval; session actor; ESS checked', async () => {
    wave2.rpc.mockResolvedValue({ data: { status: 'submitted' }, error: null })
    expect((await call({ action: 'submit', request_date: '2026-10-20', ot_minutes: 90, reason: 'Stock count', kind: 'post', employee_id: E, status: 'approved' })).status).toBe(200)
    expect(wave2.rpc).toHaveBeenCalledWith('hr_overtime_submit', {
      p_actor: wave2.sessionUser!.id, p_request_date: '2026-10-20', p_minutes: 90, p_reason: 'Stock count', p_kind: 'post', p_entry: null,
      p_planned_start: null, p_planned_end: null, p_idempotency_key: null,
    })
    ess.allowed = false
    expect((await call({ action: 'submit', request_date: '2026-10-20', ot_minutes: 90, reason: 'Stock count' })).status).toBe(403)
  })
  it('approve/reject/cancel go to the database with the session actor; self-approval refused there', async () => {
    wave2.rpc.mockResolvedValue({ data: null, error: { message: 'hr_ot_self_approval' } })
    expect((await json(await call({ action: 'approve', id: ID }))).body.code).toBe('SELF_REVIEW')
    expect(wave2.rpc).toHaveBeenCalledWith('hr_overtime_decide', { p_actor: wave2.sessionUser!.id, p_request: ID, p_decision: 'approved', p_comment: null, p_approved_minutes: null })
    wave2.rpc.mockResolvedValue({ data: { status: 'rejected' }, error: null })
    await call({ action: 'reject', id: ID, comment: 'Covered by swap' })
    expect(wave2.rpc).toHaveBeenLastCalledWith('hr_overtime_decide', { p_actor: wave2.sessionUser!.id, p_request: ID, p_decision: 'rejected', p_comment: 'Covered by swap', p_approved_minutes: null })
    wave2.rpc.mockResolvedValue({ data: null, error: { message: 'hr_ot_cancel_approved_by_hr' } })
    expect((await call({ action: 'cancel', id: ID })).status).toBe(403)
  })
  it('duplicate claim and invalid input', async () => {
    wave2.rpc.mockResolvedValue({ data: null, error: { message: 'hr_ot_duplicate' } })
    expect((await json(await call({ action: 'submit', request_date: '2026-10-20', ot_minutes: 30, reason: 'Again same day' }))).body.code).toBe('DUPLICATE')
    expect((await call({ action: 'submit', request_date: '20/10/2026', ot_minutes: 30, reason: 'Bad date' })).status).toBe(400)
    expect((await call({ action: 'approve', id: 'x' })).status).toBe(400)
  })
  it('GET mine (ESS) and queue (database scope)', async () => {
    const { GET } = await import('../overtime/requests/route')
    wave2.rpc.mockResolvedValue({ data: [], error: null })
    await GET(get('/api/hr/attendance/overtime/requests?scope=queue&status=submitted'))
    expect(wave2.rpc).toHaveBeenCalledWith('hr_overtime_list', { p_actor: wave2.sessionUser!.id, p_scope: 'queue', p_status: 'submitted', p_org: wave2.organizationId })
    await GET(get('/api/hr/attendance/overtime/requests'))
    expect(wave2.rpc).toHaveBeenLastCalledWith('hr_overtime_list', { p_actor: wave2.sessionUser!.id, p_scope: 'mine', p_status: null, p_org: null })
    expect((await GET(get('/api/hr/attendance/overtime/requests?status=paid'))).status).toBe(400)
  })
})
