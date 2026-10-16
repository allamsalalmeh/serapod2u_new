/**
 * Return Product — Excel worksheet export / import.
 *
 * Excel is an *alternative bulk data-entry method* for the existing Return Items
 * worksheet. It is NOT a PDF export and it is NOT a source of truth: the web UI
 * remains authoritative. Export mirrors the current worksheet state; import
 * merges entered rows back into the same worksheet after strict validation.
 *
 * Calculation rules are never re-implemented here — every quantity is derived
 * with the shared helpers in `format.ts` so Excel round-trips match manual UI
 * entry exactly.
 */

import {
    classifyProductLine, isCartridgeLine, productLineLabel,
    computePcsMode, computeBoxMode,
    type ProductLine, type EntryUnit,
} from './format'

/** Bump when the sheet layout / metadata contract changes incompatibly. */
export const RETURN_EXCEL_TEMPLATE_VERSION = '1.0'
export const RETURN_EXCEL_SOURCE_SYSTEM = 'Serapod2U Return Product'

export const METADATA_SHEET = 'Return Metadata'
export const ITEMS_SHEET = 'Return Items'

/** The exact editable/identity columns of the Return Items table (A→O). */
export const ITEM_COLUMNS = [
    'Product Line',                 // A
    'Product / Variant / Flavour',  // B
    'Product ID',                   // C (hidden/identity)
    'Variant ID',                   // D (hidden/identity)
    'Internal SKU',                 // E
    'Barcode',                      // F
    'Quantity Mode',                // G  PCS | Cases
    'Return Quantity',              // H  PCS mode → total pcs; Cases mode → full cases
    'PCS Per Case',                 // I  (derived/display)
    'Loose PCS',                    // J  Cases mode → extra loose pcs (editable)
    'Full Cases',                   // K  (derived/display)
    'Total PCS',                    // L  (derived/display)
    'Return Reason',                // M
    'Condition',                    // N
    'Notes',                        // O
] as const

// Column letters for convenience.
const COL = {
    productLine: 1, product: 2, productId: 3, variantId: 4, internalSku: 5,
    barcode: 6, mode: 7, qty: 8, pcsPerBox: 9, loose: 10, fullBoxes: 11,
    totalPcs: 12, reason: 13, condition: 14, notes: 15,
}

export interface ReturnExcelMasterOption { code: string; label: string }

/** Return context captured in the hidden metadata sheet and validated on import. */
export interface ReturnExcelContext {
    returnId: string | null
    returnNo: string | null
    /** 'shop' | 'distributor' — the return source org type. */
    sourceType: 'shop' | 'distributor'
    /** Source organization (Shop or Distributor). `shop*` names are legacy. */
    shopId: string
    shopCode: string | null
    shopName: string | null
    contactName?: string | null
    contactPhone?: string | null
    contactEmail?: string | null
    warehouseId: string | null
    warehouseCode: string | null
    warehouseName: string | null
    reportedDate: string | null
    programCode: string | null
    programName: string | null
    categoryId: string | null
    categoryName: string | null
    organizationId: string | null
    instructionText?: string | null
    reasons: ReturnExcelMasterOption[]
    conditions: ReturnExcelMasterOption[]
}

/**
 * Minimal shape the exporter/importer needs from a worksheet row. The editor's
 * `WorksheetRow` is a structural superset, so it can be passed directly.
 */
export interface ReturnExcelRowInput {
    key: string
    product_id: string | null
    variant_id: string | null
    sku: string | null
    manual_sku: string | null
    barcode: string | null
    product_name: string
    variant_name: string | null
    product_line: ProductLine
    units_per_case: number
    entry_unit: EntryUnit
    entered_pcs: number
    entered_box_qty: number
    entered_extra_pcs: number
    case_qty: number
    loose_piece_qty: number
    total_units: number
    reason: string | null
    condition: string | null
    notes: string | null
}

