/**
 * Return Product management reporting — server-side data loader.
 *
 * Single source of truth for the dashboard summary API and the Excel export:
 * both load through here so on-screen figures, Excel and the PDF (built from
 * the same summary payload) always match.
 *
 * Aggregation happens server-side over one windowed query (period ∪ comparison
 * ∪ trend window) with a single organizations lookup — the browser only ever
 * receives aggregates plus slim per-case rows for the detailed table.
 */
import { getReturnContext, type ReturnContext } from './server'
import { decorateCase } from './compute'
import {
    RETURN_STATUS_LABELS, RETURN_SOURCE_LABELS, isReturnSourceType,
    type ReturnStatus, type ReturnSourceType,
} from './constants'
import type { ReturnCase, ReturnSettings } from './types'
import {
    periodRange, periodLabel, previousPeriod, trendPeriods, parseReportPeriod,
    currentPeriod, computeKpis, computeKpiDeltas, bucketTrend, aggregateByReason,
    aggregateBySource, aggregateByWarehouse, aggregateByProduct, aggregateByStatus,
    buildInsights, toReportCaseRow,
    type ReportPeriod, type ReturnReportSummary, type ReportCaseRow,
} from './reporting'

const ORG_SELECT = 'id, org_code, org_name, org_type_code, branch'

/** Slim item projection — only the fields aggregation needs. */
const ITEMS_SELECT =
    'product_id, variant_id, sku, product_name, variant_name, quantity, case_qty, loose_piece_qty, units_per_case_snapshot, total_units, unit_cost, unit_price, reason'

export interface ReportFilters {
    sourceType: ReturnSourceType | null
    sourceId: string | null
    warehouseId: string | null
    reason: string | null
    status: ReturnStatus | null
}

export interface ReportRequest {
    period: ReportPeriod
    comparison: ReportPeriod
    filters: ReportFilters
}

/** Parse and validate the report request from URL search params. */
export function parseReportRequest(sp: URLSearchParams): ReportRequest {
    const now = new Date()
    const period = parseReportPeriod(sp.get('mode'), sp.get('year'), sp.get('month'), sp.get('quarter'))
        || currentPeriod(sp.get('mode') === 'quarterly' ? 'quarterly' : 'monthly', now)
    const comparison = parseReportPeriod(period.mode, sp.get('cmp_year'), sp.get('cmp_month'), sp.get('cmp_quarter'))
        || previousPeriod(period)

    const sourceTypeRaw = sp.get('source_type')
    const statusRaw = sp.get('status')
    return {
        period,
        comparison: { ...comparison, mode: period.mode },
        filters: {
            sourceType: isReturnSourceType(sourceTypeRaw) ? sourceTypeRaw : null,
            sourceId: sp.get('source') || null,
            warehouseId: sp.get('warehouse') || null,
            reason: sp.get('reason') || null,
            status: statusRaw && statusRaw in RETURN_STATUS_LABELS ? statusRaw as ReturnStatus : null,
        },
    }
}

async function loadSettings(admin: any): Promise<ReturnSettings> {
    const { data } = await admin.from('return_settings').select('*').eq('id', 1).maybeSingle()
    return data || {
        default_return_warehouse_id: null,
        sla_submitted_to_received_days: 3,
        sla_received_to_processing_days: 2,
        sla_processing_to_completed_days: 5,
        pdf_instruction_text: null,
        shop_self_service_enabled: true,
    }
}

export interface ReportData {
    summary: ReturnReportSummary
    /** All period cases as slim rows (created desc) for detailed table / Excel / PDF. */
    cases: ReportCaseRow[]
    /** Decorated period rows, for the Excel export's item-level sheets. */
    periodRows: ReturnCase[]
    reasonLabels: Record<string, string>
    generatedBy: string | null
}

/**
 * Load, filter, decorate and aggregate everything the management report needs.
 * Respects the caller's scope: non-managers only ever see their own org's
 * returns, exactly like the existing return routes.
 */
