import { financeAllowed } from '@/lib/security-access/finance'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

/**
 * GET /api/accounting/ar/aging
 * AR aging analysis: unpaid invoices bucketed by days overdue.
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
    const asAtDate = searchParams.get('asAt') || new Date().toISOString().split('T')[0]

    // Get all D2H invoices
    const { data: invoices } = await supabase
      .from('documents')
      .select(`
        id, doc_no, display_doc_no, created_at, status, order_id, payment_percentage,
        orders!inner ( id, order_no, display_doc_no, order_type, buyer_org_id )
      `)
      .eq('company_id', orgId)
      // The sales invoice only: counting the SO too doubled every order.
      .eq('doc_type', 'INVOICE')
      .eq('orders.order_type', 'D2H')
      .lte('created_at', asAtDate + 'T23:59:59')

    // Get all D2H receipts (payments received)
    const { data: receipts } = await supabase
      .from('documents')
      .select(`
        id, order_id, payment_percentage,
        orders!inner ( id, order_type )
      `)
      .eq('company_id', orgId)
      .eq('doc_type', 'RECEIPT')
      .eq('orders.order_type', 'D2H')
      .lte('created_at', asAtDate + 'T23:59:59')

    // Calculate order amounts from order_items
    const allOrderIds = [...new Set([
      ...(invoices || []).map((d: any) => d.order_id),
      ...(receipts || []).map((d: any) => d.order_id),
    ].filter(Boolean))]

    const orderAmounts: Record<string, number> = {}
    if (allOrderIds.length > 0) {
      const { data: items } = await supabase
        .from('order_items')
        .select('order_id, line_total')
        .in('order_id', allOrderIds)
      for (const item of items || []) {
        orderAmounts[item.order_id] = (orderAmounts[item.order_id] || 0) + (Number(item.line_total) || 0)
      }
    }

    // Map receipts paid per order
    const paidByOrder: Record<string, number> = {}
    for (const r of receipts || []) {
      const orderTotal = orderAmounts[r.order_id] || 0
      const receiptAmount = r.payment_percentage
        ? Math.round(orderTotal * (r.payment_percentage / 100) * 100) / 100
        : orderTotal
      paidByOrder[r.order_id] = (paidByOrder[r.order_id] || 0) + receiptAmount
    }

    // Get buyer names
    const buyerIds = [...new Set((invoices || []).map((d: any) => (d.orders as any)?.buyer_org_id).filter(Boolean))]
    const buyerMap: Record<string, string> = {}
    if (buyerIds.length > 0) {
      const { data: orgs } = await supabase.from('organizations').select('id, org_name').in('id', buyerIds)
      if (orgs) for (const o of orgs) buyerMap[o.id] = o.org_name
    }

    // Calculate aging per customer
    const now = new Date(asAtDate)
    const agingByCustomer: Record<string, {
      customer_id: string; customer_name: string
      current: number; days_31_60: number; days_61_90: number
      days_91_120: number; days_120_plus: number
      total: number; invoice_count: number
    }> = {}

    for (const inv of invoices || []) {
      const buyerId = (inv.orders as any)?.buyer_org_id || 'unknown'
      const customerName = buyerMap[buyerId] || 'Unknown'
      const orderTotal = orderAmounts[inv.order_id] || 0
      const paid = paidByOrder[inv.order_id] || 0
      const outstanding = Math.max(0, orderTotal - paid)

      if (outstanding <= 0) continue

      const invDate = new Date(inv.created_at!)
      const daysOld = Math.floor((now.getTime() - invDate.getTime()) / (1000 * 60 * 60 * 24))

      if (!agingByCustomer[buyerId]) {
        agingByCustomer[buyerId] = {
          customer_id: buyerId, customer_name: customerName,
          current: 0, days_31_60: 0, days_61_90: 0, days_91_120: 0, days_120_plus: 0,
          total: 0, invoice_count: 0,
        }
      }

      const e = agingByCustomer[buyerId]
      e.invoice_count++
      e.total += outstanding
      if (daysOld <= 30) e.current += outstanding
      else if (daysOld <= 60) e.days_31_60 += outstanding
      else if (daysOld <= 90) e.days_61_90 += outstanding
      else if (daysOld <= 120) e.days_91_120 += outstanding
      else e.days_120_plus += outstanding
    }

    const agingData = Object.values(agingByCustomer).sort((a, b) => b.total - a.total)
    const totals = agingData.reduce(
      (acc, r) => ({
        current: acc.current + r.current, days_31_60: acc.days_31_60 + r.days_31_60,
        days_61_90: acc.days_61_90 + r.days_61_90, days_91_120: acc.days_91_120 + r.days_91_120,
        days_120_plus: acc.days_120_plus + r.days_120_plus, total: acc.total + r.total,
        invoice_count: acc.invoice_count + r.invoice_count,
      }),
      { current: 0, days_31_60: 0, days_61_90: 0, days_91_120: 0, days_120_plus: 0, total: 0, invoice_count: 0 }
    )

    return NextResponse.json({ aging: agingData, totals, asAtDate, customerCount: agingData.length })
  } catch (error) {
    console.error('Error in AR aging API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
