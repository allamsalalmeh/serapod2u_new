import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, any>
const db: Record<string, Row[]> = {}
let nextId = 1

function query(table: string) {
  const filters: ((r: Row) => boolean)[] = []
  let op: 'select' | 'insert' | 'update' = 'select'
  let payload: any = null
  let lim: number | null = null
  let range: [number, number] | null = null
  const orders: [string, boolean][] = []
  const rows = () => (db[table] ||= [])

  const run = () => {
    if (op === 'insert') {
      const list: Row[] = (Array.isArray(payload) ? payload : [payload]).map((r: Row) => ({ id: `id-${nextId++}`, ...r }))
      rows().push(...list)
      return list
    }
    let out = rows().filter(r => filters.every(f => f(r)))
    if (op === 'update') { out.forEach(r => Object.assign(r, payload)); return out }
    for (const [col, asc] of [...orders].reverse()) {
      out = [...out].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1))
    }
    if (range) out = out.slice(range[0], range[1] + 1)
    if (lim !== null) out = out.slice(0, lim)
    return out
  }

  const b: any = {
    select: () => b,
    insert: (p: any) => { op = 'insert'; payload = p; return b },
    update: (p: any) => { op = 'update'; payload = p; return b },
    eq: (c: string, v: any) => { filters.push(r => r[c] === v); return b },
    gte: (c: string, v: any) => { filters.push(r => r[c] >= v); return b },
    lte: (c: string, v: any) => { filters.push(r => r[c] <= v); return b },
    in: (c: string, v: any[]) => { filters.push(r => v.includes(r[c])); return b },
    order: (c: string, o?: { ascending?: boolean }) => { orders.push([c, o?.ascending !== false]); return b },
    limit: (n: number) => { lim = n; return b },
    range: (from: number, to: number) => { range = [from, to]; return b },
    single: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
    maybeSingle: () => Promise.resolve({ data: run()[0] ?? null, error: null }),
    then: (resolve: any, reject: any) => {
      try { const data = run(); resolve({ data, error: null, count: data.length }) } catch (e) { reject(e) }
    },
  }
  return b
}

// RPC results are configured per test; the database logic itself is covered
// by the SQL test suite of 20261006160000_bank_statement_approval.sql.
const rpcResults: Record<string, { data?: any; error?: any }> = {}
const rpc = vi.fn(async (name: string, _args: Row) => rpcResults[name] ?? { data: null, error: null })

const supabase = {
  auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
  from: (t: string) => query(t),
  rpc,
}

const stored = new Map<string, Uint8Array>()
const upload = vi.fn(async (path: string, bytes: Uint8Array, opts: Row) => {
  if (stored.has(path) && !opts.upsert) return { data: null, error: { message: 'The resource already exists' } }
  stored.set(path, bytes)
  return { data: { path }, error: null }
})
const remove = vi.fn(async (paths: string[]) => { paths.forEach(p => stored.delete(p)); return { data: null, error: null } })
const download = vi.fn(async (path: string) =>
  stored.has(path) ? { data: new Blob([stored.get(path)!]), error: null } : { data: null, error: { message: 'not found' } })

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ storage: { from: () => ({ upload, remove, download }) }, from: (t: string) => query(t) }) }))
vi.mock('@/lib/security-access/finance', () => ({ financeAllowed: vi.fn(async () => true) }))
vi.mock('@/lib/server/permissions', () => ({ checkPermissionForUser: async () => ({ allowed: false }) }))

const { POST, GET } = await import('./route')
const item = await import('./[id]/route')
const file = await import('./[id]/file/route')
const { financeAllowed } = await import('@/lib/security-access/finance')

const HEADER = 'Transaction Date,Remarks,Cheque No.,Sender / Receiver Name,Receipient Reference,Other Payment Details,Payment Amount,Credit Amount,Balance,Branch Code'
function statement(rows: string[], period: string, opening: string, account = '11122233344') {
  return [
    'Transaction Details,,,,,,,,,',
    `Account Number / Currency :,${account} MYR,,,,,,,,`,
    'Account Name :,TEST COMPANY SDN. BHD.,,,,,,,,',
    `Statement Period :,${period},,,,,,,,`,
    `Prior Day Balance :,${opening},,,,,,,,`,
    HEADER,
    ...rows,
  ].join('\r\n')
}
// Newest first. Opening 1,000.00 → closing 401.00
const MARCH = [
  '20/03/2026,Profit,,,,,0,1.00,401.00,100',
  '15/03/2026,Instant Transfer,,CUSTOMER B,INV-2,,0,100,400.00,100',
  '15/03/2026,CIB Instant Transfer,,SUPPLIER A,PO-1,,100,0,300.00,100',
  '02/03/2026,Remittance,,SUPPLIER A,PO-1,,800,0,400.00,100',
  '01/03/2026,Instant Transfer,,CUSTOMER C,Paid,,0,200,"1,200.00",100',
]
const FULL_MONTH = statement(MARCH, '01/03/2026-31/03/2026', '"1,000.00"')

