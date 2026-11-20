/**
 * Regression: View Inventory labelled Cellera Hero case balances as "pcs".
 *
 * Root cause (proven): normalizeInventoryApiRow() — formerly inline in
 * InventoryView — rebuilt every API row without pcs_on_hand / pcs_per_case.
 * The aggregation then saw no ratio, defaulted it to 1, and the shared
 * formatter read ratio 1 as "piece-stocked". Incoming was unaffected because
 * it used the product-line rule directly.
 *
 * These tests drive the REAL path: a vw_inventory_on_hand-shaped API row →
 * normalizeInventoryApiRow → aggregateVariantInventory → shared formatter.
 */
import { describe, expect, it } from 'vitest'
import { aggregateVariantInventory, type InventoryConfigRow } from './inventory-view-aggregation'
import { emptyInventoryRowLookups, normalizeInventoryApiRow } from './inventory-view-rows'
import {
  formatStockChange,
  formatStockQuantity,
  resolveStockUnit,
  stockUnitCostLabel,
} from './stock-count-quantity'

/** One row exactly as vw_inventory_on_hand returns it (all 36 columns). */
const viewRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'pi-bv-20nb',
  variant_id: 'var-bv',
  organization_id: 'wh-hq',
  quantity_on_hand: 3861,
  quantity_allocated: 950,
  quantity_available: 2911,
  reorder_point: 100,
  reorder_quantity: 0,
  max_stock_level: null,
  safety_stock: null,
  lead_time_days: null,
  average_cost: 14,
  total_value: 54054,
  warehouse_location: null,
  variant_code: 'HERO-BV',
  variant_name: 'Cellera Hero [ BV ]',
  variant_image_url: null,
  product_id: 'prod-hero',
  product_name: 'Cellera Hero',
  product_code: 'CELHERO',
  organization_name: 'Serapod HQ Warehouse',
  organization_code: 'WH01',
  updated_at: '2026-10-26T00:00:00.000Z',
  stock_config_id: 'cfg-bv-20nb',
  config_code: '20NB',
  config_label: '20ml · New Box',
  stock_sku: 'HERO-BV-20NB',
  volume_ml: 20,
  packaging: 'new_box',
  stock_config_status: 'active',
  is_variant_default: true,
  requires_repacking_before_sale: false,
  default_for_ord: true,
  pcs_on_hand: 0,
  pcs_per_case: 4,
  pcs_value: 0,
  ...overrides,
})

const lookups = () => {
  const value = emptyInventoryRowLookups()
  value.variantBaseCostMap.set('var-bv', 14)
  return value
}

const summarise = (rows: Array<Record<string, unknown>>, incoming = 11_200) => {
  const normalized = rows.map((row, index) => normalizeInventoryApiRow(row, index, lookups()))
  return aggregateVariantInventory(normalized as InventoryConfigRow[], () => incoming)
}

const label = (cases: number, pcs: number, summary: { pcsPerCase: number; stockUnit: any }) =>
  formatStockQuantity({ cases, pcs, pcsPerCase: summary.pcsPerCase, unit: summary.stockUnit })

