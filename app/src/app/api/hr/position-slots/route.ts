import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getHrAuthContext, hrCan } from '@/lib/server/hrAccess'
import { listPositionSlots } from '@/lib/server/hr/position-management'
import { createPositionChangeRequest } from '@/lib/server/hr/position-workflow'
import { nextPositionCode, prefixFromName } from '@/lib/hr/positions/code'

export const dynamic = 'force-dynamic'

/** GET /api/hr/position-slots — list position slots (position-centric master). */
export async function GET(request: NextRequest) {
  try {
    const supabase = (await createClient()) as any
    const ctxResult = await getHrAuthContext(supabase)
    if (!ctxResult.success || !ctxResult.data) {
      return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
    }
    const { organizationId } = ctxResult.data
    if (!organizationId) return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
    // Position master (occupants included) is an HR view, read with the service role (same rule as /api/hr/employees).
    if (!(await hrCan(ctxResult.data, 'hr.employee.view'))) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })

    const params = request.nextUrl.searchParams
    const admin = createAdminClient() as any
    const result = await listPositionSlots(admin, organizationId, {
      search: params.get('search') ?? undefined,
      classificationId: params.get('classification_id') ?? undefined,
      departmentId: params.get('department_id') ?? undefined,
      lifecycle: params.get('lifecycle') ?? undefined,
      occupancy: (params.get('occupancy') as 'FILLED' | 'VACANT' | null) ?? undefined,
      page: Number(params.get('page') ?? 1),
      limit: Number(params.get('limit') ?? 25),
    })
    if (!result.success) return NextResponse.json({ success: false, error: result.error }, { status: 500 })
    return NextResponse.json({ success: true, data: result.data, total: result.total })
  } catch (error: any) {
    console.error('Failed to list position slots:', error)
    return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
  }
}

/**
 * POST /api/hr/position-slots — create a DRAFT change request (CREATE_POSITION).
 * Structural changes never modify live data directly; they flow through approval.
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
    const name = String(body.name || '').trim()
    const base = String(body.position_code || '').trim().toUpperCase()
    if (!name && !base) return NextResponse.json({ success: false, error: 'Position name or code is required' }, { status: 400 })

    const admin = createAdminClient() as any

    // Codes held by live slots or by open CREATE_POSITION requests are taken.
    const [{ data: existing }, { data: openCreates }] = await Promise.all([
      admin.from('hr_position_slots').select('position_code').eq('organization_id', ctx.organizationId),
      admin
        .from('hr_position_change_requests')
        .select('change_payload')
        .eq('organization_id', ctx.organizationId)
        .eq('request_type', 'CREATE_POSITION')
        .in('status', ['draft', 'pending', 'returned', 'approved', 'scheduled']),
    ])
    const takenCodes = [
      ...(existing ?? []).map((s: any) => String(s.position_code)),
      ...(openCreates ?? []).map((r: any) => r.change_payload?.position_code).filter(Boolean).map(String),
    ]

    // Auto-generate a unique position code when not supplied.
    let positionCode = base
    if (!positionCode) {
      positionCode = nextPositionCode(prefixFromName(name), takenCodes)
    } else if (takenCodes.some((c) => c.toUpperCase() === positionCode)) {
      return NextResponse.json({ success: false, error: `Position code ${positionCode} is already in use` }, { status: 409 })
    }

    if (body.parent_position_id) {
      const { data: parent } = await admin
        .from('hr_position_slots')
        .select('id')
        .eq('id', body.parent_position_id)
        .eq('organization_id', ctx.organizationId)
        .maybeSingle()
      if (!parent) return NextResponse.json({ success: false, error: 'Reports-to position not found' }, { status: 400 })
    }

    const result = await createPositionChangeRequest(admin, ctx.organizationId, ctx.userId, {
      requestType: 'CREATE_POSITION',
      changePayload: {
        position_code: positionCode,
        name: name || positionCode,
        job_classification_id: body.job_classification_id ?? null,
        department_id: body.department_id ?? null,
        business_unit: body.business_unit ?? null,
        org_tier: String(body.org_tier ?? '').trim() || 'Unassigned',
        lifecycle_status: body.lifecycle_status ?? 'active',
        parent_position_id: body.parent_position_id ?? null,
      },
      effectiveDate: body.effective_date ?? null,
    })

    if (!result.success) return NextResponse.json({ success: false, error: result.error }, { status: result.status ?? 500 })
    return NextResponse.json({ success: true, data: result.data, position_code: positionCode })
  } catch (error: any) {
    console.error('Failed to create position change request:', error)
    return NextResponse.json({ success: false, error: error.message || 'Internal error' }, { status: 500 })
  }
}
