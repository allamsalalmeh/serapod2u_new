import { guardUserOperationInReach } from '@/lib/server/warehouse-reach'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createStockCountPreflightDependencies, evaluateStockCountPreflight } from '@/lib/inventory/stock-count-verification-preflight'
import {
    createStockCountErrorReference,
    stockCountVerificationError,
    STOCK_COUNT_CONFIG_GUIDANCE,
} from '@/lib/inventory/stock-count-verification-errors'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
        const friendly = stockCountVerificationError('authentication_required', { stage: 'preflight' })
        return NextResponse.json({ ok: false, error: friendly.message, code: friendly.code, stage: 'preflight' }, { status: friendly.status })
    }
    // Module entry: own organization or a granted warehouse; the rows below are limited to the caller's scope.
    const saDenied = await guardUserOperationInReach(user.id, 'inventory.stock_count.view')
    if (saDenied) return saDenied
    const sessionId = request.nextUrl.searchParams.get('sessionId')
    if (!sessionId) {
        const friendly = stockCountVerificationError('stock_count_not_found', { stage: 'preflight' })
        return NextResponse.json({ ok: false, error: friendly.message, code: friendly.code, stage: 'preflight' }, { status: friendly.status })
    }
    try {
        const admin = createAdminClient() as any
        const result = await evaluateStockCountPreflight(createStockCountPreflightDependencies(supabase, admin), user.id, sessionId)
        if (!result.ok) {
            const friendly = stockCountVerificationError(result.code, {
                stage: 'preflight',
                message: result.message,
            })
            return NextResponse.json({
                ok: false, error: friendly.message, code: friendly.code, guidance: friendly.guidance, stage: 'preflight',
            }, { status: friendly.status })
        }
        return NextResponse.json({
            ok: true,
            recipientCount: result.recipients.length,
            recipients: result.recipients.map((email) => email.replace(/^(.{1,2}).*(@.*)$/, '$1***$2')),
            authoritativeBaseCosts: result.authoritativeBaseCosts,
            persistedSignature: result.persistedSignature,
            summary: result.summary,
            guidance: STOCK_COUNT_CONFIG_GUIDANCE,
        })
    } catch (error: any) {
        const reference = createStockCountErrorReference()
        console.error('[stock-count-verification/preflight] failed', { reference, message: error?.message })
        const friendly = stockCountVerificationError('unexpected_error', { stage: 'preflight', reference })
        return NextResponse.json({
            ok: false, error: friendly.message, code: friendly.code, reference: friendly.reference, stage: 'preflight',
        }, { status: friendly.status })
    }
}
