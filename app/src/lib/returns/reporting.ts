/**
 * Return Product management reporting — shared period math, KPI and
 * aggregation logic.
 *
 * Pure and isomorphic: used by the dashboard summary API, the Excel export
 * route (server) and the management PDF generator (client), so every surface
 * reports exactly the same figures. No hardcoded sample data — everything is
 * computed from decorated return case rows.
 */
import { RETURN_STATUSES, RETURN_STATUS_LABELS, RETURN_SOURCE_LABELS, normalizeReturnSourceType, type ReturnStatus, type ReturnSourceType } from './constants'
import type { ReturnCase } from './types'
import { itemLineValue } from './compute'

// ── Report periods ─────────────────────────────────────────────────────────

export type ReportMode = 'monthly' | 'quarterly'

export interface ReportPeriod {
    mode: ReportMode
    year: number
    /** 1–12, used in monthly mode. */
    month: number
    /** 1–4, used in quarterly mode. */
    quarter: number
}

export const MONTH_NAMES = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
] as const

export const MONTH_NAMES_SHORT = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

export function currentPeriod(mode: ReportMode, now: Date = new Date()): ReportPeriod {
    return {
        mode,
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        quarter: Math.floor(now.getMonth() / 3) + 1,
    }
}

/** The immediately preceding month/quarter — the default comparison period. */
export function previousPeriod(p: ReportPeriod): ReportPeriod {
    if (p.mode === 'monthly') {
        const month = p.month === 1 ? 12 : p.month - 1
        const year = p.month === 1 ? p.year - 1 : p.year
        return { ...p, year, month }
    }
    const quarter = p.quarter === 1 ? 4 : p.quarter - 1
    const year = p.quarter === 1 ? p.year - 1 : p.year
    return { ...p, year, quarter }
}

/** Inclusive start / exclusive end of the period, in local time. */
export function periodRange(p: ReportPeriod): { start: Date; end: Date } {
    if (p.mode === 'monthly') {
        return {
            start: new Date(p.year, p.month - 1, 1),
            end: new Date(p.year, p.month, 1),
        }
    }
    const startMonth = (p.quarter - 1) * 3
    return {
        start: new Date(p.year, startMonth, 1),
        end: new Date(p.year, startMonth + 3, 1),
    }
}

/** "July 2026" / "Q3 2026" */
export function periodLabel(p: ReportPeriod): string {
    return p.mode === 'monthly' ? `${MONTH_NAMES[p.month - 1]} ${p.year}` : `Q${p.quarter} ${p.year}`
}

/** "Jul 2026" / "Q3 2026" — compact form for chips and comparison badges. */
export function periodShortLabel(p: ReportPeriod): string {
    return p.mode === 'monthly' ? `${MONTH_NAMES_SHORT[p.month - 1]} ${p.year}` : `Q${p.quarter} ${p.year}`
}

/** "July_2026" / "Q3_2026" — filename token. */
export function periodFileToken(p: ReportPeriod): string {
    return p.mode === 'monthly' ? `${MONTH_NAMES[p.month - 1]}_${p.year}` : `Q${p.quarter}_${p.year}`
}

/** "Return_Product_Report_July_2026.pdf" */
export function reportFilename(p: ReportPeriod, ext: 'pdf' | 'xlsx'): string {
    return `Return_Product_Report_${periodFileToken(p)}.${ext}`
}

/** Stable bucket key: "2026-07" / "2026-Q3". */
export function periodKey(p: ReportPeriod): string {
    return p.mode === 'monthly' ? `${p.year}-${String(p.month).padStart(2, '0')}` : `${p.year}-Q${p.quarter}`
}

/** The period a timestamp falls into, in the given mode. */
export function periodOf(mode: ReportMode, iso: string): ReportPeriod {
    const d = new Date(iso)
    return {
        mode,
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        quarter: Math.floor(d.getMonth() / 3) + 1,
    }
}

/**
 * Trend buckets for the report: all 12 months of the selected year in monthly
 * mode; the 8 quarters ending at the selected quarter in quarterly mode.
 */
