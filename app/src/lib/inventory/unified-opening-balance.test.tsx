import fs from 'node:fs'
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import {
  buildStockCountWorksheet,
  parseStockCountWorksheet,
  type StockCountWorkbookContext,
} from './stock-count-excel'

const repoFile = (path: string) => fs.readFileSync(
  new URL(`../../../../${path}`, import.meta.url),
  'utf8',
)
const stockCountView = repoFile('app/src/components/inventory/StockAdjustmentView.tsx')
const settingsView = repoFile('app/src/components/inventory/InventorySettingsView.tsx')
const cutoffSection = repoFile('app/src/components/inventory/InventoryOpeningCutoffSection.tsx')
const verifyRoute = repoFile('app/src/app/api/inventory/stock-count/verification/verify/route.ts')
const postingStatusRoute = repoFile('app/src/app/api/inventory/stock-count/drafts/posting-status/route.ts')
const migration04 = repoFile('supabase/migrations/20260726_inventory_opening_balance_cutoff/04_unified_opening_balance_flow.sql')

const excelRow = {
  stockConfigId: 'config-20nb',
  stockSku: 'SKU-20NB',
  variantId: 'variant-1',
  volumeMl: 20,
  packagingVersion: 'new_box',
  groupName: 'Cartridge',
  variantName: 'Cellera [SC]',
  productName: 'Cellera',
  productCode: 'SC',
  systemQuantity: 0,
  physicalCount: '',
  note: '',
}

const context: StockCountWorkbookContext = {
  warehouseId: 'warehouse-balakong',
  sessionId: 'opening-session-1',
  countType: 'opening_balance_cutoff',
  categoryId: 'category-vape',
}

