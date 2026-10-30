import type ExcelJS from 'exceljs'
import { stockUnitDisplayLabel } from './stock-count-quantity'

const STOCK_COUNT_METADATA_SHEET = '_Serapod2U_Metadata'

export interface StockCountWorkbookContext {
  warehouseId: string
  sessionId: string
  countType: string
  categoryId?: string
}

export const STOCK_COUNT_EXCEL_HEADERS = [
  'Stock Configuration ID',
  'Stock SKU',
  'Variant ID',
  'Volume (ml)',
  'Packaging Version',
  'Product Group/Brand',
  'Variant Name',
  'Product Name',
  'Flavour',
  'Product Code',
  // Unit context. The balance is integer CASES for cartridge products and
  // integer PIECES for everything else, so the worksheet states which unit
  // "System Quantity" and "Physical Count" are expressed in — a case figure is
  // never silently multiplied by the pack size.
  'Stock Unit',
  'Units per Case',
  'System Quantity',
  'System Qty (Pcs)',
  'Physical Count',
  'Note',
] as const

const REQUIRED_IMPORT_HEADERS = [
  'Stock Configuration ID',
  'Variant ID',
  'Physical Count',
  'Note',
] as const

export interface StockCountExcelRow {
  stockConfigId: string
  stockSku: string
  variantId: string
  volumeMl: number | null
  packagingVersion: string | null
  groupName: string
  variantName: string
  productName: string
  productCode: string | null
  /** Unit `systemQuantity` and the entered physical count are expressed in. */
  stockUnit?: 'cases' | 'pcs'
  /** Pieces in one stock case. Only meaningful when `stockUnit` is 'cases'. */
  unitsPerCase?: number
  systemQuantity: number
  physicalCount: string
  note: string
}

export interface StockCountImportTarget {
  stockConfigId: string
  variantId: string
  stockSku: string
  physicalCount: string
  note: string
}

export interface StockCountImportResult {
  updated: number
  unchanged: number
  failed: number
  patches: Map<string, { physicalCount: string; note: string }>
  rows: Array<{
    row: number
    sku: string
    status: 'Updated' | 'Unchanged' | 'Failed'
    message: string
  }>
}

export function extractFlavour(variantName: string): string {
  const match = variantName.match(/\[([^\]]*)\]/)
  const flavour = match?.[1].trim()
  return flavour ? `[${flavour}]` : ''
}

export function formatPackagingVersion(packaging: string | null): string {
  if (packaging === 'new_box') return 'New Box'
  if (packaging === 'old_box') return 'Old Box'
  // When packaging is null this is the Legacy/Unclassified source row —
  // never render it as "Standard" which implied it was a target summary.
  return packaging || 'Legacy / Unclassified'
}

