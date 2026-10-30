import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
    deletionActorCheck, deletionExecute, deletionPreview, isDeletionEntryPoint, isUuid,
    IDENTITY_DELETE_PERMISSION, HR_EMPLOYEE_DELETE_PERMISSION,
} from '@/lib/identity/permanent-deletion'

// ─── GET  /api/identity/permanent-delete?entry=…               ── may the caller use permanent delete here? (UI hint)
// ─── GET  /api/identity/permanent-delete?entry=…&user_id=…     ── eligibility preview for one person
// ─── POST /api/identity/permanent-delete                       ── permanent deletion
//
// The single deletion backend for User Management (entry=user_management) and
// HR → Employees (entry=hr). The database decides everything on every call
// (identity_deletion_preview / _execute): explicit platform.identity.delete for
// the target's organization (+ hr.employee.delete from HR), protections,
// dependency blockers re-checked under lock, preview token, typed confirmation,
// request id (a repeat returns the recorded outcome), durable record. The actor
// is always the session user; nothing in the body decides scope.
const PERMISSIONS = [IDENTITY_DELETE_PERMISSION, HR_EMPLOYEE_DELETE_PERMISSION]

async function currentActorId(): Promise<string | null> {
    const supabase = (await createClient()) as any
    const { data: { user }, error } = await supabase.auth.getUser()
    return error || !user?.id ? null : (user.id as string)
}

async function auditAttempt(actorId: string, operation: string, allowed: boolean, reason: string) {
    try {
        const admin = createAdminClient() as any
        await admin.from('destructive_ops_audit_log').insert({
            operation, user_id: actorId, allowed, reason: reason.slice(0, 1000), created_at: new Date().toISOString(),
        })
    } catch { /* best effort: the database keeps the authoritative record */ }
}

export async function GET(request: NextRequest) {
    try {
        const actorId = await currentActorId()
        if (!actorId) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const params = new URL(request.url).searchParams
        const entry = params.get('entry')
        if (!isDeletionEntryPoint(entry)) return NextResponse.json({ success: false, error: 'The request is incomplete.' }, { status: 400 })
        const userId = params.get('user_id')
        if (!userId) {
            const check = await deletionActorCheck(actorId, entry)
            if (!check.ok) return NextResponse.json({ success: false, error: check.message, code: check.code }, { status: check.status })
            return NextResponse.json({ success: true, data: { ...check.check, permissions: PERMISSIONS } })
        }
        if (!isUuid(userId)) return NextResponse.json({ success: false, error: 'The request is incomplete.' }, { status: 400 })

        const preview = await deletionPreview(actorId, userId, entry)
        if (!preview.ok) return NextResponse.json({ success: false, error: preview.message, code: preview.code }, { status: preview.status })
        return NextResponse.json({ success: true, data: preview.preview })
    } catch {
        return NextResponse.json({ success: false, error: 'The preview did not complete.' }, { status: 500 })
    }
}

export async function POST(request: NextRequest) {
    let actorId: string | null = null
    try {
        actorId = await currentActorId()
        if (!actorId) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

        const body = await request.json().catch(() => ({}))
        const { user_id, entry, request_id, preview_token, reason, confirmation } = body ?? {}
        if (!isUuid(user_id) || !isDeletionEntryPoint(entry) || !isUuid(request_id)
            || typeof preview_token !== 'string' || !preview_token || typeof reason !== 'string' || typeof confirmation !== 'string') {
            return NextResponse.json({ success: false, error: 'The request is incomplete.' }, { status: 400 })
        }
        if (reason.trim().length < 10) {
            return NextResponse.json({ success: false, error: 'Enter a reason of at least 10 characters.', code: 'REASON_REQUIRED' }, { status: 400 })
        }
        if (!confirmation.trim()) {
            return NextResponse.json({ success: false, error: 'Type the confirmation text to continue.', code: 'CONFIRMATION_MISMATCH' }, { status: 400 })
        }

        const executed = await deletionExecute({
            actorId, userId: user_id, entry, requestId: request_id, previewToken: preview_token,
            reason: reason.trim(), confirmation: confirmation.trim(),
        })
        if (!executed.ok) {
            await auditAttempt(actorId, 'identity_permanent_delete', false, `${executed.code}: target ${user_id} via ${entry}`)
            return NextResponse.json({ success: false, error: executed.message, code: executed.code }, { status: executed.status })
        }
        const outcome = executed.outcome
        if (outcome.status === 'stale') {
            return NextResponse.json({ success: false, code: 'PREVIEW_STALE',
                error: 'This person\'s records changed since the preview. Nothing was deleted; review the preview again.' }, { status: 409 })
        }
        if (outcome.status === 'blocked') {
            return NextResponse.json({ success: false, code: 'BLOCKED', error: 'Permanent deletion is not allowed for this person. Nothing was deleted.',
                data: outcome }, { status: 409 })
        }
        await auditAttempt(actorId, 'identity_permanent_delete', true, `deleted ${user_id} via ${entry} (record ${outcome.deletionId})`)
        return NextResponse.json({ success: true, data: outcome })
    } catch {
        if (actorId) await auditAttempt(actorId, 'identity_permanent_delete', false, 'unexpected server error')
        return NextResponse.json({ success: false, code: 'UNCONFIRMED',
            error: 'The deletion result could not be confirmed. Submit again to check — repeating the same request is safe.' }, { status: 500 })
    }
}
