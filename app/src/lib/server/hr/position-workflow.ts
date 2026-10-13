import 'server-only'
import type { HrAuthContext } from '@/lib/server/hrAccess'
import { hrCan } from '@/lib/server/hrAccess'
import { statusAfterApproval } from '@/lib/hr/positions/workflow'
import type { ChangeRequestStatus } from '@/lib/hr/positions/types'
import { resolveApprovers, writeAudit } from './position-management'
import { activateChangeRequest } from './position-activation'

/**
 * Approval workflow for position change requests. Mirrors the hr04 state
 * machine: draft -> pending -> approved -> scheduled/effective, plus
 * rejected / returned / activation_failed / cancelled.
 */

export interface CreateChangeRequestInput {
  requestType: string
  positionId?: string | null
  changePayload: Record<string, unknown>
  effectiveDate?: string | null
}

/** Create a DRAFT change request (never modifies live data). */
export async function createPositionChangeRequest(
  admin: any,
  organizationId: string,
  actorUserId: string,
  input: CreateChangeRequestInput,
) {
  let before: unknown = null
  if (input.positionId) {
    const { data: slot } = await admin
      .from('hr_position_slots')
      .select('*')
      .eq('id', input.positionId)
      .eq('organization_id', organizationId)
      .maybeSingle()
    before = slot ?? null
  }

  const { data, error } = await admin
    .from('hr_position_change_requests')
    .insert({
      organization_id: organizationId,
      request_type: input.requestType,
      position_id: input.positionId ?? null,
      change_payload: input.changePayload,
      before_snapshot: before,
      effective_date: input.effectiveDate ?? null,
      status: 'draft',
      submitted_by: actorUserId,
    })
    .select('*')
    .single()

  if (error) return { success: false, error: error.message }
  await writeAudit(admin, organizationId, 'position_change_request', data.id, 'draft_created', actorUserId, null, data)
  return { success: true, data }
}

/** Load a change request scoped to the caller's organization. */
export async function loadChangeRequest(admin: any, organizationId: string, id: string) {
  const { data, error } = await admin
    .from('hr_position_change_requests')
    .select('*, approval_steps:hr_position_approval_steps(*)')
    .eq('id', id)
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (error || !data) return { success: false, error: 'Request not found' }
  return { success: true, data }
}


