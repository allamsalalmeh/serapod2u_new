import fs from 'node:fs'
import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import {
  buildStockCountCatalogRows,
  buildOpeningBalanceScopeRows,
  isStockCountCatalogRowVisible,
  resolveOpeningBalanceVisibleRows,
  STOCK_COUNT_UNGROUPED_ID,
  type StockCountCatalogRow,
} from './stock-count-catalog'
import { STOCK_COUNT_EXCEL_HEADERS, buildStockCountWorksheet } from './stock-count-excel'
import { resolveActiveOpeningBalanceDraft } from './opening-balance-active-draft'

// A minimal configuration row shaped like the Supabase catalog select. Category
// membership is included so the Opening Balance scope filter can be exercised.
function config(options: {
  id: string
  variantName: string
  variantActive?: boolean
  productActive?: boolean
  status?: string
  categoryId?: string
}) {
  const categoryId = options.categoryId ?? 'cat-devices'
  return {
    id: options.id,
    variant_id: `variant-${options.id}`,
    config_code: 'STD',
    config_label: 'Standard',
    stock_sku: `SKU-${options.id}`,
    volume_ml: null,
    packaging: null,
    status: options.status ?? 'active',
    product_variants: {
      id: `variant-${options.id}`,
      variant_name: options.variantName,
      alternative_name: null,
      variant_code: `VC-${options.id}`,
      product_code: 'PC',
      manufacturer_sku: null,
      manual_sku: null,
      image_url: null,
      base_cost: 17,
      is_active: options.variantActive ?? true,
      products: {
        id: `product-${options.id}`,
        product_name: 'Serapod Device S.Line',
        is_active: options.productActive ?? true,
        category_id: categoryId,
        product_categories: { id: categoryId, category_name: 'Devices', is_active: true },
        product_groups: { id: 'sline', group_name: 'Serapod Device S.Line', group_description: null, stock_config_profile: 'standard' },
        brands: null,
      },
    },
  }
}

// Mirror the component's live catalog query: it removes inactive configurations
// and inactive variants/products at the database (`.neq('status','inactive')`,
// `.eq('product_variants.is_active', true)`, `.eq(...products.is_active, true)`).
// A genuinely new count never receives archived master data from the server, so
// the pure catalog fixture applies the same predicate to model that boundary.
function loadActiveCatalog(configs: ReturnType<typeof config>[]): StockCountCatalogRow[] {
  const activeOnly = configs.filter(c =>
    c.status !== 'inactive'
    && c.product_variants.is_active === true
    && c.product_variants.products.is_active === true)
  return buildStockCountCatalogRows(activeOnly, [])
}

function excelDataConfigIds(sheet: ExcelJS.Worksheet): string[] {
  const ids: string[] = []
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    ids.push(String(row.getCell(1).text).trim())
  })
  return ids
}

// The exact projection the component applies before handing rows to
// buildStockCountWorksheet (StockAdjustmentView.downloadExcel).
function toWorksheetRows(rows: StockCountCatalogRow[]) {
  return rows.map(row => ({
    stockConfigId: row.stockConfigId,
    stockSku: row.stockSku,
    variantId: row.variantId,
    volumeMl: row.volumeMl,
    packagingVersion: row.packagingVersion,
    groupName: row.groupName,
    variantName: row.variantName,
    productName: row.productName,
    productCode: row.productCode,
    systemQuantity: row.systemQuantity,
    physicalCount: row.physicalCount,
    note: row.note,
  }))
}

const CATEGORY = 'cat-devices'

