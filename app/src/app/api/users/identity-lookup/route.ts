import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { checkPermissionForUser } from '@/lib/server/permissions'
import { explainOperation } from '@/lib/security-access/preflight'
import { lookupIdentity } from '@/lib/identity/lookup'

export const dynamic = 'force-dynamic'

const schema = z.object({
  organizationId: z.string().uuid(),
  email: z.string().max(320).nullish(),
  phone: z.string().max(40).nullish(),
})

/**
 * POST /api/users/identity-lookup — Add User: is this email/phone already an account or an HR employee?
 * Authorized like user creation: platform.user.manage for the selected organization (the same decision
 * createUserWithAuth takes). Returns only basic identity facts the administrator is allowed to see.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  const { organizationId, email, phone } = parsed.data

  // The same decision creation takes (platform.user.manage in the selected organization). A denial is confirmed and
  // explained (403); an authorization service that cannot answer is a failure (503), never a denial.
  let decision
  try {
    const permissionCheck = await checkPermissionForUser(user.id, 'create_users')
    const roleLevel = permissionCheck.context?.role_level
    decision = await explainOperation(user.id, 'platform.user.manage', organizationId, () => permissionCheck.allowed || (typeof roleLevel === 'number' && roleLevel <= 30))
  } catch {
    // PreflightUnavailableError or any failure while reading the actor's permissions: not a denial.
    return NextResponse.json({ error: 'The permission check is unavailable.', code: 'UNAVAILABLE' }, { status: 503 })
  }
  if (!decision.allowed) return NextResponse.json({ error: 'Forbidden', code: 'DENIED', reason: decision.reason }, { status: 403 })

  try {
    return NextResponse.json({ result: await lookupIdentity({ actorId: user.id, organizationId, email, phone }) })
  } catch {
    return NextResponse.json({ error: 'The lookup could not be completed.', code: 'FAILED' }, { status: 500 })
  }
}
