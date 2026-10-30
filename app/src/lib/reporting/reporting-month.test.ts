import { describe, expect, it } from 'vitest'
import { adjacentReportingMonths, buildReportingMonthOptions, parseReportingMonthParam } from './consumer-analytics'
import { reportingPeriodDateWindow, reportingPeriodFromKey } from './reporting-period'

const values = (options: { value: string }[]) => options.map((option) => option.value)

describe('Reporting Month options — every month in the supported range', () => {
  it('fills months without transactions instead of skipping them', () => {
    // Staging today: scans in May and July but none in June, and none yet in October.
    const options = buildReportingMonthOptions(['2026-09', '2026-07', '2026-05'], '2026-10')
    expect(values(options)).toEqual(['2026-10', '2026-09', '2026-08', '2026-07', '2026-06', '2026-05'])
    expect(options.find((o) => o.value === '2026-06')?.label).toBe('June 2026')
  })

  it('runs across year boundaries', () => {
    expect(values(buildReportingMonthOptions(['2025-11'], '2026-02'))).toEqual(['2026-02', '2026-01', '2025-12', '2025-11'])
  })

  it('offers the current month when nothing is known yet, and never a future month', () => {
    expect(values(buildReportingMonthOptions([], '2026-10'))).toEqual(['2026-10'])
    expect(values(buildReportingMonthOptions(['2027-03', '2026-12'], '2026-10'))).toEqual(['2026-10'])
  })

  it('ignores malformed keys', () => {
    expect(values(buildReportingMonthOptions(['2026-13', 'garbage', ''], '2026-10'))).toEqual(['2026-10'])
  })
})

describe('previous / next navigation', () => {
  const options = buildReportingMonthOptions(['2025-11'], '2026-02')

  it('steps one calendar month at a time, December ↔ January included', () => {
    expect(adjacentReportingMonths(options, '2026-01')).toEqual({ older: '2025-12', newer: '2026-02' })
    expect(adjacentReportingMonths(options, '2025-12')).toEqual({ older: '2025-11', newer: '2026-01' })
  })

  it('stops at the current month and at the earliest supported month', () => {
    expect(adjacentReportingMonths(options, '2026-02').newer).toBeUndefined()
    expect(adjacentReportingMonths(options, '2025-11').older).toBeUndefined()
  })

  it('walks consecutively across an empty month', () => {
    const sparse = buildReportingMonthOptions(['2026-05', '2026-07'], '2026-08')
    let month = '2026-08'
    const visited = [month]
    for (let next = adjacentReportingMonths(sparse, month).older; next; next = adjacentReportingMonths(sparse, month).older) {
      month = next
      visited.push(month)
    }
    expect(visited).toEqual(['2026-08', '2026-07', '2026-06', '2026-05'])
  })
})

describe('?month= URL parameter', () => {
  it('accepts a valid past or current month', () => {
    expect(parseReportingMonthParam('2026-09', '2026-10')).toBe('2026-09')
    expect(parseReportingMonthParam('2026-10', '2026-10')).toBe('2026-10')
  })

  it('rejects malformed and future months so the caller falls back explicitly', () => {
    for (const bad of ['2026-13', '2026-1', 'October', '', null, undefined, '2026-11']) {
      expect(parseReportingMonthParam(bad as any, '2026-10')).toBeNull()
    }
  })
})

describe('reportingPeriodDateWindow — month-to-date compares equal days', () => {
  const october = reportingPeriodFromKey('2026-10')!

  it('runs the current month to today and compares the same elapsed days of last month', () => {
    const w = reportingPeriodDateWindow(october, new Date('2026-10-20T10:00:00+08:00'))
    expect(w.start.toISOString()).toBe('2026-09-30T16:00:00.000Z') // 1 Oct 00:00 MYT
    expect(w.end.toISOString()).toBe('2026-10-20T16:00:00.000Z') // 21 Oct 00:00 MYT
    expect(w.prevStart.toISOString()).toBe('2026-08-31T16:00:00.000Z') // 1 Sep 00:00 MYT
    expect(w.prevEnd.toISOString()).toBe('2026-09-20T16:00:00.000Z') // 21 Sep 00:00 MYT
  })

  it('uses Malaysia time at the day boundary (00:30 MYT is still the previous UTC day)', () => {
    const w = reportingPeriodDateWindow(october, new Date('2026-10-04T16:30:00Z')) // 5 Oct 00:30 MYT
    expect(w.end.toISOString()).toBe('2026-10-05T16:00:00.000Z')
  })

  it('clamps the comparison to a shorter previous month', () => {
    const march = reportingPeriodFromKey('2026-03')!
    const w = reportingPeriodDateWindow(march, new Date('2026-03-31T12:00:00+08:00'))
    expect(w.prevEnd.toISOString()).toBe('2026-02-28T16:00:00.000Z') // 1 Mar 00:00 MYT — all 28 Feb days
  })

  it('reports a historical month as the whole month against the whole previous month', () => {
    const w = reportingPeriodDateWindow(reportingPeriodFromKey('2026-01')!, new Date('2026-10-20T10:00:00+08:00'))
    expect(w.start.toISOString()).toBe('2025-12-31T16:00:00.000Z')
    expect(w.end.toISOString()).toBe('2026-01-31T16:00:00.000Z')
    expect(w.prevStart.toISOString()).toBe('2025-11-30T16:00:00.000Z')
    expect(w.prevEnd.toISOString()).toBe('2025-12-31T16:00:00.000Z')
  })
})
