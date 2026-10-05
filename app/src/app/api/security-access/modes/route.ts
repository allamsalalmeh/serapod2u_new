import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { governanceError, requireSecurityActor } from '@/lib/security-access/admin-api'
import { MODE_FORBIDDEN_TEXT } from '@/lib/security-access/bulk-modes'

export const dynamic = 'force-dynamic'

const schema = z.object({
  permissionKey: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
  mode: z.enum(['LEGACY_ENFORCED', 'SHADOW', 'NEW_ENFORCED', 'LEGACY_RETIRED']),
  reason: z.string().trim().min(10).max(500),
})

/**
 * Changes an operation's migration mode (security.permission.manage).
 * sa_set_migration_mode refuses NEW_ENFORCED/LEGACY_RETIRED for anything not
 * registered as enforcement-ready and audits every change.
 */
export async function POST(request: NextRequest) {
  const actor = await requireSecurityActor('security.permission.manage')
  if (actor instanceof NextResponse) return actor.status === 403 ? NextResponse.json({ error: MODE_FORBIDDEN_TEXT, code: 'forbidden' }, { status: 403 }) : actor
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid mode change' }, { status: 400 })
  const { data, error } = await actor.admin.rpc('sa_set_migration_mode', {
    p_actor: actor.userId, p_permission: parsed.data.permissionKey, p_mode: parsed.data.mode, p_reason: parsed.data.reason,
  })
  if (error) return governanceError(error)
  return NextResponse.json({ ok: true, mode: data })
}