export function trendPeriods(p: ReportPeriod): ReportPeriod[] {
    if (p.mode === 'monthly') {
        return Array.from({ length: 12 }, (_, i) => ({ ...p, month: i + 1 }))
    }
    const out: ReportPeriod[] = []
    let cursor = { ...p }
    for (let i = 0; i < 8; i++) {
        out.unshift(cursor)
        cursor = previousPeriod(cursor)
    }
    return out
}

/** Parse untrusted query params into a valid ReportPeriod (or null). */
export function parseReportPeriod(
    mode: string | null,
    year: string | null,
    month: string | null,
    quarter: string | null,
): ReportPeriod | null {
    const m: ReportMode = mode === 'quarterly' ? 'quarterly' : 'monthly'
    const y = Number(year)
    if (!Number.isInteger(y) || y < 2000 || y > 2100) return null
    const mo = Number(month)
    const q = Number(quarter)
    const validMonth = Number.isInteger(mo) && mo >= 1 && mo <= 12 ? mo : 1
    const validQuarter = Number.isInteger(q) && q >= 1 && q <= 4 ? q : 1
    if (m === 'monthly' && !(Number.isInteger(mo) && mo >= 1 && mo <= 12)) return null
    if (m === 'quarterly' && !(Number.isInteger(q) && q >= 1 && q <= 4)) return null
    return { mode: m, year: y, month: validMonth, quarter: validQuarter }
}

// ── Safe comparison deltas ─────────────────────────────────────────────────

export type DeltaDirection = 'up' | 'down' | 'flat'

export interface KpiDelta {
    /** Signed percentage change, null when the previous value was 0 but the current is not. */
    pct: number | null
    direction: DeltaDirection
}

/** Percentage change with divide-by-zero safety. */
export function percentDelta(current: number, previous: number): KpiDelta {
    if (previous === 0 && current === 0) return { pct: 0, direction: 'flat' }
    if (previous === 0) return { pct: null, direction: current > 0 ? 'up' : 'down' }
    const pct = ((current - previous) / previous) * 100
    if (Math.abs(pct) < 0.05) return { pct: 0, direction: 'flat' }
    return { pct, direction: pct > 0 ? 'up' : 'down' }
}

/** "↓ 22.7% vs June 2026" body — the arrow/color is rendered by the caller. */
export function deltaText(delta: KpiDelta, comparisonLabel: string): string {
    if (delta.direction === 'flat') return `No change vs ${comparisonLabel}`
    if (delta.pct == null) return `New vs ${comparisonLabel}`
    return `${delta.direction === 'up' ? '↑' : '↓'} ${Math.abs(delta.pct).toFixed(1)}% vs ${comparisonLabel}`
}

// ── KPIs ───────────────────────────────────────────────────────────────────

export interface ReportKpis {
    /** Number of return cases created in the period. */
    totalReturns: number
    /** Total returned pieces across those cases. */
    totalQty: number
    /** Total return value (RM). */
    totalValue: number
    /** Average return value per case (RM), 0 when there are no cases. */
    avgValue: number
    /** Cases currently exceeding the SLA overdue rule. */
    overdue: number
    /** Cases still in flight — neither completed nor cancelled. */
    open: number
    /** Cases from the period that reached Return Completed. */
    completed: number
    /** completed / totalReturns × 100, 0 when there are no cases. */
    completionRate: number
}

export const EMPTY_KPIS: ReportKpis = {
    totalReturns: 0, totalQty: 0, totalValue: 0, avgValue: 0,
    overdue: 0, open: 0, completed: 0, completionRate: 0,
}

/**
 * KPIs over decorated case rows (total_qty / total_value / is_overdue already
 * computed). All KPIs describe the same cohort — the cases created in the
 * period — so figures are directly comparable across periods.
 */
export function computeKpis(rows: ReturnCase[]): ReportKpis {
    const totalReturns = rows.length
    let totalQty = 0
    let totalValue = 0
    let overdue = 0
    let open = 0
    let completed = 0
    for (const r of rows) {
        totalQty += Number(r.total_qty || 0)
        totalValue += Number(r.total_value || 0)
        if (r.is_overdue) overdue += 1
        if (r.status === 'return_completed') completed += 1
        else if (r.status !== 'return_cancelled') open += 1
    }
    return {
        totalReturns,
        totalQty,
        totalValue,
        avgValue: totalReturns > 0 ? totalValue / totalReturns : 0,
        overdue,
        open,
        completed,
        completionRate: totalReturns > 0 ? (completed / totalReturns) * 100 : 0,
    }
}

