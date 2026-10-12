import { NextResponse } from 'next/server'
import { noStore, requireManagerPermission, loadDirectReports } from '@/lib/server/hr/manager-self-service'

export const dynamic = 'force-dynamic'

/**
 * GET /api/hr/mss/performance — the manager's direct reports' performance reviews (hr.mss.performance.view).
 *
 * The manager is the authenticated account; only the current, active direct reports' reviews in the manager's own
 * organization are returned. Direct-report ids come from the server, never a client id.
 */
export async function GET() {
  const ctx = await requireManagerPermission('hr.mss.performance.view')
  if (!ctx.ok) return ctx.response

  const { actor, admin } = ctx
  try {
    const reports = await loadDirectReports(admin, actor.organizationId, actor.userId)
    const reportIds = reports.map((r) => r.userId)
    if (reportIds.length === 0) return NextResponse.json({ success: true, data: [] }, { headers: noStore })

    const { data, error } = await admin
      .from('hr_performance_reviews')
      .select('id, employee_id, reviewer_id, appraisal_cycle_id, review_type, status, due_date, submitted_at, overall_rating, created_at')
      .eq('organization_id', actor.organizationId)
      .in('employee_id', reportIds)
      .order('created_at', { ascending: false })
      .limit(500)

    if (error) return NextResponse.json({ success: false, error: 'Team performance is unavailable' }, { status: 500, headers: noStore })
    return NextResponse.json({ success: true, data: data ?? [] }, { headers: noStore })
  } catch {
    return NextResponse.json({ success: false, error: 'Team performance is unavailable' }, { status: 500, headers: noStore })
  }
}
