import { describe, expect, it } from 'vitest'
import { commissionAmount, cycleBounds, cycleLabel, cycleRangeLabel, periodFor } from './cycle'

describe('commission cycles (28th–27th, Asia/Kuala_Lumpur)', () => {
  it('October 2026 runs 28 Sep 00:00 MYT to 28 Oct 00:00 MYT (exclusive)', () => {
    const { startAt, endAt } = cycleBounds('2026-10-01')
    expect(startAt.toISOString()).toBe('2026-09-27T16:00:00.000Z')
    expect(endAt.toISOString()).toBe('2026-10-27T16:00:00.000Z')
    expect(cycleRangeLabel(startAt, endAt)).toBe('28 Sep 2026 – 27 Oct 2026')
    expect(cycleLabel('2026-10-01')).toBe('October 2026 Commission Cycle')
  })

  it('crosses the year and supports calendar months', () => {
    expect(cycleBounds('2026-01-01').startAt.toISOString()).toBe('2025-12-27T16:00:00.000Z')
    const cal = cycleBounds('2026-02-01', 1)
    expect(cal.startAt.toISOString()).toBe('2026-01-31T16:00:00.000Z')
    expect(cal.endAt.toISOString()).toBe('2026-02-28T16:00:00.000Z')
  })

  it('assigns approvals by Malaysia date (brief examples)', () => {
    expect(periodFor(new Date('2026-09-27T23:59:59.999+08:00'))).toBe('2026-09-01') // SO001
    expect(periodFor(new Date('2026-09-28T00:00:00+08:00'))).toBe('2026-10-01') // SO002
    expect(periodFor(new Date('2026-10-27T12:00:00+08:00'))).toBe('2026-10-01') // SO003
    expect(periodFor(new Date('2026-10-29T09:00:00+08:00'))).toBe('2026-11-01') // SO004
    // 27 Sep 17:00 UTC is 28 Sep 01:00 in Kuala Lumpur.
    expect(periodFor(new Date('2026-09-27T17:00:00Z'))).toBe('2026-10-01')
    expect(periodFor(new Date('2026-12-29T10:00:00+08:00'))).toBe('2027-01-01')
  })

  it('every instant falls in exactly one cycle (no gaps, no overlaps)', () => {
    for (const m of ['2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01']) {
      const cur = cycleBounds(m)
      const next = cycleBounds(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1)).toISOString().slice(0, 10))
      expect(cur.endAt.getTime()).toBe(next.startAt.getTime())
      expect(periodFor(new Date(cur.endAt.getTime() - 1))).toBe(m)
      expect(periodFor(cur.startAt)).toBe(m)
    }
  })
})

describe('commission rounding (decimal, half away from zero, 2 dp)', () => {
  it('matches the brief and the database', () => {
    expect(commissionAmount(1607784.0, 0.12)).toBe(1929.34)
    expect(commissionAmount(1608634.0, 0.12)).toBe(1930.36)
    expect(commissionAmount(1607884.0, 0.2278)).toBe(3662.76)
    expect(commissionAmount(750, 0.25)).toBe(1.88)
    expect(commissionAmount(-750, 0.25)).toBe(-1.88)
    expect(commissionAmount(2400, 0.05)).toBe(1.2)
    expect(commissionAmount(0.01, 0.01)).toBe(0)
    expect(commissionAmount(10000, 0.015)).toBe(1.5)
  })
})
