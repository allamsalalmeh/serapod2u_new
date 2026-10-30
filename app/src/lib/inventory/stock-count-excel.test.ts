import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import {
  STOCK_COUNT_EXCEL_HEADERS,
  buildStockCountWorksheet,
  extractFlavour,
  parseStockCountWorksheet,
  type StockCountExcelRow,
  CLASSIFICATION_EXCEL_HEADERS,
  buildClassificationWorksheet,
  parseClassificationWorksheet,
  type ClassificationExcelRow,
  formatPackagingVersion,
} from './stock-count-excel'

const sourceRows: StockCountExcelRow[] = [
  {
    stockConfigId: 'config-20nb', stockSku: 'SKU-001-20NB', variantId: 'variant-1',
    volumeMl: 20, packagingVersion: 'new_box', groupName: 'Cartridge',
    variantName: 'Deluxe Cellera Cartridge [ Banana Milk ]', productName: 'Cellera Hero',
    productCode: '00123', systemQuantity: 3997, physicalCount: '', note: '',
  },
  {
    stockConfigId: 'config-50nb', stockSku: 'SKU-001-50NB', variantId: 'variant-1',
    volumeMl: 50, packagingVersion: 'new_box', groupName: 'Cartridge',
    variantName: 'Deluxe Cellera Cartridge [ Banana Milk ]', productName: 'Cellera Hero',
    productCode: '00123', systemQuantity: 12, physicalCount: '', note: '',
  },
]

const targets = () => sourceRows.map((row) => ({
  stockConfigId: row.stockConfigId,
  variantId: row.variantId,
  stockSku: row.stockSku,
  physicalCount: row.physicalCount,
  note: row.note,
}))

