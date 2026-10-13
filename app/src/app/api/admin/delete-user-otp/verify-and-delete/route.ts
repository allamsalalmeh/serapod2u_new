import { guardUserOperation } from '@/lib/security-access/operation'
import { archiveIdentityKeepingIdentifiers, authorizeIdentityRemoval } from '@/lib/identity/removal-authorization'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { hashOtp, logNotificationEvent } from '@/server/auth/passwordResetService'
import { identityHistoryReferences } from '@/lib/identity/provisioning'

const PURPOSE = 'user_deletion'
type UserRemovalMode = 'delete' | 'archive'

async function getUserRemovalMode(admin: any, userId: string): Promise<UserRemovalMode> {
    // One definition of "history" for every removal path: any business or
    // audit reference except the identity's own memberships, sessions and
    // consumer loyalty data (public.identity_history_references). The database
    // refuses a hard delete of such an identity (users_history_delete_guard).
    const references = await identityHistoryReferences(userId)
    // A failed check must never fall through to hard deletion.
    if (references === null) return 'archive'
    return references.length > 0 ? 'archive' : 'delete'
}

/**
 * POST /api/admin/delete-user-otp/verify-and-delete
 * 
 * Step 2: Verify OTP and execute deletion.
 * 
 * Body: { targetUserId: string, code: string, codeId: string }
 * 
 * Security:
 * - Archive Identities (platform.identity.delete) for the TARGET's organization,
 *   re-decided here (never trusted from the OTP request), before the code is
 *   checked or consumed; until enforced, HQ Admin / Super Admin (role_level <= 10)
 * - Target protection and self-removal refusal (lib/identity/removal-authorization)
 * - OTP must match (hashed comparison)
 * - OTP must not be expired, used, or invalidated
 * - Max 5 attempts per OTP
 * - Target user must match the one in the OTP request
 * - Full audit trail + cascading cleanup before deletion
 */
