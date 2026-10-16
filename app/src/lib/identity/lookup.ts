import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { previewOnboardingCandidate, ONBOARDING_BLOCK_MESSAGES } from '@/lib/hr/onboarding'
import { normalizeIdentityEmail, normalizeIdentityPhone } from './normalize'
import { IDENTITY_BLOCK_MESSAGES, isIdentityBlockCode, parseResolution } from './resolution'
import { isHqOrgType } from '@/lib/security-access/ess-eligibility'

/**
 * Add User → "is this person already known?" lookup.
 *
 * Every HR employee record is anchored to a central identity (hr_employees.user_id), so an existing employee IS an
 * existing account. The lookup therefore resolves the email and the phone SEPARATELY through the canonical resolver
 * (identity_resolve, the same one provisioning uses) and reports one of:
 *
 *   none            nothing known — a new account may be created
 *   employee        HQ only: an eligible HR employee of the selected organization (the actor holds hr.employee.manage and
 *                   hr_onboarding_candidate says eligible). May be linked instead of creating a duplicate.
 *   account_exists  an account exists but cannot be linked (other organization, partner, ended, no HR authority…)
 *   conflict        email → one person, phone → another: must be resolved before anything is created or linked
 *   blocked         the resolver refused (ambiguous / unverified phone / archived …)
 *
 * Names never match; nothing sensitive is returned (no salary, bank, masked or full contact details). The route
 * authorizes the actor for the selected organization first; the HR preview re-checks hr.employee.manage in the database.
 */
export type LookupField = 'email' | 'phone'

export type IdentityLookupResult =
  | { status: 'none' }
  | { status: 'blocked'; code: string; message: string }
  | { status: 'conflict'; message: string }
  | {
      status: 'account_exists'
      matchedBy: LookupField | 'both'
      message: string
      /** Only for a person inside the selected organization (the actor is already authorized there). */
      openUserId: string | null
      name: string | null
      organizationName: string | null
    }
  | {
      status: 'employee'
      matchedBy: LookupField | 'both'
      userId: string
      name: string | null
      organizationName: string | null
      employeeNo: number | null
      /** Basic identity fields "Use employee details" will fill or replace. */
      fills: Array<{ field: 'full_name'; label: string; value: string }>
    }

export async function lookupIdentity(input: { actorId: string; organizationId: string; email?: string | null; phone?: string | null }): Promise<IdentityLookupResult> {
  const email = normalizeIdentityEmail(input.email)
  const phone = normalizeIdentityPhone(input.phone)
  if (!email && !phone) return { status: 'none' }
  const admin = createAdminClient() as any

  const resolveOne = async (e: string | null, p: string | null) => {
    if (!e && !p) return null
    const { data, error } = await admin.rpc('identity_resolve', { p_email: e, p_phone: p })
    if (error) throw error
    return parseResolution(data)
  }
  const [byEmail, byPhone] = await Promise.all([resolveOne(email, null), resolveOne(null, phone)])

  for (const r of [byEmail, byPhone]) {
    if (r && isIdentityBlockCode(r.outcome)) return { status: 'blocked', code: r.outcome, message: IDENTITY_BLOCK_MESSAGES[r.outcome] }
  }
  // A login without a profile is completed by provisioning (a retry): not an account to link or to block on.
  const matches = [byEmail, byPhone].map((r, i) => (r && r.outcome === 'MATCH' && r.userId && r.hasProfile !== false
    ? { userId: r.userId, field: (i === 0 ? 'email' : 'phone') as LookupField } : null)).filter(Boolean) as Array<{ userId: string; field: LookupField }>
  if (matches.length === 0) return { status: 'none' }
  const distinct = new Set(matches.map(m => m.userId))
  if (distinct.size > 1) return { status: 'conflict', message: IDENTITY_BLOCK_MESSAGES.IDENTITY_CONFLICT }

  const userId = matches[0].userId
  const matchedBy: LookupField | 'both' = matches.length === 2 ? 'both' : matches[0].field
  const { data: row } = await admin.from('users')
    .select('id, full_name, organization_id, account_status, principal_type, organizations:organization_id(org_name, org_type_code)')
    .eq('id', userId).maybeSingle()
  const sameOrg = row?.organization_id === input.organizationId
  const base = {
    status: 'account_exists' as const,
    matchedBy,
    openUserId: sameOrg ? userId : null,
    name: sameOrg ? (row?.full_name ?? null) : null,
    organizationName: sameOrg ? (row?.organizations?.org_name ?? null) : null,
  }

  const { data: org } = await admin.from('organizations').select('org_type_code').eq('id', input.organizationId).maybeSingle()
  if (!isHqOrgType(org?.org_type_code) || !sameOrg) {
    return { ...base, message: sameOrg
      ? 'An account already exists for this person. No second account is created.'
      : 'This email or phone number already belongs to an account outside the selected organization. No second account is created.' }
  }

  const preview = await previewOnboardingCandidate(input.actorId, input.organizationId, userId)
  if (!preview.ok || !preview.candidate.found) {
    return { ...base, message: 'An account already exists for this person. You do not have HR access to link it as an employee here.' }
  }
  const c = preview.candidate
  if (!c.eligible) {
    return { ...base, message: (c.block_code && ONBOARDING_BLOCK_MESSAGES[c.block_code]) || 'An account already exists for this person and it cannot be linked as an employee.' }
  }
  const name = c.full_name ?? null
  return {
    status: 'employee',
    matchedBy,
    userId,
    name,
    organizationName: c.organization_name ?? null,
    employeeNo: c.employment?.employee_no ?? null,
    fills: name ? [{ field: 'full_name', label: 'Full name', value: name }] : [],
  }
}
