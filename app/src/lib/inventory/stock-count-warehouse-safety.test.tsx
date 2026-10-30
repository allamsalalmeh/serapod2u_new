import fs from 'node:fs'
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { buildStockCountWorksheet, parseStockCountWorksheet } from './stock-count-excel'

const repoFile = (path: string) => fs.readFileSync(
  new URL(`../../../../${path}`, import.meta.url),
  'utf8',
)

const stockCountView = repoFile('app/src/components/inventory/StockAdjustmentView.tsx')
const preflight = repoFile('app/src/lib/inventory/stock-count-verification-preflight.ts')
const verifyRoute = repoFile('app/src/app/api/inventory/stock-count/verification/verify/route.ts')
const migration04 = repoFile('supabase/migrations/20260726_inventory_opening_balance_cutoff/04_unified_opening_balance_flow.sql')

describe('Stock Count active warehouse safety', () => {
  it('queries authoritative active WH master records without name/code fallbacks', () => {
    expect(stockCountView).toContain(".eq('org_type_code', 'WH')")
    expect(stockCountView).toContain(".eq('is_active', true)")
    expect(stockCountView).not.toContain("location.org_code === 'HQ'")
    expect(stockCountView).not.toContain("org_name.toLowerCase().includes('warehouse')")
  })

  it('validates draft save, reopen, Excel download, and Excel import', () => {
    expect(stockCountView).toContain('if (!await validateActiveWarehouse()) throw new Error(ACTIVE_WAREHOUSE_REQUIRED_MESSAGE)')
    expect(stockCountView).toContain('Invalid warehouse on saved Stock Count')
    expect(stockCountView).toContain('Excel download blocked')
    expect(stockCountView).toContain('if (!selectedWarehouseIsValid || !await validateActiveWarehouse())')
    expect(stockCountView).toContain('Selected organization is not an active warehouse.')
  })

  it('rejects non-WH sessions in request preflight, direct verify, freeze, and final posting transition', () => {
    expect(preflight).toContain('loadActiveWarehouse')
    expect(preflight).toContain("code: 'invalid_warehouse'")
    expect(verifyRoute).toContain(".eq('org_type_code', 'WH')")
    expect(verifyRoute).toContain("stockCountVerificationError('invalid_warehouse'")
    expect(migration04).toContain('is_active_stock_count_warehouse')
    expect(migration04).toContain('stock_count_active_warehouse_required')
    expect(migration04).toContain('before insert or update of count_type, status, warehouse_organization_id')
    expect(migration04).toMatch(/start_inventory_opening_cutoff[\s\S]*is_active_stock_count_warehouse/)
    expect(migration04).toMatch(/prepare_stock_count_verification[\s\S]*is_active_stock_count_warehouse/)
  })

  it('keeps valid warehouse history and blocks unsafe legacy history from mutation/posting', () => {
    // Legacy Initial-Classification history is restricted to POSTED sessions via
    // LEGACY_HISTORY_STATUSES (= ['posted']); 'archived'/discarded drafts must not
    // reappear as "Legacy — Read Only" cards (approved discard-drafts fix).
    expect(stockCountView).toContain(".in('status', LEGACY_HISTORY_STATUSES)")
    expect(stockCountView).toContain('Stock Count drafts blocked by invalid warehouse master data')
    expect(stockCountView).toContain('invalidWarehouseDrafts')
    expect(stockCountView).toContain('This historical record remains unchanged')
    expect(migration04).toContain('stock_count_legacy_initial_read_only')
  })

  it('binds normal-count Excel to stable warehouse, session, and count type IDs', () => {
    const workbook = new ExcelJS.Workbook()
    const context = {
      warehouseId: 'warehouse-alma',
      sessionId: 'full-count-1',
      countType: 'full_count',
    }
    const sheet = buildStockCountWorksheet(workbook, [{
      stockConfigId: 'config-20nb',
      stockSku: 'SKU-20NB',
      variantId: 'variant-1',
      volumeMl: 20,
      packagingVersion: 'new_box',
      groupName: 'Cartridge',
      variantName: 'Cellera [SC]',
      productName: 'Cellera',
      productCode: 'SC',
      systemQuantity: 10,
      physicalCount: '',
      note: '',
    }], context)
    sheet.getRow(2).getCell(15).value = 11

    const targets = [{
      stockConfigId: 'config-20nb',
      stockSku: 'SKU-20NB',
      variantId: 'variant-1',
      physicalCount: '',
      note: '',
    }]
    expect(parseStockCountWorksheet(sheet, targets, context).patches.get('config-20nb')?.physicalCount).toBe('11')
    expect(() => parseStockCountWorksheet(sheet, targets, { ...context, warehouseId: 'distributor-1' }))
      .toThrow(/different warehouse/)
  })
})