export interface ReportKpiDeltas {
    totalReturns: KpiDelta
    totalQty: KpiDelta
    totalValue: KpiDelta
    avgValue: KpiDelta
    overdue: KpiDelta
    completionRate: KpiDelta
}

export function computeKpiDeltas(current: ReportKpis, previous: ReportKpis): ReportKpiDeltas {
    return {
        totalReturns: percentDelta(current.totalReturns, previous.totalReturns),
        totalQty: percentDelta(current.totalQty, previous.totalQty),
        totalValue: percentDelta(current.totalValue, previous.totalValue),
        avgValue: percentDelta(current.avgValue, previous.avgValue),
        overdue: percentDelta(current.overdue, previous.overdue),
        completionRate: percentDelta(current.completionRate, previous.completionRate),
    }
}

// ── Aggregations ───────────────────────────────────────────────────────────

export interface TrendPoint {
    key: string
    label: string
    cases: number
    qty: number
    value: number
}

export interface ReasonSlice {
    reason: string
    label: string
    cases: number
    qty: number
    value: number
    /** Share of total return value, 0–100. */
    pct: number
}

export interface SourceSlice {
    id: string
    name: string
    code: string | null
    sourceType: ReturnSourceType
    cases: number
    qty: number
    value: number
    /** Share of total cases, 0–100. */
    pct: number
}

export interface WarehouseSlice {
    id: string
    name: string
    cases: number
    qty: number
    value: number
    /** Share of total return value, 0–100. */
    pct: number
}

export interface ProductSlice {
    key: string
    name: string
    productLine: string | null
    qty: number
    value: number
    topReason: string | null
}

export interface StatusSlice {
    status: ReturnStatus
    label: string
    cases: number
}

/** Bucket rows into trend points by created_at. */
export function bucketTrend(rows: ReturnCase[], periods: ReportPeriod[]): TrendPoint[] {
    const buckets = new Map<string, TrendPoint>()
    for (const p of periods) {
        buckets.set(periodKey(p), {
            key: periodKey(p),
            label: periodShortLabel(p),
            cases: 0, qty: 0, value: 0,
        })
    }
    for (const r of rows) {
        if (!r.created_at) continue
        const mode = periods[0]?.mode || 'monthly'
        const key = periodKey(periodOf(mode, r.created_at))
        const bucket = buckets.get(key)
        if (!bucket) continue
        bucket.cases += 1
        bucket.qty += Number(r.total_qty || 0)
        bucket.value += Number(r.total_value || 0)
    }
    return Array.from(buckets.values())
}

/** Reason breakdown from item-level quantities/values; pct is by value share. */
export function aggregateByReason(rows: ReturnCase[], reasonLabels: Record<string, string>): ReasonSlice[] {
    const map = new Map<string, ReasonSlice>()
    let grandValue = 0
    for (const r of rows) {
        const seenReasons = new Set<string>()
        for (const it of r.items || []) {
            const code = it.reason || 'unspecified'
            const qty = Number(it.total_units || it.quantity || 0)
            const value = itemLineValue(it)
            grandValue += value
            let slice = map.get(code)
            if (!slice) {
                slice = {
                    reason: code,
                    label: reasonLabels[code] || (code === 'unspecified' ? 'Unspecified' : code),
                    cases: 0, qty: 0, value: 0, pct: 0,
                }
                map.set(code, slice)
            }
            slice.qty += qty
            slice.value += value
            if (!seenReasons.has(code)) {
                slice.cases += 1
                seenReasons.add(code)
            }
        }
    }
    const slices = Array.from(map.values()).sort((a, b) => b.value - a.value)
    for (const s of slices) s.pct = grandValue > 0 ? (s.value / grandValue) * 100 : 0
    return slices
}

/** Reason code that already means "everything else" in the stored data. */
export const OTHER_REASON_CODE = 'other'