describe('Genuinely new count — archived master data eligibility (UI + Excel parity)', () => {
  it('excludes an inactive variant from a genuinely new Opening Balance count', () => {
    // Two active variants + one archived variant. Names are only for readability;
    // eligibility is decided by is_active, never by any variant name.
    const catalog = loadActiveCatalog([
      config({ id: 'green', variantName: 'S.Line Raya Edition Green', variantActive: false }),
      config({ id: 'white', variantName: 'S.Line Raya Edition White', variantActive: false }),
      config({ id: 'active', variantName: 'S.Line Standard Black' }),
    ])
    const visible = resolveOpeningBalanceVisibleRows(catalog, {
      currentSessionId: null,
      selectedCategory: CATEGORY,
      scopeIds: new Set(),
    })
    const names = visible.map(r => r.variantName)
    expect(names).toContain('S.Line Standard Black')
    expect(names).not.toContain('S.Line Raya Edition Green')
    expect(names).not.toContain('S.Line Raya Edition White')
  })

  it('excludes an inactive configuration from new scope creation', () => {
    // Variant/product active, but the configuration itself was made inactive by
    // the archive reconciliation. It must not enter the immutable scope snapshot.
    const catalog = loadActiveCatalog([
      config({ id: 'inactive-cfg', variantName: 'S.Line Phased Config', status: 'inactive' }),
      config({ id: 'active', variantName: 'S.Line Standard Black' }),
    ])
    const scope = buildOpeningBalanceScopeRows(catalog, CATEGORY)
    expect(scope.map(r => r.variantName)).toEqual(['S.Line Standard Black'])
    // Defence in depth: even if such a row were present, the visibility rule
    // hides an inactive configuration from a fresh (non-Show-Inactive) list.
    const forced = buildStockCountCatalogRows(
      [config({ id: 'inactive-cfg', variantName: 'S.Line Phased Config', status: 'inactive' })],
      [],
    )
    expect(isStockCountCatalogRowVisible(forced[0], false)).toBe(false)
  })

  it('omits the archived variant row from the Download Excel Template output', () => {
    const catalog = loadActiveCatalog([
      config({ id: 'green', variantName: 'S.Line Raya Edition Green', variantActive: false }),
      config({ id: 'active', variantName: 'S.Line Standard Black' }),
    ])
    const visible = resolveOpeningBalanceVisibleRows(catalog, {
      currentSessionId: null,
      selectedCategory: CATEGORY,
      scopeIds: new Set(),
    })
    const workbook = new ExcelJS.Workbook()
    const sheet = buildStockCountWorksheet(workbook, toWorksheetRows(visible))
    const ids = excelDataConfigIds(sheet)
    expect(ids).toContain('active')
    expect(ids).not.toContain('green')
  })

  it('UI table rows and Excel rows are the identical new-count eligible set', () => {
    // Both surfaces consume `visibleRows`; feeding the same set to the worksheet
    // must yield exactly the eligible Stock Configuration IDs, in the same order.
    const catalog = loadActiveCatalog([
      config({ id: 'white', variantName: 'S.Line Raya Edition White', variantActive: false }),
      config({ id: 'active-a', variantName: 'S.Line Alpha' }),
      config({ id: 'active-b', variantName: 'S.Line Bravo' }),
    ])
    const visible = resolveOpeningBalanceVisibleRows(catalog, {
      currentSessionId: null,
      selectedCategory: CATEGORY,
      scopeIds: new Set(),
    })
    const uiConfigIds = visible.map(r => r.stockConfigId)
    const workbook = new ExcelJS.Workbook()
    const sheet = buildStockCountWorksheet(workbook, toWorksheetRows(visible))
    expect(excelDataConfigIds(sheet)).toEqual(uiConfigIds)
    expect(uiConfigIds).toEqual(['active-a', 'active-b'])
  })

  it('does not change the Excel structure when eligible rows are excluded', () => {
    const catalog = loadActiveCatalog([
      config({ id: 'green', variantName: 'S.Line Raya Edition Green', variantActive: false }),
      config({ id: 'active', variantName: 'S.Line Standard Black' }),
    ])
    const visible = resolveOpeningBalanceVisibleRows(catalog, {
      currentSessionId: null,
      selectedCategory: CATEGORY,
      scopeIds: new Set(),
    })
    const workbook = new ExcelJS.Workbook()
    const sheet = buildStockCountWorksheet(workbook, toWorksheetRows(visible))
    expect(sheet.name).toBe('Stock Count')
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual([...STOCK_COUNT_EXCEL_HEADERS])
    expect(sheet.autoFilter).toEqual({ from: 'A1', to: 'P1' })
    // Header formatting anchors: text columns stay text, quantities stay numeric.
    expect(sheet.getColumn(1).numFmt).toBe('@')
    // Stock Unit (K) and Units per Case (L) are context; System Quantity (M) and
    // Physical Count (O) stay numeric.
    expect(sheet.getColumn(13).numFmt).toBe('#,##0')
    expect(sheet.getColumn(15).numFmt).toBe('#,##0')
  })

  it('reopened draft keeps the archived variant as a historical scope row (unchanged history)', () => {
    // A previously-saved draft snapshot pins these config ids; the reopen path is
    // bound to the snapshot scope and does NOT re-apply the active filter, so the
    // archived variant remains visible (and is labelled historical in the UI).
    const green = buildStockCountCatalogRows(
      [config({ id: 'green', variantName: 'S.Line Raya Edition Green', variantActive: false })],
      [],
    )
    const active = loadActiveCatalog([config({ id: 'active', variantName: 'S.Line Standard Black' })])
    const scopedCatalog = [...active, ...green]
    const reopened = resolveOpeningBalanceVisibleRows(scopedCatalog, {
      currentSessionId: 'session-1',
      selectedCategory: CATEGORY,
      scopeIds: new Set(['active', 'green']),
    })
    const names = reopened.map(r => r.variantName)
    expect(names).toContain('S.Line Standard Black')
    expect(names).toContain('S.Line Raya Edition Green')
    expect(reopened.find(r => r.stockConfigId === 'green')?.variantIsActive).toBe(false)
  })
})

