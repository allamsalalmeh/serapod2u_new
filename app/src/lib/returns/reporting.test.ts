import { describe, it, expect } from 'vitest'
import {
    currentPeriod, previousPeriod, periodRange, periodLabel, periodShortLabel,
    periodFileToken, reportFilename, periodKey, trendPeriods, parseReportPeriod,
    percentDelta, deltaText, computeKpis, computeKpiDeltas, bucketTrend,
    aggregateByReason, aggregateBySource, aggregateByWarehouse, aggregateByProduct,
    aggregateByStatus, buildInsights, EMPTY_KPIS,
    groupReasonsForDisplay, buildKeyInsight, toReportCaseRow,
    formatAmount, formatRMWhole,
    type ReportPeriod, type ReasonSlice,
} from './reporting'
import type { ReturnCase } from './types'

const JULY: ReportPeriod = { mode: 'monthly', year: 2026, month: 7, quarter: 3 }
const Q3: ReportPeriod = { mode: 'quarterly', year: 2026, month: 7, quarter: 3 }

function makeCase(overrides: Partial<ReturnCase> = {}): ReturnCase {
    return {
        id: overrides.id || 'case-1',
        return_no: overrides.return_no || 'RET26-000001',
        return_source_type: 'shop',
        return_source_organization_id: 'org-1',
        shop_org_id: 'org-1',
        return_warehouse_id: 'wh-1',
        contact_person: null, contact_phone: null, contact_email: null,
        status: 'return_draft',
        notes: null, reported_date: null, program_snapshot: null, category_snapshot: null,
        received_by: null, received_date: null, processing_notes: null, action_taken: null,
        return_courier: null, tracking_no: null, completed_date: null,
        created_by: null,
        created_at: '2026-07-10T10:00:00Z',
        updated_at: '2026-07-10T10:00:00Z',
        submitted_at: null, received_at: null, processing_started_at: null,
        completed_at: null, cancelled_at: null,
        total_qty: 0, total_value: 0, days_open: 0, is_overdue: false,
        items: [],
        ...overrides,
    } as ReturnCase
}

describe('report periods', () => {
    it('derives the current monthly and quarterly period', () => {
        const now = new Date(2026, 6, 14) // 14 July 2026
        expect(currentPeriod('monthly', now)).toMatchObject({ year: 2026, month: 7 })
        expect(currentPeriod('quarterly', now)).toMatchObject({ year: 2026, quarter: 3 })
    })

    it('steps back across year boundaries', () => {
        expect(previousPeriod({ mode: 'monthly', year: 2026, month: 1, quarter: 1 })).toMatchObject({ year: 2025, month: 12 })
        expect(previousPeriod({ mode: 'quarterly', year: 2026, month: 1, quarter: 1 })).toMatchObject({ year: 2025, quarter: 4 })
        expect(previousPeriod(JULY)).toMatchObject({ year: 2026, month: 6 })
    })

    it('computes month and quarter ranges (end exclusive)', () => {
        const m = periodRange(JULY)
        expect(m.start).toEqual(new Date(2026, 6, 1))
        expect(m.end).toEqual(new Date(2026, 7, 1))
        const q = periodRange(Q3)
        expect(q.start).toEqual(new Date(2026, 6, 1))
        expect(q.end).toEqual(new Date(2026, 9, 1))
    })

    it('formats labels, tokens and filenames', () => {
        expect(periodLabel(JULY)).toBe('July 2026')
        expect(periodLabel(Q3)).toBe('Q3 2026')
        expect(periodShortLabel(JULY)).toBe('Jul 2026')
        expect(periodFileToken(Q3)).toBe('Q3_2026')
        expect(reportFilename(JULY, 'pdf')).toBe('Return_Product_Report_July_2026.pdf')
        expect(reportFilename(Q3, 'xlsx')).toBe('Return_Product_Report_Q3_2026.xlsx')
        expect(periodKey(JULY)).toBe('2026-07')
        expect(periodKey(Q3)).toBe('2026-Q3')
    })

    it('builds trend buckets: 12 months, or 8 trailing quarters', () => {
        const months = trendPeriods(JULY)
        expect(months).toHaveLength(12)
        expect(months[0]).toMatchObject({ month: 1, year: 2026 })
        expect(months[11]).toMatchObject({ month: 12, year: 2026 })

        const quarters = trendPeriods(Q3)
        expect(quarters).toHaveLength(8)
        expect(quarters[7]).toMatchObject({ year: 2026, quarter: 3 })
        expect(quarters[0]).toMatchObject({ year: 2024, quarter: 4 })
    })

    it('parses untrusted period params', () => {
        expect(parseReportPeriod('monthly', '2026', '7', null)).toMatchObject({ mode: 'monthly', year: 2026, month: 7 })
        expect(parseReportPeriod('quarterly', '2026', null, '3')).toMatchObject({ mode: 'quarterly', quarter: 3 })
        expect(parseReportPeriod('monthly', '2026', '13', null)).toBeNull()
        expect(parseReportPeriod('monthly', 'abc', '7', null)).toBeNull()
        expect(parseReportPeriod('quarterly', '2026', null, '5')).toBeNull()
    })
})

