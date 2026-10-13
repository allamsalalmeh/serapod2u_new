import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ALL_DISTRIBUTORS,
  ALL_STATUS,
  DORMANT_DAYS,
  ELIGIBLE_ORDER_TYPE,
  DISTRIBUTOR_ORG_TYPE,
  ORDER_STATUSES,
  buildDistributorAnalyticsReport,
  buildReportingMonthOptions,
  cadenceDays,
  classifyAction,
  classifyHealth,
  classifyStage,
  currentReportingMonthKey,
  distributorReportFilename,
  emptyAggregate,
  growthPercent,
  productIdentityLabel,
  resolveDistributorReportPeriod,
  riskThresholdDays,
  type DistributorAggregate,
  type DistributorAnalyticsAggregate,
} from './distributor-analytics'
import {
  aggregateDistributorOrders,
  fetchDistributorAnalyticsAggregate,
  filterBusinessDateRange,
  resolveOrderDateColumn,
  type OrderItemRecord,
  type OrderRecord,
} from './distributor-analytics-source'

/** 7 September 2026, 10:00 Malaysia time — the scenario date in the spec. */
const NOW = new Date('2026-09-07T10:00:00+08:00')

const INFY = 'd-infy'
const SAHABAT = 'd-sahabat'
const NEWCO = 'd-newco'

function distributor(partial: Partial<DistributorAggregate> & { distributorId: string }): DistributorAggregate {
  return {
    name: 'Distributor',
    orgCode: null,
    isActive: true,
    currentOrders: 0,
    currentValue: 0,
    previousOrders: 0,
    previousValue: 0,
    firstOrderAt: null,
    lastOrderAt: null,
    lifetimeOrders: 0,
    ...partial,
  }
}

function aggregate(
  partial: Partial<DistributorAnalyticsAggregate> = {},
  month = '2026-09',
): DistributorAnalyticsAggregate {
  return { ...emptyAggregate(month, resolveDistributorReportPeriod(month, NOW)), ...partial }
}

// ═══ A. Period model ═══════════════════════════════════════════════════════

describe('reporting month defaults and boundaries (Asia/Kuala_Lumpur)', () => {
  it('defaults to the current Malaysia month, not the UTC month', () => {
    // 00:30 on 1 September in Malaysia is still 31 August in UTC. The report
    // must open on September regardless.
    expect(currentReportingMonthKey(new Date('2026-09-01T00:30:00+08:00'))).toBe('2026-09')
    expect(currentReportingMonthKey(NOW)).toBe('2026-09')
  })

  it('builds MYT half-open month boundaries, never UTC ones', () => {
    const period = resolveDistributorReportPeriod('2026-09', NOW)
    expect(period.startUtc).toBe('2026-08-31T16:00:00.000Z')
    // Exclusive upper bound: 8 Sep 00:00 MYT, so 7 Sep 23:59 MYT is included
    // and 8 Sep 00:00 MYT is not.
    expect(period.endUtc).toBe('2026-09-07T16:00:00.000Z')
    expect(period.timeZone).toBe('Asia/Kuala_Lumpur')
  })

  it('never offers a future month', () => {
    const options = buildReportingMonthOptions(['2026-11', '2026-10', '2026-09', '2026-08'], '2026-09')
    expect(options.map((option) => option.value)).toEqual(['2026-09', '2026-08'])
  })
})

describe('current month reports month to date against the same elapsed days', () => {
  const period = resolveDistributorReportPeriod('2026-09', NOW)

  it('runs 01 Sep to today and stops there — no future days', () => {
    expect(period.isCurrentMonth).toBe(true)
    expect(period.dayCount).toBe(7)
    expect(period.startDate).toBe('2026-09-01')
    expect(period.endDate).toBe('2026-09-07')
    expect(period.rangeLabel).toBe('01 Sep 2026 – 07 Sep 2026')
  })

  it('compares 01–07 Sep against 01–07 Aug, never against the whole of August', () => {
    expect(period.comparisonMonth).toBe('2026-08')
    expect(period.comparisonDayCount).toBe(7)
    expect(period.comparisonRangeLabel).toBe('01 Aug 2026 – 07 Aug 2026')
    expect(period.comparisonEndUtc).toBe('2026-08-07T16:00:00.000Z')
  })

  it('clamps the comparison window when the previous month is shorter', () => {
    // 30 March against February, which has only 28 days in 2026.
    const march = resolveDistributorReportPeriod('2026-03', new Date('2026-03-30T10:00:00+08:00'))
    expect(march.dayCount).toBe(30)
    expect(march.comparisonDayCount).toBe(28)
    expect(march.comparisonClamped).toBe(true)
  })
})

describe('historical months compare complete calendar months', () => {
  it('August runs 01–31 Aug against 01–31 Jul', () => {
    const period = resolveDistributorReportPeriod('2026-08', NOW)
    expect(period.isCurrentMonth).toBe(false)
    expect(period.dayCount).toBe(31)
    expect(period.rangeLabel).toBe('01 Aug 2026 – 31 Aug 2026')
    expect(period.comparisonDayCount).toBe(31)
    expect(period.comparisonRangeLabel).toBe('01 Jul 2026 – 31 Jul 2026')
    expect(period.comparisonClamped).toBe(false)
  })

  it('January rolls over to the previous December', () => {
    const period = resolveDistributorReportPeriod('2026-01', new Date('2026-09-07T10:00:00+08:00'))
    expect(period.comparisonMonth).toBe('2025-12')
    expect(period.comparisonRangeLabel).toBe('01 Dec 2025 – 31 Dec 2025')
    expect(period.comparisonStartUtc).toBe('2025-11-30T16:00:00.000Z')
  })
})

// ═══ B. Relationship semantics ═════════════════════════════════════════════

