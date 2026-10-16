import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getHrAuthContext, hrCan } from '@/lib/server/hrAccess'
import { pickApplicableUserFields, validSensitivePayload } from '@/lib/server/hr/profile-edit'

export const dynamic = 'force-dynamic'

/**
 * POST /api/hr/self-service/profile-change-requests/[id]/review — Category B HR review.
 *
 * Only an HR administrator (hr.employee.manage) of the request's own organization may approve or reject. Approving applies
 * the permitted sensitive fields to the official record (full_name, bank account) in the same organization; rejecting only
 * records the outcome. A reviewer can never review their own request. The decision and the applied values are recorded on
 * the request row (reviewed_by, reviewed_at, rejection_reason, applied_at).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supabase = (await createClient()) as any
  const ctxResult = await getHrAuthContext(supabase)
  if (!ctxResult.success || !ctxResult.data) return NextResponse.json({ success: false, error: ctxResult.error }, { status: 401 })
  const ctx = ctxResult.data
  if (!ctx.organizationId) return NextResponse.json({ success: false, error: 'Organization not found' }, { status: 400 })
  if (!(await hrCan(ctx, 'hr.employee.manage'))) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })

  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const decision = String(body?.decision ?? '').trim()

  const admin = createAdminClient() as any
  const { data: reqRow, error: loadError } = await admin
    .from('hr_profile_change_requests')
    .select('*')
    .eq('id', id)
    .eq('organization_id', ctx.organizationId)
    .maybeSingle()

  if (loadError || !reqRow) return NextResponse.json({ success: false, error: 'Request not found' }, { status: 404 })
  if (reqRow.employee_user_id === ctx.userId) {
    return NextResponse.json({ success: false, error: 'You cannot review your own request.' }, { status: 403 })
  }

  if (decision === 'reject') {
    const { error } = await admin
      .from('hr_profile_change_requests')
      .update({ status: 'rejected', reviewed_by: ctx.userId, reviewed_at: new Date().toISOString(), rejection_reason: String(body?.reason ?? '').slice(0, 500) })
      .eq('id', id)
    if (error) return NextResponse.json({ success: false, error: 'Reject failed' }, { status: 500 })
    return NextResponse.json({ success: true, status: 'rejected' })
  }

  if (decision === 'approve') {
    if (!validSensitivePayload(reqRow.change_payload)) {
      return NextResponse.json({ success: false, error: 'Request payload is not a valid sensitive change.' }, { status: 400 })
    }
    const applied = pickApplicableUserFields(reqRow.change_payload as Record<string, unknown>)
    if (Object.keys(applied).length > 0) {
      const { error } = await admin
        .from('users')
        .update(applied)
        .eq('id', reqRow.employee_user_id)
        .eq('organization_id', ctx.organizationId)
      if (error) return NextResponse.json({ success: false, error: 'Apply failed' }, { status: 500 })
    }
    const { error } = await admin
      .from('hr_profile_change_requests')
      .update({ status: 'approved', reviewed_by: ctx.userId, reviewed_at: new Date().toISOString(), applied_at: new Date().toISOString(), rejection_reason: null })
      .eq('id', id)
    if (error) return NextResponse.json({ success: false, error: 'Approve failed' }, { status: 500 })
    return NextResponse.json({ success: true, status: 'approved' })
  }

  return NextResponse.json({ success: false, error: 'decision must be "approve" or "reject"' }, { status: 400 })
}