export function buildStockCountWorksheet(
  workbook: ExcelJS.Workbook,
  rows: StockCountExcelRow[],
  context?: StockCountWorkbookContext,
): ExcelJS.Worksheet {
  const worksheet = workbook.addWorksheet('Stock Count')
  worksheet.addRow([...STOCK_COUNT_EXCEL_HEADERS])

  rows.forEach((row) => {
    const stockUnit = row.stockUnit ?? 'pcs'
    const unitsPerCase = stockUnit === 'cases' && row.unitsPerCase && row.unitsPerCase > 0
      ? row.unitsPerCase
      : 1
    worksheet.addRow([
      row.stockConfigId,
      row.stockSku,
      row.variantId,
      row.volumeMl,
      formatPackagingVersion(row.packagingVersion),
      row.groupName,
      row.variantName,
      row.productName,
      extractFlavour(row.variantName) || null,
      row.productCode || null,
      stockUnitDisplayLabel(stockUnit),
      unitsPerCase,
      row.systemQuantity,
      // Display-only piece equivalent so a case balance is never misread as pcs.
      stockUnit === 'cases' ? row.systemQuantity * unitsPerCase : row.systemQuantity,
      row.physicalCount.trim() === '' ? null : Number(row.physicalCount),
      row.note || null,
    ])
  })

  worksheet.columns = [
    { width: 38 }, { width: 24 }, { width: 38 }, { width: 14 },
    { width: 20 }, { width: 24 }, { width: 42 }, { width: 34 },
    { width: 24 }, { width: 18 }, { width: 14 }, { width: 15 },
    { width: 18 }, { width: 18 }, { width: 18 }, { width: 34 },
  ]
  worksheet.views = [{ state: 'frozen', ySplit: 1 }]
  worksheet.autoFilter = { from: 'A1', to: 'P1' }

  const header = worksheet.getRow(1)
  header.height = 24
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF97316' } }
  header.alignment = { vertical: 'middle', horizontal: 'center' }
  header.eachCell((cell) => {
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFC2410C' } } }
  })
  // Physical Count is entered in the row's Stock Unit (column K). Say so in
  // place instead of leaving the unit to be guessed from another column.
  worksheet.getCell('O1').note = 'Enter the physical count in the Stock Unit shown in column K (Cases or Pcs). A case count is never converted to pieces.'

  for (const column of [1, 2, 3, 10]) worksheet.getColumn(column).numFmt = '@'
  worksheet.getColumn(4).numFmt = '0'
  worksheet.getColumn(12).numFmt = '0'
  for (const column of [13, 14, 15]) worksheet.getColumn(column).numFmt = '#,##0'

  if (context) {
    const metadata = workbook.addWorksheet(STOCK_COUNT_METADATA_SHEET)
    metadata.addRows([
      ['format', 'serapod2u-stock-count-v2'],
      ['warehouse_id', context.warehouseId],
      ['session_id', context.sessionId],
      ['count_type', context.countType],
      ['category_id', context.categoryId || ''],
    ])
    metadata.state = 'veryHidden'
  }

  return worksheet
}

const normalizeHeader = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()

function resolveImportHeaders(sheet: ExcelJS.Worksheet): Map<string, number> {
  const indexes = new Map<string, number[]>()
  const headerRow = sheet.getRow(1)

  for (let column = 1; column <= sheet.columnCount; column += 1) {
    const normalized = normalizeHeader(headerRow.getCell(column).text)
    if (!normalized) continue
    indexes.set(normalized, [...(indexes.get(normalized) || []), column])
  }

  const missing = REQUIRED_IMPORT_HEADERS.filter((header) => !indexes.has(normalizeHeader(header)))
  const duplicates = REQUIRED_IMPORT_HEADERS.filter((header) => (indexes.get(normalizeHeader(header))?.length || 0) > 1)

  if (missing.includes('Stock Configuration ID')) {
    throw new Error('This Stock Count file uses an older template and cannot be imported. Export a new configuration-aware template and copy the physical counts into it.')
  }
  if (missing.length || duplicates.length) {
    const details = [
      missing.length ? `Missing required header(s): ${missing.join(', ')}.` : '',
      duplicates.length ? `Duplicate required header(s): ${duplicates.join(', ')}.` : '',
    ].filter(Boolean).join(' ')
    throw new Error(`Invalid Stock Count Excel headers. ${details}`)
  }

  return new Map(Array.from(indexes.entries()).map(([name, columns]) => [name, columns[0]]))
}

