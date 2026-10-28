import { describe, expect, it } from 'vitest'
import {
  buildCutoffBoundaries,
  buildReservationBreakdown,
  isExpectedReservingStatus,
  reservationWarehouseOf,
  type ReservationMovement,
} from './reserved-stock'

const WH = 'wh-hq'
const OTHER_WH = 'wh-north'
const BUYER = 'dist-a'
const CFG = 'cfg-20nb'
const CFG_LEGACY = 'cfg-legacy'

let clock = 0
const at = () => new Date(Date.UTC(2026, 9, 1, 0, 0, clock++)).toISOString()

// Exactly the column shapes the SQL writers post (see reserved-stock.ts header).
const allocate = (orderId: string, qty: number, cfg: string | null = CFG, wh = WH, created_at = at()): ReservationMovement => ({
  movement_type: 'allocation', reference_type: 'order', reference_id: orderId, reference_no: orderId.toUpperCase(),
  stock_config_id: cfg, from_organization_id: wh, to_organization_id: BUYER, quantity_change: qty, created_at,
})
const release = (orderId: string, qty: number, cfg: string | null = CFG, wh = WH, created_at = at()): ReservationMovement => ({
  movement_type: 'deallocation', reference_type: 'order', reference_id: orderId, reference_no: orderId.toUpperCase(),
  stock_config_id: cfg, from_organization_id: BUYER, to_organization_id: wh, quantity_change: -qty, created_at,
})
const fulfil = (orderId: string, qty: number, cfg = CFG, wh = WH): ReservationMovement => ({
  movement_type: 'order_fulfillment', reference_type: 'order', reference_id: orderId, reference_no: orderId.toUpperCase(),
  stock_config_id: cfg, from_organization_id: wh, to_organization_id: BUYER, quantity_change: -qty, created_at: at(),
})
const configChange = (orderId: string, qty: number, fromCfg: string, toCfg: string): ReservationMovement[] => [
  { movement_type: 'deallocation', reference_type: 'order_config_change', reference_id: orderId, reference_no: null,
    stock_config_id: fromCfg, from_organization_id: BUYER, to_organization_id: WH, quantity_change: -qty, created_at: at() },
  { movement_type: 'allocation', reference_type: 'order_config_change', reference_id: orderId, reference_no: null,
    stock_config_id: toCfg, from_organization_id: WH, to_organization_id: BUYER, quantity_change: qty, created_at: at() },
]
const transferReserve = (id: string, qty: number, cfg = CFG): ReservationMovement => ({
  movement_type: 'allocation', reference_type: 'transfer', reference_id: id, reference_no: id.toUpperCase(),
  stock_config_id: cfg, from_organization_id: WH, to_organization_id: OTHER_WH, quantity_change: qty, created_at: at(),
})
const transferRelease = (id: string, qty: number, cfg = CFG): ReservationMovement => ({
  movement_type: 'deallocation', reference_type: 'transfer', reference_id: id, reference_no: id.toUpperCase(),
  stock_config_id: cfg, from_organization_id: OTHER_WH, to_organization_id: WH, quantity_change: -qty, created_at: at(),
})

const scope = (overrides: Partial<Parameters<typeof buildReservationBreakdown>[1]> = {}) => ({
  warehouseOrgId: WH, configIds: [CFG], includeUnconfigured: false, ...overrides,
})

describe('Reserved sources and warehouse side', () => {
  it('reads the reserving warehouse from the side each writer posts', () => {
    expect(reservationWarehouseOf(allocate('o', 1))).toBe(WH)
    expect(reservationWarehouseOf(release('o', 1))).toBe(WH)
    expect(reservationWarehouseOf(fulfil('o', 1))).toBe(WH)
    expect(reservationWarehouseOf(transferReserve('t', 1))).toBe(WH)
    expect(reservationWarehouseOf(transferRelease('t', 1))).toBe(WH)
  })

  it('BV: 950 cases reserved by open orders reconciles exactly', () => {
    const movements = [allocate('so-1', 600), allocate('so-2', 350), allocate('so-3', 100), fulfil('so-3', 100)]
    const result = buildReservationBreakdown(movements, scope(), 950)
    expect(result.records.map(r => [r.referenceId, r.reserved])).toEqual([['so-1', 600], ['so-2', 350]])
    expect(result.attributedTotal).toBe(950)
    expect(result.unreconciled).toBe(0)
    expect(result.anomalies).toEqual([])
  })

  it('LB: 200 cases split between an order and a pending transfer', () => {
    const movements = [allocate('so-9', 150), transferReserve('trf-1', 50)]
    const result = buildReservationBreakdown(movements, scope(), 200)
    expect(result.records.map(r => [r.sourceType, r.reserved])).toEqual([['order', 150], ['transfer', 50]])
    expect(result.unreconciled).toBe(0)
  })
})

