// @vitest-environment jsdom

import fs from 'node:fs'
import path from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ReportingMonthSelector from '@/components/dashboard/views/reporting/ReportingMonthSelector'
import {
  ALL_ORDER_MONTHS,
  applyOrderMonthFilter,
  orderMonthCreatedAtRange,
  orderMonthDateRange,
  orderMonthHref,
  orderMonthOf,
  parseOrderMonthParam,
} from './order-month-filter'

/**
 * Supply Chain → Orders: Order Month filter (Enhancement03).
 * Month = calendar month of orders.order_date (Malaysia business DATE).
 */

/** 21 Oct 2026, 10:00 MYT. */
const NOW = new Date('2026-10-21T10:00:00+08:00')

const APP_SRC = path.resolve(__dirname, '../..')
const read = (relative: string) => fs.readFileSync(path.resolve(APP_SRC, relative), 'utf8')

/** Records the range conditions a query builder receives. */
function recordingQuery() {
  const calls: Array<[string, string, string]> = []
  const query = {
    gte(column: string, value: string) { calls.push(['gte', column, value]); return query },
    lt(column: string, value: string) { calls.push(['lt', column, value]); return query },
  }
  return { query, calls }
}

/** What Postgres would return for the recorded conditions over an in-memory table. */
function runRecorded(rows: Array<Record<string, string>>, calls: Array<[string, string, string]>) {
  return rows.filter((row) => calls.every(([op, column, value]) => {
    const cell = column === 'created_at' ? new Date(row[column]).toISOString() : row[column]
    return op === 'gte' ? cell >= value : cell < value
  }))
}

const ORDERS = [
  { order_no: 'SO26000151', status: 'cancelled', order_date: '2026-10-03', created_at: '2026-10-03T02:00:00.000Z' },
  { order_no: 'SO26000140', status: 'closed', order_date: '2026-10-01', created_at: '2026-09-30T16:30:00.000Z' }, // 00:30 MYT 1 Oct
  { order_no: 'SO26000152', status: 'draft', order_date: '2026-10-31', created_at: '2026-10-31T15:59:00.000Z' }, // 23:59 MYT 31 Oct
  { order_no: 'SO26000120', status: 'approved', order_date: '2026-09-30', created_at: '2026-09-30T15:59:59.000Z' }, // 23:59 MYT 30 Sep
  { order_no: 'SO26000099', status: 'submitted', order_date: '2026-09-01', created_at: '2026-10-05T03:00:00.000Z' }, // backdated in October
  { order_no: 'SO26000010', status: 'closed', order_date: '2026-08-15', created_at: '2026-08-15T03:00:00.000Z' },
]

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// ═══ URL parameter ═════════════════════════════════════════════════════════

describe('parseOrderMonthParam', () => {
  it('1. no parameter (fresh entry) is All Months', () => {
    expect(parseOrderMonthParam(null)).toBe(ALL_ORDER_MONTHS)
    expect(parseOrderMonthParam(undefined)).toBe(ALL_ORDER_MONTHS)
    expect(parseOrderMonthParam('')).toBe(ALL_ORDER_MONTHS)
  })

  it('9. restores a valid month, including the current and historical months', () => {
    expect(parseOrderMonthParam('2026-10')).toBe('2026-10')
    expect(parseOrderMonthParam('2026-09')).toBe('2026-09')
    expect(parseOrderMonthParam('2019-01')).toBe('2019-01')
  })

  it('invalid or future months fail safe to All Months', () => {
    for (const bad of ['2026-13', '2026-00', '2026-1', '202610', 'October', 'all', '2026-10-01', '<script>', '2026-11', '2099-01']) {
      expect(parseOrderMonthParam(bad)).toBe(ALL_ORDER_MONTHS)
    }
  })

  it('judges "future" by the Malaysia month, not the UTC month', () => {
    // 1 Nov 00:30 MYT is still 31 Oct in UTC — November is already current.
    vi.setSystemTime(new Date('2026-10-31T16:30:00.000Z'))
    expect(parseOrderMonthParam('2026-11')).toBe('2026-11')
  })
})

describe('orderMonthHref', () => {
  it('sets the month and keeps every other parameter', () => {
    expect(orderMonthHref('/supply-chain/orders', '?foo=1', '2026-10')).toBe('/supply-chain/orders?foo=1&month=2026-10')
    expect(orderMonthHref('/supply-chain/orders', '?month=2026-09', '2026-10')).toBe('/supply-chain/orders?month=2026-10')
  })

  it('All Months removes the parameter, so it shares the fresh-entry URL', () => {
    expect(orderMonthHref('/supply-chain/orders', '?month=2026-10', ALL_ORDER_MONTHS)).toBe('/supply-chain/orders')
    expect(orderMonthHref('/supply-chain/orders', '?foo=1&month=2026-10', ALL_ORDER_MONTHS)).toBe('/supply-chain/orders?foo=1')
  })
})

