import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { governanceError, requireSecurityActor } from '@/lib/security-access/admin-api'
import { MODE_FORBIDDEN_TEXT, NOTE_MIGRATION_MISSING_TEXT } from '@/lib/security-access/bulk-modes'
import { checkModeNote, reasonRequiredFor } from '@/lib/security-access/mode-change-rules'

export const dynamic = 'force-dynamic'

const schema = z.object({
  permissionKey: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/),
  mode: z.enum(['LEGACY_ENFORCED', 'SHADOW', 'NEW_ENFORCED', 'LEGACY_RETIRED']),
  // Required (>= 10 characters) only for an actual change back to Legacy enforced / Monitoring; otherwise an
  // optional note. Checked below against the CURRENT mode, and again by the database.
  reason: z.string().max(500).nullish(),
})

/**
 * Changes an operation's migration mode (security.permission.manage).
 * sa_set_migration_mode refuses NEW_ENFORCED/LEGACY_RETIRED for anything not
 * registered as enforcement-ready and audits every change (a generated
 * description when no note is given).
 */
export async function POST(request: NextRequest) {
  const actor = await requireSecurityActor('security.permission.manage')
  if (actor instanceof NextResponse) return actor.status === 403 ? NextResponse.json({ error: MODE_FORBIDDEN_TEXT, code: 'forbidden' }, { status: 403 }) : actor
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid mode change' }, { status: 400 })
  const { permissionKey, mode } = parsed.data

  const { data: current, error: currentError } = await actor.admin.from('sa_migration_modes').select('mode').eq('permission_key', permissionKey).maybeSingle()
  if (currentError) return NextResponse.json({ error: 'Migration modes could not be loaded.' }, { status: 500 })
  const reasonRequired = reasonRequiredFor(current?.mode ?? null, mode)
  const note = checkModeNote(reasonRequired, parsed.data.reason)
  if (!note.ok) return NextResponse.json({ error: note.error, code: note.code }, { status: 400 })

  const { data, error } = await actor.admin.rpc('sa_set_migration_mode', {
    p_actor: actor.userId, p_permission: permissionKey, p_mode: mode, p_reason: note.note,
  })
  if (error) {
    if (!reasonRequired && note.note === null && /sa_reason_required/.test(String(error.message || ''))) {
      return NextResponse.json({ error: NOTE_MIGRATION_MISSING_TEXT, code: 'note_migration_missing' }, { status: 409 })
    }
    return governanceError(error)
  }
  return NextResponse.json({ ok: true, mode: data })
}