export function parseStockCountWorksheet(
  sheet: ExcelJS.Worksheet,
  targets: StockCountImportTarget[],
  expectedContext?: StockCountWorkbookContext,
): StockCountImportResult {
  if (expectedContext) {
    const metadata = sheet.workbook.getWorksheet(STOCK_COUNT_METADATA_SHEET)
    if (!metadata) {
      throw new Error('This Opening Balance workbook has no session identity. Download a fresh template from the selected Opening Balance draft.')
    }
    const values = new Map<string, string>()
    metadata.eachRow((row) => {
      const key = row.getCell(1).text.trim()
      if (key) values.set(key, row.getCell(2).text.trim())
    })
    if (values.get('format') !== 'serapod2u-stock-count-v2') {
      throw new Error('This Opening Balance workbook uses an unsupported template version. Download a fresh template.')
    }
    if (values.get('warehouse_id') !== expectedContext.warehouseId) {
      throw new Error('This template belongs to a different warehouse and cannot update the selected Opening Balance draft.')
    }
    if (values.get('session_id') !== expectedContext.sessionId) {
      throw new Error('This template belongs to a different Stock Count session and cannot update the selected draft.')
    }
    if (values.get('count_type') !== expectedContext.countType) {
      throw new Error('This template belongs to a different Stock Count type and cannot update the selected draft.')
    }
    if ((values.get('category_id') || '') !== (expectedContext.categoryId || '')) {
      throw new Error('This template belongs to a different Product Category and cannot update the selected Opening Balance draft.')
    }
  }
  const headers = resolveImportHeaders(sheet)
  const column = (name: string) => headers.get(normalizeHeader(name))!
  const stockConfigIdColumn = column('Stock Configuration ID')
  const variantIdColumn = column('Variant ID')
  const physicalCountColumn = column('Physical Count')
  const noteColumn = column('Note')
  const stockSkuColumn = headers.get(normalizeHeader('Stock SKU'))
  const byConfig = new Map(targets.map((target) => [target.stockConfigId, target]))
  const seenConfigIds = new Set<string>()
  const patches = new Map<string, { physicalCount: string; note: string }>()
  const results: StockCountImportResult['rows'] = []
  let updated = 0
  let unchanged = 0

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return

    const stockConfigId = row.getCell(stockConfigIdColumn).text.trim()
    const variantId = row.getCell(variantIdColumn).text.trim()
    const sku = stockSkuColumn ? row.getCell(stockSkuColumn).text.trim() : ''
    const matched = byConfig.get(stockConfigId)

    if (!stockConfigId || !matched) {
      results.push({ row: rowNumber, sku: sku || stockConfigId || '-', status: 'Failed', message: 'Unknown or missing Stock Configuration ID.' })
      return
    }
    if (!variantId || variantId !== matched.variantId) {
      results.push({ row: rowNumber, sku: sku || matched.stockSku, status: 'Failed', message: 'Variant ID does not match the Stock Configuration ID.' })
      return
    }
    if (seenConfigIds.has(stockConfigId)) {
      results.push({ row: rowNumber, sku: sku || matched.stockSku, status: 'Failed', message: 'Duplicate Stock Configuration ID in import file.' })
      return
    }
    seenConfigIds.add(stockConfigId)

    const physicalValue = row.getCell(physicalCountColumn).value
    const physicalString = physicalValue === null || physicalValue === undefined ? '' : String(physicalValue).trim()
    const note = row.getCell(noteColumn).text.trim()

    if (physicalString !== '' && !/^\d+$/.test(physicalString)) {
      results.push({ row: rowNumber, sku: sku || matched.stockSku, status: 'Failed', message: 'Physical Count must be zero or a positive integer.' })
      return
    }

    // A blank import cell means "no update", never "replace the saved count
    // with zero/blank". This lets users import small completed subsets over
    // several days without erasing earlier work. Explicit 0 remains a count.
    const mergedPhysicalCount = physicalString === '' ? matched.physicalCount : physicalString
    const mergedNote = note === '' ? matched.note : note
    const changed = matched.physicalCount !== mergedPhysicalCount || matched.note !== mergedNote
    if (changed) {
      patches.set(matched.stockConfigId, {
        physicalCount: mergedPhysicalCount,
        note: mergedNote,
      })
    }
    if (changed) updated += 1
    else unchanged += 1
    results.push({
      row: rowNumber,
      sku: sku || matched.stockSku,
      status: changed ? 'Updated' : 'Unchanged',
      message: physicalString === ''
        ? (matched.physicalCount === '' ? 'Blank physical count remains not counted.' : 'Blank physical count did not replace the saved count.')
        : changed ? 'Loaded into draft.' : 'No change from current draft.',
    })
  })

  return { updated, unchanged, failed: results.filter((row) => row.status === 'Failed').length, patches, rows: results }
}

