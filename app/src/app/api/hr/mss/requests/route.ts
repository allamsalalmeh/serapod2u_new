import { NextResponse } from 'next/server'
import { noStore, requireManagerPermission, loadDirectReports } from '@/lib/server/hr/manager-self-service'

export const dynamic = 'force-dynamic'

/**
 * GET /api/hr/mss/requests — the manager's direct reports' pending team requests (hr.mss.requests.view).
 *
 * Aggregates the existing request tables (attendance corrections, document requests, profile change requests) for the
 * manager's current, active direct reports only. The direct-report ids come from the server, never a client id.
 */
export async function GET() {
  const ctx = await requireManagerPermission('hr.mss.requests.view')
  if (!ctx.ok) return ctx.response

  const { actor, admin } = ctx
  try {
    const reports = await loadDirectReports(admin, actor.organizationId, actor.userId)
    const reportIds = reports.map((r) => r.userId)
    if (reportIds.length === 0) {
      return NextResponse.json({ success: true, data: { corrections: [], documents: [], profileChanges: [] } }, { headers: noStore })
    }

    const [corrections, documents, profileChanges] = await Promise.all([
      admin.from('hr_attendance_corrections').select('id, entry_id, requested_by, reason, status, reviewed_by, reviewed_at, created_at')
        .eq('organization_id', actor.organizationId).in('requested_by', reportIds).order('created_at', { ascending: false }).limit(500),
      admin.from('hr_document_requests').select('id, employee_user_id, document_type, status, requested_at')
        .eq('organization_id', actor.organizationId).in('employee_user_id', reportIds).order('requested_at', { ascending: false }).limit(500),
      admin.from('hr_profile_change_requests').select('id, employee_user_id, change_payload, status, reviewed_by, reviewed_at, created_at')
        .eq('organization_id', actor.organizationId).in('employee_user_id', reportIds).order('created_at', { ascending: false }).limit(500),
    ])

    if (corrections.error || documents.error || profileChanges.error) {
      return NextResponse.json({ success: false, error: 'Team requests are unavailable' }, { status: 500, headers: noStore })
    }

    return NextResponse.json({
      success: true,
      data: { corrections: corrections.data ?? [], documents: documents.data ?? [], profileChanges: profileChanges.data ?? [] },
    }, { headers: noStore })
  } catch {
    return NextResponse.json({ success: false, error: 'Team requests are unavailable' }, { status: 500, headers: noStore })
  }
}