const OK_CHECK = { duplicate_file: null, overlap: null, expected_opening_balance: 1000, opening_basis: 'previous_statement', opening_difference: 0, gap_days: 0, reason_required: false, reason_codes: [] }

function form(fields: Record<string, string>, csv: string | null = FULL_MONTH, name = 'Transaction Statement March.csv') {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, v)
  if (csv !== null) f.set('file', new File([csv], name, { type: 'text/csv' }))
  return f
}
const post = (fields: Record<string, string>, csv?: string | null, name?: string) =>
  POST(new Request('http://x/api/accounting/cash/bank-statements', { method: 'POST', body: form(fields, csv, name) }))
const base = { bank_account_id: 'bank-1' }
const ID = '11111111-2222-4333-8444-555555555555'
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) })
const act = (body: Row, id = ID) =>
  item.POST(new Request(`http://x/api/accounting/cash/bank-statements/${id}`, { method: 'POST', body: JSON.stringify(body) }), ctx(id))
const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k]
  for (const k of Object.keys(rpcResults)) delete rpcResults[k]
  stored.clear()
  rpc.mockClear(); upload.mockClear(); remove.mockClear(); download.mockClear()
  db.users = [{ id: 'user-1', organization_id: 'org-1', principal_type: 'INTERNAL_EMPLOYEE', is_active: true, roles: { role_level: 10 } }]
  db.bank_accounts = [
    { id: 'bank-1', company_id: 'org-1', account_name: 'Main', bank_name: 'Hong Leong Bank', account_number: '1112-2233-344', currency_code: 'MYR', is_active: true },
    { id: 'bank-other', company_id: 'org-2', account_name: 'Other', bank_name: 'X', account_number: '11122233344', currency_code: 'MYR', is_active: true },
  ]
  rpcResults.bank_statement_check = { data: OK_CHECK, error: null }
  rpcResults.bank_statement_stage = { data: { status: 'uploaded', reason_required: false, opening_basis: 'previous_statement', opening_difference: 0, expected_opening_balance: 1000 }, error: null }
  vi.mocked(financeAllowed).mockReset()
  vi.mocked(financeAllowed).mockResolvedValue(true)
})