/** A validated per-row update to apply back to the worksheet. */
export interface ReturnExcelImportUpdate {
    rowKey: string
    entry_unit: EntryUnit
    entered_pcs: number
    entered_box_qty: number
    entered_extra_pcs: number
    reason: string | null
    condition: string | null
    notes: string | null
}

export type ImportRowStatus = 'update' | 'skipped' | 'warning' | 'error'

export interface ReturnExcelImportRowResult {
    excelRow: number
    label: string
    identifier: string
    status: ImportRowStatus
    message: string
}

export interface ReturnExcelImportResult {
    /** True only when there are NO blocking (workbook or row) errors. */
    ok: boolean
    /** Workbook-level blocking errors (context mismatch, wrong template, …). */
    fatalErrors: string[]
    rows: ReturnExcelImportRowResult[]
    updates: ReturnExcelImportUpdate[]
    summary: {
        totalDataRows: number
        valid: number
        withQuantity: number
        skippedEmpty: number
        warnings: number
        errors: number
    }
}

// ─────────────────────────── Filename ───────────────────────────

/**
 * `Return-Worksheet-RET26-000003.xlsx` when saved, else
 * `Return-Worksheet-<SHOP_CODE>-<DATE>.xlsx`.
 */
export function buildReturnExcelFilename(ctx: ReturnExcelContext): string {
    if (ctx.returnNo) return `Return-Worksheet-${sanitize(ctx.returnNo)}.xlsx`
    const shop = sanitize(ctx.shopCode || ctx.shopName || 'SHOP')
    const date = (ctx.reportedDate || new Date().toISOString().slice(0, 10)).slice(0, 10)
    return `Return-Worksheet-${shop}-${date}.xlsx`
}

function sanitize(s: string): string {
    return s.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'SHOP'
}

// ─────────────────────────── Export ───────────────────────────

/**
 * Build the Return worksheet workbook: a visible `Return Items` sheet (info
 * banner + product table with validation) and a hidden `Return Metadata` sheet
 * used to validate the file on import.
 */
export async function buildReturnWorkbook(
    ctx: ReturnExcelContext,
    rows: ReturnExcelRowInput[],
): Promise<any> {
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    wb.creator = RETURN_EXCEL_SOURCE_SYSTEM
    wb.created = new Date()

    buildMetadataSheet(wb, ctx)
    buildItemsSheet(wb, ctx, rows)

    return wb
}

