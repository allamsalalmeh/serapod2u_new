import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildAddStockMovementParams,
  buildManualStockRpcItems,
  buildPostManualStockAdditionParams,
  catalogRowKey,
  effectiveConfigurationFilterKey,
  fetchExistingStockForWarehouse,
  filterManualStockCatalogRows,
  isSelectableManualStockConfiguration,
  newBalance,
  paginateRows,
  parseAddQuantity,
  summarizeManualStockSelection,
  weightedAverageCost,
  type ManualStockCatalogRow,
} from './add-stock-inventory'
import { shouldShowConfigurationColumn } from './canonical-stock-config'

type InventoryRow = {
  organization_id: string
  variant_id: string
  is_active: boolean
  quantity_on_hand: number
  quantity_allocated: number
  quantity_available: number
  warehouse_location: string | null
  average_cost: number | null
  organization: { org_name: string }
  stock_config_id?: string
}

function inventoryRow(
  organizationId: string,
  variantId: string,
  quantity: number,
  warehouseName: string
): InventoryRow {
  return {
    organization_id: organizationId,
    variant_id: variantId,
    is_active: true,
    quantity_on_hand: quantity,
    quantity_allocated: 0,
    quantity_available: quantity,
    warehouse_location: null,
    average_cost: 14,
    organization: { org_name: warehouseName },
  }
}

function fakeSupabase(rows: InventoryRow[]) {
  const queries: Array<{ table: string; filters: Record<string, unknown>; methods: string[] }> = []

  return {
    queries,
    client: {
      from(table: string) {
        const query = { table, filters: {} as Record<string, unknown>, methods: [] as string[] }
        queries.push(query)
        const builder = {
          select() {
            query.methods.push('select')
            return builder
          },
          eq(column: string, value: unknown) {
            query.methods.push(`eq:${column}`)
            query.filters[column] = value
            return builder
          },
          async maybeSingle() {
            query.methods.push('maybeSingle')
            const matches = rows.filter(row =>
              Object.entries(query.filters).every(([column, value]) =>
                row[column as keyof InventoryRow] === value
              )
            )
            if (matches.length > 1) return { data: null, error: new Error('Multiple rows') }
            return { data: matches[0] ?? null, error: null }
          },
        }
        return builder
      },
    },
  }
}

const BALAKONG = 'warehouse-balakong'
const SAHABAT = 'warehouse-sahabat'
const BANANA_MILK = 'variant-banana-milk'
const addStockComponent = readFileSync(
  new URL('../../components/inventory/AddStockView.tsx', import.meta.url),
  'utf8'
)

function catalogRow(overrides: Partial<ManualStockCatalogRow> = {}): ManualStockCatalogRow {
  return {
    rowKey: catalogRowKey('v-1', 'c-20nb'),
    stockConfigId: 'c-20nb',
    variantId: 'v-1',
    productId: 'p-1',
    productCode: 'CEL-001',
    productName: 'Cellera Hazelnut',
    variantName: 'Cellera Hazelnut [Hazelnut]',
    variantProductCode: 'HA',
    alternativeName: 'Coffee Hazelnut',
    baseCost: 14,
    flavour: '[Hazelnut]',
    productLine: 'Cellera',
    manufacturerId: 'mfg-1',
    manufacturerName: 'Cellera Mfg',
    configCode: '20NB',
    configLabel: '20ml · New Box',
    stockSku: 'HAZ-20NB',
    volumeMl: 20,
    packaging: 'new_box',
    status: 'active',
    isCellera: true,
    currentOnHand: 10,
    averageCost: 12,
    ...overrides,
  }
}