describe('bank statement upload (preview / upload)', () => {
  it('previews a full-month file without writing or storing anything', async () => {
    const res = await post({ ...base, mode: 'preview' })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.can_upload).toBe(true)
    expect(body.blocking).toEqual([])
    expect(body.summary).toMatchObject({
      lines_in_file: 5, period_type: 'monthly', opening_balance: '1000.00', closing_balance: '401.00',
      total_debit: '900.00', total_credit: '301.00', debit_count: 2, credit_count: 3,
      account_number: '••••3344', file_sha256: sha(FULL_MONTH), reason_required: false,
    })
    expect(upload).not.toHaveBeenCalled()
    expect(rpc.mock.calls.map(c => c[0])).toEqual(['bank_statement_check'])
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_bank_account_id: 'bank-1', p_period_start: '2026-03-01', p_period_end: '2026-03-31', p_opening_balance: '1000.00' })
  })

  it('stores the exact uploaded bytes, then records the statement with numbered lines (oldest first)', async () => {
    const res = await post({ ...base, mode: 'upload' })
    const body = await res.json()
    expect(res.status).toBe(201)
    expect(body.status).toBe('uploaded')

    const [path, bytes, opts] = upload.mock.calls[0]
    expect(path).toBe(`org-1/bank-1/${body.import_id}/Transaction_Statement_March.csv`)
    expect(opts).toMatchObject({ upsert: false })
    expect(Buffer.from(bytes).toString('utf8')).toBe(FULL_MONTH)

    const stage = rpc.mock.calls.find(c => c[0] === 'bank_statement_stage')![1] as Row
    expect(stage.p_import_id).toBe(body.import_id)
    expect(stage.p_file).toMatchObject({ file_path: path, file_sha256: sha(FULL_MONTH), file_size: Buffer.byteLength(FULL_MONTH), period_type: 'monthly', closing_balance: '401.00', account_number: '11122233344' })
    expect(stage.p_lines).toHaveLength(5)
    expect(stage.p_lines[0]).toMatchObject({ line_no: 1, source_row_no: 11, transaction_date: '2026-03-01', credit_amount: '200.00', balance: '1200.00' })
    expect(stage.p_lines[4]).toMatchObject({ line_no: 5, source_row_no: 7, transaction_date: '2026-03-20' })
    // The route never writes bank lines itself.
    expect(db.bank_statement_transactions ?? []).toHaveLength(0)
  })

  it('blocks partial periods, duplicate files and overlapping statements', async () => {
    const half = await (await post({ ...base, mode: 'preview' }, statement(MARCH.slice(1), '01/03/2026-15/03/2026', '"1,000.00"'))).json()
    expect(half.can_upload).toBe(false)
    expect(half.blocking[0]).toMatch(/takes monthly statements/)

    rpcResults.bank_statement_check = { data: { ...OK_CHECK, duplicate_file: { import_id: 'x', status: 'completed', period_start: '2026-03-01', period_end: '2026-03-31' } }, error: null }
    const dup = await post({ ...base, mode: 'upload' })
    expect(dup.status).toBe(409)
    expect((await dup.json()).error).toMatch(/already uploaded/)

    rpcResults.bank_statement_check = { data: { ...OK_CHECK, overlap: { import_id: 'y', status: 'pending_approval', period_start: '2026-03-01', period_end: '2026-03-31' } }, error: null }
    const overlap = await (await post({ ...base, mode: 'preview' })).json()
    expect(overlap.blocking[0]).toMatch(/already covers part of this period/)
    expect(upload).not.toHaveBeenCalled()
  })

  it('follows a daily account: accepts days within one month, refuses a period across months', async () => {
    db.bank_accounts[0].statement_frequency = 'daily'
    const days = await (await post({ ...base, mode: 'preview' }, statement(MARCH.slice(1), '01/03/2026-15/03/2026', '"1,000.00"'))).json()
    expect(days.can_upload).toBe(true)
    expect(days.summary).toMatchObject({ statement_frequency: 'daily', period_type: 'daily' })

    const across = await (await post({ ...base, mode: 'preview' }, statement(MARCH.slice(1), '01/03/2026-02/04/2026', '"1,000.00"'))).json()
    expect(across.can_upload).toBe(false)
    expect(across.blocking[0]).toMatch(/within one calendar month/)

    await post({ ...base, mode: 'upload' }, statement(MARCH.slice(1), '01/03/2026-15/03/2026', '"1,000.00"'))
    const stage = rpc.mock.calls.find(c => c[0] === 'bank_statement_stage')![1] as Row
    expect(stage.p_file).toMatchObject({ period_type: 'daily', period_start: '2026-03-01', period_end: '2026-03-15' })
  })

  it('explains an opening balance difference and that a reason will be required', async () => {
    rpcResults.bank_statement_check = { data: { ...OK_CHECK, expected_opening_balance: 900, opening_difference: 100, reason_required: true, reason_codes: ['opening_mismatch'] }, error: null }
    const body = await (await post({ ...base, mode: 'preview' })).json()
    expect(body.can_upload).toBe(true)
    expect(body.summary).toMatchObject({ reason_required: true, opening_difference: 100 })
    expect(body.warnings.some((w: string) => /does not match the expected 900.*difference 100.*reason is required/.test(w))).toBe(true)
  })

  it('removes the stored copy when the database refuses the statement', async () => {
    rpcResults.bank_statement_stage = { data: null, error: { message: 'bank_statement_period_overlap' } }
    const res = await post({ ...base, mode: 'upload' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/already covers part of this period/)
    expect(remove).toHaveBeenCalledTimes(1)
    expect(stored.size).toBe(0)
  })

  it('refuses a file for another account, a broken file, and another company\'s bank account', async () => {
    const wrong = await post({ ...base, mode: 'preview' }, statement(MARCH, '01/03/2026-31/03/2026', '"1,000.00"', '99988877766'))
    expect(wrong.status).toBe(422)
    expect((await wrong.json()).error).toMatch(/This file is for account ••••7766/)

    const broken = await post({ ...base, mode: 'preview' }, statement([MARCH[0], MARCH[2], MARCH[4]], '01/03/2026-31/03/2026', '"1,000.00"'))
    expect(broken.status).toBe(422)

    const other = await post({ bank_account_id: 'bank-other', mode: 'upload' })
    expect(other.status).toBe(404)
    expect(upload).not.toHaveBeenCalled()

    const missing = await post({ ...base, mode: 'upload' }, null)
    expect(missing.status).toBe(400)
  })

  it('requires finance.statement.import to upload; Super Admin is the legacy rule', async () => {
    vi.mocked(financeAllowed).mockResolvedValue(false)
    expect((await post({ ...base, mode: 'upload' })).status).toBe(403)
    const [userId, permission, legacy, org] = vi.mocked(financeAllowed).mock.calls[0]
    expect([userId, permission, org]).toEqual(['user-1', 'finance.statement.import', 'org-1'])
    expect(await legacy()).toBe(false) // role level 10
    db.users[0].roles = { role_level: 1 }
    vi.mocked(financeAllowed).mockClear()
    await post({ ...base, mode: 'upload' })
    expect(await vi.mocked(financeAllowed).mock.calls[0][2]()).toBe(true)
  })
})

