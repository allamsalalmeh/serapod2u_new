/**
 * HR employment foundation (Wave 2, migration 20261221100000) — caller-safe messages and pure payload helpers.
 * Isomorphic (no server imports): used by the API routes and by the HR People screens.
 *
 * The database owns every rule (lifecycle guard, reporting-line validation, compensation overlap, statutory formats,
 * explicit S&A authority). This module only turns its stable error codes into clear messages and shapes payloads.
 */

export interface EmploymentErrorInfo {
  status: number
  code: string
  message: string
}

const RULES: Array<[string, number, string, string]> = [
  // [error code in the database message, HTTP status, API code, message]
  ['sa_authorization_required', 403, 'FORBIDDEN', 'You do not have HR authority for this employee (an explicit HR policy in their company is required).'],
  ['sa_actor_inactive', 403, 'FORBIDDEN', 'Your account is not active.'],
  ['hr_self_change_prohibited', 403, 'SELF_CHANGE', 'You cannot change your own employment record. Another HR administrator must do it.'],
  ['hr_statutory_self_edit_refused', 403, 'SELF_CHANGE', 'Statutory details (ID, tax, EPF, SOCSO, EIS) are updated by HR. Ask HR to change them.'],
  ['hr_employment_archived_locked', 409, 'FORMER_EMPLOYEE', 'This person is a former employee (archived). Their employment details are read-only; reactivate the identity first.'],
  ['hr_employment_not_found', 404, 'NOT_FOUND', 'No employment record was found for this person.'],
  ['hr_onboarding_pending', 409, 'ONBOARDING_PENDING', 'HR onboarding of this employee is not completed yet.'],
  ['hr_manager_self', 400, 'MANAGER_INVALID', 'An employee cannot report to themself.'],
  ['hr_manager_unknown', 400, 'MANAGER_INVALID', 'The selected manager does not exist.'],
  ['hr_manager_inactive', 400, 'MANAGER_INVALID', 'The selected manager is a former or inactive employee. Choose an active manager.'],
  ['hr_manager_outside_company', 400, 'MANAGER_INVALID', 'The selected manager belongs to another company.'],
  ['hr_manager_cycle', 400, 'MANAGER_INVALID', 'This reporting line would create a reporting cycle.'],
  ['hr_manager_required', 400, 'INVALID_INPUT', 'Select the current manager.'],
  ['hr_reassign_same_manager', 400, 'INVALID_INPUT', 'Choose a different new manager.'],
  ['hr_employment_end_before_hire', 400, 'INVALID_DATES', 'The employment end date cannot be before the hire date.'],
  ['hr_employment_end_date_passed', 400, 'INVALID_DATES', 'An active employment cannot carry an end date in the past. End the employment instead.'],
  ['hr_effective_date_invalid', 400, 'INVALID_DATES', 'The effective date must be today or earlier, and not before the hire date.'],
  ['hr_status_change_not_allowed', 400, 'STATUS_NOT_ALLOWED', 'Ending employment is done through Archive & Revoke Access (offboarding), not as a field change.'],
  ['hr_change_field_not_allowed', 400, 'FIELD_NOT_ALLOWED', 'One of the fields cannot be changed here.'],
  ['hr_changes_required', 400, 'INVALID_INPUT', 'Nothing to change.'],
  ['hr_reason_required', 400, 'REASON_REQUIRED', 'Enter a reason (at least 5 characters).'],
  ['hr_reference_outside_company', 400, 'REFERENCE_INVALID', 'The selected department or position belongs to another company.'],
  ['hr_compensation_overlap', 409, 'COMPENSATION_OVERLAP', 'Another active salary record already covers part of this period. End or supersede it first.'],
  ['hr_emp_comp_dates_chk', 400, 'INVALID_DATES', 'A salary record cannot end before it starts.'],
  ['hr_history_append_only', 409, 'HISTORY_SEALED', 'Employment history cannot be changed.'],
  ['hr_employee_statutory_profiles', 400, 'INVALID_STATUTORY', 'One of the statutory details has an invalid format (NRIC = 12 digits; EPF/SOCSO/EIS/tax numbers = letters and digits).'],
  ['hr_employee_profiles', 400, 'INVALID_PROFILE', 'One of the profile details has an invalid format (e.g. bank account number = digits only).'],
]

