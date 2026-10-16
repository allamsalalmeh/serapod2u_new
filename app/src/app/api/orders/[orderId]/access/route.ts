import { NextRequest, NextResponse } from 'next/server'

import { createClient } from '@/lib/supabase/server'
import { authorizeOperation, organizationResource } from '@/lib/security-access/operation'
import { legacyOrderView, orderViewOrganizations } from '@/lib/security-access/order-view'

const relation = <T,>(value: T | T[] | null | undefined): T | null => Array.isArray(value) ? value[0] || null : value || null

export async function GET(_request: NextRequest, { params }: { params: Promise<{ orderId: string }> }) {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { orderId } = await params
  if (!orderId) return NextResponse.json({ error: 'Order ID is required' }, { status: 400 })

  const { data: requester, error: requesterError } = await supabase
    .from('users')
    .select('organization_id, organizations:organization_id(org_type_code), roles:role_code(role_level)')
    .eq('id', user.id)
    .single()

  if (requesterError || !requester?.organization_id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Authenticated client deliberately invokes orders_select RLS first.
  const { data: order, error: orderError } = await supabase
    .from('orders')
    .select('id, order_type, company_id, buyer_org_id, seller_org_id, warehouse_org_id')
    .eq('id', orderId)
    .maybeSingle()

  if (orderError || !order) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const org = relation(requester.organizations as any) as { org_type_code?: string } | null
  const role = relation(requester.roles as any) as { role_level?: number } | null
  const orgType = String(org?.org_type_code || '').toUpperCase()

  if (orgType === 'MFG' || orgType === 'MANU') {
    if (order.seller_org_id !== requester.organization_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  // View Orders (supply_chain.order.view) on one of the order's parties, from the row the server just loaded — never an
  // organization from the request. The approval organization is asked first, so an Order Approver who may approve the
  // order may also open it. In legacy modes the historical Order Details rule (role level 40) decides.
  let unavailable = false
  for (const organizationId of orderViewOrganizations(order)) {
    const decision = await authorizeOperation({
      actorId: user.id,
      permission: 'supply_chain.order.view',
      resource: organizationResource('order', organizationId, { id: order.id }),
      legacy: () => legacyOrderView(role?.role_level),
    }).catch(() => null)
    if (decision?.decision === 'ALLOW') return NextResponse.json({ success: true, order_id: order.id })
    // An infrastructure failure is not a confirmed denial (never an implicit allow either).
    if (!decision || (decision as { unavailable?: boolean }).unavailable) unavailable = true
  }

  if (unavailable) {
    return NextResponse.json({ error: 'Authorization service unavailable', code: 'sa_unavailable' }, { status: 503 })
  }
  return NextResponse.json({ error: 'You do not have permission to view this order', code: 'sa_forbidden', permission: 'supply_chain.order.view' }, { status: 403 })
}
