import { financeAllowed } from '@/lib/security-access/finance'
import { loadSubledger } from '@/lib/accounting/subledger-data'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

/**
 * GET /api/accounting/ap/bills
 * List supplier bills (PAYMENT_REQUEST documents) with GL posting status.
 *
 * Schema: documents has NO total_amount; orders uses seller_org_id not supplier_id.
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
    const search = searchParams.get('search')

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
        orders (
          id,
          order_no,
          display_doc_no,
          order_type,
          seller_org_id
        )
      `, { count: 'exact' })
      .eq('company_id', orgId)
      .eq('doc_type', 'PAYMENT_REQUEST')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (fromDate) query = query.gte('created_at', fromDate)
    if (toDate) query = query.lte('created_at', toDate + 'T23:59:59')
    if (search) query = query.or(`doc_no.ilike.%${search}%,display_doc_no.ilike.%${search}%`)

    const { data: bills, error, count } = await query

    if (error) {
      console.error('Error fetching AP bills:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Calculate amounts from order_items
    const orderIds = [...new Set((bills || []).map((d: any) => d.order_id).filter(Boolean))]
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

    // GL posting status
    const docIds = (bills || []).map((d: any) => d.id)
    const postingMap: Record<string, any> = {}
    if (docIds.length > 0) {
      const { data: postings } = await supabase
        .from('gl_document_postings')
        .select('document_id, journal_id, document_number, posted_amount, created_at')
        .in('document_id', docIds)
      if (postings) for (const p of postings) postingMap[p.document_id] = p
    }

    // Supplier names (seller_org_id on orders)
    const supplierIds = [...new Set((bills || []).map((d: any) => (d.orders as any)?.seller_org_id).filter(Boolean))]
    const supplierMap: Record<string, string> = {}
    if (supplierIds.length > 0) {
      const { data: orgs } = await supabase.from('organizations').select('id, org_name').in('id', supplierIds)
      if (orgs) for (const o of orgs) supplierMap[o.id] = o.org_name
    }

    // Money actually paid on each order (supplier payments posted in Finance).
    const { invoices: ledger } = await loadSubledger(createAdminClient() as any, { companyId: orgId, side: 'AP' })
    const ledgerByDoc = new Map(ledger.map((l) => [l.documentId, l]))

    const result = (bills || []).map((doc: any) => ({
      id: doc.id,
      document_no: doc.display_doc_no || doc.doc_no,
      order_no: doc.orders?.display_doc_no || doc.orders?.order_no,
      order_id: doc.order_id,
      status: doc.status,
      amount: orderAmounts[doc.order_id] || 0,
      date: doc.created_at,
      supplier_name: supplierMap[doc.orders?.seller_org_id] || '-',
      gl_posted: !!postingMap[doc.id],
      gl_posting: postingMap[doc.id] || null,
      journal_number: ledgerByDoc.get(doc.id)?.journalNumber || null,
      paid: ledgerByDoc.get(doc.id)?.balance.settled ?? 0,
      outstanding: ledgerByDoc.get(doc.id)?.balance.outstanding ?? 0,
      advance_paid: ledgerByDoc.get(doc.id)?.balance.unappliedAdvance ?? 0,
      payment_status: ledgerByDoc.get(doc.id)?.balance.status ?? 'UNPAID',
    }))

    return NextResponse.json({ bills: result, total: count || 0, limit, offset })
  } catch (error) {
    console.error('Error in AP bills API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