// ── Initial Configuration Classification ──────────────────────────────────

// Column order (1-indexed) — identification descriptors sit near the left,
// immediately after the technical IDs, so a user never has to read a UUID to
// know which flavour/product a group represents. Physical Count (the only
// editable target) sits to the right of the frozen identification block.
//   1 A  Stock Configuration ID        10 J  Packaging Version
//   2 B  Stock SKU                      11 K  Lifecycle
//   3 C  Variant ID                     12 L  Row Type / Classification Status
//   4 D  Product Group/Brand            13 M  Legacy System Quantity
//   5 E  Product Name                   14 N  Physical Count (editable target only)
//   6 F  Variant Name                   15 O  Classification Total
//   7 G  Flavour                        16 P  Variance
//   8 H  Product Code                   17 Q  Classification Reference
//   9 I  Volume (ml)
export const CLASSIFICATION_EXCEL_HEADERS = [
  'Stock Configuration ID',
  'Stock SKU',
  'Variant ID',
  'Product Group/Brand',
  'Product Name',
  'Variant Name',
  'Flavour',
  'Product Code',
  'Volume (ml)',
  'Packaging Version',
  'Lifecycle',
  'Row Type / Classification Status',
  'Legacy System Quantity',
  'Physical Count',
  'Classification Total',
  'Variance',
  'Classification Reference',
] as const

const REQUIRED_CLASSIFICATION_IMPORT_HEADERS = [
  ...CLASSIFICATION_EXCEL_HEADERS,
] as const

export interface ClassificationExcelRow {
  stockConfigId: string
  stockSku: string
  variantId: string
  /** Human-readable identity — surfaced so users never identify a group by UUID. */
  groupName: string
  productName: string
  variantName: string
  productCode: string | null
  volumeMl: number | null
  packagingVersion: string | null
  lifecycle: string
  isLegacy: boolean
  legacySystemQuantity: number
  physicalCount: string
  classifiedTotal: number
  variance: number
}

// 1-indexed column positions, referenced by both the writer and the tests.
const CLASSIFICATION_COL = {
  stockConfigId: 1,
  stockSku: 2,
  variantId: 3,
  groupName: 4,
  productName: 5,
  variantName: 6,
  flavour: 7,
  productCode: 8,
  volumeMl: 9,
  packaging: 10,
  lifecycle: 11,
  rowType: 12,
  legacyQty: 13,
  physicalCount: 14,
  classificationTotal: 15,
  variance: 16,
  reference: 17,
} as const

export interface ClassificationImportTarget {
  stockConfigId: string
  stockSku: string
  variantId: string
  groupName: string
  productName: string
  variantName: string
  productCode: string | null
  volumeMl: number | null
  packagingVersion: string | null
  lifecycle: string
  isLegacy: boolean
  legacySystemQuantity: number
  physicalCount: string
}

export interface ClassificationImportResult {
  updated: number
  unchanged: number
  failed: number
  patches: Map<string, { physicalCount: string }>
  rows: Array<{
    row: number
    sku: string
    status: 'Updated' | 'Unchanged' | 'Failed'
    message: string
  }>
}

const GREY_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFF1F5F9' } }
const SUMMARY_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FFFEF3C7' } }
const DO_NOT_ENTER_TEXT = 'Do not enter'

