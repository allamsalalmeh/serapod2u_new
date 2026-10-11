import { guardUserOperation } from '@/lib/security-access/operation'
import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { malaysiaDateOf, orderBusinessDate } from '@/lib/orders/order-date'
import { orderDateSelect, resolveOrderDateColumn } from '@/lib/reporting/business-date-query'
import { APPROVED_SALES_STATUSES, CANCELLED_STATUS, PIPELINE_STATUSES, salesClassOf, summarizeSales } from '@/lib/reporting/sales-kpi'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')
    const distributorId = searchParams.get('distributorId')
    
    // Debug: Log environment info
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    console.log('[Reporting API] Environment:', { 
      supabaseUrl: supabaseUrl?.substring(8, 40), // Extract project ID part
      nodeEnv: process.env.NODE_ENV 
    })
    console.log('[Reporting API] Request params:', { startDate, endDate, distributorId })
    
    const supabase = await createClient()
    
    // Get authenticated user
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    console.log('[Reporting API] Auth result:', { userId: user?.id, email: user?.email, authError: authError?.message })
    
    if (authError || !user) {
      console.log('[Reporting API] Unauthorized - no user')
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const saDenied = await guardUserOperation(user.id, 'reporting.analytics.view')
    if (saDenied) return saDenied

    // Get organization_id
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('organization_id, role_code, roles(role_level)')
      .eq('id', user.id)
      .single()

    console.log('[Reporting API] Profile result:', { profile, profileError: profileError?.message })

    if (!profile) {
      console.log('[Reporting API] Profile not found for user:', user.id)
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
    }

    const isSuperAdmin = profile.roles?.role_level === 1
    console.log('[Reporting API] User role:', { role_code: profile.role_code, role_level: profile.roles?.role_level, isSuperAdmin })

    // ==========================================
    // FETCH DATA FROM ACTUAL POPULATED TABLES
    // ==========================================

    // 1. Fetch Orders with Items. Periods, trend and dates follow the business
    // SO date (order_date); created_at only on a database without the column.
    const dateColumn = await resolveOrderDateColumn(supabase)
    // The select list is built at runtime (order_date may not exist yet), so the
    // typed query parser cannot follow it.
    let ordersQuery = (supabase as any)
      .from('orders')
      .select(`
        id,
        order_no,
        display_doc_no,
        order_type,
        status,
        ${orderDateSelect(dateColumn)},
        updated_at,
        buyer:organizations!orders_buyer_org_id_fkey (
          id,
          org_name,
          org_type_code
        ),
        seller:organizations!orders_seller_org_id_fkey (
          id,
          org_name,
          org_type_code
        ),
        order_items (
          id,
          variant_id,
          qty,
          unit_price,
          line_total
        )
      `)
      // Approved sales, the submitted pipeline and cancellations are all read so each is reported apart; drafts are
      // not commitments. Only approved sales feed revenue, units, trend, mix and buyer performance.
      .in('status', [...APPROVED_SALES_STATUSES, ...PIPELINE_STATUSES, CANCELLED_STATUS])
      // Entry order: it only decides which rows the "recent" activity list shows.
      .order('created_at', { ascending: false })

    // Apply date filters. The client sends instants; order_date is compared
    // with the Malaysia calendar days they fall on (inclusive).
    const startKey = startDate ? malaysiaDateOf(startDate) : null
    const endKey = endDate ? malaysiaDateOf(endDate) : null
    if (startDate) {
      ordersQuery = dateColumn === 'order_date' && startKey
        ? ordersQuery.gte('order_date', startKey)
        : ordersQuery.gte('created_at', startDate)
    }
    if (endDate) {
      ordersQuery = dateColumn === 'order_date' && endKey
        ? ordersQuery.lte('order_date', endKey)
        : ordersQuery.lte('created_at', endDate)
    }
    
    // Filter by distributor if specified
    if (distributorId) {
      ordersQuery = ordersQuery.eq('buyer_org_id', distributorId)
    }

    const { data: orders, error: ordersError } = await ordersQuery

    console.log('[Reporting API] Orders query result:', { 
      orderCount: orders?.length || 0, 
      ordersError: ordersError?.message,
      firstOrder: orders?.[0] ? { id: orders[0].id, status: orders[0].status } : null
    })

    if (ordersError) {
      console.error('[Reporting API] Orders fetch error:', ordersError)
      return NextResponse.json({ error: ordersError.message }, { status: 500 })
    }

    // 2. Fetch Product Variants for names
    const variantIds = new Set<string>()
    orders?.forEach((order: any) => {
      order.order_items?.forEach((item: any) => {
        if (item.variant_id) variantIds.add(item.variant_id)
      })
    })

    let productNames: Record<string, string> = {}
    if (variantIds.size > 0) {
      const { data: variants } = await supabase
        .from('product_variants')
        .select(`
          id,
          variant_code,
          variant_name,
          products (
            product_name
          )
        `)
        .in('id', Array.from(variantIds))

      variants?.forEach((v: any) => {
        const pName = v.products?.product_name
        const vName = v.variant_name
        const fullName = pName && vName && pName !== vName ? `${pName} - ${vName}` : (vName || pName || 'Unknown Product')
        // Extract content within brackets [ ] for shorter names
        const match = fullName.match(/\[(.*?)\]/)
        productNames[v.id] = match ? match[1].trim() : fullName
      })
    }

    // 3. Process statistics. Status mix first (every fetched order), then confirmed sales only.
    const orderValueOf = (order: any) => (order.order_items ?? []).reduce((sum: number, item: any) => sum + (Number(item.line_total) || 0), 0)
    const salesSummary = summarizeSales((orders ?? []).map((order: any) => ({ status: order.status, orderType: order.order_type, value: orderValueOf(order) })))
    const stats = {
      totalUnits: 0,
      totalRevenue: 0,
      totalOrders: 0,
      ordersInProgress: 0,
      completedOrders: 0,
      activeDistributors: new Set<string>(),
      distributorPerformance: {} as Record<string, { units: number; revenue: number }>,
      productMix: {} as Record<string, number>,
      trend: {} as Record<string, { units: number; orders: number; revenue: number }>,
      recentShipments: [] as any[]
    }

    orders?.forEach((order: any) => {
      // Approved Sales only: sell-side orders (H2M purchases excluded) that reached approval and are not cancelled.
      if (salesClassOf(order.status) !== 'approved_sales' || String(order.order_type).toUpperCase() === 'H2M') return
      // Business date (Malaysia calendar day) — never the UTC day of created_at.
      const businessDate = orderBusinessDate(order) ?? ''
      const monthKey = businessDate.slice(0, 7) // YYYY-MM

      // Get distributor name (buyer for orders)
      const distributorName = order.buyer?.org_name || 'Unknown'
      const isDistributor = order.buyer?.org_type_code === 'DIST'
      
      stats.totalOrders++
      
      // Track order status
      if (['approved', 'warehouse_packed'].includes(order.status)) {
        stats.ordersInProgress++
      } else if (['closed', 'shipped_distributor'].includes(order.status)) {
        stats.completedOrders++
      }

      // Track distributors
      if (isDistributor || order.buyer?.org_type_code === 'SHOP') {
        stats.activeDistributors.add(distributorName)
      }

      // Process order items
      let orderUnits = 0
      let orderRevenue = 0
      
      order.order_items?.forEach((item: any) => {
        const qty = item.qty || 0
        const lineTotal = Number(item.line_total) || 0
        
        orderUnits += qty
        orderRevenue += lineTotal

        // Product mix
        if (item.variant_id) {
          stats.productMix[item.variant_id] = (stats.productMix[item.variant_id] || 0) + qty
        }
      })

      stats.totalUnits += orderUnits
      stats.totalRevenue += orderRevenue

      // Distributor performance
      if (!stats.distributorPerformance[distributorName]) {
        stats.distributorPerformance[distributorName] = { units: 0, revenue: 0 }
      }
      stats.distributorPerformance[distributorName].units += orderUnits
      stats.distributorPerformance[distributorName].revenue += orderRevenue

      // Monthly trend
      if (!stats.trend[monthKey]) {
        stats.trend[monthKey] = { units: 0, orders: 0, revenue: 0 }
      }
      stats.trend[monthKey].units += orderUnits
      stats.trend[monthKey].orders++
      stats.trend[monthKey].revenue += orderRevenue

      // Recent shipments
      if (stats.recentShipments.length < 10) {
        stats.recentShipments.push({
          id: order.id,
          // Activity list rendered with a time of day: the real entry instant.
          date: order.created_at,
          orderDate: businessDate || null,
          distributor: distributorName,
          orderNo: order.display_doc_no || order.order_no,
          units: orderUnits,
          revenue: orderRevenue,
          status: order.status
        })
      }
    })

    // 4. Fetch inventory summary
    const { data: inventory } = await supabase
      .from('product_inventory')
      .select('variant_id, quantity_on_hand, quantity_available, cases_on_hand, units_on_hand')

    let totalInventory = 0
    let totalSKUs = new Set<string>()
    inventory?.forEach((inv: any) => {
      totalInventory += (inv.quantity_on_hand || 0)
      if (inv.variant_id) totalSKUs.add(inv.variant_id)
    })

    // 5. Fetch document stats
    const { data: documents } = await supabase
      .from('documents')
      .select('doc_type, status')
      .in('doc_type', ['PO', 'INVOICE', 'PAYMENT', 'RECEIPT', 'DO'])

    const docStats = {
      totalPOs: 0,
      totalInvoices: 0,
      totalPayments: 0,
      pendingDOs: 0
    }
    documents?.forEach((doc: any) => {
      if (doc.doc_type === 'PO') docStats.totalPOs++
      if (doc.doc_type === 'INVOICE') docStats.totalInvoices++
      if (doc.doc_type === 'PAYMENT' && doc.status === 'acknowledged') docStats.totalPayments++
      if (doc.doc_type === 'DO' && doc.status === 'pending') docStats.pendingDOs++
    })

    // Format for frontend
    const response = {
      summary: {
        totalUnits: stats.totalUnits,
        // totalRevenue is kept for compatibility and equals approvedSalesValue.
        totalRevenue: stats.totalRevenue,
        approvedSalesValue: stats.totalRevenue,
        approvedSalesOrders: stats.totalOrders,
        pipelineValue: salesSummary.pipelineValue,
        pipelineOrders: salesSummary.pipelineOrders,
        cancelledValue: salesSummary.cancelledValue,
        cancelledOrders: salesSummary.cancelledOrders,
        purchaseValue: salesSummary.purchaseValue,
        purchaseOrders: salesSummary.purchaseOrders,
        totalOrders: stats.totalOrders,
        ordersInProgress: stats.ordersInProgress,
        completedOrders: stats.completedOrders,
        activeDistributors: stats.activeDistributors.size,
        totalInventory,
        totalSKUs: totalSKUs.size,
        ...docStats
      },
      trend: Object.entries(stats.trend)
        .map(([date, data]) => ({ 
          date, 
          units: data.units,
          orders: data.orders,
          revenue: data.revenue
        }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      productMix: Object.entries(stats.productMix)
        .map(([id, units]) => ({
          id,
          name: productNames[id] || 'Unknown Product',
          units
        }))
        .sort((a, b) => b.units - a.units)
        .slice(0, 10),
      distributorPerformance: Object.entries(stats.distributorPerformance)
        .map(([name, data]) => ({ 
          name, 
          units: data.units,
          revenue: data.revenue
        }))
        .sort((a, b) => b.units - a.units)
        .slice(0, 10),
      recentShipments: stats.recentShipments,
      inventory: {
        total: totalInventory,
        skuCount: totalSKUs.size,
        items: inventory || []
      }
    }

    // Final log before returning
    console.log('[Reporting API] Returning response:', {
      summary: response.summary,
      trendItems: response.trend.length,
      productMixItems: response.productMix.length,
      distributorItems: response.distributorPerformance.length
    })

    return NextResponse.json(response)
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
