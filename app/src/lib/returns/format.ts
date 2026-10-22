/**
 * Return Product worksheet — display/formatting helpers.
 *
 * These are pure presentation rules. They never mutate master data: the full
 * Variant Name (e.g. "Zero Edition Novella [ Buttercake ]") stays intact in the
 * database; the worksheet and PDF only *show* the concise flavour.
 */

export type ProductLine = 'hero' | 'zero' | 'sbox' | 'sline' | 'other'

// ── Money ──

/**
 * Return value / amount display: grouped thousands with exactly 2 decimals.
 * The "RM" prefix (if any) belongs to the caller — column headers already say
 * "Value (RM)".
 *
 *   1788   -> "1,788.00"
 *   3513.5 -> "3,513.50"
 *   null   -> "0.00"
 */
export function formatReturnAmount(value: number | string | null | undefined): string {
    const n = Number(value ?? 0)
    return (Number.isFinite(n) ? n : 0).toLocaleString('en-MY', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })
}

// ── Unit wording ──

/**
 * User-facing wording for the outer packaging unit is "Case" / "Cases".
 * Internal fields and stored values stay `case_qty` / `entry_unit: 'box'`.
 */
export const CASE_UNIT_LABEL = 'Cases'

/** "1 Case" / "2 Cases" — singular only for exactly one. */
export function caseUnitLabel(qty: number): string {
    return qty === 1 ? 'Case' : 'Cases'
}

/**
 * Concise flavour label for a full variant name.
 *
 * If the variant name contains square brackets, return the trimmed text of the
 * final non-empty `[ … ]` group; otherwise return the full (trimmed) name.
 *
 *   "Zero Edition Novella [ Buttercake ]"        -> "Buttercake"
 *   "Deluxe Cellera Cartridge [ Banana Milk ]"   -> "Banana Milk"
 *   "Cellera Zero [ Novella ] [ Buttercake ]"    -> "Buttercake"
 *   "Honeydew"                                   -> "Honeydew"
 */
export function getVariantDisplayName(fullVariantName?: string | null): string {
    const name = (fullVariantName || '').trim()
    if (!name) return ''
    const groups = name.match(/\[([^[\]]*)\]/g)
    if (groups) {
        for (let i = groups.length - 1; i >= 0; i--) {
            const inner = groups[i].slice(1, -1).trim()
            if (inner) return inner
        }
    }
    return name
}

/**
 * Classify a Product (Product Line) from its product name.
 *
 *   Cellera Hero           → hero
 *   Cellera Zero           → zero
 *   Serapod Device S.Box   → sbox
 *   Serapod Device S.Line  → sline
 *
 * Matching is case-insensitive and whitespace-safe. Zero is tested before Hero
 * so "Hero Zero" resolves to Zero. S.Box/S.Line are tested before the broader
 * patterns to avoid false positives.
 */
export function classifyProductLine(productName?: string | null): ProductLine {
    const n = (productName || '').toLowerCase().replace(/\s+/g, ' ').trim()
    if (n.includes('s.line') || n.includes('sline')) return 'sline'
    if (n.includes('s.box') || n.includes('sbox')) return 'sbox'
    if (n.includes('zero')) return 'zero'
    if (n.includes('hero')) return 'hero'
    return 'other'
}

/**
 * Device product lines are entered in PCS only — no Cases mode, no pack-size
 * conversion. 1 entered unit = 1 PCS.
 */
export function isDeviceLine(line: ProductLine): boolean {
    return line === 'sline' || line === 'sbox'
}

/**
 * Vape cartridges (Cellera Hero / Zero) are the only products that may be
 * entered or displayed in Cases. Devices and every other product stay in PCS.
 */
export function isCartridgeLine(line: ProductLine): boolean {
    return line === 'hero' || line === 'zero'
}

/**
 * Units per case for a worksheet row.
 * Devices and non-cartridge products always resolve to 1 (PCS only).
 * Hero / Zero keep the standard pack-size resolution.
 */