describe('View Inventory Cases/Pcs — BV baseline from the real API shape', () => {
  it('keeps the canonical pair on the projected row (the dropped fields)', () => {
    const row = normalizeInventoryApiRow(viewRow(), 0, lookups())
    expect(row.pcs_on_hand).toBe(0)
    expect(row.pcs_per_case).toBe(4)
    expect(row.quantity_on_hand).toBe(3861)
  })

  it('renders every BV column in cases with unchanged values', () => {
    const [bv] = summarise([viewRow()])

    expect(bv).toMatchObject({
      stockUnit: 'cases',
      pcsPerCase: 4,
      unitConflict: null,
      onHand: 3861,
      allocated: 950,
      available: 2911,
      incoming: 11_200,
      position: 14_111,
      unitCost: 14,
      value: 54_054,
    })

    expect(label(bv.onHand, bv.pcsOnHand, bv)).toMatchObject({ primary: '3,861 cases', secondary: null })
    expect(label(bv.allocated, 0, bv).text).toBe('950 cases')
    expect(label(bv.available, 0, bv).text).toBe('2,911 cases')
    expect(label(bv.incoming, 0, bv).text).toBe('11,200 cases')
    expect(label(bv.position, 0, bv).text).toBe('14,111 cases')
    expect(`RM14.00 per ${stockUnitCostLabel(bv.stockUnit)}`).toBe('RM14.00 per case')

    // Nothing anywhere is divided or multiplied by the packing ratio.
    for (const text of [bv.onHand, bv.allocated, bv.available, bv.position].map(n => label(n, 0, bv).text)) {
      expect(text).not.toMatch(/pcs/)
      expect(text).not.toMatch(/15,444|965/)
    }
  })

  it('still reads cases when the ratio is missing (pre-migration view shape)', () => {
    const row = viewRow()
    delete (row as any).pcs_on_hand
    delete (row as any).pcs_per_case
    delete (row as any).pcs_value
    const [bv] = summarise([row])
    expect(bv.stockUnit).toBe('cases')
    expect(bv.pcsPerCase).toBe(4)
    expect(label(bv.onHand, bv.pcsOnHand, bv).text).toBe('3,861 cases')
    expect(bv.value).toBe(54_054)
  })

  it('still reads cases when a balance carries the column default of 1', () => {
    // fulfill_order_inventory / adjust_inventory_quantity / the movements
    // trigger create rows without setting pcs_per_case (default 1).
    const [bv] = summarise([viewRow({ pcs_per_case: 1 })])
    expect(bv.stockUnit).toBe('cases')
    expect(bv.pcsPerCase).toBe(4)
    expect(label(bv.onHand, 0, bv).text).toBe('3,861 cases')
    expect(resolveStockUnit({ productName: 'Cellera Hero', balancePcsPerCase: 1 }).staleBalanceRatio).toBe(true)
  })
})

describe('View Inventory Cases/Pcs — additional pieces', () => {
  it('shows 3,861 cases with + 2 pcs beneath and values the pieces', () => {
    const [bv] = summarise([viewRow({ pcs_on_hand: 2, pcs_value: 7 })])
    expect(label(bv.onHand, bv.pcsOnHand, bv)).toMatchObject({
      primary: '3,861 cases',
      secondary: '+ 2 pcs',
    })
    // RM14 per case → RM3.50 per piece; 2 pcs = RM7.00 (doc §3 worked example).
    expect(bv.value).toBe(54_061)
    // Whole-unit semantics are untouched: availability and position stay in cases.
    expect(bv.available).toBe(2911)
    expect(bv.position).toBe(14_111)
  })

  it('hides the extra-pcs line when it is zero', () => {
    const [bv] = summarise([viewRow({ pcs_on_hand: 0 })])
    const labels = label(bv.onHand, bv.pcsOnHand, bv)
    expect(labels.secondary).toBeNull()
    expect(labels.text).not.toContain('+ 0 pcs')
  })

  it('shows only pieces for a case product holding less than one case', () => {
    const [row] = summarise([viewRow({ quantity_on_hand: 0, quantity_allocated: 0, quantity_available: 0, pcs_on_hand: 2 })], 0)
    expect(label(row.onHand, row.pcsOnHand, row).text).toBe('2 pcs')
  })
})

