import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadNavActor, resolveDestinationAccess } from '@/lib/server/nav-access'
import { loadStaffChart } from '@/lib/server/hr/staff-org-chart'

export const dynamic = 'force-dynamic'

/**
 * GET /api/hr/org-chart/staff — the limited, read-only staff organization chart.
 *
 * Authorized by the same destinations the screen uses: the administrative chart (hr.employee.view with the HR module
 * entry) or the staff directory read (hr.employee.view_internal). Both are decided by the canonical Security & Access
 * evaluation. The organization is the verified account's own; nothing in the request selects an organization or a
 * person. The response is a server-side projection (name, job title, department, reporting line); see
 * lib/server/hr/staff-org-chart.ts.
 */
export async function GET() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })

  const actor = await loadNavActor(user.id)
  if (!actor?.organizationId) return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })

  const access = await resolveDestinationAccess(actor, ['hr/people/org-chart', 'hr/people/org-chart/staff'])
  if (access.state === 'unavailable') return NextResponse.json({ success: false, error: 'Access could not be checked' }, { status: 503 })
  if (access.state !== 'allowed') return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  try {
    const nodes = await loadStaffChart(createAdminClient() as any, actor.organizationId, user.id)
    return NextResponse.json({ success: true, nodes }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ success: false, error: 'The organization chart is unavailable' }, { status: 500 })
  }
}
