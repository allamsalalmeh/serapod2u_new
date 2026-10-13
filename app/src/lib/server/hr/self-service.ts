import 'server-only'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getOwnOnboardingState } from '@/lib/hr/onboarding'
import { loadNavActor, resolveDestinationAccess, type NavActor } from '@/lib/server/nav-access'

const NO_STORE = { 'Cache-Control': 'no-store' }

export type SelfServiceContext =
  | { ok: true; actor: NavActor & { organizationId: string }; admin: any; employee: 'ready' | 'pending' }
  | { ok: false; response: NextResponse }

/**
 * Employee Self-Service request context. The employee is ALWAYS the authenticated account: the account id comes from
 * the verified session and the organization from that account's own profile, never from the request. Any employee id,
 * user id or organization parameter a client sends is ignored (and no route here reads one).
 *
 *   - hr.self_service.use is decided on the person's own record (own_record scope) by the canonical evaluation
 *   - the employee link is the person's own HR employment record in that organization; it is never matched by email or
 *     phone, and nothing is created when it is missing
 *   - 401 expired login, 403 no Employee Self-Service, 503 the checks could not be completed (not a denial)
 *   - `employee: 'pending'` when the employment record does not exist or HR onboarding is not complete
 */
export async function requireSelfService(options: { requireReadyEmployee?: boolean } = {}): Promise<SelfServiceContext> {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return { ok: false, response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401, headers: NO_STORE }) }

  const actor = await loadNavActor(user.id)
  if (!actor?.organizationId) {
    return { ok: false, response: NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400, headers: NO_STORE }) }
  }
  const access = await resolveDestinationAccess(actor, 'hr/my-workspace')
  if (access.state === 'unavailable') {
    return { ok: false, response: NextResponse.json({ success: false, error: 'Access could not be checked', code: 'access_unavailable' }, { status: 503, headers: NO_STORE }) }
  }
  if (access.state !== 'allowed') {
    return { ok: false, response: NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403, headers: NO_STORE }) }
  }

  const onboarding = await getOwnOnboardingState(actor.userId, actor.organizationId)
  if (onboarding === 'unknown') {
    return { ok: false, response: NextResponse.json({ success: false, error: 'Employee setup could not be checked', code: 'employee_state_unavailable' }, { status: 503, headers: NO_STORE }) }
  }
  const employee = onboarding === 'completed' ? 'ready' : 'pending'
  if (options.requireReadyEmployee && employee !== 'ready') {
    return { ok: false, response: NextResponse.json({ success: false, state: 'pending', error: 'Your employee setup is pending. Contact HR.' }, { status: 409, headers: NO_STORE }) }
  }
  return { ok: true, actor: actor as NavActor & { organizationId: string }, admin: createAdminClient() as any, employee }
}

export const noStore = NO_STORE

/** A payroll run's payslips are available to the employee only once the run is final (approved or posted). */
export const PUBLISHED_PAYROLL_RUN_STATUSES = ['approved', 'posted'] as const
