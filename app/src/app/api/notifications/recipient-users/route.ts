import { guardUserOperation } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { recipientUserSearchTerm } from '@/lib/notifications/recipientUsers'

/**
 * GET /api/notifications/recipient-users
 *
 * Names for the "Specific users" picker in Notification Types → Configure.
 *   ?ids=<uuid>&ids=<uuid>  hydrate saved selections (stored as UUIDs)
 *   ?q=<text>               search active users by name, email or phone
 *
 * Gated by the same permission as configuring notifications
 * (platform.settings.manage), not platform.user.manage. Reads run with the
 * caller's own session, so row-level security decides which users are visible;
 * a saved ID the caller cannot see, or a deleted user, comes back in
 * `unavailable` instead of being exposed. Only id, name, email, phone and
 * active state are returned.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_IDS = 100
const COLUMNS = 'id, full_name, email, phone, is_active'

export async function GET(request: NextRequest) {
    const params = request.nextUrl.searchParams
    const ids = Array.from(new Set(params.getAll('ids').filter((id) => UUID.test(id)))).slice(0, MAX_IDS)
    const query = recipientUserSearchTerm(params.get('q'))

    if (ids.length === 0 && query.length < 2) return NextResponse.json({ users: [], unavailable: [] })

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const saDenied = await guardUserOperation(user.id, 'platform.settings.manage')
    if (saDenied) return saDenied

    if (ids.length > 0) {
        const { data, error } = await supabase.from('users').select(COLUMNS).in('id', ids)
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        const users = (data || []) as any[]
        const visible = new Set(users.map((row) => row.id))
        return NextResponse.json({ users, unavailable: ids.filter((id) => !visible.has(id)) })
    }

    const pattern = `%${query}%`
    const { data, error } = await supabase
        .from('users')
        .select(COLUMNS)
        .eq('is_active', true)
        .or(`full_name.ilike.${pattern},email.ilike.${pattern},phone.ilike.${pattern}`)
        .order('full_name')
        .limit(10)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ users: data || [], unavailable: [] })
}
