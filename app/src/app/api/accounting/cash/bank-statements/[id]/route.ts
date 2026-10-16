import {
  CASH_VIEW,
  STATEMENT_APPROVE,
  STATEMENT_IMPORT,
  UUID_RE,
  loadStatementContext,
  statementErrorResponse,
} from '@/lib/finance/bank-statements/server'
import { NextResponse } from 'next/server'

/**
 * GET  /api/accounting/cash/bank-statements/:id — statement header, its lines (?offset, ?limit) and event history
 * POST /api/accounting/cash/bank-statements/:id — { action, reason? }
 *
 *   submit   (finance.statement.import)   uploaded → pending_approval; reason required
 *                                          when the opening balance differs, there is a gap or no basis
 *   approve  (finance.statement.approve)  pending_approval → completed; writes the bank lines.
 *                                          Never by the person who uploaded or submitted it.
 *   reject   (finance.statement.approve, or the uploader/submitter to withdraw) → rejected
 *   reverse  (finance.statement.approve)  completed → reversed; latest statement of the account only
 *
 * Every action runs in a database function that re-checks the permission,
 * the state and the maker/checker rule; this route is the first gate only.
 */

type Action = 'submit' | 'approve' | 'reject' | 'reverse'
const ACTIONS: Record<Action, { rpc: string; permissions: string[]; reason: boolean }> = {
  submit: { rpc: 'bank_statement_submit', permissions: [STATEMENT_IMPORT], reason: false },
  approve: { rpc: 'bank_statement_approve', permissions: [STATEMENT_APPROVE], reason: false },
  reject: { rpc: 'bank_statement_reject', permissions: [STATEMENT_APPROVE, STATEMENT_IMPORT], reason: true },
  reverse: { rpc: 'bank_statement_reverse', permissions: [STATEMENT_APPROVE], reason: true },
}

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Statement not found' }, { status: 404 })
    const ctx = await loadStatementContext()
    if ('error' in ctx) return ctx.error
    const { db, orgId, allowed } = ctx
    const [canView, canImport, canApprove] = await Promise.all([allowed(CASH_VIEW), allowed(STATEMENT_IMPORT), allowed(STATEMENT_APPROVE)])
    if (!canView && !canImport && !canApprove) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { data: statement, error } = await db
      .from('bank_statement_imports')
      .select('*')
      .eq('id', id)
      .eq('company_id', orgId)
      .maybeSingle()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!statement) return NextResponse.json({ error: 'Statement not found' }, { status: 404 })

    const { searchParams } = new URL(request.url)
    const offset = Math.max(Number(searchParams.get('offset')) || 0, 0)
    const limit = Math.min(Math.max(Number(searchParams.get('limit')) || 500, 1), 1000)
    const [{ data: lines, error: linesError }, { data: events, error: eventsError }] = await Promise.all([
      db.from('bank_statement_import_lines')
        .select('line_no, source_row_no, transaction_date, day_sequence, description, cheque_no, counterparty, reference, payment_details, debit_amount, credit_amount, balance, branch_code')
        .eq('import_id', id)
        .order('line_no', { ascending: true })
        .range(offset, offset + limit - 1),
      db.from('bank_statement_events')
        .select('id, occurred_at, event, actor_id, reason, details')
        .eq('import_id', id)
        .order('occurred_at', { ascending: true }),
    ])
    if (linesError || eventsError) return NextResponse.json({ error: (linesError || eventsError).message }, { status: 500 })

    // Never expose the storage path; the file is downloaded through ./file.
    const { file_path: _filePath, validation, ...header } = statement
    return NextResponse.json({
      statement: { ...header, has_original_file: Boolean(_filePath), warnings: validation?.warnings ?? [], reason_codes: validation?.reason_codes ?? [] },
      lines: lines || [],
      events: events || [],
      permissions: { can_import: canImport, can_approve: canApprove },
    })
  } catch (error) {
    console.error('Error in bank statement detail API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Statement not found' }, { status: 404 })
    const ctx = await loadStatementContext()
    if ('error' in ctx) return ctx.error
    const { db, orgId, allowed } = ctx

    const body = await request.json().catch(() => null)
    const action = body?.action as Action
    const spec = ACTIONS[action]
    if (!spec) return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 1000) : ''
    if (spec.reason && reason.length < 5) return NextResponse.json({ error: 'A reason is required' }, { status: 422 })

    const decisions = await Promise.all(spec.permissions.map(p => allowed(p)))
    if (!decisions.some(Boolean)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

    const { data: statement } = await db
      .from('bank_statement_imports')
      .select('id')
      .eq('id', id)
      .eq('company_id', orgId)
      .maybeSingle()
    if (!statement) return NextResponse.json({ error: 'Statement not found' }, { status: 404 })

    const args: Record<string, unknown> = { p_import_id: id }
    if (action !== 'approve') args.p_reason = reason || null
    const { data, error } = await db.rpc(spec.rpc, args)
    if (error) return statementErrorResponse(error)
    return NextResponse.json(data ?? { import_id: id })
  } catch (error) {
    console.error('Error in bank statement action API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
