import { financeAllowed } from '@/lib/security-access/finance'
import { createClient } from '@/lib/supabase/server'
import { checkPermissionForUser } from '@/lib/server/permissions'
import { isCanonicalStaff } from '@/lib/identity/staff'
import {
  centsToAmount,
  normalizeAccountNumber,
  parseAmountCents,
  parseHlbStatementCsv,
  type BankStatementLine,
} from '@/lib/finance/bank-statements/hlb-csv'
import { NextResponse } from 'next/server'

/**
 * GET  /api/accounting/cash/bank-statements?bank_account_id=… — imports and stored lines
 * POST /api/accounting/cash/bank-statements — { bank_account_id, file_name, csv_text, mode: 'preview' | 'import' }
 *
 * Read-only bank data: lines come from the bank's exported statement file.
 * Nothing is sent to the bank and bank_accounts balances are not changed.
 */

const MAX_CSV_BYTES = 2 * 1024 * 1024
const PAGE = 1000
const INSERT_CHUNK = 500

async function loadContext() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const { data: profile } = await (supabase as any)
    .from('users')
    .select('id, organization_id, principal_type, is_active, account_status, roles:role_code ( role_level )')
    .eq('id', user.id)
    .single()
  if (!profile?.organization_id) return { error: NextResponse.json({ error: 'User has no organization' }, { status: 400 }) }

  const role = Array.isArray((profile as any).roles) ? (profile as any).roles[0] : (profile as any).roles
  const legacyFinanceUser = async () =>
    isCanonicalStaff(profile as any, role?.role_level, 40) || (await checkPermissionForUser(user.id, 'view_settings')).allowed
  return { supabase, user, orgId: profile.organization_id as string, legacyFinanceUser }
}

function maskAccount(value: string | null | undefined) {
  const digits = normalizeAccountNumber(value)
  return digits.length > 4 ? `••••${digits.slice(-4)}` : digits
}

const amount = (v: unknown) => parseAmountCents(String(v ?? '')) ?? 0

