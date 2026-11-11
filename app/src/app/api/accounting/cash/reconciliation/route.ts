import { financeAllowed } from '@/lib/security-access/finance'
import { createClient } from '@/lib/supabase/server'
import { adjustmentJournalLines, parseReconRequest, parseReconStart } from '@/modules/finance/reconciliation'
import { NextResponse } from 'next/server'

/**
 * Bank reconciliation against approved bank statements.
 *
 * GET   /api/accounting/cash/reconciliation            list reconciliations
 * GET   /api/accounting/cash/reconciliation?id=…       one reconciliation: figures, bank and book lines
 * POST  /api/accounting/cash/reconciliation            start { bank_account_id, period_end, start_date? }
 * PATCH /api/accounting/cash/reconciliation            { id, action, … }:
 *   auto_match | match {statementIds, journalLineIds} | unmatch {matchGroup} | submit | approve
 *   | return {reason} | void {reason} | adjust {statementLineId, accountId, description}
 *
 * The rules (matching, balances, submit only when complete, a second person
 * approves) are enforced by the fin_recon_* database functions.
 */

type Actor = { supabase: any; userId: string; orgId: string }

async function actor(permission: string): Promise<Actor | NextResponse> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: userData } = await supabase
    .from('users')
    .select('organization_id')
    .eq('id', user.id)
    .single()
  if (!userData?.organization_id) {
    return NextResponse.json({ error: 'User has no organization' }, { status: 400 })
  }
  if (!(await financeAllowed(user.id, permission, () => true, userData.organization_id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return { supabase: supabase as any, userId: user.id, orgId: userData.organization_id }
}

/** Database functions answer { success, error }; turn that into a response. */
function rpcResult(data: any, error: any) {
  if (error) {
    console.error('Reconciliation RPC error:', error)
    return NextResponse.json({ error: error.message || 'Database error' }, { status: 500 })
  }
  if (!data?.success) {
    return NextResponse.json({ error: data?.error || 'The action was refused' }, { status: 400 })
  }
  return NextResponse.json(data)
}

export async function GET(request: Request) {
  try {
    const a = await actor('finance.cash.view')
    if (a instanceof NextResponse) return a
    const { searchParams } = new URL(request.url)

    const id = searchParams.get('id')
    if (id) {
      const { data, error } = await a.supabase.rpc('fin_recon_data', { p_recon_id: id })
      return rpcResult(data, error)
    }

    let query = a.supabase
      .from('bank_reconciliations')
      .select(`
        id, bank_account_id, period_start, period_end, start_date,
        statement_balance, book_balance, status, summary,
        created_by, created_at, submitted_by, submitted_at, reconciled_at, reconciled_by, notes
      `)
      .eq('company_id', a.orgId)
      .order('period_end', { ascending: false })
      .order('created_at', { ascending: false })
    const bankAccountId = searchParams.get('bank_account_id')
    const status = searchParams.get('status')
    if (bankAccountId) query = query.eq('bank_account_id', bankAccountId)
    if (status) query = query.eq('status', status)

    const { data: recs, error } = await query
    if (error) {
      console.error('Error fetching reconciliations:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const userIds = [...new Set((recs || []).flatMap((r: any) => [r.created_by, r.submitted_by, r.reconciled_by]).filter(Boolean))]
    const { data: users } = userIds.length
      ? await a.supabase.from('users').select('id, full_name, email').in('id', userIds)
      : { data: [] }
    const userName = new Map<string, string>((users || []).map((u: any) => [u.id, u.full_name || u.email]))

    const { data: accounts } = await a.supabase
      .from('bank_accounts')
      .select('id, account_name, bank_name, gl_account_id, is_active')
      .eq('company_id', a.orgId)
      .order('account_name')
    const accountById = new Map<string, any>((accounts || []).map((b: any) => [b.id, b]))

    const reconciliations = (recs || []).map((r: any) => ({
      ...r,
      bank_account: accountById.get(r.bank_account_id) || null,
      created_by_name: userName.get(r.created_by) || null,
      submitted_by_name: userName.get(r.submitted_by) || null,
      approved_by_name: userName.get(r.reconciled_by) || null,
      is_mine: r.created_by === a.userId || r.submitted_by === a.userId,
    }))

    return NextResponse.json({ reconciliations, bankAccounts: accounts || [], currentUserId: a.userId })
  } catch (error) {
    console.error('Error in reconciliation API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const a = await actor('finance.reconciliation.perform')
    if (a instanceof NextResponse) return a
    const parsed = parseReconStart(await request.json().catch(() => ({})))
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const { data, error } = await a.supabase.rpc('fin_recon_start', {
      p_bank_account_id: parsed.value.bankAccountId,
      p_period_end: parsed.value.periodEnd,
      p_start_date: parsed.value.startDate,
    })
    return rpcResult(data, error)
  } catch (error) {
    console.error('Error starting reconciliation:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(request: Request) {
  try {
    const a = await actor('finance.reconciliation.perform')
    if (a instanceof NextResponse) return a
    const parsed = parseReconRequest(await request.json().catch(() => ({})))
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const req = parsed.value

    switch (req.action) {
      case 'auto_match': {
        const { data, error } = await a.supabase.rpc('fin_recon_auto_match', { p_recon_id: req.id })
        return rpcResult(data, error)
      }
      case 'match': {
        const { data, error } = await a.supabase.rpc('fin_recon_match', {
          p_recon_id: req.id, p_statement_ids: req.statementIds, p_journal_line_ids: req.journalLineIds,
        })
        return rpcResult(data, error)
      }
      case 'unmatch': {
        const { data, error } = await a.supabase.rpc('fin_recon_unmatch', { p_recon_id: req.id, p_match_group: req.matchGroup })
        return rpcResult(data, error)
      }
      case 'submit': {
        const { data, error } = await a.supabase.rpc('fin_recon_submit', { p_recon_id: req.id })
        return rpcResult(data, error)
      }
      case 'approve': {
        const { data, error } = await a.supabase.rpc('fin_recon_approve', { p_recon_id: req.id })
        return rpcResult(data, error)
      }
      case 'return': {
        const { data, error } = await a.supabase.rpc('fin_recon_return', { p_recon_id: req.id, p_reason: req.reason })
        return rpcResult(data, error)
      }
      case 'void': {
        const { data, error } = await a.supabase.rpc('fin_recon_void', { p_recon_id: req.id, p_reason: req.reason })
        return rpcResult(data, error)
      }
      case 'adjust': {
        // A bank-only movement (charge, interest) becomes a draft manual journal on the
        // bank's GL account; another user posts it from GL Journals, then it is matched.
        const { data: recon, error: reconError } = await a.supabase.rpc('fin_recon_data', { p_recon_id: req.id })
        if (reconError || !recon?.success) return rpcResult(recon, reconError)
        const line = (recon.lines || []).find((l: any) => l.side === 'BANK' && l.id === req.statementLineId)
        if (!line) return NextResponse.json({ error: 'Bank line not found in this reconciliation' }, { status: 400 })
        if (line.match_group) return NextResponse.json({ error: 'This bank line is already matched' }, { status: 400 })
        const bankGl = recon.reconciliation?.gl_account_id
        if (!bankGl) return NextResponse.json({ error: 'The bank account is not linked to a GL account' }, { status: 400 })

        const { data, error } = await a.supabase.rpc('fin_save_manual_journal', {
          p_journal_id: null,
          p_journal_date: line.date,
          p_description: req.description,
          p_reference: `Bank reconciliation ${recon.reconciliation.period_start} to ${recon.reconciliation.period_end}`,
          p_lines: adjustmentJournalLines(line, bankGl, req.accountId, req.description),
        })
        return rpcResult(data, error)
      }
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (error) {
    console.error('Error updating reconciliation:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