describe('percentDelta', () => {
    it('handles divide-by-zero safely', () => {
        expect(percentDelta(0, 0)).toEqual({ pct: 0, direction: 'flat' })
        expect(percentDelta(5, 0)).toEqual({ pct: null, direction: 'up' })
    })

    it('computes signed changes', () => {
        expect(percentDelta(17, 22)).toMatchObject({ direction: 'down' })
        expect(percentDelta(17, 22).pct).toBeCloseTo(-22.7, 1)
        expect(percentDelta(4, 2)).toMatchObject({ pct: 100, direction: 'up' })
        expect(percentDelta(10, 10)).toMatchObject({ pct: 0, direction: 'flat' })
    })

    it('renders delta text', () => {
        expect(deltaText(percentDelta(17, 22), 'June 2026')).toBe('↓ 22.7% vs June 2026')
        expect(deltaText(percentDelta(2, 1), 'Q2 2026')).toBe('↑ 100.0% vs Q2 2026')
        expect(deltaText(percentDelta(0, 0), 'June 2026')).toBe('No change vs June 2026')
        expect(deltaText(percentDelta(3, 0), 'June 2026')).toBe('New vs June 2026')
    })
})

describe('computeKpis', () => {
    it('is all zeros for an empty period', () => {
        expect(computeKpis([])).toEqual(EMPTY_KPIS)
    })

    it('aggregates cases, quantity, value, overdue and completion', () => {
        const rows = [
            makeCase({ id: 'a', total_qty: 10, total_value: 100, status: 'return_completed' }),
            makeCase({ id: 'b', total_qty: 5, total_value: 60, is_overdue: true }),
            makeCase({ id: 'c', total_qty: 5, total_value: 40 }),
        ]
        const kpis = computeKpis(rows)
        expect(kpis.totalReturns).toBe(3)
        expect(kpis.totalQty).toBe(20)
        expect(kpis.totalValue).toBe(200)
        expect(kpis.avgValue).toBeCloseTo(200 / 3)
        expect(kpis.overdue).toBe(1)
        expect(kpis.open).toBe(2)
        expect(kpis.completed).toBe(1)
        expect(kpis.completionRate).toBeCloseTo(33.33, 1)
    })

    it('counts open cases as everything neither completed nor cancelled', () => {
        const kpis = computeKpis([
            makeCase({ id: 'a', status: 'return_completed' }),
            makeCase({ id: 'b', status: 'return_cancelled' }),
            makeCase({ id: 'c', status: 'return_submitted' }),
            makeCase({ id: 'd', status: 'return_processing' }),
        ])
        expect(kpis.totalReturns).toBe(4)
        expect(kpis.open).toBe(2)
    })

    it('produces deltas for every KPI', () => {
        const current = computeKpis([makeCase({ total_qty: 4, total_value: 40 })])
        const deltas = computeKpiDeltas(current, EMPTY_KPIS)
        expect(deltas.totalReturns).toEqual({ pct: null, direction: 'up' })
        expect(deltas.overdue).toEqual({ pct: 0, direction: 'flat' })
    })
})

