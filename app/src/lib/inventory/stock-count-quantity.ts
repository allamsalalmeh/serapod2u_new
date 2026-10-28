/**
 * Stock Count quantity units — cases ↔ pieces.
 *
 * The ledger is integer CASES for cartridge products and integer PIECES for
 * everything else:
 *
 *   product_inventory.quantity_on_hand      integer   (cases for cartridges)
 *   stock_count_session_items.*_quantity    integer   (same unit as the balance)
 *   record_stock_movement(p_quantity_change integer)   (same unit as the balance)
 *
 * Counting in pieces is therefore an ENTRY convenience, not a second storage
 * unit: a piece count must resolve to whole cases before it can be saved or
 * posted. That is the same policy `post_return_case_inventory` already applies
 * (`floor(total_units / units_per_case)`; loose pieces never reach stock).
 *
 * Pieces per case is resolved centrally by `getUnitsPerCase` in
 * `@/lib/returns/format` (master pack size > 1 wins, Cellera Hero/Zero default
 * 4). Note this is NOT `orders.units_per_case` — that legacy field means
 * cases-per-box (default 100).
 */

import {
    classifyProductLine,
    getUnitsPerCase,
    isCartridgeLine,
} from '@/lib/returns/format'
import type { StockCountUnit } from './stock-count-catalog'

const numberFormat = (value: number) => value.toLocaleString('en-MY')

/**
 * Pieces in one stock case for a Stock Count row.
 *
 * Cartridges resolve through the central pack-size rule; every other product
 * is stocked in pieces, so its factor is exactly 1 (never a pack-size value
 * that happens to sit on master data).
 */
export function resolveCaseUnitsPerCase(
    productName: string | null | undefined,
    masterUnitsPerCase?: number | null,
): number {
    if (!isCartridgeLine(classifyProductLine(productName))) return 1
    const units = getUnitsPerCase(productName, masterUnitsPerCase)
    if (!Number.isFinite(units) || units < 1) return 1
    return Math.floor(units)
}

/**
 * Unit a product's stock is stored in, resolved from its Product Line:
 * cartridges (Hero / Zero) are integer CASES, every other product integer PIECES.
 *
 * Single source for the "which unit is this number in?" question asked by Stock
 * Count, Add Stock and View Inventory, so no screen can quietly disagree.
 */
export function stockUnitForProduct(productName: string | null | undefined): StockCountUnit {
    return isCartridgeLine(classifyProductLine(productName)) ? 'cases' : 'pcs'
}

/** Worksheet/table caption for a unit: "Cases" / "Pcs". */
export function stockUnitDisplayLabel(unit: StockCountUnit): 'Cases' | 'Pcs' {
    return unit === 'cases' ? 'Cases' : 'Pcs'
}

/** "1 case" / "2 cases", "1 pc" / "2 pcs". */
export function quantityUnitLabel(quantity: number, unit: StockCountUnit): string {
    if (unit === 'cases') return Math.abs(quantity) === 1 ? 'case' : 'cases'
    return Math.abs(quantity) === 1 ? 'pc' : 'pcs'
}

/**
 * "3,861 cases" for a case-stocked row, "140 pcs" otherwise.
 *
 * The piece equivalent of a case balance is deliberately NOT shown: "= 15,444
 * pcs" beneath "3,861 cases" invited operators to read the wrong unit. Loose
 * pieces that are really held are shown by formatStockQuantity() instead.
 */
export function formatQuantityWithUnit(
    quantity: number,
    unit: StockCountUnit,
    _unitsPerCase = 1,
): string {
    if (unit === 'pcs') return `${numberFormat(quantity)} ${quantityUnitLabel(quantity, 'pcs')}`
    return `${numberFormat(quantity)} ${quantityUnitLabel(quantity, 'cases')}`
}

/** Same as above with an explicit sign, for variance cells and summaries. */
export function formatSignedQuantityWithUnit(
    quantity: number,
    unit: StockCountUnit,
    unitsPerCase = 1,
): string {
    const sign = quantity > 0 ? '+' : ''
    return `${sign}${formatQuantityWithUnit(quantity, unit, unitsPerCase)}`
}