/** Build the workbook and serialise it to a browser Blob for download. */
export async function exportReturnWorkbookBlob(
    ctx: ReturnExcelContext,
    rows: ReturnExcelRowInput[],
): Promise<Blob> {
    const wb = await buildReturnWorkbook(ctx, rows)
    const buffer = await wb.xlsx.writeBuffer()
    return new Blob([new Uint8Array(buffer)], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
}

function buildMetadataSheet(wb: any, ctx: ReturnExcelContext) {
    const sheet = wb.addWorksheet(METADATA_SHEET)
    sheet.state = 'veryHidden'
    sheet.columns = [{ width: 22 }, { width: 42 }, { width: 4 }, { width: 24 }, { width: 24 }, { width: 10 }]

    const pairs: [string, string][] = [
        ['Template Version', RETURN_EXCEL_TEMPLATE_VERSION],
        ['Source System', RETURN_EXCEL_SOURCE_SYSTEM],
        ['Exported At', new Date().toISOString()],
        ['Return ID', ctx.returnId || ''],
        ['Return Number', ctx.returnNo || ''],
        ['Source Type', ctx.sourceType === 'distributor' ? 'Distributor' : 'Shop'],
        ['Shop ID', ctx.shopId || ''],
        ['Shop Code', ctx.shopCode || ''],
        ['Shop Name', ctx.shopName || ''],
        ['Contact Name', ctx.contactName || ''],
        ['Contact Phone', ctx.contactPhone || ''],
        ['Contact Email', ctx.contactEmail || ''],
        ['Warehouse ID', ctx.warehouseId || ''],
        ['Warehouse Code', ctx.warehouseCode || ''],
        ['Warehouse Name', ctx.warehouseName || ''],
        ['Reported Date', ctx.reportedDate || ''],
        ['Program Code', ctx.programCode || ''],
        ['Program Name', ctx.programName || ''],
        ['Category ID', ctx.categoryId || ''],
        ['Category Name', ctx.categoryName || ''],
        ['Organization ID', ctx.organizationId || ''],
    ]
    sheet.getCell('A1').value = 'Key'
    sheet.getCell('B1').value = 'Value'
    sheet.getRow(1).font = { bold: true }
    pairs.forEach(([k, v], i) => {
        const r = i + 2
        sheet.getCell(`A${r}`).value = k
        sheet.getCell(`B${r}`).value = v
    })

    // Reference lists (columns D/E/F) for the Return Items dropdowns.
    sheet.getCell('D1').value = 'Reasons'
    sheet.getCell('E1').value = 'Conditions'
    sheet.getCell('F1').value = 'Modes'
    ctx.reasons.forEach((r, i) => { sheet.getCell(`D${i + 2}`).value = r.label })
    ctx.conditions.forEach((c, i) => { sheet.getCell(`E${i + 2}`).value = c.label })
    sheet.getCell('F2').value = 'PCS'
    sheet.getCell('F3').value = 'Cases'
}

function buildItemsSheet(wb: any, ctx: ReturnExcelContext, rows: ReturnExcelRowInput[]) {
    const sheet = wb.addWorksheet(ITEMS_SHEET, {
        views: [{ state: 'frozen', ySplit: 0 }],
    })

    // ── Top information banner ──
    const sourceLabel = ctx.sourceType === 'distributor' ? 'Distributor' : 'Shop'
    const info: [string, string][] = [
        ['Return No', ctx.returnNo || '(not saved yet)'],
        ['Return From Type', sourceLabel],
        [`Return From ${sourceLabel}`, ctx.shopName || ''],
        ['Organization Code', ctx.shopCode || ''],
        ['Contact Name', ctx.contactName || ''],
        ['Contact Phone', ctx.contactPhone || ''],
        ['Contact Email', ctx.contactEmail || ''],
        ['Warehouse', ctx.warehouseName || ''],
        ['Reported Date', ctx.reportedDate || ''],
        ['Program', ctx.programName || ''],
        ['Category', ctx.categoryName || ''],
    ]
    info.forEach(([k, v]) => {
        const row = sheet.addRow([k, v])
        row.getCell(1).font = { bold: true }
    })
    const instr = sheet.addRow([
        'Instructions',
        'Fill Return Quantity and, for Hero/Zero, choose Quantity Mode (PCS or Cases). '
        + 'Devices (S.Line / S.Box) are PCS only. Do not edit Product ID, Variant ID, or the grey derived columns. '
        + 'Save as .xlsx and import back into the system to update the worksheet.',
    ])
    instr.getCell(1).font = { bold: true }
    instr.getCell(2).alignment = { wrapText: true }
    sheet.addRow([])

    // ── Header row ──
    const headerRowNumber = sheet.rowCount + 1
    const header = sheet.addRow(ITEM_COLUMNS as unknown as string[])
    header.font = { bold: true }
    header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
    header.eachCell((cell: any) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF3F8' } }
        cell.border = {
            top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
            bottom: { style: 'thin', color: { argb: 'FFCBD5E1' } },
            left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        }
    })

    // Freeze everything above and including the header row.
    sheet.views = [{ state: 'frozen', ySplit: headerRowNumber }]

    sheet.columns = [
        { width: 12 }, { width: 30 }, { width: 22 }, { width: 22 }, { width: 18 },
        { width: 16 }, { width: 14 }, { width: 15 }, { width: 12 }, { width: 11 },
        { width: 11 }, { width: 11 }, { width: 20 }, { width: 18 }, { width: 26 },
    ]

    // Highlight editable columns (Return Quantity, Quantity Mode, Loose PCS,
    // Reason, Condition, Notes) via a soft header tint.
    for (const c of [COL.mode, COL.qty, COL.loose, COL.reason, COL.condition, COL.notes]) {
        header.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF7E0' } }
    }

    const reasonRange = `'${METADATA_SHEET}'!$D$2:$D$${1 + Math.max(1, ctx.reasons.length)}`
    const conditionRange = `'${METADATA_SHEET}'!$E$2:$E$${1 + Math.max(1, ctx.conditions.length)}`
    const modeRange = `'${METADATA_SHEET}'!$F$2:$F$3`

    rows.forEach((r, i) => {
        const cartridge = isCartridgeLine(r.product_line)
        const upb = r.units_per_case > 0 ? r.units_per_case : 1
        const view = deriveExportView(r)

        const excelRow = sheet.addRow([
            productLineLabel(r.product_line),
            variantDisplay(r),
            r.product_id || '',
            r.variant_id || '',
            r.manual_sku || '',
            r.barcode || '',
            cartridge ? (r.entry_unit === 'box' ? 'Cases' : 'PCS') : 'PCS',
            view.quantity,
            cartridge ? upb : '',
            view.loose,
            cartridge ? view.fullBoxes : '',
            view.totalPcs,
            labelForCode(ctx.reasons, r.reason),
            labelForCode(ctx.conditions, r.condition),
            r.notes || '',
        ])

        // Alternating row styling.
        if (i % 2 === 1) {
            excelRow.eachCell((cell: any) => {
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } }
            })
        }

        // Quantity Mode dropdown — cartridges (Hero/Zero) PCS/Cases; everything else PCS only.
        excelRow.getCell(COL.mode).dataValidation = {
            type: 'list', allowBlank: false,
            formulae: [cartridge ? modeRange : '"PCS"'],
            showErrorMessage: true,
            error: cartridge ? 'Choose PCS or Cases.' : 'Cases mode is only for Cellera Hero / Zero cartridges — this product is PCS only.',
        }
        // Return Quantity — whole number ≥ 0.
        excelRow.getCell(COL.qty).dataValidation = {
            type: 'whole', operator: 'greaterThanOrEqual', allowBlank: true,
            formulae: [0], showErrorMessage: true,
            error: 'Return Quantity must be a whole number of 0 or more.',
        }
        // Loose PCS (extra pcs for Cases mode) — whole number ≥ 0.
        excelRow.getCell(COL.loose).dataValidation = {
            type: 'whole', operator: 'greaterThanOrEqual', allowBlank: true,
            formulae: [0], showErrorMessage: true,
            error: 'Loose PCS must be a whole number of 0 or more.',
        }
        if (ctx.reasons.length > 0) {
            excelRow.getCell(COL.reason).dataValidation = {
                type: 'list', allowBlank: true, formulae: [reasonRange],
            }
        }
        if (ctx.conditions.length > 0) {
            excelRow.getCell(COL.condition).dataValidation = {
                type: 'list', allowBlank: true, formulae: [conditionRange],
            }
        }

        // Grey-out derived/identity columns so users know not to edit them.
        for (const c of [COL.productId, COL.variantId, COL.pcsPerBox, COL.fullBoxes, COL.totalPcs]) {
            excelRow.getCell(c).font = { color: { argb: 'FF94A3B8' } }
        }
    })

    // Hide identity columns but keep them available for safe import matching.
    sheet.getColumn(COL.productId).hidden = true
    sheet.getColumn(COL.variantId).hidden = true

    // Whole-number display for numeric columns.
    for (const c of [COL.qty, COL.pcsPerBox, COL.loose, COL.fullBoxes, COL.totalPcs]) {
        sheet.getColumn(c).numFmt = '#,##0'
    }

    // Auto filter over the table header.
    const lastCol = ITEM_COLUMNS.length
    sheet.autoFilter = {
        from: { row: headerRowNumber, column: 1 },
        to: { row: headerRowNumber, column: lastCol },
    }
}