/**
 * Display grouping for the Overview ranking bar. Stored reason codes are left
 * untouched — this only decides how they are *shown*: the strongest reasons by
 * value keep their own row and the tail is folded into a single "Other" group,
 * so the bar always reads as a complete breakdown of the period.
 */
export function groupReasonsForDisplay(slices: ReasonSlice[], limit = 4): ReasonSlice[] {
    if (limit < 1 || slices.length === 0) return []

    const named = slices.filter((s) => s.reason !== OTHER_REASON_CODE)
    const stored = slices.filter((s) => s.reason === OTHER_REASON_CODE)

    const fold = (parts: ReasonSlice[]): ReasonSlice => ({
        reason: OTHER_REASON_CODE,
        label: 'Other',
        cases: parts.reduce((n, p) => n + p.cases, 0),
        qty: parts.reduce((n, p) => n + p.qty, 0),
        value: parts.reduce((n, p) => n + p.value, 0),
        pct: parts.reduce((n, p) => n + p.pct, 0),
    })

    // Everything already fits: keep each reason on its own row, "Other" last.
    if (named.length + (stored.length > 0 ? 1 : 0) <= limit) {
        return stored.length > 0 ? [...named, fold(stored)] : named
    }

    const top = named.slice(0, limit - 1)
    return [...top, fold([...named.slice(limit - 1), ...stored])]
}

/** Per-source (Shop / Distributor) breakdown; pct is by case share. */
export function aggregateBySource(rows: ReturnCase[]): SourceSlice[] {
    const map = new Map<string, SourceSlice>()
    for (const r of rows) {
        const org = r.source || r.shop || null
        const id = r.return_source_organization_id || r.shop_org_id || 'unknown'
        let slice = map.get(id)
        if (!slice) {
            slice = {
                id,
                name: org?.org_name || 'Unknown source',
                code: org?.org_code || null,
                sourceType: normalizeReturnSourceType(r.return_source_type),
                cases: 0, qty: 0, value: 0, pct: 0,
            }
            map.set(id, slice)
        }
        slice.cases += 1
        slice.qty += Number(r.total_qty || 0)
        slice.value += Number(r.total_value || 0)
    }
    const total = rows.length
    const slices = Array.from(map.values()).sort((a, b) => b.cases - a.cases || b.value - a.value)
    for (const s of slices) s.pct = total > 0 ? (s.cases / total) * 100 : 0
    return slices
}

/** Per-warehouse breakdown; pct is by value share. */
export function aggregateByWarehouse(rows: ReturnCase[]): WarehouseSlice[] {
    const map = new Map<string, WarehouseSlice>()
    let grandValue = 0
    for (const r of rows) {
        const id = r.return_warehouse_id || 'unassigned'
        let slice = map.get(id)
        if (!slice) {
            slice = {
                id,
                name: r.warehouse?.org_name || 'Unassigned',
                cases: 0, qty: 0, value: 0, pct: 0,
            }
            map.set(id, slice)
        }
        slice.cases += 1
        slice.qty += Number(r.total_qty || 0)
        slice.value += Number(r.total_value || 0)
        grandValue += Number(r.total_value || 0)
    }
    const slices = Array.from(map.values()).sort((a, b) => b.value - a.value)
    for (const s of slices) s.pct = grandValue > 0 ? (s.value / grandValue) * 100 : 0
    return slices
}

/** Per product/variant breakdown with the dominant return reason. */
export function aggregateByProduct(
    rows: ReturnCase[],
    reasonLabels: Record<string, string>,
): ProductSlice[] {
    interface Acc extends ProductSlice { reasonQty: Map<string, number> }
    const map = new Map<string, Acc>()
    for (const r of rows) {
        for (const it of r.items || []) {
            const key = it.variant_id || it.sku || `${it.product_name}|${it.variant_name}`
            const name = [it.product_name, it.variant_name].filter(Boolean).join(' — ') || it.sku || 'Unknown product'
            const qty = Number(it.total_units || it.quantity || 0)
            const value = itemLineValue(it)
            let acc = map.get(key)
            if (!acc) {
                acc = { key, name, productLine: null, qty: 0, value: 0, topReason: null, reasonQty: new Map() }
                map.set(key, acc)
            }
            acc.qty += qty
            acc.value += value
            if (it.reason) acc.reasonQty.set(it.reason, (acc.reasonQty.get(it.reason) || 0) + qty)
        }
    }
    return Array.from(map.values())
        .sort((a, b) => b.qty - a.qty || b.value - a.value)
        .map(({ reasonQty, ...slice }) => {
            let top: string | null = null
            let topQty = -1
            for (const [code, q] of reasonQty) {
                if (q > topQty) { top = code; topQty = q }
            }
            return { ...slice, topReason: top ? (reasonLabels[top] || top) : null }
        })
}