describe('aggregations', () => {
    const item = (over: Record<string, unknown> = {}) => ({
        id: 'i', return_case_id: 'c', product_id: 'p1', variant_id: 'v1',
        sku: 'SKU-1', product_name: 'Cellera Vanilla 30ml', variant_name: null,
        quantity: 4, case_qty: 1, loose_piece_qty: 0, units_per_case_snapshot: 4,
        total_units: 4, unit_cost: 10, reason: 'damaged', condition: null,
        photo_url: null, notes: null,
        ...over,
    })

    const labels = { damaged: 'Damaged', expired: 'Expired' }

    it('aggregates by reason with value share (pieces valued per case of 4)', () => {
        const rows = [
            makeCase({ id: 'a', items: [item(), item({ variant_id: 'v2', reason: 'expired', total_units: 2, unit_cost: 5 })] as any }),
            makeCase({ id: 'b', items: [item({ total_units: 6 })] as any }),
        ]
        const slices = aggregateByReason(rows, labels)
        expect(slices[0]).toMatchObject({ reason: 'damaged', label: 'Damaged', qty: 10, value: 25, cases: 2 })
        expect(slices[1]).toMatchObject({ reason: 'expired', qty: 2, value: 2.5, cases: 1 })
        expect(slices[0].pct).toBeCloseTo(100 * 25 / 27.5)
    })

    it('aggregates by source with case share and source type', () => {
        const rows = [
            makeCase({ id: 'a', source: { id: 'org-1', org_code: 'SH003', org_name: '24 Street Vapor' }, total_qty: 4, total_value: 40 }),
            makeCase({ id: 'b', source: { id: 'org-1', org_code: 'SH003', org_name: '24 Street Vapor' }, total_qty: 2, total_value: 20 }),
            makeCase({
                id: 'c', return_source_type: 'distributor', return_source_organization_id: 'org-2', shop_org_id: 'org-2',
                source: { id: 'org-2', org_code: 'DS001', org_name: 'Mega Dist' }, total_qty: 1, total_value: 10,
            }),
        ]
        const slices = aggregateBySource(rows)
        expect(slices[0]).toMatchObject({ name: '24 Street Vapor', cases: 2, sourceType: 'shop' })
        expect(slices[0].pct).toBeCloseTo(66.67, 1)
        expect(slices[1]).toMatchObject({ name: 'Mega Dist', sourceType: 'distributor', cases: 1 })
    })

    it('aggregates by warehouse with value share', () => {
        const rows = [
            makeCase({ id: 'a', warehouse: { id: 'wh-1', org_code: null, org_name: 'Balakong' }, total_value: 75 }),
            makeCase({ id: 'b', return_warehouse_id: 'wh-2', warehouse: { id: 'wh-2', org_code: null, org_name: 'Shah Alam' }, total_value: 25 }),
        ]
        const slices = aggregateByWarehouse(rows)
        expect(slices[0]).toMatchObject({ name: 'Balakong', pct: 75 })
        expect(slices[1]).toMatchObject({ name: 'Shah Alam', pct: 25 })
    })

    it('aggregates by product with the dominant reason', () => {
        const rows = [
            makeCase({
                id: 'a', items: [
                    item({ total_units: 6, reason: 'damaged' }),
                    item({ total_units: 2, reason: 'expired' }),
                ] as any,
            }),
        ]
        const slices = aggregateByProduct(rows, labels)
        expect(slices[0]).toMatchObject({ qty: 8, topReason: 'Damaged' })
    })

    it('aggregates by status in flow order, hiding cancelled when empty', () => {
        const rows = [
            makeCase({ id: 'a', status: 'return_draft' }),
            makeCase({ id: 'b', status: 'return_completed' }),
        ]
        const slices = aggregateByStatus(rows)
        expect(slices.map((s) => s.status)).toEqual([
            'return_draft', 'return_submitted', 'return_received', 'return_processing', 'return_completed',
        ])
        expect(slices[0].cases).toBe(1)
        expect(slices[4].cases).toBe(1)
    })

    it('buckets the trend by created_at', () => {
        const rows = [
            makeCase({ id: 'a', created_at: '2026-07-05T02:00:00', total_qty: 4, total_value: 40 }),
            makeCase({ id: 'b', created_at: '2026-06-20T02:00:00', total_qty: 2, total_value: 20 }),
            makeCase({ id: 'c', created_at: '2025-01-01T02:00:00', total_qty: 9, total_value: 90 }), // outside window
        ]
        const points = bucketTrend(rows, trendPeriods(JULY))
        expect(points).toHaveLength(12)
        expect(points[6]).toMatchObject({ label: 'Jul 2026', cases: 1, qty: 4 })
        expect(points[5]).toMatchObject({ label: 'Jun 2026', cases: 1, qty: 2 })
        expect(points[0]).toMatchObject({ cases: 0 })
    })
})

