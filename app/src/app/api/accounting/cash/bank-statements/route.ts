import { createHash, randomUUID } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  centsToAmount,
  normalizeAccountNumber,
  parseHlbStatementCsv,
  statementPeriodError,
  statementPeriodType,
  type BankStatementLine,
  type StatementFrequency,
} from '@/lib/finance/bank-statements/hlb-csv'
import {
  CASH_VIEW,
  MAX_STATEMENT_BYTES,
  STATEMENT_APPROVE,
  STATEMENT_BUCKET,
  STATEMENT_IMPORT,
  loadStatementContext,
  maskAccount,
  statementErrorResponse,
  statementFilePath,
  loadPeopleNames,
} from '@/lib/finance/bank-statements/server'
import { NextResponse } from 'next/server'

/**
 * GET  /api/accounting/cash/bank-statements?bank_account_id=… — statements (all states) and approved lines
 * POST /api/accounting/cash/bank-statements — multipart/form-data:
 *        bank_account_id, mode ('preview' | 'upload'), file (the bank's CSV, unchanged)
 *
 *   preview  validates the file and returns a summary; nothing is written.
 *   upload   stores the original file (private bucket 'bank-statements', never
 *            overwritten), then records the statement as 'uploaded' through
 *            bank_statement_stage(), which re-validates every line in the
 *            database. Lines reach bank_statement_transactions only when a
 *            second person approves (see ./[id]/route.ts).
 *
 * Read-only bank data: nothing is sent to the bank and bank balances are not changed.
 */

const IMPORT_COLUMNS = [
  'id', 'source_format', 'file_name', 'file_size', 'period_type', 'period_start', 'period_end',
  'opening_balance', 'closing_balance', 'total_debit', 'total_credit', 'rows_in_file', 'rows_inserted', 'rows_skipped',
  'expected_opening_balance', 'opening_difference', 'opening_basis', 'reason_required', 'mismatch_reason',
  'status', 'imported_by', 'imported_at', 'submitted_by', 'submitted_at', 'approved_by', 'approved_at',
  'rejected_by', 'rejected_at', 'rejection_reason', 'reversed_by', 'reversed_at', 'reversal_reason',
].join(', ')