export async function GET(request: Request) {
  try {
    const ctx = await loadContext()
    if (ctx.error) return ctx.error
    const { supabase, user, orgId, legacyFinanceUser } = ctx
    if (!(await financeAllowed(user.id, 'finance.cash.view', legacyFinanceUser, orgId))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const bankAccountId = searchParams.get('bank_account_id')
    if (!bankAccountId) return NextResponse.json({ error: 'bank_account_id is required' }, { status: 400 })
    const from = searchParams.get('from')
    const to = searchParams.get('to')
    const limit = Math.min(Math.max(Number(searchParams.get('limit')) || 200, 1), 1000)

    const db = supabase as any
    const { data: imports, error: importsError } = await db
      .from('bank_statement_imports')
      .select('id, source_format, file_name, period_start, period_end, opening_balance, closing_balance, rows_in_file, rows_inserted, rows_skipped, status, imported_at')
      .eq('company_id', orgId)
      .eq('bank_account_id', bankAccountId)
      .order('imported_at', { ascending: false })
      .limit(50)
    if (importsError) return NextResponse.json({ error: importsError.message }, { status: 500 })

    let query = db
      .from('bank_statement_transactions')
      .select('id, transaction_date, day_sequence, description, cheque_no, counterparty, reference, payment_details, debit_amount, credit_amount, balance, branch_code', { count: 'exact' })
      .eq('company_id', orgId)
      .eq('bank_account_id', bankAccountId)
      .order('transaction_date', { ascending: false })
      .order('day_sequence', { ascending: false })
      .limit(limit)
    if (from) query = query.gte('transaction_date', from)
    if (to) query = query.lte('transaction_date', to)
    const { data: transactions, count, error: txError } = await query
    if (txError) return NextResponse.json({ error: txError.message }, { status: 500 })

    return NextResponse.json({ imports: imports || [], transactions: transactions || [], total: count ?? 0 })
  } catch (error) {
    console.error('Error in bank statements list API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await loadContext()
    if (ctx.error) return ctx.error
    const { supabase, user, orgId, legacyFinanceUser } = ctx
    if (!(await financeAllowed(user.id, 'finance.reconciliation.perform', legacyFinanceUser, orgId))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const body = await request.json().catch(() => null)
    const bankAccountId = typeof body?.bank_account_id === 'string' ? body.bank_account_id : ''
    const csvText = typeof body?.csv_text === 'string' ? body.csv_text : ''
    const fileName = typeof body?.file_name === 'string' ? body.file_name.slice(0, 255) : null
    const mode = body?.mode === 'import' ? 'import' : 'preview'
    if (!bankAccountId || !csvText) {
      return NextResponse.json({ error: 'Bank account and statement file are required' }, { status: 400 })
    }
    if (Buffer.byteLength(csvText, 'utf8') > MAX_CSV_BYTES) {
      return NextResponse.json({ error: 'Statement file is too large (max 2 MB)' }, { status: 413 })
    }

    const db = supabase as any
    const { data: bank } = await db
      .from('bank_accounts')
      .select('id, account_name, bank_name, account_number, currency_code, is_active')
      .eq('id', bankAccountId)
      .eq('company_id', orgId)
      .maybeSingle()
    if (!bank) return NextResponse.json({ error: 'Bank account not found' }, { status: 404 })
    if (!bank.is_active) return NextResponse.json({ error: 'Bank account is inactive' }, { status: 400 })

    const parsed = parseHlbStatementCsv(csvText)
    if (parsed.errors.length) {
      return NextResponse.json({ error: 'The statement file cannot be imported', errors: parsed.errors }, { status: 422 })
    }
    const { meta, lines } = parsed
    if (normalizeAccountNumber(bank.account_number) !== meta.accountNumber) {
      return NextResponse.json({
        error: `This file is for account ${maskAccount(meta.accountNumber)}, but the selected bank account is ${maskAccount(bank.account_number)}.`,
      }, { status: 422 })
    }
    if (meta.currency && bank.currency_code && meta.currency !== bank.currency_code) {
      return NextResponse.json({ error: `File currency ${meta.currency} does not match the bank account currency ${bank.currency_code}.` }, { status: 422 })
    }

    // Lines already stored for the file's period (delta detection)
    const stored: { dedupe_key: string }[] = []
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await db
        .from('bank_statement_transactions')
        .select('dedupe_key')
        .eq('bank_account_id', bank.id)
        .gte('transaction_date', meta.periodStart)
        .lte('transaction_date', meta.periodEnd)
        .order('id')
        .range(offset, offset + PAGE - 1)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      stored.push(...(data || []))
      if (!data || data.length < PAGE) break
    }
    const storedKeys = new Set(stored.map(r => r.dedupe_key))
    const fileKeys = new Set(lines.map(l => l.dedupeKey))
    const newLines = lines.filter(l => !storedKeys.has(l.dedupeKey))
    const storedNotInFile = stored.filter(r => !fileKeys.has(r.dedupe_key)).length

    const warnings = [...parsed.warnings]
    if (storedNotInFile) {
      warnings.push(`${storedNotInFile} line(s) already stored for this period are not in this file. Check that the file covers whole days and is the right statement.`)
    }
    const { data: before } = await db
      .from('bank_statement_transactions')
      .select('transaction_date, balance')
      .eq('bank_account_id', bank.id)
      .lt('transaction_date', meta.periodStart)
      .order('transaction_date', { ascending: false })
      .order('day_sequence', { ascending: false })
      .limit(1)
    if (before?.[0] && amount(before[0].balance) !== meta.openingBalanceCents) {
      warnings.push(`Gap before this statement: the last stored balance (${before[0].transaction_date}) is ${centsToAmount(amount(before[0].balance))}, but this file starts from ${centsToAmount(meta.openingBalanceCents ?? 0)}. A period may be missing.`)
    }
    const { data: after } = await db
      .from('bank_statement_transactions')
      .select('transaction_date, balance, debit_amount, credit_amount')
      .eq('bank_account_id', bank.id)
      .gt('transaction_date', meta.periodEnd)
      .order('transaction_date', { ascending: true })
      .order('day_sequence', { ascending: true })
      .limit(1)
    if (after?.[0] && parsed.closingBalanceCents !== null) {
      const expectedBefore = amount(after[0].balance) + amount(after[0].debit_amount) - amount(after[0].credit_amount)
      if (expectedBefore !== parsed.closingBalanceCents) {
        warnings.push(`Gap after this statement: the next stored line (${after[0].transaction_date}) does not continue from this file's closing balance ${centsToAmount(parsed.closingBalanceCents)}.`)
      }
    }

    const summary = {
      bank_account_label: `${bank.bank_name} - ${bank.account_name}`,
      account_number: maskAccount(meta.accountNumber),
      account_name: meta.accountName,
      currency: meta.currency,
      period_start: meta.periodStart,
      period_end: meta.periodEnd,
      opening_balance: centsToAmount(meta.openingBalanceCents ?? 0),
      closing_balance: centsToAmount(parsed.closingBalanceCents ?? 0),
      total_debit: centsToAmount(parsed.totalDebitCents),
      total_credit: centsToAmount(parsed.totalCreditCents),
      lines_in_file: lines.length,
      new_lines: newLines.length,
      already_imported: lines.length - newLines.length,
    }

    if (mode === 'preview') {
      return NextResponse.json({
        summary,
        warnings,
        sample: newLines.slice(-20).reverse().map(toPreviewRow),
      })
    }

    const { data: importRow, error: importError } = await db
      .from('bank_statement_imports')
      .insert({
        company_id: orgId,
        bank_account_id: bank.id,
        source_format: parsed.format,
        file_name: fileName,
        period_start: meta.periodStart,
        period_end: meta.periodEnd,
        opening_balance: centsToAmount(meta.openingBalanceCents ?? 0),
        closing_balance: centsToAmount(parsed.closingBalanceCents ?? 0),
        rows_in_file: lines.length,
        imported_by: user.id,
      })
      .select('id')
      .single()
    if (importError || !importRow) {
      console.error('Error creating bank statement import:', importError)
      return NextResponse.json({ error: importError?.message || 'Failed to record the import' }, { status: 500 })
    }

    let inserted = 0
    try {
      for (let i = 0; i < newLines.length; i += INSERT_CHUNK) {
        const chunk = newLines.slice(i, i + INSERT_CHUNK).map(l => toRow(l, orgId, bank.id, importRow.id))
        const { data, error } = await db
          .from('bank_statement_transactions')
          .upsert(chunk, { onConflict: 'bank_account_id,dedupe_key', ignoreDuplicates: true })
          .select('id')
        if (error) throw error
        inserted += data?.length ?? 0
      }
    } catch (error: any) {
      console.error('Error inserting bank statement lines:', error)
      await db.from('bank_statement_imports')
        .update({ status: 'failed', rows_inserted: inserted, rows_skipped: lines.length - inserted })
        .eq('id', importRow.id)
      return NextResponse.json({
        error: `Import stopped after ${inserted} line(s): ${error?.message || 'database error'}. Importing the same file again continues safely.`,
      }, { status: 500 })
    }

    await db.from('bank_statement_imports')
      .update({ status: 'completed', rows_inserted: inserted, rows_skipped: lines.length - inserted })
      .eq('id', importRow.id)

    return NextResponse.json({
      summary: { ...summary, new_lines: inserted, already_imported: lines.length - inserted },
      warnings,
      import_id: importRow.id,
    }, { status: 201 })
  } catch (error) {
    console.error('Error in bank statement import API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

function toRow(line: BankStatementLine, companyId: string, bankAccountId: string, importId: string) {
  return {
    company_id: companyId,
    bank_account_id: bankAccountId,
    import_id: importId,
    transaction_date: line.transactionDate,
    day_sequence: line.daySequence,
    description: line.description,
    cheque_no: line.chequeNo,
    counterparty: line.counterparty,
    reference: line.reference,
    payment_details: line.paymentDetails,
    debit_amount: centsToAmount(line.debitCents),
    credit_amount: centsToAmount(line.creditCents),
    balance: centsToAmount(line.balanceCents),
    branch_code: line.branchCode,
    dedupe_key: line.dedupeKey,
  }
}

function toPreviewRow(line: BankStatementLine) {
  return {
    transaction_date: line.transactionDate,
    description: line.description,
    counterparty: line.counterparty,
    reference: line.reference,
    debit_amount: centsToAmount(line.debitCents),
    credit_amount: centsToAmount(line.creditCents),
    balance: centsToAmount(line.balanceCents),
  }
}
