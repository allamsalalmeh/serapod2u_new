import { NextResponse } from 'next/server'
import { noStore, requireManagerPermission, loadDirectReports } from '@/lib/server/hr/manager-self-service'

export const dynamic = 'force-dynamic'

/**
 * GET /api/hr/mss/attendance — the manager's direct reports' attendance entries (hr.mss.attendance_view).
 *
 * The manager is the authenticated account; only the current, active direct reports' attendance rows in the manager's own
 * organization are returned. The direct-report ids come from the server (never a client id); any user_id the client sends
 * is ignored.
 */
export async function GET() {
  const ctx = await requireManagerPermission('hr.mss.attendance_view')
  if (!ctx.ok) return ctx.response

  const { actor, admin } = ctx
  try {
    const reports = await loadDirectReports(admin, actor.organizationId, actor.userId)
    const reportIds = reports.map((r) => r.userId)
    if (reportIds.length === 0) return NextResponse.json({ success: true, data: [] }, { headers: noStore })

    const { data, error } = await admin
      .from('hr_attendance_entries')
      .select('id, user_id, clock_in_at, clock_out_at, worked_minutes, status, created_at')
      .eq('organization_id', actor.organizationId)
      .in('user_id', reportIds)
      .order('clock_in_at', { ascending: false })
      .limit(500)

    if (error) return NextResponse.json({ success: false, error: 'Team attendance is unavailable' }, { status: 500, headers: noStore })
    return NextResponse.json({ success: true, data: data ?? [] }, { headers: noStore })
  } catch {
    return NextResponse.json({ success: false, error: 'Team attendance is unavailable' }, { status: 500, headers: noStore })
  }
}