/** Case counts per status, in flow order (cancelled appended when present). */
export function aggregateByStatus(rows: ReturnCase[]): StatusSlice[] {
    const counts = new Map<string, number>()
    for (const r of rows) counts.set(r.status, (counts.get(r.status) || 0) + 1)
    const ordered: ReturnStatus[] = [...RETURN_STATUSES, 'return_cancelled']
    return ordered
        .filter((s) => s !== 'return_cancelled' || (counts.get(s) || 0) > 0)
        .map((status) => ({
            status,
            label: RETURN_STATUS_LABELS[status] || status,
            cases: counts.get(status) || 0,
        }))
}

// ── Recent / detailed row shape shared with the client ─────────────────────

export interface ReportCaseRow {
    id: string
    return_no: string
    return_source_type: ReturnSourceType
    source_id: string | null
    source_name: string | null
    source_code: string | null
    warehouse_id: string | null
    warehouse_name: string | null
    /** Distinct item-level reason codes, so the detailed table can filter by reason without a round trip. */
    reason_codes: string[]
    status: ReturnStatus
    total_qty: number
    total_value: number
    created_at: string
    updated_at: string
    days_open: number
    is_overdue: boolean
}

export function toReportCaseRow(r: ReturnCase): ReportCaseRow {
    const org = r.source || r.shop || null
    return {
        id: r.id,
        return_no: r.return_no,
        return_source_type: normalizeReturnSourceType(r.return_source_type),
        source_id: r.return_source_organization_id || r.shop_org_id || null,
        source_name: org?.org_name || null,
        source_code: org?.org_code || null,
        warehouse_id: r.return_warehouse_id || null,
        warehouse_name: r.warehouse?.org_name || null,
        reason_codes: Array.from(new Set((r.items || []).map((it) => it.reason).filter((c): c is string => Boolean(c)))),
        status: r.status,
        total_qty: Number(r.total_qty || 0),
        total_value: Number(r.total_value || 0),
        created_at: r.created_at,
        updated_at: r.updated_at,
        days_open: Number(r.days_open || 0),
        is_overdue: Boolean(r.is_overdue),
    }
}

// ── Summary payload ────────────────────────────────────────────────────────

export interface ReportAppliedFilters {
    sourceType: ReturnSourceType | null
    sourceName: string | null
    warehouseName: string | null
    reasonLabel: string | null
    statusLabel: string | null
}

export interface ReturnReportSummary {
    period: ReportPeriod
    periodLabel: string
    comparison: ReportPeriod
    comparisonLabel: string
    kpis: ReportKpis
    comparisonKpis: ReportKpis
    deltas: ReportKpiDeltas
    trend: TrendPoint[]
    byReason: ReasonSlice[]
    bySource: SourceSlice[]
    byWarehouse: WarehouseSlice[]
    byProduct: ProductSlice[]
    byStatus: StatusSlice[]
    recent: ReportCaseRow[]
    insights: string[]
    availableYears: number[]
    generatedAt: string
    filters: ReportAppliedFilters
}

// ── Formatting helpers (RM) ────────────────────────────────────────────────