describe('New Distributor means first EVER eligible order', () => {
  const period = resolveDistributorReportPeriod('2026-09', NOW)
  const stageOf = (firstOrderAt: string | null, currentOrders: number, previousOrders: number) =>
    classifyStage({
      currentOrders,
      previousOrders,
      firstOrderAt,
      periodStartUtc: period.startUtc,
      periodEndUtc: period.endUtc,
    })

  it('classifies a first-ever order inside the report period as New', () => {
    expect(stageOf('2026-09-03T02:00:00.000Z', 1, 0)).toBe('new')
  })

  it('does NOT call a distributor New because it merely skipped last month', () => {
    // Ordered in January 2025, silent in August 2026, ordering again now. The
    // previous report called this "New"; it is a Returning distributor.
    expect(stageOf('2025-01-14T02:00:00.000Z', 2, 0)).toBe('returning')
  })

  it('classifies trading with earlier history as Returning', () => {
    expect(stageOf('2026-05-01T02:00:00.000Z', 3, 2)).toBe('returning')
  })

  it('classifies comparison-period-only activity as Inactive', () => {
    expect(stageOf('2025-02-01T02:00:00.000Z', 0, 4)).toBe('inactive')
  })

  it('classifies activity in neither window as absent', () => {
    expect(stageOf('2024-02-01T02:00:00.000Z', 0, 0)).toBe('absent')
  })
})

describe('Returning Distributor Rate is relationship retention, not order frequency', () => {
  it('counts distributors active now that traded before the period', () => {
    const report = buildDistributorAnalyticsReport(aggregate({
      current: { orders: 6, orderValue: 600, activeDistributors: 3 },
      previous: { orders: 3, orderValue: 300, activeDistributors: 2 },
      distributors: [
        // Returning: one order this period, but trading history before it.
        distributor({ distributorId: INFY, name: 'Infy Tech Distribution', currentOrders: 1, currentValue: 300, previousOrders: 1, previousValue: 150, firstOrderAt: '2025-03-01T02:00:00.000Z', lastOrderAt: '2026-09-04T02:00:00.000Z', lifetimeOrders: 9 }),
        // Returning: many orders, also historical.
        distributor({ distributorId: SAHABAT, name: 'Sahabat Vape', currentOrders: 4, currentValue: 250, previousOrders: 2, previousValue: 150, firstOrderAt: '2025-06-01T02:00:00.000Z', lastOrderAt: '2026-09-06T02:00:00.000Z', lifetimeOrders: 12 }),
        // New: first ever order inside the report window.
        distributor({ distributorId: NEWCO, name: 'Newco Supply', currentOrders: 1, currentValue: 50, firstOrderAt: '2026-09-02T02:00:00.000Z', lastOrderAt: '2026-09-02T02:00:00.000Z', lifetimeOrders: 1 }),
      ],
    }), NOW)

    expect(report.summary.activeDistributors).toBe(3)
    expect(report.summary.returningDistributors).toBe(2)
    expect(report.summary.returningRatePct).toBeCloseTo(66.7, 1)
    expect(report.relationship.newDistributors).toBe(1)
  })

  it('reports "more than one order this period" separately, never as retention', () => {
    const report = buildDistributorAnalyticsReport(aggregate({
      current: { orders: 5, orderValue: 500, activeDistributors: 2 },
      distributors: [
        distributor({ distributorId: INFY, currentOrders: 4, currentValue: 400, firstOrderAt: '2025-01-01T02:00:00.000Z', lastOrderAt: '2026-09-05T02:00:00.000Z', lifetimeOrders: 20 }),
        distributor({ distributorId: NEWCO, currentOrders: 1, currentValue: 100, firstOrderAt: '2026-09-01T02:00:00.000Z', lastOrderAt: '2026-09-01T02:00:00.000Z', lifetimeOrders: 1 }),
      ],
    }), NOW)

    expect(report.summary.multipleOrderDistributors).toBe(1)
    // The relationship KPI is retention, and is a different number.
    expect(report.summary.returningDistributors).toBe(1)
  })
})

describe('Inactive This Period', () => {
  it('counts comparison-period activity with no report-period order', () => {
    const report = buildDistributorAnalyticsReport(aggregate({
      current: { orders: 1, orderValue: 100, activeDistributors: 1 },
      previous: { orders: 3, orderValue: 400, activeDistributors: 2 },
      distributors: [
        distributor({ distributorId: INFY, currentOrders: 1, currentValue: 100, previousOrders: 1, previousValue: 100, firstOrderAt: '2025-01-01T02:00:00.000Z', lastOrderAt: '2026-09-04T02:00:00.000Z', lifetimeOrders: 8 }),
        // Traded 01–07 Aug, nothing since — Inactive This Period, not churned.
        distributor({ distributorId: SAHABAT, currentOrders: 0, currentValue: 0, previousOrders: 2, previousValue: 300, firstOrderAt: '2025-01-01T02:00:00.000Z', lastOrderAt: '2026-08-06T02:00:00.000Z', lifetimeOrders: 10 }),
      ],
    }), NOW)

    expect(report.relationship.inactiveThisPeriod).toBe(1)
    const row = report.health.rows.find((entry) => entry.distributorId === SAHABAT)!
    expect(row.health).toBe('inactive_period')
    expect(row.isInactiveThisPeriod).toBe(true)
  })
})

// ═══ C. Zero baseline ══════════════════════════════════════════════════════

describe('zero comparison baselines never fabricate growth', () => {
  it('returns null rather than Infinity or a fake +100%', () => {
    expect(growthPercent(400, 0)).toBeNull()
    expect(growthPercent(0, 0)).toBeNull()
    expect(growthPercent(150, 100)).toBe(50)
    expect(growthPercent(50, 100)).toBe(-50)
  })

  it('leaves leaderboard growth null for a distributor with no previous trading', () => {
    const report = buildDistributorAnalyticsReport(aggregate({
      current: { orders: 2, orderValue: 900, activeDistributors: 1 },
      previous: { orders: 0, orderValue: 0, activeDistributors: 0 },
      distributors: [
        distributor({ distributorId: NEWCO, name: 'Newco Supply', currentOrders: 2, currentValue: 900, firstOrderAt: '2026-09-02T02:00:00.000Z', lastOrderAt: '2026-09-05T02:00:00.000Z', lifetimeOrders: 2 }),
      ],
    }), NOW)

    expect(report.leaderboard[0].growthPct).toBeNull()
    // Every period-level comparison with an empty baseline is null too.
    for (const row of report.comparison) {
      if (row.previous === 0 || row.previous === null) expect(row.changePct).toBeNull()
      expect(Number.isFinite(row.changePct ?? 0)).toBe(true)
    }
  })
})