export function buildClassificationWorksheet(
  workbook: ExcelJS.Workbook,
  rows: ClassificationExcelRow[],
): ExcelJS.Worksheet {
  const C = CLASSIFICATION_COL
  const columnLetter = (index: number) => String.fromCharCode('A'.charCodeAt(0) + index - 1)
  workbook.calcProperties.fullCalcOnLoad = true
  const worksheet = workbook.addWorksheet('Stock Classification')
  worksheet.addRow([...CLASSIFICATION_EXCEL_HEADERS])

  // Group rows by variant so we can interleave per-variant summary rows
  const byVariant = new Map<string, ClassificationExcelRow[]>()
  for (const row of rows) {
    const list = byVariant.get(row.variantId) || []
    list.push(row)
    byVariant.set(row.variantId, list)
  }

  let currentRowNumber = 2 // header is row 1, data starts at row 2

  for (const [variantId, variantRows] of byVariant) {
    const legacyRow = variantRows.find(r => r.isLegacy)
    const targetRows = variantRows.filter(r => !r.isLegacy)
    // Identity descriptors are variant-level; take them from any row (legacy
    // rows carry the same identity as their targets).
    const identity = legacyRow || targetRows[0]
    const flavour = identity ? extractFlavour(identity.variantName) || null : null

    // ── Legacy source row ──
    if (legacyRow) {
      const rowIndex = currentRowNumber
      worksheet.addRow([
        legacyRow.stockConfigId,
        legacyRow.stockSku,
        legacyRow.variantId,
        legacyRow.groupName,
        legacyRow.productName,
        legacyRow.variantName,
        flavour,
        legacyRow.productCode || null,
        // Never surface Volume/Packaging for the Legacy row: it is
        // dimensionless, and a blank cell must never be re-interpreted as
        // 20ml on import.
        null,
        formatPackagingVersion(legacyRow.packagingVersion),
        legacyRow.lifecycle,
        'Legacy Source — Read Only',
        legacyRow.legacySystemQuantity,
        // Physical Count is always 0 for the legacy row — it's not a real
        // countable configuration. Put "Do not enter" as the label, but
        // store 0 as the actual value so the import parser ignores it.
        DO_NOT_ENTER_TEXT,
        legacyRow.classifiedTotal,
        legacyRow.variance,
        legacyRow.variantId,
      ])
      // Grey out the entire legacy row
      worksheet.getRow(rowIndex).eachCell((cell) => {
        cell.fill = GREY_FILL
      })
      // The legacy Physical Count is not an editable target: leave it locked
      // (the default) and style it as informational.
      const physicalCountCell = worksheet.getCell(rowIndex, C.physicalCount)
      physicalCountCell.protection = { locked: true }
      physicalCountCell.font = { color: { argb: 'FF9CA3AF' }, italic: true }
      currentRowNumber += 1
    }

    const firstTargetRow = currentRowNumber

    // ── Target rows ──
    for (const row of targetRows) {
      worksheet.addRow([
        row.stockConfigId,
        row.stockSku,
        row.variantId,
        row.groupName,
        row.productName,
        row.variantName,
        flavour,
        row.productCode || null,
        row.volumeMl,
        formatPackagingVersion(row.packagingVersion),
        row.lifecycle,
        'Target Configuration',
        row.legacySystemQuantity,
        row.physicalCount.trim() === '' ? null : Number(row.physicalCount),
        row.classifiedTotal,
        row.variance,
        row.variantId,
      ])
      // Only the Physical Count target cell is editable; everything else is
      // protected once the sheet lock is applied at the end.
      worksheet.getCell(currentRowNumber, C.physicalCount).protection = { locked: false }
      currentRowNumber += 1
    }

    const lastTargetRow = currentRowNumber - 1

    // ── Per-variant classification summary row ──
    const targetPhysicalTotal = targetRows.reduce(
      (sum, r) => sum + (r.physicalCount.trim() === '' ? 0 : Number(r.physicalCount)),
      0,
    )
    const allTargetsCounted = targetRows.length > 0 && targetRows.every(
      r => r.physicalCount.trim() !== '',
    )
    const classificationTotal = targetPhysicalTotal
    const legacyQty = legacyRow?.legacySystemQuantity || 0
    const variance = classificationTotal - legacyQty
    const completionStatus = allTargetsCounted ? 'Complete' : 'Incomplete'

    worksheet.addRow(new Array(CLASSIFICATION_EXCEL_HEADERS.length).fill(null))
    const summaryRow = worksheet.getRow(currentRowNumber)

    // Live Excel formulas keep the totals correct if a user edits a Physical
    // Count in Excel, while `result` mirrors the server-authoritative value for
    // non-Excel readers and the import round trip.
    const physCol = columnLetter(C.physicalCount)
    const totalCol = columnLetter(C.classificationTotal)
    const hasTargetRange = targetRows.length > 0
    const sumFormula = hasTargetRange
      ? `SUM(${physCol}${firstTargetRow}:${physCol}${lastTargetRow})`
      : null

    worksheet.getCell(currentRowNumber, C.rowType).value = completionStatus
    worksheet.getCell(currentRowNumber, C.legacyQty).value = legacyQty
    worksheet.getCell(currentRowNumber, C.physicalCount).value = sumFormula
      ? { formula: sumFormula, result: targetPhysicalTotal }
      : targetPhysicalTotal
    worksheet.getCell(currentRowNumber, C.classificationTotal).value = sumFormula
      ? { formula: sumFormula, result: classificationTotal }
      : classificationTotal
    worksheet.getCell(currentRowNumber, C.variance).value = {
      formula: `${totalCol}${currentRowNumber}-${columnLetter(C.legacyQty)}${currentRowNumber}`,
      result: variance,
    }
    worksheet.getCell(currentRowNumber, C.reference).value = variantId

    summaryRow.eachCell((cell) => { cell.fill = SUMMARY_FILL })
    summaryRow.font = { bold: true }
    currentRowNumber += 1
  }

  worksheet.columns = [
    { width: 38 }, { width: 22 }, { width: 38 }, { width: 22 },
    { width: 30 }, { width: 34 }, { width: 20 }, { width: 16 },
    { width: 12 }, { width: 20 }, { width: 22 }, { width: 26 },
    { width: 18 }, { width: 16 }, { width: 18 }, { width: 12 }, { width: 38 },
  ]
  // Freeze the header row and the identification columns (A–H) so the product,
  // variant and flavour stay visible while scrolling right to Physical Count.
  worksheet.views = [{ state: 'frozen', xSplit: C.productCode, ySplit: 1 }]
  worksheet.autoFilter = { from: 'A1', to: `${columnLetter(CLASSIFICATION_EXCEL_HEADERS.length)}1` }

  const header = worksheet.getRow(1)
  header.height = 30
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF97316' } }
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
  header.eachCell((cell) => {
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFC2410C' } } }
  })

  // Text format for IDs / codes / references so UUIDs and leading-zero product
  // codes are never coerced to numbers or scientific notation.
  for (const column of [C.stockConfigId, C.stockSku, C.variantId, C.productCode, C.reference]) {
    worksheet.getColumn(column).numFmt = '@'
  }
  worksheet.getColumn(C.volumeMl).numFmt = '0'
  for (const column of [C.legacyQty, C.physicalCount, C.classificationTotal, C.variance]) {
    worksheet.getColumn(column).numFmt = '#,##0'
  }
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    worksheet.getRow(rowNumber).alignment = { vertical: 'middle', wrapText: true }
  }

  // Protect the sheet: with an empty password every cell is locked by default;
  // only the target Physical Count cells were explicitly unlocked above, so the
  // legacy source, totals, variance, IDs and descriptors are all read-only.
  worksheet.protect('', {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatColumns: true,
    autoFilter: true,
  })

  return worksheet
}