export async function GET(request: Request) {
  try {
    const ctx = await loadStatementContext()
    if ('error' in ctx) return ctx.error
    const { db, orgId, user, allowed } = ctx
    const [canView, canImport, canApprove] = await Promise.all([allowed(CASH_VIEW), allowed(STATEMENT_IMPORT), allowed(STATEMENT_APPROVE)])
    if (!canView && !canImport && !canApprove) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { searchParams } = new URL(request.url)
    const bankAccountId = searchParams.get('bank_account_id')
    if (!bankAccountId) return NextResponse.json({ error: 'bank_account_id is required' }, { status: 400 })
    const from = searchParams.get('from')
    const to = searchParams.get('to')
    const limit = Math.min(Math.max(Number(searchParams.get('limit')) || 200, 1), 1000)

    const { data: imports, error: importsError } = await db
      .from('bank_statement_imports')
      .select(IMPORT_COLUMNS)
      .eq('company_id', orgId)
      .eq('bank_account_id', bankAccountId)
      .order('imported_at', { ascending: false })
      .limit(50)
    if (importsError) return NextResponse.json({ error: importsError.message }, { status: 500 })

    let transactions: any[] = []
    let total = 0
    if (canView) {
      let query = db
        .from('bank_statement_transactions')
        .select('id, import_id, transaction_date, day_sequence, description, cheque_no, counterparty, reference, payment_details, debit_amount, credit_amount, balance, branch_code', { count: 'exact' })
        .eq('company_id', orgId)
        .eq('bank_account_id', bankAccountId)
        .order('transaction_date', { ascending: false })
        .order('day_sequence', { ascending: false })
        .limit(limit)
      if (from) query = query.gte('transaction_date', from)
      if (to) query = query.lte('transaction_date', to)
      const { data, count, error: txError } = await query
      if (txError) return NextResponse.json({ error: txError.message }, { status: 500 })
      transactions = data || []
      total = count ?? 0
    }

    const people = await loadPeopleNames(orgId, (imports || []).flatMap((i: any) =>
      [i.imported_by, i.submitted_by, i.approved_by, i.rejected_by, i.reversed_by]))

    return NextResponse.json({
      imports: imports || [],
      people,
      transactions,
      total,
      permissions: { can_view_lines: canView, can_import: canImport, can_approve: canApprove },
      user_id: user.id,
    })
  } catch (error) {
    console.error('Error in bank statements list API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await loadStatementContext()
    if ('error' in ctx) return ctx.error
    const { db, orgId, allowed } = ctx
    if (!(await allowed(STATEMENT_IMPORT))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const form = await request.formData().catch(() => null)
    const file = form?.get('file')
    const bankAccountId = String(form?.get('bank_account_id') ?? '')
    const mode = form?.get('mode') === 'upload' ? 'upload' : 'preview'
    if (!bankAccountId || !file || typeof file === 'string') {
      return NextResponse.json({ error: 'Bank account and statement file are required' }, { status: 400 })
    }
    if (file.size <= 0) return NextResponse.json({ error: 'The statement file is empty' }, { status: 400 })
    if (file.size > MAX_STATEMENT_BYTES) {
      return NextResponse.json({ error: 'Statement file is too large (max 2 MB)' }, { status: 413 })
    }

    // The exact bytes received are hashed and (on upload) stored unchanged.
    const bytes = new Uint8Array(await file.arrayBuffer())
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const fileName = (file.name || 'statement.csv').slice(0, 255)

    const { data: bank } = await db
      .from('bank_accounts')
      .select('id, company_id, account_name, bank_name, account_number, currency_code, is_active, statement_frequency')
      .eq('id', bankAccountId)
      .eq('company_id', orgId)
      .maybeSingle()
    if (!bank) return NextResponse.json({ error: 'Bank account not found' }, { status: 404 })
    if (!bank.is_active) return NextResponse.json({ error: 'Bank account is inactive' }, { status: 400 })

    const parsed = parseHlbStatementCsv(new TextDecoder('utf-8').decode(bytes))
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

    const frequency: StatementFrequency = bank.statement_frequency === 'daily' ? 'daily' : 'monthly'
    const periodType = statementPeriodType(meta.periodStart, meta.periodEnd)
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kuala_Lumpur' }).format(new Date())
    const opening = centsToAmount(meta.openingBalanceCents ?? 0)
    const closing = centsToAmount(parsed.closingBalanceCents ?? 0)

    const { data: check, error: checkError } = await db.rpc('bank_statement_check', {
      p_bank_account_id: bank.id,
      p_period_start: meta.periodStart,
      p_period_end: meta.periodEnd,
      p_file_sha256: sha256,
      p_opening_balance: opening,
    })
    if (checkError) return statementErrorResponse(checkError)

    const blocking: string[] = []
    const periodError = statementPeriodError(frequency, meta.periodStart, meta.periodEnd, today)
    if (periodError) blocking.push(periodError)
    else if (check?.period_error) blocking.push('The statement period does not match this account\'s statement frequency.')
    if (check?.duplicate_file) {
      blocking.push(`This exact file was already uploaded (statement ${check.duplicate_file.period_start} to ${check.duplicate_file.period_end}, status ${check.duplicate_file.status}).`)
    } else if (check?.overlap) {
      blocking.push(`A statement for ${check.overlap.period_start} to ${check.overlap.period_end} (status ${check.overlap.status}) already covers part of this period.`)
    }

    const warnings = [...parsed.warnings]
    for (const code of (check?.reason_codes ?? []) as string[]) {
      if (code === 'opening_mismatch') {
        warnings.push(`Opening balance ${opening} does not match the expected ${check.expected_opening_balance} (${check.opening_basis === 'previous_statement' ? 'closing balance of the previous statement' : 'account opening balance'}); difference ${check.opening_difference}. A reason is required to submit.`)
      } else if (code === 'period_gap') {
        warnings.push(`There is a gap of ${check.gap_days} day(s) before this statement. A reason is required to submit.`)
      } else if (code === 'no_opening_basis') {
        warnings.push('There is no previous statement and no account opening balance date to compare the opening balance with. A reason is required to submit.')
      }
    }

    const summary = {
      bank_account_label: `${bank.bank_name} - ${bank.account_name}`,
      account_number: maskAccount(meta.accountNumber),
      account_name: meta.accountName,
      currency: meta.currency,
      file_name: fileName,
      file_size: file.size,
      file_sha256: sha256,
      period_type: periodType,
      statement_frequency: frequency,
      period_start: meta.periodStart,
      period_end: meta.periodEnd,
      opening_balance: opening,
      closing_balance: closing,
      total_debit: centsToAmount(parsed.totalDebitCents),
      total_credit: centsToAmount(parsed.totalCreditCents),
      debit_count: lines.filter(l => l.debitCents > 0).length,
      credit_count: lines.filter(l => l.creditCents > 0).length,
      lines_in_file: lines.length,
      expected_opening_balance: check?.expected_opening_balance ?? null,
      opening_basis: check?.opening_basis ?? 'none',
      opening_difference: check?.opening_difference ?? null,
      reason_required: Boolean(check?.reason_required),
    }

    if (mode === 'preview') {
      return NextResponse.json({
        summary,
        warnings,
        blocking,
        can_upload: blocking.length === 0,
        sample: lines.slice(-20).reverse().map(toPreviewRow),
      })
    }
    if (blocking.length) {
      return NextResponse.json({ error: blocking[0], blocking, summary }, { status: 409 })
    }

    // 1. Store the original file (never overwritten). 2. Record + re-validate in the database.
    const importId = randomUUID()
    const filePath = statementFilePath(bank.company_id, bank.id, importId, fileName)
    const admin = createAdminClient(30_000)
    const { error: storeError } = await admin.storage.from(STATEMENT_BUCKET).upload(filePath, bytes, {
      contentType: 'text/csv',
      upsert: false,
    })
    if (storeError) {
      console.error('Error storing bank statement file:', storeError)
      return NextResponse.json({ error: 'The original file could not be stored. Try again.' }, { status: 500 })
    }

    const { data: staged, error: stageError } = await db.rpc('bank_statement_stage', {
      p_import_id: importId,
      p_bank_account_id: bank.id,
      p_file: {
        file_name: fileName,
        file_path: filePath,
        file_size: file.size,
        file_sha256: sha256,
        source_format: parsed.format,
        period_type: frequency,
        period_start: meta.periodStart,
        period_end: meta.periodEnd,
        opening_balance: opening,
        closing_balance: closing,
        account_number: meta.accountNumber,
        currency_code: meta.currency,
        warnings: parsed.warnings,
      },
      p_lines: lines.map(toStageLine),
    })
    if (stageError) {
      // The statement was refused, so no record points to the stored copy:
      // remove the orphan object (an accepted upload is never removed).
      await admin.storage.from(STATEMENT_BUCKET).remove([filePath]).catch(() => undefined)
      return statementErrorResponse(stageError)
    }

    return NextResponse.json({ import_id: importId, status: 'uploaded', summary: { ...summary, ...pickStaged(staged) }, warnings }, { status: 201 })
  } catch (error) {
    console.error('Error in bank statement upload API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

function pickStaged(staged: any) {
  if (!staged || typeof staged !== 'object') return {}
  const { expected_opening_balance, opening_difference, opening_basis, reason_required } = staged
  return { expected_opening_balance, opening_difference, opening_basis, reason_required }
}

function toStageLine(line: BankStatementLine, index: number) {
  return {
    line_no: index + 1,
    source_row_no: line.sourceRowNo,
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
