import { guardUserOperation } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { expandNotificationRoleCodes } from '@/lib/notifications/recipientRoleCodes'

/**
 * GET /api/notifications/recipients/preview
 * 
 * Preview who will receive a notification based on recipient config.
 * Does NOT require a sample order - resolves from org context.
 * 
 * Query params:
 *   - roles: comma-separated role codes (e.g. "admin,warehouse")
 *   - dynamicTarget: "manufacturer" | "distributor" | "warehouse"
 *   - userIds: comma-separated user IDs
 *   - consumer: "true" to include consumer placeholder
 */
export async function GET(request: NextRequest) {
    const supabase = await createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const saDenied = await guardUserOperation(user.id, 'platform.settings.manage')
    if (saDenied) return saDenied

    // Get caller's org
    const { data: profile } = await supabase
        .from('users')
        .select('organization_id')
        .eq('id', user.id)
        .single()

    if (!profile?.organization_id) {
        return NextResponse.json({ error: 'Organization not found' }, { status: 404 })
    }

    const orgId = profile.organization_id
    const searchParams = request.nextUrl.searchParams
    const rolesParam = searchParams.get('roles')
    const dynamicTarget = searchParams.get('dynamicTarget')
    const userIdsParam = searchParams.get('userIds')

    const recipients: Array<{
        user_id: string
        full_name: string
        email: string | null
        phone: string | null
        type: string
    }> = []

    const notes: string[] = []

    try {
        // 1. Resolve by roles — search system-wide (not restricted to one org)
        //    Saved notification configs can contain legacy aliases, so expand them
        //    to the live role_code variants used across different environments.
        if (rolesParam) {
            const rawRoles = rolesParam.split(',').map(r => r.trim()).filter(Boolean)
            const roles = expandNotificationRoleCodes(rawRoles)
            if (roles.length > 0) {
                const { data: users } = await supabase
                    .from('users')
                    .select('id, full_name, email, phone, role_code')
                    .in('role_code', roles)
                    .order('full_name')

                if (users) {
                    const ROLE_LABELS: Record<string, string> = {
                        SUPER: 'Super Admin', HQ_ADMIN: 'Admin', MANU_ADMIN: 'Manufacturer Admin',
                        DIST_ADMIN: 'Distributor Admin', WH_MANAGER: 'Warehouse Mgr',
                        USER: 'Staff User', GUEST: 'Guest',
                    }
                    recipients.push(...users.map(u => ({
                        user_id: u.id,
                        full_name: u.full_name || u.email || 'Unknown',
                        email: u.email,
                        phone: u.phone,
                        type: ROLE_LABELS[u.role_code || ''] || (u.role_code || '').replace(/_/g, ' ')
                    })))
                }
            }
        }

        // 2. Related organization ("dynamic target") depends on the transaction: the
        //    distributor or manufacturer on one order. Without an order there is no
        //    single organization, and listing every organization of a type would
        //    show people who never receive the notification. Use the Configure
        //    drawer's "Find recipients" with a real order instead.
        if (dynamicTarget) {
            notes.push('Related organization is resolved per transaction (the distributor or manufacturer on that order). Use Test notification → Find recipients with a real order to see it.')
        }

        // 3. Resolve specific users by ID
        if (userIdsParam) {
            const ids = userIdsParam.split(',').map(id => id.trim()).filter(Boolean)
            if (ids.length > 0) {
                const { data: users } = await supabase
                    .from('users')
                    .select('id, full_name, email, phone')
                    .in('id', ids)
                    .order('full_name')

                if (users) {
                    recipients.push(...users.map(u => ({
                        user_id: u.id,
                        full_name: u.full_name || u.email || 'Unknown',
                        email: u.email,
                        phone: u.phone,
                        type: 'Specific User'
                    })))
                }
            }
        }

        // Deduplicate by user_id
        const unique = Array.from(
            new Map(recipients.map(r => [r.user_id, r])).values()
        )

        return NextResponse.json({
            success: true,
            recipients: unique,
            total: unique.length,
            hasPhone: unique.filter(r => !!r.phone).length,
            missingPhone: unique.filter(r => !r.phone).length,
            notes,
        })
    } catch (error: any) {
        console.error('Recipients preview error:', error)
        return NextResponse.json({ error: error.message }, { status: 500 })
    }
}