// ── Pcs-mode entry ────────────────────────────────────────────────────────

export interface PcsEntryConversion {
    /**
     * Whole cases the entry converts to, or null when the entry cannot be
     * stored in the case ledger (blank, invalid, or a partial case).
     */
    cases: number | null
    /** Total pieces typed (0 for blank/invalid input). */
    totalPcs: number
    /** Pieces left over after the last full case (0 when exact). */
    loosePcs: number
    /** Operator-facing explanation, or null when there is nothing to say. */
    message: string | null
}

/**
 * Convert a Pcs-mode entry into the canonical case quantity.
 *
 *   "8"  (4 pcs/case) → 2 cases  → "= 2 cases"
 *   "9"  (4 pcs/case) → null     → "9 pcs is not a whole number of cases…"
 *   ""                → null     → null (blank stays "not counted")
 *
 * A partial case is never rounded: rounding a physical count would post a
 * variance the operator never saw.
 */
export function pcsEntryToCases(raw: string, unitsPerCase: number): PcsEntryConversion {
    const trimmed = raw.trim()
    if (trimmed === '') return { cases: null, totalPcs: 0, loosePcs: 0, message: null }

    if (!/^\d+$/.test(trimmed)) {
        return {
            cases: null,
            totalPcs: 0,
            loosePcs: 0,
            message: 'Physical count must be a whole number of pieces.',
        }
    }

    const totalPcs = Number(trimmed)
    const perCase = Number.isFinite(unitsPerCase) && unitsPerCase >= 1 ? Math.floor(unitsPerCase) : 1
    if (perCase === 1) {
        return { cases: totalPcs, totalPcs, loosePcs: 0, message: null }
    }

    const loosePcs = totalPcs % perCase
    if (loosePcs !== 0) {
        return {
            cases: null,
            totalPcs,
            loosePcs,
            message: `${numberFormat(totalPcs)} pcs is not a whole number of cases (${perCase} pcs per case). Enter a multiple of ${perCase}, or count in cases.`,
        }
    }

    const cases = totalPcs / perCase
    return { cases, totalPcs, loosePcs: 0, message: `= ${numberFormat(cases)} ${quantityUnitLabel(cases, 'cases')}` }
}

/** Pieces shown when a case quantity is opened in Pcs mode. */
export function casesToPcs(cases: number, unitsPerCase: number): number {
    const perCase = Number.isFinite(unitsPerCase) && unitsPerCase >= 1 ? Math.floor(unitsPerCase) : 1
    return Math.max(0, Math.floor(cases)) * perCase
}


// ── Unit-aware totals ─────────────────────────────────────────────────────

/**
 * A set of rows can hold case-stocked cartridges and piece-stocked products at
 * the same time. Adding those raw numbers together (the old "System Qty
 * (Total)") mixed units and produced a meaningless figure, so totals are kept
 * per unit and only rendered together as a labelled string.
 */
export interface QuantityTotals {
    /** Sum of case-denominated quantities. */
    cases: number
    /** Sum of piece-denominated quantities. */
    pcs: number
    /** Piece equivalent of `cases` (display only), using each row's pack size. */
    casePieces: number
}

export const EMPTY_QUANTITY_TOTALS: QuantityTotals = { cases: 0, pcs: 0, casePieces: 0 }

export function addToQuantityTotals(
    totals: QuantityTotals,
    value: number,
    unit: StockCountUnit,
    unitsPerCase = 1,
): QuantityTotals {
    if (!Number.isFinite(value)) return totals
    if (unit === 'pcs') return { ...totals, pcs: totals.pcs + value }
    return {
        ...totals,
        cases: totals.cases + value,
        casePieces: totals.casePieces + value * (unitsPerCase > 0 ? unitsPerCase : 1),
    }
}

export function sumQuantityTotals(
    rows: Array<{ value: number; unit: StockCountUnit; unitsPerCase?: number }>,
): QuantityTotals {
    return rows.reduce(
        (totals, row) => addToQuantityTotals(totals, row.value, row.unit, row.unitsPerCase ?? 1),
        EMPTY_QUANTITY_TOTALS,
    )
}

