import { describe, expect, it } from 'vitest'
import { employmentError, mergeProfileForUi, normalizeStatutoryValue, splitProfilePayload, statutoryFormatError } from './employment-messages'

describe('employmentError (Wave 2 database codes → caller-safe messages)', () => {
  it.each([
    ['sa_authorization_required', 403, 'FORBIDDEN'],
    ['hr_employment_archived_locked', 409, 'FORMER_EMPLOYEE'],
    ['hr_manager_inactive', 400, 'MANAGER_INVALID'],
    ['hr_manager_outside_company', 400, 'MANAGER_INVALID'],
    ['hr_manager_cycle', 400, 'MANAGER_INVALID'],
    ['hr_compensation_overlap', 409, 'COMPENSATION_OVERLAP'],
    ['hr_self_change_prohibited', 403, 'SELF_CHANGE'],
    ['hr_statutory_self_edit_refused', 403, 'SELF_CHANGE'],
    ['hr_effective_date_invalid', 400, 'INVALID_DATES'],
    ['hr_status_change_not_allowed', 400, 'STATUS_NOT_ALLOWED'],
  ])('%s → %i %s', (code, status, api) => {
    const e = employmentError({ message: code })
    expect(e.status).toBe(status)
    expect(e.code).toBe(api)
    expect(e.message).not.toContain(code) // never the raw code
  })
  it('maps a statutory check-constraint violation to a format message', () => {
    expect(employmentError({ message: 'new row for relation "hr_employee_statutory_profiles" violates check constraint "hr_employee_statutory_profiles_nric_no_check"' }).code).toBe('INVALID_STATUTORY')
  })
  it('reports a missing migration as not available (503), not as success or a crash', () => {
    expect(employmentError({ message: 'Could not find the function public.hr_employee_history(p_actor, p_employee_user) in the schema cache' }).status).toBe(503)
  })
  it('keeps unknown errors generic', () => {
    expect(employmentError(new Error('boom'), 'Nope')).toEqual({ status: 500, code: 'ERROR', message: 'Nope' })
  })
})

describe('HR Profile payload split (one source for statutory data)', () => {
  it('routes statutory fields to the statutory profile and normalizes them', () => {
    const r = splitProfilePayload({ ic_number: '900101-01-1234', epf_number: ' 1234 5678 ', gender: 'Female', emergency_name: 'Spouse', bank_account_no: '1234-5678-90', unknown: 'x' })
    expect(r.statutory).toEqual({ nric_no: '900101011234', id_type: 'nric', epf_no: '12345678', gender: 'female' })
    expect(r.personal).toEqual({ emergency_name: 'Spouse', bank_account_no: '1234567890' })
    expect(r.errors).toEqual({})
  })
  it('reports format errors per field before calling the database', () => {
    const r = splitProfilePayload({ ic_number: '9001', socso_number: 'A!' })
    expect(Object.keys(r.errors).sort()).toEqual(['ic_number', 'socso_number'])
  })
  it('empty strings clear a field', () => {
    expect(splitProfilePayload({ tax_id: '', city: '  ' })).toMatchObject({ statutory: { income_tax_no: null }, personal: { city: null } })
  })
  it('merges both stores back into the sheet shape', () => {
    const ui = mergeProfileForUi({ city: 'Shah Alam' }, { nric_no: '900101011234', eis_no: 'A1234567' })
    expect(ui).toMatchObject({ city: 'Shah Alam', ic_number: '900101011234', eis_number: 'A1234567', tax_id: null })
  })
  it('normalizer and validator agree with the database formats', () => {
    expect(normalizeStatutoryValue('nric_no', '900101 01 1234')).toBe('900101011234')
    expect(statutoryFormatError('nric_no', '900101011234')).toBeNull()
    expect(statutoryFormatError('income_tax_no', 'SG1234567890')).toBeNull()
    expect(statutoryFormatError('passport_no', 'A1')).not.toBeNull()
  })
})
