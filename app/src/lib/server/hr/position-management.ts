import 'server-only'

/**
 * Server-side domain service for HR Position Management V1.1.
 *
 * All writes go through the service role (`admin`) after the route has already
 * performed an S&A decision via `hrCan`. This module never trusts request input
 * for organization scoping — `organizationId` always comes from the verified
 * session context.
 */

/** Record an immutable audit event. */
export async function writeAudit(
  admin: any,
  organizationId: string,
  entityType: string,
  entityId: string,
  action: string,
  actorUserId: string | null,
  before: unknown = null,
  after: unknown = null,
): Promise<void> {
  await admin.from('hr_position_audit_events').insert({
    organization_id: organizationId,
    entity_type: entityType,
    entity_id: entityId,
    action,
    actor_user_id: actorUserId,
    before: before ? JSON.parse(JSON.stringify(before)) : null,
    after: after ? JSON.parse(JSON.stringify(after)) : null,
  })
}

const ADMIN_CODES = new Set(['SUPER_ADMIN', 'SUPERADMIN', 'SUPER', 'SA', 'HQ_ADMIN', 'ADMIN_HQ', 'HQ', 'ADMIN', 'HR_MANAGER'])

/** Resolve concrete HR approvers (role-based snapshot) for a submission. */
export async function resolveApprovers(admin: any, organizationId: string): Promise<{ userId: string }[]> {
  const { data } = await admin
    .from('users')
    .select('id, role_code, roles(role_level)')
    .eq('organization_id', organizationId)
    .eq('is_active', true)

  return ((data ?? []) as any[])
    .filter((u) => {
      const level = (u.roles as any)?.role_level ?? null
      return (level !== null && level <= 20) || ADMIN_CODES.has(String(u.role_code ?? '').toUpperCase())
    })
    .map((u) => ({ userId: u.id }))
}

export interface PositionSlotFilters {
  search?: string
  classificationId?: string
  departmentId?: string
  lifecycle?: string
  occupancy?: 'FILLED' | 'VACANT'
  page?: number
  limit?: number
}

/** List position slots with occupancy + classification + incumbent (live data only). */
export async function listPositionSlots(admin: any, organizationId: string, filters: PositionSlotFilters = {}) {
  const limit = filters.limit ?? 25
  const page = filters.page ?? 1

  let query = admin
    .from('hr_position_slots')
    .select(`*,
      job_classification:job_classification_id (id, code, name, family),
      department:department_id (id, dept_name, dept_code)
    `)
    .eq('organization_id', organizationId)

  if (filters.classificationId) query = query.eq('job_classification_id', filters.classificationId)
  if (filters.departmentId) query = query.eq('department_id', filters.departmentId)
  if (filters.lifecycle) query = query.eq('lifecycle_status', filters.lifecycle)
  if (filters.search) query = query.or(`position_code.ilike.%${filters.search}%,name.ilike.%${filters.search}%`)

  const { data, error } = await query.order('position_code', { ascending: true })
  if (error) return { success: false, error: error.message }

  const slots = (data ?? []) as any[]
  const ids = slots.map((s) => s.id)

  let assignments: any[] = []
  if (ids.length) {
    const { data: asgn } = await admin
      .from('hr_position_assignments')
      .select('position_id, employee_user_id')
      .in('position_id', ids)
      .eq('status', 'active')
      .eq('organization_id', organizationId)
    assignments = asgn ?? []
  }

  const incumbentIds = [...new Set(assignments.map((a) => a.employee_user_id))]
  const incumbentMap = new Map<string, string>()
  if (incumbentIds.length) {
    const { data: users } = await admin
      .from('users')
      .select('id, full_name')
      .in('id', incumbentIds)
    for (const u of users ?? []) incumbentMap.set(u.id, u.full_name)
  }

  const rows = slots
    .map((s) => {
      const incumbent = assignments.find((a) => a.position_id === s.id)
      const occupancy: 'FILLED' | 'VACANT' = incumbent ? 'FILLED' : 'VACANT'
      if (filters.occupancy && filters.occupancy !== occupancy) return null
      return {
        ...s,
        job_classification: s.job_classification ?? null,
        department: s.department ?? null,
        incumbent_user_id: incumbent?.employee_user_id ?? null,
        incumbent_name: incumbent ? incumbentMap.get(incumbent.employee_user_id) ?? null : null,
        occupancy,
      }
    })
    .filter(Boolean)

  const total = rows.length
  const start = (page - 1) * limit
  return { success: true, data: rows.slice(start, start + limit), total }
}


/** Load a single position slot with classification + relationships + history. */
export async function getPositionSlot(admin: any, organizationId: string, id: string) {
  const { data, error } = await admin
    .from('hr_position_slots')
    .select(`*,
      job_classification:job_classification_id (id, code, name, family, job_grade),
      department:department_id (id, dept_name, dept_code)
    `)
    .eq('id', id)
    .eq('organization_id', organizationId)
    .maybeSingle()
  if (error || !data) return { success: false, error: 'Position not found' }

  const { data: rels } = await admin
    .from('hr_position_relationships')
    .select('*')
    .eq('position_id', id)
    .eq('organization_id', organizationId)
    .order('relationship_type')
    .order('effective_from', { ascending: false })

  const { data: asgn } = await admin
    .from('hr_position_assignments')
    .select('*')
    .eq('position_id', id)
    .eq('organization_id', organizationId)
    .order('effective_from', { ascending: false })

  const { data: versions } = await admin
    .from('hr_position_versions')
    .select('*')
    .eq('position_id', id)
    .eq('organization_id', organizationId)
    .order('effective_from', { ascending: false })

  const { data: audit } = await admin
    .from('hr_position_audit_events')
    .select('*')
    .eq('entity_id', id)
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(50)

  return {
    success: true,
    data: {
      ...data,
      relationships: rels ?? [],
      assignments: asgn ?? [],
      versions: versions ?? [],
      audit: audit ?? [],
    },
  }
}

/** List job classifications (reference data). */
export async function listJobClassifications(admin: any, organizationId: string) {
  const { data, error } = await admin
    .from('hr_job_classifications')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('is_active', true)
    .order('name')
  if (error) return { success: false, error: error.message }
  return { success: true, data: data ?? [] }
}
