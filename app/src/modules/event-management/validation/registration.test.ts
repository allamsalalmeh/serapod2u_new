import { describe, expect, it } from 'vitest'
import { publicRegistrationSchema, normalizeMalaysianMobile, normalizeOptionalEmail } from './registration'

describe('event-management registration validation', () => {
  const base = { token: 'tok', name: 'Amir', phone: '0112345678' }

  it('accepts a valid mandatory submission with no optional fields', () => {
    expect(publicRegistrationSchema.safeParse(base).success).toBe(true)
  })

  it('rejects a missing name', () => {
    expect(publicRegistrationSchema.safeParse({ token: 'tok', phone: '0112345678' }).success).toBe(false)
  })

  it('rejects a missing phone', () => {
    expect(publicRegistrationSchema.safeParse({ token: 'tok', name: 'Amir' }).success).toBe(false)
  })

  it('rejects an invalid Malaysian mobile (landline / garbage)', () => {
    expect(publicRegistrationSchema.safeParse({ ...base, phone: '0312345678' }).success).toBe(false)
    expect(publicRegistrationSchema.safeParse({ ...base, phone: 'abc' }).success).toBe(false)
  })

  it('accepts optional email / cat fields when provided, and empty strings', () => {
    expect(publicRegistrationSchema.safeParse({ ...base, email: 'a@b.com', cat_name: 'Momo' }).success).toBe(true)
    expect(publicRegistrationSchema.safeParse({ ...base, email: '' }).success).toBe(true)
  })

  it('rejects an invalid email', () => {
    expect(publicRegistrationSchema.safeParse({ ...base, email: 'not-an-email' }).success).toBe(false)
  })

  it('normalizes a Malaysian mobile to E.164 +60', () => {
    expect(normalizeMalaysianMobile('0112345678')).toBe('+60112345678')
    expect(normalizeMalaysianMobile('0312345678')).toBeNull()
  })

  it('normalizes email to lowercase trimmed form, null when invalid', () => {
    expect(normalizeOptionalEmail('  Ada@Serapod.com ')).toBe('ada@serapod.com')
    expect(normalizeOptionalEmail('')).toBeNull()
    expect(normalizeOptionalEmail('not-an-email')).toBeNull()
  })
})
