import { guardUserOperation } from '@/lib/security-access/operation'
import { archiveIdentityKeepingIdentifiers, authorizeIdentityRemoval } from '@/lib/identity/removal-authorization'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { hashOtp } from '@/server/auth/passwordResetService'

const PURPOSE = 'user_deletion'

/**
 * POST /api/admin/delete-user-otp/verify-and-delete
 * 
 * Step 2: Verify OTP and archive the account (history kept, identifiers
 * reserved). Permanent deletion is /api/identity/permanent-delete.
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
 * - Full audit trail; never a hard delete
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

        // Archive only. Permanent deletion is the canonical identity deletion
        // (/api/identity/permanent-delete → identity_deletion_execute), shared
        // with HR; this OTP flow never hard-deletes an identity.
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