export async function POST(request: NextRequest) {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null

    try {
        const supabase = await createClient()
        const admin = createAdminClient()
        // Untyped alias for tables not in generated Database types
        const db: any = admin

        // --- Auth + HQ Admin / Super Admin check ---
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        const saDenied = await guardUserOperation(user.id, 'platform.data.destructive')
        if (saDenied) return saDenied

        const { targetUserId, code, codeId } = await request.json().catch(() => ({}))
        if (!targetUserId || !code || !codeId) {
            return NextResponse.json({ error: 'targetUserId, code, and codeId are required' }, { status: 400 })
        }

        // Authorization is decided again at submission (current permission,
        // mode, target organization and target protection) before the code is
        // checked: a refused request changes neither the OTP nor the account.
        const removal = await authorizeIdentityRemoval(user.id, targetUserId)
        if (!removal.ok) {
            if (removal.status === 403) {
                await logDeletionAudit(admin, {
                    operation: 'delete_user_execute',
                    userId: user.id,
                    userEmail: user.email || null,
                    allowed: false,
                    reason: removal.auditReason,
                    ip,
                })
            }
            return NextResponse.json(
                { success: false, error: removal.error, code: removal.code, ...(removal.decisionId ? { decisionId: removal.decisionId } : {}) },
                { status: removal.status }
            )
        }
        const targetUser = removal.target

        // --- Find and validate OTP ---
        const { data: codeRow } = await db
            .from('auth_verification_codes')
            .select('*')
            .eq('id', codeId)
            .eq('purpose', PURPOSE)
            .is('invalidated_at', null)
            .is('used_at', null)
            .single()

        if (!codeRow) {
            return NextResponse.json({ error: 'Invalid or expired verification code. Please request a new one.' }, { status: 400 })
        }

        // Check expiry
        if (new Date(codeRow.expires_at) < new Date()) {
            return NextResponse.json({ error: 'Verification code expired. Please request a new one.' }, { status: 400 })
        }

        // Check attempts
        if (codeRow.attempt_count >= codeRow.max_attempts) {
            // Invalidate the code
            await db
                .from('auth_verification_codes')
                .update({ invalidated_at: new Date().toISOString() })
                .eq('id', codeId)

            return NextResponse.json({ error: 'Too many incorrect attempts. Please request a new code.' }, { status: 400 })
        }

        // Increment attempt
        await db
            .from('auth_verification_codes')
            .update({ attempt_count: (codeRow.attempt_count || 0) + 1 })
            .eq('id', codeId)

        // Verify code hash
        const inputHash = hashOtp(code)
        if (inputHash !== codeRow.code_hash) {
            const remaining = codeRow.max_attempts - (codeRow.attempt_count || 0) - 1
            return NextResponse.json(
                { error: `Incorrect code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.` },
                { status: 400 }
            )
        }

        // Verify target user matches (a code is bound to one target; a code
        // without a recorded target is never accepted)
        const meta = codeRow.meta || {}
        if (meta.target_user_id !== targetUserId) {
            return NextResponse.json({ error: 'Target user mismatch. Please request a new code.' }, { status: 400 })
        }

        // Verify requester matches
        if (codeRow.user_id !== user.id) {
            return NextResponse.json({ error: 'This code was requested by a different admin.' }, { status: 403 })
        }

        // Recheck immediately before mutating: history may have been created
        // between the OTP request and this confirmation.
        const removalMode = await getUserRemovalMode(admin, targetUserId)

        if (removalMode === 'archive') {
            const archiveResult = await archiveIdentityKeepingIdentifiers(user.id, targetUser.id)
            if (archiveResult.error) {
                return NextResponse.json({
                    error: `Unable to archive this user: ${archiveResult.error}`,
                }, { status: archiveResult.status ?? 500 })
            }

            await db
                .from('auth_verification_codes')
                .update({ used_at: new Date().toISOString(), verified_at: new Date().toISOString() })
                .eq('id', codeId)

            await logDeletionAudit(admin, {
                operation: 'archive_user_keep_identifiers',
                userId: user.id,
                userEmail: user.email || null,
                allowed: true,
                reason: `Archived ${targetUser.full_name || targetUser.email}; retained business history; email/phone remain reserved`,
                ip,
            })

            return NextResponse.json({
                success: true,
                mode: 'archive',
                message: `${targetUser.full_name || targetUser.email} was archived. Their history is kept and their email/phone stay reserved; reactivate the account if they return.`,
            })
        }

        // --- OTP verified — permanently delete a user with no retained history ---
        // Mark code as used only once an irreversible operation is about to start.
        await db
            .from('auth_verification_codes')
            .update({ used_at: new Date().toISOString(), verified_at: new Date().toISOString() })
            .eq('id', codeId)

        // --- Cascading cleanup (same as deleteUserWithAuth but more thorough) ---
        const cleanupErrors: string[] = []

        // Delete audit_logs
        const { error: e1 } = await admin.from('audit_logs').delete().eq('user_id', targetUserId)
        if (e1) cleanupErrors.push(`audit_logs: ${e1.message}`)

        // Delete points_transactions
        const { error: e2 } = await admin.from('points_transactions').delete().eq('user_id', targetUserId)
        if (e2) cleanupErrors.push(`points_transactions: ${e2.message}`)

        // Delete consumer_activations by email
        if (targetUser.email) {
            const { error: e3 } = await admin.from('consumer_activations').delete().eq('consumer_email', targetUser.email)
            if (e3) cleanupErrors.push(`consumer_activations(email): ${e3.message}`)
        }

        // Delete consumer_activations by phone
        if (targetUser.phone) {
            const { error: e4 } = await admin.from('consumer_activations').delete().eq('consumer_phone', targetUser.phone)
            if (e4) cleanupErrors.push(`consumer_activations(phone): ${e4.message}`)
        }

        // Nullify consumer_qr_scans
        const { error: e5 } = await admin.from('consumer_qr_scans').update({ consumer_id: null }).eq('consumer_id', targetUserId)
        if (e5) cleanupErrors.push(`consumer_qr_scans: ${e5.message}`)

        // Reassign retained business records so hard delete does not break foreign keys.
        const ownershipTransferErrors = await transferOwnedBusinessRecords(db, targetUserId, user.id)
        cleanupErrors.push(...ownershipTransferErrors)

        // Nullify reference_assignments
        await admin.from('reference_assignments').update({ reference_user_id: null }).eq('reference_user_id', targetUserId)
        await admin.from('reference_assignments').delete().eq('user_id', targetUserId)

        // Delete notification_events for this user
        await db.from('notification_events').delete().eq('user_id', targetUserId)

        // Delete support_conversations
        await db.from('support_conversations').delete().eq('consumer_id', targetUserId)

        // --- Delete from public.users ---
        const { error: dbError } = await admin.from('users').delete().eq('id', targetUserId)

        if (dbError) {
            console.error('❌ User deletion failed after OTP verification:', dbError)

            await logDeletionAudit(admin, {
                operation: 'delete_user_execute',
                userId: user.id,
                userEmail: user.email || null,
                allowed: true,
                reason: `DB delete failed: ${dbError.message} | Target: ${targetUser.full_name || targetUser.email}`,
                ip,
            })

            return NextResponse.json(
                { error: `Deletion failed: ${dbError.message}. Cleanup errors: ${cleanupErrors.join('; ') || 'none'}` },
                { status: 500 }
            )
        }

        // --- Delete from Supabase Auth ---
        const { error: authError } = await admin.auth.admin.deleteUser(targetUserId)

        // --- Audit ---
        await logDeletionAudit(admin, {
            operation: 'delete_user_execute',
            userId: user.id,
            userEmail: user.email || null,
            allowed: true,
            reason: `User deleted: ${targetUser.full_name || targetUser.email} (${targetUser.email}). Auth cleanup: ${authError ? 'failed' : 'ok'}`,
            ip,
        })

        await logNotificationEvent(admin, {
            eventType: 'delete_user_completed',
            phone: codeRow?.phone_normalized,
            userId: user.id,
            status: 'completed',
            meta: {
                target_user_id: targetUserId,
                target_user_name: targetUser.full_name,
                target_user_email: targetUser.email,
                cleanup_errors: cleanupErrors,
            },
            ip,
        })

        return NextResponse.json({
            success: true,
            message: `${targetUser.full_name || targetUser.email} deleted successfully`,
            warning: authError ? 'User records deleted but auth cleanup failed' : undefined,
            cleanupErrors: cleanupErrors.length > 0 ? cleanupErrors : undefined,
        })
    } catch (err: any) {
        console.error('Delete user verify error:', err)
        return NextResponse.json({
            error: 'Unable to complete the user removal. No account was deleted; please try again or contact support.',
        }, { status: 500 })
    }
}

