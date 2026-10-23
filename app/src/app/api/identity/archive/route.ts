import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isDeletionEntryPoint, isUuid, IDENTITY_DELETE_PERMISSION, HR_EMPLOYEE_DELETE_PERMISSION } from '@/lib/identity/permanent-deletion'
import { archiveExecute, archivePreview, isEmploymentEnd, releaseIdentifiers } from '@/lib/identity/archive'

// ─── GET  /api/identity/archive?entry=…&user_id=…   ── Archive & Revoke Access preview (also for release)
// ─── POST /api/identity/archive                     ── { action: 'archive' | 'release', … }
//
// Shared by User Management (entry=user_management) and HR → Employees
// (entry=hr). The database decides everything on every call
// (identity_archive_preview / _execute, identity_release_identifiers):
// explicit platform.identity.delete for the target's organization
// (+ hr.employee.delete from HR), protections, preview token, typed
// confirmation, request id (a repeat returns the recorded outcome), durable
// record. The actor is always the session user.
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
        const userId = params.get('user_id')
        if (!isDeletionEntryPoint(entry) || !isUuid(userId)) {
            return NextResponse.json({ success: false, error: 'The request is incomplete.' }, { status: 400 })
        }
        const preview = await archivePreview(actorId, userId, entry)
        if (!preview.ok) return NextResponse.json({ success: false, error: preview.message, code: preview.code }, { status: preview.status })
        return NextResponse.json({ success: true, data: { ...preview.preview, permissions: PERMISSIONS } })
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
        const { action, user_id, entry, request_id, preview_token, reason, confirmation, release_identifiers, employment_end } = body ?? {}
        if ((action !== 'archive' && action !== 'release') || !isUuid(user_id) || !isDeletionEntryPoint(entry) || !isUuid(request_id)
            || typeof reason !== 'string') {
            return NextResponse.json({ success: false, error: 'The request is incomplete.' }, { status: 400 })
        }
        // Archive & Revoke Access makes the reason optional; releasing identifiers still requires one.
        if (action === 'release' && reason.trim().length < 10) {
            return NextResponse.json({ success: false, error: 'Enter a reason of at least 10 characters.', code: 'REASON_REQUIRED' }, { status: 400 })
        }

        let executed
        if (action === 'archive') {
            if (typeof preview_token !== 'string' || !preview_token || typeof confirmation !== 'string' || !confirmation.trim()
                || (employment_end !== undefined && !isEmploymentEnd(employment_end))
                || (release_identifiers !== undefined && typeof release_identifiers !== 'boolean')) {
                return NextResponse.json({ success: false, error: 'The request is incomplete.' }, { status: 400 })
            }
            executed = await archiveExecute({
                actorId, userId: user_id, entry, requestId: request_id, previewToken: preview_token, reason: reason.trim(),
                confirmation: confirmation.trim(), releaseIdentifiers: release_identifiers === true,
                employmentEnd: isEmploymentEnd(employment_end) ? employment_end : 'resigned',
            })
        } else {
            executed = await releaseIdentifiers({ actorId, userId: user_id, entry, requestId: request_id, reason: reason.trim() })
        }

        const operation = action === 'archive' ? 'identity_archive' : 'identity_release_identifiers'
        if (!executed.ok) {
            await auditAttempt(actorId, operation, false, `${executed.code}: target ${user_id} via ${entry}`)
            return NextResponse.json({ success: false, error: executed.message, code: executed.code }, { status: executed.status })
        }
        const outcome = executed.outcome
        if (outcome.status === 'stale') {
            return NextResponse.json({ success: false, code: 'PREVIEW_STALE',
                error: 'This person\'s account changed since the preview. Nothing was changed; review the preview again.' }, { status: 409 })
        }
        if (outcome.status === 'blocked') {
            return NextResponse.json({ success: false, code: 'BLOCKED', error: 'Not allowed for this person. Nothing was changed.', data: outcome }, { status: 409 })
        }
        await auditAttempt(actorId, operation, true, `${action} ${user_id} via ${entry} (record ${outcome.actionId})`)
        return NextResponse.json({ success: true, data: outcome })
    } catch {
        if (actorId) await auditAttempt(actorId, 'identity_archive', false, 'unexpected server error')
        return NextResponse.json({ success: false, code: 'UNCONFIRMED',
            error: 'The result could not be confirmed. Submit again to check — repeating the same request is safe.' }, { status: 500 })
    }
}
