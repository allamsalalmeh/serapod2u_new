import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { bulkRemovalExecute } from '@/lib/identity/bulk-removal'

// ─── POST /api/hr/employees/bulk-removal ─────────────────────────────────────
//
// Executes exactly the reviewed batch plan. This is an explicitly authorized
// bulk contract that invokes the SAME canonical per-identity operations as the
// single-employee workflows (identity_deletion_execute /
// identity_archive_execute, entry=hr): the database re-authorizes every target
// and every protection, re-checks dependencies under locks, verifies the
// per-target preview token and writes the durable audit record.
//
// This endpoint is NOT the internal staging tool (/api/admin/bulk-delete-users)
// and does not use or weaken that guard: authority is the canonical S&A
// decision for each target's organization plus hr.employee.delete.
//
// Body: {
//   request_id, batch_token, confirmation, reason,
//   plan: [{ user_id, action: 'delete'|'archive', employment_end, release_identifiers }]
// }
// The plan must be byte-for-byte the plan that was confirmed (fingerprint).
// Mixed outcomes are reported per employee; failure of one never rolls another
// back and a failed permanent deletion is never retried as an archive.

async function currentActor() {
  const supabase = (await createClient()) as any
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return null
  const { data: profile, error: profileError } = await supabase
    .from('users').select('id, organization_id').eq('id', user.id).single()
  if (profileError || !profile?.id || !profile.organization_id) return null
  return { id: profile.id as string, organizationId: profile.organization_id as string }
}

async function auditAttempt(actorId: string, allowed: boolean, reason: string) {
  try {
    const admin = createAdminClient() as any
    await admin.from('destructive_ops_audit_log').insert({
      operation: 'hr_bulk_employee_removal',
      user_id: actorId,
      allowed,
      reason: reason.slice(0, 1000),
      created_at: new Date().toISOString(),
    })
  } catch { /* best effort: the database keeps the authoritative per-identity record */ }
}

export async function POST(request: NextRequest) {
  let actorId: string | null = null
  try {
    const actor = await currentActor()
    if (!actor) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    actorId = actor.id

    const body = await request.json().catch(() => ({}))
    const result = await bulkRemovalExecute({
      actorId: actor.id,
      organizationId: actor.organizationId,
      requestId: body?.request_id,
      token: body?.batch_token,
      confirmation: body?.confirmation,
      plan: body?.plan,
      reason: body?.reason,
    })
    if (!result.ok) {
      await auditAttempt(actor.id, false, `${result.code}: ${result.message}`)
      return NextResponse.json({
        success: false, error: result.message, code: result.code,
        data: { problems: result.problems, targets: result.targets },
      }, { status: result.status })
    }

    const summary = result.summary
    await auditAttempt(actor.id, result.complete,
      `request ${result.request_id}: ${summary.deleted} deleted, ${summary.archived} archived, `
      + `${summary.blocked} blocked, ${summary.failed} failed, ${summary.stale} stale (${summary.total} planned)`)
    return NextResponse.json({ success: result.complete, complete: result.complete, data: result })
  } catch {
    if (actorId) {
      await auditAttempt(actorId, false,
        'UNCONFIRMED: unexpected server error; some identities may be processed. Repeating the same request is safe.')
    }
    return NextResponse.json({
      success: false, code: 'UNCONFIRMED',
      error: 'The result could not be confirmed. Submit again to check — repeating the same request is safe.',
    }, { status: 500 })
  }
}
