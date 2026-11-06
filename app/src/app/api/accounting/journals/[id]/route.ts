import { financeAllowed } from '@/lib/security-access/finance'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { parseJournalAction, parseManualJournalInput } from '@/modules/finance/manualJournal'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function authorize(supabase: any, permission: string) {
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { data: financeActor } = await supabase.from('users').select('organization_id').eq('id', user.id).maybeSingle()
  if (!(await financeAllowed(user.id, permission, () => true, financeActor?.organization_id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null
}

function rpcResult(data: any, error: any, fallback: string) {
  if (error) {
    console.error(`${fallback}:`, error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!data?.success) {
    return NextResponse.json({ error: data?.error || fallback }, { status: 400 })
  }
  return NextResponse.json(data)
}

/**
 * GET /api/accounting/journals/[id]
 * Get journal details with lines
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const { data: financeActor } = await (supabase as any).from('users').select('organization_id').eq('id', user.id).maybeSingle()
    if (!(await financeAllowed(user.id, 'finance.ledger.view', () => true, financeActor?.organization_id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // Get journal header (using 'any' since view not in generated types yet)
    const { data: journal, error: journalError } = await (supabase as any)
      .from('v_gl_journals')
      .select('*')
      .eq('id', id)
      .single()

    if (journalError) {
      console.error('Error fetching journal:', journalError)
      return NextResponse.json({ error: journalError.message }, { status: 500 })
    }

    if (!journal) {
      return NextResponse.json({ error: 'Journal not found' }, { status: 404 })
    }

    // Get journal lines (using 'any' since view not in generated types yet)
    const { data: lines, error: linesError } = await (supabase as any)
      .from('v_gl_journal_lines')
      .select('*')
      .eq('journal_id', id)
      .order('line_number')

    if (linesError) {
      console.error('Error fetching journal lines:', linesError)
      return NextResponse.json({ error: linesError.message }, { status: 500 })
    }

    // Get linked document posting (using 'any' since table not in generated types yet)
    const { data: posting } = await (supabase as any)
      .from('gl_document_postings')
      .select('*')
      .eq('journal_id', id)
      .limit(1)
      .maybeSingle()

    // Manual / reversal details (columns newer than the view)
    const { data: extra } = await (supabase as any)
      .from('gl_journals')
      .select('is_manual, reference, is_reversal, reversal_reason, reversal_journal_id, reversed_journal_id')
      .eq('id', id)
      .maybeSingle()

    const linkedIds = [extra?.reversal_journal_id, extra?.reversed_journal_id].filter(Boolean)
    const linkedNumbers: Record<string, string> = {}
    if (linkedIds.length > 0) {
      const { data: linked } = await (supabase as any)
        .from('gl_journals').select('id, journal_number').in('id', linkedIds)
      for (const l of linked || []) linkedNumbers[l.id] = l.journal_number
    }

    // Raw lines (account ids) so a manual draft can be edited
    let editLines: any[] = []
    if (extra?.is_manual && journal.status === 'DRAFT') {
      const { data: raw } = await (supabase as any)
        .from('gl_journal_lines')
        .select('account_id, description, debit_amount, credit_amount, line_number')
        .eq('journal_id', id)
        .order('line_number')
      editLines = raw || []
    }

    return NextResponse.json({
      journal: {
        ...journal,
        is_manual: !!extra?.is_manual,
        reference: extra?.reference ?? null,
        is_reversal: !!extra?.is_reversal,
        reversal_reason: extra?.reversal_reason ?? null,
        reversal_journal_id: extra?.reversal_journal_id ?? null,
        reversal_journal_number: extra?.reversal_journal_id ? linkedNumbers[extra.reversal_journal_id] ?? null : null,
        reversed_journal_id: extra?.reversed_journal_id ?? null,
        reversed_journal_number: extra?.reversed_journal_id ? linkedNumbers[extra.reversed_journal_id] ?? null : null,
      },
      lines: lines || [],
      posting: posting || null,
      edit_lines: editLines,
    })
  } catch (error) {
    console.error('Error in journal detail API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * PUT /api/accounting/journals/[id]
 * Update a manual journal draft (finance.journal.post).
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    if (!UUID.test(id)) return NextResponse.json({ error: 'A valid journal id is required' }, { status: 400 })
    const supabase = (await createClient()) as any

    const denied = await authorize(supabase, 'finance.journal.post')
    if (denied) return denied

    const parsed = parseManualJournalInput(await request.json().catch(() => ({})))
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const input = parsed.value

    const { data, error } = await supabase.rpc('fin_save_manual_journal', {
      p_journal_id: id,
      p_journal_date: input.journalDate,
      p_description: input.description,
      p_reference: input.reference,
      p_lines: input.lines,
    })
    return rpcResult(data, error, 'Failed to save the journal')
  } catch (error) {
    console.error('Error in journal detail API (PUT):', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/accounting/journals/[id]
 * Delete a manual journal draft (finance.journal.post).
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    if (!UUID.test(id)) return NextResponse.json({ error: 'A valid journal id is required' }, { status: 400 })
    const supabase = (await createClient()) as any

    const denied = await authorize(supabase, 'finance.journal.post')
    if (denied) return denied

    const { data, error } = await supabase.rpc('fin_delete_manual_journal', { p_journal_id: id })
    return rpcResult(data, error, 'Failed to delete the journal')
  } catch (error) {
    console.error('Error in journal detail API (DELETE):', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * POST /api/accounting/journals/[id]
 * { action: 'post' }                                   post a manual draft (finance.journal.post)
 * { action: 'reverse', reason, reversalDate }          reverse a posted journal (finance.payment.approve)
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const supabase = (await createClient()) as any

    const parsed = parseJournalAction(id, await request.json().catch(() => ({})))
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const action = parsed.value

    const denied = await authorize(supabase, action.action === 'reverse' ? 'finance.payment.approve' : 'finance.journal.post')
    if (denied) return denied

    if (action.action === 'post') {
      const { data, error } = await supabase.rpc('fin_post_manual_journal', { p_journal_id: id })
      return rpcResult(data, error, 'Failed to post the journal')
    }

    const { data, error } = await supabase.rpc('fin_reverse_journal', {
      p_journal_id: id,
      p_reason: action.reason,
      p_reversal_date: action.reversalDate,
    })
    return rpcResult(data, error, 'Failed to reverse the journal')
  } catch (error) {
    console.error('Error in journal detail API (POST):', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