describe('Add Stock existing inventory balance', () => {
  it('keeps the same variant in two warehouses as separate balances', async () => {
    const database = fakeSupabase([
      inventoryRow(BALAKONG, BANANA_MILK, 100, 'Serapod Warehouse Balakong'),
      inventoryRow(SAHABAT, BANANA_MILK, 3_500, 'Sahabat Vape'),
    ])

    const balakong = await fetchExistingStockForWarehouse(database.client, BALAKONG, BANANA_MILK)
    const sahabat = await fetchExistingStockForWarehouse(database.client, SAHABAT, BANANA_MILK)

    expect(balakong?.quantity_available).toBe(100)
    expect(balakong?.warehouse_name).toBe('Serapod Warehouse Balakong')
    expect(sahabat?.quantity_available).toBe(3_500)
    expect(sahabat?.warehouse_name).toBe('Sahabat Vape')
  })

  it('does not query or show arbitrary stock when no warehouse is selected', async () => {
    const database = fakeSupabase([
      inventoryRow(SAHABAT, BANANA_MILK, 3_500, 'Sahabat Vape'),
    ])

    expect(await fetchExistingStockForWarehouse(database.client, '', BANANA_MILK)).toBeNull()
    expect(database.queries).toHaveLength(0)
  })

  it('builds a manual movement for only the selected warehouse', () => {
    const params = buildAddStockMovementParams({
      variantId: BANANA_MILK,
      warehouseId: BALAKONG,
      quantity: 25,
      unitCost: 14,
      manufacturerId: null,
      warehouseLocation: null,
      notes: null,
      companyId: 'company-1',
      createdBy: 'user-1',
    })

    expect(params.p_organization_id).toBe(BALAKONG)
    expect(params.p_variant_id).toBe(BANANA_MILK)
    expect(params.p_quantity_change).toBe(25)
    expect(JSON.stringify(params)).not.toContain(SAHABAT)
  })
})