describe('Stock Count Excel', () => {
  it('extracts and trims bracketed Flavour without changing the Variant Name', () => {
    const variantName = 'Deluxe Cellera Cartridge [ Banana Milk ]'
    expect(extractFlavour(variantName)).toBe('[Banana Milk]')
    expect(variantName).toBe('Deluxe Cellera Cartridge [ Banana Milk ]')
    expect(extractFlavour('Variant without square brackets')).toBe('')
  })

  it('exports configuration identity, stock unit context, and dimensions in the exact A-P order', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildStockCountWorksheet(workbook, sourceRows)

    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual([...STOCK_COUNT_EXCEL_HEADERS])
    expect(sheet.getCell('A2').value).toBe('config-20nb')
    expect(sheet.getCell('B2').value).toBe('SKU-001-20NB')
    expect(sheet.getCell('C2').value).toBe('variant-1')
    expect(sheet.getCell('D2').value).toBe(20)
    expect(sheet.getCell('E2').value).toBe('New Box')
    expect(sheet.getCell('J2').value).toBe('00123')
    expect(sheet.getColumn(10).numFmt).toBe('@')
    expect(sheet.autoFilter).toEqual({ from: 'A1', to: 'P1' })
  })

  it('states the stock unit and piece equivalent without rescaling the balance', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildStockCountWorksheet(workbook, [
      { ...sourceRows[0], stockUnit: 'cases', unitsPerCase: 4, systemQuantity: 3861 },
      { ...sourceRows[1], stockUnit: 'pcs', unitsPerCase: 1, systemQuantity: 140 },
    ])

    // Case-stocked row: 3,861 stays 3,861 cases; the pcs figure is secondary.
    expect(sheet.getCell('K2').value).toBe('Cases')
    expect(sheet.getCell('L2').value).toBe(4)
    expect(sheet.getCell('M2').value).toBe(3861)
    expect(sheet.getCell('N2').value).toBe(15444)

    // Piece-stocked row: unit is pcs and the equivalent is the same number.
    expect(sheet.getCell('K3').value).toBe('Pcs')
    expect(sheet.getCell('L3').value).toBe(1)
    expect(sheet.getCell('M3').value).toBe(140)
    expect(sheet.getCell('N3').value).toBe(140)
  })

  it('defaults an unlabelled row to pieces so no pack size is ever applied', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildStockCountWorksheet(workbook, sourceRows)

    expect(sheet.getCell('K2').value).toBe('Pcs')
    expect(sheet.getCell('L2').value).toBe(1)
    expect(sheet.getCell('M2').value).toBe(3997)
    expect(sheet.getCell('N2').value).toBe(3997)
  })

  it('matches two rows for one flavour independently by Stock Configuration ID', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildStockCountWorksheet(workbook, sourceRows)
    sheet.getCell('O2').value = 25
    sheet.getCell('P2').value = '20ml shelf'
    sheet.getCell('O3').value = 8
    sheet.getCell('P3').value = '50ml shelf'

    const result = parseStockCountWorksheet(sheet, targets())
    expect(result.patches.get('config-20nb')).toEqual({ physicalCount: '25', note: '20ml shelf' })
    expect(result.patches.get('config-50nb')).toEqual({ physicalCount: '8', note: '50ml shelf' })
    expect(result.updated).toBe(2)
  })

  it('merges a partial import without clearing counts saved by earlier imports', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildStockCountWorksheet(workbook, sourceRows)
    const existingTargets = targets().map(target =>
      target.stockConfigId === 'config-20nb'
        ? { ...target, physicalCount: '17', note: 'counted yesterday' }
        : target)
    sheet.getCell('O2').value = null
    sheet.getCell('P2').value = null
    sheet.getCell('O3').value = 0

    const result = parseStockCountWorksheet(sheet, existingTargets)

    expect(result.patches.has('config-20nb')).toBe(false)
    expect(result.rows[0].message).toContain('did not replace the saved count')
    expect(result.patches.get('config-50nb')).toEqual({ physicalCount: '0', note: '' })
  })

  it('binds an Opening Balance workbook to its Product Category', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildStockCountWorksheet(workbook, sourceRows, {
      warehouseId: 'warehouse-1',
      sessionId: 'session-1',
      countType: 'opening_balance_cutoff',
      categoryId: 'category-vape',
    })

    expect(() => parseStockCountWorksheet(sheet, targets(), {
      warehouseId: 'warehouse-1',
      sessionId: 'session-1',
      countType: 'opening_balance_cutoff',
      categoryId: 'category-pet-food',
    })).toThrow('different Product Category')
  })

  it('rejects old variant-only templates with a clear compatibility message', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Old Stock Count')
    sheet.addRow(['Variant ID', 'SKU', 'System Quantity', 'Physical Count', 'Note'])
    sheet.addRow(['variant-1', 'SKU-001', 10, 9, 'Legacy'])

    expect(() => parseStockCountWorksheet(sheet, targets())).toThrow(
      'This Stock Count file uses an older template and cannot be imported. Export a new configuration-aware template and copy the physical counts into it.',
    )
  })

  it('still imports a template exported before the Stock Unit columns existed', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Stock Count')
    // The previous 13-column layout: identification, System Quantity, Physical
    // Count, Note — no Stock Unit / Units per Case / System Qty (Pcs).
    sheet.addRow([
      'Stock Configuration ID', 'Stock SKU', 'Variant ID', 'Volume (ml)', 'Packaging Version',
      'Product Group/Brand', 'Variant Name', 'Product Name', 'Flavour', 'Product Code',
      'System Quantity', 'Physical Count', 'Note',
    ])
    sheet.addRow([
      'config-20nb', 'SKU-001-20NB', 'variant-1', 20, 'New Box', 'Cartridge',
      'Deluxe Cellera Cartridge [ Banana Milk ]', 'Cellera Hero', '[Banana Milk]', '00123',
      3997, 25, 'old template',
    ])

    const result = parseStockCountWorksheet(sheet, targets())
    expect(result.failed).toBe(0)
    expect(result.patches.get('config-20nb')).toEqual({ physicalCount: '25', note: 'old template' })
  })

  it('does not silently accept a mismatched Variant ID', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildStockCountWorksheet(workbook, sourceRows)
    sheet.getCell('C2').value = 'different-variant'

    const result = parseStockCountWorksheet(sheet, targets())
    expect(result.rows[0]).toMatchObject({ status: 'Failed', message: 'Variant ID does not match the Stock Configuration ID.' })
    expect(result.patches.has('config-20nb')).toBe(false)
  })

  it('rejects duplicate configuration IDs even when Variant IDs are identical', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildStockCountWorksheet(workbook, sourceRows)
    sheet.getCell('A3').value = 'config-20nb'

    const result = parseStockCountWorksheet(sheet, targets())
    expect(result.rows[1]).toMatchObject({ status: 'Failed', message: 'Duplicate Stock Configuration ID in import file.' })
  })

  it('round trips configuration IDs, leading-zero product codes, and count fields', async () => {
    const exported = new ExcelJS.Workbook()
    buildStockCountWorksheet(exported, sourceRows)
    const buffer = await exported.xlsx.writeBuffer()
    const imported = new ExcelJS.Workbook()
    await imported.xlsx.load(buffer)
    const sheet = imported.worksheets[0]

    expect(sheet.getCell('A2').text).toBe('config-20nb')
    expect(sheet.getCell('J2').text).toBe('00123')
    sheet.getCell('O2').value = 3998
    sheet.getCell('P2').value = 'Round trip'

    const result = parseStockCountWorksheet(sheet, targets())
    expect(result.patches.get('config-20nb')).toEqual({ physicalCount: '3998', note: 'Round trip' })
  })
})

