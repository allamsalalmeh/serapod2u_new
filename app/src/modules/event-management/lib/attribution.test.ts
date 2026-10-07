import { describe, expect, it } from 'vitest'
import { resolveAttributedStaff, isBoothRegistration, mayOverwriteAttribution } from './attribution'

describe('event-management attribution', () => {
  const staffA = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

  it('staff token resolves to the staff id', () => {
    expect(resolveAttributedStaff('staff', staffA)).toBe(staffA)
  })

  it('booth token always resolves to NULL (never a staff id)', () => {
    expect(resolveAttributedStaff('booth', staffA)).toBeNull()
    expect(resolveAttributedStaff('booth', null)).toBeNull()
  })

  it('booth registrations are identified as non-staff (never inflate rankings)', () => {
    expect(isBoothRegistration(null)).toBe(true)
    expect(isBoothRegistration(undefined)).toBe(true)
    expect(isBoothRegistration(staffA)).toBe(false)
  })

  it('never overwrites an existing attribution (first source fixed)', () => {
    // booth -> staff A stays booth; staff A -> staff B stays staff A
    expect(mayOverwriteAttribution(null, staffA)).toBe(false)
    expect(mayOverwriteAttribution(staffA, 'cccccccc-cccc-cccc-cccc-cccccccccccc')).toBe(false)
  })
})
