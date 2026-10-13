import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSecurityActor } from '@/lib/security-access/admin-api'
import { BULK_TARGET_MODES, MODE_FORBIDDEN_TEXT, applyBulkModeChange, previewBulkModeChange } from '@/lib/security-access/bulk-modes'

export const dynamic = 'force-dynamic'

// No permission list is accepted: membership is resolved on the server.
const groupId = z.string().regex(/^[a-z_]+(\/[a-z_]+)?$/).max(80)
const mode = z.enum(BULK_TARGET_MODES)
const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('preview'), groupId, mode }).strict(),
  z.object({
    action: z.literal('apply'), groupId, mode,
    selection: z.enum(['all', 'eligible_only']),
    // Required (>= 10 characters) only for an actual change back to Legacy enforced / Monitoring; the server decides
    // that from the current modes. Otherwise an optional note.
    reason: z.string().max(500).nullish(),
    previewHash: z.string().regex(/^[0-9a-f]{64}$/),
    idempotencyKey: z.string().uuid(),
  }).strict(),
])

/**
 * Bulk migration-mode change for a module group / subgroup
 * (security.permission.manage). Preview is read-only; apply runs the whole
 * batch in one database transaction (sa_bulk_set_migration_mode).
 */
export async function POST(request: NextRequest) {
  const actor = await requireSecurityActor('security.permission.manage')
  if (actor instanceof NextResponse) return actor.status === 403 ? NextResponse.json({ error: MODE_FORBIDDEN_TEXT, code: 'forbidden' }, { status: 403 }) : actor
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid group mode change', code: 'invalid_request' }, { status: 400 })
  const input = parsed.data
  const outcome = input.action === 'preview'
    ? await previewBulkModeChange(actor.admin, actor.userId, { groupId: input.groupId, targetMode: input.mode })
    : await applyBulkModeChange(actor.admin, actor.userId, {
      groupId: input.groupId, targetMode: input.mode, selection: input.selection, reason: input.reason,
      previewHash: input.previewHash, idempotencyKey: input.idempotencyKey,
    })
  if (!outcome.ok) return NextResponse.json({ error: outcome.error, code: outcome.code }, { status: outcome.status })
  return NextResponse.json(input.action === 'preview' ? { ok: true, preview: outcome.value } : { ok: true, result: outcome.value })
}
