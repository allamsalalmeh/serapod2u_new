import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ORDER_VIEW_PERMISSION, legacyOrderView, orderViewOrganizations } from './order-view'
import { SUPPORTING_READS, missingSupportingReads, supportingReadsIn } from './policy-dependencies'
import { SUPPLY_CHAIN_ACCESS_PERMISSIONS, SUPPLY_CHAIN_VIEW_DESTINATIONS, supplyChainDestinationForView } from './nav-access'
import { canAccessSupplyChainView } from '@/modules/supply-chain/supplyChainNav'

const migration = readFileSync(
  resolve(process.cwd(), '../supabase/migrations/20261101100000_sa_order_view_policy_dependencies.sql'), 'utf8')

describe('View Orders — lock-step with 20261101100000', () => {
  it('registers the same permission and the level-40 compatibility rule', () => {
    expect(migration).toContain(`c_view constant text := '${ORDER_VIEW_PERMISSION}'`)
    expect(migration).toMatch(/\(c_view, 40, '\{\}', '\{\}', false,/)
    expect([40, 39, 1].map(legacyOrderView)).toEqual([true, true, true])
    expect([50, null, undefined, Number.NaN].map(legacyOrderView)).toEqual([false, false, false, false])
  })

  it('declares exactly the order supporting reads the app knows (the rest: 20261110100000, policy-hardening.test.ts)', () => {
    const seeded = [...migration.matchAll(/\('(supply_chain\.order\.[a-z]+)',\s+c_view, '/g)].map(m => m[1]).sort()
    const orderOps = Object.keys(SUPPORTING_READS).filter(k => k.startsWith('supply_chain.order.')).sort()
    expect(seeded).toEqual(orderOps)
    expect(orderOps.every(k => SUPPORTING_READS[k].length === 1 && SUPPORTING_READS[k][0] === ORDER_VIEW_PERMISSION)).toBe(true)
  })

  it('extends only the order policies and Supply Chain Full Access', () => {
    expect(migration).toContain(`b.role_key in ('order-approver', 'order-creator')`)
    expect(migration).toContain(`sa_extend_standard_policy('supply-chain-full-access', array[c_view]`)
    expect(migration).toContain(`is distinct from array['supply_chain.order.approve', c_view]`)
  })
})

describe('policy dependencies', () => {
  it('explains the supporting read of a standard policy and reports a missing one', () => {
    expect(supportingReadsIn(['supply_chain.order.approve', ORDER_VIEW_PERMISSION]))
      .toEqual(new Map([[ORDER_VIEW_PERMISSION, ['supply_chain.order.approve']]]))
    expect(missingSupportingReads(['supply_chain.order.approve']))
      .toEqual(new Map([['supply_chain.order.approve', [ORDER_VIEW_PERMISSION]]]))
    expect(missingSupportingReads(['supply_chain.order.approve', ORDER_VIEW_PERMISSION]).size).toBe(0)
    // A lone view permission supports nothing (it is a plain grant, not a dependency).
    expect(supportingReadsIn([ORDER_VIEW_PERMISSION]).size).toBe(0)
  })
})

describe('order party organizations', () => {
  it('asks the approval organization first, then the remaining parties, without duplicates', () => {
    expect(orderViewOrganizations({ order_type: 'H2M', buyer_org_id: 'hq', seller_org_id: 'mfg', warehouse_org_id: 'wh' })).toEqual(['hq', 'mfg', 'wh'])
    expect(orderViewOrganizations({ order_type: 'D2H', buyer_org_id: 'dist', seller_org_id: 'hq', warehouse_org_id: 'hq' })).toEqual(['hq', 'dist'])
    expect(orderViewOrganizations({ order_type: 'S2D', buyer_org_id: 'shop', seller_org_id: 'dist', warehouse_org_id: null })).toEqual(['dist', 'shop'])
  })
})

describe('Order Details navigation', () => {
  it('decides view-order and track-order with View Orders only', () => {
    expect(supplyChainDestinationForView('view-order')).toBe('supply-chain/view-order')
    expect(supplyChainDestinationForView('track-order')).toBe('supply-chain/view-order')
    expect(SUPPLY_CHAIN_VIEW_DESTINATIONS['supply-chain/view-order']).toEqual({ org: [ORDER_VIEW_PERMISSION] })
    expect(SUPPLY_CHAIN_VIEW_DESTINATIONS['supply-chain/orders'].org).toContain(ORDER_VIEW_PERMISSION)
    expect(SUPPLY_CHAIN_ACCESS_PERMISSIONS).toContain(ORDER_VIEW_PERMISSION)
  })

  it('lets the S&A answer replace the level-40 rule (orderapp: HQ level 50 with View Orders)', () => {
    const granted = (id: string) => ['supply-chain/view-order', 'supply-chain/orders'].includes(supplyChainDestinationForView(id))
    expect(canAccessSupplyChainView('view-order', 'HQ', 50, undefined, granted)).toBe(true)
    expect(canAccessSupplyChainView('track-order', 'HQ', 50, undefined, granted)).toBe(true)
    // Denied by S&A: no level bypass.
    expect(canAccessSupplyChainView('view-order', 'HQ', 10, undefined, () => false)).toBe(false)
    // No S&A answer supplied: the historical rule alone.
    expect(canAccessSupplyChainView('view-order', 'HQ', 50)).toBe(false)
    expect(canAccessSupplyChainView('view-order', 'HQ', 40)).toBe(true)
    // View Orders never opens the order editor.
    expect(canAccessSupplyChainView('create-order', 'HQ', 50, false, granted)).toBe(false)
  })
})
