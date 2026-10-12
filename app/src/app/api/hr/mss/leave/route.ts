import { NextResponse } from 'next/server'
import { noStore, requireManagerPermission, loadDirectReports } from '@/lib/server/hr/manager-self-service'

export const dynamic = 'force-dynamic'

/**
 * GET /api/hr/mss/leave — the manager's direct reports' leave requests (hr.mss.leave.view).
 *
 * The manager is the authenticated account; only the current, active direct reports' leave rows in the manager's own
 * organization are returned. Direct-report ids come from the server, never a client id. Approval is a separate,
 * workflow-gated action (hr.mss.leave.approve).
 */
export async function GET() {
  const ctx = await requireManagerPermission('hr.mss.leave.view')
  if (!ctx.ok) return ctx.response

  const { actor, admin } = ctx
  try {
    const reports = await loadDirectReports(admin, actor.organizationId, actor.userId)
    const reportIds = reports.map((r) => r.userId)
    if (reportIds.length === 0) return NextResponse.json({ success: true, data: [] }, { headers: noStore })

    const { data, error } = await admin
      .from('hr_leave_requests')
      .select('id, employee_id, leave_type_id, start_date, end_date, total_days, is_half_day, half_day_period, status, reason, approved_by, approved_at, created_at')
      .eq('organization_id', actor.organizationId)
      .in('employee_id', reportIds)
      .order('created_at', { ascending: false })
      .limit(500)

    if (error) return NextResponse.json({ success: false, error: 'Team leave is unavailable' }, { status: 500, headers: noStore })
    return NextResponse.json({ success: true, data: data ?? [] }, { headers: noStore })
  } catch {
    return NextResponse.json({ success: false, error: 'Team leave is unavailable' }, { status: 500, headers: noStore })
  }
}
