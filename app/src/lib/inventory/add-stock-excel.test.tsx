import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import {
  MANUAL_STOCK_ADDITION_EXCEL_HEADERS,
  buildManualStockAdditionWorksheet,
  parseManualStockAdditionImport,
} from './add-stock-excel'
import { catalogRowKey, type ManualStockCatalogRow } from './add-stock-inventory'

function row(overrides: Partial<ManualStockCatalogRow> = {}): ManualStockCatalogRow {
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

describe('Manual Stock Addition Excel', () => {
  it('exports protected identity columns and editable qty/cost/note columns', async () => {
    const workbook = new ExcelJS.Workbook()
    const source = [row(), row({
      rowKey: catalogRowKey('v-1', 'c-50nb'),
      stockConfigId: 'c-50nb',
      productName: 'Cellera Hero',
      configCode: '50NB',
      configLabel: '50ml · New Box',
      stockSku: 'HAZ-50NB',
      volumeMl: 50,
    })]
    buildManualStockAdditionWorksheet(
      workbook,
      source,
      { [source[0].rowKey]: '7' },
      { [source[0].rowKey]: '9.5' },
      { [source[0].rowKey]: 'opening' },
    )

    const sheet = workbook.worksheets[0]
    expect(sheet.name).toBe('Manual Stock Addition')
    expect(MANUAL_STOCK_ADDITION_EXCEL_HEADERS).toEqual([
      'Stock Configuration ID',
      'Stock SKU',
      'Variant ID',
      'Product Group',
      'Product Name',
      'Variant Name',
      'Flavour',
      'Product Code',
      'Volume',
      'Packaging Version',
      'Stock Unit',
      'Current Quantity',
      'Add Quantity',
      'Unit Cost',
      'Row Note',
    ])
    expect(sheet.getRow(2).getCell(1).value).toBe('c-20nb')
    // "Cellera Hazelnut" is not a cartridge line → counted in pcs.
    expect(sheet.getRow(2).getCell(11).value).toBe('Pcs')
    expect(sheet.getRow(2).getCell(12).value).toBe(10)
    expect(sheet.getRow(2).getCell(13).value).toBe(7)
    expect(sheet.getRow(2).getCell(14).value).toBe(9.5)
    // "Cellera Hero" is a cartridge line → counted in cases.
    expect(sheet.getRow(3).getCell(11).value).toBe('Cases')
    expect(sheet.getRow(2).getCell(1).protection?.locked).toBe(true)
    expect(sheet.getRow(2).getCell(11).protection?.locked).toBe(true)
    expect(sheet.getRow(2).getCell(13).protection?.locked).toBe(false)
    expect(sheet.getRow(2).getCell(14).protection?.locked).toBe(false)
    expect(sheet.getRow(2).getCell(15).protection?.locked).toBe(false)
  })

  it('imports matching configuration IDs and rejects duplicate/mismatched/stale/variant-only rows', async () => {
    const source = [row(), row({
      rowKey: catalogRowKey('v-2', 'c-20nb-b'),
      stockConfigId: 'c-20nb-b',
      variantId: 'v-2',
      stockSku: 'BNN-20NB',
      productCode: 'CEL-002',
      productName: 'Cellera Banana',
      variantName: 'Cellera Banana [Banana]',
    })]

    const good = new ExcelJS.Workbook()
    buildManualStockAdditionWorksheet(
      good,
      source,
      { [source[0].rowKey]: '4', [source[1].rowKey]: '6' },
      { [source[0].rowKey]: '10' },
      {},
    )
    const imported = await parseManualStockAdditionImport(good, source)
    expect(imported.updated).toBe(2)
    expect(imported.failed).toBe(0)
    expect(imported.patches.get(source[0].rowKey)?.quantity).toBe('4')

    const duplicate = new ExcelJS.Workbook()
    const dupSheet = duplicate.addWorksheet('Manual Stock Addition')
    dupSheet.addRow([...MANUAL_STOCK_ADDITION_EXCEL_HEADERS])
    dupSheet.addRow(['c-20nb', 'HAZ-20NB', 'v-1', 'Cellera', 'Cellera Hazelnut', 'Cellera Hazelnut [Hazelnut]', '[Hazelnut]', 'CEL-001', 20, 'New Box', 10, 3, 10, null])
    dupSheet.addRow(['c-20nb', 'HAZ-20NB', 'v-1', 'Cellera', 'Cellera Hazelnut', 'Cellera Hazelnut [Hazelnut]', '[Hazelnut]', 'CEL-001', 20, 'New Box', 10, 5, 10, null])
    const dupResult = await parseManualStockAdditionImport(duplicate, source)
    expect(dupResult.failed).toBeGreaterThan(0)
    expect(dupResult.rows.some((entry) => /Duplicate/i.test(entry.message))).toBe(true)

    const mismatched = new ExcelJS.Workbook()
    const mismatchSheet = mismatched.addWorksheet('Manual Stock Addition')
    mismatchSheet.addRow([...MANUAL_STOCK_ADDITION_EXCEL_HEADERS])
    mismatchSheet.addRow(['c-20nb', 'HAZ-20NB', 'v-WRONG', 'Cellera', 'Cellera Hazelnut', 'Cellera Hazelnut [Hazelnut]', '[Hazelnut]', 'CEL-001', 20, 'New Box', 10, 3, 10, null])
    const mismatchResult = await parseManualStockAdditionImport(mismatched, source)
    expect(mismatchResult.rows.some((entry) => /Variant ID does not match/i.test(entry.message))).toBe(true)

    const stale = new ExcelJS.Workbook()
    const staleSheet = stale.addWorksheet('Manual Stock Addition')
    staleSheet.addRow([...MANUAL_STOCK_ADDITION_EXCEL_HEADERS])
    staleSheet.addRow(['missing-config', 'OLD-SKU', 'v-1', 'Cellera', 'Old', 'Old', '', 'X', 20, 'New Box', 10, 3, 10, null])
    const staleResult = await parseManualStockAdditionImport(stale, source)
    expect(staleResult.rows.some((entry) => /stale or mismatched/i.test(entry.message))).toBe(true)

    const variantOnly = new ExcelJS.Workbook()
    const variantSheet = variantOnly.addWorksheet('Manual Stock Addition')
    variantSheet.addRow(['Variant ID', 'Add Quantity'])
    variantSheet.addRow(['v-1', 3])
    const variantResult = await parseManualStockAdditionImport(variantOnly, source)
    expect(variantResult.failed).toBe(1)
    expect(variantResult.rows[0].message).toMatch(/Missing column: Stock Configuration ID|Variant-only/i)
  })

  it('rejects Legacy/Unclassified import rows even if present in a workbook', async () => {
    const source = [row({
      rowKey: catalogRowKey('v-1', 'c-legacy'),
      stockConfigId: 'c-legacy',
      configCode: 'UNCLASSIFIED',
      configLabel: 'Legacy / Unclassified',
      stockSku: 'HAZ-LEGACY',
      volumeMl: null,
      packaging: null,
    })]
    // Force source into parser map even though selectable filter excludes it from UI catalog.
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Manual Stock Addition')
    sheet.addRow([...MANUAL_STOCK_ADDITION_EXCEL_HEADERS])
    sheet.addRow(['c-legacy', 'HAZ-LEGACY', 'v-1', 'Cellera', 'Cellera Hazelnut', 'Cellera Hazelnut [Hazelnut]', '[Hazelnut]', 'CEL-001', null, 'Legacy / Unclassified', 10, 3, 10, null])
    const result = await parseManualStockAdditionImport(workbook, source)
    expect(result.rows.some((entry) => /Legacy\/Unclassified/i.test(entry.message))).toBe(true)
  })
})