describe('bank statement list', () => {
  it('lists every statement state and tells the UI what the user may do', async () => {
    db.bank_statement_imports = [
      { id: 'a', company_id: 'org-1', bank_account_id: 'bank-1', status: 'pending_approval', imported_at: '2026-10-02' },
      { id: 'b', company_id: 'org-1', bank_account_id: 'bank-1', status: 'completed', imported_at: '2026-10-01' },
      { id: 'c', company_id: 'org-2', bank_account_id: 'bank-1', status: 'completed', imported_at: '2026-10-01' },
    ]
    vi.mocked(financeAllowed).mockImplementation(async (_u, p) => p !== 'finance.statement.approve')
    const body = await (await GET(new Request('http://x/api/accounting/cash/bank-statements?bank_account_id=bank-1'))).json()
    expect(body.imports.map((r: Row) => r.id)).toEqual(['a', 'b'])
    expect(body.permissions).toEqual({ can_view_lines: true, can_import: true, can_approve: false })
  })

  it('returns the names of who uploaded and approved, from the same organization only', async () => {
    const U1 = '11111111-1111-4111-8111-111111111111', U2 = '22222222-2222-4222-8222-222222222222', U3 = '33333333-3333-4333-8333-333333333333'
    db.users.push(
      { id: U1, organization_id: 'org-1', full_name: 'Allam', email: 'a@x' },
      { id: U2, organization_id: 'org-1', full_name: '', email: 'b@x' },
      { id: U3, organization_id: 'org-2', full_name: 'Other org', email: 'c@x' },
    )
    db.bank_statement_imports = [
      { id: 'a', company_id: 'org-1', bank_account_id: 'bank-1', status: 'completed', imported_at: '2026-10-02', imported_by: U1, submitted_by: U1, approved_by: U2 },
      { id: 'b', company_id: 'org-1', bank_account_id: 'bank-1', status: 'rejected', imported_at: '2026-10-01', imported_by: U1, rejected_by: U3 },
    ]
    const body = await (await GET(new Request('http://x/api/accounting/cash/bank-statements?bank_account_id=bank-1'))).json()
    expect(body.people).toEqual({ [U1]: 'Allam', [U2]: 'b@x' })
  })

  it('is forbidden without any statement or cash permission', async () => {
    vi.mocked(financeAllowed).mockResolvedValue(false)
    expect((await GET(new Request('http://x/api/accounting/cash/bank-statements?bank_account_id=bank-1'))).status).toBe(403)
  })
})

