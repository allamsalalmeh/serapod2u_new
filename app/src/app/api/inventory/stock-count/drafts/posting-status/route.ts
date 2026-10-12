import { guardUserOperationInReach } from '@/lib/server/warehouse-reach'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

/**
 * Returns the minimum safe "final verification started" status for a set of
 * Stock Count drafts, so Manage Drafts can decide which rows are still
 * discardable.
 *
 * Protection boundary = explicit OTP request for final posting
 * (`stock_count_verification_requests` in pending_delivery / active / posted).
 *
 * A warehouse freeze / counting Opening Balance cutoff alone is NOT posting
 * started — operators may still discard unfinished pre-OTP drafts.
 *
 * `stock_count_verification_requests` is deliberately server-only (it stores OTP
 * code hashes and is REVOKEd from the authenticated role). The browser must
 * therefore never query it directly. This route reads it with the service role
 * behind an authenticated, warehouse-scoped authorization check and returns
 * only session IDs — never codes, hashes, recipients or any other verification
 * payload.
 */
export async function POST(request: NextRequest) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
        return NextResponse.json({ error: 'authentication_required' }, { status: 401 })
    }
    // Module entry: own organization or a granted warehouse; the rows below are limited to the caller's scope.
    const saDenied = await guardUserOperationInReach(user.id, 'inventory.stock_count.view')
    if (saDenied) return saDenied

    let sessionIds: unknown
    try {
        ({ sessionIds } = await request.json())
    } catch {
        return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
    }
    if (!Array.isArray(sessionIds)) {
        return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
    }
    const requestedIds = [...new Set(
        sessionIds.filter((id): id is string => typeof id === 'string' && id.length > 0),
    )].slice(0, 500)
    if (requestedIds.length === 0) {
        return NextResponse.json({ postingStartedSessionIds: [] })
    }

    // Authorization: the caller only learns about sessions RLS already lets them
    // see (org/warehouse scoped via stock_count_sessions_manage_org). Anything
    // outside their access is silently dropped here.
    const { data: accessible, error: accessError } = await (supabase as any)
        .from('stock_count_sessions')
        .select('id')
        .in('id', requestedIds)
    if (accessError) {
        return NextResponse.json({ error: 'stock_count_access_denied' }, { status: 403 })
    }
    const accessibleIds = (accessible || []).map((row: any) => row.id as string)
    if (accessibleIds.length === 0) {
        return NextResponse.json({ postingStartedSessionIds: [] })
    }

    const admin = createAdminClient() as any
    const verificationResult = await admin
        .from('stock_count_verification_requests')
        .select('session_id')
        .in('session_id', accessibleIds)
        .in('status', ['pending_delivery', 'active', 'posted'])

    if (verificationResult.error) {
        return NextResponse.json({ error: 'posting_status_unavailable' }, { status: 500 })
    }

    const postingStartedSessionIds = [...new Set<string>(
        (verificationResult.data || []).map((row: any) => row.session_id as string),
    )]

    return NextResponse.json({ postingStartedSessionIds })
}