describe('Manual Stock Addition bulk helpers', () => {
  it('rejects every legacy and inactive configuration, admitting only the canonical one', () => {
    expect(isSelectableManualStockConfiguration({
      stockConfigId: 'legacy',
      configCode: 'UNCLASSIFIED',
      status: 'active',
    })).toBe(false)
    // 50NB and 50OB are retired to zero, never restocked.
    expect(isSelectableManualStockConfiguration({
      stockConfigId: 'c-50nb',
      configCode: '50NB',
      status: 'active',
    })).toBe(false)
    expect(isSelectableManualStockConfiguration({
      stockConfigId: 'c-50ob',
      configCode: '50OB',
      status: 'active',
    })).toBe(false)
    // STD stays selectable: it is the canonical configuration for non-vape.
    expect(isSelectableManualStockConfiguration({
      stockConfigId: 'c-std',
      configCode: 'STD',
      status: 'active',
    })).toBe(true)
    expect(isSelectableManualStockConfiguration({
      stockConfigId: 'c1',
      configCode: '20NB',
      status: 'phase_out',
    })).toBe(false)
    expect(isSelectableManualStockConfiguration({
      stockConfigId: 'c1',
      configCode: '20NB',
      status: 'active',
    })).toBe(true)
  })

  it('requires positive whole add quantities', () => {
    expect(parseAddQuantity('0').ok).toBe(false)
    expect(parseAddQuantity('-3').ok).toBe(false)
    expect(parseAddQuantity('1.5').ok).toBe(false)
    expect(parseAddQuantity('12')).toEqual({ ok: true, value: 12 })
  })

  it('keeps exact configuration identity and admits only the canonical configuration', () => {
    const rows = [
      catalogRow(),
      catalogRow({
        rowKey: catalogRowKey('v-1', 'c-50nb'),
        stockConfigId: 'c-50nb',
        configCode: '50NB',
        configLabel: '50ml · New Box',
        stockSku: 'HAZ-50NB',
        volumeMl: 50,
        packaging: 'new_box',
        currentOnHand: 4,
      }),
      catalogRow({
        rowKey: catalogRowKey('v-1', 'c-50ob'),
        stockConfigId: 'c-50ob',
        configCode: '50OB',
        configLabel: '50ml · Old Box',
        stockSku: 'HAZ-50OB',
        volumeMl: 50,
        packaging: 'old_box',
        currentOnHand: 2,
      }),
      catalogRow({
        rowKey: catalogRowKey('v-1', 'c-legacy'),
        stockConfigId: 'c-legacy',
        configCode: 'UNCLASSIFIED',
        configLabel: 'Legacy / Unclassified',
        stockSku: 'HAZ-LEGACY',
        volumeMl: null,
        packaging: null,
      }),
    ]

    // Several configurations on one variant: the control is genuinely shown, so
    // an explicit choice still filters.
    expect(effectiveConfigurationFilterKey(rows, '20|new_box|20ml · New Box')).toBe('20|new_box|20ml · New Box')
    const filtered = filterManualStockCatalogRows(rows, {
      configurationKey: '20|new_box|20ml · New Box',
    })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].stockConfigId).toBe('c-20nb')

    // Canonical operational configuration only. 50NB, 50OB and UNCLASSIFIED are
    // retired to zero by LEGACY-CONFIG-CUTOVER-2026 and can never receive new
    // stock, so posting against them fails closed rather than silently adding.
    const selected = new Set([rows[0].rowKey])
    const items = buildManualStockRpcItems(
      rows,
      selected,
      { [rows[0].rowKey]: '5' },
      { [rows[0].rowKey]: '10' },
      {},
    )
    expect(items.map((item) => item.stockConfigId)).toEqual(['c-20nb'])
    expect(items.every((item) => item.variantId === 'v-1')).toBe(true)

    for (const legacy of [rows[1], rows[2], rows[3]]) {
      expect(isSelectableManualStockConfiguration(legacy)).toBe(false)
      expect(() => buildManualStockRpcItems(
        rows,
        new Set([legacy.rowKey]),
        { [legacy.rowKey]: '3' },
        { [legacy.rowKey]: '11' },
        {},
      )).toThrow(/Legacy\/Unclassified/)
    }
  })

  it('preserves entered quantities across pagination and filtering', () => {
    const rows = Array.from({ length: 30 }, (_, index) => catalogRow({
      rowKey: catalogRowKey(`v-${index}`, `c-${index}`),
      stockConfigId: `c-${index}`,
      variantId: `v-${index}`,
      stockSku: `SKU-${index}`,
      productName: `Product ${index}`,
    }))
    const quantities = Object.fromEntries(rows.map((row) => [row.rowKey, '2']))
    const page1 = paginateRows(rows, 1, 25)
    const page2 = paginateRows(rows, 2, 25)
    expect(page1).toHaveLength(25)
    expect(page2).toHaveLength(5)
    expect(quantities[page2[0].rowKey]).toBe('2')

    const qtyOnly = filterManualStockCatalogRows(rows, {
      quantityOnly: true,
      quantities: { [rows[0].rowKey]: '4' },
    })
    expect(qtyOnly.map((row) => row.rowKey)).toEqual([rows[0].rowKey])
  })

  it('summarizes selected flavours, configurations, units and value', () => {
    const rows = [
      catalogRow(),
      catalogRow({
        rowKey: catalogRowKey('v-2', 'c-20nb-b'),
        stockConfigId: 'c-20nb-b',
        variantId: 'v-2',
        stockSku: 'BNN-20NB',
      }),
    ]
    const summary = summarizeManualStockSelection(
      rows,
      new Set(rows.map((row) => row.rowKey)),
      { [rows[0].rowKey]: '10', [rows[1].rowKey]: '5' },
      { [rows[0].rowKey]: '2', [rows[1].rowKey]: '3' },
    )
    expect(summary).toMatchObject({
      selectedFlavours: 2,
      selectedConfigurations: 2,
      totalUnits: 15,
      totalValue: 35,
      ready: true,
    })
  })

  it('builds an atomic bulk RPC payload with exact stock_config_id per line', () => {
    const params = buildPostManualStockAdditionParams({
      requestId: 'req-1',
      warehouseId: BALAKONG,
      companyId: 'company-1',
      createdBy: 'user-1',
      reason: 'Non-PO Receipt',
      externalReference: 'EMAIL-9',
      items: [
        { stockConfigId: 'c-20nb', variantId: 'v-1', quantity: 4, pcs: 0, unitCost: 12, rowNote: 'shelf A' },
        { stockConfigId: 'c-50nb', variantId: 'v-1', quantity: 2, pcs: 0, unitCost: 15 },
      ],
    })

    expect(params.p_request_id).toBe('req-1')
    expect(params.p_organization_id).toBe(BALAKONG)
    expect(params.p_reason).toBe('Non-PO Receipt')
    expect(params.p_items).toEqual([
      { pcs: 0, stock_config_id: 'c-20nb', variant_id: 'v-1', quantity: 4, unit_cost: 12, row_note: 'shelf A' },
      { pcs: 0, stock_config_id: 'c-50nb', variant_id: 'v-1', quantity: 2, unit_cost: 15, row_note: null },
    ])
    expect(JSON.stringify(params.p_items)).not.toContain('UNCLASSIFIED')
  })

  it('keeps weighted average cost mathematically correct and non-negative', () => {
    expect(weightedAverageCost(100, 10, 100, 20)).toBe(15)
    expect(weightedAverageCost(0, null, 10, 8)).toBe(8)
    expect(weightedAverageCost(50, 12, 10, null)).toBe(12)
    expect(newBalance(10, 5)).toBe(15)
  })

  it('blocks Legacy rows from RPC item construction', () => {
    const rows = [catalogRow({
      rowKey: catalogRowKey('v-1', 'c-legacy'),
      stockConfigId: 'c-legacy',
      configCode: 'UNCLASSIFIED',
      configLabel: 'Legacy / Unclassified',
      stockSku: 'HAZ-LEGACY',
    })]
    expect(() => buildManualStockRpcItems(
      rows,
      new Set([rows[0].rowKey]),
      { [rows[0].rowKey]: '3' },
      {},
      {},
    )).toThrow(/Legacy\/Unclassified/)
  })
})

