import { describe, expect, it } from 'vitest'
import {
  BASIC_PROFILE_FIELDS,
  disallowedBasicFields,
  disallowedSensitiveFields,
  pickApplicableUserFields,
  SENSITIVE_PROFILE_FIELDS,
  validAddress,
  validSensitivePayload,
} from './profile-edit'

describe('ESS hybrid profile editing field lists', () => {
  it('sensitive fields are exactly the identity/payroll-sensitive ones', () => {
    expect([...SENSITIVE_PROFILE_FIELDS].sort()).toEqual(
      ['bank_account_holder_name', 'bank_account_number', 'bank_id', 'full_name', 'ic_number', 'passport_number'].sort(),
    )
  })

  it('basic fields are only the directly-editable non-sensitive ones', () => {
    expect([...BASIC_PROFILE_FIELDS]).toEqual(['address'])
  })

  it('rejects salary, payroll and employment fields from either list', () => {
    for (const bad of ['basic_salary', 'hourly_rate', 'net_amount', 'employee_no', 'manager_user_id', 'department_id', 'role_code']) {
      expect(disallowedSensitiveFields({ [bad]: 1 })).toContain(bad)
      expect(disallowedBasicFields({ [bad]: 1 })).toContain(bad)
    }
  })
})

describe('validSensitivePayload', () => {
  it('accepts a non-empty object of permitted sensitive fields', () => {
    expect(validSensitivePayload({ full_name: 'New Name', bank_account_number: '123' })).toBe(true)
  })
  it('rejects empty, non-object and disallowed fields', () => {
    expect(validSensitivePayload(null)).toBe(false)
    expect(validSensitivePayload([])).toBe(false)
    expect(validSensitivePayload({})).toBe(false)
    expect(validSensitivePayload({ address: 'x' })).toBe(false) // basic field, not sensitive
    expect(validSensitivePayload({ basic_salary: 999 })).toBe(false) // salary is never self-service
  })
})

describe('pickApplicableUserFields', () => {
  it('applies only the sensitive fields that map onto public.users columns', () => {
    const out = pickApplicableUserFields({ full_name: 'A', bank_account_number: 'B', ic_number: 'C', passport_number: 'D' })
    expect(out).toEqual({ full_name: 'A', bank_account_number: 'B' })
    expect(out).not.toHaveProperty('ic_number')
    expect(out).not.toHaveProperty('passport_number')
  })
})

describe('validAddress', () => {
  it('accepts a 1-255 character non-empty string and rejects the rest', () => {
    expect(validAddress('12 Jalan Example')).toBe(true)
    expect(validAddress('')).toBe(false)
    expect(validAddress('   ')).toBe(false)
    expect(validAddress('x'.repeat(256))).toBe(false)
    expect(validAddress(123)).toBe(false)
    expect(validAddress(null)).toBe(false)
  })
})