/**
 * "3,861 cases · 140 pcs" — one labelled part per unit actually present, never
 * a single mixed "units" figure and never a piece equivalent of a case balance.
 */
export function formatQuantityTotals(totals: QuantityTotals): string {
    const parts: string[] = []
    if (totals.cases !== 0 || totals.pcs === 0) {
        parts.push(`${numberFormat(totals.cases)} ${quantityUnitLabel(totals.cases, 'cases')}`)
    }
    if (totals.pcs !== 0) {
        parts.push(`${numberFormat(totals.pcs)} ${quantityUnitLabel(totals.pcs, 'pcs')}`)
    }
    return parts.join(' · ')
}

/**
 * True when a set of rows mixes case and piece denominations, which is when a
 * combined figure must be shown per unit instead of as one number.
 */
export function hasMixedUnits(rows: Array<{ unit: StockCountUnit }>): boolean {
    let cases = false
    let pcs = false
    for (const row of rows) {
        if (row.unit === 'cases') cases = true
        else pcs = true
        if (cases && pcs) return true
    }
    return false
}

// ── Canonical pair: whole cases + loose pieces ────────────────────────────
//
// One quantity, two units. The database stores exactly this pair
// (product_inventory.quantity_on_hand + pcs_on_hand), so every screen reads and
// prints it through the helpers below instead of inventing its own conversion.

export interface StockQuantity {
    /** Whole stock units: cases for cartridges, pieces for everything else. */
    cases: number
    /** Loose pieces on top of the whole units. Always below pcsPerCase. */
    pcs: number
    /** Pieces in one stock unit. 1 for piece-stocked products. */
    pcsPerCase: number
    /**
     * Unit `cases` is denominated in, when the caller knows it.
     *
     * Supply it whenever the row has a product identity (see resolveStockUnit).
     * Without it the formatter can only guess from `pcsPerCase`, and a missing or
     * defaulted ratio of 1 would relabel a known case balance as pieces — the
     * View Inventory defect where 3,861 cases rendered as "3,861 pcs".
     * `unknown` renders the number without claiming either unit.
     */
    unit?: StockCountUnit | 'unknown'
}

const toInt = (value: number | null | undefined) =>
    Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0

/**
 * Fold loose pieces into whole units: 100 cases + 7 pcs at 4 pcs/case becomes
 * 101 cases + 3 pcs. This is a quantity operation only — nothing is physically
 * repacked.
 */
export function normalizeStockQuantity(
    cases: number | null | undefined,
    pcs: number | null | undefined,
    pcsPerCase: number | null | undefined,
): StockQuantity {
    const pack = toInt(pcsPerCase) >= 1 ? toInt(pcsPerCase) : 1
    const rawCases = toInt(cases)
    const rawPcs = toInt(pcs)

    if (pack === 1) {
        // Piece-stocked products have no loose remainder at all.
        return { cases: rawCases + rawPcs, pcs: 0, pcsPerCase: 1 }
    }

    const totalPcs = rawCases * pack + rawPcs
    const sign = totalPcs < 0 ? -1 : 1
    const absPcs = Math.abs(totalPcs)
    return {
        cases: sign * Math.floor(absPcs / pack),
        pcs: sign * (absPcs % pack),
        pcsPerCase: pack,
    }
}

/** Total pieces represented by a pair (the only place the units are added). */
export function stockQuantityTotalPcs(quantity: StockQuantity): number {
    const pack = quantity.pcsPerCase >= 1 ? quantity.pcsPerCase : 1
    return quantity.cases * pack + quantity.pcs
}

export interface StockQuantityLabels {
    /** Main line, e.g. "3,861 cases" / "2 pcs" / "0 cases". */
    primary: string
    /** Secondary line for the loose pieces, e.g. "+ 2 pcs"; null when none. */
    secondary: string | null
    /** Both lines joined for plain-text output (Excel, print, title attrs). */
    text: string
    /** True when there is no stock at all, so callers can mute the styling. */
    isZero: boolean
}