describe('Manual Stock Addition UI contracts', () => {
  it('renders the bulk manual addition page structure and ORD receiving warning', () => {
    expect(addStockComponent).toContain('Manual Stock Addition')
    expect(addStockComponent).toContain('Use ORD Receiving for stock linked to a manufacturer order')
    expect(addStockComponent).toContain('Review & Add Stock')
    expect(addStockComponent).toContain('Ready to Post')
    expect(addStockComponent).toContain('Select all visible')
    expect(addStockComponent).toContain('Export Excel Template')
    expect(addStockComponent).toContain('Import Updated Excel')
    expect(addStockComponent).toContain("rpc('post_manual_stock_addition'")
    expect(addStockComponent).toContain('postingLockRef')
    expect(addStockComponent).toContain('inventory will increase immediately')
  })

  it('drops the Stock SKU column and shows variant Product Code, alternative name and Base Cost', () => {
    expect(addStockComponent).not.toContain('<TableHead>Stock SKU</TableHead>')
    expect(addStockComponent).not.toContain('{row.stockSku}')
    expect(addStockComponent).toContain('variantIdentityLabel(row.variantName, row.variantProductCode)')
    expect(addStockComponent).toContain('variantAlternativeLabel(row.alternativeName)')
    expect(addStockComponent).toContain('product_code,\n            alternative_name,\n            base_cost,')
    expect(addStockComponent).toContain('next[row.rowKey] = String(row.baseCost)')
  })

  it('does not introduce a draft or OTP approval lifecycle for Add Stock', () => {
    expect(addStockComponent).not.toContain('verify_and_post_stock_count')
    expect(addStockComponent).not.toContain('pending_approval')
    expect(addStockComponent).not.toContain('OTP')
  })
})