// ── Source-level guarantees: the same eligibility path feeds UI and Excel, and a
// discarded/archived draft session is never reused as a new-count scope. These
// assert the wiring in the (very large, stateful) component without rendering it.
describe('New-count eligibility wiring (source guarantees)', () => {
  const view = fs.readFileSync(
    new URL('../../../../app/src/components/inventory/StockAdjustmentView.tsx', import.meta.url),
    'utf8',
  )

  it('the Excel template is built from the same visibleRows the UI renders', () => {
    const download = view.slice(view.indexOf('const downloadExcel = async'), view.indexOf('// Any change to the counted rows voids'))
    expect(download).toContain('buildStockCountWorksheet(workbook, visibleRows.map(')
  })

  it('visibleRows and the persisted scope both derive from the shared eligibility helpers', () => {
    expect(view).toContain('resolveOpeningBalanceVisibleRows(rows, {')
    expect(view).toContain('buildOpeningBalanceScopeRows(rows, selectedCategory)')
  })

  it('a genuinely new count is bound to the active-only catalog, never a reopened scope', () => {
    // resetSession (used after the current draft is discarded) rebuilds rows from
    // the authoritative active-only catalog, so a discarded scope can never leak
    // into the next new count.
    const resetSession = view.slice(view.indexOf('const resetSession = ()'), view.indexOf('const downloadExcel = async'))
    expect(resetSession).toContain('setCurrentSessionId(null)')
    expect(resetSession).toContain('setRows(catalogRows.map(')
    expect(resetSession).toContain('setOpeningDraftScopeIds(new Set())')
  })

  it('discarding the current draft resets its session so its scope is not reused', () => {
    expect(view).toContain('if (currentSessionId && removedIds.has(currentSessionId)) {')
    expect(view).toMatch(/removedIds\.has\(currentSessionId\)\)\s*\{\s*resetSession\(\)/)
  })

  it('existing-draft detection delegates to the authoritative resumable-draft resolver', () => {
    // The inline `draft.status === 'draft'` filter was refactored into
    // resolveActiveOpeningBalanceDraft. Assert the memo delegates to that
    // authoritative resolver (which enforces status/count_type/cutoff/scope),
    // rather than scanning for a specific inline expression that can drift.
    const detection = view.slice(view.indexOf('const existingOpeningDraft = useMemo'), view.indexOf('const mustContinueExistingOpeningDraft'))
    expect(detection).toContain('resolveActiveOpeningBalanceDraft(')
    expect(detection).toContain('selectedWarehouse')
    expect(detection).toContain('selectedCategory')
  })

  it('the resumable-draft resolver only ever matches a live draft, never an archived session', () => {
    // Behavioural regression for the rule the source scan protected: a
    // soft-archived session must not be selected as the active draft, so it can
    // never block a valid new count nor drop rows from Excel eligibility.
    const archived = { id: 'archived-1', status: 'archived', count_type: 'opening_balance_cutoff', warehouse_organization_id: 'wh-1', product_category_id: 'cat-vape', cutoff_status: 'cancelled' as const }
    const live = { id: 'live-1', status: 'draft', count_type: 'opening_balance_cutoff', warehouse_organization_id: 'wh-1', product_category_id: 'cat-vape', cutoff_status: null }
    expect(resolveActiveOpeningBalanceDraft([archived], 'wh-1', 'cat-vape')).toBeUndefined()
    expect(resolveActiveOpeningBalanceDraft([archived, live], 'wh-1', 'cat-vape')?.id).toBe('live-1')
  })

  it('the new-count creation preflight also matches only live drafts', () => {
    expect(view).toMatch(/\.eq\('count_type', 'opening_balance_cutoff'\)\s*\n\s*\.eq\('status', 'draft'\)/)
  })
})

// Guard the ungrouped fallback export stays importable (keeps the eligibility
// module surface stable for the wiring above).
describe('module surface', () => {
  it('exposes the ungrouped id constant', () => {
    expect(STOCK_COUNT_UNGROUPED_ID).toBe('ungrouped')
  })
})