function variantDisplay(r: ReturnExcelRowInput): string {
    const name = (r.variant_name || '').trim()
    return name || r.product_name
}

function labelForCode(options: ReturnExcelMasterOption[], code: string | null): string {
    if (!code) return ''
    return options.find((o) => o.code === code)?.label || code
}

/**
 * Display quantities for a row, respecting its current entry mode. Uses the
 * shared compute helpers so exported figures match the UI exactly.
 */
function deriveExportView(r: ReturnExcelRowInput): {
    quantity: number; loose: number; fullBoxes: number; totalPcs: number
} {
    if (!isCartridgeLine(r.product_line)) {
        const pcs = Math.max(0, Math.floor(r.total_units || r.entered_pcs || 0))
        return { quantity: pcs, loose: pcs, fullBoxes: 0, totalPcs: pcs }
    }
    const upb = r.units_per_case > 0 ? r.units_per_case : 1
    if (r.entry_unit === 'box') {
        const res = computeBoxMode({ boxQty: r.entered_box_qty, extraPcs: r.entered_extra_pcs, unitsPerBox: upb })
        return {
            quantity: Math.max(0, Math.floor(r.entered_box_qty)),
            loose: Math.max(0, Math.floor(r.entered_extra_pcs)),
            fullBoxes: res.boxQty,
            totalPcs: res.totalPcs,
        }
    }
    const res = computePcsMode({ enteredPcs: r.entered_pcs, unitsPerBox: upb })
    return {
        quantity: Math.max(0, Math.floor(r.entered_pcs)),
        loose: res.loosePcs,
        fullBoxes: res.boxQty,
        totalPcs: res.totalPcs,
    }
}

