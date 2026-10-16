import { isHqOrgType } from '@/lib/security-access/ess-eligibility'

/**
 * Employment details (department, position, reporting line, join date, employment type/status) and the HR employee
 * link are HQ-only at account creation. Client-safe; the server judges the organization's STORED type, never a
 * submitted organization-type value. Employment facts never grant business access.
 */
export const EMPLOYMENT_HQ_ONLY_MESSAGE =
  'Employment details and HR employee links are available for HQ accounts only.'

export const employmentAllowedForOrgType = (orgTypeCode?: string | null) => isHqOrgType(orgTypeCode)

const HQ_ONLY_FIELDS = ['department_id', 'manager_user_id', 'position_id', 'employment_type', 'join_date'] as const
// linked_user_id (the HR employee link) is rejected for non-HQ organizations by the existing ESS_HQ_ONLY guard in createUserWithAuth.

/** The HQ-only fields a creation request actually carries a value for ('active' is the unchanged default status). */
export function hqOnlyEmploymentFieldsPresent(data: Record<string, unknown> | null | undefined): string[] {
  const d = data ?? {}
  const present: string[] = HQ_ONLY_FIELDS.filter(k => {
    const v = d[k]
    return v !== undefined && v !== null && String(v).trim() !== ''
  })
  const status = d.employment_status
  if (status !== undefined && status !== null && String(status).trim() !== '' && String(status).trim().toLowerCase() !== 'active') present.push('employment_status')
  return present
}

/** null = acceptable. Rejects HQ-only values on a non-HQ creation, before any side effect. */
export function employmentEligibilityError(data: Record<string, unknown> | null | undefined, orgTypeCode?: string | null): string | null {
  if (employmentAllowedForOrgType(orgTypeCode)) return null
  const present = hqOnlyEmploymentFieldsPresent(data)
  return present.length ? `${EMPLOYMENT_HQ_ONLY_MESSAGE} Remove: ${present.join(', ')}.` : null
}
