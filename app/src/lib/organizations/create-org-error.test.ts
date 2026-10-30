import { describe, expect, it } from 'vitest'

import {
  ORG_CREATE_MESSAGES,
  classifyOrgCreateError,
  describeOrgCreateError,
  fieldForValidationMessage,
  newOrgErrorReferenceId,
} from './create-org-error'

const ref = () => 'ORG-TEST-0001'

describe('classifyOrgCreateError', () => {
  it('maps the staging RLS denial (PostgREST 42501 plain object) to the permission message', () => {
    // Shape observed on staging 2026-10-21: POST /rest/v1/organizations → 403.
    const error = {
      code: '42501',
      details: null,
      hint: null,
      message: 'new row violates row-level security policy for table "organizations"',
    }
    const result = classifyOrgCreateError(error, ref)
    expect(result).toMatchObject({ kind: 'permission', expected: true, message: ORG_CREATE_MESSAGES.permission })
    expect(result.message).not.toContain('row-level')
    expect(result.referenceId).toBeUndefined()
  })

  it('maps a duplicate org_code to the code message and highlights the code', () => {
    const result = classifyOrgCreateError({
      code: '23505',
      message: 'duplicate key value violates unique constraint "organizations_org_code_key"',
      details: 'Key (org_code)=(DT014) already exists.',
    }, ref)
    expect(result).toMatchObject({ kind: 'duplicate_code', field: 'org_code', message: ORG_CREATE_MESSAGES.duplicate_code })
    expect(result.message).not.toContain('DT014')
  })

  it('maps a generic unique violation without leaking constraint details', () => {
    const result = classifyOrgCreateError({ code: '23505', message: 'duplicate key value violates unique constraint "x"', details: 'Key (foo)=(secret)' }, ref)
    expect(result.kind).toBe('duplicate')
    expect(result.message).not.toContain('secret')
  })

  it('maps not-null violations to missing information', () => {
    expect(classifyOrgCreateError({ code: '23502', message: 'null value in column "org_name" of relation "organizations"' }, ref))
      .toMatchObject({ kind: 'missing_field', field: 'org_name', message: ORG_CREATE_MESSAGES.missing_field })
    expect(classifyOrgCreateError({ code: '23502', message: 'null value in column "country_code"' }, ref))
      .toMatchObject({ kind: 'missing_field', field: undefined })
  })

  it('maps parent foreign-key and hierarchy trigger failures to the invalid parent message', () => {
    expect(classifyOrgCreateError({ code: '23503', message: 'insert or update on table "organizations" violates foreign key constraint "organizations_parent_org_id_fkey"' }, ref))
      .toMatchObject({ kind: 'invalid_parent', field: 'parent_org_id' })
    expect(classifyOrgCreateError({ code: 'P0001', message: 'Parent organization not found' }, ref))
      .toMatchObject({ kind: 'invalid_parent', field: 'parent_org_id' })
    expect(classifyOrgCreateError({ code: 'P0001', message: 'Invalid organization hierarchy: DIST cannot be child of SHOP' }, ref))
      .toMatchObject({ kind: 'invalid_parent', message: ORG_CREATE_MESSAGES.invalid_parent })
    expect(classifyOrgCreateError({ code: 'P0001', message: 'Only HQ and Manufacturer organizations can have no parent' }, ref))
      .toMatchObject({ kind: 'invalid_parent' })
  })

  it('maps contact check-constraint failures to the contact message', () => {
    expect(classifyOrgCreateError({ code: '23514', message: 'new row violates check constraint "organizations_contact_email_check"' }, ref))
      .toMatchObject({ kind: 'invalid_contact', field: 'contact_email', message: ORG_CREATE_MESSAGES.invalid_contact })
    expect(classifyOrgCreateError({ code: '23514', message: 'new row violates check constraint "organizations_contact_phone_check"' }, ref))
      .toMatchObject({ kind: 'invalid_contact', field: 'contact_phone' })
  })

  it('maps browser/network failures to the connection message', () => {
    // postgrest-js converts a fetch rejection into { message: 'TypeError: Failed to fetch', code: '' }
    expect(classifyOrgCreateError({ message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' }, ref).kind).toBe('network')
    expect(classifyOrgCreateError(new TypeError('Failed to fetch'), ref).kind).toBe('network')
    expect(classifyOrgCreateError({ name: 'AbortError', message: 'The user aborted a request.' }, ref).kind).toBe('network')
    // A database statement timeout is a server failure, not a connection problem.
    expect(classifyOrgCreateError({ code: '57014', message: 'canceling statement due to statement timeout' }, ref).kind).toBe('unexpected')
  })

  it('never shows {} or raw text for an empty or unknown error, and adds a reference ID', () => {
    for (const error of [{}, null, undefined, '', { code: 'XX000', message: 'internal error at pg_foo.c:123' }]) {
      const result = classifyOrgCreateError(error, ref)
      expect(result.kind).toBe('unexpected')
      expect(result.expected).toBe(false)
      expect(result.referenceId).toBe('ORG-TEST-0001')
      expect(result.message).toBe(`${ORG_CREATE_MESSAGES.unexpected} (Reference: ORG-TEST-0001)`)
      expect(result.message).not.toContain('{}')
      expect(result.message).not.toContain('pg_foo')
    }
  })
})

describe('describeOrgCreateError', () => {
  it('keeps code/status/message for logs but drops details (which echo submitted values)', () => {
    const error = { code: '23505', message: 'duplicate key', details: 'Key (contact_email)=(owner@example.com)', status: 409 }
    const result = classifyOrgCreateError(error, ref)
    const diag = describeOrgCreateError(error, result)
    expect(diag).toMatchObject({ kind: 'duplicate', code: '23505', status: 409, message: 'duplicate key' })
    expect(JSON.stringify(diag)).not.toContain('owner@example.com')
  })
})

describe('fieldForValidationMessage', () => {
  it('maps validateOrgForm messages to fields', () => {
    expect(fieldForValidationMessage('Organization name is required')).toBe('org_name')
    expect(fieldForValidationMessage('Invalid email format')).toBe('contact_email')
    expect(fieldForValidationMessage('Parent HQ is required for Distributor')).toBe('parent_org_id')
    expect(fieldForValidationMessage('Postal code must be exactly 5 digits')).toBeNull()
  })
})

describe('newOrgErrorReferenceId', () => {
  it('produces a short, non-sensitive support reference', () => {
    expect(newOrgErrorReferenceId(1_700_000_000_000, () => 0.5)).toMatch(/^ORG-[0-9A-Z]{6}-[0-9A-Z]{4}$/)
  })
})
