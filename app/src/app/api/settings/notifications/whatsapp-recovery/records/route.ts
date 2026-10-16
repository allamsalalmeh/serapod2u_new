import { NextRequest, NextResponse } from 'next/server'

import { isAdminUser } from '@/app/api/settings/whatsapp/_utils'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { LEGACY_LIMIT, loadWhatsAppRecords } from '@/lib/notifications/monitor/channelLoaders'

export const dynamic = 'force-dynamic'

export async function GET(_request: NextRequest) {
    try {
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

        const adminAllowed = await isAdminUser(supabase as any, user.id)
        if (!adminAllowed) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

        const admin = createAdminClient()
        const { data: profile } = await (admin as any).from('users').select('organization_id').eq('id', user.id).single()
        const { records } = await loadWhatsAppRecords(admin, profile?.organization_id || null, { limit: LEGACY_LIMIT })
        return NextResponse.json({ records })
    } catch (error: any) {
        console.error('[wa-recovery/records]', error)
        return NextResponse.json({ error: error?.message || 'Server error' }, { status: 500 })
    }
}
