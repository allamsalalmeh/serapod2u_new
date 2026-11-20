/**
 * Classifies a failed Add Organization submission into a user-safe outcome.
 *
 * Supabase/PostgREST hands back plain `{ message, code, details, hint }` objects
 * (not Error instances), and fetch failures arrive as `{ message: 'TypeError: …' }`.
 * Next's dev console formatter prints such objects as `{}`, which is why the raw
 * catch block surfaced "Error creating organization: {}" even though the error
 * carried a real PostgreSQL code. Nothing here returns SQL text, constraint
 * details or submitted values to the user.
 */

export type OrgCreateErrorKind =
  | 'duplicate_code'
  | 'duplicate'
  | 'missing_field'
  | 'invalid_contact'
  | 'invalid_parent'
  | 'permission'
  | 'network'
  | 'unexpected'

/** Form fields the view can highlight for an actionable failure. */
export type OrgCreateErrorField = 'org_code' | 'org_name' | 'parent_org_id' | 'contact_phone' | 'contact_email'

export interface OrgCreateErrorOutcome {
  kind: OrgCreateErrorKind
  title: string
  message: string
  field?: OrgCreateErrorField
  /** Expected business outcomes are not logged as console errors (no dev overlay). */
  expected: boolean
  /** Only for unexpected failures, so a user can quote it to support. */
  referenceId?: string
}

export const ORG_CREATE_MESSAGES = {
  duplicate_code: 'This organization code is already in use. A new code has been generated — please review and submit again.',
  duplicate: 'An organization with these details already exists. Please check the name and code.',
  missing_field: 'Please complete the required fields before continuing.',
  invalid_contact: 'Please enter a valid contact phone number or email address.',
  invalid_parent: 'The selected parent organization is invalid or unavailable.',
  permission: "You don't have permission to create this organization. Please contact your administrator.",
  network: 'Unable to connect. Please check your connection and try again.',
  unexpected: 'Unable to create the organization. Please try again or contact support.',
} as const

const TITLES: Record<OrgCreateErrorKind, string> = {
  duplicate_code: 'Organization code in use',
  duplicate: 'Duplicate organization',
  missing_field: 'Missing information',
  invalid_contact: 'Invalid contact details',
  invalid_parent: 'Invalid parent organization',
  permission: 'Permission denied',
  network: 'Connection problem',
  unexpected: 'Organization not created',
}

interface ErrorParts {
  message: string
  code: string
  details: string
  hint: string
  status?: number
  name: string
}

function readParts(error: unknown): ErrorParts {
  if (typeof error === 'string') return { message: error, code: '', details: '', hint: '', name: '' }
  if (!error || typeof error !== 'object') return { message: '', code: '', details: '', hint: '', name: '' }
  const e = error as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))
  const status = typeof e.status === 'number' ? e.status : undefined
  return {
    message: str(e.message),
    code: str(e.code),
    details: str(e.details),
    hint: str(e.hint),
    status,
    name: str(e.name),
  }
}

const NETWORK_PATTERN = /failed to fetch|networkerror|network request failed|fetch failed|load failed|err_network|err_internet_disconnected|aborterror|the user aborted|timed? ?out/i
const CONTACT_COLUMNS = /contact_phone|contact_email|phone|email/i

export function newOrgErrorReferenceId(now: number = Date.now(), random: () => number = Math.random): string {
  const rand = Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0')
  return `ORG-${now.toString(36).slice(-6).toUpperCase()}-${rand.toUpperCase()}`
}

function outcome(kind: OrgCreateErrorKind, field?: OrgCreateErrorField): OrgCreateErrorOutcome {
  return { kind, title: TITLES[kind], message: ORG_CREATE_MESSAGES[kind], field, expected: kind !== 'unexpected' }
}

export function classifyOrgCreateError(
  error: unknown,
  makeReferenceId: () => string = newOrgErrorReferenceId,
): OrgCreateErrorOutcome {
  const { message, code, details, name } = readParts(error)
  const text = `${message} ${details}`

  // Network / transport: browser fetch rejection, aborted request, or offline.
  if (
    (error instanceof TypeError && NETWORK_PATTERN.test(message)) ||
    name === 'AbortError' ||
    (!code.match(/^[0-9A-Z]{5}$/) && NETWORK_PATTERN.test(message))
  ) {
    return outcome('network')
  }

  // Permission: RLS denial (42501), or PostgREST JWT/role errors.
  if (code === '42501' || /row-level security|permission denied/i.test(message) || code === 'PGRST301' || code === 'PGRST302') {
    return outcome('permission')
  }

  // Unique violation.
  if (code === '23505') {
    if (/org_code/i.test(text)) return outcome('duplicate_code', 'org_code')
    if (/org_name/i.test(text)) return outcome('duplicate', 'org_name')
    return outcome('duplicate')
  }

  // Not-null violation.
  if (code === '23502') {
    const column = message.match(/column "(\w+)"/)?.[1]
    if (column === 'parent_org_id') return outcome('invalid_parent', 'parent_org_id')
    if (column === 'org_name') return outcome('missing_field', 'org_name')
    if (column === 'org_code') return outcome('missing_field', 'org_code')
    return outcome('missing_field')
  }

  // Foreign key violation.
  if (code === '23503') {
    if (/parent_org_id/i.test(text)) return outcome('invalid_parent', 'parent_org_id')
    return withReference(outcome('unexpected'), makeReferenceId)
  }

  // Check constraint (format checks on code or contact columns).
  if (code === '23514' || /check constraint/i.test(message)) {
    if (/org_code/i.test(text)) return outcome('missing_field', 'org_code')
    if (/contact_email|email/i.test(text)) return outcome('invalid_contact', 'contact_email')
    if (CONTACT_COLUMNS.test(text)) return outcome('invalid_contact', 'contact_phone')
  }

  // Hierarchy trigger (validate_org_hierarchy raises P0001 with these texts).
  if (
    /parent organization not found|invalid organization hierarchy|can have no parent|must report to|must have a parent/i.test(message)
  ) {
    return outcome('invalid_parent', 'parent_org_id')
  }

  // Phone normalization trigger / invalid phone input.
  if (/invalid phone|phone number/i.test(message)) return outcome('invalid_contact', 'contact_phone')

  return withReference(outcome('unexpected'), makeReferenceId)
}

function withReference(result: OrgCreateErrorOutcome, makeReferenceId: () => string): OrgCreateErrorOutcome {
  const referenceId = makeReferenceId()
  return { ...result, referenceId, message: `${result.message} (Reference: ${referenceId})` }
}

/**
 * Safe structured diagnostics for logs: PostgreSQL code, HTTP status and a
 * truncated message. `details` is excluded because constraint details echo the
 * submitted values (codes, phone numbers, emails).
 */
export function describeOrgCreateError(error: unknown, result: OrgCreateErrorOutcome) {
  const { message, code, hint, status, name } = readParts(error)
  return {
    kind: result.kind,
    referenceId: result.referenceId,
    code: code || undefined,
    status,
    name: name || undefined,
    message: message ? message.slice(0, 200) : '(no message)',
    hint: hint ? hint.slice(0, 200) : undefined,
  }
}

/** Maps a client-side validateOrgForm message to the field it is about, for highlighting. */
export function fieldForValidationMessage(message: string): OrgCreateErrorField | null {
  if (/organization name/i.test(message)) return 'org_name'
  if (/organization code|org code/i.test(message)) return 'org_code'
  if (/email/i.test(message)) return 'contact_email'
  if (/phone/i.test(message)) return 'contact_phone'
  if (/parent/i.test(message)) return 'parent_org_id'
  return null
}