/** Submit a draft/returned request: snapshot approvers, -> pending. */
export async function submitChangeRequest(admin: any, ctx: HrAuthContext, id: string) {
  const { data: req, error: loadError } = await admin
    .from('hr_position_change_requests')
    .select('*')
    .eq('id', id)
    .eq('organization_id', ctx.organizationId)
    .maybeSingle()

  if (loadError || !req) return { success: false, error: 'Request not found', status: 404 }
  if (!(req.status === 'draft' || req.status === 'returned')) {
    return { success: false, error: 'Only draft or returned requests can be submitted', status: 409 }
  }
  if (req.submitted_by !== ctx.userId) {
    return { success: false, error: 'Only the submitter can submit this request', status: 403 }
  }
  if (!(await hrCan(ctx, 'hr.employee.manage'))) {
    return { success: false, error: 'Unauthorized', status: 403 }
  }

  const approvers = await resolveApprovers(admin, ctx.organizationId!)
  await admin.from('hr_position_approval_steps').delete().eq('change_request_id', id)

  if (approvers.length > 0) {
    const steps = approvers.map((a, i) => ({
      change_request_id: id,
      step_no: i + 1,
      approver_type: 'USER',
      approver_ref: a.userId,
      status: 'pending',
    }))
    await admin.from('hr_position_approval_steps').insert(steps)
  } else {
    await admin.from('hr_position_approval_steps').insert({
      change_request_id: id,
      step_no: 1,
      approver_type: 'POLICY',
      approver_ref: 'hr.employee.manage',
      status: 'pending',
    })
  }

  const { data, error } = await admin
    .from('hr_position_change_requests')
    .update({ status: 'pending', submitted_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single()

  if (error) return { success: false, error: error.message }
  await writeAudit(admin, ctx.organizationId!, 'position_change_request', id, 'submitted', ctx.userId, null, data)
  return { success: true, data }
}

/** Approve. When all steps are approved the change is activated. */
export async function approveChangeRequest(admin: any, ctx: HrAuthContext, id: string) {
  const { data: req, error: loadError } = await admin
    .from('hr_position_change_requests')
    .select('*')
    .eq('id', id)
    .eq('organization_id', ctx.organizationId)
    .maybeSingle()

  if (loadError || !req) return { success: false, error: 'Request not found', status: 404 }
  if (req.status !== 'pending') return { success: false, error: 'Request is not pending approval', status: 409 }
  if (req.submitted_by === ctx.userId) return { success: false, error: 'You cannot approve your own request', status: 403 }
  if (!(await hrCan(ctx, 'hr.employee.manage'))) return { success: false, error: 'Unauthorized', status: 403 }

  const { data: steps } = await admin
    .from('hr_position_approval_steps')
    .select('*')
    .eq('change_request_id', id)
    .eq('status', 'pending')
    .order('step_no')

  const list = (steps ?? []) as any[]
  const isConcreteApprover = list.some((s) => s.approver_type === 'USER' && s.approver_ref === ctx.userId)
  const hasPolicyStep = list.some((s) => s.approver_type === 'POLICY')
  if (!isConcreteApprover && !hasPolicyStep) {
    return { success: false, error: 'You are not a resolved approver for this request', status: 403 }
  }

  const now = new Date().toISOString()
  for (const s of list) {
    const canDecide = s.approver_type === 'POLICY' || s.approver_ref === ctx.userId
    if (canDecide) {
      await admin
        .from('hr_position_approval_steps')
        .update({ status: 'approved', decision_by: ctx.userId, decision_at: now })
        .eq('id', s.id)
    }
  }

  const { data: remaining } = await admin
    .from('hr_position_approval_steps')
    .select('status')
    .eq('change_request_id', id)
  const allApproved = (remaining ?? []).every((s: any) => s.status === 'approved' || s.status === 'skipped')

  if (!allApproved) {
    return { success: true, data: { id, status: 'pending', pending_approvers: true } }
  }

  const nextStatus: ChangeRequestStatus = statusAfterApproval(req.effective_date)
  const activation = await activateChangeRequest(admin, ctx, req)
  if (!activation.success && nextStatus !== 'scheduled') {
    await admin
      .from('hr_position_change_requests')
      .update({ status: 'activation_failed', activation_error: activation.error ?? 'Activation failed' })
      .eq('id', id)
    await writeAudit(admin, ctx.organizationId!, 'position_change_request', id, 'activation_failed', ctx.userId, req, activation)
    return { success: false, error: activation.error ?? 'Activation failed', status: 500 }
  }

  const { data } = await admin
    .from('hr_position_change_requests')
    .update({ status: nextStatus, approved_by: ctx.userId, approved_at: now, activated_at: nextStatus === 'effective' ? now : null })
    .eq('id', id)
    .select('*')
    .single()

  await writeAudit(admin, ctx.organizationId!, 'position_change_request', id, 'approved', ctx.userId, req, data)
  return { success: true, data }
}

/** Reject (no live data changed). */
export async function rejectChangeRequest(admin: any, ctx: HrAuthContext, id: string, reason: string) {
  const { data: req, error: loadError } = await admin
    .from('hr_position_change_requests')
    .select('*')
    .eq('id', id)
    .eq('organization_id', ctx.organizationId)
    .maybeSingle()
  if (loadError || !req) return { success: false, error: 'Request not found', status: 404 }
  if (req.status !== 'pending') return { success: false, error: 'Request is not pending approval', status: 409 }
  if (req.submitted_by === ctx.userId) return { success: false, error: 'You cannot reject your own request', status: 403 }
  if (!(await hrCan(ctx, 'hr.employee.manage'))) return { success: false, error: 'Unauthorized', status: 403 }

  const { data, error } = await admin
    .from('hr_position_change_requests')
    .update({ status: 'rejected', cancellation_reason: reason.slice(0, 500) })
    .eq('id', id)
    .select('*')
    .single()
  if (error) return { success: false, error: error.message }
  await writeAudit(admin, ctx.organizationId!, 'position_change_request', id, 'rejected', ctx.userId, req, data)
  return { success: true, data }
}

/** Return for correction (no live data changed). */
export async function returnChangeRequest(admin: any, ctx: HrAuthContext, id: string, comment: string) {
  const { data: req, error: loadError } = await admin
    .from('hr_position_change_requests')
    .select('*')
    .eq('id', id)
    .eq('organization_id', ctx.organizationId)
    .maybeSingle()
  if (loadError || !req) return { success: false, error: 'Request not found', status: 404 }
  if (req.status !== 'pending') return { success: false, error: 'Request is not pending approval', status: 409 }
  if (req.submitted_by === ctx.userId) return { success: false, error: 'You cannot return your own request', status: 403 }
  if (!(await hrCan(ctx, 'hr.employee.manage'))) return { success: false, error: 'Unauthorized', status: 403 }

  const { data, error } = await admin
    .from('hr_position_change_requests')
    .update({ status: 'returned', cancellation_reason: comment.slice(0, 500) })
    .eq('id', id)
    .select('*')
    .single()
  if (error) return { success: false, error: error.message }
  await writeAudit(admin, ctx.organizationId!, 'position_change_request', id, 'returned', ctx.userId, req, data)
  return { success: true, data }
}

