import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getHrAuthContext, hrCan } from '@/lib/server/hrAccess'
import { createPositionChangeRequest } from '@/lib/server/hr/position-workflow'

export const dynamic = 'force-dynamic'

/** GET /api/hr/position-change-requests — list requests for the caller's org. */
export async function GET(request: NextRequest) {
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

    const status = request.nextUrl.searchParams.get('status')
    const admin = createAdminClient() as any
    let query = admin
      .from('hr_position_change_requests')
      .select('*')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(200)
    if (status) query = query.eq('status', status)

    const { data, error } = await query
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: data ?? [] })
  } catch (error: any) {
    console.error('Failed to list position change requests:', error)
    return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
  }
}

/**
 * POST /api/hr/position-change-requests — create a DRAFT change request for
 * assignment / lifecycle changes (structural mutations never touch live data).
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = (await createClient()) as any
    const ctxResult = await getHrAuthContext(supabase)
    if (!ctxResult.success || !ctxResult.data) {
      return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
    }
    const ctx = ctxResult.data
    if (!ctx.organizationId) return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
    if (!(await hrCan(ctx, 'hr.employee.manage'))) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })

    const body = await request.json()
    const requestType = String(body.request_type || '')
    const allowed = ['ASSIGN_EMPLOYEE', 'REASSIGN_EMPLOYEE', 'END_ASSIGNMENT', 'CHANGE_LIFECYCLE']
    if (!allowed.includes(requestType)) {
      return NextResponse.json({ success: false, error: 'Unsupported request type' }, { status: 400 })
    }
    if (!body.position_id) return NextResponse.json({ success: false, error: 'position_id is required' }, { status: 400 })

    const admin = createAdminClient() as any
    const result = await createPositionChangeRequest(admin, ctx.organizationId, ctx.userId, {
      requestType,
      positionId: body.position_id,
      changePayload: {
        employee_user_id: body.employee_user_id ?? null,
        lifecycle_status: body.lifecycle_status ?? null,
        ...(body.payload ?? {}),
      },
      effectiveDate: body.effective_date ?? null,
    })
    if (!result.success) return NextResponse.json({ success: false, error: result.error }, { status: result.status ?? 500 })
    return NextResponse.json({ success: true, data: result.data })
  } catch (error: any) {
    console.error('Failed to create position change request:', error)
    return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
  }
}
