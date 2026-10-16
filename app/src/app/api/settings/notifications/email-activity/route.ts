import { guardUserOperation } from '@/lib/security-access/operation'
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { canViewEmailMonitor } from '@/lib/notifications/emailMonitorAccess'
import { LEGACY_LIMIT, loadEmailMessages } from '@/lib/notifications/monitor/channelLoaders'
import { canViewMonitor, loadMonitorViewer, resolveMonitorScope } from '@/lib/notifications/monitorScope'

export const dynamic = 'force-dynamic'

export async function GET(_request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const saDenied = await guardUserOperation(user.id, 'platform.settings.manage')
    if (saDenied) return saDenied
    if (!await canViewEmailMonitor(supabase, user.id)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const admin = createAdminClient()
    const viewer = await loadMonitorViewer(admin, user.id)
    if (!viewer || !canViewMonitor(viewer)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    // HQ staff oversee every organization; everyone else sees only their own.
    const { messages } = await loadEmailMessages(admin, resolveMonitorScope(viewer), { limit: LEGACY_LIMIT })

    const kpis = {
      pending: messages.filter((row) => row.status === 'pending').length,
      sent: messages.filter((row) => row.status === 'sent').length,
      delivered: messages.filter((row) => row.status === 'delivered').length,
      failed: messages.filter((row) => row.status === 'failed').length,
      total: messages.length,
    }
    return NextResponse.json({ success: true, kpis, messages })
  } catch (error: any) {
    console.error('[email-activity]', error)
    return NextResponse.json({ error: error.message || 'Failed to load email activity' }, { status: 500 })
  }
}
