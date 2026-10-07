import { describe, expect, it } from 'vitest'
import { normalizeParticipantPhone, isSameParticipantPhone, isReturningContact } from './duplicate'

describe('event-management duplicate policy (phone normalization)', () => {
  it('normalizes Malaysian mobiles to canonical E.164 +60', () => {
    expect(normalizeParticipantPhone('0112345678')).toBe('+60112345678')
    expect(normalizeParticipantPhone('+6011-234 5678')).toBe('+60112345678')
    expect(normalizeParticipantPhone('60112345678')).toBe('+60112345678')
  })

  it('rejects landlines and non-Malaysian / invalid numbers', () => {
    expect(normalizeParticipantPhone('0312345678')).toBeNull() // landline
    expect(normalizeParticipantPhone('abc')).toBeNull()
    expect(normalizeParticipantPhone('')).toBeNull()
    expect(normalizeParticipantPhone(null)).toBeNull()
  })

  it('compares phones after normalization', () => {
    expect(isSameParticipantPhone('0112345678', '+60112345678')).toBe(true)
    expect(isSameParticipantPhone('0112345678', '0119999999')).toBe(false)
  })

  it('matches returning contacts only within the same org and brand', () => {
    const earlierEvents = [
      { id: 'e1', brand_id: 'brand-a', starts_at: '2026-01-01T00:00:00Z' },
      { id: 'e2', brand_id: 'brand-b', starts_at: '2026-01-02T00:00:00Z' },
    ]
    // Same phone already seen in brand-a, current event is brand-a, later start
    expect(
      isReturningContact({
        phone: '0112345678',
        currentEventStartsAt: '2026-02-01T00:00:00Z',
        earlierEvents,
        currentBrandId: 'brand-a',
        seenPhones: new Set(['+60112345678']),
      }),
    ).toBe(true)
    // Different brand: never silently matched across brands
    expect(
      isReturningContact({
        phone: '0112345678',
        currentEventStartsAt: '2026-02-01T00:00:00Z',
        earlierEvents,
        currentBrandId: 'brand-c',
        seenPhones: new Set(['+60112345678']),
      }),
    ).toBe(false)
  })
})