describe('View Inventory Cases/Pcs — piece-stocked and uncertain metadata', () => {
  const sboxRow = (overrides: Record<string, unknown> = {}) => viewRow({
    id: 'pi-sbox', variant_id: 'var-sbox', variant_code: 'SBOX-BLK', variant_name: 'S.Box [ Black ]',
    product_name: 'S.Box Device', product_code: 'SBOX', stock_config_id: 'cfg-sbox-std', config_code: 'STD',
    config_label: 'Standard', stock_sku: 'SBOX-BLK', volume_ml: null, packaging: null,
    quantity_on_hand: 29, quantity_allocated: 4, quantity_available: 25, pcs_per_case: 1, average_cost: 80,
    ...overrides,
  })

  it('keeps a genuine pcs-only product in pcs', () => {
    const [sbox] = summarise([sboxRow()], 10)
    expect(sbox.stockUnit).toBe('pcs')
    expect(sbox.unitConflict).toBeNull()
    expect(label(sbox.onHand, sbox.pcsOnHand, sbox).text).toBe('29 pcs')
    expect(label(sbox.incoming, 0, sbox).text).toBe('10 pcs')
    expect(stockUnitCostLabel(sbox.stockUnit)).toBe('pc')
  })

  it('never turns a pcs-only product into cases, and flags a contradicting ratio', () => {
    const [sbox] = summarise([sboxRow({ pcs_per_case: 10 })], 0)
    expect(sbox.stockUnit).toBe('pcs')
    expect(label(sbox.onHand, 0, sbox).text).toBe('29 pcs')
    expect(sbox.unitConflict).toMatch(/stocked in pieces/)
  })

  it('does not claim a unit when product identity is missing', () => {
    const [row] = summarise([viewRow({ product_name: null, pcs_per_case: null })], 0)
    expect(row.stockUnit).toBe('unknown')
    expect(row.unitConflict).toMatch(/Product identity is missing/)
    const text = label(row.onHand, 0, row).text
    expect(text).toBe('3,861')
    expect(text).not.toMatch(/pcs|cases/)
    expect(stockUnitCostLabel(row.stockUnit)).toBe('unit')
  })

  it('aggregates multiple configurations without mislabelling or folding pieces', () => {
    const legacy = viewRow({
      id: 'pi-bv-legacy', stock_config_id: 'cfg-bv-legacy', config_code: 'UNCLASSIFIED', config_label: 'Legacy',
      volume_ml: null, packaging: null, default_for_ord: false,
      quantity_on_hand: 10, quantity_allocated: 0, quantity_available: 10, pcs_on_hand: 0, pcs_per_case: 1,
    })
    const [bv] = summarise([viewRow({ pcs_on_hand: 3 }), legacy])
    expect(bv.stockUnit).toBe('cases')
    expect(bv.pcsPerCase).toBe(4)
    expect(bv.unitConflict).toBeNull()
    expect(bv.onHand).toBe(3871)
    expect(bv.pcsOnHand).toBe(3)
    expect(bv.configs.every(config => config.stockUnit === 'cases')).toBe(true)
    expect(bv.configs.find(config => config.configCode === 'UNCLASSIFIED')?.pcsPerCase).toBe(4)
  })

  it('flags configurations that disagree on pieces per case', () => {
    const other = viewRow({
      id: 'pi-bv-50nb', stock_config_id: 'cfg-bv-50nb', config_code: '50NB', volume_ml: 50,
      default_for_ord: false, quantity_on_hand: 5, quantity_allocated: 0, quantity_available: 5, pcs_on_hand: 2, pcs_per_case: 6,
    })
    const [bv] = summarise([viewRow({ pcs_on_hand: 3 }), other])
    expect(bv.stockUnit).toBe('cases')
    expect(bv.unitConflict).toMatch(/different pieces per case/)
    // 3 + 2 pieces of DIFFERENT packs are not folded into a fake case.
    expect(bv.onHand).toBe(3866)
    expect(bv.pcsOnHand).toBe(5)
    // Each configuration is valued at its own ratio: 3 × 14/4 + 2 × 14/6.
    expect(bv.value).toBe(Number((3866 * 14 + 3 * 3.5 + (2 * 14) / 6).toFixed(2)))
  })
})

