import { describe, expect, it } from 'vitest'
import { defaultPostingDate, financeToday, isValidPostingDate, toFinanceDate } from './postingDate'

describe('postingDate', () => {
  it('validates YYYY-MM-DD calendar dates', () => {
    expect(isValidPostingDate('2026-10-16')).toBe(true)
    expect(isValidPostingDate('2026-02-30')).toBe(false)
    expect(isValidPostingDate('16/10/2026')).toBe(false)
    expect(isValidPostingDate(undefined)).toBe(false)
  })

  it('uses Malaysia time, not UTC', () => {
    // 2026-11-05 17:30 UTC is already 6 November in Malaysia (UTC+8).
    expect(financeToday(new Date('2026-11-05T17:30:00Z'))).toBe('2026-11-06')
    expect(toFinanceDate('2026-10-15T20:00:00Z')).toBe('2026-10-16')
  })

  it('keeps a date-only string as it is', () => {
    expect(toFinanceDate('2026-10-16')).toBe('2026-10-16')
  })

  it('defaults to the document date', () => {
    const now = new Date('2026-11-06T03:00:00Z')
    expect(defaultPostingDate('2026-10-16T02:00:00Z', now)).toBe('2026-10-16')
  })

  it('falls back to today for a missing, invalid or future document date', () => {
    const now = new Date('2026-11-06T03:00:00Z')
    expect(defaultPostingDate(null, now)).toBe('2026-11-06')
    expect(defaultPostingDate('not a date', now)).toBe('2026-11-06')
    expect(defaultPostingDate('2026-12-01', now)).toBe('2026-11-06')
  })
})
