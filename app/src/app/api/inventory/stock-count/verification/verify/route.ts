import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkPermissionForUser } from '@/lib/server/permissions'
import { hashStockCountCode } from '@/lib/inventory/stock-count-verification-server'
import {
    createStockCountErrorReference,
    mapStockCountDatabaseError,
    STOCK_COUNT_POST_PERMISSION,
    stockCountVerificationError,
} from '@/lib/inventory/stock-count-verification-errors'
import { isAuthorizationDenied, requireAuthorization } from '@/lib/security-access/authorization'
import { resolveWarehouseResourceContext } from '@/lib/security-access/resource-context'

export const dynamic = 'force-dynamic'

function jsonError(friendly: ReturnType<typeof stockCountVerificationError>) {
    return NextResponse.json({
        error: friendly.message,
        code: friendly.code,
        guidance: friendly.guidance,
        reference: friendly.reference,
        stage: friendly.stage || 'verify',
    }, { status: friendly.status })
}

export async function POST(request: NextRequest) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
        return jsonError(stockCountVerificationError('authentication_required', { stage: 'verify' }))
    }
    let requestIdForAudit: string | null = null
    try {
        const { requestId, sessionId, code } = await request.json()
        requestIdForAudit = typeof requestId === 'string' ? requestId : null
        if (!requestId || !sessionId || !/^\d{8}$/.test(String(code || ''))) {
            return jsonError(stockCountVerificationError('invalid_code', { stage: 'verify' }))
        }
        const { data: accessibleSession } = await (supabase as any)
            .from('stock_count_sessions')
            .select('id,status,count_type,warehouse_organization_id')
            .eq('id', sessionId)
            .maybeSingle()
        if (!accessibleSession) {
            return jsonError(stockCountVerificationError('stock_count_access_denied', { stage: 'verify' }))
        }
        const admin = createAdminClient() as any
        const { data: activeWarehouse } = await admin
            .from('organizations')
            .select('id')
            .eq('id', accessibleSession.warehouse_organization_id)
            .eq('org_type_code', 'WH')
            .eq('is_active', true)
            .maybeSingle()
        if (!activeWarehouse) {
            return jsonError(stockCountVerificationError('invalid_warehouse', { stage: 'post' }))
        }
        if (accessibleSession.status === 'posted') {
            return jsonError(stockCountVerificationError('already_posted', { stage: 'post' }))
        }
        if (accessibleSession.count_type === 'initial_configuration_classification') {
            return jsonError(stockCountVerificationError('invalid_count_data', {
                stage: 'post',
                message: 'Legacy Initial Classification drafts are read-only. Use Inventory Opening Balance & Initial Classification.',
            }))
        }
        // Legacy key post_stock_count: the posting authority while inventory.stock_count.post is
        // LEGACY_ENFORCED/SHADOW (requireAuthorization below uses it as the legacy evaluator); the
        // organization context is needed in every mode for the code hash.
        const permission = await checkPermissionForUser(user.id, STOCK_COUNT_POST_PERMISSION)
        if (!permission.context?.organization_id) {
            return jsonError(stockCountVerificationError('permission_denied', { stage: 'verify' }))
        }
        const resource = {
            type: 'stock_count', id: sessionId,
            ...(await resolveWarehouseResourceContext(permission.context.organization_id, accessibleSession.warehouse_organization_id)),
        }
        // Consuming the OTP completes the verification: enforce
        // inventory.stock_count.verify through the S&A contract before the
        // atomic verify-and-post RPC. A new-engine DENY in NEW_ENFORCED stops
        // here; the database backstop rejects any path that skipped this call.
        try {
            await requireAuthorization({
                actorId: user.id,
                permission: 'inventory.stock_count.verify',
                resource,
                context: { correlationId: requestIdForAudit },
            })
        } catch (authorizationError) {
            if (isAuthorizationDenied(authorizationError)) {
                return jsonError(stockCountVerificationError('permission_denied', {
                    stage: 'verify', reference: authorizationError.decisionId,
                }))
            }
            throw authorizationError
        }
        // Posting itself: inventory.stock_count.post through the same contract. LEGACY_ENFORCED/SHADOW:
        // the legacy key decides exactly as before (SHADOW records the comparison). NEW_ENFORCED/
        // LEGACY_RETIRED: the S&A decision for this warehouse decides; the database repeats it when the
        // code is consumed (sa_stock_count_post_enforcement, stock_count_user_can_post).
        try {
            await requireAuthorization({
                actorId: user.id,
                permission: 'inventory.stock_count.post',
                resource,
                context: { correlationId: requestIdForAudit },
            }, { legacy: () => permission.allowed })
        } catch (authorizationError) {
            if (isAuthorizationDenied(authorizationError)) {
                return jsonError(stockCountVerificationError('permission_denied', {
                    stage: 'verify', reference: authorizationError.decisionId,
                }))
            }
            throw authorizationError
        }
        const codeHash = hashStockCountCode(String(code), permission.context.organization_id, sessionId, user.id)
        const postingFunction = accessibleSession.count_type === 'opening_balance_cutoff'
                ? 'verify_and_post_inventory_opening_cutoff'
                : 'verify_and_post_stock_count'
        const { data, error } = await (supabase as any).rpc(postingFunction, {
            p_request_id: requestId, p_code_hash: codeHash,
        })
        if (error) throw error
        if (data?.error_code) throw new Error(data.error_code)
        return NextResponse.json(data)
    } catch (error: any) {
        const reference = createStockCountErrorReference()
        // Every failure — specific or unexpected — carries the same correlation
        // reference that is written to the server log and to posting_result, so
        // an actionable message is still traceable to this exact attempt.
        const mapped = mapStockCountDatabaseError(error?.message || '', 'post', error?.code, reference)
        const friendly = { ...mapped, stage: mapped.stage || 'post', reference }
        console.error('[stock-count-verification/verify] failed', {
            reference: friendly.reference || reference,
            requestId: requestIdForAudit,
            code: friendly.code,
            // Full Postgres/PostgREST diagnostics stay server-side only.
            sqlState: error?.code ?? null,
            message: error?.message ?? null,
            detail: error?.details ?? error?.detail ?? null,
            hint: error?.hint ?? null,
            // Never log secrets / plaintext codes / stack traces to clients; server log only.
        })
        if (requestIdForAudit) {
            try {
                const admin = createAdminClient() as any
                await admin.from('stock_count_verification_requests').update({
                    posting_result: {
                        status: 'failed',
                        error_code: friendly.code,
                        sql_state: error?.code ?? null,
                        // Raw server error string, admin-only. Without it a P0001
                        // rejection is only correlatable while the server log is
                        // still around (the SC-MSB3UFDM-1FSK investigation).
                        // Never contains the plaintext code or any secret.
                        db_message: String(error?.message ?? '').slice(0, 500) || null,
                        reference: friendly.reference || reference,
                        recorded_at: new Date().toISOString(),
                    },
                }).eq('id', requestIdForAudit).eq('requesting_user_id', user.id)
            } catch (auditError: any) {
                console.error('[stock-count-verification/verify] audit update failed', {
                    requestId: requestIdForAudit,
                    message: auditError?.message,
                })
            }
        }
        return jsonError(friendly)
    }
}