// ═══ Business-date range ═══════════════════════════════════════════════════

describe('orderMonthDateRange', () => {
  it('is the half-open calendar month of order_date', () => {
    expect(orderMonthDateRange('2026-10')).toEqual({ from: '2026-10-01', toExclusive: '2026-11-01' })
    expect(orderMonthDateRange('2026-09')).toEqual({ from: '2026-09-01', toExclusive: '2026-10-01' })
    expect(orderMonthDateRange('2026-12')).toEqual({ from: '2026-12-01', toExclusive: '2027-01-01' })
    expect(orderMonthDateRange('2028-02')).toEqual({ from: '2028-02-01', toExclusive: '2028-03-01' })
  })

  it('rejects a malformed month', () => {
    expect(() => orderMonthDateRange('2026-13')).toThrow()
  })

  it('created_at fallback uses 00:00 MYT boundaries', () => {
    expect(orderMonthCreatedAtRange('2026-10')).toEqual({
      fromUtc: '2026-09-30T16:00:00.000Z',
      toExclusiveUtc: '2026-10-31T16:00:00.000Z',
    })
  })
})

describe('applyOrderMonthFilter', () => {
  it('5. All Months adds no condition', () => {
    const { query, calls } = recordingQuery()
    expect(applyOrderMonthFilter(query, ALL_ORDER_MONTHS)).toBe(query)
    expect(calls).toEqual([])
    expect(runRecorded(ORDERS, calls)).toHaveLength(ORDERS.length)
  })

  it('2/3. October returns only October business dates, every status including Cancelled SO26000151', () => {
    const { query, calls } = recordingQuery()
    applyOrderMonthFilter(query, '2026-10')
    expect(calls).toEqual([['gte', 'order_date', '2026-10-01'], ['lt', 'order_date', '2026-11-01']])
    expect(runRecorded(ORDERS, calls).map((o) => o.order_no)).toEqual(['SO26000151', 'SO26000140', 'SO26000152'])
  })

  it('4. September excludes SO26000151 and keeps the backdated order created in October', () => {
    const { query, calls } = recordingQuery()
    applyOrderMonthFilter(query, '2026-09')
    const result = runRecorded(ORDERS, calls).map((o) => o.order_no)
    expect(result).toEqual(['SO26000120', 'SO26000099'])
    expect(result).not.toContain('SO26000151')
  })

  it('month boundaries follow the MYT business date, not the UTC instant', () => {
    // SO26000140 was created 30 Sep 16:30 UTC = 1 Oct 00:30 MYT → October.
    const oct = recordingQuery(); applyOrderMonthFilter(oct.query, '2026-10')
    const sep = recordingQuery(); applyOrderMonthFilter(sep.query, '2026-09')
    expect(runRecorded(ORDERS, oct.calls).map((o) => o.order_no)).toContain('SO26000140')
    expect(runRecorded(ORDERS, sep.calls).map((o) => o.order_no)).not.toContain('SO26000140')
  })

  it('the created_at fallback puts the MYT-midnight orders in the same months', () => {
    const { query, calls } = recordingQuery()
    applyOrderMonthFilter(query, '2026-10', { useCreatedAt: true })
    expect(calls[0][1]).toBe('created_at')
    const names = runRecorded(ORDERS, calls).map((o) => o.order_no)
    expect(names).toContain('SO26000140')
    expect(names).toContain('SO26000152')
    expect(names).not.toContain('SO26000120')
  })
})

describe('orderMonthOf', () => {
  it('reads order_date first, then the MYT date of created_at', () => {
    expect(orderMonthOf({ order_date: '2025-03-31' })).toBe('2025-03')
    expect(orderMonthOf({ created_at: '2025-03-31T16:30:00.000Z' })).toBe('2025-04')
    expect(orderMonthOf(null)).toBeNull()
    expect(orderMonthOf({})).toBeNull()
  })
})

// ═══ Shared month selector with All Months ═════════════════════════════════