// ═══ D. Risk and action classification ═════════════════════════════════════

describe('cadence-aware risk thresholds', () => {
  it('needs a settled rhythm before deriving a cadence', () => {
    expect(cadenceDays('2026-01-01T00:00:00Z', '2026-03-02T00:00:00Z', 2)).toBeNull()
    // Three orders spanning 60 days is one order every 30 days.
    expect(cadenceDays('2026-01-01T00:00:00Z', '2026-03-02T00:00:00Z', 3)).toBe(30)
  })

  it('falls back to the flat threshold without a cadence and bounds it with one', () => {
    expect(riskThresholdDays(null)).toBe(90)
    // Twice the cadence, floored at the watch threshold and capped at dormancy.
    expect(riskThresholdDays(7)).toBe(45)
    expect(riskThresholdDays(30)).toBe(60)
    expect(riskThresholdDays(200)).toBe(180)
  })
})

describe('health classification', () => {
  const base = { previousOrders: 0, currentValue: 0, previousValue: 0, growthPct: null as number | null, riskThresholdDays: 90 }

  it('puts dormancy and recency ahead of trading movement', () => {
    expect(classifyHealth({ ...base, currentOrders: 0, daysSinceLastOrder: DORMANT_DAYS })).toBe('dormant')
    expect(classifyHealth({ ...base, currentOrders: 0, daysSinceLastOrder: null })).toBe('dormant')
    expect(classifyHealth({ ...base, currentOrders: 0, daysSinceLastOrder: 120 })).toBe('at_risk')
    expect(classifyHealth({ ...base, currentOrders: 0, previousOrders: 3, daysSinceLastOrder: 34 })).toBe('inactive_period')
    expect(classifyHealth({ ...base, currentOrders: 0, daysSinceLastOrder: 60 })).toBe('watch')
  })

  it('never calls a distributor that traded this period dormant', () => {
    expect(classifyHealth({ ...base, currentOrders: 2, currentValue: 500, previousValue: 100, growthPct: 400, daysSinceLastOrder: 1 })).toBe('growing')
  })

  it('uses a ±15% band so ordinary order timing does not read as a trend', () => {
    expect(classifyHealth({ ...base, currentOrders: 2, currentValue: 110, previousValue: 100, growthPct: 10, daysSinceLastOrder: 2 })).toBe('stable')
    expect(classifyHealth({ ...base, currentOrders: 2, currentValue: 130, previousValue: 100, growthPct: 30, daysSinceLastOrder: 2 })).toBe('growing')
    expect(classifyHealth({ ...base, currentOrders: 2, currentValue: 70, previousValue: 100, growthPct: -30, daysSinceLastOrder: 2 })).toBe('declining')
  })

  it('treats trading with no baseline at all as growing, not as flat', () => {
    expect(classifyHealth({ ...base, currentOrders: 1, currentValue: 500, previousValue: 0, growthPct: null, daysSinceLastOrder: 1 })).toBe('growing')
  })
})

describe('action classification', () => {
  it('escalates overdue and dormant accounts to a HIGH review', () => {
    expect(classifyAction({ health: 'at_risk', growthPct: null, previousSharePct: 0, currentOrders: 0 }))
      .toMatchObject({ action: 'review', priority: 'HIGH' })
    expect(classifyAction({ health: 'dormant', growthPct: null, previousSharePct: 0, currentOrders: 0 }))
      .toMatchObject({ action: 'review', priority: 'HIGH' })
  })

  it('raises a re-engagement, and prioritises it for a key account', () => {
    expect(classifyAction({ health: 'inactive_period', growthPct: null, previousSharePct: 2, currentOrders: 0 }))
      .toMatchObject({ action: 're_engage', priority: 'MEDIUM' })
    expect(classifyAction({ health: 'inactive_period', growthPct: null, previousSharePct: 18, currentOrders: 0 }))
      .toMatchObject({ action: 're_engage', priority: 'HIGH' })
    // A severe decline is HIGH whatever the account's size.
    expect(classifyAction({ health: 'declining', growthPct: -55, previousSharePct: 1, currentOrders: 2 }))
      .toMatchObject({ action: 're_engage', priority: 'HIGH' })
    expect(classifyAction({ health: 'declining', growthPct: -19, previousSharePct: 1, currentOrders: 2 }))
      .toMatchObject({ action: 're_engage', priority: 'MEDIUM' })
  })

  it('supports growth and maintains stability', () => {
    expect(classifyAction({ health: 'growing', growthPct: 40, previousSharePct: 5, currentOrders: 3 }))
      .toMatchObject({ action: 'grow', priority: 'NORMAL' })
    expect(classifyAction({ health: 'stable', growthPct: 2, previousSharePct: 5, currentOrders: 3 }))
      .toMatchObject({ action: 'maintain', priority: 'NORMAL' })
  })

  it('every action card count equals the list of rows it opens', () => {
    const report = buildDistributorAnalyticsReport(aggregate({
      current: { orders: 4, orderValue: 1000, activeDistributors: 2 },
      previous: { orders: 4, orderValue: 1200, activeDistributors: 2 },
      distributors: [
        distributor({ distributorId: INFY, currentOrders: 3, currentValue: 900, previousOrders: 2, previousValue: 400, firstOrderAt: '2025-01-01T02:00:00.000Z', lastOrderAt: '2026-09-04T02:00:00.000Z', lifetimeOrders: 20 }),
        distributor({ distributorId: SAHABAT, currentOrders: 1, currentValue: 100, previousOrders: 2, previousValue: 800, firstOrderAt: '2025-01-01T02:00:00.000Z', lastOrderAt: '2026-09-01T02:00:00.000Z', lifetimeOrders: 14 }),
      ],
    }), NOW)

    for (const card of report.actionPlan.summary) {
      expect(report.actionPlan.rows.filter((row) => row.action === card.key)).toHaveLength(card.count)
    }
  })
})