describe('buildInsights', () => {
    const base = {
        periodLabel: 'July 2026',
        comparisonLabel: 'June 2026',
        byReason: [], bySource: [], byWarehouse: [], byProduct: [],
    }

    it('handles an empty period gracefully', () => {
        const insights = buildInsights({
            ...base,
            kpis: EMPTY_KPIS,
            deltas: computeKpiDeltas(EMPTY_KPIS, EMPTY_KPIS),
        })
        expect(insights).toEqual(['No Return Product activity was recorded for July 2026.'])
    })

    it('produces deterministic management insights', () => {
        const current = computeKpis([
            makeCase({ id: 'a', total_qty: 10, total_value: 100, is_overdue: true }),
            makeCase({ id: 'b', total_qty: 5, total_value: 60 }),
        ])
        const previous = computeKpis([
            makeCase({ id: 'p1', total_qty: 8, total_value: 90 }),
            makeCase({ id: 'p2', total_qty: 8, total_value: 90 }),
            makeCase({ id: 'p3', total_qty: 8, total_value: 90 }),
        ])
        const insights = buildInsights({
            ...base,
            kpis: current,
            deltas: computeKpiDeltas(current, previous),
            byReason: [{ reason: 'damaged', label: 'Damaged', cases: 2, qty: 10, value: 120, pct: 75 }],
            byWarehouse: [{ id: 'wh-1', name: 'Balakong', cases: 2, qty: 15, value: 160, pct: 100 }],
            bySource: [{ id: 'o', name: '24 Street Vapor', code: 'SH003', sourceType: 'shop', cases: 2, qty: 15, value: 160, pct: 100 }],
            byProduct: [{ key: 'v1', name: 'Cellera Vanilla 30ml', productLine: null, qty: 10, value: 100, topReason: 'Damaged' }],
        })
        expect(insights.join(' ')).toContain('decreased by 33.3%')
        expect(insights.join(' ')).toContain('Damaged was the top return reason by value')
        expect(insights.join(' ')).toContain('Balakong contributed 100.0% of total return value')
        expect(insights.join(' ')).toContain('Overdue returns appeared in July 2026')
        expect(insights.join(' ')).toContain('Cellera Vanilla 30ml had the highest returned quantity')
    })
})