function resolveClassificationImportHeaders(sheet: ExcelJS.Worksheet): Map<string, number> {
  const indexes = new Map<string, number[]>()
  const headerRow = sheet.getRow(1)

  for (let column = 1; column <= sheet.columnCount; column += 1) {
    const normalized = normalizeHeader(headerRow.getCell(column).text)
    if (!normalized) continue
    indexes.set(normalized, [...(indexes.get(normalized) || []), column])
  }

  const missing = REQUIRED_CLASSIFICATION_IMPORT_HEADERS.filter((header) => !indexes.has(normalizeHeader(header)))
  const duplicates = REQUIRED_CLASSIFICATION_IMPORT_HEADERS.filter(
    (header) => (indexes.get(normalizeHeader(header))?.length || 0) > 1,
  )
  const isStandardStockCountWorkbook = REQUIRED_IMPORT_HEADERS.every(
    (header) => indexes.has(normalizeHeader(header)),
  ) && !indexes.has(normalizeHeader('Classification Reference'))
  if (isStandardStockCountWorkbook) {
    throw new Error(
      'This is a standard Stock Count workbook, not an Initial Configuration Classification workbook. '
      + 'To load it as a regular stock count, change Count Type to Full Count, Cycle Count, or Spot Check before importing. '
      + 'To reclassify Legacy / Unclassified stock, download a fresh Initial Configuration Classification template for the selected inventory organization.',
    )
  }
  if (missing.includes('Stock Configuration ID')) {
    throw new Error('This Initial Configuration Classification file uses an older template and cannot be imported. Export a new template and copy the physical counts into it.')
  }
  if (missing.length || duplicates.length) {
    const details = [
      missing.length ? `Missing required header(s): ${missing.join(', ')}.` : '',
      duplicates.length ? `Duplicate required header(s): ${duplicates.join(', ')}.` : '',
    ].filter(Boolean).join(' ')
    throw new Error(`Invalid Initial Configuration Classification Excel headers. ${details}`)
  }

  return new Map(Array.from(indexes.entries()).map(([name, columns]) => [name, columns[0]]))
}