describe('Add Stock hidden configuration filter regression (Device STD vs Cartridge 20NB)', () => {
  const CARTRIDGE_20NB_KEY = '20|new_box|20ml · New Box'

  function mixedCatalog(): ManualStockCatalogRow[] {
    return [
      catalogRow({
        rowKey: catalogRowKey('v-cart', 'c-cart-20nb'),
        stockConfigId: 'c-cart-20nb',
        variantId: 'v-cart',
        productId: 'p-cart',
        productName: 'Cellera Cartridge Hazelnut',
        variantName: 'Cellera Cartridge [Hazelnut]',
        productLine: 'Cartridge',
        manufacturerId: 'mfg-cellera',
        configCode: '20NB',
        configLabel: '20ml · New Box',
        stockSku: 'CART-HAZ-20NB',
        volumeMl: 20,
        packaging: 'new_box',
        isCellera: true,
      }),
      catalogRow({
        rowKey: catalogRowKey('v-dev', 'c-dev-std'),
        stockConfigId: 'c-dev-std',
        variantId: 'v-dev',
        productId: 'p-dev',
        productCode: 'DEV-001',
        productName: 'Serapod Device',
        variantName: 'Serapod Device [Black]',
        variantProductCode: 'DB',
        alternativeName: 'Pod Device Black',
        flavour: '[Black]',
        productLine: 'Device',
        manufacturerId: 'mfg-device',
        manufacturerName: 'Device Mfg',
        configCode: 'STD',
        configLabel: 'Standard',
        stockSku: 'DEV-BLK-STD',
        volumeMl: null,
        packaging: null,
        isCellera: false,
      }),
    ]
  }

  it('hides the Configuration control for a single-canonical-config mixed catalog', () => {
    expect(shouldShowConfigurationColumn(mixedCatalog())).toBe(false)
  })

  it('cannot leave an invisible 20NB filter active when the control is hidden', () => {
    const rows = mixedCatalog()
    // This is the exact stale state production was left in.
    expect(effectiveConfigurationFilterKey(rows, CARTRIDGE_20NB_KEY)).toBe('all')
    expect(effectiveConfigurationFilterKey(rows, 'all')).toBe('all')
    expect(effectiveConfigurationFilterKey(rows, '')).toBe('all')
    expect(effectiveConfigurationFilterKey(rows, 'no-such-config')).toBe('all')
  })

  it('returns the Device STD row when Product Group = Device', () => {
    const rows = mixedCatalog()
    const device = filterManualStockCatalogRows(rows, {
      productLine: 'Device',
      configurationKey: effectiveConfigurationFilterKey(rows, CARTRIDGE_20NB_KEY),
    })
    expect(device.map((row) => row.stockConfigId)).toEqual(['c-dev-std'])
    expect(device[0].configCode).toBe('STD')

    // Documents the production failure mode if the stale key reached the filter.
    expect(filterManualStockCatalogRows(rows, {
      productLine: 'Device',
      configurationKey: CARTRIDGE_20NB_KEY,
    })).toEqual([])
  })

  it('still returns the Cartridge 20NB row when Product Group = Cartridge', () => {
    const rows = mixedCatalog()
    const cartridge = filterManualStockCatalogRows(rows, {
      productLine: 'Cartridge',
      configurationKey: effectiveConfigurationFilterKey(rows, CARTRIDGE_20NB_KEY),
    })
    expect(cartridge.map((row) => row.stockConfigId)).toEqual(['c-cart-20nb'])
    expect(cartridge[0].configCode).toBe('20NB')
  })

  it('shows both groups under All and keeps search, manufacturer and quantity-only filters working', () => {
    const rows = mixedCatalog()
    const configurationKey = effectiveConfigurationFilterKey(rows, CARTRIDGE_20NB_KEY)
    expect(filterManualStockCatalogRows(rows, { productLine: 'all', configurationKey })).toHaveLength(2)
    expect(filterManualStockCatalogRows(rows, { search: 'pod device', configurationKey })
      .map((row) => row.stockConfigId)).toEqual(['c-dev-std'])
    expect(filterManualStockCatalogRows(rows, { manufacturerId: 'mfg-device', configurationKey })
      .map((row) => row.stockConfigId)).toEqual(['c-dev-std'])
    expect(filterManualStockCatalogRows(rows, {
      quantityOnly: true,
      quantities: { [rows[1].rowKey]: '7' },
      configurationKey,
    }).map((row) => row.stockConfigId)).toEqual(['c-dev-std'])
    expect(paginateRows(filterManualStockCatalogRows(rows, { configurationKey }), 1, 25)).toHaveLength(2)
  })

  it('keeps STD selectable and posts the exact Device and Cartridge stock_config_id', () => {
    const rows = mixedCatalog()
    expect(isSelectableManualStockConfiguration(rows[0])).toBe(true)
    expect(isSelectableManualStockConfiguration(rows[1])).toBe(true)

    const items = buildManualStockRpcItems(
      rows,
      new Set(rows.map((row) => row.rowKey)),
      { [rows[0].rowKey]: '5', [rows[1].rowKey]: '3' },
      { [rows[0].rowKey]: '10', [rows[1].rowKey]: '40' },
      {},
    )
    expect(items.map((item) => [item.variantId, item.stockConfigId])).toEqual([
      ['v-cart', 'c-cart-20nb'],
      ['v-dev', 'c-dev-std'],
    ])
  })

  it('still rejects 50NB, 50OB and UNCLASSIFIED', () => {
    for (const configCode of ['50NB', '50OB', 'UNCLASSIFIED']) {
      const legacy = catalogRow({
        rowKey: catalogRowKey('v-cart', `c-${configCode}`),
        stockConfigId: `c-${configCode}`,
        configCode,
        configLabel: configCode === 'UNCLASSIFIED' ? 'Legacy / Unclassified' : configCode,
      })
      expect(isSelectableManualStockConfiguration(legacy)).toBe(false)
      expect(() => buildManualStockRpcItems(
        [legacy],
        new Set([legacy.rowKey]),
        { [legacy.rowKey]: '1' },
        {},
        {},
      )).toThrow(/Legacy\/Unclassified/)
    }
  })

  it('AddStockView defaults to all and filters only through the effective configuration key', () => {
    expect(addStockComponent).not.toContain('defaultConfigurationFilterKey')
    expect(addStockComponent).toContain("setConfigurationKey('all')")
    expect(addStockComponent).toContain('effectiveConfigurationFilterKey(catalogRows, configurationKey)')
    expect(addStockComponent).toContain('configurationKey: activeConfigurationKey,')
    expect(addStockComponent).not.toMatch(/filterManualStockCatalogRows\(catalogRows, \{[^}]*configurationKey,/)
  })
})
