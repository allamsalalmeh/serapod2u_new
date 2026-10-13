import { guardUserOperation, userAllowed } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { referenceHeaders, reportServerError } from '@/lib/system-logs/server'
import { createClient } from '@supabase/supabase-js'
import { loadScopedShopUsers, normalizePhone } from '../_user-management-scope'

/**
 * PostgREST sends `id=in.(...)` in the query string, so a few hundred UUIDs push the
 * request line past the gateway's 8 KB limit and the whole endpoint dies with
 * "URI too long" (414). Keep every id filter well under that.
 */
const ID_FILTER_CHUNK_SIZE = 50

/**
 * GET /api/admin/shop-staff-performance
 * Returns shop staff performance rows across the current company hierarchy.
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

        const { shopUsers, allVisibleUsers } = await loadScopedShopUsers(admin, profile.role_code, profile.organization_id, { userId: user.id, permission: 'customer.report.view' })

        if (shopUsers.length === 0) {
            return NextResponse.json({
                success: true,
                data: [],
                meta: {
                    scopedShopUserCount: 0,
                    shopUsersWithPointsCount: 0,
                    scanRowCount: 0,
                    pointsTransactionRowCount: 0,
                    finalReturnedCount: 0,
                },
            })
        }

        const shopOrgIds = Array.from(new Set(shopUsers.map((item) => item.organization_id).filter(Boolean))) as string[]
        const shopOrgs: any[] = []

        for (let index = 0; index < shopOrgIds.length; index += ID_FILTER_CHUNK_SIZE) {
            const { data: shopOrgChunk, error: shopError } = await admin
                .from('organizations')
                .select('id, org_name, state_id, states(state_name)')
                .in('id', shopOrgIds.slice(index, index + ID_FILTER_CHUNK_SIZE))

            if (shopError) throw shopError
            shopOrgs.push(...(shopOrgChunk || []))
        }

        const shopNameById = new Map((shopOrgs || []).map((item) => [item.id, item.org_name]))
        const shopStateById = new Map((shopOrgs || []).map((item: any) => [item.id, item.states?.state_name || null]))
        const userByNormalizedPhone = new Map(
            (allVisibleUsers || [])
                .filter((item) => item.phone)
                .map((item) => [normalizePhone(item.phone), item])
        )
        const staffUsers = shopUsers

        const userIds = staffUsers?.map((item) => item.id) || []
        let scanRowCount = 0
        let pointsTransactionRowCount = 0
        const statsByUser = new Map<string, {
            current_balance: number
            total_collected_system: number
            total_collected_manual: number
            total_migration: number
            total_other: number
            total_redeemed: number
            other_types: Set<string>
            transaction_count: number
            last_transaction_date: string | null
        }>()

        if (userIds.length > 0) {
            for (let index = 0; index < userIds.length; index += ID_FILTER_CHUNK_SIZE) {
                const userIdChunk = userIds.slice(index, index + ID_FILTER_CHUNK_SIZE)
                const { data: scanRows, error: scanError } = await admin
                    .from('consumer_qr_scans')
                    .select('consumer_id, points_amount, points_collected_at, is_manual_adjustment')
                    .eq('collected_points', true)
                    .in('consumer_id', userIdChunk)

                if (scanError) throw scanError
                scanRowCount += (scanRows || []).length

                for (const row of scanRows || []) {
                    const userId = row.consumer_id
                    if (!userId) continue
                    const current = statsByUser.get(userId) || {
                        current_balance: 0,
                        total_collected_system: 0,
                        total_collected_manual: 0,
                        total_migration: 0,
                        total_other: 0,
                        total_redeemed: 0,
                        other_types: new Set<string>(),
                        transaction_count: 0,
                        last_transaction_date: null,
                    }

                    const amount = Number(row.points_amount || 0)
                    current.current_balance += amount
                    current.transaction_count += 1
                    if (row.is_manual_adjustment) {
                        current.total_collected_manual += amount
                    } else {
                        current.total_collected_system += amount
                    }
                    if (!current.last_transaction_date || (row.points_collected_at && row.points_collected_at > current.last_transaction_date)) {
                        current.last_transaction_date = row.points_collected_at
                    }
                    statsByUser.set(userId, current)
                }

                const { data: transactionRows, error: transactionError } = await admin
                    .from('points_transactions')
                    .select('user_id, transaction_type, points_amount, transaction_date')
                    .in('user_id', userIdChunk)

                if (transactionError) throw transactionError
                pointsTransactionRowCount += (transactionRows || []).length

                for (const row of transactionRows || []) {
                    const userId = row.user_id
                    if (!userId) continue

                    const current = statsByUser.get(userId) || {
                        current_balance: 0,
                        total_collected_system: 0,
                        total_collected_manual: 0,
                        total_migration: 0,
                        total_other: 0,
                        total_redeemed: 0,
                        other_types: new Set<string>(),
                        transaction_count: 0,
                        last_transaction_date: null,
                    }

                    const amount = Number(row.points_amount || 0)
                    const type = row.transaction_type || ''

                    if (type !== 'adjust') {
                        current.current_balance += amount
                    }

                    if (type === 'adjust') {
                        current.total_collected_manual += amount
                        current.current_balance += amount
                    } else if (type === 'MIGRATION') {
                        current.total_migration += amount
                    } else if (type === 'redeem') {
                        current.total_redeemed += Math.abs(amount)
                    } else {
                        current.total_other += amount
                        if (type) current.other_types.add(type)
                    }

                    current.transaction_count += 1
                    if (!current.last_transaction_date || (row.transaction_date && row.transaction_date > current.last_transaction_date)) {
                        current.last_transaction_date = row.transaction_date
                    }

                    statsByUser.set(userId, current)
                }
            }
        }

        const data = (staffUsers || []).map((staff) => {
            const stats = statsByUser.get(staff.id)
            const referenceUser = userByNormalizedPhone.get(normalizePhone(staff.referral_phone))
            return {
                user_id: staff.id,
                consumer_name: staff.full_name || 'Unknown Shop Staff',
                consumer_phone: staff.phone,
                consumer_email: staff.email,
                consumer_location: shopStateById.get(staff.organization_id || '') || null,
                consumer_reference: staff.referral_phone || null,
                referral_name: referenceUser?.full_name || null,
                referral_email: referenceUser?.email || null,
                referral_phone_full: referenceUser?.phone || null,
                consumer_shop_name: shopNameById.get(staff.organization_id || '') || null,
                current_balance: stats?.current_balance || 0,
                total_collected_system: stats?.total_collected_system || 0,
                total_collected_manual: stats?.total_collected_manual || 0,
                total_migration: stats?.total_migration || 0,
                total_other: stats?.total_other || 0,
                other_types: stats?.other_types ? Array.from(stats.other_types).join(', ') : null,
                total_redeemed: stats?.total_redeemed || 0,
                transaction_count: stats?.transaction_count || 0,
                last_transaction_date: stats?.last_transaction_date || null,
                last_migration_by_name: null,
            }
        }).sort((left, right) => right.current_balance - left.current_balance)

        const shopUsersWithPointsCount = data.filter((item) => item.transaction_count > 0 || item.current_balance !== 0).length

        return NextResponse.json({
            success: true,
            data,
            meta: {
                scopedShopUserCount: staffUsers.length,
                shopUsersWithPointsCount,
                scanRowCount,
                pointsTransactionRowCount,
                finalReturnedCount: data.length,
            },
        })
    } catch (err: any) {
        console.error('shop-staff-performance error:', err)
        // System Logs (Product Catalog): the browser's report of this failure links to this one via the returned reference.
        const referenceId = await reportServerError({ error: err, status: 500, module: 'Product Catalog', action: 'Load shop staff performance',
            apiRoute: '/api/admin/shop-staff-performance', method: 'GET', actorId })
        return NextResponse.json({ error: err.message, referenceId }, { status: 500, headers: referenceHeaders(referenceId) })
    }
}
