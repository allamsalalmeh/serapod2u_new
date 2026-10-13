import { describe, expect, it } from 'vitest'
import { employmentAllowedForOrgType, employmentEligibilityError, hqOnlyEmploymentFieldsPresent } from './employment-eligibility'

describe('employment eligibility (HQ only)', () => {
  it('allows HQ only, by exact stored type', () => {
    expect(employmentAllowedForOrgType('HQ')).toBe(true)
    expect(employmentAllowedForOrgType(' hq ')).toBe(true)
    for (const t of ['MFG', 'DIST', 'SHOP', 'WH', '', null, undefined]) expect(employmentAllowedForOrgType(t)).toBe(false)
  })
  it('lists only fields that carry a value; the default status and empty values are not employment data', () => {
    expect(hqOnlyEmploymentFieldsPresent({ department_id: '', position_id: null, employment_status: 'active', full_name: 'A' })).toEqual([])
    expect(hqOnlyEmploymentFieldsPresent({ department_id: 'd', join_date: '2026-01-01', employment_status: 'resigned' })).toEqual(['department_id', 'join_date', 'employment_status'])
  })
  it('rejects values for non-HQ and accepts everything for HQ', () => {
    expect(employmentEligibilityError({ position_id: 'p' }, 'MFG')).toMatch(/HQ accounts only.*position_id/)
    expect(employmentEligibilityError({ position_id: 'p' }, null)).toMatch(/HQ accounts only/)
    expect(employmentEligibilityError({ position_id: 'p' }, 'HQ')).toBeNull()
    expect(employmentEligibilityError({ full_name: 'A', email: 'a@b.c', phone: '1' }, 'MFG')).toBeNull()
  })
})
