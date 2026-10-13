import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getHrAuthContext, hrCan } from '@/lib/server/hrAccess'
import { loadChangeRequest } from '@/lib/server/hr/position-workflow'

export const dynamic = 'force-dynamic'

/** GET /api/hr/position-change-requests/[id] — detail with approval steps. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const supabase = (await createClient()) as any
    const ctxResult = await getHrAuthContext(supabase)
    if (!ctxResult.success || !ctxResult.data) {
      return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
    }
    const { organizationId } = ctxResult.data
    if (!organizationId) return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
    // Change requests carry assignment payloads; only HR administrators read them (same rule as /api/hr/employees).
    if (!(await hrCan(ctxResult.data, 'hr.employee.manage'))) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })

    const { id } = await params
    const admin = createAdminClient() as any
    const result = await loadChangeRequest(admin, organizationId, id)
    if (!result.success) return NextResponse.json({ success: false, error: result.error }, { status: 404 })
    return NextResponse.json({ success: true, data: result.data })
  } catch (error: any) {
    console.error('Failed to load change request:', error)
    return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
  }
}