export function getRowUnitsPerCase(
    line: ProductLine,
    productName: string | null | undefined,
    masterUnitsPerCase?: number | null,
): number {
    if (!isCartridgeLine(line)) return 1
    return getUnitsPerCase(productName, masterUnitsPerCase)
}

/**
 * Units per case for a line already saved on a return: the snapshot it was
 * posted to stock with, so a stored line always reads back the quantity that
 * reached inventory. Lines without a usable snapshot resolve like a new row.
 */
export function getSavedRowUnitsPerCase(
    line: ProductLine,
    productName: string | null | undefined,
    snapshotUnitsPerCase: number | null | undefined,
    fallbackUnitsPerCase?: number | null,
): number {
    const snapshot = Number(snapshotUnitsPerCase)
    if (!Number.isFinite(snapshot) || snapshot < 1) {
        return getRowUnitsPerCase(line, productName, fallbackUnitsPerCase)
    }
    if (isCartridgeLine(line)) return Math.floor(snapshot)
    return getRowUnitsPerCase(line, productName, Math.floor(snapshot))
}

/** Short badge label for a Product Line. */
export function productLineLabel(line: ProductLine): string {
    if (line === 'hero') return 'Hero'
    if (line === 'zero') return 'Zero'
    if (line === 'sbox') return 'S.Box'
    if (line === 'sline') return 'S.Line'
    return 'Other'
}

/**
 * Units per Case (pieces in one full outer case) for a worksheet line.
 *
 * Resolution priority:
 *   1. A reliable value from master data (product/variant packaging config), i.e.
 *      a configured pack size > 1.
 *   2. Centralized Cellera product-line default: Hero / Zero = 4 pcs per case.
 *   3. Fall back to the master value if positive, else 1.
 *
 * Never silently defaults Cellera Hero/Zero to 1. This is the single place that
 * knows the Cellera pack size — replace it with real master-data config later
 * without touching any UI component.
 */
export const CELLERA_UNITS_PER_CASE = 4

export function getUnitsPerCase(productName: string | null | undefined, masterUnitsPerCase?: number | null): number {
    const master = Number(masterUnitsPerCase)
    // A configured pack size > 1 is treated as reliable and wins.
    if (Number.isFinite(master) && master > 1) return Math.floor(master)

    const line = classifyProductLine(productName)
    if (line === 'hero' || line === 'zero') return CELLERA_UNITS_PER_CASE

    // For device lines (S.Box / S.Line), if master data has a valid units_per_case,
    // use it; otherwise return it but flag as unavailable for Cases mode downstream.
    return Number.isFinite(master) && master > 0 ? Math.floor(master) : 1
}

/**
 * Alias: Units per Box — same resolution as Units per Case.
 * User-facing wording is "Cases", internal field remains units_per_case.
 */
export function getUnitsPerBox(productName: string | null | undefined, masterUnitsPerBox?: number | null): number {
    return getUnitsPerCase(productName, masterUnitsPerBox)
}

// ── Entry Unit ──

export type EntryUnit = 'pcs' | 'box'

// ── Quantity mode: Pcs ──

export interface PcsModeInput {
    /** The whole-number quantity entered in Pcs mode. */
    enteredPcs: number
    /** Units per box (e.g. 4 for Cellera Hero/Zero). */
    unitsPerBox: number
}

export interface PcsModeOutput {
    /** Normalized full-box count. */
    boxQty: number
    /** Remaining loose pieces (always < unitsPerBox). */
    loosePcs: number
    /** Total pieces (= enteredPcs). */
    totalPcs: number
}

/**
 * Compute box breakdown from a Pcs-mode entry.
 *
 *   total_pcs = entered_pcs
 *   box_qty = floor(total_pcs / units_per_box)
 *   loose_pcs = total_pcs % units_per_box
 *
 * Example (unitsPerBox = 4):
 *   3 Pcs → 0 Box + 3 Pcs → Total 3
 *   4 Pcs → 1 Box + 0 Pcs → Total 4
 *   5 Pcs → 1 Box + 1 Pc  → Total 5
 */