/**
 * The one presentation rule for a stock quantity.
 *
 *   whole units        → "3,861 cases"
 *   units + pieces     → "3,861 cases"  /  "+ 2 pcs"
 *   less than one unit → "2 pcs"        (never "0 cases")
 *   piece-stocked      → "29 pcs"
 *   zero               → "0 cases" / "0 pcs", never "+ 0 pcs"
 */
export function formatStockQuantity(quantity: StockQuantity): StockQuantityLabels {
    const pack = quantity.pcsPerCase >= 1 ? quantity.pcsPerCase : 1
    const cases = toInt(quantity.cases)
    const pcs = toInt(quantity.pcs)
    const unit = quantity.unit ?? (pack === 1 ? 'pcs' : 'cases')

    if (unit === 'unknown') {
        // No product identity and no packing ratio: show the stored figure
        // without inventing a unit for it.
        const primary = numberFormat(cases)
        const secondary = pcs === 0 ? null : `${pcs > 0 ? '+ ' : '- '}${numberFormat(Math.abs(pcs))} ${quantityUnitLabel(pcs, 'pcs')}`
        const text = secondary ? `${primary} ${secondary}` : primary
        return { primary, secondary, text, isZero: cases === 0 && pcs === 0 }
    }

    if (unit === 'pcs') {
        const total = cases + pcs
        const label = `${numberFormat(total)} ${quantityUnitLabel(total, 'pcs')}`
        return { primary: label, secondary: null, text: label, isZero: total === 0 }
    }

    if (cases === 0 && pcs === 0) {
        return { primary: '0 cases', secondary: null, text: '0 cases', isZero: true }
    }

    if (cases === 0) {
        const label = `${numberFormat(pcs)} ${quantityUnitLabel(pcs, 'pcs')}`
        return { primary: label, secondary: null, text: label, isZero: false }
    }

    const primary = `${numberFormat(cases)} ${quantityUnitLabel(cases, 'cases')}`
    if (pcs === 0) return { primary, secondary: null, text: primary, isZero: false }

    const secondary = `${pcs > 0 ? '+ ' : '- '}${numberFormat(Math.abs(pcs))} ${quantityUnitLabel(pcs, 'pcs')}`
    return { primary, secondary, text: `${primary} ${secondary}`, isZero: false }
}

/**
 * Signed change between two pairs, e.g. a movement or a variance.
 *
 * A mixed vector is collapsed to its net pieces ("+1 case, -2 pcs" is really
 * "+2 pcs"), because that is what actually changed on the shelf.
 */
export function formatStockChange(change: StockQuantity): StockQuantityLabels {
    const pack = change.pcsPerCase >= 1 ? change.pcsPerCase : 1
    const cases = toInt(change.cases)
    const pcs = toInt(change.pcs)
    const unit = change.unit ?? (pack === 1 ? 'pcs' : 'cases')
    const noChange: StockQuantityLabels = { primary: 'No change', secondary: null, text: 'No change', isZero: true }
    const signed = (value: number, label: StockCountUnit) =>
        `${value > 0 ? '+' : '-'}${numberFormat(Math.abs(value))} ${quantityUnitLabel(value, label)}`

    if (unit === 'pcs') {
        // Piece-stocked: whole units ARE pieces.
        const net = cases + pcs
        if (net === 0) return noChange
        const label = signed(net, 'pcs')
        return { primary: label, secondary: null, text: label, isZero: false }
    }

    if (cases === 0 && pcs === 0) return noChange

    if (unit === 'cases' && pack > 1) {
        // A known packing ratio lets a mixed vector collapse to its net pieces
        // ("+1 case, -2 pcs" is really "+2 pcs").
        const netPcs = cases * pack + pcs
        if (netPcs === 0) return noChange
        const opposed = cases !== 0 && pcs !== 0 && Math.sign(cases) !== Math.sign(pcs)
        if (opposed) {
            const label = signed(netPcs, 'pcs')
            return { primary: label, secondary: null, text: label, isZero: false }
        }
    }

    const caseLabel: StockCountUnit = unit === 'cases' ? 'cases' : 'pcs'
    if (cases !== 0) {
        const primary = unit === 'unknown'
            ? `${cases > 0 ? '+' : '-'}${numberFormat(Math.abs(cases))}`
            : signed(cases, caseLabel)
        if (pcs === 0) return { primary, secondary: null, text: primary, isZero: false }
        const secondary = `${pcs > 0 ? '+' : '-'} ${numberFormat(Math.abs(pcs))} ${quantityUnitLabel(pcs, 'pcs')}`
        return { primary, secondary, text: `${primary} ${secondary}`, isZero: false }
    }

    const label = signed(pcs, 'pcs')
    return { primary: label, secondary: null, text: label, isZero: false }
}