export function parseClassificationWorksheet(
  sheet: ExcelJS.Worksheet,
  targets: ClassificationImportTarget[],
): ClassificationImportResult {
  const headers = resolveClassificationImportHeaders(sheet)
  const column = (name: string) => headers.get(normalizeHeader(name))!
  const stockConfigIdColumn = column('Stock Configuration ID')
  const variantIdColumn = column('Variant ID')
  const physicalCountColumn = column('Physical Count')
  const referenceColumn = column('Classification Reference')
  const stockSkuColumn = headers.get(normalizeHeader('Stock SKU'))

  const byConfig = new Map(targets.map((target) => [target.stockConfigId, target]))
  const seenConfigIds = new Set<string>()
  const patches = new Map<string, { physicalCount: string }>()
  const results: ClassificationImportResult['rows'] = []
  let updated = 0
  let unchanged = 0

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return

    const stockConfigId = row.getCell(stockConfigIdColumn).text.trim()
    const variantId = row.getCell(variantIdColumn).text.trim()
    const sku = stockSkuColumn ? row.getCell(stockSkuColumn).text.trim() : ''
    const reference = row.getCell(referenceColumn).text.trim()
    const matched = byConfig.get(stockConfigId)

    // Summary rows have no Stock Configuration ID — skip them silently
    if (!stockConfigId) return

    if (!matched) {
      results.push({ row: rowNumber, sku: sku || stockConfigId || '-', status: 'Failed', message: 'Unknown or missing Stock Configuration ID.' })
      return
    }
    if (!variantId || variantId !== matched.variantId) {
      results.push({ row: rowNumber, sku: sku, status: 'Failed', message: 'Variant ID does not match the Stock Configuration ID.' })
      return
    }
    if (reference !== matched.variantId) {
      results.push({ row: rowNumber, sku: sku, status: 'Failed', message: 'Classification Reference does not match this row\'s Variant ID.' })
      return
    }
    if (seenConfigIds.has(stockConfigId)) {
      results.push({ row: rowNumber, sku: sku, status: 'Failed', message: 'Duplicate Stock Configuration ID in import file.' })
      return
    }
    seenConfigIds.add(stockConfigId)

    const protectedIdentity: Array<[string, string, string]> = [
      ['Stock SKU', row.getCell(column('Stock SKU')).text.trim(), matched.stockSku],
      ['Product Group/Brand', row.getCell(column('Product Group/Brand')).text.trim(), matched.groupName],
      ['Product Name', row.getCell(column('Product Name')).text.trim(), matched.productName],
      ['Variant Name', row.getCell(column('Variant Name')).text.trim(), matched.variantName],
      ['Flavour', row.getCell(column('Flavour')).text.trim(), extractFlavour(matched.variantName)],
      ['Product Code', row.getCell(column('Product Code')).text.trim(), matched.productCode || ''],
      ['Volume (ml)', row.getCell(column('Volume (ml)')).text.trim(), matched.volumeMl === null ? '' : String(matched.volumeMl)],
      ['Packaging Version', row.getCell(column('Packaging Version')).text.trim(), formatPackagingVersion(matched.packagingVersion)],
      ['Lifecycle', row.getCell(column('Lifecycle')).text.trim(), matched.lifecycle],
      ['Row Type / Classification Status', row.getCell(column('Row Type / Classification Status')).text.trim(), matched.isLegacy ? 'Legacy Source — Read Only' : 'Target Configuration'],
      ['Legacy System Quantity', row.getCell(column('Legacy System Quantity')).text.trim(), String(matched.legacySystemQuantity)],
    ]
    const modifiedIdentity = protectedIdentity.find(([, actual, expected]) => actual !== expected)
    if (modifiedIdentity) {
      results.push({
        row: rowNumber,
        sku: sku || matched.stockSku,
        status: 'Failed',
        message: `Protected identity field "${modifiedIdentity[0]}" was modified. Export a fresh template and enter values only in Physical Count.`,
      })
      return
    }

    const physicalValue = row.getCell(physicalCountColumn).value
    const physicalString = physicalValue === null || physicalValue === undefined ? '' : String(physicalValue).trim()

    if (matched.isLegacy) {
      // Legacy row: "Do not enter" label or blank/0 are all acceptable
      const isDoNotEnter = physicalString.toLowerCase() === 'do not enter'
      if (!isDoNotEnter && physicalString !== '' && Number(physicalString) !== 0) {
        results.push({ row: rowNumber, sku: sku, status: 'Failed', message: 'The Legacy/Unclassified row is read-only and cannot be used as a target classification. Leave its Physical Count blank, 0, or "Do not enter".' })
        return
      }
      unchanged += 1
      results.push({ row: rowNumber, sku: sku, status: 'Unchanged', message: 'Legacy/Unclassified row is informational only.' })
      return
    }

    if (physicalString !== '' && !/^\d+$/.test(physicalString)) {
      results.push({ row: rowNumber, sku: sku, status: 'Failed', message: 'Physical Count must be zero or a positive integer.' })
      return
    }

    const changed = matched.physicalCount !== physicalString
    patches.set(matched.stockConfigId, { physicalCount: physicalString })
    if (changed) updated += 1
    else unchanged += 1
    results.push({
      row: rowNumber,
      sku: sku,
      status: changed ? 'Updated' : 'Unchanged',
      message: physicalString === '' ? 'Blank physical count kept as not counted.' : changed ? 'Loaded into draft.' : 'No change from current draft.',
    })
  })

  // Group by variant to validate completeness
  const targetsByVariant = new Map<string, ClassificationImportTarget[]>()
  targets.filter(target => !target.isLegacy).forEach((target) => {
    const list = targetsByVariant.get(target.variantId) || []
    list.push(target)
    targetsByVariant.set(target.variantId, list)
  })
  const seenVariantIds = new Set(Array.from(seenConfigIds).map((configId) => byConfig.get(configId)?.variantId).filter(Boolean) as string[])
  seenVariantIds.forEach((variantId) => {
    const expected = targetsByVariant.get(variantId) || []
    const missingTargets = expected.filter((target) => !seenConfigIds.has(target.stockConfigId))
    if (missingTargets.length > 0 && missingTargets.length < expected.length) {
      results.push({
        row: 0,
        sku: variantId,
        status: 'Failed',
        message: `Incomplete classification batch: ${missingTargets.length} of ${expected.length} target configuration(s) for this variant are missing from the import file.`,
      })
    }
  })

  return { updated, unchanged, failed: results.filter((row) => row.status === 'Failed').length, patches, rows: results }
}
