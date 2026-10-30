import type ExcelJS from 'exceljs'
import {
  catalogRowKey,
  extractFlavour,
  isSelectableManualStockConfiguration,
  parseAddQuantity,
  parseUnitCost,
  type ManualStockCatalogRow,
} from './add-stock-inventory'
import { stockUnitDisplayLabel, stockUnitForProduct } from './stock-count-quantity'

export const MANUAL_STOCK_ADDITION_EXCEL_HEADERS = [
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
  // Quantities below are in this unit (cases for cartridges, pcs otherwise).
  'Stock Unit',
  'Current Quantity',
  'Add Quantity',
  'Unit Cost',
  'Row Note',
] as const

const REQUIRED_IMPORT_HEADERS = [
  'Stock Configuration ID',
  'Variant ID',
  'Add Quantity',
] as const

const EDITABLE_HEADERS = new Set(['Add Quantity', 'Unit Cost', 'Row Note'])

export interface ManualStockExcelPatch {
  quantity: string
  unitCost: string
  rowNote: string
}

export interface ManualStockImportResult {
  updated: number
  unchanged: number
  failed: number
  patches: Map<string, ManualStockExcelPatch>
  rows: Array<{
    row: number
    sku: string
    status: 'Updated' | 'Unchanged' | 'Failed'
    message: string
  }>
}

function formatPackagingVersion(packaging: string | null): string {
  if (packaging === 'new_box') return 'New Box'
  if (packaging === 'old_box') return 'Old Box'
  return packaging || 'Standard'
}

function normalizeHeader(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase()
}

function cellText(value: ExcelJS.CellValue | null | undefined): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object' && 'text' in value && typeof value.text === 'string') return value.text
  if (typeof value === 'object' && 'result' in value) return String((value as { result?: unknown }).result ?? '')
  return String(value)
}

export function buildManualStockAdditionWorksheet(
  workbook: ExcelJS.Workbook,
  rows: ManualStockCatalogRow[],
  quantities: Record<string, string>,
  unitCosts: Record<string, string>,
  rowNotes: Record<string, string>,
): ExcelJS.Worksheet {
  const worksheet = workbook.addWorksheet('Manual Stock Addition')
  worksheet.addRow([...MANUAL_STOCK_ADDITION_EXCEL_HEADERS])

  rows.forEach((row) => {
    worksheet.addRow([
      row.stockConfigId,
      row.stockSku,
      row.variantId,
      row.productLine,
      row.productName,
      row.variantName,
      extractFlavour(row.variantName) || null,
      row.productCode || null,
      row.volumeMl,
      formatPackagingVersion(row.packaging),
      stockUnitDisplayLabel(stockUnitForProduct(row.productName)),
      row.currentOnHand,
      quantities[row.rowKey] ? Number(quantities[row.rowKey]) : null,
      unitCosts[row.rowKey] ? Number(unitCosts[row.rowKey]) : null,
      rowNotes[row.rowKey] || null,
    ])
  })

  worksheet.columns = MANUAL_STOCK_ADDITION_EXCEL_HEADERS.map((header) => ({
    header,
    width: Math.max(14, Math.min(42, header.length + 4)),
  }))
  worksheet.views = [{ state: 'frozen', ySplit: 1, xSplit: 3 }]
  worksheet.autoFilter = {
    from: 'A1',
    to: `${String.fromCharCode(64 + MANUAL_STOCK_ADDITION_EXCEL_HEADERS.length)}1`,
  }

  const header = worksheet.getRow(1)
  header.height = 24
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F766E' } }
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
  header.eachCell((cell) => {
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF115E59' } } }
  })

  for (const column of [1, 2, 3, 8]) worksheet.getColumn(column).numFmt = '@'
  worksheet.getColumn(9).numFmt = '0'
  worksheet.getColumn(12).numFmt = '#,##0'
  worksheet.getColumn(13).numFmt = '#,##0'
  worksheet.getColumn(14).numFmt = '#,##0.00'

  // Lock identity columns; unlock only Add Quantity, Unit Cost, Row Note.
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    for (let col = 1; col <= MANUAL_STOCK_ADDITION_EXCEL_HEADERS.length; col += 1) {
      const headerName = MANUAL_STOCK_ADDITION_EXCEL_HEADERS[col - 1]
      worksheet.getCell(rowNumber, col).protection = {
        locked: !EDITABLE_HEADERS.has(headerName),
      }
    }
  }

  worksheet.protect('', {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatColumns: true,
    autoFilter: true,
  })

  return worksheet
}