describe('bank statement actions', () => {
  beforeEach(() => {
    db.bank_statement_imports = [{ id: ID, company_id: 'org-1', bank_account_id: 'bank-1', status: 'pending_approval', file_name: 'march.csv' }]
  })

  it('maps each action to its database function and permission', async () => {
    rpcResults.bank_statement_submit = { data: { status: 'pending_approval' }, error: null }
    rpcResults.bank_statement_approve = { data: { status: 'completed', rows_inserted: 5 }, error: null }
    expect(await (await act({ action: 'submit', reason: 'Opening differs: bank fee' })).json()).toEqual({ status: 'pending_approval' })
    expect(await (await act({ action: 'approve' })).json()).toEqual({ status: 'completed', rows_inserted: 5 })
    await act({ action: 'reject', reason: 'Wrong month' })
    await act({ action: 'reverse', reason: 'Uploaded to the wrong account' })
    expect(rpc.mock.calls).toEqual([
      ['bank_statement_submit', { p_import_id: ID, p_reason: 'Opening differs: bank fee' }],
      ['bank_statement_approve', { p_import_id: ID }],
      ['bank_statement_reject', { p_import_id: ID, p_reason: 'Wrong month' }],
      ['bank_statement_reverse', { p_import_id: ID, p_reason: 'Uploaded to the wrong account' }],
    ])
    expect(vi.mocked(financeAllowed).mock.calls.map(c => c[1])).toEqual([
      'finance.statement.import', 'finance.statement.approve',
      'finance.statement.approve', 'finance.statement.import', 'finance.statement.approve',
    ])
  })

  it('explains the two-person rule when the uploader tries to approve', async () => {
    rpcResults.bank_statement_approve = { data: null, error: { message: 'sod_violation: Bank statement maker/checker', details: 'bank-statement-maker-checker' } }
    const res = await act({ action: 'approve' })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/another person must approve it/)
  })

  it('requires a reason to reject or reverse, and the right permission', async () => {
    expect((await act({ action: 'reject' })).status).toBe(422)
    expect((await act({ action: 'reverse', reason: 'no' })).status).toBe(422)
    vi.mocked(financeAllowed).mockImplementation(async (_u, p) => p === 'finance.statement.import')
    expect((await act({ action: 'approve' })).status).toBe(403)
    expect((await act({ action: 'reject', reason: 'Withdrawn by uploader' })).status).toBe(200) // maker may withdraw
    expect((await act({ action: 'publish' })).status).toBe(400)
    expect(rpc.mock.calls.map(c => c[0])).toEqual(['bank_statement_reject'])
  })

  it('does not act on another company\'s statement or a malformed id', async () => {
    db.bank_statement_imports[0].company_id = 'org-2'
    expect((await act({ action: 'approve' })).status).toBe(404)
    expect((await act({ action: 'approve' }, 'not-a-uuid')).status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('returns the statement with its lines and history, without the storage path', async () => {
    db.bank_statement_imports[0] = { ...db.bank_statement_imports[0], file_path: 'org-1/bank-1/x/march.csv', validation: { warnings: ['w'], reason_codes: ['opening_mismatch'] } }
    db.bank_statement_import_lines = [{ import_id: ID, line_no: 2 }, { import_id: ID, line_no: 1 }]
    db.bank_statement_events = [{ import_id: ID, event: 'uploaded', occurred_at: '1' }]
    const body = await (await item.GET(new Request(`http://x/api/accounting/cash/bank-statements/${ID}`), ctx())).json()
    expect(body.statement).toMatchObject({ id: ID, has_original_file: true, warnings: ['w'], reason_codes: ['opening_mismatch'] })
    expect(body.statement.file_path).toBeUndefined()
    expect(body.lines.map((l: Row) => l.line_no)).toEqual([1, 2])
    expect(body.events).toHaveLength(1)
  })
})

describe('original file download', () => {
  it('serves the stored original only when its hash matches the upload record', async () => {
    const path = 'org-1/bank-1/x/march.csv'
    stored.set(path, new Uint8Array(Buffer.from(FULL_MONTH, 'utf8')))
    db.bank_statement_imports = [{ id: ID, company_id: 'org-1', file_name: 'Transaction Statement March.csv', file_path: path, file_sha256: sha(FULL_MONTH) }]
    const res = await file.GET(new Request('http://x'), ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="Transaction_Statement_March.csv"')
    expect(await res.text()).toBe(FULL_MONTH)

    db.bank_statement_imports[0].file_sha256 = 'f'.repeat(64)
    expect((await file.GET(new Request('http://x'), ctx())).status).toBe(409)
  })

  it('is forbidden without a Finance statement or cash permission', async () => {
    vi.mocked(financeAllowed).mockResolvedValue(false)
    expect((await file.GET(new Request('http://x'), ctx())).status).toBe(403)
    expect(download).not.toHaveBeenCalled()
  })
})