// ─────────────────────────── Import ───────────────────────────

/**
 * Parse and validate an uploaded workbook against the current return context
 * and worksheet. Never mutates anything — returns a preview result the caller
 * applies (merge semantics) after user review.
 */
export async function parseReturnWorkbook(
    input: File | ArrayBuffer | Uint8Array,
    ctx: ReturnExcelContext,
    currentRows: ReturnExcelRowInput[],
): Promise<ReturnExcelImportResult> {
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    const buffer = input instanceof File ? await input.arrayBuffer() : input
    await wb.xlsx.load(buffer as ArrayBuffer)

    const result: ReturnExcelImportResult = {
        ok: false, fatalErrors: [], rows: [], updates: [],
        summary: { totalDataRows: 0, valid: 0, withQuantity: 0, skippedEmpty: 0, warnings: 0, errors: 0 },
    }

    // ── Metadata validation ──
    const metaSheet = wb.getWorksheet(METADATA_SHEET)
    if (!metaSheet) {
        result.fatalErrors.push('This file is not a Return Product worksheet (missing metadata).')
        return finalize(result)
    }
    const meta = readMetadata(metaSheet)
    validateContext(meta, ctx, result.fatalErrors)
    if (result.fatalErrors.length > 0) return finalize(result)

    const itemsSheet = wb.getWorksheet(ITEMS_SHEET)
    if (!itemsSheet) {
        result.fatalErrors.push('The worksheet tab "Return Items" is missing from this file.')
        return finalize(result)
    }

    const headerRowNumber = findHeaderRow(itemsSheet)
    if (headerRowNumber < 0) {
        result.fatalErrors.push('Could not locate the product table header in "Return Items".')
        return finalize(result)
    }

    // ── Build lookup indexes from the current worksheet ──
    const byVariant = new Map<string, ReturnExcelRowInput>()
    const bySku = indexUnique(currentRows, (r) => r.manual_sku)
    const byBarcode = indexUnique(currentRows, (r) => r.barcode)
    for (const r of currentRows) {
        if (r.variant_id) byVariant.set(norm(r.variant_id), r)
    }

    const seen = new Set<string>()

    itemsSheet.eachRow((excelRow: any, rowNumber: number) => {
        if (rowNumber <= headerRowNumber) return
        const cell = (c: number) => excelRow.getCell(c)
        const variantId = cellStr(cell(COL.variantId))
        const productId = cellStr(cell(COL.productId))
        const internalSku = cellStr(cell(COL.internalSku))
        const barcode = cellStr(cell(COL.barcode))
        const modeRaw = cellStr(cell(COL.mode))
        const qtyRaw = cell(COL.qty).value
        const looseRaw = cell(COL.loose).value
        const reasonRaw = cellStr(cell(COL.reason))
        const conditionRaw = cellStr(cell(COL.condition))
        const notes = cellStr(cell(COL.notes))
        const labelText = cellStr(cell(COL.product)) || internalSku || variantId

        // Entirely blank line → ignore silently.
        if (!variantId && !productId && !internalSku && !barcode
            && qtyRaw == null && looseRaw == null && !reasonRaw && !conditionRaw && !notes) {
            return
        }
        result.summary.totalDataRows += 1
        const identifier = variantId || internalSku || barcode || '(row)'

        const push = (status: ImportRowStatus, message: string) =>
            result.rows.push({ excelRow: rowNumber, label: labelText, identifier, status, message })

        // ── Match to a current worksheet row ──
        let matched: ReturnExcelRowInput | undefined
        let matchedBy = ''
        if (variantId && byVariant.has(norm(variantId))) { matched = byVariant.get(norm(variantId)); matchedBy = 'Variant ID' }
        else if (internalSku && bySku.has(norm(internalSku))) { matched = bySku.get(norm(internalSku)); matchedBy = 'Internal SKU' }
        else if (barcode && byBarcode.has(norm(barcode))) { matched = byBarcode.get(norm(barcode)); matchedBy = 'Barcode' }

        if (!matched) {
            push('error', 'Product not found in the current worksheet (unknown or from another template).')
            return
        }
        // Product ID tampering guard.
        if (productId && matched.product_id && norm(productId) !== norm(matched.product_id)) {
            push('error', 'Product ID does not match this product — the identity column was modified.')
            return
        }
        // Duplicate detection within the file.
        const dedupeKey = norm(matched.variant_id || matched.manual_sku || matched.sku || matched.key)
        if (seen.has(dedupeKey)) {
            push('error', 'Duplicate product row in the Excel file — matched more than once.')
            return
        }
        seen.add(dedupeKey)

        const cartridge = isCartridgeLine(matched.product_line)

        // ── Quantity mode ──
        // "Cases" is the current wording; "Box" is still accepted so templates
        // downloaded before the rename keep importing. Cases is only for
        // vape cartridges (Cellera Hero / Zero) — devices and other products
        // are PCS only.
        let mode: EntryUnit
        const modeLc = modeRaw.toLowerCase()
        const isCaseMode = modeLc === 'cases' || modeLc === 'case' || modeLc === 'box'
        if (!cartridge) {
            if (isCaseMode) { push('error', 'Cases mode is only for Cellera Hero / Zero cartridges — this product is PCS only.'); return }
            mode = 'pcs'
        } else if (isCaseMode) {
            mode = 'box'
        } else if (modeLc === 'pcs' || modeLc === '') {
            mode = 'pcs'
        } else {
            push('error', `Unrecognised Quantity Mode "${modeRaw}". Use PCS or Cases.`)
            return
        }

        // ── Quantity values ──
        const qty = parseWholeNumber(qtyRaw)
        if (qty.error) { push('error', `Return Quantity: ${qty.error}`); return }
        const loose = parseWholeNumber(looseRaw)
        if (loose.error) { push('error', `Loose PCS: ${loose.error}`); return }

        // ── Reason / condition mapping (only when provided) ──
        const reason = reasonRaw ? mapOption(ctx.reasons, reasonRaw) : null
        if (reasonRaw && reason == null) { push('error', `Unsupported Return Reason "${reasonRaw}".`); return }
        const condition = conditionRaw ? mapOption(ctx.conditions, conditionRaw) : null
        if (conditionRaw && condition == null) { push('error', `Unsupported Condition "${conditionRaw}".`); return }

        // ── Merge semantics: only rows with an entered quantity update the UI ──
        const hasQuantity = mode === 'box' ? (qty.value > 0 || loose.value > 0) : qty.value > 0
        if (!hasQuantity) {
            result.summary.skippedEmpty += 1
            push('skipped', 'No quantity entered — existing worksheet value kept (merge mode).')
            return
        }

        const update: ReturnExcelImportUpdate = {
            rowKey: matched.key,
            entry_unit: mode,
            entered_pcs: mode === 'pcs' ? qty.value : 0,
            entered_box_qty: mode === 'box' ? qty.value : 0,
            entered_extra_pcs: mode === 'box' ? loose.value : 0,
            reason,
            condition,
            notes: notes || null,
        }
        result.updates.push(update)
        result.summary.withQuantity += 1

        // A product-line label mismatch is non-blocking (identity already matched).
        const excelLine = classifyLineLabel(cellStr(cell(COL.productLine)))
        if (excelLine && excelLine !== matched.product_line) {
            result.summary.warnings += 1
            push('warning', `Product Line in Excel ("${cellStr(cell(COL.productLine))}") differs from the system — system value kept. Matched by ${matchedBy}.`)
        } else {
            push('update', `Will update quantity, reason, condition and notes. Matched by ${matchedBy}.`)
        }
    })

    return finalize(result)
}

