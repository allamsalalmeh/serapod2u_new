/**
 * Reserved (product_inventory.quantity_allocated) drill-down — pure logic.
 *
 * Proven writers of quantity_allocated and the ledger rows they post
 * (supabase/schemas/current_schema.sql + 20261220100000_inventory_cases_and_pcs.sql):
 *
 *   Orders (D2H / S2D)
 *     allocate_inventory_for_order        +qty  'allocation'        ref 'order'               warehouse = from_org
 *     release_allocation_for_order        -qty  'deallocation'      ref 'order'               warehouse = to_org
 *     fulfill_order_inventory             -qty  'order_fulfillment' ref 'order'               warehouse = from_org
 *     set_order_item_stock_config         -/+   deallocation/allocation ref 'order_config_change' (moves between configs)
 *     stock_count_carry_classification_allocations   same pair, ref 'order_config_change'
 *     verify_and_post_inventory_opening_cutoff*      carried forward: +qty 'allocation' ref 'order_config_change'
 *   Stock transfers
 *     _stock_transfer_reserve_items       +qty  'allocation'        ref 'transfer'            warehouse = from_org (source)
 *     _stock_transfer_release_reservations -qty 'deallocation'      ref 'transfer'            warehouse = to_org   (source)
 *       (called on dispatch, cancel and reject)
 *   Not attributable to a record
 *     resolve_inventory_cutoff_allocation  -qty 'deallocation' ref 'opening_balance_cutoff' (orphan release)
 *     opening cut-off posting              quantity_allocated := 0 on every counted row,
 *                                          with NO release movement, then re-adds carried orders.
 *
 * Therefore a record's CURRENT reservation is the net of its own allocation
 * ledger at this warehouse/configuration, counting only movements at or after
 * the latest posted opening cut-off that reset that configuration. Anything the
 * ledger cannot attribute (legacy null-configuration allocations, pre-ledger
 * balances, manual writes) is reported as an explicit unreconciled amount — it
 * is never invented, hidden or "repaired". Nothing here writes.
 */

export type ReservationSourceType = 'order' | 'transfer'

export interface ReservationMovement {
  movement_type: string
  reference_type: string | null
  reference_id: string | null
  reference_no?: string | null
  stock_config_id: string | null
  from_organization_id: string | null
  to_organization_id: string | null
  quantity_change: number | null
  created_at: string
}

export interface ReservationRecord {
  key: string
  sourceType: ReservationSourceType
  referenceId: string
  /** reference_no from the ledger; only shown when the record itself is readable. */
  ledgerReferenceNo: string | null
  /** Current outstanding reservation in whole stock units (cases / pcs). */
  reserved: number
  /** Earliest counted allocation movement for this record (accurate "Reserved since"). */
  reservedSince: string | null
  /** Configurations in scope that this record currently reserves. */
  configIds: string[]
}

export interface ReservationAnomaly {
  sourceType: ReservationSourceType
  referenceId: string
  configId: string | null
  /** Negative net: the ledger released more than it reserved after the boundary. */
  net: number
}

export interface ReservationBreakdown {
  records: ReservationRecord[]
  /** Sum of record reservations (all records, never only a page). */
  attributedTotal: number
  /** The Reserved figure that was clicked (stored quantity_allocated, summed over scope). */
  storedTotal: number
  /** storedTotal - attributedTotal. Non-zero is shown, never hidden. */
  unreconciled: number
  anomalies: ReservationAnomaly[]
}

export interface ReservationScope {
  warehouseOrgId: string
  /** Configurations included in the clicked inventory row. */
  configIds: string[]
  /**
   * Include ledger rows that carry no configuration (pre-configuration legacy
   * allocations). Only meaningful for a whole-flavour row; a single
   * configuration row cannot claim them.
   */
  includeUnconfigured: boolean
  /** configId → ISO time of the latest posted opening cut-off that reset it. */
  cutoffBoundaries?: Map<string, string>
}

const ORDER_REFERENCES = new Set(['order', 'order_config_change'])
const RESERVATION_MOVEMENTS = new Set(['allocation', 'deallocation', 'order_fulfillment'])

export const RESERVATION_MOVEMENT_TYPES = ['allocation', 'deallocation', 'order_fulfillment'] as const

function sourceTypeOf(movement: ReservationMovement): ReservationSourceType | null {
  const ref = (movement.reference_type || '').toLowerCase()
  if (ORDER_REFERENCES.has(ref)) return 'order'
  if (ref === 'transfer') return 'transfer'
  return null
}

/** Organisation whose quantity_allocated a ledger row changed. */
export function reservationWarehouseOf(movement: ReservationMovement): string | null {
  switch (movement.movement_type) {
    case 'allocation':
    case 'order_fulfillment':
      return movement.from_organization_id
    case 'deallocation':
      return movement.to_organization_id
    default:
      return null
  }
}

/** Signed effect on quantity_allocated. */
function reservationDelta(movement: ReservationMovement, source: ReservationSourceType): number {
  const qty = Math.abs(Number(movement.quantity_change) || 0)
  if (movement.movement_type === 'allocation') return qty
  if (movement.movement_type === 'deallocation') return -qty
  // Only an order fulfilment consumes an order reservation.
  if (movement.movement_type === 'order_fulfillment' && source === 'order') return -qty
  return 0
}

