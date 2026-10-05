import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, any>
const db: Record<string, Row[]> = {}
let nextId = 1

function query(table: string) {
  const filters: ((r: Row) => boolean)[] = []
  let op: 'select' | 'insert' | 'upsert' | 'update' = 'select'
  let payload: any = null
  let upsertKeys: string[] = []
  let lim: number | null = null
  let range: [number, number] | null = null
  const orders: [string, boolean][] = []
  const rows = () => (db[table] ||= [])

  const run = () => {
    if (op === 'insert' || op === 'upsert') {
      const list: Row[] = (Array.isArray(payload) ? payload : [payload]).map((r: Row) => ({ id: `id-${nextId++}`, ...r }))
      const added: Row[] = []
      for (const r of list) {
        if (op === 'upsert' && rows().some(e => upsertKeys.every(k => e[k] === r[k]))) continue
        rows().push(r)
        added.push(r)
      }
      return added
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
    upsert: (p: any, o: any) => { op = 'upsert'; payload = p; upsertKeys = o.onConflict.split(','); return b },
    update: (p: any) => { op = 'update'; payload = p; return b },
    eq: (c: string, v: any) => { filters.push(r => r[c] === v); return b },
    gte: (c: string, v: any) => { filters.push(r => r[c] >= v); return b },
    lte: (c: string, v: any) => { filters.push(r => r[c] <= v); return b },
    lt: (c: string, v: any) => { filters.push(r => r[c] < v); return b },
    gt: (c: string, v: any) => { filters.push(r => r[c] > v); return b },
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

const supabase = {
  auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
  from: (t: string) => query(t),
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))
vi.mock('@/lib/security-access/finance', () => ({ financeAllowed: vi.fn(async () => true) }))
vi.mock('@/lib/server/permissions', () => ({ checkPermissionForUser: async () => ({ allowed: false }) }))

const { POST, GET } = await import('./route')
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
  ].join('\n')
}
// Newest first. Opening 1,000.00
const ALL = [
  '20/03/2026,Profit,,,,,0,1.00,401.00,100',
  '15/03/2026,Instant Transfer,,CUSTOMER B,INV-2,,0,100,400.00,100',
  '15/03/2026,CIB Instant Transfer,,SUPPLIER A,PO-1,,100,0,300.00,100',
  '02/03/2026,Remittance,,SUPPLIER A,PO-1,,800,0,400.00,100',
  '01/03/2026,Instant Transfer,,CUSTOMER C,Paid,,0,200,"1,200.00",100',
]
const FIRST = statement(ALL.slice(1), '01/03/2026-15/03/2026', '"1,000.00"')
const SECOND = statement(ALL.slice(0, 3), '10/03/2026-20/03/2026', '400.00')

const post = (body: Row) => POST(new Request('http://x/api/accounting/cash/bank-statements', { method: 'POST', body: JSON.stringify(body) }))
const base = { bank_account_id: 'bank-1', file_name: 'stmt.csv' }

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k]
  db.users = [{ id: 'user-1', organization_id: 'org-1', principal_type: 'INTERNAL_EMPLOYEE', is_active: true, roles: { role_level: 10 } }]
  db.bank_accounts = [
    { id: 'bank-1', company_id: 'org-1', account_name: 'Main', bank_name: 'Hong Leong Bank', account_number: '1112-2233-344', currency_code: 'MYR', is_active: true },
    { id: 'bank-other', company_id: 'org-2', account_name: 'Other', bank_name: 'X', account_number: '11122233344', currency_code: 'MYR', is_active: true },
  ]
  vi.mocked(financeAllowed).mockClear()
  vi.mocked(financeAllowed).mockResolvedValue(true)
})

describe('bank statement import API', () => {
  it('previews without writing anything', async () => {
    const res = await post({ ...base, csv_text: FIRST, mode: 'preview' })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.summary).toMatchObject({ lines_in_file: 4, new_lines: 4, already_imported: 0, opening_balance: '1000.00', closing_balance: '400.00', account_number: '••••3344' })
    expect(db.bank_statement_transactions ?? []).toHaveLength(0)
    expect(db.bank_statement_imports ?? []).toHaveLength(0)
  })

  it('imports, then adds only the new lines of an overlapping statement, then nothing on re-import', async () => {
    const first = await (await post({ ...base, csv_text: FIRST, mode: 'import' })).json()
    expect(first.summary).toMatchObject({ new_lines: 4, already_imported: 0 })
    expect(db.bank_statement_transactions).toHaveLength(4)
    expect(db.bank_statement_imports[0]).toMatchObject({ status: 'completed', rows_inserted: 4, rows_skipped: 0, company_id: 'org-1', imported_by: 'user-1' })

    const preview = await (await post({ ...base, csv_text: SECOND, mode: 'preview' })).json()
    expect(preview.summary).toMatchObject({ lines_in_file: 3, new_lines: 1, already_imported: 2 })
    expect(preview.warnings).toEqual([])

    await post({ ...base, csv_text: SECOND, mode: 'import' })
    expect(db.bank_statement_transactions).toHaveLength(5)
    expect(db.bank_statement_transactions.map(r => r.balance).sort()).toEqual(['1200.00', '300.00', '400.00', '400.00', '401.00'].sort())

    const again = await (await post({ ...base, csv_text: FIRST, mode: 'preview' })).json()
    expect(again.summary).toMatchObject({ new_lines: 0, already_imported: 4 })
  })

  it('warns about a missing period between statements', async () => {
    await post({ ...base, csv_text: statement(ALL.slice(3), '01/03/2026-02/03/2026', '"1,000.00"'), mode: 'import' })
    const later = await (await post({ ...base, csv_text: statement(['20/03/2026,Profit,,,,,0,1.00,301.00,100'], '20/03/2026-20/03/2026', '300.00'), mode: 'preview' })).json()
    expect(later.warnings.some((w: string) => /Gap before this statement/.test(w))).toBe(true)
  })

  it('refuses a file for another account, a broken file, and another company\'s bank account', async () => {
    const wrong = await post({ ...base, csv_text: statement(ALL.slice(1), '01/03/2026-15/03/2026', '"1,000.00"', '99988877766'), mode: 'preview' })
    expect(wrong.status).toBe(422)
    expect((await wrong.json()).error).toMatch(/This file is for account ••••7766/)

    const broken = await post({ ...base, csv_text: statement([ALL[1], ALL[3], ALL[4]], '01/03/2026-15/03/2026', '"1,000.00"'), mode: 'preview' })
    expect(broken.status).toBe(422)

    const other = await post({ ...base, bank_account_id: 'bank-other', csv_text: FIRST, mode: 'import' })
    expect(other.status).toBe(404)
    expect(db.bank_statement_transactions ?? []).toHaveLength(0)
  })

  it('requires the Finance permissions', async () => {
    vi.mocked(financeAllowed).mockResolvedValue(false)
    expect((await post({ ...base, csv_text: FIRST, mode: 'import' })).status).toBe(403)
    expect((await GET(new Request('http://x/api/accounting/cash/bank-statements?bank_account_id=bank-1'))).status).toBe(403)
    expect(vi.mocked(financeAllowed).mock.calls.map(c => c[1])).toEqual(['finance.reconciliation.perform', 'finance.cash.view'])
  })
})