// ── Unit identity: which unit is this balance in? ─────────────────────────

/** Why a resolved unit/ratio deserves an operator's attention, if it does. */
export interface StockUnitResolution {
    /** Unit the whole-unit balance is denominated in. */
    unit: StockCountUnit | 'unknown'
    /** Pieces per case to use for loose pieces (1 for piece-stocked/unknown). */
    pcsPerCase: number
    /**
     * Where the ratio came from:
     *   balance       — product_inventory.pcs_per_case (> 1) on the balance row(s)
     *   product-line  — Cellera Hero/Zero pack rule (master pack size, else 4)
     *   piece-stocked — product is stocked in pieces
     *   unresolved    — no product identity and no case ratio on the balance
     */
    source: 'balance' | 'product-line' | 'piece-stocked' | 'unresolved'
    /**
     * True when a balance row carried the column default (1) for a
     * case-stocked product. That snapshot is stale, not authoritative: rows
     * created by older writers (adjust_inventory_quantity,
     * fulfill_order_inventory, the stock_movements trigger) never set it, and
     * pcs_on_hand cannot be > 0 while it is 1. The product-line rule wins.
     */
    staleBalanceRatio: boolean
    /** Operator-facing explanation when the unit/ratio is genuinely uncertain. */
    conflict: string | null
}

/**
 * The one answer to "which unit is this balance in, and how many pieces make a
 * case?" for any screen that shows a stored balance.
 *
 * The unit comes from the product line (the same rule as Incoming, Stock Count
 * and Add Stock). The ratio comes from the balance row when it holds a real
 * case ratio (> 1), otherwise from the shared pack rule. A missing or
 * defaulted ratio of 1 can therefore never turn a case-stocked balance into
 * pieces, and a piece-stocked product never acquires cases.
 *
 * Never reads orders.units_per_case (cases per box, default 100).
 */
export function resolveStockUnit(input: {
    productName?: string | null
    /** pcs_per_case from one or more balance rows (missing values ignored). */
    balancePcsPerCase?: ReadonlyArray<number | string | null | undefined> | number | string | null
    /** products.units_per_case master pack size, when known. */
    masterUnitsPerCase?: number | null
}): StockUnitResolution {
    const raw = Array.isArray(input.balancePcsPerCase)
        ? input.balancePcsPerCase
        : [input.balancePcsPerCase as number | string | null | undefined]
    const ratios = Array.from(new Set(
        raw
            .filter((value) => value !== null && value !== undefined && value !== '')
            .map((value) => Math.floor(Number(value)))
            .filter((value) => Number.isFinite(value) && value >= 1),
    ))
    const caseRatios = ratios.filter((value) => value > 1).sort((a, b) => a - b)
    const hasDefaultRatio = ratios.includes(1)
    const mixedMessage = `Configurations record different pieces per case (${caseRatios.join(' / ')}); loose pieces are shown per configuration and are not combined into cases.`
    const hasProduct = typeof input.productName === 'string' && input.productName.trim() !== ''

    if (!hasProduct) {
        if (caseRatios.length > 0) {
            return {
                unit: 'cases',
                pcsPerCase: caseRatios[0],
                source: 'balance',
                staleBalanceRatio: false,
                conflict: caseRatios.length > 1 ? mixedMessage : null,
            }
        }
        return {
            unit: 'unknown',
            pcsPerCase: 1,
            source: 'unresolved',
            staleBalanceRatio: false,
            conflict: 'Product identity is missing, so the stock unit cannot be confirmed.',
        }
    }

    if (stockUnitForProduct(input.productName) === 'pcs') {
        return {
            unit: 'pcs',
            pcsPerCase: 1,
            source: 'piece-stocked',
            staleBalanceRatio: false,
            conflict: caseRatios.length > 0
                ? `The balance records ${caseRatios.join(' / ')} pcs per case, but this product is stocked in pieces. Shown in pieces; check its stock configuration.`
                : null,
        }
    }

    if (caseRatios.length > 0) {
        return {
            unit: 'cases',
            pcsPerCase: caseRatios[0],
            source: 'balance',
            staleBalanceRatio: hasDefaultRatio,
            conflict: caseRatios.length > 1 ? mixedMessage : null,
        }
    }

    return {
        unit: 'cases',
        pcsPerCase: resolveCaseUnitsPerCase(input.productName, input.masterUnitsPerCase),
        source: 'product-line',
        staleBalanceRatio: hasDefaultRatio,
        conflict: null,
    }
}

