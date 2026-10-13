import { createAdminClient } from '@/lib/supabase/admin'

type ActiveAccountRecord = { is_active?: boolean | null } | null | undefined

export function isActiveAccountRecord(record: ActiveAccountRecord, error?: unknown): boolean {
  return !error && record?.is_active === true
}

export async function isActiveSecurityAccessAccount(userId: string): Promise<boolean> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('users')
    .select('is_active')
    .eq('id', userId)
    .maybeSingle()

  return isActiveAccountRecord(data, error)
}

export type ActiveAccountState = 'active' | 'inactive' | 'unavailable'

/**
 * Tri-state account gate: a read failure (timeout, network, database error) is
 * 'unavailable', never 'inactive', so callers can fail closed without reporting
 * an infrastructure failure as a confirmed denial.
 */
export async function activeAccountState(userId: string): Promise<ActiveAccountState> {
  try {
    const { data, error } = await createAdminClient().from('users').select('is_active').eq('id', userId).maybeSingle()
    if (error) return 'unavailable'
    return isActiveAccountRecord(data) ? 'active' : 'inactive'
  } catch {
    return 'unavailable'
  }
}