export function computePcsMode(input: PcsModeInput): PcsModeOutput {
    const upb = input.unitsPerBox > 0 ? Math.floor(input.unitsPerBox) : 1
    const total = Math.max(0, Math.floor(input.enteredPcs))
    return {
        boxQty: Math.floor(total / upb),
        loosePcs: total % upb,
        totalPcs: total,
    }
}

// ── Quantity mode: Box ──

export interface BoxModeInput {
    /** Whole-number box count. */
    boxQty: number
    /** Extra loose pieces (may exceed unitsPerBox before normalization). */
    extraPcs: number
    /** Units per box (e.g. 4 for Cellera Hero/Zero). */
    unitsPerBox: number
}

export interface BoxModeOutput {
    /** Normalized full-box count (carry applied). */
    boxQty: number
    /** Normalized loose pieces (always < unitsPerBox). */
    loosePcs: number
    /** Total pieces = boxQty * unitsPerBox + loosePcs. */
    totalPcs: number
}

/**
 * Compute total from Box-mode entry, normalizing extra pieces into boxes.
 *
 *   total_pcs = (box_qty × units_per_box) + extra_pcs
 *   normalized_box_qty = floor(total_pcs / units_per_box)
 *   normalized_loose_pcs = total_pcs % units_per_box
 *
 * Example (unitsPerBox = 4):
 *   1 Box + 0 Pcs   → Total 4
 *   4 Box + 3 Pcs   → Total 19
 *   4 Box + 6 Pcs   → 5 Box + 2 Pcs → Total 22
 */
export function computeBoxMode(input: BoxModeInput): BoxModeOutput {
    const upb = input.unitsPerBox > 0 ? Math.floor(input.unitsPerBox) : 1
    const b = Math.max(0, Math.floor(input.boxQty))
    const e = Math.max(0, Math.floor(input.extraPcs))
    const total = b * upb + e
    return {
        boxQty: Math.floor(total / upb),
        loosePcs: total % upb,
        totalPcs: total,
    }
}

// ── Normalized storage (internal) ──

export interface NormalizedStorage {
    case_qty: number
    loose_piece_qty: number
    units_per_case_snapshot: number
    total_units: number
}

/**
 * Convert Pcs-mode input to normalized storage values.
 */
export function pcsModeToStorage(enteredPcs: number, unitsPerBox: number): NormalizedStorage {
    const result = computePcsMode({ enteredPcs, unitsPerBox })
    return {
        case_qty: result.boxQty,
        loose_piece_qty: result.loosePcs,
        units_per_case_snapshot: unitsPerBox,
        total_units: result.totalPcs,
    }
}

/**
 * Convert Box-mode input to normalized storage values.
 */
export function boxModeToStorage(boxQty: number, extraPcs: number, unitsPerBox: number): NormalizedStorage {
    const result = computeBoxMode({ boxQty, extraPcs, unitsPerBox })
    return {
        case_qty: result.boxQty,
        loose_piece_qty: result.loosePcs,
        units_per_case_snapshot: unitsPerBox,
        total_units: result.totalPcs,
    }
}

/** Convert stored case_qty + loose_piece_qty back to what Pcs mode would show. */
export function storageToPcsMode(caseQty: number, looseQty: number, unitsPerBox: number): number {
    const upb = unitsPerBox > 0 ? Math.floor(unitsPerBox) : 1
    return Math.max(0, Math.floor(caseQty)) * upb + Math.max(0, Math.floor(looseQty))
}

/** Convert stored case_qty + loose_piece_qty back to what Box mode would show. */
export function storageToBoxMode(caseQty: number, looseQty: number, unitsPerBox: number): { boxQty: number; extraPcs: number } {
    const upb = unitsPerBox > 0 ? Math.floor(unitsPerBox) : 1
    const total = Math.max(0, Math.floor(caseQty)) * upb + Math.max(0, Math.floor(looseQty))
    return {
        boxQty: Math.floor(total / upb),
        extraPcs: total % upb,
    }
}