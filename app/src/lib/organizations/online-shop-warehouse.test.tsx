import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (relative: string) => readFileSync(path.resolve(__dirname, relative), 'utf8')
const migration = read('../../../../supabase/migrations/20260929200000_storefront_online_shop_warehouse.sql')
const api = read('../../app/api/organizations/set-default-warehouse/route.ts')
const card = read('../../components/organizations/OnlineShopWarehouseCard.tsx')
const editView = read('../../components/organizations/EditOrganizationView.tsx')

describe('Online shop warehouse', () => {
  it('lets website orders use their own warehouse and otherwise follow the distributor default', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS storefront_warehouse_org_id')
    expect(migration).toContain('COALESCE(storefront_warehouse_org_id, default_warehouse_org_id)')
    expect(migration).not.toMatch(/UPDATE\s+public\.organizations\s+SET\s+default_warehouse_org_id/i)
  })

  it('keeps the chosen warehouse valid and fails closed when it is not', () => {
    expect(migration).toContain('is_active_hq_fulfillment_warehouse(NEW.id, NEW.storefront_warehouse_org_id)')
    expect(migration).toContain('Cannot deactivate the online shop warehouse')
    expect(migration).toContain('the online shop warehouse is no longer an active warehouse under the HQ')
  })

  it('saves through the same HQ-admin endpoint without touching the distributor default', () => {
    expect(api).toContain("body.purpose === 'online_shop'")
    expect(api).toContain('storefront_warehouse_org_id: warehouse_org_id')
    expect(api).toContain('Only HQ Admin can update the default fulfillment warehouse.')
    expect(card).toContain("purpose: 'online_shop' | 'outdoor_shop' = 'online_shop'")
    expect(card).toContain("rpc('is_hq_admin')")
  })

  it('sits on the warehouse page after the distributor card', () => {
    expect(editView.indexOf('<DistributorOrderFulfillmentCard')).toBeLessThan(editView.indexOf('<OnlineShopWarehouseCard'))
  })
})
