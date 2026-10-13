import { guardUserOperation, userAllowed } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { referenceHeaders, reportServerError } from '@/lib/system-logs/server'
import { createClient } from '@supabase/supabase-js'
import { loadScopedShopUsers } from '../_user-management-scope'

/**
 * GET /api/admin/consumer-performance
 * Returns non-shop consumer performance rows for the current company scope.
 */
export async function GET(_request: NextRequest) {
    let actorId: string | null = null
    try {
        const { createClient: createServerClient } = await import('@/lib/supabase/server')
        const supabase = await createServerClient()
        const { data: { user }, error: authError } = await supabase.auth.getUser()

        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }
        actorId = user.id
        const saDenied = await guardUserOperation(user.id, 'customer.consumer.view')
        if (saDenied) return saDenied

        const admin = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { auth: { autoRefreshToken: false, persistSession: false } }
        )

        const { data: profile } = await admin
            .from('users')
            .select('role_code, organization_id')
            .eq('id', user.id)
            .single()

        // Cross-shop reports are an S&A decision (customer.report.view); the
        // historical admin role list is the legacy evaluator.
        if (!profile || !(await userAllowed(user.id, 'customer.report.view', () => ['SA', 'HQ', 'POWER_USER'].includes(profile.role_code)))) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        }

        const { shopUsers } = await loadScopedShopUsers(admin, profile.role_code, profile.organization_id, { userId: user.id, permission: 'customer.report.view' })
        const excludedUserIds = new Set(shopUsers.map((item) => item.id))

        const { data: consumerScanRows, error: consumerScanError } = await admin
            .from('consumer_qr_scans')
            .select('consumer_id')
            .eq('claim_lane', 'consumer')
            .eq('collected_points', true)

        if (consumerScanError) throw consumerScanError

        const consumerLaneUserIds = new Set(
            (consumerScanRows || [])
                .map((row: any) => row.consumer_id)
                .filter(Boolean)
        )

        const { data: consumerRows, error: consumerError } = await admin
            .from('v_consumer_points_balance')
            .select('*')
            .order('current_balance', { ascending: false })

        if (consumerError) throw consumerError

        const data = (consumerRows || []).filter((row: any) => {
            if (excludedUserIds.has(row.user_id)) return false
            if (!consumerLaneUserIds.has(row.user_id)) return false
            return true
        })

        return NextResponse.json({ success: true, data })
    } catch (err: any) {
        console.error('consumer-performance error:', err)
        // System Logs (Product Catalog): the browser's report of this failure links to this one via the returned reference.
        const referenceId = await reportServerError({ error: err, status: 500, module: 'Product Catalog', action: 'Load consumer performance',
            apiRoute: '/api/admin/consumer-performance', method: 'GET', actorId })
        return NextResponse.json({ error: err.message, referenceId }, { status: 500, headers: referenceHeaders(referenceId) })
    }
}