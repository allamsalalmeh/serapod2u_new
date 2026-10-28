/**
 * Loads the Reserved drill-down with the signed-in user's Supabase client.
 *
 * Read-only: SELECTs only, through RLS (stock_movements_inventory_read,
 * orders_select, stock_transfers_view_all, inventory_cutoffs_read, …). No
 * service role, no RPC that writes, no recalculation of quantity_allocated.
 * A record whose detail RLS does not return is shown as restricted (quantity
 * only) rather than revealed.
 */
import {
  RESERVATION_MOVEMENT_TYPES,
  buildCutoffBoundaries,
  buildReservationBreakdown,
  type ReservationBreakdown,
  type ReservationMovement,
  type ReservationSourceType,
} from './reserved-stock'

export interface ReservationLoadParams {
  variantId: string
  warehouseOrgId: string
  configIds: string[]
  includeUnconfigured: boolean
  storedReserved: number
}

export interface ReservationDetailRow {
  key: string
  sourceType: ReservationSourceType
  referenceId: string
  /** False when RLS did not return the record: no number, party or link is shown. */
  accessible: boolean
  referenceNo: string | null
  counterpartyName: string | null
  status: string | null
  reserved: number
  reservedSince: string | null
  href: string | null
}

export interface ReservationLoadResult extends Omit<ReservationBreakdown, 'records'> {
  rows: ReservationDetailRow[]
  restrictedCount: number
  /** A posted cut-off exists but its counted items were not readable. */
  cutoffBoundaryUncertain: boolean
  sources: ReservationSourceType[]
}

const MOVEMENT_COLUMNS =
  'movement_type,reference_type,reference_id,reference_no,stock_config_id,from_organization_id,to_organization_id,quantity_change,created_at'
const PAGE = 1000

async function fetchAllMovements(supabase: any, params: ReservationLoadParams): Promise<ReservationMovement[]> {
  const rows: ReservationMovement[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('stock_movements')
      .select(MOVEMENT_COLUMNS)
      .eq('variant_id', params.variantId)
      .in('movement_type', RESERVATION_MOVEMENT_TYPES as unknown as string[])
      .or(`from_organization_id.eq.${params.warehouseOrgId},to_organization_id.eq.${params.warehouseOrgId}`)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    const page = (data || []) as ReservationMovement[]
    rows.push(...page)
    if (page.length < PAGE) return rows
  }
}

export async function loadReservationBreakdown(
  supabase: any,
  params: ReservationLoadParams,
): Promise<ReservationLoadResult> {
  const movements = await fetchAllMovements(supabase, params)

  // Opening cut-off boundary (reset without release movements).
  let cutoffBoundaryUncertain = false
  let boundaries = new Map<string, string>()
  const { data: cutoffs, error: cutoffError } = await supabase
    .from('inventory_opening_cutoffs')
    .select('stock_count_session_id,posted_at,status')
    .eq('warehouse_organization_id', params.warehouseOrgId)
    .eq('status', 'posted')
  if (cutoffError) {
    cutoffBoundaryUncertain = true
  } else if ((cutoffs || []).length > 0) {
    const sessionIds = (cutoffs as any[]).map((cutoff) => cutoff.stock_count_session_id)
    const { data: items, error: itemsError } = await supabase
      .from('stock_count_session_items')
      .select('session_id,stock_config_id,physical_quantity')
      .in('session_id', sessionIds)
      .eq('variant_id', params.variantId)
      .not('physical_quantity', 'is', null)
    if (itemsError || (items || []).length === 0) cutoffBoundaryUncertain = true
    boundaries = buildCutoffBoundaries(cutoffs as any[], (items || []) as any[])
  }

  const breakdown = buildReservationBreakdown(
    movements,
    {
      warehouseOrgId: params.warehouseOrgId,
      configIds: params.configIds,
      includeUnconfigured: params.includeUnconfigured,
      cutoffBoundaries: boundaries,
    },
    params.storedReserved,
  )

  const orderIds = breakdown.records.filter((r) => r.sourceType === 'order').map((r) => r.referenceId)
  const transferIds = breakdown.records.filter((r) => r.sourceType === 'transfer').map((r) => r.referenceId)

  const orders = new Map<string, any>()
  if (orderIds.length) {
    const { data, error } = await supabase
      .from('orders')
      .select('id,order_no,display_doc_no,status,order_type,buyer_org_id')
      .in('id', orderIds)
    if (error) throw error
    for (const row of data || []) orders.set(row.id, row)
  }
  const transfers = new Map<string, any>()
  if (transferIds.length) {
    const { data, error } = await supabase
      .from('stock_transfers')
      .select('id,transfer_no,status,to_organization_id')
      .in('id', transferIds)
    if (error) throw error
    for (const row of data || []) transfers.set(row.id, row)
  }

  const orgIds = Array.from(new Set([
    ...Array.from(orders.values()).map((o) => o.buyer_org_id),
    ...Array.from(transfers.values()).map((t) => t.to_organization_id),
  ].filter(Boolean)))
  const orgNames = new Map<string, string>()
  if (orgIds.length) {
    const { data } = await supabase.from('organizations').select('id,org_name').in('id', orgIds)
    for (const row of data || []) orgNames.set(row.id, row.org_name)
  }

  let restrictedCount = 0
  const rows: ReservationDetailRow[] = breakdown.records.map((record) => {
    if (record.sourceType === 'order') {
      const order = orders.get(record.referenceId)
      if (!order) restrictedCount += 1
      const referenceNo = order ? (order.display_doc_no || order.order_no) : null
      return {
        key: record.key,
        sourceType: 'order',
        referenceId: record.referenceId,
        accessible: Boolean(order),
        referenceNo,
        counterpartyName: order ? (orgNames.get(order.buyer_org_id) ?? null) : null,
        status: order?.status ?? null,
        reserved: record.reserved,
        reservedSince: record.reservedSince,
        href: order ? `/supply-chain?view=view-order&orderId=${record.referenceId}` : null,
      }
    }
    const transfer = transfers.get(record.referenceId)
    if (!transfer) restrictedCount += 1
    return {
      key: record.key,
      sourceType: 'transfer',
      referenceId: record.referenceId,
      accessible: Boolean(transfer),
      referenceNo: transfer?.transfer_no ?? null,
      counterpartyName: transfer ? (orgNames.get(transfer.to_organization_id) ?? null) : null,
      status: transfer?.status ?? null,
      reserved: record.reserved,
      reservedSince: record.reservedSince,
      // Same destination the Incoming popup uses for transfers (no transfer detail page exists).
      href: transfer ? `/dashboard?view=stock-movements&id=${encodeURIComponent(transfer.transfer_no)}` : null,
    }
  })

  const { records: _records, ...totals } = breakdown
  return {
    ...totals,
    rows,
    restrictedCount,
    cutoffBoundaryUncertain,
    sources: Array.from(new Set(rows.map((row) => row.sourceType))),
  }
}
