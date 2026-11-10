import { financeAllowed } from '@/lib/security-access/finance'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

/**
 * GET /api/accounting/ar/invoices
 * List D2H sales invoices with GL posting status.
 *
 * Schema notes:
 * - documents: NO total_amount (amount = SUM(order_items.line_total))
 * - documents: NO completed_at, NO source_request_id column
 * - orders: buyer_org_id / seller_org_id (NOT buyer_id / supplier_id)
 * - orders: NO total_amount
 * - gl_document_postings: NO posted_at (use created_at)
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
    const limit = parseInt(searchParams.get('limit') || '50')
    const offset = parseInt(searchParams.get('offset') || '0')
    const glStatus = searchParams.get('status')
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
        payment_percentage,
        orders!inner (
          id,
          order_no,
          display_doc_no,
          order_type,
          buyer_org_id,
          seller_org_id,
          status
        )
      `, { count: 'exact' })
      .eq('company_id', orgId)
      // The sales invoice only: the SO of the same order is not a second invoice.
      .eq('doc_type', 'INVOICE')
      .eq('orders.order_type', 'D2H')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (fromDate) query = query.gte('created_at', fromDate)
    if (toDate) query = query.lte('created_at', toDate + 'T23:59:59')
    if (search) query = query.or(`doc_no.ilike.%${search}%,display_doc_no.ilike.%${search}%`)

    const { data: invoices, error, count } = await query

    if (error) {
      console.error('Error fetching AR invoices:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Calculate amounts from order_items
    const orderIds = [...new Set((invoices || []).map((d: any) => d.order_id).filter(Boolean))]
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
    const docIds = (invoices || []).map((d: any) => d.id)
    const postingMap: Record<string, any> = {}
    if (docIds.length > 0) {
      const { data: postings } = await supabase
        .from('gl_document_postings')
        .select('document_id, journal_id, document_number, posted_amount, created_at')
        .in('document_id', docIds)
      if (postings) for (const p of postings) postingMap[p.document_id] = p
    }

    // Buyer org names
    const buyerIds = [...new Set((invoices || []).map((d: any) => (d.orders as any)?.buyer_org_id).filter(Boolean))]
    const buyerMap: Record<string, string> = {}
    if (buyerIds.length > 0) {
      const { data: orgs } = await supabase.from('organizations').select('id, org_name').in('id', buyerIds)
      if (orgs) for (const o of orgs) buyerMap[o.id] = o.org_name
    }

    const result = (invoices || []).map((doc: any) => ({
      id: doc.id,
      doc_type: doc.doc_type,
      document_no: doc.display_doc_no || doc.doc_no,
      order_no: doc.orders?.display_doc_no || doc.orders?.order_no,
      order_id: doc.order_id,
      status: doc.status,
      amount: orderAmounts[doc.order_id] || 0,
      date: doc.created_at,
      acknowledged_at: doc.acknowledged_at,
      customer_name: buyerMap[doc.orders?.buyer_org_id] || '-',
      gl_posted: !!postingMap[doc.id],
      gl_posting: postingMap[doc.id] || null,
    }))

    let filtered = result
    if (glStatus === 'posted') filtered = result.filter((r: any) => r.gl_posted)
    if (glStatus === 'unposted') filtered = result.filter((r: any) => !r.gl_posted)

    return NextResponse.json({ invoices: filtered, total: count || 0, limit, offset })
  } catch (error) {
    console.error('Error in AR invoices API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
