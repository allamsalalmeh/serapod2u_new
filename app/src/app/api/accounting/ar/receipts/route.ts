import { financeAllowed } from '@/lib/security-access/finance'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

/**
 * GET /api/accounting/ar/receipts
 * Money actually received from customers (D2H): one row per receipt posted from
 * Pending Postings (fin_payments, direction IN), with bank, reference, journal,
 * stage (advance before the invoice / settlement after it) and reversal status.
 * Receipts posted before fin_payments existed are listed from their posting rows.
 *
 * Query: from, to (receipt date), status (POSTED | REVERSED), search, limit, offset.
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: userData } = await supabase
      .from('users')
      .select('organization_id')
      .eq('id', user.id)
      .single()

    if (!userData?.organization_id) {
      return NextResponse.json({ error: 'User has no organization' }, { status: 400 })
    }
    if (!(await financeAllowed(user.id, 'finance.receivable.view', () => true, userData.organization_id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const orgId = userData.organization_id
    const { searchParams } = new URL(request.url)
    const limit = Math.min(parseInt(searchParams.get('limit') || '50') || 50, 500)
    const offset = parseInt(searchParams.get('offset') || '0') || 0
    const fromDate = searchParams.get('from')
    const toDate = searchParams.get('to')
    const statusFilter = searchParams.get('status')
    const search = (searchParams.get('search') || '').trim().toLowerCase()

    const admin = createAdminClient() as any

    // 1. Receipts posted through Finance.
    const { data: payments, error } = await admin
      .from('fin_payments')
      .select('id, document_id, order_id, party_org_id, stage, amount, payment_date, bank_account_id, reference, journal_id, status, created_at')
      .eq('company_id', orgId)
      .eq('direction', 'IN')
      .order('payment_date', { ascending: false })
      .order('created_at', { ascending: false })
    if (error) {
      console.error('Error fetching AR receipts:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    const pays: any[] = payments || []

    // 2. Older receipts posted before fin_payments existed (posting row, no fin_payments row).
    const docsWithPayments = new Set(pays.map((p) => p.document_id))
    const { data: legacyPostings } = await admin
      .from('gl_document_postings')
      .select('document_id, journal_id, posted_amount, created_at')
      .eq('company_id', orgId)
      .eq('document_type', 'RECEIPT')
      .eq('posting_status', 'POSTED')
    const legacy: any[] = (legacyPostings || []).filter((p: any) => !docsWithPayments.has(p.document_id))

    // 3. Lookups: documents, orders, customers, banks, journals, reversals.
    const docIds = [...new Set([...pays.map((p) => p.document_id), ...legacy.map((p) => p.document_id)])]
    const { data: docs } = docIds.length
      ? await admin.from('documents').select('id, doc_no, display_doc_no, order_id').in('id', docIds)
      : { data: [] }
    const docById = new Map<string, any>((docs || []).map((d: any) => [d.id, d]))

    const orderIds = [...new Set([...pays.map((p) => p.order_id), ...(docs || []).map((d: any) => d.order_id)].filter(Boolean))]
    const { data: orders } = orderIds.length
      ? await admin.from('orders').select('id, order_no, display_doc_no, buyer_org_id').in('id', orderIds)
      : { data: [] }
    const orderById = new Map<string, any>((orders || []).map((o: any) => [o.id, o]))

    const partyIds = [...new Set([...pays.map((p) => p.party_org_id), ...(orders || []).map((o: any) => o.buyer_org_id)].filter(Boolean))]
    const { data: orgs } = partyIds.length
      ? await admin.from('organizations').select('id, org_name').in('id', partyIds)
      : { data: [] }
    const orgName = new Map<string, string>((orgs || []).map((o: any) => [o.id, o.org_name]))

    const bankIds = [...new Set(pays.map((p) => p.bank_account_id).filter(Boolean))]
    const { data: banks } = bankIds.length
      ? await admin.from('bank_accounts').select('id, account_name, bank_name').in('id', bankIds)
      : { data: [] }
    const bankById = new Map<string, any>((banks || []).map((b: any) => [b.id, b]))

    const journalIds = [...new Set([...pays.map((p) => p.journal_id), ...legacy.map((p) => p.journal_id)].filter(Boolean))]
    const { data: journals } = journalIds.length
      ? await admin.from('gl_journals').select('id, journal_number, journal_date').in('id', journalIds)
      : { data: [] }
    const journalById = new Map<string, any>((journals || []).map((j: any) => [j.id, j]))
    const { data: reversals } = journalIds.length
      ? await admin.from('fin_journal_reversals').select('journal_id, reversal_journal_id, reversal_date, reason').in('journal_id', journalIds)
      : { data: [] }
    const reversalIds = [...new Set((reversals || []).map((r: any) => r.reversal_journal_id))]
    const { data: reversalJournals } = reversalIds.length
      ? await admin.from('gl_journals').select('id, journal_number').in('id', reversalIds)
      : { data: [] }
    const reversalNo = new Map<string, string>((reversalJournals || []).map((j: any) => [j.id, j.journal_number]))
    const reversalByJournal = new Map<string, any>((reversals || []).map((r: any) => [r.journal_id, r]))

    // 4. Rows.
    const rows = [
      ...pays.map((p) => {
        const doc = docById.get(p.document_id)
        const order = orderById.get(p.order_id)
        const bank = bankById.get(p.bank_account_id)
        const rev = reversalByJournal.get(p.journal_id)
        return {
          id: p.id as string,
          receipt_date: p.payment_date as string,
          document_id: p.document_id as string,
          document_no: doc?.display_doc_no || doc?.doc_no || '-',
          order_no: order?.display_doc_no || order?.order_no || '-',
          customer_name: orgName.get(p.party_org_id || order?.buyer_org_id) || '-',
          amount: Number(p.amount) || 0,
          stage: p.stage as 'ADVANCE' | 'SETTLEMENT',
          bank_name: bank ? bank.account_name || bank.bank_name : '-',
          reference: (p.reference as string | null) || null,
          journal_number: (journalById.get(p.journal_id)?.journal_number as string | undefined) || null,
          status: p.status as 'POSTED' | 'REVERSED',
          reversal_journal_number: rev ? reversalNo.get(rev.reversal_journal_id) || null : null,
          reversal_date: (rev?.reversal_date as string | undefined) || null,
          legacy: false,
        }
      }),
      ...legacy.map((p) => {
        const doc = docById.get(p.document_id)
        const order = doc ? orderById.get(doc.order_id) : null
        const journal = journalById.get(p.journal_id)
        return {
          id: `legacy-${p.document_id}`,
          receipt_date: (journal?.journal_date as string | undefined) || String(p.created_at || '').slice(0, 10),
          document_id: p.document_id as string,
          document_no: doc?.display_doc_no || doc?.doc_no || '-',
          order_no: order?.display_doc_no || order?.order_no || '-',
          customer_name: orgName.get(order?.buyer_org_id) || '-',
          amount: Number(p.posted_amount) || 0,
          stage: 'SETTLEMENT' as 'ADVANCE' | 'SETTLEMENT',
          bank_name: '-',
          reference: null as string | null,
          journal_number: (journal?.journal_number as string | undefined) || null,
          status: 'POSTED' as 'POSTED' | 'REVERSED',
          reversal_journal_number: null as string | null,
          reversal_date: null as string | null,
          legacy: true,
        }
      }),
    ]
      .filter((r) => !fromDate || r.receipt_date >= fromDate)
      .filter((r) => !toDate || r.receipt_date <= toDate)
      .filter((r) => !statusFilter || r.status === statusFilter)
      .filter((r) => !search || [r.document_no, r.order_no, r.customer_name, r.reference, r.journal_number]
        .some((v) => String(v || '').toLowerCase().includes(search)))
      .sort((a, b) => (b.receipt_date || '').localeCompare(a.receipt_date || ''))

    const round2 = (n: number) => Math.round(n * 100) / 100
    const posted = rows.filter((r) => r.status === 'POSTED')
    const summary = {
      receipts: posted.length,
      total_received: round2(posted.reduce((s, r) => s + r.amount, 0)),
      advances: round2(posted.filter((r) => r.stage === 'ADVANCE').reduce((s, r) => s + r.amount, 0)),
      reversed: rows.length - posted.length,
    }

    return NextResponse.json({
      receipts: rows.slice(offset, offset + limit),
      total: rows.length,
      summary,
      limit,
      offset,
    })
  } catch (error) {
    console.error('Error in AR receipts API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