describe('Unified Inventory Opening Balance flow', () => {
  it('offers one Opening Balance creation option and keeps the old type label-only', () => {
    const creationOptions = stockCountView.match(
      /const countTypeCreationOptions[\s\S]*?\n\)/,
    )?.[0] || ''
    expect(stockCountView).toContain('Inventory Opening Balance & Initial Classification')
    expect(creationOptions).toContain("option.value !== 'initial_configuration_classification'")
    expect(stockCountView).toContain('Legacy Initial Classification — Read Only')
    expect(stockCountView).toContain('isLegacyInitialReadOnly')
  })

  it('removes the separate Inventory Settings entry and embeds controls in Stock Count', () => {
    expect(settingsView).not.toContain('InventoryOpeningCutoffSection')
    expect(settingsView).not.toContain('Inventory Go-Live &amp; Cut-off')
    expect(stockCountView).toContain('<InventoryOpeningCutoffSection')
    expect(cutoffSection).toContain('Opening Balance Review, Freeze &amp; Posting')
    // The guided wizard embeds the same distributor and manufacturer decisions
    // under their five-step headings (renamed from the old flat sections).
    expect(cutoffSection).toContain('Resolve Distributor (D2H) Orders')
    expect(cutoffSection).toContain('Resolve Manufacturer (H2M) Incoming')
    expect(cutoffSection).toContain('Danger Zone / More Actions')
    expect(cutoffSection).toContain('Cancel Entire Opening Balance Exercise')
    expect(cutoffSection).toContain('Posting Note')
    expect(cutoffSection).toContain('Request OTP')
    expect(cutoffSection).toContain('Verify OTP &amp; Post Opening Balance')
  })

  it('blocks legacy posting in both preflight and verify routing', () => {
    expect(verifyRoute).toContain("accessibleSession.count_type === 'initial_configuration_classification'")
    expect(verifyRoute).not.toContain("'verify_and_post_stock_classification'")
    expect(migration04).toContain('stock_count_legacy_initial_read_only')
    expect(migration04).toContain('stock_count_unified_opening_balance_guard')
  })

  it('enforces one posted Opening Balance per warehouse/category and complete saved counts server-side', () => {
    expect(migration04).toContain('inventory_opening_cutoffs_one_posted_warehouse_category')
    expect(migration04).toContain('warehouse_organization_id, product_category_id')
    expect(migration04).toMatch(/where status = 'posted'/i)
    expect(migration04).toContain('inventory_opening_balance_already_posted')
    expect(migration04).toContain('inventory_opening_balance_count_incomplete')
    expect(migration04).toContain('stock_count_session_scope')
    expect(stockCountView).toContain('visibleRows.every(row => rowIsCounted(row))')
  })

  it('uses the official Product Category relationship for immutable draft scope', () => {
    expect(stockCountView).toContain('product_categories!inner')
    expect(stockCountView).toContain('product_category_id: isOpeningBalanceMode ? selectedCategory : null')
    expect(stockCountView).toContain('row.categoryId === selectedCategory')
    expect(migration04).toContain('products.category_id -> product_categories.id')
    expect(migration04).toContain('stock_count_category_immutable')
    expect(migration04).toContain('inventory_opening_balance_category_scope_mismatch')
    expect(migration04).toContain('inventory_cutoff_order_outside_category')
  })

  it('enforces one active Opening Balance draft per warehouse/category across DB, UI and save', () => {
    // Database backstop: a partial unique index over (warehouse, category) for
    // still-draft Opening Balance sessions.
    expect(migration04).toContain('stock_count_one_active_opening_balance_draft')
    expect(migration04).toMatch(/where\s+count_type = 'opening_balance_cutoff'\s+and status = 'draft'/i)
    // UI: pick a warehouse+category that already has a draft -> must continue it.
    expect(stockCountView).toContain('mustContinueExistingOpeningDraft')
    expect(stockCountView).toContain('existingOpeningDraft')
    expect(stockCountView).toContain('Continue Existing Draft')
    expect(stockCountView).toContain('resolveActiveOpeningBalanceDraft')
    expect(stockCountView).toContain('cutoff_status')
    expect(cutoffSection).toContain('Cancelled — Read Only')
    expect(cutoffSection).toContain('cancelledOpeningBalanceNextAction')
    expect(cutoffSection).toContain('onReturnToActiveDraft')
    // Save path: a concurrent create loses the unique race, refreshes detection,
    // and still requires the operator to choose Continue Existing Draft.
    expect(stockCountView).toContain("(error as any).code === '23505'")
    expect(stockCountView).toContain('Use Continue Existing Draft. No second draft was created.')
  })

  it('lists only deletable drafts and rejects discard after posting starts', () => {
    // Manage Drafts is scoped to the selected Count Type but still shows the
    // removable (deletable) count only; discard acts on deletable drafts only.
    expect(stockCountView).toContain('countTypeDrafts.filter(draft => draft.deletable)')
    expect(stockCountView).toContain('draft => uniqueIds.has(draft.id) && draft.deletable')
    // The posting-started status (which reads the server-only OTP table) now
    // lives behind an authorized server route, never in the browser bundle.
    // Counting freezes alone are intentionally excluded from posting-started.
    expect(postingStatusRoute).toContain("['pending_delivery', 'active', 'posted']")
    expect(postingStatusRoute).not.toContain("from('inventory_opening_cutoffs')")
    expect(stockCountView).not.toContain("from('stock_count_verification_requests')")
    expect(migration04).toContain('stock_count_discard_posting_started_guard')
    expect(migration04).toContain('stock_count_not_discardable_posting_started')
  })

  it('keeps Opening Balance outside the pre-go-live Legacy misuse guard', () => {
    expect(migration04).toContain("'initial_configuration_classification', 'opening_balance_cutoff'")
    expect(migration04).toContain("c.status = 'posted'")
    expect(stockCountView).toContain("!postedOpeningCategoryIds.has(row.categoryId)")
  })

  it('round-trips a session-bound Opening Balance workbook using stable IDs', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildStockCountWorksheet(workbook, [excelRow], context)
    sheet.getRow(2).getCell(15).value = 42

    const result = parseStockCountWorksheet(sheet, [{
      stockConfigId: excelRow.stockConfigId,
      stockSku: excelRow.stockSku,
      variantId: excelRow.variantId,
      physicalCount: '',
      note: '',
    }], context)

    expect(result.failed).toBe(0)
    expect(result.patches.get(excelRow.stockConfigId)?.physicalCount).toBe('42')
    expect(workbook.getWorksheet('_Serapod2U_Metadata')?.state).toBe('veryHidden')
  })

  it('rejects a template from another warehouse, session, or count type', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildStockCountWorksheet(workbook, [excelRow], context)
    const targets = [{
      stockConfigId: excelRow.stockConfigId,
      stockSku: excelRow.stockSku,
      variantId: excelRow.variantId,
      physicalCount: '',
      note: '',
    }]

    expect(() => parseStockCountWorksheet(sheet, targets, { ...context, warehouseId: 'warehouse-other' }))
      .toThrow(/different warehouse/)
    expect(() => parseStockCountWorksheet(sheet, targets, { ...context, sessionId: 'session-other' }))
      .toThrow(/different Stock Count session/)
    expect(() => parseStockCountWorksheet(sheet, targets, { ...context, countType: 'full_count' }))
      .toThrow(/different Stock Count type/)
    expect(() => parseStockCountWorksheet(sheet, targets, { ...context, categoryId: 'category-pet-food' }))
      .toThrow(/different Product Category/)
  })
})