function finalize(result: ReturnExcelImportResult): ReturnExcelImportResult {
    result.summary.errors = result.rows.filter((r) => r.status === 'error').length
    result.summary.valid = result.summary.withQuantity + result.summary.skippedEmpty
    result.ok = result.fatalErrors.length === 0 && result.summary.errors === 0
    return result
}

// ── Metadata helpers ──

function readMetadata(sheet: any): Map<string, string> {
    const map = new Map<string, string>()
    sheet.eachRow((row: any) => {
        const key = cellStr(row.getCell(1))
        if (!key) return
        map.set(key.toLowerCase(), cellStr(row.getCell(2)))
    })
    return map
}

function validateContext(meta: Map<string, string>, ctx: ReturnExcelContext, errors: string[]) {
    const source = meta.get('source system')
    if (source !== RETURN_EXCEL_SOURCE_SYSTEM) {
        errors.push('This file is not a Serapod2U Return Product worksheet.')
        return
    }
    const version = meta.get('template version')
    if (version !== RETURN_EXCEL_TEMPLATE_VERSION) {
        errors.push(`Unsupported template version "${version || 'unknown'}". Please download a fresh template.`)
    }
    // Source type must match the current mode — never import a Distributor
    // template while in Shop mode, or vice versa.
    const mSourceType = (meta.get('source type') || '').toLowerCase()
    if (mSourceType && (mSourceType === 'shop' || mSourceType === 'distributor') && mSourceType !== ctx.sourceType) {
        errors.push(`This template was exported for a ${mSourceType} return, but the current return is from a ${ctx.sourceType}.`)
    }
    const mShop = meta.get('shop id')
    if (mShop && ctx.shopId && norm(mShop) !== norm(ctx.shopId)) {
        const label = ctx.sourceType === 'distributor' ? 'distributor' : 'shop'
        errors.push(`This template was exported for a different ${label} (${meta.get('shop name') || mShop}).`)
    }
    const mWh = meta.get('warehouse id')
    if (mWh && ctx.warehouseId && norm(mWh) !== norm(ctx.warehouseId)) {
        errors.push('This template was exported for a different Return Warehouse.')
    }
    const mCat = meta.get('category id')
    if (mCat && ctx.categoryId && norm(mCat) !== norm(ctx.categoryId)) {
        errors.push(`This template was exported for a different category (${meta.get('category name') || mCat}).`)
    } else if (!mCat) {
        const mCatName = meta.get('category name')
        if (mCatName && ctx.categoryName && norm(mCatName) !== norm(ctx.categoryName)) {
            errors.push(`This template was exported for a different category (${mCatName}).`)
        }
    }
    const mProg = meta.get('program name')
    if (mProg && ctx.programName && norm(mProg) !== norm(ctx.programName)) {
        errors.push(`This template was exported for a different program (${mProg}).`)
    }
    // Return ID/number must match when importing into a saved return.
    const mReturnId = meta.get('return id')
    if (ctx.returnId && mReturnId && norm(mReturnId) !== norm(ctx.returnId)) {
        errors.push('This template belongs to a different saved return.')
    }
    const mReturnNo = meta.get('return number')
    if (ctx.returnNo && mReturnNo && norm(mReturnNo) !== norm(ctx.returnNo)) {
        errors.push(`This template was exported for return ${mReturnNo}, not ${ctx.returnNo}.`)
    }
}