/** Maps a database/PostgREST error (or thrown value) to a status, code and caller-safe message. */
export function employmentError(error: unknown, fallback = 'The change could not be saved.'): EmploymentErrorInfo {
  const text = typeof error === 'string'
    ? error
    : error && typeof error === 'object'
      ? [(error as any).message, (error as any).details, (error as any).hint].filter((p) => typeof p === 'string').join(' ')
      : ''
  for (const [needle, status, code, message] of RULES) {
    if (text.includes(needle)) return { status, code, message }
  }
  if (/violates check constraint/i.test(text)) return { status: 400, code: 'INVALID_INPUT', message: 'One of the values has an invalid format.' }
  if (/could not find the function|does not exist/i.test(text)) {
    return { status: 503, code: 'NOT_AVAILABLE', message: 'This HR feature is not installed on this environment yet (migration 20261221100000).' }
  }
  return { status: 500, code: 'ERROR', message: fallback }
}

/* ─── HR Profile sheet: one UI shape, two stores (personal profile + statutory profile) ───────────────── */

/** Fields of the HR Profile sheet that are statutory master data, with their statutory-profile column. */
export const STATUTORY_FIELD_MAP = {
  ic_number: 'nric_no',
  passport_number: 'passport_no',
  tax_id: 'income_tax_no',
  socso_number: 'socso_no',
  epf_number: 'epf_no',
  eis_number: 'eis_no',
  gender: 'gender',
  date_of_birth: 'date_of_birth',
  nationality: 'nationality',
  marital_status: 'marital_status',
  // Statutory work state (drives state public holidays for leave working days, attendance and overtime day types).
  work_state: 'work_state',
} as const

/** Work-state codes accepted by hr_employee_statutory_profiles.work_state (Wave 2), with readable names. */
export const WORK_STATES: { code: string; name: string }[] = [
  { code: 'JHR', name: 'Johor' }, { code: 'KDH', name: 'Kedah' }, { code: 'KTN', name: 'Kelantan' }, { code: 'MLK', name: 'Melaka' },
  { code: 'NSN', name: 'Negeri Sembilan' }, { code: 'PHG', name: 'Pahang' }, { code: 'PNG', name: 'Pulau Pinang' }, { code: 'PRK', name: 'Perak' },
  { code: 'PLS', name: 'Perlis' }, { code: 'SBH', name: 'Sabah' }, { code: 'SWK', name: 'Sarawak' }, { code: 'SGR', name: 'Selangor' },
  { code: 'TRG', name: 'Terengganu' }, { code: 'KUL', name: 'W.P. Kuala Lumpur' }, { code: 'LBN', name: 'W.P. Labuan' }, { code: 'PJY', name: 'W.P. Putrajaya' },
]

export type UiStatutoryField = keyof typeof STATUTORY_FIELD_MAP

export const PERSONAL_FIELDS = [
  'blood_type', 'religion', 'personal_email', 'personal_phone', 'address_line1', 'address_line2', 'city', 'state', 'postcode',
  'country', 'emergency_name', 'emergency_relationship', 'emergency_phone', 'emergency_address', 'bank_name', 'bank_account_no',
  'bank_holder_name', 'highest_education', 'education_institution', 'education_field', 'notes',
] as const

const compact = (v: string) => v.replace(/[\s-]/g, '').toUpperCase()

/** NRIC as entered ("900101-01-1234") → 12 digits; other identifiers → upper case without spaces/dashes. */
export function normalizeStatutoryValue(column: string, value: unknown): string | null {
  if (value === null || value === undefined) return null
  const raw = String(value).trim()
  if (!raw) return null
  switch (column) {
    case 'nric_no':
    case 'passport_no':
    case 'income_tax_no':
    case 'socso_no':
    case 'epf_no':
    case 'eis_no':
      return compact(raw)
    case 'gender':
    case 'marital_status':
      return raw.toLowerCase()
    case 'work_state':
      return raw.toUpperCase()
    default:
      return raw
  }
}

