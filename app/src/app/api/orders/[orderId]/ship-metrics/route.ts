import { guardUserOperation } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const parseUUID = (value: string | null) => {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  // Simple UUID v4 format check (8-4-4-4-12 hex)
  const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
  return uuidRegex.test(trimmed) ? trimmed : null
}

// Keeps PostgREST `in.(...)` filters well inside URL limits.
const IN_CHUNK_SIZE = 100
// PostgREST caps a response at its max-rows setting; read every page.
const PAGE_SIZE = 1000

const chunk = <T,>(values: T[]): T[][] => {
  const chunks: T[][] = []
  for (let i = 0; i < values.length; i += IN_CHUNK_SIZE) chunks.push(values.slice(i, i + IN_CHUNK_SIZE))
  return chunks
}

type PageResult<T> = PromiseLike<{ data: T[] | null; error: unknown }>

const readAllPages = async <T,>(page: (from: number, to: number) => PageResult<T>): Promise<T[]> => {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1)
    if (error) throw error
    rows.push(...(data ?? []))
    if (!data || data.length < PAGE_SIZE) return rows
  }
}

type MasterRecord = {
  id: string
  status: string | null
  actual_unit_count: number | null
  expected_unit_count: number | null
}

const resolveUnitsForMaster = (record: MasterRecord): number => {
  const actual = typeof record.actual_unit_count === 'number' ? record.actual_unit_count : null
  const expected = typeof record.expected_unit_count === 'number' ? record.expected_unit_count : null
  const candidate = actual && actual > 0 ? actual : expected
  return candidate && candidate > 0 ? candidate : 0
}

/**
 * D2H shipping metrics for one warehouse.
 *
 * - units_shipped: order_fulfillment stock movements that reference this D2H
 *   order and leave this warehouse (written by fulfill_order_inventory).
 * - cases_shipped: master cases scanned in this warehouse's approved shipping
 *   sessions whose source_order_id is this D2H order (the link WarehouseShipV2
 *   writes and confirm-shipment acts on). QR batches belong to H2M production
 *   orders, so batch order ids are never used to attribute D2H shipments.
 * - cases_received / units_received: H2M warehouse receiving cannot be
 *   attributed to a D2H order, so they are null and received_metrics_available
 *   is false.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ orderId: string }> }) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const saDenied = await guardUserOperation(user.id, 'inventory.report.view')
    if (saDenied) return saDenied

    const { orderId: orderIdParam } = await context.params
    const orderId = parseUUID(orderIdParam)

    if (!orderId) {
      return NextResponse.json({ error: 'Valid orderId is required' }, { status: 400 })
    }

    // Use the authenticated client so orders_select RLS validates the caller's
    // real organization relationship. Never trust a manufacturer id supplied
    // by the browser.
    const { data: accessibleOrder, error: orderAccessError } = await supabase
      .from('orders')
      .select('id, order_type')
      .eq('id', orderId)
      .maybeSingle()

    if (orderAccessError || !accessibleOrder) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    if (accessibleOrder.order_type !== 'D2H') {
      return NextResponse.json(
        { error: 'Shipping metrics are only available for D2H orders' },
        { status: 422 }
      )
    }

    const searchParams = request.nextUrl.searchParams
    const warehouseId = parseUUID(searchParams.get('warehouseId') || searchParams.get('warehouse_id'))

    if (!warehouseId) {
      return NextResponse.json({ error: 'warehouseId query parameter is required' }, { status: 400 })
    }

    // --- Units shipped (movement-based) ---
    const { data: movementRows, error: movementError } = await supabase
      .from('v_stock_movements_display')
      .select('quantity_change')
      .eq('movement_type', 'order_fulfillment')
      .eq('reference_type', 'order')
      .eq('reference_id', orderId)
      .eq('from_organization_id', warehouseId)

    if (movementError) {
      console.error('[ship-metrics] Failed to load stock movements', movementError)
      return NextResponse.json({ error: 'Unable to load shipment movements' }, { status: 500 })
    }

    let unitsShipped = 0
    if (Array.isArray(movementRows)) {
      for (const row of movementRows) {
        const change = typeof row.quantity_change === 'number' ? row.quantity_change : 0
        if (change < 0) {
          unitsShipped += -change
        }
      }
    }

    // --- Master cases shipped against this D2H order ---
    const { data: sessions, error: sessionError } = await supabase
      .from('qr_validation_reports')
      .select('id, master_codes_scanned')
      .eq('source_order_id', orderId)
      .eq('warehouse_org_id', warehouseId)
      .eq('validation_status', 'approved')

    if (sessionError) {
      console.error('[ship-metrics] Failed to load shipping sessions', sessionError)
      return NextResponse.json({ error: 'Unable to load shipping sessions' }, { status: 500 })
    }

    const masterCodes = Array.from(new Set(
      (sessions || []).flatMap((session) => (Array.isArray(session.master_codes_scanned) ? session.master_codes_scanned : []))
    ))

    const mastersById = new Map<string, MasterRecord>()
    try {
      for (const codes of chunk(masterCodes)) {
        const rows = await readAllPages<MasterRecord>((from, to) =>
          supabase
            .from('qr_master_codes')
            .select('id, status, actual_unit_count, expected_unit_count')
            .in('master_code', codes)
            .eq('warehouse_org_id', warehouseId)
            .order('id', { ascending: true })
            .range(from, to)
        )
        for (const row of rows) mastersById.set(row.id, row)
      }
    } catch (masterError) {
      console.error('[ship-metrics] Failed to load master cases', masterError)
      return NextResponse.json({ error: 'Unable to load master case data' }, { status: 500 })
    }

    // --- Shipped (non-buffer) unique codes per master ---
    const shippedUniquelyByMaster = new Map<string, number>()
    try {
      for (const ids of chunk(Array.from(mastersById.keys()))) {
        const rows = await readAllPages<{ master_code_id: string | null }>((from, to) =>
          supabase
            .from('qr_codes')
            .select('id, master_code_id')
            .eq('status', 'shipped_distributor')
            .eq('is_buffer', false)
            .in('master_code_id', ids)
            .order('id', { ascending: true })
            .range(from, to)
        )
        for (const row of rows) {
          if (!row.master_code_id) continue
          shippedUniquelyByMaster.set(row.master_code_id, (shippedUniquelyByMaster.get(row.master_code_id) ?? 0) + 1)
        }
      }
    } catch (shippedUniqueError) {
      console.error('[ship-metrics] Failed to load shipped unique codes', shippedUniqueError)
      return NextResponse.json({ error: 'Unable to load shipped unit details' }, { status: 500 })
    }

    let casesShipped = 0
    for (const master of mastersById.values()) {
      const caseUnits = resolveUnitsForMaster(master)
      const masterShipped = master.status === 'shipped_distributor'
      const shippedUniqueCount = shippedUniquelyByMaster.get(master.id) ?? 0

      const shippedViaUnits = caseUnits > 0 && shippedUniqueCount >= caseUnits
      if (masterShipped || shippedViaUnits) {
        casesShipped += 1
      }
    }

    return NextResponse.json({
      order_id: orderId,
      warehouse_id: warehouseId,
      cases_shipped: casesShipped,
      units_shipped: unitsShipped,
      cases_received: null,
      units_received: null,
      received_metrics_available: false
    })
  } catch (error: any) {
    console.error('[ship-metrics] Unexpected error', error)
    return NextResponse.json({ error: 'Unexpected error' }, { status: 500 })
  }
}