export async function loadReportData(ctx: ReturnContext, request: ReportRequest): Promise<ReportData> {
    const { period, comparison, filters } = request

    // One fetch window covering the report period, the comparison period and
    // the whole trend range.
    const pr = periodRange(period)
    const cr = periodRange(comparison)
    const trend = trendPeriods(period)
    const tr0 = periodRange(trend[0])
    const trN = periodRange(trend[trend.length - 1])
    const windowStart = new Date(Math.min(pr.start.getTime(), cr.start.getTime(), tr0.start.getTime()))
    const windowEnd = new Date(Math.max(pr.end.getTime(), cr.end.getTime(), trN.end.getTime()))

    // return_cases is not yet in the generated Database type (same pattern as
    // the other return routes) — cast keeps this file type-clean.
    let query = (ctx.admin as any)
        .from('return_cases')
        .select(`*, items:return_case_items (${ITEMS_SELECT})`)
        .gte('created_at', windowStart.toISOString())
        .lt('created_at', windowEnd.toISOString())
        .order('created_at', { ascending: false })

    if (!ctx.isManager) {
        // shop_org_id is kept in sync with return_source_organization_id, so
        // scoping on it covers both legacy and worksheet-v2 records.
        query = query.eq('shop_org_id', ctx.orgId || '00000000-0000-0000-0000-000000000000')
    } else if (filters.sourceId) {
        // Primary: the new source column; fall back to legacy shop_org_id rows
        // that were never backfilled.
        query = query.or(
            `return_source_organization_id.eq.${filters.sourceId},and(return_source_organization_id.is.null,shop_org_id.eq.${filters.sourceId})`,
        )
    }
    if (filters.sourceType) query = query.eq('return_source_type', filters.sourceType)
    if (filters.warehouseId) query = query.eq('return_warehouse_id', filters.warehouseId)
    if (filters.status) query = query.eq('status', filters.status)

    const [{ data, error }, settings, reasonLabels, generatedBy, availableYears] = await Promise.all([
        query,
        loadSettings(ctx.admin),
        loadReasonLabels(ctx.admin),
        loadUserName(ctx.admin, ctx.userId),
        loadAvailableYears(ctx),
    ])
    if (error) throw new Error(error.message)

    // Join source/warehouse organizations in one lookup.
    const orgIds: string[] = Array.from(new Set<string>(
        (data || []).flatMap((r: any) => [r.return_source_organization_id || r.shop_org_id, r.return_warehouse_id]).filter(Boolean),
    ))
    let orgMap: Record<string, any> = {}
    if (orgIds.length > 0) {
        const { data: orgs } = await ctx.admin.from('organizations').select(ORG_SELECT).in('id', orgIds)
        orgMap = Object.fromEntries((orgs || []).map((o: any) => [o.id, o]))
    }

    let rows: ReturnCase[] = (data || []).map((r: any) => {
        const source = orgMap[r.return_source_organization_id || r.shop_org_id] || null
        return decorateCase({ ...r, source, shop: source, warehouse: orgMap[r.return_warehouse_id] || null }, settings)
    })

    // Reason is an item-level attribute: keep cases containing at least one
    // matching item (consistent with the detailed reporting endpoint).
    if (filters.reason) {
        rows = rows.filter((r) => (r.items || []).some((it) => it.reason === filters.reason))
    }

    const inRange = (r: ReturnCase, range: { start: Date; end: Date }) => {
        const t = new Date(r.created_at).getTime()
        return t >= range.start.getTime() && t < range.end.getTime()
    }
    const periodRows = rows.filter((r) => inRange(r, pr))
    const comparisonRows = rows.filter((r) => inRange(r, cr))

    const kpis = computeKpis(periodRows)
    const comparisonKpis = computeKpis(comparisonRows)
    const deltas = computeKpiDeltas(kpis, comparisonKpis)
    const byReason = aggregateByReason(periodRows, reasonLabels)
    const bySource = aggregateBySource(periodRows)
    const byWarehouse = aggregateByWarehouse(periodRows)
    const byProduct = aggregateByProduct(periodRows, reasonLabels)
    const byStatus = aggregateByStatus(periodRows)
    const pl = periodLabel(period)
    const cl = periodLabel(comparison)

    const cases = periodRows.map(toReportCaseRow)

    const summary: ReturnReportSummary = {
        period,
        periodLabel: pl,
        comparison,
        comparisonLabel: cl,
        kpis,
        comparisonKpis,
        deltas,
        trend: bucketTrend(rows, trend),
        byReason,
        bySource,
        byWarehouse,
        byProduct,
        byStatus,
        recent: cases.slice(0, 10),
        insights: buildInsights({ kpis, deltas, byReason, bySource, byWarehouse, byProduct, periodLabel: pl, comparisonLabel: cl }),
        availableYears,
        generatedAt: new Date().toISOString(),
        filters: await resolveFilterLabels(ctx, filters, orgMap, reasonLabels),
    }

    return { summary, cases, periodRows, reasonLabels, generatedBy }
}

async function loadReasonLabels(admin: any): Promise<Record<string, string>> {
    const { data } = await admin.from('return_reasons').select('code, label')
    return Object.fromEntries((data || []).map((r: any) => [r.code, r.label]))
}

async function loadUserName(admin: any, userId: string): Promise<string | null> {
    const { data } = await admin.from('users').select('full_name, email').eq('id', userId).maybeSingle()
    return (data as any)?.full_name || (data as any)?.email || null
}

/** Years selectable in the period picker: first return year → max(now, +1 for future planning). */
async function loadAvailableYears(ctx: ReturnContext): Promise<number[]> {
    let query = (ctx.admin as any)
        .from('return_cases')
        .select('created_at')
        .order('created_at', { ascending: true })
        .limit(1)
    if (!ctx.isManager) query = query.eq('shop_org_id', ctx.orgId || '00000000-0000-0000-0000-000000000000')
    const { data } = await query
    const nowYear = new Date().getFullYear()
    const firstYear = data?.[0]?.created_at ? new Date(data[0].created_at).getFullYear() : nowYear
    const from = Math.min(firstYear, nowYear)
    const to = Math.max(nowYear + 1, from)
    return Array.from({ length: to - from + 1 }, (_, i) => from + i)
}

/** Human-readable labels for the applied filters (Excel / PDF headers). */
async function resolveFilterLabels(
    ctx: ReturnContext,
    filters: ReportFilters,
    orgMap: Record<string, any>,
    reasonLabels: Record<string, string>,
) {
    const orgName = async (id: string | null): Promise<string | null> => {
        if (!id) return null
        if (orgMap[id]) return orgMap[id].org_name || null
        const { data } = await ctx.admin.from('organizations').select('org_name').eq('id', id).maybeSingle()
        return (data as any)?.org_name || null
    }
    return {
        sourceType: filters.sourceType,
        sourceName: await orgName(filters.sourceId),
        warehouseName: await orgName(filters.warehouseId),
        reasonLabel: filters.reason ? (reasonLabels[filters.reason] || filters.reason) : null,
        statusLabel: filters.status ? (RETURN_STATUS_LABELS[filters.status] || filters.status) : null,
    }
}

export { getReturnContext, RETURN_SOURCE_LABELS }