/** Client-side format check mirroring the database constraints (the database remains the authority). */
export function statutoryFormatError(column: string, value: string | null): string | null {
  if (value === null) return null
  if (column === 'nric_no' && !/^\d{12}$/.test(value)) return 'NRIC must be 12 digits (e.g. 900101-01-1234).'
  if (['epf_no', 'socso_no', 'eis_no', 'income_tax_no'].includes(column) && !/^[0-9A-Z]{5,20}$/.test(value)) {
    return 'Use 5–20 letters or digits.'
  }
  if (column === 'passport_no' && (value.length < 5 || value.length > 20)) return 'Passport number must be 5–20 characters.'
  if (column === 'date_of_birth' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Enter a valid date of birth.'
  if (column === 'work_state' && !WORK_STATES.some((s) => s.code === value)) return 'Choose a Malaysian state or Federal Territory.'
  return null
}

/** Splits the HR Profile sheet payload into the personal and statutory sections (unknown keys are dropped). */
export function splitProfilePayload(fields: Record<string, unknown>): {
  personal: Record<string, string | null>
  statutory: Record<string, string | null>
  errors: Record<string, string>
} {
  const personal: Record<string, string | null> = {}
  const statutory: Record<string, string | null> = {}
  const errors: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (key in STATUTORY_FIELD_MAP) {
      const column = STATUTORY_FIELD_MAP[key as UiStatutoryField]
      const v = normalizeStatutoryValue(column, value)
      const err = statutoryFormatError(column, v)
      if (err) errors[key] = err
      statutory[column] = v
      if (column === 'nric_no' && v) statutory.id_type = 'nric'
    } else if ((PERSONAL_FIELDS as readonly string[]).includes(key)) {
      const v = value === undefined || value === null || String(value).trim() === '' ? null : String(value).trim()
      personal[key] = key === 'bank_account_no' && v ? v.replace(/[\s-]/g, '') : v
    }
  }
  return { personal, statutory, errors }
}

/** Database rows → the HR Profile sheet's flat shape. */
export function mergeProfileForUi(profile: Record<string, any> | null | undefined, statutory: Record<string, any> | null | undefined) {
  const out: Record<string, string | null> = {}
  for (const k of PERSONAL_FIELDS) out[k] = profile?.[k] ?? null
  for (const [ui, column] of Object.entries(STATUTORY_FIELD_MAP)) out[ui] = statutory?.[column] ?? null
  return out
}

/** Readable labels for employment-history entries. */
export const CHANGE_KIND_LABELS: Record<string, string> = {
  baseline: 'Recorded at go-live of history (earlier changes not reconstructed)',
  hire: 'Hired',
  transfer: 'Transfer (department / position)',
  reporting_change: 'Reporting line changed',
  status_change: 'Employment status changed',
  employment_terms: 'Employment terms changed',
  end_of_employment: 'Employment ended',
  rehire: 'Re-employed',
  organization_move: 'Moved to another company of the group',
  onboarding: 'HR onboarding state changed',
  correction: 'Correction',
}

export const REPORTING_ISSUE_LABELS: Record<string, string> = {
  NO_MANAGER: 'No manager assigned',
  NO_MANAGER_POSITION_SUGGESTS: 'No manager assigned (the position hierarchy suggests one)',
  MANAGER_INACTIVE: 'Reports to a former or inactive employee',
  MANAGER_OUTSIDE_COMPANY: 'Reports to a manager in another company',
  MANAGER_CYCLE: 'Part of a reporting cycle',
  MANAGER_UNKNOWN: 'Manager record not found',
  MANAGER_SELF: 'Reports to themself',
  POSITION_DIVERGENCE: 'Manager differs from the position hierarchy',
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)
