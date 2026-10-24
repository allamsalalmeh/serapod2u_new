import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (relative: string) => readFileSync(path.resolve(__dirname, relative), 'utf8').replace(/\r\n/g, '\n')
const migration = read('../../../../supabase/migrations/20261214100000_outdoor_shop_warehouse_and_online_stock.sql')
const api = read('../../app/api/organizations/set-default-warehouse/route.ts')
const card = read('../../components/organizations/OnlineShopWarehouseCard.tsx')
const fn = (name: string) => {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  return migration.slice(start, migration.indexOf('$$;', start))
}

describe('Outdoor shop warehouse', () => {
  it('is an HQ setting that falls back to the website warehouse', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS outdoor_warehouse_org_id uuid')
    const channel = fn('storefront_channel_warehouse')
    expect(channel).toContain("IF lower(COALESCE(p_channel, '')) <> 'outdoor' THEN\n    RETURN v_wh;")
    expect(channel).toContain('IF v_outdoor IS NULL THEN\n    RETURN v_wh;')
    expect(channel).toContain('the Outdoor shop warehouse is no longer an active warehouse under the HQ')
  })

  it('keeps the website warehouse guard and adds the same guard for Outdoor', () => {
    const guard = fn('organizations_protect_storefront_warehouse')
    expect(guard).toContain('Cannot deactivate the online shop warehouse')
    expect(guard).toContain('is_active_hq_fulfillment_warehouse(NEW.id, NEW.storefront_warehouse_org_id)')
    expect(guard).toContain('Cannot deactivate the Outdoor shop warehouse')
    expect(guard).toContain('is_active_hq_fulfillment_warehouse(NEW.id, NEW.outdoor_warehouse_org_id)')
    expect(migration).toContain('BEFORE INSERT OR UPDATE OF is_active, storefront_warehouse_org_id, outdoor_warehouse_org_id, org_type_code')
  })

  it('ships each order from its own channel warehouse and returns stock where it left', () => {
    expect(fn('storefront_order_stock_out')).toContain('v_wh := public.storefront_channel_warehouse(v_order.organization_id, v_order.sales_channel);')
    expect(fn('storefront_order_stock_return')).toContain('p_organization_id => v_order.stock_warehouse_id')
    expect(fn('storefront_order_stock_undo')).toContain('p_organization_id => v_order.stock_warehouse_id')
  })

  it('does not let a broken Outdoor setting stop the Serapod2U store', () => {
    const stock = fn('storefront_variant_stock')
    expect(stock).toContain('EXCEPTION WHEN OTHERS THEN\n      v_outdoor_wh := NULL;')
    expect(stock).toContain('v_split := v_outdoor_wh IS NOT NULL AND v_outdoor_wh IS DISTINCT FROM v_store_wh;')
  })

  it('is saved by HQ admin only through the existing endpoint', () => {
    expect(api).toContain("body.purpose === 'outdoor_shop'")
    expect(api).toContain('outdoor_warehouse_org_id: warehouse_org_id')
    expect(api).toContain('outdoor_warehouse_org_id: null')
    expect(api).toContain('Only HQ Admin can change the Outdoor shop warehouse.')
    expect(card).toContain("save(warehouse.id, 'outdoor_shop')")
    expect(card).toContain("save(null, 'outdoor_shop')")
  })
})

describe('Online stock allocation', () => {
  it('is optional and never negative', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS online_stock_allocation integer')
    expect(migration).toContain('CHECK (online_stock_allocation IS NULL OR online_stock_allocation >= 0)')
  })

  it('caps what the website sells without touching warehouse stock', () => {
    const stock = fn('storefront_variant_stock')
    expect(stock).toContain('COALESCE(s.allocation - COALESCE(h.every_channel, 0), s.free - COALESCE(h.same_warehouse, 0))')
    expect(stock).not.toMatch(/UPDATE\s+public\.(product_inventory|product_variants)/i)
  })

  it('is used up on shipping and given back on return or undo', () => {
    expect(fn('storefront_order_stock_out')).toContain('SET online_stock_allocation = GREATEST(0, online_stock_allocation - v_line.qty)')
    expect(fn('storefront_order_stock_return')).toContain('SET online_stock_allocation = online_stock_allocation + v_line.qty')
    expect(fn('storefront_order_stock_undo')).toContain('SET online_stock_allocation = online_stock_allocation + v_line.qty')
    for (const name of ['storefront_order_stock_out', 'storefront_order_stock_return', 'storefront_order_stock_undo']) {
      expect(fn(name)).toContain('AND online_stock_allocation IS NOT NULL')
    }
  })

  it('keeps the stock functions server-only', () => {
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.storefront_variant_stock(uuid[], uuid, text) FROM PUBLIC, anon, authenticated;')
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.storefront_variant_stock(uuid[], uuid, text) TO service_role;')
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.storefront_variant_stock(uuid[], uuid);')
  })
})
