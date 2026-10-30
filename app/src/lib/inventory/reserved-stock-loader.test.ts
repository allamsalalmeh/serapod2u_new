import { describe, expect, it } from 'vitest'
import { loadReservationBreakdown } from './reserved-stock-loader'

/**
 * Minimal read-only PostgREST double. Tables hold only rows the CALLER may
 * see (that is what RLS does); any write or RPC fails the test.
 */
function fakeSupabase(tables: Record<string, any[]>, calls: string[] = []) {
  const forbid = (name: string) => () => { throw new Error(`write attempted: ${name}`) }
  return {
    calls,
    rpc: forbid('rpc'),
    from(table: string) {
      calls.push(table)
      let rows = [...(tables[table] || [])]
      let range: [number, number] | null = null
      const builder: any = {
        select: () => builder,
        insert: forbid('insert'), update: forbid('update'), upsert: forbid('upsert'), delete: forbid('delete'),
        eq: (col: string, value: any) => { rows = rows.filter(r => r[col] === value); return builder },
        in: (col: string, values: any[]) => { rows = rows.filter(r => values.includes(r[col])); return builder },
        not: (col: string, op: string, value: any) => {
          if (op === 'is' && value === null) rows = rows.filter(r => r[col] !== null && r[col] !== undefined)
          return builder
        },
        or: (expr: string) => {
          const clauses = expr.split(',').map(c => { const [col, , val] = c.split('.'); return [col, val] as const })
          rows = rows.filter(r => clauses.some(([col, val]) => r[col] === val))
          return builder
        },
        order: () => builder,
        range: (a: number, b: number) => { range = [a, b]; return builder },
        then: (resolve: any) => resolve({ data: range ? rows.slice(range[0], range[1] + 1) : rows, error: null }),
      }
      return builder
    },
  }
}

const WH = 'wh-hq'
const mv = (over: Record<string, any>) => ({
  movement_type: 'allocation', reference_type: 'order', reference_no: null, stock_config_id: 'cfg',
  from_organization_id: WH, to_organization_id: 'dist', quantity_change: 1,
  created_at: '2026-10-01T00:00:00Z', variant_id: 'var', ...over,
})

describe('loadReservationBreakdown', () => {
  it('joins readable records, hides restricted ones, and reconciles', async () => {
    const supabase = fakeSupabase({
      stock_movements: [
        mv({ reference_id: 'o-visible', quantity_change: 600 }),
        mv({ reference_id: 'o-hidden', quantity_change: 350, reference_no: 'SO-SECRET' }),
        mv({ reference_id: 't-1', reference_type: 'transfer', quantity_change: 0 + 50 }),
        mv({ reference_id: 'o-other-wh', from_organization_id: 'wh-x', quantity_change: 999 }),
      ],
      orders: [{ id: 'o-visible', order_no: 'SO26000152', display_doc_no: null, status: 'submitted', order_type: 'D2H', buyer_org_id: 'dist' }],
      stock_transfers: [{ id: 't-1', transfer_no: 'TRF-001', status: 'pending_approval', to_organization_id: 'wh-north' }],
      organizations: [{ id: 'dist', org_name: 'Distributor A' }, { id: 'wh-north', org_name: 'North WH' }],
      inventory_opening_cutoffs: [],
    })
    const result = await loadReservationBreakdown(supabase, {
      variantId: 'var', warehouseOrgId: WH, configIds: ['cfg'], includeUnconfigured: true, storedReserved: 1000,
    })
    expect(result.attributedTotal).toBe(1000)
    expect(result.unreconciled).toBe(0)
    expect(result.restrictedCount).toBe(1)
    expect(result.sources.sort()).toEqual(['order', 'transfer'])

    const visible = result.rows.find(r => r.referenceId === 'o-visible')!
    expect(visible).toMatchObject({ accessible: true, referenceNo: 'SO26000152', counterpartyName: 'Distributor A', status: 'submitted' })
    expect(visible.href).toBe('/supply-chain?view=view-order&orderId=o-visible')

    const hidden = result.rows.find(r => r.referenceId === 'o-hidden')!
    expect(hidden).toMatchObject({ accessible: false, referenceNo: null, counterpartyName: null, status: null, href: null, reserved: 350 })
    expect(JSON.stringify(result.rows)).not.toContain('SO-SECRET')

    const transfer = result.rows.find(r => r.sourceType === 'transfer')!
    expect(transfer).toMatchObject({ referenceNo: 'TRF-001', counterpartyName: 'North WH' })
  })

  it('pages through every movement (totals are never page-limited)', async () => {
    const movements = Array.from({ length: 2500 }, (_, i) => mv({ reference_id: `o-${i}`, quantity_change: 1 }))
    const supabase = fakeSupabase({ stock_movements: movements, orders: [], inventory_opening_cutoffs: [] })
    const result = await loadReservationBreakdown(supabase, {
      variantId: 'var', warehouseOrgId: WH, configIds: ['cfg'], includeUnconfigured: false, storedReserved: 2500,
    })
    expect(result.attributedTotal).toBe(2500)
    expect(result.restrictedCount).toBe(2500)
  })

  it('applies a readable cut-off boundary and flags an unreadable one', async () => {
    const tables = {
      stock_movements: [
        mv({ reference_id: 'o', quantity_change: 30, created_at: '2026-09-01T00:00:00Z' }),
        mv({ reference_id: 'o', reference_type: 'order_config_change', quantity_change: 30, created_at: '2026-09-15T08:00:00Z' }),
      ],
      orders: [{ id: 'o', order_no: 'SO1', status: 'submitted', buyer_org_id: 'dist' }],
      inventory_opening_cutoffs: [{ warehouse_organization_id: WH, stock_count_session_id: 's1', posted_at: '2026-09-15T08:00:00Z', status: 'posted' }],
      stock_count_session_items: [{ session_id: 's1', variant_id: 'var', stock_config_id: 'cfg', physical_quantity: 400 }],
    }
    const params = { variantId: 'var', warehouseOrgId: WH, configIds: ['cfg'], includeUnconfigured: false, storedReserved: 30 }
    const readable = await loadReservationBreakdown(fakeSupabase(tables), params)
    expect(readable.attributedTotal).toBe(30)
    expect(readable.cutoffBoundaryUncertain).toBe(false)

    const unreadable = await loadReservationBreakdown(fakeSupabase({ ...tables, stock_count_session_items: [] }), params)
    expect(unreadable.cutoffBoundaryUncertain).toBe(true)
    expect(unreadable.unreconciled).toBe(-30)   // shown, not hidden
  })

  it('performs no writes and no RPCs', async () => {
    const calls: string[] = []
    const supabase = fakeSupabase({ stock_movements: [mv({ reference_id: 'o', quantity_change: 5 })], orders: [], inventory_opening_cutoffs: [] }, calls)
    await loadReservationBreakdown(supabase, { variantId: 'var', warehouseOrgId: WH, configIds: ['cfg'], includeUnconfigured: false, storedReserved: 5 })
    expect(calls).not.toContain('product_inventory')
  })
})
