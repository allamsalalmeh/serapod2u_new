import { financeAllowed } from '@/lib/security-access/finance'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

/**
 * GET /api/accounting/ap/payments
 * List supplier payments (deposit + balance) with GL posting status.
 *
 * Deposit vs Balance classification (from v_pending_gl_postings):
 * - Deposit: doc_no NOT LIKE '%-BAL%' AND payload->'source_request_id' does not exist
 * - Balance: doc_no LIKE '%-BAL%' OR payload ? 'source_request_id'
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
    if (!(await financeAllowed(user.id, 'finance.payable.view', () => true, userData.organization_id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const orgId = userData.organization_id
    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get('limit') || '50')
    const offset = parseInt(searchParams.get('offset') || '0')
    const fromDate = searchParams.get('from')
    const toDate = searchParams.get('to')
    const paymentType = searchParams.get('type') // 'deposit' | 'balance' | null

    let query = supabase
      .from('documents')
      .select(`
        id,
        doc_type,
        doc_no,
        display_doc_no,
        status,
        created_at,
        acknowledged_at,
        order_id,
        payment_percentage,
        payload,
        orders (
          id,
          order_no,
          display_doc_no,
          order_type,
          seller_org_id,
          payment_terms
        )
      `, { count: 'exact' })
      .eq('company_id', orgId)
      .eq('doc_type', 'PAYMENT')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (fromDate) query = query.gte('created_at', fromDate)
    if (toDate) query = query.lte('created_at', toDate + 'T23:59:59')

    const { data: payments, error, count } = await query

    if (error) {
      console.error('Error fetching AP payments:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Calculate amounts from order_items
    const orderIds = [...new Set((payments || []).map((d: any) => d.order_id).filter(Boolean))]
    const orderAmounts: Record<string, number> = {}
    if (orderIds.length > 0) {
      const { data: items } = await supabase
        .from('order_items')
        .select('order_id, line_total')
        .in('order_id', orderIds)
      for (const item of items || []) {
        orderAmounts[item.order_id] = (orderAmounts[item.order_id] || 0) + (Number(item.line_total) || 0)
      }
    }

    // Classify deposit vs balance (matching v_pending_gl_postings logic)
    const classified = (payments || []).map((doc: any) => {
      const docNo = doc.doc_no || ''
      const payload = doc.payload || {}
      const isBalance = docNo.includes('-BAL') || !!payload.source_request_id
      const orderTotal = orderAmounts[doc.order_id] || 0
      const paymentTerms = doc.orders?.payment_terms || {}

      let amount: number
      if (isBalance) {
        const balancePct = Number(paymentTerms.balance_pct) || 0.7
        amount = Math.round(orderTotal * balancePct * 100) / 100
      } else {
        const depositPct = Number(paymentTerms.deposit_pct) || 0.3
        amount = Math.round(orderTotal * depositPct * 100) / 100
      }

      return { ...doc, payment_type: isBalance ? 'balance' : 'deposit', amount }
    })

    // Filter by payment type
    let filtered = classified
    if (paymentType === 'deposit') filtered = classified.filter((p: any) => p.payment_type === 'deposit')
    if (paymentType === 'balance') filtered = classified.filter((p: any) => p.payment_type === 'balance')

    // GL posting status
    const docIds = filtered.map((d: any) => d.id)
    const postingMap: Record<string, any> = {}
    if (docIds.length > 0) {
      const { data: postings } = await supabase
        .from('gl_document_postings')
        .select('document_id, journal_id, document_number, posted_amount, created_at')
        .in('document_id', docIds)
      if (postings) for (const p of postings) postingMap[p.document_id] = p
    }

    // Actual payments and document closures (server-only tables; ids already scoped above)
    const paidMap: Record<string, number> = {}
    const closureMap: Record<string, { kind: string; reason: string | null }> = {}
    if (docIds.length > 0) {
      const admin = createAdminClient() as any
      const [{ data: paid }, { data: closures }] = await Promise.all([
        admin.from('fin_payments').select('document_id, amount').in('document_id', docIds).eq('status', 'POSTED'),
        admin.from('fin_document_closures').select('document_id, kind, reason').in('document_id', docIds),
      ])
      for (const p of paid || []) paidMap[p.document_id] = (paidMap[p.document_id] || 0) + (Number(p.amount) || 0)
      for (const c of closures || []) closureMap[c.document_id] = { kind: c.kind, reason: c.reason }
    }

    // Supplier names
    const supplierIds = [...new Set(filtered.map((d: any) => (d.orders as any)?.seller_org_id).filter(Boolean))]
    const supplierMap: Record<string, string> = {}
    if (supplierIds.length > 0) {
      const { data: orgs } = await supabase.from('organizations').select('id, org_name').in('id', supplierIds)
      if (orgs) for (const o of orgs) supplierMap[o.id] = o.org_name
    }

    const result = filtered.map((doc: any) => ({
      id: doc.id,
      document_no: doc.display_doc_no || doc.doc_no,
      order_no: doc.orders?.display_doc_no || doc.orders?.order_no,
      order_id: doc.order_id,
      status: doc.status,
      amount: doc.amount,
      date: doc.created_at,
      payment_type: doc.payment_type,
      supplier_name: supplierMap[doc.orders?.seller_org_id] || '-',
      gl_posted: !!postingMap[doc.id],
      gl_posting: postingMap[doc.id] || null,
      // Actual amount paid: new payments, or the single posting made the old way.
      paid_amount: paidMap[doc.id] ?? (postingMap[doc.id] ? Number(postingMap[doc.id].posted_amount) || 0 : 0),
      closed: !!closureMap[doc.id] || !!postingMap[doc.id],
      closure_kind: closureMap[doc.id]?.kind || null,
      closure_reason: closureMap[doc.id]?.reason || null,
      can_reopen: !!closureMap[doc.id],
    }))

    return NextResponse.json({ payments: result, total: count || 0, limit, offset })
  } catch (error) {
    console.error('Error in AP payments API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