// ═══ E. Leaderboard, contribution, daily trend ═════════════════════════════

describe('leaderboard and contribution', () => {
  const report = buildDistributorAnalyticsReport(aggregate({
    current: { orders: 10, orderValue: 1000, activeDistributors: 4 },
    previous: { orders: 8, orderValue: 800, activeDistributors: 3 },
    distributors: [
      distributor({ distributorId: 'd1', name: 'Alpha', currentOrders: 4, currentValue: 500, previousOrders: 3, previousValue: 400, firstOrderAt: '2025-01-01T02:00:00.000Z', lastOrderAt: '2026-09-05T02:00:00.000Z', lifetimeOrders: 30 }),
      distributor({ distributorId: 'd2', name: 'Beta', currentOrders: 3, currentValue: 300, previousOrders: 3, previousValue: 300, firstOrderAt: '2025-01-01T02:00:00.000Z', lastOrderAt: '2026-09-04T02:00:00.000Z', lifetimeOrders: 24 }),
      distributor({ distributorId: 'd3', name: 'Gamma', currentOrders: 2, currentValue: 150, previousOrders: 2, previousValue: 100, firstOrderAt: '2025-01-01T02:00:00.000Z', lastOrderAt: '2026-09-03T02:00:00.000Z', lifetimeOrders: 18 }),
      distributor({ distributorId: 'd4', name: 'Delta', currentOrders: 1, currentValue: 50, previousOrders: 0, previousValue: 0, firstOrderAt: '2026-09-02T02:00:00.000Z', lastOrderAt: '2026-09-02T02:00:00.000Z', lifetimeOrders: 1 }),
    ],
  }), NOW)

  it('ranks by Order Value descending', () => {
    expect(report.leaderboard.map((row) => row.name)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta'])
    expect(report.leaderboard.map((row) => row.rank)).toEqual([1, 2, 3, 4])
  })

  it("reports each distributor's share of the period Order Value", () => {
    expect(report.leaderboard[0].sharePct).toBe(50)
    expect(report.leaderboard[1].sharePct).toBe(30)
  })

  it('splits contribution into Top 3 / Next 5 / Remaining that sum to the total', () => {
    const bands = report.contribution.bands
    expect(bands.map((band) => band.distributors)).toEqual([3, 1, 0])
    expect(bands[0].orderValue).toBe(950)
    const total = bands.reduce((sum, band) => sum + band.orderValue, 0)
    expect(total).toBe(report.contribution.totalOrderValue)
    // Shares of a non-zero total add up to 100%.
    const shares = bands.reduce((sum, band) => sum + (band.sharePct ?? 0), 0)
    expect(shares).toBeCloseTo(100, 1)
  })

  it('states concentration over the top quintile of active distributors', () => {
    expect(report.contribution.topQuintileCount).toBe(1)
    expect(report.contribution.topQuintileSharePct).toBe(50)
  })
})

describe('daily trend covers the report window only', () => {
  it('runs 1–7 September for the current month, with no 8–30 September zeros', () => {
    const report = buildDistributorAnalyticsReport(aggregate(), NOW)
    expect(report.dailyTrend).toHaveLength(7)
    expect(report.dailyTrend[0].date).toBe('2026-09-01')
    expect(report.dailyTrend[6].date).toBe('2026-09-07')
    expect(report.dailyTrend.some((row) => row.date > '2026-09-07')).toBe(false)
  })

  it('covers every day of a completed month', () => {
    const report = buildDistributorAnalyticsReport(aggregate({}, '2026-08'), NOW)
    expect(report.dailyTrend).toHaveLength(31)
    expect(report.dailyTrend[30].date).toBe('2026-08-31')
  })

  it('carries no twelve-month or multi-month trend anywhere in the report', () => {
    const report = buildDistributorAnalyticsReport(aggregate(), NOW)
    const keys = JSON.stringify(Object.keys(report))
    expect(keys).not.toMatch(/twelveMonth|monthlyTrend|trendMonths/i)
    // Nothing in the DTO spans more than the report window plus its comparison.
    expect(report.dailyTrend.length).toBeLessThanOrEqual(31)
  })
})

// ═══ F. Server-side aggregation ════════════════════════════════════════════

const ORGS = [
  { id: INFY, org_name: 'Infy Tech Distribution' },
  { id: SAHABAT, org_name: 'Sahabat Vape' },
  { id: NEWCO, org_name: 'Newco Supply' },
]

function order(partial: Partial<OrderRecord> & { id: string; buyer_org_id: string; created_at: string }): OrderRecord {
  return { status: 'approved', order_no: partial.id, display_doc_no: null, ...partial }
}

function item(orderId: string, value: number, qty = 1, variantId = 'v1'): OrderItemRecord {
  return { order_id: orderId, variant_id: variantId, product_id: 'p1', qty, line_total: value }
}

describe('server-side aggregation folds orders into the report aggregate', () => {
  // Infy: historic trading, active this period and last.
  // Sahabat: historic trading, active in the comparison window only.
  // Newco: first ever order inside the report window.
  const orders: OrderRecord[] = [
    order({ id: 'o-hist-1', buyer_org_id: INFY, created_at: '2025-03-01T02:00:00.000Z' }),
    order({ id: 'o-hist-2', buyer_org_id: INFY, created_at: '2026-05-10T02:00:00.000Z' }),
    order({ id: 'o-aug-infy', buyer_org_id: INFY, created_at: '2026-08-03T02:00:00.000Z' }),
    order({ id: 'o-sep-infy', buyer_org_id: INFY, created_at: '2026-09-04T02:00:00.000Z' }),
    order({ id: 'o-hist-s', buyer_org_id: SAHABAT, created_at: '2025-08-01T02:00:00.000Z' }),
    order({ id: 'o-aug-sah', buyer_org_id: SAHABAT, created_at: '2026-08-05T02:00:00.000Z' }),
    order({ id: 'o-sep-new', buyer_org_id: NEWCO, created_at: '2026-09-02T02:00:00.000Z', status: 'cancelled' }),
  ]
  const items: OrderItemRecord[] = [
    item('o-aug-infy', 400), item('o-sep-infy', 600, 3),
    item('o-aug-sah', 300), item('o-sep-new', 100, 2),
  ]
  const variants = [{ id: 'v1', product_id: 'p1', variant_name: 'Deluxe Cellera Cartridge [ Banana Vanilla ]', product_code: 'BV', productName: 'Cellera Hero' }]

  const built = aggregateDistributorOrders(orders, items, ORGS, variants, '2026-09', NOW)
  const report = buildDistributorAnalyticsReport(built, NOW)

  it('separates the report window from the comparison window', () => {
    expect(built.current).toMatchObject({ orders: 2, orderValue: 700, activeDistributors: 2 })
    expect(built.previous).toMatchObject({ orders: 2, orderValue: 700, activeDistributors: 2 })
  })

  it('derives first-ever and last-ever order dates from the whole history', () => {
    const infy = built.distributors.find((row) => row.distributorId === INFY)!
    // Business dates (legacy rows: the MYT date of created_at), carried as the
    // instant each Malaysia day starts so recency compares like with like.
    expect(infy.firstOrderDate).toBe('2025-03-01')
    expect(infy.lastOrderDate).toBe('2026-09-04')
    expect(infy.firstOrderAt).toBe('2025-02-28T16:00:00.000Z')
    expect(infy.lastOrderAt).toBe('2026-09-03T16:00:00.000Z')
    expect(infy.lifetimeOrders).toBe(4)
  })

  it('classifies New, Returning and Inactive from that history', () => {
    expect(report.relationship.newDistributors).toBe(1)      // Newco
    expect(report.relationship.returningDistributors).toBe(1) // Infy
    expect(report.relationship.inactiveThisPeriod).toBe(1)    // Sahabat
  })

  it('buckets the daily trend in Malaysia time across the whole window', () => {
    expect(report.dailyTrend).toHaveLength(7)
    // 2026-09-04T02:00Z is 10:00 on 4 September in Malaysia.
    expect(report.dailyTrend.find((row) => row.date === '2026-09-04')?.orders).toBe(1)
    expect(report.dailyTrend.find((row) => row.date === '2026-09-02')?.orderValue).toBe(100)
  })

  it('labels top products canonically rather than by raw UUID', () => {
    expect(report.topProducts[0].label).toBe('Cellera Hero / Banana Vanilla – BV')
    expect(report.topProducts[0].units).toBe(5)
    expect(report.topProducts[0].variantId).toBe('v1')
  })

  it('reports the status mix of the report window for Order Processing Health', () => {
    // Two orders this period: one approved, one cancelled.
    expect(report.orderProcessing.total).toBe(2)
    expect(report.orderProcessing.approvedOrders).toBe(1)
    expect(report.orderProcessing.approvalRatePct).toBe(50)
    expect(report.orderProcessing.cancelledOrders).toBe(1)
  })

  it('scopes the whole report to one distributor when one is selected', () => {
    const scopedOrgs = ORGS.filter((org) => org.id === INFY)
    const scoped = aggregateDistributorOrders(
      orders.filter((row) => row.buyer_org_id === INFY),
      items, scopedOrgs, variants, '2026-09', NOW,
      resolveDistributorReportPeriod('2026-09', NOW), INFY,
    )
    const scopedReport = buildDistributorAnalyticsReport(scoped, NOW)

    expect(scopedReport.distributor.isAll).toBe(false)
    expect(scopedReport.distributor.name).toBe('Infy Tech Distribution')
    expect(scopedReport.summary.totalOrders).toBe(1)
    expect(scopedReport.summary.orderValue).toBe(600)
    expect(scopedReport.summary.activeDistributors).toBe(1)
    // Sahabat and Newco are outside the scope entirely.
    expect(scopedReport.health.rows.map((row) => row.distributorId)).toEqual([INFY])
  })

  it('applies the status filter identically to both windows', () => {
    // Approved-only: the cancelled September order leaves the report, and so
    // does its distributor — from the current window AND from the comparison.
    const approvedOnly = orders.filter((row) => row.status === 'approved')
    const scoped = aggregateDistributorOrders(
      approvedOnly, items, ORGS, variants, '2026-09', NOW,
      resolveDistributorReportPeriod('2026-09', NOW), ALL_DISTRIBUTORS, 'approved',
    )
    expect(scoped.status).toBe('approved')
    expect(scoped.current).toMatchObject({ orders: 1, orderValue: 600, activeDistributors: 1 })
    // The comparison window is measured on the same population, not on all statuses.
    expect(scoped.previous).toMatchObject({ orders: 2, orderValue: 700, activeDistributors: 2 })
    expect(scoped.distributors.find((row) => row.distributorId === NEWCO)).toBeUndefined()
  })

  it('places an order on a half-open boundary in exactly one window', () => {
    // 2026-09-01T00:00 MYT is the first instant of the report window and the
    // instant after the comparison window closes.
    const boundary = aggregateDistributorOrders(
      [order({ id: 'o-edge', buyer_org_id: INFY, created_at: '2026-08-31T16:00:00.000Z' })],
      [item('o-edge', 10)], ORGS, variants, '2026-09', NOW,
    )
    expect(boundary.current.orders).toBe(1)
    expect(boundary.previous.orders).toBe(0)
  })
})

// ═══ F2. Business date: orders.order_date, not orders.created_at ══════════

describe('reporting buckets on the business SO date (orders.order_date)', () => {
  /** 5 October 2026: August and September are both closed months. */
  const OCT = new Date('2026-10-05T10:00:00+08:00')
  // SO dated 31 Aug 2026, keyed into the system on 21 Sep 2026.
  const backdated = order({
    id: 'o-backdated', buyer_org_id: NEWCO, order_date: '2026-08-31', created_at: '2026-09-21T03:00:00.000Z', display_doc_no: 'SO26000300',
  })
  const history: OrderRecord[] = [
    order({ id: 'o-infy-jul', buyer_org_id: INFY, order_date: '2026-07-10', created_at: '2026-07-10T02:00:00.000Z' }),
    order({ id: 'o-infy-aug', buyer_org_id: INFY, order_date: '2026-08-12', created_at: '2026-08-12T02:00:00.000Z' }),
    order({ id: 'o-infy-sep', buyer_org_id: INFY, order_date: '2026-09-09', created_at: '2026-09-09T02:00:00.000Z' }),
    backdated,
  ]
  const lines: OrderItemRecord[] = [
    item('o-infy-jul', 100), item('o-infy-aug', 200), item('o-infy-sep', 300), item('o-backdated', 500, 5),
  ]
  const variants = [{ id: 'v1', product_id: 'p1', variant_name: 'Deluxe Cellera Cartridge [ Banana Vanilla ]', product_code: 'BV', productName: 'Cellera Hero' }]
  const build = (month: string, orders = history, now = OCT) => {
    const aggregate = aggregateDistributorOrders(orders, lines, ORGS, variants, month, now)
    return { aggregate, report: buildDistributorAnalyticsReport(aggregate, now) }
  }
  const aug = build('2026-08')
  const sep = build('2026-09')

  it('13. counts an SO dated 31 Aug but created 21 Sep in August, never in September', () => {
    expect(aug.report.summary.totalOrders).toBe(2)
    expect(aug.report.summary.orderValue).toBe(700)
    expect(sep.report.summary.totalOrders).toBe(1)
    expect(sep.report.summary.orderValue).toBe(300)
    expect(sep.aggregate.recentOrders.map((row) => row.orderId)).not.toContain('o-backdated')
  })

  it('14. places it on 31 Aug in the Daily Sell-In Trend', () => {
    expect(aug.report.dailyTrend.find((row) => row.date === '2026-08-31')).toMatchObject({ orders: 1, orderValue: 500 })
    expect(sep.report.dailyTrend.find((row) => row.date === '2026-09-21')).toMatchObject({ orders: 0, orderValue: 0 })
  })

  it('15. includes it in the August leaderboard, with its AOV and share', () => {
    const newco = aug.report.leaderboard.find((row) => row.distributorId === NEWCO)!
    expect(newco).toMatchObject({ currentOrders: 1, currentValue: 500, aov: 500 })
    expect(newco.sharePct).toBeCloseTo((500 / 700) * 100, 1)
    expect(sep.report.leaderboard.find((row) => row.distributorId === NEWCO)).toBeUndefined()
  })

  it('16. Last Order is the SO date, not the entry time', () => {
    const newco = aug.aggregate.distributors.find((row) => row.distributorId === NEWCO)!
    expect(newco.lastOrderDate).toBe('2026-08-31')
    expect(newco.lastOrderAt).toBe('2026-08-30T16:00:00.000Z')
  })

  it('first order / New Distributor follows the SO date', () => {
    expect(aug.report.relationship.newDistributors).toBe(1)
    const newco = sep.report.health.rows.find((row) => row.distributorId === NEWCO)!
    // In September it traded in the comparison window only: a lost month, not new.
    expect(newco).toMatchObject({ currentOrders: 0, previousOrders: 1, stage: 'inactive' })
  })

  it('17. the previous-period comparison uses the SO date', () => {
    expect(sep.aggregate.previous).toMatchObject({ orders: 2, orderValue: 700, activeDistributors: 2 })
    expect(sep.report.comparison.find((row) => row.key === 'orderValue')).toMatchObject({ current: 300, previous: 700 })
  })

  it('23. keeps the real entry timestamp as the audit value on the order record', () => {
    const row = aug.aggregate.recentOrders.find((entry) => entry.orderId === 'o-backdated')!
    expect(row.orderDate).toBe('2026-08-31')
    expect(row.createdAt).toBe('2026-09-21T03:00:00.000Z')
  })

  it('the running month is still month-to-date with no future days', () => {
    const mtd = build('2026-09', history, new Date('2026-09-21T10:00:00+08:00'))
    expect(mtd.report.dailyTrend).toHaveLength(21)
    expect(mtd.report.period.comparisonDayCount).toBe(21)
    // Comparison is 1–21 Aug: the 31 Aug SO is outside it, the 12 Aug one inside.
    expect(mtd.aggregate.previous).toMatchObject({ orders: 1, orderValue: 200 })
  })

  it('22. an SO dated 31 Aug stays in August even when entered at 00:30 MYT on 1 Sep', () => {
    const edge = aggregateDistributorOrders(
      [order({ id: 'o-edge', buyer_org_id: INFY, order_date: '2026-08-31', created_at: '2026-08-31T16:30:00.000Z' })],
      [item('o-edge', 10)], ORGS, variants, '2026-08', OCT,
    )
    expect(edge.current.orders).toBe(1)
    expect(edge.dailyTrend.find((row) => row.date === '2026-08-31')?.orders).toBe(1)
  })

  it('21. a legacy row without order_date still buckets on its MYT created_at date', () => {
    const legacy = aggregateDistributorOrders(
      [order({ id: 'o-legacy', buyer_org_id: INFY, created_at: '2026-08-31T16:30:00.000Z' })],
      [item('o-legacy', 10)], ORGS, variants, '2026-09', OCT,
    )
    expect(legacy.dailyTrend.find((row) => row.date === '2026-09-01')?.orders).toBe(1)
  })

  it('18. the PDF renders the same DTO and shows the SO date for recent orders', () => {
    const pdf = readFileSync(new URL('./distributor-analytics-pdf.ts', import.meta.url), 'utf8')
    expect(pdf).toContain('formatDay(row.orderDate || row.createdAt)')
    expect(pdf).not.toContain('formatDay(row.createdAt)')
  })
})

describe('RPC payload normalisation', () => {
  const OCT = new Date('2026-10-05T10:00:00+08:00')
  const rpcClient = (payload: any) => ({ rpc: async () => ({ data: payload, error: null }) })
  const payload = (extra: Record<string, unknown>) => ({
    month: '2026-08', distributorId: 'all', distributorName: 'All Distributors', status: 'all',
    current: { orders: 1, orderValue: 500, activeDistributors: 1 },
    previous: { orders: 0, orderValue: 0, activeDistributors: 0 },
    dailyTrend: [], statusBreakdown: [], topProducts: [],
    ...extra,
  })

  it('reads business dates from the order_date RPC and compares instants like with like', async () => {
    const { aggregate, notice } = await fetchDistributorAnalyticsAggregate(rpcClient(payload({
      dateField: 'orders.order_date',
      distributors: [{
        distributorId: NEWCO, name: 'Newco Supply', currentOrders: 1, currentValue: 500, previousOrders: 0, previousValue: 0,
        firstOrderDate: '2026-08-01', lastOrderDate: '2026-08-31',
        // PostgREST serialises timestamptz as +00:00, the period model as Z.
        firstOrderAt: '2026-07-31T16:00:00+00:00', lastOrderAt: '2026-08-30T16:00:00+00:00', lifetimeOrders: 1,
      }],
      recentOrders: [{ orderId: 'o1', orderNo: 'SO26000300', orderDate: '2026-08-31', createdAt: '2026-09-21T03:00:00+00:00', status: 'approved', distributorId: NEWCO, distributorName: 'Newco Supply', orderValue: 500, itemCount: 1 }],
    })), '2026-08', ALL_DISTRIBUTORS, ALL_STATUS, OCT)
    expect(notice).toBeNull()
    expect(aggregate.distributors[0]).toMatchObject({
      firstOrderDate: '2026-08-01', lastOrderDate: '2026-08-31',
      firstOrderAt: '2026-07-31T16:00:00.000Z', lastOrderAt: '2026-08-30T16:00:00.000Z',
    })
    expect(aggregate.recentOrders[0].orderDate).toBe('2026-08-31')
    const report = buildDistributorAnalyticsReport(aggregate, OCT)
    // First order exactly on the window's first day is New (the +00:00 vs Z trap).
    expect(report.relationship.newDistributors).toBe(1)
    expect(report.meta.dateField).toBe('orders.order_date')
  })

  it('says so when the installed RPC still buckets on created_at', async () => {
    const { aggregate, notice } = await fetchDistributorAnalyticsAggregate(rpcClient(payload({
      distributors: [], recentOrders: [{ orderId: 'o1', createdAt: '2026-08-31T16:30:00+00:00', status: 'approved', distributorId: NEWCO, orderValue: 1, itemCount: 1 }],
    })), '2026-08', ALL_DISTRIBUTORS, ALL_STATUS, OCT)
    expect(aggregate.dateField).toBe('orders.created_at')
    expect(notice).toMatch(/still buckets on orders\.created_at/)
    // Legacy recent orders still get a Malaysia business date.
    expect(aggregate.recentOrders[0].orderDate).toBe('2026-09-01')
    expect(buildDistributorAnalyticsReport(aggregate, OCT).meta.dateField).toBe('orders.created_at')
  })
})

describe('application ahead of the order_date migration', () => {
  const client = (error: any) => ({ from: () => ({ select: () => ({ limit: async () => ({ data: [], error }) }) }) })

  it('detects the missing column and falls back to created_at windows at MYT midnight', async () => {
    expect(await resolveOrderDateColumn(client(null))).toBe('order_date')
    expect(await resolveOrderDateColumn(client({ code: '42703', message: 'column orders.order_date does not exist' }))).toBe('created_at')
    await expect(resolveOrderDateColumn(client({ code: '42501', message: 'permission denied' }))).rejects.toMatchObject({ code: '42501' })

    const calls: string[] = []
    const query: any = { gte: (c: string, v: string) => (calls.push(`gte ${c} ${v}`), query), lt: (c: string, v: string) => (calls.push(`lt ${c} ${v}`), query) }
    filterBusinessDateRange(query, 'order_date', '2026-08-01', '2026-09-01')
    filterBusinessDateRange(query, 'created_at', '2026-08-01', '2026-09-01', 'orders.')
    expect(calls).toEqual([
      'gte order_date 2026-08-01', 'lt order_date 2026-09-01',
      'gte orders.created_at 2026-07-31T16:00:00.000Z', 'lt orders.created_at 2026-08-31T16:00:00.000Z',
    ])
  })
})

// ═══ G. Empty state, scope and inclusion semantics ═════════════════════════

describe('empty state', () => {
  it('reports an empty period without NaN or a misleading -100%', () => {
    const report = buildDistributorAnalyticsReport(aggregate(), NOW)
    expect(report.isEmpty).toBe(true)
    expect(report.summary.totalOrders).toBe(0)
    expect(report.summary.avgOrderValue).toBeNull()
    expect(report.summary.returningRatePct).toBeNull()
    expect(report.orderProcessing.approvalRatePct).toBeNull()
    for (const row of report.comparison) {
      expect(row.changePct).toBeNull()
      expect(Number.isNaN(row.current ?? 0)).toBe(false)
    }
  })
})

describe('documented order inclusion semantics', () => {
  it('pins the order type and buyer type the report has always measured', () => {
    expect(ELIGIBLE_ORDER_TYPE).toBe('D2H')
    expect(DISTRIBUTOR_ORG_TYPE).toBe('DIST')
  })

  it('publishes the exact rules in the report meta', () => {
    const report = buildDistributorAnalyticsReport(aggregate(), NOW)
    // Business SO date, not the entry timestamp.
    expect(report.meta.dateField).toBe('orders.order_date')
    expect(report.meta.orderValueField).toBe('sum(order_items.line_total)')
    // All Status includes every status, which is what makes Order Processing
    // Health measurable and is unchanged from the previous report.
    expect(report.meta.statuses).toEqual([...ORDER_STATUSES])
    expect(report.meta.approvedStatuses).toEqual(['approved', 'closed'])
  })

  it('narrows the published statuses when one is selected', () => {
    const report = buildDistributorAnalyticsReport(
      aggregate({ status: 'approved' }), NOW,
    )
    expect(report.meta.statuses).toEqual(['approved'])
    expect(report.status.isAll).toBe(false)
    expect(report.status.label).toBe('Approved')
  })
})

describe('product identity labels', () => {
  it('renders the agreed structure and never a raw UUID', () => {
    expect(productIdentityLabel('Cellera Hero', 'Deluxe Cellera Cartridge [ Banana Vanilla ]', 'BV'))
      .toBe('Cellera Hero / Banana Vanilla – BV')
    expect(productIdentityLabel('Cellera Hero', null, null)).toBe('Cellera Hero')
    expect(productIdentityLabel(null, null, null)).toBe('Unknown product')
  })
})

// ═══ H. PDF shares the report's single data source ═════════════════════════

describe('PDF uses the same report data source as the web report', () => {
  const source = readFileSync(new URL('./distributor-analytics-pdf.ts', import.meta.url), 'utf8')

  it('takes the report DTO as its only data input — it never queries or recomputes', () => {
    expect(source).not.toMatch(/supabase|createClient|fetch\(|\.rpc\(/)
    expect(source).not.toMatch(/buildDistributorAnalyticsReport|aggregateDistributorOrders/)
  })

  it('carries no twelve-month trend', () => {
    expect(source).not.toMatch(/twelveMonth|12[- ]month/i)
  })

  it('names the file by month, MTD suffix and distributor scope', () => {
    const current = resolveDistributorReportPeriod('2026-09', NOW)
    const historical = resolveDistributorReportPeriod('2026-08', NOW)
    const all = { id: ALL_DISTRIBUTORS, name: 'All Distributors', isAll: true }
    const infy = { id: INFY, name: 'Infy Tech Distribution', isAll: false }

    expect(distributorReportFilename(current, all)).toBe('Serapod_Distributor_Report_2026-09_MTD.pdf')
    expect(distributorReportFilename(historical, all)).toBe('Serapod_Distributor_Report_2026-08.pdf')
    expect(distributorReportFilename(current, infy)).toBe('Serapod_Distributor_Infy_Tech_Distribution_2026-09_MTD.pdf')
  })

  it('produces a filename-safe name from anything master data can hold', () => {
    const period = resolveDistributorReportPeriod('2026-09', NOW)
    const awkward = { id: 'x', name: 'Vape / Pods (2026)', isAll: false }
    const filename = distributorReportFilename(period, awkward)
    expect(filename).toBe('Serapod_Distributor_Vape_Pods_2026_2026-09_MTD.pdf')
    expect(filename).not.toContain('/')
  })
})

// ═══ I. The report the UI receives is report-sized ═════════════════════════

describe('browser payload stays report-sized', () => {
  it('carries no raw order population beyond the bounded recent-orders list', () => {
    const orders: OrderRecord[] = Array.from({ length: 250 }, (_, index) =>
      order({ id: `o${index}`, buyer_org_id: INFY, created_at: '2026-09-03T02:00:00.000Z' }))
    const items = orders.map((row) => item(row.id, 100))
    const built = aggregateDistributorOrders(orders, items, ORGS, [], '2026-09', NOW)
    const report = buildDistributorAnalyticsReport(built, NOW)

    expect(report.summary.totalOrders).toBe(250)
    // 250 orders in, at most 20 order rows out.
    expect(report.recentOrders.length).toBeLessThanOrEqual(20)
    expect(JSON.stringify(report).length).toBeLessThan(120_000)
  })
})

describe('Top Products lists every flavour ordered in the period', () => {
  it('keeps all products, ranked by Order Value, not only the top 10', () => {
    const topProducts = Array.from({ length: 14 }, (_, index) => ({
      variantId: `v${index + 1}`,
      productId: 'p1',
      productName: 'Cellera Hero',
      variantName: `Flavour ${index + 1}`,
      productCode: null,
      units: 10 + index,
      orderValue: (index + 1) * 100,
    }))
    const report = buildDistributorAnalyticsReport(aggregate({
      current: { orders: 14, orderValue: 10_500, activeDistributors: 1 },
      topProducts,
    }), NOW)

    expect(report.topProducts).toHaveLength(14)
    expect(report.topProducts[0].variantId).toBe('v14')
    expect(report.topProducts[13].variantId).toBe('v1')
    expect(report.topProducts.map((row) => row.rank)).toEqual(Array.from({ length: 14 }, (_, index) => index + 1))
  })

  it('the database report no longer stops at 10 products', () => {
    const sql = readFileSync(`${__dirname}/../../../../supabase/migrations/20261013150000_distributor_analytics_all_products.sql`, 'utf8')
    const topProductsCte = sql.slice(sql.indexOf('top_products AS ('), sql.indexOf('recent AS ('))
    expect(topProductsCte).toContain('GROUP BY oi.variant_id')
    expect(topProductsCte).not.toMatch(/LIMIT/i)
    expect(sql).toContain('SECURITY INVOKER')
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.reporting_distributor_analytics(text, uuid, text) TO authenticated;')
  })
})
