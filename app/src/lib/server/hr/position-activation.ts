import 'server-only'
import type { HrAuthContext } from '@/lib/server/hrAccess'
import { validateAssignmentOverlap, validatePrimaryRelationshipOverlap, wouldCreateCycle } from '@/lib/hr/positions/validation'
import type { ChangeRequestType, LifecycleStatus } from '@/lib/hr/positions/types'
import { writeAudit } from './position-management'

/**
 * Apply an approved change request to live tables (additive, service-role).
 * This is the ONLY place live position data is mutated.
 */

const now = () => new Date().toISOString().slice(0, 10)

export async function activateChangeRequest(
  admin: any,
  ctx: HrAuthContext,
  req: any,
): Promise<{ success: boolean; error?: string; data?: any }> {
  const orgId = req.organization_id
  const payload = (req.change_payload ?? {}) as Record<string, any>

  try {
    switch (req.request_type as ChangeRequestType) {
      case 'CREATE_POSITION': {
        const { data, error } = await admin
          .from('hr_position_slots')
          .insert({
            organization_id: orgId,
            position_code: String(payload.position_code),
            name: String(payload.name),
            job_classification_id: payload.job_classification_id ?? null,
            department_id: payload.department_id ?? null,
            business_unit: payload.business_unit ?? null,
            org_tier: payload.org_tier ?? 'Unassigned',
            lifecycle_status: (payload.lifecycle_status ?? 'active') as LifecycleStatus,
            is_active: true,
            created_by: ctx.userId,
          })
          .select('*')
          .single()
        if (error) return { success: false, error: error.message }
        await writeAudit(admin, orgId, 'position_slot', data.id, 'created', ctx.userId, null, data)
        if (payload.parent_position_id) {
          const rel = await createRelationshipInternal(admin, orgId, data.id, payload.parent_position_id, 'PRIMARY', req.effective_date, ctx.userId)
          if (!rel.success) return rel
        }
        return { success: true, data }
      }

      case 'UPDATE_POSITION': {
        const patch: Record<string, any> = {}
        for (const k of ['name', 'job_classification_id', 'department_id', 'business_unit', 'org_tier', 'lifecycle_status', 'is_active']) {
          if (payload[k] !== undefined) patch[k] = payload[k]
        }
        const { data, error } = await admin
          .from('hr_position_slots')
          .update(patch)
          .eq('id', req.position_id)
          .eq('organization_id', orgId)
          .select('*')
          .single()
        if (error) return { success: false, error: error.message }
        await writeAudit(admin, orgId, 'position_slot', data.id, 'updated', ctx.userId, req.before_snapshot, data)
        return { success: true, data }
      }

      case 'CHANGE_REPORTING': {
        const childId = req.position_id
        const parentId = (payload.parent_position_id ?? null) as string | null
        const relType = (payload.relationship_type ?? 'PRIMARY') as string

        if (relType === 'PRIMARY') {
          const { data: rels } = await admin
            .from('hr_position_relationships')
            .select('position_id, parent_position_id')
            .eq('organization_id', orgId)
            .eq('relationship_type', 'PRIMARY')
            .eq('is_active', true)
          const parentById = new Map<string, string | null>()
          for (const r of (rels ?? []) as any[]) parentById.set(r.position_id, r.parent_position_id)
          if (wouldCreateCycle(childId, parentId, parentById)) {
            return { success: false, error: 'Cannot set parent: would create a reporting cycle' }
          }
          const { data: existing } = await admin
            .from('hr_position_relationships')
            .select('id, effective_from, effective_to')
            .eq('position_id', childId)
            .eq('relationship_type', 'PRIMARY')
            .eq('is_active', true)
          const overlap = validatePrimaryRelationshipOverlap(existing ?? [], {
            id: '',
            effective_from: req.effective_date ?? now(),
            effective_to: null,
          })
          if (!overlap.ok) return { success: false, error: overlap.message }
        }

        return await createRelationshipInternal(admin, orgId, childId, parentId, relType, req.effective_date, ctx.userId)
      }

      case 'CHANGE_LIFECYCLE': {
        const { data, error } = await admin
          .from('hr_position_slots')
          .update({ lifecycle_status: payload.lifecycle_status, is_active: payload.lifecycle_status === 'active' })
          .eq('id', req.position_id)
          .eq('organization_id', orgId)
          .select('*')
          .single()
        if (error) return { success: false, error: error.message }
        await writeAudit(admin, orgId, 'position_slot', data.id, 'lifecycle_changed', ctx.userId, req.before_snapshot, data)
        return { success: true, data }
      }

      case 'ASSIGN_EMPLOYEE':
      case 'REASSIGN_EMPLOYEE':
      case 'END_ASSIGNMENT':
        return await activateAssignment(admin, ctx, req)

      default:
        return { success: false, error: 'Unsupported request type' }
    }
  } catch (e: any) {
    return { success: false, error: e.message ?? 'Activation failed' }
  }
}