async function logDeletionAudit(
    admin: any,
    entry: { operation: string; userId: string; userEmail: string | null; allowed: boolean; reason: string; ip: string | null }
) {
    const prefix = entry.allowed ? '✅ DELETE-OP' : '🚫 DELETE-OP BLOCKED'
    console.log(`${prefix} | op=${entry.operation} | user=${entry.userEmail ?? entry.userId} | reason=${entry.reason}`)

    try {
        await admin.from('destructive_ops_audit_log').insert({
            operation: entry.operation,
            user_id: entry.userId,
            user_email: entry.userEmail,
            allowed: entry.allowed,
            reason: entry.reason,
            ip_address: entry.ip,
            created_at: new Date().toISOString(),
        })
    } catch { /* best effort */ }
}

async function transferOwnedBusinessRecords(
    admin: any,
    fromUserId: string,
    toUserId: string
): Promise<string[]> {
    const errors: string[] = []

    const operations: Array<{
        table: string
        column: string
        value: string | null
        label: string
    }> = [
            { table: 'documents', column: 'created_by', value: toUserId, label: 'documents.created_by' },
            { table: 'documents', column: 'acknowledged_by', value: null, label: 'documents.acknowledged_by' },
            { table: 'document_files', column: 'uploaded_by', value: toUserId, label: 'document_files.uploaded_by' },
            { table: 'orders', column: 'created_by', value: toUserId, label: 'orders.created_by' },
            { table: 'orders', column: 'approved_by', value: null, label: 'orders.approved_by' },
            { table: 'orders', column: 'updated_by', value: null, label: 'orders.updated_by' },
        ]

    for (const operation of operations) {
        const { error } = await admin
            .from(operation.table)
            .update({ [operation.column]: operation.value })
            .eq(operation.column, fromUserId)

        if (error) {
            errors.push(`${operation.label}: ${error.message}`)
        }
    }

    return errors
}