describe('Lifecycle without double counting', () => {
  it('fulfilment consumes the reservation (approved orders no longer reserve)', () => {
    const result = buildReservationBreakdown([allocate('so', 40), fulfil('so', 40)], scope(), 0)
    expect(result.records).toEqual([])
    expect(result.unreconciled).toBe(0)
  })

  it('partial: two lines of one order, one fulfilled, nets per record once', () => {
    const lineA = allocate('so', 30, CFG)
    const lineB = allocate('so', 20, CFG_LEGACY)
    const result = buildReservationBreakdown(
      [lineA, lineB, fulfil('so', 30, CFG)],
      scope({ configIds: [CFG, CFG_LEGACY] }), 20,
    )
    expect(result.records).toHaveLength(1)
    expect(result.records[0]).toMatchObject({ referenceId: 'so', reserved: 20, configIds: [CFG_LEGACY] })
  })

  it('cancellation release removes it; a second release is an anomaly, not a negative record', () => {
    const cancelled = buildReservationBreakdown([allocate('so', 25), release('so', 25)], scope(), 0)
    expect(cancelled.records).toEqual([])
    const doubled = buildReservationBreakdown([allocate('so', 25), release('so', 25), release('so', 25)], scope(), 0)
    expect(doubled.records).toEqual([])
    expect(doubled.anomalies).toEqual([expect.objectContaining({ referenceId: 'so', net: -25 })])
  })

  it('transfer reserved then released on dispatch / cancel / reject', () => {
    const result = buildReservationBreakdown(
      [transferReserve('trf-a', 10), transferRelease('trf-a', 10), transferReserve('trf-b', 7)],
      scope(), 7,
    )
    expect(result.records.map(r => r.referenceId)).toEqual(['trf-b'])
  })

  it('a configuration change nets to the final configuration within the record', () => {
    const movements = [allocate('so', 12, CFG_LEGACY), ...configChange('so', 12, CFG_LEGACY, CFG)]
    const flavour = buildReservationBreakdown(movements, scope({ configIds: [CFG, CFG_LEGACY] }), 12)
    expect(flavour.records).toEqual([expect.objectContaining({ referenceId: 'so', reserved: 12, configIds: [CFG] })])
    const legacyOnly = buildReservationBreakdown(movements, scope({ configIds: [CFG_LEGACY] }), 0)
    expect(legacyOnly.records).toEqual([])
  })

  it('a duplicated ledger row is never collapsed: it shows as over-attribution', () => {
    const row = allocate('so', 5)
    const result = buildReservationBreakdown([row, { ...row }], scope(), 5)
    expect(result.attributedTotal).toBe(10)
    expect(result.unreconciled).toBe(-5)
  })
})

describe('Scoping', () => {
  it('excludes other warehouses, other configurations and unrelated references', () => {
    const movements = [
      allocate('so-here', 9),
      allocate('so-elsewhere', 99, CFG, OTHER_WH),
      allocate('so-other-cfg', 4, 'cfg-50nb'),
      { ...allocate('cutoff-1', 3), reference_type: 'opening_balance_cutoff' },
      { ...allocate('mv', 2), movement_type: 'transfer_out' },
    ]
    const result = buildReservationBreakdown(movements, scope(), 9)
    expect(result.records.map(r => r.referenceId)).toEqual(['so-here'])
  })

  it('unconfigured legacy rows count only for a whole-flavour scope', () => {
    const movements = [allocate('so-legacy', 8, null)]
    expect(buildReservationBreakdown(movements, scope({ includeUnconfigured: true }), 8).attributedTotal).toBe(8)
    expect(buildReservationBreakdown(movements, scope({ includeUnconfigured: false }), 0).attributedTotal).toBe(0)
  })
})

describe('Opening cut-off boundary', () => {
  it('ignores pre-cut-off ledger rows for a configuration the cut-off reset', () => {
    const before = allocate('so', 30, CFG, WH, '2026-09-01T00:00:00.000Z')
    const carried = { ...allocate('so', 30, CFG, WH, '2026-09-15T08:00:00.000Z'), reference_type: 'order_config_change' }
    const boundaries = buildCutoffBoundaries(
      [{ stock_count_session_id: 's1', posted_at: '2026-09-15T08:00:00.000Z', status: 'posted' }],
      [{ session_id: 's1', stock_config_id: CFG, physical_quantity: 500 }],
    )
    const naive = buildReservationBreakdown([before, carried], scope(), 30)
    expect(naive.attributedTotal).toBe(60)           // the double count the boundary prevents
    const bounded = buildReservationBreakdown([before, carried], scope({ cutoffBoundaries: boundaries }), 30)
    expect(bounded.attributedTotal).toBe(30)
    expect(bounded.unreconciled).toBe(0)
  })

  it('only posted cut-offs and counted items create a boundary', () => {
    const boundaries = buildCutoffBoundaries(
      [
        { stock_count_session_id: 's1', posted_at: '2026-09-15T00:00:00Z', status: 'posted' },
        { stock_count_session_id: 's2', posted_at: null, status: 'counting' },
      ],
      [
        { session_id: 's1', stock_config_id: CFG, physical_quantity: 1 },
        { session_id: 's1', stock_config_id: 'cfg-uncounted', physical_quantity: null },
        { session_id: 's2', stock_config_id: CFG_LEGACY, physical_quantity: 5 },
      ],
    )
    expect(Array.from(boundaries.entries())).toEqual([[CFG, '2026-09-15T00:00:00Z']])
  })
})

describe('Reconciliation', () => {
  it('reports a legacy / unattributed remainder explicitly', () => {
    const result = buildReservationBreakdown([allocate('so', 100)], scope(), 130)
    expect(result.attributedTotal).toBe(100)
    expect(result.unreconciled).toBe(30)
  })

  it('totals cover every record, not a page', () => {
    const movements = Array.from({ length: 120 }, (_, i) => allocate(`so-${String(i).padStart(3, '0')}`, 1))
    const result = buildReservationBreakdown(movements, scope(), 120)
    expect(result.records).toHaveLength(120)
    expect(result.attributedTotal).toBe(120)
  })

  it('status expectations are a flag only', () => {
    expect(isExpectedReservingStatus('order', 'submitted')).toBe(true)
    expect(isExpectedReservingStatus('order', 'approved')).toBe(false)
    expect(isExpectedReservingStatus('transfer', 'ready_to_dispatch')).toBe(true)
    expect(isExpectedReservingStatus('transfer', 'in_transit')).toBe(false)
  })
})