/** "case" / "pc" for a cost caption ("RM14.00 per case"); "unit" when unknown. */
export function stockUnitCostLabel(unit: StockCountUnit | 'unknown'): 'case' | 'pc' | 'unit' {
    if (unit === 'cases') return 'case'
    if (unit === 'pcs') return 'pc'
    return 'unit'
}

/** Balance row shape shared by the inventory tables and movement reports. */
export interface StockQuantityRowLike {
    quantity_on_hand?: number | null
    pcs_on_hand?: number | null
    pcs_per_case?: number | null
    quantity_allocated?: number | null
    /** Piece-stocked rows never carry a packing ratio. */
    units_per_case?: number | null
}

/** Read the canonical pair out of a balance/movement row. */
export function stockQuantityFromRow(
    row: StockQuantityRowLike,
    pcsPerCase?: number | null,
): StockQuantity {
    const pack = pcsPerCase ?? row.pcs_per_case ?? row.units_per_case ?? 1
    return normalizeStockQuantity(row.quantity_on_hand ?? 0, row.pcs_on_hand ?? 0, pack)
}

export interface StockQuantityEntry {
    /** Whole units typed; null means "not counted" (blank), never zero. */
    cases: number | null
    /** Loose pieces typed; 0 when the box is blank. */
    pcs: number
    /** Canonical pair after folding pieces into units. */
    quantity: StockQuantity | null
    /** Operator-facing problem, or null when the entry is usable. */
    error: string | null
}

/**
 * Parse the two adjacent Physical Count boxes.
 *
 * Entry is normalised when editing is finished, not on every keystroke: typing
 * 100 cases + 7 pcs at 4 pcs/case is accepted as typed and settles to
 * 101 cases + 3 pcs once the operator leaves the row.
 *
 * Both boxes blank  -> not counted (cases: null), which is NOT zero.
 * Only pcs typed    -> counted, with 0 whole units.
 */
export function parseStockQuantityEntry(
    casesText: string,
    pcsText: string,
    pcsPerCase: number,
): StockQuantityEntry {
    const casesTrim = (casesText ?? '').trim()
    const pcsTrim = (pcsText ?? '').trim()

    if (casesTrim === '' && pcsTrim === '') {
        return { cases: null, pcs: 0, quantity: null, error: null }
    }

    if (casesTrim !== '' && !/^\d+$/.test(casesTrim)) {
        return { cases: null, pcs: 0, quantity: null, error: 'Cases must be a whole number.' }
    }
    if (pcsTrim !== '' && !/^\d+$/.test(pcsTrim)) {
        return { cases: null, pcs: 0, quantity: null, error: 'Pieces must be a whole number.' }
    }

    const cases = casesTrim === '' ? 0 : Number(casesTrim)
    const pcs = pcsTrim === '' ? 0 : Number(pcsTrim)
    const pack = pcsPerCase >= 1 ? Math.floor(pcsPerCase) : 1

    return {
        cases,
        pcs,
        quantity: normalizeStockQuantity(cases, pcs, pack),
        error: null,
    }
}