// ── Cell / value helpers ──

function findHeaderRow(sheet: any): number {
    let found = -1
    sheet.eachRow((row: any, rowNumber: number) => {
        if (found >= 0) return
        if (cellStr(row.getCell(1)).toLowerCase() === 'product line'
            && cellStr(row.getCell(COL.qty)).toLowerCase() === 'return quantity') {
            found = rowNumber
        }
    })
    return found
}

function cellStr(cell: any): string {
    const v = cell?.value
    if (v == null) return ''
    if (typeof v === 'object') {
        // Rich text / formula result / hyperlink objects.
        if ('text' in v && v.text != null) return String(v.text).trim()
        if ('result' in v && v.result != null) return String(v.result).trim()
        if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((t: any) => t.text).join('').trim()
    }
    return String(v).trim()
}

interface WholeParse { value: number; error: string | null }
function parseWholeNumber(raw: any): WholeParse {
    if (raw == null || raw === '') return { value: 0, error: null }
    let s: string
    if (typeof raw === 'object' && raw !== null && 'result' in raw) s = String(raw.result)
    else s = String(raw).trim()
    if (s === '') return { value: 0, error: null }
    const n = Number(s)
    if (!Number.isFinite(n)) return { value: 0, error: 'must be a number.' }
    if (n < 0) return { value: 0, error: 'negative values are not allowed.' }
    if (!Number.isInteger(n)) return { value: 0, error: 'decimals are not allowed — enter a whole number.' }
    return { value: n, error: null }
}

