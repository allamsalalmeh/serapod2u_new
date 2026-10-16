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

const approval = fs.readFileSync(
  path.resolve(__dirname, '../../../../../supabase/migrations/20261006160000_bank_statement_approval.sql'),
  'utf8',
).toLowerCase()

describe('bank statement approval migration', () => {
  it('removes every direct write path for app users; lines are written only on approval', () => {
    expect(approval).toContain('revoke insert, update, delete on table public.bank_statement_transactions from authenticated')
    expect(approval).toContain('revoke insert, update on table public.bank_statement_imports from authenticated')
    expect(approval.match(/insert into public\.bank_statement_transactions/g)).toHaveLength(1)
    expect(approval).toMatch(/create or replace function public\.bank_statement_approve[\s\S]*insert into public\.bank_statement_transactions/)
  })

  it('enforces maker/checker in the approval function', () => {
    expect(approval).toMatch(/sa_enforce_same_document_sod\('bank-statement-maker-checker', p_import_id::text, v_actor,\s*array_remove\(array\[v_imp\.imported_by, v_imp\.submitted_by\], null\)\)/)
  })

  it('keeps the original file private and its content immutable', () => {
    expect(approval).toMatch(/insert into storage\.buckets[^;]*'bank-statements', 'bank-statements', false/)
    expect(approval).not.toMatch(/create policy[^;]*on storage\.objects/)
    expect(approval).toContain('bank_statement_imports_file_once')
    expect(approval).toMatch(/bank_statement_import_lines_append_only before update or delete/)
    expect(approval).toMatch(/bank_statement_events_append_only before update or delete/)
  })

  it('locks the account opening balance and statement frequency to Super Admin and logs every change', () => {
    expect(approval).toMatch(/create trigger bank_accounts_opening_balance_guard\s+before update of opening_balance, opening_balance_date, statement_frequency on public\.bank_accounts/)
    expect(approval).toContain('sa_legacy_is_super_admin(v_actor)')
    expect(approval).toContain("'opening_balance_changed'")
    expect(approval).toContain("'statement_frequency_changed'")
  })

  it('accepts monthly or daily statements according to the bank account', () => {
    expect(approval).toContain("check (statement_frequency in ('monthly','daily'))")
    expect(approval).toContain("v_type  := v_acc.statement_frequency;")
    expect(approval).toContain('bank_statement_not_full_month')
    expect(approval).toContain('bank_statement_period_crosses_month')
    expect(approval).toContain('bank_statement_period_in_future')
  })
})