export function formatRM(value: number): string {
    return `RM ${Number(value || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function formatCount(value: number): string {
    return Number(value || 0).toLocaleString('en-MY')
}

/** "153,785.00" — an amount without the prefix, for columns already headed "Value (RM)". */
export function formatAmount(value: number): string {
    return Number(value || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** "RM 153,785" — whole-ringgit form, for KPI cards and rankings that must read at a glance. */
export function formatRMWhole(value: number): string {
    return `RM ${Math.round(Number(value || 0)).toLocaleString('en-MY')}`
}

// ── Key insights ───────────────────────────────────────────────────────────

/**
 * Deterministic management insights computed from the aggregated report — no
 * external AI involved. Returns an empty-period message when there is no data.
 */
export function buildInsights(summary: {
    kpis: ReportKpis
    deltas: ReportKpiDeltas
    byReason: ReasonSlice[]
    bySource: SourceSlice[]
    byWarehouse: WarehouseSlice[]
    byProduct: ProductSlice[]
    periodLabel: string
    comparisonLabel: string
}): string[] {
    const { kpis, deltas, byReason, bySource, byWarehouse, byProduct, periodLabel: pl, comparisonLabel: cl } = summary
    if (kpis.totalReturns === 0) {
        return [`No Return Product activity was recorded for ${pl}.`]
    }

    const insights: string[] = []

    const d = deltas.totalReturns
    if (d.direction === 'flat') {
        insights.push(`Total returns were unchanged compared with ${cl}.`)
    } else if (d.pct == null) {
        insights.push(`Return activity started in ${pl} — there were no returns in ${cl}.`)
    } else {
        insights.push(`Total returns ${d.direction === 'up' ? 'increased' : 'decreased'} by ${Math.abs(d.pct).toFixed(1)}% compared with ${cl}.`)
    }

    const topReason = byReason[0]
    if (topReason && topReason.value > 0) {
        insights.push(`${topReason.label} was the top return reason by value (${topReason.pct.toFixed(1)}%, ${formatRM(topReason.value)}).`)
    }

    const topWarehouse = byWarehouse[0]
    if (topWarehouse && topWarehouse.value > 0) {
        insights.push(`${topWarehouse.name} contributed ${topWarehouse.pct.toFixed(1)}% of total return value.`)
    }

    const topSource = bySource[0]
    if (topSource) {
        insights.push(`${topSource.name} (${RETURN_SOURCE_LABELS[topSource.sourceType]}) had the highest number of returns (${topSource.cases} case${topSource.cases === 1 ? '' : 's'}, ${topSource.pct.toFixed(1)}%).`)
    }

    const od = deltas.overdue
    if (od.direction === 'up') {
        insights.push(od.pct == null
            ? `Overdue returns appeared in ${pl} (${kpis.overdue}) — there were none in ${cl}.`
            : `Overdue returns increased by ${Math.abs(od.pct).toFixed(1)}% compared with ${cl}.`)
    } else if (od.direction === 'down') {
        insights.push(`Overdue returns decreased by ${Math.abs(od.pct ?? 0).toFixed(1)}% compared with ${cl}.`)
    } else if (kpis.overdue > 0) {
        insights.push(`Overdue returns were unchanged at ${kpis.overdue} compared with ${cl}.`)
    }

    const topProduct = byProduct[0]
    if (topProduct && topProduct.qty > 0) {
        insights.push(`${topProduct.name} had the highest returned quantity (${formatCount(topProduct.qty)} pcs).`)
    }

    return insights
}

/**
 * The single management insight shown on the Overview — a deterministic
 * statement about where the period's return value is concentrated. Returns null
 * when the period has too little data for the statement to mean anything, so
 * the caller can simply omit the line rather than pad it with commentary.
 *
 * `periodNoun` is the bare period name used mid-sentence, e.g. "August".
 */
export function buildKeyInsight(
    kpis: ReportKpis,
    reasonGroups: ReasonSlice[],
    periodNoun: string,
): string | null {
    if (kpis.totalReturns === 0 || kpis.totalValue <= 0) return null

    const named = reasonGroups.filter((g) => g.reason !== OTHER_REASON_CODE && g.value > 0)
    const [first, second] = named
    if (!first) return null

    if (second) {
        const combined = first.pct + second.pct
        if (combined >= 50) {
            return `${first.label} and ${second.label} account for ${Math.round(combined)}% of ${periodNoun} return value.`
        }
    }
    if (first.pct >= 40) {
        return `${first.label} accounts for ${Math.round(first.pct)}% of ${periodNoun} return value.`
    }
    return null
}
