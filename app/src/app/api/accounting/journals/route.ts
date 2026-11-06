import { financeAllowed } from '@/lib/security-access/finance'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { parseManualJournalInput } from '@/modules/finance/manualJournal'

/**
 * GET /api/accounting/journals
 * List GL journals with filters
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const { data: financeActor } = await (supabase as any).from('users').select('organization_id').eq('id', user.id).maybeSingle()
    if (!(await financeAllowed(user.id, 'finance.ledger.view', () => true, financeActor?.organization_id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status')
    const journalType = searchParams.get('type')
    const fromDate = searchParams.get('from')
    const toDate = searchParams.get('to')
    const limit = parseInt(searchParams.get('limit') || '50')
    const offset = parseInt(searchParams.get('offset') || '0')

    // Use the view for journals (using 'any' since view not in generated types yet)
    let query = (supabase as any)
      .from('v_gl_journals')
      .select('*', { count: 'exact' })
      .order('journal_date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (status) {
      query = query.eq('status', status)
    }

    if (journalType) {
      query = query.eq('journal_type', journalType)
    }

    if (fromDate) {
      query = query.gte('journal_date', fromDate)
    }

    if (toDate) {
      query = query.lte('journal_date', toDate)
    }

    const { data: journals, error, count } = await query

    if (error) {
      console.error('Error fetching journals:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Manual / reversal flags (columns newer than the view)
    const ids = (journals || []).map((j: any) => j.id)
    const extra: Record<string, any> = {}
    if (ids.length > 0) {
      const { data: rows } = await (supabase as any)
        .from('gl_journals')
        .select('id, is_manual, reference, is_reversal, reversal_journal_id, reversed_journal_id')
        .in('id', ids)
      for (const r of rows || []) extra[r.id] = r
    }

    return NextResponse.json({
      journals: (journals || []).map((j: any) => ({
        ...j,
        is_manual: !!extra[j.id]?.is_manual,
        reference: extra[j.id]?.reference ?? null,
        is_reversal: !!extra[j.id]?.is_reversal,
        reversal_journal_id: extra[j.id]?.reversal_journal_id ?? null,
        reversed_journal_id: extra[j.id]?.reversed_journal_id ?? null,
      })),
      total: count || 0,
      limit,
      offset
    })
  } catch (error) {
    console.error('Error in journals API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * POST /api/accounting/journals
 * Create a manual journal draft (finance.journal.post).
 * Body: { journalDate, description, reference?, lines: [{ account_id, description?, debit?, credit? }] }
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const { data: financeActor } = await (supabase as any).from('users').select('organization_id').eq('id', user.id).maybeSingle()
    if (!(await financeAllowed(user.id, 'finance.journal.post', () => true, financeActor?.organization_id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const parsed = parseManualJournalInput(await request.json().catch(() => ({})))
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }
    const input = parsed.value

    const { data, error } = await (supabase as any).rpc('fin_save_manual_journal', {
      p_journal_id: null,
      p_journal_date: input.journalDate,
      p_description: input.description,
      p_reference: input.reference,
      p_lines: input.lines,
    })

    if (error) {
      console.error('Error creating manual journal:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!data?.success) {
      return NextResponse.json({ error: data?.error || 'Failed to save the journal' }, { status: 400 })
    }
    return NextResponse.json(data)
  } catch (error) {
    console.error('Error in journals API (POST):', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