export async function parseManualStockAdditionImport(
  workbook: ExcelJS.Workbook,
  sourceRows: ManualStockCatalogRow[],
): Promise<ManualStockImportResult> {
  const worksheet = workbook.worksheets[0]
  if (!worksheet) {
    return {
      updated: 0,
      unchanged: 0,
      failed: 1,
      patches: new Map(),
      rows: [{ row: 1, sku: '', status: 'Failed', message: 'Worksheet is empty' }],
    }
  }

  const headerRow = worksheet.getRow(1)
  const headers: string[] = []
  headerRow.eachCell((cell, col) => {
    headers[col] = cellText(cell.value).trim()
  })

  const normalizedHeaders = headers.map((header) => normalizeHeader(header || ''))
  for (const name of REQUIRED_IMPORT_HEADERS) {
    if (!normalizedHeaders.includes(normalizeHeader(name))) {
      return {
        updated: 0,
        unchanged: 0,
        failed: 1,
        patches: new Map(),
        rows: [{
          row: 1,
          sku: '',
          status: 'Failed',
          message: `Missing column: ${name}. Variant-only or stale templates are not accepted.`,
        }],
      }
    }
  }

  // Reject legacy variant-only templates that lack Stock Configuration ID values.
  if (!normalizedHeaders.includes(normalizeHeader('Stock Configuration ID'))) {
    return {
      updated: 0,
      unchanged: 0,
      failed: 1,
      patches: new Map(),
      rows: [{
        row: 1,
        sku: '',
        status: 'Failed',
        message: 'Variant-only templates are not accepted. Export a fresh Manual Stock Addition template.',
      }],
    }
  }

  const col = (name: string) => normalizedHeaders.indexOf(normalizeHeader(name))
  const byConfig = new Map(sourceRows.map((row) => [row.stockConfigId, row]))
  const seenConfigIds = new Set<string>()
  const patches = new Map<string, ManualStockExcelPatch>()
  const resultRows: ManualStockImportResult['rows'] = []
  let updated = 0
  let unchanged = 0
  let failed = 0

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return

    const stockConfigId = cellText(row.getCell(col('Stock Configuration ID')).value).trim()
    const variantId = cellText(row.getCell(col('Variant ID')).value).trim()
    const sku = cellText(row.getCell(col('Stock SKU') > 0 ? col('Stock SKU') : -1).value).trim()
    const qtyRaw = row.getCell(col('Add Quantity')).value
    const unitCostRaw = col('Unit Cost') > 0 ? row.getCell(col('Unit Cost')).value : null
    const rowNote = col('Row Note') > 0
      ? cellText(row.getCell(col('Row Note')).value).trim()
      : ''

    const hasQty = !(qtyRaw === null || qtyRaw === undefined || qtyRaw === '')
    if (!stockConfigId && !hasQty) return

    if (!stockConfigId) {
      failed += 1
      resultRows.push({
        row: rowNumber,
        sku: sku || variantId,
        status: 'Failed',
        message: 'Stock Configuration ID is required. Variant-only rows are rejected.',
      })
      return
    }

    if (seenConfigIds.has(stockConfigId)) {
      failed += 1
      resultRows.push({
        row: rowNumber,
        sku: sku || stockConfigId,
        status: 'Failed',
        message: 'Duplicate Stock Configuration ID in the workbook',
      })
      return
    }
    seenConfigIds.add(stockConfigId)

    const source = byConfig.get(stockConfigId)
    if (!source) {
      failed += 1
      resultRows.push({
        row: rowNumber,
        sku: sku || stockConfigId,
        status: 'Failed',
        message: 'Stock configuration not found in the current catalog (stale or mismatched template)',
      })
      return
    }

    if (variantId && variantId !== source.variantId) {
      failed += 1
      resultRows.push({
        row: rowNumber,
        sku: source.stockSku,
        status: 'Failed',
        message: 'Variant ID does not match the Stock Configuration ID',
      })
      return
    }

    if (!isSelectableManualStockConfiguration(source)) {
      failed += 1
      resultRows.push({
        row: rowNumber,
        sku: source.stockSku,
        status: 'Failed',
        message: 'Legacy/Unclassified configurations cannot be imported',
      })
      return
    }

    // Identity drift checks for protected columns when present.
    const protectedChecks: Array<[string, string]> = [
      ['Stock SKU', source.stockSku],
      ['Product Code', source.productCode],
      ['Product Name', source.productName],
      ['Variant Name', source.variantName],
    ]
    for (const [headerName, expected] of protectedChecks) {
      const index = col(headerName)
      if (index <= 0) continue
      const actual = cellText(row.getCell(index).value).trim()
      if (actual && actual !== expected) {
        failed += 1
        resultRows.push({
          row: rowNumber,
          sku: source.stockSku,
          status: 'Failed',
          message: `${headerName} does not match the current catalog (stale or edited identity column)`,
        })
        return
      }
    }

    if (!hasQty) {
      unchanged += 1
      resultRows.push({
        row: rowNumber,
        sku: source.stockSku,
        status: 'Unchanged',
        message: 'No add quantity',
      })
      return
    }

    const parsedQty = parseAddQuantity(qtyRaw as string | number)
    if (!parsedQty.ok) {
      failed += 1
      resultRows.push({
        row: rowNumber,
        sku: source.stockSku,
        status: 'Failed',
        message: parsedQty.error,
      })
      return
    }

    const parsedCost = parseUnitCost(unitCostRaw as string | number | null)
    if (!parsedCost.ok) {
      failed += 1
      resultRows.push({
        row: rowNumber,
        sku: source.stockSku,
        status: 'Failed',
        message: parsedCost.error,
      })
      return
    }

    patches.set(catalogRowKey(source.variantId, source.stockConfigId), {
      quantity: String(parsedQty.value),
      unitCost: parsedCost.value === null ? '' : String(parsedCost.value),
      rowNote,
    })
    updated += 1
    resultRows.push({
      row: rowNumber,
      sku: source.stockSku,
      status: 'Updated',
      message: `Qty ${parsedQty.value}`,
    })
  })

  return { updated, unchanged, failed, patches, rows: resultRows }
}
