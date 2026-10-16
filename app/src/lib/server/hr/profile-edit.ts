import 'server-only'

/**
 * ESS hybrid profile editing: which fields an employee may change directly (Category A) vs. which require HR approval
 * (Category B). Salary, job title, reporting manager, department, organization and payroll configuration are never in
 * either list — they are edited only through HR/Payroll administration.
 */

/** Category B — sensitive fields that require HR approval before the official record changes. */
export const SENSITIVE_PROFILE_FIELDS = [
  'full_name',
  'ic_number',
  'passport_number',
  'bank_account_number',
  'bank_account_holder_name',
  'bank_id',
] as const

/** The subset of sensitive fields that map onto public.users columns and are therefore applied by the review step. */
export const SENSITIVE_USER_FIELDS = [
  'full_name',
  'bank_account_number',
  'bank_account_holder_name',
  'bank_id',
] as const

/** Category A — basic fields an employee may self-edit directly (validated + audited). */
export const BASIC_PROFILE_FIELDS = ['address'] as const

const SENSITIVE_SET = new Set<string>(SENSITIVE_PROFILE_FIELDS)
const BASIC_SET = new Set<string>(BASIC_PROFILE_FIELDS)

/** Returns the fields in `payload` that are NOT permitted sensitive fields (for a Category B request). */
export function disallowedSensitiveFields(payload: Record<string, unknown>): string[] {
  return Object.keys(payload).filter((k) => !SENSITIVE_SET.has(k))
}

/** Returns the fields in `payload` that are NOT permitted basic fields (for a Category A self-edit). */
export function disallowedBasicFields(payload: Record<string, unknown>): string[] {
  return Object.keys(payload).filter((k) => !BASIC_SET.has(k))
}

/** A Category B change payload must be a non-empty object of permitted sensitive fields. */
export function validSensitivePayload(payload: unknown): payload is Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  const keys = Object.keys(payload)
  return keys.length > 0 && disallowedSensitiveFields(payload as Record<string, unknown>).length === 0
}

/** The whitelisted users columns to apply on approval, narrowed to the fields that were actually requested. */
export function pickApplicableUserFields(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of SENSITIVE_USER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) out[key] = payload[key]
  }
  return out
}

/** `address` (Category A) is a bounded text field. */
export function validAddress(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 255
}