describe('Shared formatter honours an explicit unit', () => {
  it('a case unit with an unknown ratio is still cases', () => {
    expect(formatStockQuantity({ cases: 3861, pcs: 0, pcsPerCase: 1, unit: 'cases' }).text).toBe('3,861 cases')
    expect(formatStockQuantity({ cases: 3861, pcs: 2, pcsPerCase: 1, unit: 'cases' })).toMatchObject({
      primary: '3,861 cases', secondary: '+ 2 pcs',
    })
  })

  it('keeps legacy behaviour when no unit is given', () => {
    expect(formatStockQuantity({ cases: 29, pcs: 0, pcsPerCase: 1 }).text).toBe('29 pcs')
    expect(formatStockQuantity({ cases: 3861, pcs: 2, pcsPerCase: 4 }).text).toBe('3,861 cases + 2 pcs')
  })

  it('changes keep their unit too', () => {
    expect(formatStockChange({ cases: -2, pcs: 0, pcsPerCase: 1, unit: 'cases' }).text).toBe('-2 cases')
    expect(formatStockChange({ cases: 1, pcs: -2, pcsPerCase: 4, unit: 'cases' }).text).toBe('+2 pcs')
    expect(formatStockChange({ cases: 0, pcs: -2, pcsPerCase: 4, unit: 'cases' }).text).toBe('-2 pcs')
    expect(formatStockChange({ cases: 5, pcs: 0, pcsPerCase: 1, unit: 'pcs' }).text).toBe('+5 pcs')
    expect(formatStockChange({ cases: 1, pcs: -4, pcsPerCase: 4, unit: 'cases' }).text).toBe('No change')
  })
})

describe('Stock Count catalog uses the same unit rule', () => {
  // Imported lazily so this file's View Inventory tests do not depend on it.
  const configFor = (productName: string) => ({
    id: 'cfg-1', variant_id: 'var-1', config_code: '20NB', config_label: '20ml · New Box',
    stock_sku: 'SKU-1', volume_ml: 20, packaging: 'new_box', status: 'active',
    product_variants: {
      id: 'var-1', variant_name: `${productName} [ BV ]`, alternative_name: null, variant_code: 'V1',
      product_code: 'BV', manufacturer_sku: null, manual_sku: null, image_url: null, base_cost: 14,
      products: { id: 'p-1', product_name: productName, product_groups: { id: 'g', group_name: 'Cartridge', group_description: null }, brands: null },
    },
  })

  it('a stale pcs_per_case of 1 on a Hero balance resolves to 4, in cases', async () => {
    const { buildStockCountCatalogRows } = await import('./stock-count-catalog')
    const [row] = buildStockCountCatalogRows([configFor('Cellera Hero')], [{
      id: 'pi-1', stock_config_id: 'cfg-1', quantity_on_hand: 3861, pcs_on_hand: 0, pcs_per_case: 1, quantity_allocated: 950,
    }])
    expect(row.countUnit).toBe('cases')
    expect(row.pcsPerCase).toBe(4)
    expect(row.systemQuantity).toBe(3861)
    expect(formatStockQuantity({ cases: row.systemQuantity, pcs: row.systemPcs ?? 0, pcsPerCase: row.pcsPerCase!, unit: row.countUnit }).text)
      .toBe('3,861 cases')
  })

  it('a real ratio on the balance is kept; a device stays in pieces', async () => {
    const { buildStockCountCatalogRows } = await import('./stock-count-catalog')
    const [hero] = buildStockCountCatalogRows([configFor('Cellera Hero')], [{
      id: 'pi-1', stock_config_id: 'cfg-1', quantity_on_hand: 3861, pcs_on_hand: 2, pcs_per_case: 4,
    }])
    expect(hero.pcsPerCase).toBe(4)
    expect(hero.systemPcs).toBe(2)
    const [device] = buildStockCountCatalogRows([configFor('S.Box Device')], [{
      id: 'pi-2', stock_config_id: 'cfg-1', quantity_on_hand: 29, pcs_on_hand: 0, pcs_per_case: 1,
    }])
    expect(device.countUnit).toBe('pcs')
    expect(device.pcsPerCase).toBe(1)
  })
})
