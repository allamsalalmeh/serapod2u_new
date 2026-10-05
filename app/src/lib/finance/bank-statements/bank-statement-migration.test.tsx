import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const sql = fs.readFileSync(
  path.resolve(__dirname, '../../../../../supabase/migrations/20261005130000_bank_statement_import.sql'),
  'utf8',
).toLowerCase()

describe('bank statement import migration', () => {
  it('makes overlapping imports add only new lines', () => {
    expect(sql).toContain('unique (bank_account_id, dedupe_key)')
  })

  it('keeps imported lines read-only for app users', () => {
    expect(sql).toContain('revoke all on table public.bank_statement_transactions from public, anon, authenticated')
    expect(sql).toContain('grant select, insert on table public.bank_statement_transactions to authenticated')
    expect(sql).not.toMatch(/grant[^;]*(update|delete)[^;]*bank_statement_transactions to authenticated/)
    expect(sql).not.toMatch(/grant[^;]*delete[^;]*bank_statement_imports to authenticated/)
  })

  it('gates both tables like the existing bank tables', () => {
    for (const table of ['bank_statement_imports', 'bank_statement_transactions']) {
      expect(sql).toContain(`alter table public.${table} enable row level security`)
      expect(sql).toContain(`create policy ${table}_company_access on public.${table}`)
      expect(sql).toContain(`create policy sa_finance_cash_view on public.${table} for select`)
    }
    expect(sql).toContain("sa_rls_gate('finance.reconciliation.perform'")
    expect(sql).toContain("sa_rls_gate('finance.cash.view'")
  })

  it('does not alter existing bank tables', () => {
    expect(sql).not.toMatch(/alter table public\.bank_(accounts|reconciliations|reconciliation_lines)/)
    expect(sql).not.toMatch(/drop table(?! if exists public\.bank_statement)/)
  })
})