export function buildReservationBreakdown(
  movements: ReservationMovement[],
  scope: ReservationScope,
  storedTotal: number,
): ReservationBreakdown {
  const inScope = new Set(scope.configIds)
  const boundaries = scope.cutoffBoundaries ?? new Map<string, string>()
  const latestBoundary = Array.from(boundaries.values()).sort().pop() ?? null

  // Net per (source, reference, configuration) first: a configuration change
  // inside one order nets to its final configuration, and a duplicate joined
  // row can never be counted twice because each ledger row is counted once.
  const perConfig = new Map<string, {
    sourceType: ReservationSourceType
    referenceId: string
    configId: string | null
    net: number
    since: string | null
    referenceNo: string | null
  }>()

  for (const movement of movements) {
    if (!RESERVATION_MOVEMENTS.has(movement.movement_type)) continue
    const source = sourceTypeOf(movement)
    if (!source || !movement.reference_id) continue
    if (reservationWarehouseOf(movement) !== scope.warehouseOrgId) continue

    const configId = movement.stock_config_id
    if (configId === null) {
      if (!scope.includeUnconfigured) continue
      // A legacy unconfigured row predates any posted cut-off of this warehouse.
      if (latestBoundary && movement.created_at < latestBoundary) continue
    } else {
      if (!inScope.has(configId)) continue
      const boundary = boundaries.get(configId)
      if (boundary && movement.created_at < boundary) continue
    }

    const delta = reservationDelta(movement, source)
    if (delta === 0) continue
    const key = `${source}:${movement.reference_id}:${configId ?? 'unconfigured'}`
    const entry = perConfig.get(key) ?? {
      sourceType: source,
      referenceId: movement.reference_id,
      configId,
      net: 0,
      since: null,
      referenceNo: movement.reference_no ?? null,
    }
    entry.net += delta
    if (delta > 0 && (entry.since === null || movement.created_at < entry.since)) entry.since = movement.created_at
    if (!entry.referenceNo && movement.reference_no) entry.referenceNo = movement.reference_no
    perConfig.set(key, entry)
  }

  const anomalies: ReservationAnomaly[] = []
  const byRecord = new Map<string, ReservationRecord>()
  for (const entry of perConfig.values()) {
    if (entry.net < 0) {
      anomalies.push({ sourceType: entry.sourceType, referenceId: entry.referenceId, configId: entry.configId, net: entry.net })
      continue
    }
    if (entry.net === 0) continue
    const key = `${entry.sourceType}:${entry.referenceId}`
    const record = byRecord.get(key) ?? {
      key,
      sourceType: entry.sourceType,
      referenceId: entry.referenceId,
      ledgerReferenceNo: entry.referenceNo,
      reserved: 0,
      reservedSince: null,
      configIds: [],
    }
    record.reserved += entry.net
    if (entry.since && (record.reservedSince === null || entry.since < record.reservedSince)) {
      record.reservedSince = entry.since
    }
    if (entry.configId) record.configIds.push(entry.configId)
    byRecord.set(key, record)
  }

  const records = Array.from(byRecord.values()).sort((a, b) =>
    (a.reservedSince ?? '').localeCompare(b.reservedSince ?? '') || a.referenceId.localeCompare(b.referenceId),
  )
  const attributedTotal = records.reduce((sum, record) => sum + record.reserved, 0)
  return {
    records,
    attributedTotal,
    storedTotal,
    unreconciled: storedTotal - attributedTotal,
    anomalies,
  }
}

/** Latest posted cut-off per configuration from cut-offs and their counted items. */
export function buildCutoffBoundaries(
  cutoffs: Array<{ stock_count_session_id: string; posted_at: string | null; status: string }>,
  countedItems: Array<{ session_id: string; stock_config_id: string | null; physical_quantity: number | null }>,
): Map<string, string> {
  const postedAtBySession = new Map<string, string>()
  for (const cutoff of cutoffs) {
    if (cutoff.status !== 'posted' || !cutoff.posted_at) continue
    postedAtBySession.set(cutoff.stock_count_session_id, cutoff.posted_at)
  }
  const boundaries = new Map<string, string>()
  for (const item of countedItems) {
    if (item.physical_quantity === null || item.physical_quantity === undefined) continue
    if (!item.stock_config_id) continue
    const postedAt = postedAtBySession.get(item.session_id)
    if (!postedAt) continue
    const current = boundaries.get(item.stock_config_id)
    if (!current || postedAt > current) boundaries.set(item.stock_config_id, postedAt)
  }
  return boundaries
}

const ORDER_STATUS_LABELS: Record<string, string> = {
  submitted: 'Submitted',
  approved: 'Approved',
  draft: 'Draft',
  cancelled: 'Cancelled',
  closed: 'Closed',
}
const TRANSFER_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  pending: 'Pending',
  pending_approval: 'Pending Approval',
  ready_to_dispatch: 'Ready to Dispatch',
  in_transit: 'In Transit',
  received: 'Received',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
}

export function reservationStatusLabel(sourceType: ReservationSourceType, status: string | null | undefined): string {
  if (!status) return 'Unknown'
  const map = sourceType === 'order' ? ORDER_STATUS_LABELS : TRANSFER_STATUS_LABELS
  return map[status] ?? status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Statuses in which a record is expected to hold a reservation. Used only to
 * FLAG a ledger reservation on an unexpected status — never to include or
 * exclude records (the ledger is the source of truth).
 */
export function isExpectedReservingStatus(sourceType: ReservationSourceType, status: string | null | undefined): boolean {
  if (!status) return false
  if (sourceType === 'order') return status === 'submitted'
  return status === 'pending_approval' || status === 'ready_to_dispatch' || status === 'pending'
}
