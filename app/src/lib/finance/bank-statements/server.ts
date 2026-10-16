import 'server-only'
import { financeAllowed } from '@/lib/security-access/finance'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkPermissionForUser } from '@/lib/server/permissions'
import { isCanonicalStaff } from '@/lib/identity/staff'
import { normalizeAccountNumber } from './hlb-csv'
import { NextResponse } from 'next/server'

/**
 * Shared server context for the bank statement routes.
 *
 * Permissions:
 *   finance.cash.view           read statements and lines (unchanged)
 *   finance.statement.import    upload, validate, submit, withdraw
 *   finance.statement.approve   approve, reject, reverse (never one you uploaded/submitted)
 * The statement permissions start in SHADOW: their legacy rule is
 * Super Admin only (role level 1). The database functions re-check every
 * decision and enforce maker/checker, so the route checks are the first gate,
 * not the only one.
 */

export const STATEMENT_BUCKET = 'bank-statements'
export const MAX_STATEMENT_BYTES = 2 * 1024 * 1024
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const STATEMENT_IMPORT = 'finance.statement.import'
export const STATEMENT_APPROVE = 'finance.statement.approve'
export const CASH_VIEW = 'finance.cash.view'

export async function loadStatementContext() {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const

  const { data: profile } = await (supabase as any)
    .from('users')
    .select('id, organization_id, principal_type, is_active, account_status, roles:role_code ( role_level )')
    .eq('id', user.id)
    .single()
  if (!profile?.organization_id) return { error: NextResponse.json({ error: 'User has no organization' }, { status: 400 }) } as const

  const role = Array.isArray((profile as any).roles) ? (profile as any).roles[0] : (profile as any).roles
  const roleLevel = Number(role?.role_level)
  const orgId = profile.organization_id as string

  // Historical Finance rule (cash view / reconciliation).
  const legacyFinanceUser = async () =>
    isCanonicalStaff(profile as any, roleLevel, 40) || (await checkPermissionForUser(user.id, 'view_settings')).allowed
  // New statement permissions have no legacy equivalent: Super Admin only
  // (same rule as public.sa_legacy_is_super_admin: active user, role level 1).
  const legacySuperAdmin = () => (profile as any).is_active === true && roleLevel === 1

  const allowed = (permission: string) =>
    financeAllowed(user.id, permission, permission === CASH_VIEW ? legacyFinanceUser : legacySuperAdmin, orgId)

  return { supabase, db: supabase as any, user, orgId, roleLevel, isSuperAdmin: legacySuperAdmin(), allowed } as const
}

export function maskAccount(value: string | null | undefined) {
  const digits = normalizeAccountNumber(value)
  return digits.length > 4 ? `••••${digits.slice(-4)}` : digits
}

/** Keeps the original name readable but safe as a storage object name. */
export function safeFileName(name: string | null | undefined) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 120)
  return cleaned || 'statement.csv'
}

export function statementFilePath(companyId: string, bankAccountId: string, importId: string, fileName: string) {
  return `${companyId}/${bankAccountId}/${importId}/${safeFileName(fileName)}`
}

const ERRORS: [RegExp, number, string][] = [
  [/sod_violation/, 403, 'You uploaded or submitted this statement, so another person must approve it.'],
  [/sa_authorization_required|bank_statement_actor_required|sa_actor_/, 403, 'You are not allowed to perform this action.'],
  [/bank_account_opening_balance_locked/, 403, 'Only a Super Admin can change the opening balance or its date.'],
  [/bank_account_statement_frequency_locked/, 403, 'Only a Super Admin can change the statement frequency.'],
  [/bank_statement_reason_required/, 422, 'A reason is required (at least 10 characters to submit or reverse, 5 to reject).'],
  [/bank_statement_invalid_status/, 409, 'This statement is no longer in a state that allows this action. Refresh the page.'],
  [/bank_statement_opening_basis_changed/, 409, 'The previous statement or the account opening balance changed after submission. Reject this upload and upload the file again.'],
  [/bank_statement_period_overlap/, 409, 'Another statement of this account already covers part of this period.'],
  [/bank_statement_duplicate_file/, 409, 'This exact file was already uploaded for this account.'],
  [/bank_statement_lines_already_imported/, 409, 'Some lines of this file are already stored for this account.'],
  [/bank_statement_not_latest/, 409, 'Only the latest statement of the account can be reversed. Reverse the later statements first.'],
  [/bank_statement_not_full_month/, 422, 'This account takes monthly statements: the file must cover a whole calendar month.'],
  [/bank_statement_period_crosses_month/, 422, 'A daily statement must stay within one calendar month.'],
  [/bank_statement_period_in_future/, 422, 'The statement period ends in the future.'],
  [/bank_statement_period_type_mismatch|bank_statement_period_type_not_supported/, 409, 'The bank account statement frequency changed. Check the file again.'],
  [/bank_statement_period_invalid/, 422, 'The statement period is invalid.'],
  [/bank_statement_account_mismatch/, 422, 'This file is for a different bank account.'],
  [/bank_statement_currency_mismatch/, 422, 'The file currency does not match the bank account currency.'],
  [/bank_statement_(running_balance_invalid|closing_balance_mismatch|lines_invalid|no_lines|line_numbers_invalid|balances_missing|too_many_lines)/, 422, 'The statement lines failed the database validation. The file is incomplete or was edited.'],
  [/bank_account_inactive/, 400, 'Bank account is inactive.'],
  [/bank_statement_not_found|bank_account_not_found/, 404, 'Statement not found.'],
  [/bank_statement_file_/, 500, 'The original file could not be stored. Try again.'],
]

/** Maps a database exception from the workflow functions to an HTTP response. */
export function statementErrorResponse(error: { message?: string; details?: string } | null | undefined) {
  const message = String(error?.message ?? '')
  for (const [pattern, status, text] of ERRORS) {
    if (pattern.test(message)) {
      return NextResponse.json({ error: text, code: message.split(':')[0].trim(), detail: error?.details || undefined }, { status })
    }
  }
  console.error('Bank statement workflow error:', error)
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
}

/**
 * Display names for the people on a statement (uploader, submitter,
 * approver, ...). Limited to the given ids inside the caller's own
 * organization; returns only id -> name, never other user data.
 * Read with the admin client because users may not see each other's rows.
 */
export async function loadPeopleNames(orgId: string, ids: (string | null | undefined)[]): Promise<Record<string, string>> {
  const unique = Array.from(new Set(ids.filter((v): v is string => typeof v === 'string' && UUID_RE.test(v))))
  if (unique.length === 0) return {}
  try {
    const admin = createAdminClient() as any
    const { data } = await admin
      .from('users')
      .select('id, full_name, email')
      .eq('organization_id', orgId)
      .in('id', unique)
    const out: Record<string, string> = {}
    for (const u of data || []) out[u.id] = (u.full_name && String(u.full_name).trim()) || u.email || 'Unknown user'
    return out
  } catch (error) {
    console.error('Bank statement people lookup failed:', error)
    return {}
  }
}