const identity = {
  groupName: 'Cellera', productName: 'Cellera Hero',
  variantName: 'Deluxe Cellera Cartridge [ Banana Milk ]', productCode: '00123',
}

const classificationRows: ClassificationExcelRow[] = [
  {
    stockConfigId: 'config-unc', stockSku: 'SKU-001-UNC', variantId: 'variant-1', ...identity,
    volumeMl: null, packagingVersion: null, lifecycle: 'Unclassified (pending stock take)',
    isLegacy: true, legacySystemQuantity: 100, physicalCount: '0', classifiedTotal: 100, variance: 0,
  },
  {
    stockConfigId: 'config-20nb', stockSku: 'SKU-001-20NB', variantId: 'variant-1', ...identity,
    volumeMl: 20, packagingVersion: 'new_box', lifecycle: '20ml · New Box',
    isLegacy: false, legacySystemQuantity: 100, physicalCount: '40', classifiedTotal: 100, variance: 0,
  },
  {
    stockConfigId: 'config-50nb', stockSku: 'SKU-001-50NB', variantId: 'variant-1', ...identity,
    volumeMl: 50, packagingVersion: 'new_box', lifecycle: '50ml · New Box',
    // Zero-balance target row: never had a movement at this warehouse yet.
    isLegacy: false, legacySystemQuantity: 100, physicalCount: '', classifiedTotal: 100, variance: 0,
  },
  {
    stockConfigId: 'config-50ob', stockSku: 'SKU-001-50OB', variantId: 'variant-1', ...identity,
    volumeMl: 50, packagingVersion: 'old_box', lifecycle: '50ml · Old Box',
    isLegacy: false, legacySystemQuantity: 100, physicalCount: '25', classifiedTotal: 100, variance: 0,
  },
]

const classificationTargets = () => classificationRows.map((row) => ({
  stockConfigId: row.stockConfigId,
  stockSku: row.stockSku,
  variantId: row.variantId,
  groupName: row.groupName,
  productName: row.productName,
  variantName: row.variantName,
  productCode: row.productCode,
  volumeMl: row.volumeMl,
  packagingVersion: row.packagingVersion,
  lifecycle: row.lifecycle,
  isLegacy: row.isLegacy,
  legacySystemQuantity: row.legacySystemQuantity,
  physicalCount: row.physicalCount,
}))

