import { NextResponse } from 'next/server'
import { noStore, requireManagerPermission, loadDirectReports } from '@/lib/server/hr/manager-self-service'

export const dynamic = 'force-dynamic'

/**
 * GET /api/hr/mss/team — the manager's own, current, active direct reports (hr.mss.team.view).
 *
 * The manager is the authenticated account and the organization is its own; no employee, user or organization parameter
 * is read, so changing ids cannot reach another manager's team. Only non-sensitive directory fields are returned: name,
 * job title, department, employee number and employment status. No email, phone, salary, banking or payroll data.
 */
export async function GET() {
  const ctx = await requireManagerPermission('hr.mss.team.view')
  if (!ctx.ok) return ctx.response

  try {
    const reports = await loadDirectReports(ctx.admin, ctx.actor.organizationId, ctx.actor.userId)
    return NextResponse.json({ success: true, data: reports }, { headers: noStore })
  } catch {
    return NextResponse.json({ success: false, error: 'Team directory is unavailable' }, { status: 500, headers: noStore })
  }
}
