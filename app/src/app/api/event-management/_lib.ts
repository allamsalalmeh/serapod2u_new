import 'server-only'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { authorizeEventManagement } from '@/modules/event-management/lib/auth'

/**
 * Shared auth + authorization for Event Management admin API routes.
 * Every admin endpoint verifies the Marketing parent gate BEFORE any database
 * operation, and derives the permitted organization scope server-side.
 */
export async function requireMarketingUser(): Promise<
  | { ok: true; userId: string; orgId: string }
  | { ok: false; response: NextResponse }
> {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUser()
  const user = data?.user
  if (error || !user) {
    return { ok: false, response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  }

  const access = await authorizeEventManagement(user.id)
  if (!access.allowed || !access.orgId) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: 'Forbidden', code: 'sa_forbidden', permission: 'marketing.module.view' },
        { status: 403 },
      ),
    }
  }

  return { ok: true, userId: user.id, orgId: access.orgId }
}