// New column layout (1-indexed): A ConfigID, B SKU, C VariantID, D Group/Brand,
// E ProductName, F VariantName, G Flavour, H ProductCode, I Volume, J Packaging,
// K Lifecycle, L RowType, M LegacyQty, N Physical, O ClassificationTotal,
// P Variance, Q Reference.
const summaryResult = (cell: ExcelJS.Cell): unknown => {
  const value = cell.value as { formula?: string; result?: unknown } | null
  if (value && typeof value === 'object' && 'formula' in value) {
    // ExcelJS omits a cached `result` of 0; Excel recalculates on open.
    return 'result' in value ? value.result : 0
  }
  return value
}

describe('Initial Configuration Classification Excel', () => {
  it('exports human-readable identification columns near the left', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildClassificationWorksheet(workbook, classificationRows)

    const headers = (sheet.getRow(1).values as unknown[]).slice(1)
    expect(headers).toEqual([...CLASSIFICATION_EXCEL_HEADERS])
    expect(headers.length).toBe(17)
    // Product / Variant / Flavour descriptors appear before the technical
    // dimensions so a user never identifies a group by UUID.
    expect(headers.slice(3, 8)).toEqual([
      'Product Group/Brand', 'Product Name', 'Variant Name', 'Flavour', 'Product Code',
    ])

    // Legacy row (row 2) carries the same identity descriptors as its targets.
    expect(sheet.getCell('D2').value).toBe('Cellera')
    expect(sheet.getCell('E2').value).toBe('Cellera Hero')
    expect(sheet.getCell('F2').value).toBe('Deluxe Cellera Cartridge [ Banana Milk ]')
    expect(sheet.getCell('G2').value).toBe('[Banana Milk]')
    expect(sheet.getCell('H2').value).toBe('00123')
    // Product Code column keeps a leading-zero-safe text format.
    expect(sheet.getColumn(8).numFmt).toBe('@')
  })

  it('exports the Legacy row with "Legacy / Unclassified" packaging version and read-only row type', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildClassificationWorksheet(workbook, classificationRows)

    // Legacy row: row 2
    expect(sheet.getCell('A2').value).toBe('config-unc')
    // Packaging version (col J = 10) is "Legacy / Unclassified" (not blank, not "Standard")
    expect(sheet.getCell('J2').value).toBe('Legacy / Unclassified')
    // Row Type column (col L = 12)
    expect(sheet.getCell('L2').value).toBe('Legacy Source — Read Only')
    // Physical Count (col N = 14) shows "Do not enter"
    expect(sheet.getCell('N2').value).toBe('Do not enter')
    // Legacy row is greyed out
    expect(sheet.getCell('A2').fill).toBeDefined()
    // Volume (col I = 9) for legacy row is null
    expect(sheet.getCell('I2').value).toBeNull()
  })

  it('exports target rows with "Target Configuration" row type', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildClassificationWorksheet(workbook, classificationRows)

    // 20NB target row: row 3 (after legacy row 2)
    expect(sheet.getCell('A3').value).toBe('config-20nb')
    expect(sheet.getCell('J3').value).toBe('New Box')
    expect(sheet.getCell('L3').value).toBe('Target Configuration')
    expect(sheet.getCell('I3').value).toBe(20)

    // 50NB zero-balance target: row 4
    expect(sheet.getCell('A4').value).toBe('config-50nb')
    expect(sheet.getCell('L4').value).toBe('Target Configuration')
    expect(sheet.getCell('N4').value).toBeNull() // blank physical count
  })

  it('freezes the header row and the identification columns', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildClassificationWorksheet(workbook, classificationRows)
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', xSplit: 8, ySplit: 1 })
    expect(sheet.autoFilter).toEqual({ from: 'A1', to: 'Q1' })
  })

  it('protects everything except the target Physical Count cells', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildClassificationWorksheet(workbook, classificationRows)

    // Sheet-level protection is enabled.
    expect((sheet as any).sheetProtection?.sheet).toBe(true)
    // Target Physical Count cells (col N = 14) are the only editable cells.
    expect(sheet.getCell('N3').protection).toMatchObject({ locked: false })
    expect(sheet.getCell('N5').protection).toMatchObject({ locked: false })
    // Legacy Physical Count and identity/summary cells stay locked.
    expect(sheet.getCell('N2').protection).toMatchObject({ locked: true })
    expect(sheet.getCell('A3').protection?.locked).not.toBe(false)
    expect(sheet.getCell('E3').protection?.locked).not.toBe(false)
  })

  it('includes a per-variant classification summary row with live formulas', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildClassificationWorksheet(workbook, classificationRows)

    // Row 2: legacy, Row 3: 20NB, Row 4: 50NB, Row 5: 50OB, Row 6: summary
    const summaryRow = sheet.getRow(6)
    // Summary has no Stock Configuration ID
    expect(summaryRow.getCell(1).value).toBeNull()
    // Legacy System Quantity (col M = 13)
    expect(summaryRow.getCell(13).value).toBe(100)
    // Total Target Physical Count (col N = 14) — formula summing the target rows
    expect((summaryRow.getCell(14).value as { formula?: string }).formula).toBe('SUM(N3:N5)')
    expect(summaryResult(summaryRow.getCell(14))).toBe(65) // 40 + 0 + 25
    // Classification Total (col O = 15)
    expect(summaryResult(summaryRow.getCell(15))).toBe(65)
    // Variance (col P = 16) — formula: total − legacy
    expect((summaryRow.getCell(16).value as { formula?: string }).formula).toBe('O6-M6')
    expect(summaryResult(summaryRow.getCell(16))).toBe(-35)
    // Completion Status (col L = 12)
    expect(summaryRow.getCell(12).value).toBe('Incomplete')
    // Summary row has the yellow fill and bold font
    expect(summaryRow.getCell(13).fill).toBeDefined()
    expect(summaryRow.font?.bold).toBe(true)
  })

  it('shows "Complete" in summary when all targets have physical counts', () => {
    const completeRows: ClassificationExcelRow[] = classificationRows.map((row) =>
      row.stockConfigId === 'config-50nb' ? { ...row, physicalCount: '35' } : row,
    )

    const workbook = new ExcelJS.Workbook()
    const sheet = buildClassificationWorksheet(workbook, completeRows)

    // Row 6 should be the summary row (legacy + 3 targets = 4 data rows, then summary)
    const summaryRow = sheet.getRow(6)
    expect(summaryRow.getCell(12).value).toBe('Complete')
    expect(summaryResult(summaryRow.getCell(14))).toBe(100) // 40 + 35 + 25
    expect(summaryResult(summaryRow.getCell(16))).toBe(0) // variance = 100 - 100
  })

  it('never renders "Standard" for any packaging version — only "Legacy / Unclassified" or actual box types', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildClassificationWorksheet(workbook, classificationRows)

    // Check every row that has non-null packaging version (col J = 10)
    for (let rowNum = 2; rowNum <= 5; rowNum++) {
      const packaging = sheet.getCell(rowNum, 10).value
      if (packaging !== null && packaging !== undefined) {
        expect(String(packaging)).not.toBe('Standard')
      }
    }
  })

  it('rejects an older template missing Stock Configuration ID', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Old Template')
    sheet.addRow(['Variant ID', 'Physical Count'])
    sheet.addRow(['variant-1', '40'])

    expect(() => parseClassificationWorksheet(sheet, classificationTargets())).toThrow(
      'This Initial Configuration Classification file uses an older template and cannot be imported. Export a new template and copy the physical counts into it.',
    )
  })

  it('identifies a standard Stock Count workbook with actionable mode guidance', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildStockCountWorksheet(workbook, sourceRows)

    expect(() => parseClassificationWorksheet(sheet, classificationTargets())).toThrow(
      'This is a standard Stock Count workbook, not an Initial Configuration Classification workbook. '
      + 'To load it as a regular stock count, change Count Type to Full Count, Cycle Count, or Spot Check before importing. '
      + 'To reclassify Legacy / Unclassified stock, download a fresh Initial Configuration Classification template for the selected inventory organization.',
    )
  })

  it('rejects duplicate Configuration IDs', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildClassificationWorksheet(workbook, classificationRows)
    sheet.getCell('A3').value = 'config-unc'

    const result = parseClassificationWorksheet(sheet, classificationTargets())
    expect(result.rows.find((row) => row.row === 3)).toMatchObject({ status: 'Failed', message: 'Duplicate Stock Configuration ID in import file.' })
  })

  it.each([
    ['Stock SKU', 'B3', 'TAMPERED-SKU'],
    ['Product Name', 'E3', 'Different Product'],
    ['Flavour', 'G3', '[Different Flavour]'],
    ['Volume (ml)', 'I3', 99],
    ['Legacy System Quantity', 'M3', 999],
  ])('rejects a modified protected %s field', (field, cell, value) => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildClassificationWorksheet(workbook, classificationRows)
    sheet.getCell(cell).value = value

    const result = parseClassificationWorksheet(sheet, classificationTargets())
    expect(result.rows.find((row) => row.row === 3)).toMatchObject({
      status: 'Failed',
      message: `Protected identity field "${field}" was modified. Export a fresh template and enter values only in Physical Count.`,
    })
    expect(result.patches.has('config-20nb')).toBe(false)
  })

  it('rejects modified Variant ID and Classification Reference fields', () => {
    const variantWorkbook = new ExcelJS.Workbook()
    const variantSheet = buildClassificationWorksheet(variantWorkbook, classificationRows)
    variantSheet.getCell('C3').value = 'different-variant'
    expect(parseClassificationWorksheet(variantSheet, classificationTargets()).rows.find(row => row.row === 3)).toMatchObject({
      status: 'Failed',
      message: 'Variant ID does not match the Stock Configuration ID.',
    })

    const referenceWorkbook = new ExcelJS.Workbook()
    const referenceSheet = buildClassificationWorksheet(referenceWorkbook, classificationRows)
    referenceSheet.getCell('Q3').value = ''
    expect(parseClassificationWorksheet(referenceSheet, classificationTargets()).rows.find(row => row.row === 3)).toMatchObject({
      status: 'Failed',
      message: 'Classification Reference does not match this row\'s Variant ID.',
    })
  })

  it('rejects duplicate required headers and an incomplete target batch', () => {
    const duplicateWorkbook = new ExcelJS.Workbook()
    const duplicateSheet = buildClassificationWorksheet(duplicateWorkbook, classificationRows)
    duplicateSheet.getCell('Q1').value = 'Variant ID'
    expect(() => parseClassificationWorksheet(duplicateSheet, classificationTargets())).toThrow('Duplicate required header(s): Variant ID.')

    const incompleteWorkbook = new ExcelJS.Workbook()
    const incompleteSheet = buildClassificationWorksheet(incompleteWorkbook, classificationRows)
    incompleteSheet.spliceRows(4, 1)
    const result = parseClassificationWorksheet(incompleteSheet, classificationTargets())
    expect(result.rows).toContainEqual(expect.objectContaining({
      row: 0,
      status: 'Failed',
      message: 'Incomplete classification batch: 1 of 3 target configuration(s) for this variant are missing from the import file.',
    }))
  })

  it('rejects a nonzero Physical Count typed into the Legacy/Unclassified row', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildClassificationWorksheet(workbook, classificationRows)
    // The legacy row exports "Do not enter", but someone might type 15
    sheet.getCell('N2').value = 15

    const result = parseClassificationWorksheet(sheet, classificationTargets())
    expect(result.rows.find((row) => row.row === 2)).toMatchObject({
      status: 'Failed',
      message: 'The Legacy/Unclassified row is read-only and cannot be used as a target classification. Leave its Physical Count blank, 0, or "Do not enter".',
    })
  })

  it('accepts "Do not enter" label in legacy row physical count without treating it as a target', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildClassificationWorksheet(workbook, classificationRows)
    // Legacy row already exports "Do not enter" — verify import accepts it
    const result = parseClassificationWorksheet(sheet, classificationTargets())
    expect(result.rows.find((row) => row.row === 2)).toMatchObject({ status: 'Unchanged' })
    expect(result.patches.has('config-unc')).toBe(false)
  })

  it('imports the zero-balance target row and updates the draft', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildClassificationWorksheet(workbook, classificationRows)
    sheet.getCell('N4').value = 35

    const result = parseClassificationWorksheet(sheet, classificationTargets())
    expect(result.patches.get('config-50nb')).toEqual({ physicalCount: '35' })
    expect(result.updated).toBeGreaterThan(0)
  })

  it('skips summary rows (no Stock Config ID) during import', () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = buildClassificationWorksheet(workbook, classificationRows)
    // Modify a target count to test update
    sheet.getCell('N3').value = 50
    // The summary row (row 6) has no config ID — should be skipped silently

    const result = parseClassificationWorksheet(sheet, classificationTargets())
    expect(result.patches.get('config-20nb')).toEqual({ physicalCount: '50' })
    // No errors from the summary row
    expect(result.rows.filter((r) => r.status === 'Failed').length).toBe(0)
  })

  it('round trips classification data through Excel binary', async () => {
    const workbook = new ExcelJS.Workbook()
    buildClassificationWorksheet(workbook, classificationRows)
    const buffer = await workbook.xlsx.writeBuffer()
    const imported = new ExcelJS.Workbook()
    await imported.xlsx.load(buffer)
    const sheet = imported.worksheets[0]

    // Verify round-trip fidelity (identity descriptors + config columns)
    expect(sheet.getCell('A2').text).toBe('config-unc')
    expect(sheet.getCell('E2').text).toBe('Cellera Hero')
    expect(sheet.getCell('G2').text).toBe('[Banana Milk]')
    expect(sheet.getCell('J2').text).toBe('Legacy / Unclassified')
    expect(sheet.getCell('L2').text).toBe('Legacy Source — Read Only')
    expect(sheet.getCell('N2').text).toBe('Do not enter')
    expect(sheet.getCell('A3').text).toBe('config-20nb')
    expect(sheet.getCell('L3').text).toBe('Target Configuration')

    // Summary row
    expect(sheet.getCell('A6').text).toBe('')
    expect(sheet.getCell('L6').text).toBe('Incomplete')
    // Sheet protection survives the binary round trip.
    expect((sheet as any).sheetProtection?.sheet).toBe(true)

    // Can still import from round-tripped file
    const result = parseClassificationWorksheet(sheet, classificationTargets())
    expect(result.updated).toBe(0)
    expect(result.failed).toBe(0)
  })

  describe('formatPackagingVersion', () => {
    it('returns "Legacy / Unclassified" for null packaging (legacy row)', () => {
      expect(formatPackagingVersion(null)).toBe('Legacy / Unclassified')
    })

    it('returns "New Box" for new_box packaging', () => {
      expect(formatPackagingVersion('new_box')).toBe('New Box')
    })

    it('returns "Old Box" for old_box packaging', () => {
      expect(formatPackagingVersion('old_box')).toBe('Old Box')
    })

    it('returns "Legacy / Unclassified" for empty string (legacy row)', () => {
      expect(formatPackagingVersion('')).toBe('Legacy / Unclassified')
    })
  })
})