/** Assignment mutations (ASSIGN/REASSIGN/END). */
export async function activateAssignment(
  admin: any,
  ctx: HrAuthContext,
  req: any,
): Promise<{ success: boolean; error?: string; data?: any }> {
  const orgId = req.organization_id
  const payload = (req.change_payload ?? {}) as Record<string, any>
  const employeeId = payload.employee_user_id
  const positionId = req.position_id

  if (!employeeId || !positionId) return { success: false, error: 'employee and position are required' }

  if (req.request_type === 'END_ASSIGNMENT') {
    const { error } = await admin
      .from('hr_position_assignments')
      .update({ effective_to: req.effective_date ?? now(), status: 'ended' })
      .eq('organization_id', orgId)
      .eq('position_id', positionId)
      .eq('employee_user_id', employeeId)
      .eq('status', 'active')
    if (error) return { success: false, error: error.message }
    return { success: true }
  }

  const { data: existing } = await admin
    .from('hr_position_assignments')
    .select('id, position_id, employee_user_id, assignment_type, effective_from, effective_to')
    .eq('status', 'active')
    .eq('organization_id', orgId)
  const overlap = validateAssignmentOverlap(existing ?? [], {
    id: '',
    position_id: positionId,
    employee_user_id: employeeId,
    assignment_type: 'PRIMARY',
    effective_from: req.effective_date ?? now(),
    effective_to: null,
  })
  if (!overlap.ok) return { success: false, error: overlap.message }

  const { data, error } = await admin
    .from('hr_position_assignments')
    .insert({
      organization_id: orgId,
      position_id: positionId,
      employee_user_id: employeeId,
      assignment_type: 'PRIMARY',
      effective_from: req.effective_date ?? now(),
      effective_to: null,
      status: 'active',
      created_by: ctx.userId,
    })
    .select('*')
    .single()
  if (error) return { success: false, error: error.message }
  await writeAudit(admin, orgId, 'position_assignment', data.id, 'assigned', ctx.userId, null, data)
  return { success: true, data }
}

async function createRelationshipInternal(
  admin: any,
  orgId: string,
  positionId: string,
  parentPositionId: string | null,
  relationshipType: string,
  effectiveDate: string | null,
  actorUserId: string,
) {
  const { data, error } = await admin
    .from('hr_position_relationships')
    .insert({
      organization_id: orgId,
      position_id: positionId,
      parent_position_id: parentPositionId,
      relationship_type: relationshipType,
      effective_from: effectiveDate ?? now(),
      effective_to: null,
      is_active: true,
      created_by: actorUserId,
    })
    .select('*')
    .single()
  if (error) return { success: false, error: error.message }
  await writeAudit(admin, orgId, 'position_relationship', data.id, 'created', actorUserId, null, data)
  return { success: true, data }
}
