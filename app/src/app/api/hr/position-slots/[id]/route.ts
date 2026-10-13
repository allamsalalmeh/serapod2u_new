import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getHrAuthContext, hrCan } from '@/lib/server/hrAccess'
import { getPositionSlot } from '@/lib/server/hr/position-management'
import { createPositionChangeRequest } from '@/lib/server/hr/position-workflow'

export const dynamic = 'force-dynamic'

/** GET /api/hr/position-slots/[id] — position detail with history. */
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
    // Position detail and history are an HR view, read with the service role (same rule as /api/hr/employees).
    if (!(await hrCan(ctxResult.data, 'hr.employee.view'))) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })

    const { id } = await params
    const admin = createAdminClient() as any
    const result = await getPositionSlot(admin, organizationId, id)
    if (!result.success) return NextResponse.json({ success: false, error: result.error }, { status: 404 })
    return NextResponse.json({ success: true, data: result.data })
  } catch (error: any) {
    console.error('Failed to load position slot:', error)
    return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
  }
}

/**
 * PATCH /api/hr/position-slots/[id] — create a DRAFT change request for an
 * update (UPDATE_POSITION) or a reporting change (CHANGE_REPORTING). Live data
 * is never modified directly.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const supabase = (await createClient()) as any
    const ctxResult = await getHrAuthContext(supabase)
    if (!ctxResult.success || !ctxResult.data) {
      return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
    }
    const ctx = ctxResult.data
    if (!ctx.organizationId) return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
    if (!(await hrCan(ctx, 'hr.employee.manage'))) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })

    const { id } = await params
    const body = await request.json()
    const admin = createAdminClient() as any

    // Reporting change?
    if (body.parent_position_id !== undefined || body.relationship_type !== undefined) {
      const result = await createPositionChangeRequest(admin, ctx.organizationId, ctx.userId, {
        requestType: 'CHANGE_REPORTING',
        positionId: id,
        changePayload: {
          parent_position_id: body.parent_position_id ?? null,
          relationship_type: body.relationship_type ?? 'PRIMARY',
        },
        effectiveDate: body.effective_date ?? null,
      })
      if (!result.success) return NextResponse.json({ success: false, error: result.error }, { status: result.status ?? 500 })
      return NextResponse.json({ success: true, data: result.data })
    }

    const payload: Record<string, unknown> = {}
    for (const k of ['name', 'job_classification_id', 'department_id', 'business_unit', 'org_tier', 'lifecycle_status', 'is_active']) {
      if (body[k] !== undefined) payload[k] = body[k]
    }
    if (Object.keys(payload).length === 0) return NextResponse.json({ success: false, error: 'No updates provided' }, { status: 400 })

    const result = await createPositionChangeRequest(admin, ctx.organizationId, ctx.userId, {
      requestType: 'UPDATE_POSITION',
      positionId: id,
      changePayload: payload,
      effectiveDate: body.effective_date ?? null,
    })
    if (!result.success) return NextResponse.json({ success: false, error: result.error }, { status: result.status ?? 500 })
    return NextResponse.json({ success: true, data: result.data })
  } catch (error: any) {
    console.error('Failed to update position slot:', error)
    return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
  }
}