function mapOption(options: ReturnExcelMasterOption[], raw: string): string | null {
    const s = raw.trim().toLowerCase()
    const byLabel = options.find((o) => o.label.toLowerCase() === s)
    if (byLabel) return byLabel.code
    const byCode = options.find((o) => o.code.toLowerCase() === s)
    return byCode ? byCode.code : null
}

function classifyLineLabel(label: string): ProductLine | null {
    const s = label.trim().toLowerCase()
    if (!s) return null
    if (s === 'hero') return 'hero'
    if (s === 'zero') return 'zero'
    if (s === 's.box' || s === 'sbox') return 'sbox'
    if (s === 's.line' || s === 'sline') return 'sline'
    if (s === 'other') return 'other'
    return classifyProductLine(label)
}

function indexUnique(
    rows: ReturnExcelRowInput[],
    keyFn: (r: ReturnExcelRowInput) => string | null,
): Map<string, ReturnExcelRowInput> {
    const counts = new Map<string, number>()
    for (const r of rows) {
        const k = keyFn(r)
        if (!k) continue
        counts.set(norm(k), (counts.get(norm(k)) || 0) + 1)
    }
    const map = new Map<string, ReturnExcelRowInput>()
    for (const r of rows) {
        const k = keyFn(r)
        if (!k) continue
        const nk = norm(k)
        if ((counts.get(nk) || 0) === 1) map.set(nk, r)
    }
    return map
}

function norm(s: string): string {
    return s.trim().toLowerCase()
}