describe('groupReasonsForDisplay', () => {
    const slice = (reason: string, pct: number, value = pct * 10): ReasonSlice =>
        ({ reason, label: reason, cases: 1, qty: 1, value, pct })

    it('is empty for a period with no reasons', () => {
        expect(groupReasonsForDisplay([], 4)).toEqual([])
    })

    it('keeps every reason on its own row when they already fit', () => {
        const groups = groupReasonsForDisplay([slice('wrong_item', 50), slice('damaged', 30), slice('other', 20)], 4)
        expect(groups.map((g) => g.reason)).toEqual(['wrong_item', 'damaged', 'other'])
        expect(groups[2].label).toBe('Other')
    })

    it('folds the tail into a single Other group that keeps the totals', () => {
        const groups = groupReasonsForDisplay([
            slice('wrong_item', 36), slice('packaging_change', 35), slice('damaged', 18),
            slice('expired', 6), slice('leaking', 3), slice('other', 2),
        ], 4)
        expect(groups).toHaveLength(4)
        expect(groups.map((g) => g.reason)).toEqual(['wrong_item', 'packaging_change', 'damaged', 'other'])
        expect(groups[3].label).toBe('Other')
        expect(groups[3].pct).toBeCloseTo(11)
        expect(groups.reduce((n, g) => n + g.pct, 0)).toBeCloseTo(100)
    })

    it('always sends a stored "other" reason to the tail', () => {
        const groups = groupReasonsForDisplay([slice('other', 60), slice('damaged', 40)], 4)
        expect(groups.map((g) => g.reason)).toEqual(['damaged', 'other'])
    })
})

describe('buildKeyInsight', () => {
    const kpis = { ...EMPTY_KPIS, totalReturns: 27, totalValue: 153_785 }
    const slice = (reason: string, label: string, pct: number): ReasonSlice =>
        ({ reason, label, cases: 1, qty: 1, value: pct * 100, pct })

    it('names the two dominant reasons when they carry the period', () => {
        const insight = buildKeyInsight(kpis, [
            slice('wrong_item', 'Wrong Item', 36),
            slice('packaging_change', 'Packaging Change', 35),
            slice('damaged', 'Damaged', 18),
            slice('other', 'Other', 11),
        ], 'August')
        expect(insight).toBe('Wrong Item and Packaging Change account for 71% of August return value.')
    })

    it('falls back to a single dominant reason', () => {
        const insight = buildKeyInsight(kpis, [
            slice('damaged', 'Damaged', 45),
            slice('other', 'Other', 55),
        ], 'August')
        expect(insight).toBe('Damaged accounts for 45% of August return value.')
    })

    it('stays silent when nothing stands out', () => {
        expect(buildKeyInsight(kpis, [
            slice('wrong_item', 'Wrong Item', 25),
            slice('damaged', 'Damaged', 20),
        ], 'August')).toBeNull()
    })

    it('stays silent when the period has no data', () => {
        expect(buildKeyInsight(EMPTY_KPIS, [slice('damaged', 'Damaged', 100)], 'August')).toBeNull()
    })
})

describe('toReportCaseRow', () => {
    it('carries the ids and reason codes the detailed table filters on', () => {
        const row = toReportCaseRow(makeCase({
            id: 'a',
            return_warehouse_id: 'wh-1',
            warehouse: { id: 'wh-1', org_code: 'WH1', org_name: 'Balakong' },
            source: { id: 'org-1', org_code: 'SH003', org_name: '24 Street Vapor' },
            items: [
                { reason: 'damaged', total_units: 2, unit_cost: 1 },
                { reason: 'damaged', total_units: 1, unit_cost: 1 },
                { reason: null, total_units: 1, unit_cost: 1 },
            ] as any,
        }))
        expect(row.source_id).toBe('org-1')
        expect(row.warehouse_id).toBe('wh-1')
        expect(row.warehouse_name).toBe('Balakong')
        expect(row.reason_codes).toEqual(['damaged'])
    })
})

describe('currency formatting', () => {
    it('formats an amount without the prefix and a whole-ringgit KPI', () => {
        expect(formatAmount(1624)).toBe('1,624.00')
        expect(formatRMWhole(153_784.6)).toBe('RM 153,785')
    })
})