describe('ReportingMonthSelector with an All Months option', () => {
  const ALL = { value: ALL_ORDER_MONTHS, label: 'All Months' }

  it('1. All Months shows its label and disables both arrows', () => {
    render(
      <ReportingMonthSelector id="m" label="Order Month" month={ALL_ORDER_MONTHS} onMonthChange={() => {}}
        availableMonths={['2026-01']} allOption={ALL} fullWidth />,
    )
    expect(screen.getByText('Order Month')).toBeTruthy()
    expect(screen.getByRole('combobox').textContent).toContain('All Months')
    expect((screen.getByLabelText('Previous month') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('Next month') as HTMLButtonElement).disabled).toBe(true)
  })

  it('6. arrows move exactly one calendar month, through empty months, and Next stops at the current month', async () => {
    const user = userEvent.setup()
    const onMonthChange = vi.fn()
    const { rerender } = render(
      <ReportingMonthSelector id="m" label="Order Month" month="2026-10" onMonthChange={onMonthChange}
        availableMonths={['2026-01']} allOption={ALL} />,
    )
    expect((screen.getByLabelText('Next month') as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByLabelText('Previous month'))
    expect(onMonthChange).toHaveBeenLastCalledWith('2026-09')

    // An empty month in between (no orders in June) is still one step.
    rerender(
      <ReportingMonthSelector id="m" label="Order Month" month="2026-07" onMonthChange={onMonthChange}
        availableMonths={['2026-01']} allOption={ALL} />,
    )
    await user.click(screen.getByLabelText('Previous month'))
    expect(onMonthChange).toHaveBeenLastCalledWith('2026-06')
    await user.click(screen.getByLabelText('Next month'))
    expect(onMonthChange).toHaveBeenLastCalledWith('2026-08')
  })

  it('crosses a year boundary by one month', async () => {
    const user = userEvent.setup()
    const onMonthChange = vi.fn()
    render(
      <ReportingMonthSelector id="m" month="2026-01" onMonthChange={onMonthChange} availableMonths={['2025-06']} allOption={ALL} />,
    )
    await user.click(screen.getByLabelText('Previous month'))
    expect(onMonthChange).toHaveBeenLastCalledWith('2025-12')
  })

  it('without allOption it keeps the Executive Dashboard behaviour and label', () => {
    render(<ReportingMonthSelector id="m" month="2026-10" onMonthChange={() => {}} availableMonths={['2026-08']} />)
    expect(screen.getByText('Reporting Month')).toBeTruthy()
    expect((screen.getByLabelText('Previous month') as HTMLButtonElement).disabled).toBe(false)
  })
})

// ═══ OrdersView wiring ═════════════════════════════════════════════════════

describe('OrdersView Order Month wiring', () => {
  const src = read('components/orders/OrdersView.tsx')

  it('reads the month from the URL only, with All Months as the default', () => {
    expect(src).toMatch(/parseOrderMonthParam\(rawOrderMonth\)/)
    expect(src).toMatch(/searchParams\?\.get\(ORDER_MONTH_PARAM\)/)
    expect(src).not.toMatch(/useState<OrderMonth>/)
  })

  it('9. writes month choices with pushState so Back/Forward step through them', () => {
    expect(src).toMatch(/window\.history\.pushState\(null, '', orderMonthHref\(/)
  })

  it('4. applies the month in the query before the fetch limit', () => {
    const load = src.slice(src.indexOf('const loadOrders = async'), src.indexOf('const loadSummary = async'))
    expect(load).toMatch(/limited\(applyOrderMonthFilter\(baseQuery, orderMonth\)\)/)
    expect(load).toMatch(/\.limit\(ORDER_FETCH_LIMIT\)/)
    // Status / type stay in the query; no client-side month slicing anywhere.
    expect(load).toMatch(/query\.eq\('status', statusFilter\)/)
    expect(src).not.toMatch(/orders\.filter\([^)]*order_date/)
  })

  it('7/8. reloads on month change, resets to page 1, and keeps the summary cards unfiltered', () => {
    expect(src).toMatch(/loadOrders\(\)\n[^\n]*\n\s*\}, \[statusFilter, typeFilter, orderMonth\]\)/)
    expect(src).toMatch(/setCurrentPage\(1\)\n\s*\}, \[searchQuery, statusFilter, typeFilter, sellerFilter, orderMonth\]\)/)
    const summary = src.slice(src.indexOf('const loadSummary = async'))
    expect(summary.slice(0, 800)).not.toMatch(/orderMonth|order_date/)
  })

  it('drops a stale response so quick arrow clicks end on the chosen month', () => {
    expect(src).toMatch(/const requestId = \+\+loadRequestRef\.current/)
    expect(src.match(/if \(requestId !== loadRequestRef\.current\) return/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('renders the shared selector labelled Order Month with All Months', () => {
    expect(src).toMatch(/<ReportingMonthSelector[\s\S]*?label="Order Month"[\s\S]*?allOption=\{\{ value: ALL_ORDER_MONTHS, label: ALL_ORDER_MONTHS_LABEL \}\}/)
  })
})
