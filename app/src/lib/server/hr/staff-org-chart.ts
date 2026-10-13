import 'server-only'

/**
 * Staff organization chart projection.
 *
 * The ONLY fields that ever leave the server for the staff chart are a display name, a job title, a department name and
 * the reporting line. The query selects exactly those columns (plus the internal ids needed to build the tree on the
 * server); ids are replaced with per-response opaque keys, so no user id, email, phone, number, salary or HR field
 * is read into the response, and the browser never receives a full employee object to "hide" fields from.
 */
export interface StaffChartNode {
  /** Opaque, per-response key (not a user id). */
  key: string
  name: string
  jobTitle: string | null
  department: string | null
  /** Key of the person this one reports to, when that person is in the chart. */
  managerKey: string | null
  /** The viewer's own entry, so the screen can highlight it. */
  isSelf: boolean
}

export const STAFF_CHART_LIMIT = 2000

type Row = {
  id: string
  full_name: string | null
  manager_user_id: string | null
  positions?: { name?: string | null } | { name?: string | null }[] | null
  departments?: { dept_name?: string | null } | { dept_name?: string | null }[] | null
}

const one = <T,>(value: T | T[] | null | undefined): T | null => (Array.isArray(value) ? value[0] ?? null : value ?? null)

/** Pure projection from the selected rows (kept separate so it can be tested without a database). */
export function projectStaffChart(rows: readonly Row[], viewerId: string): StaffChartNode[] {
  const keyById = new Map<string, string>()
  rows.forEach((row, index) => keyById.set(row.id, `n${index + 1}`))
  return rows.map(row => ({
    key: keyById.get(row.id)!,
    name: (row.full_name ?? '').trim() || 'Unnamed',
    jobTitle: one(row.positions)?.name ?? null,
    department: one(row.departments)?.dept_name ?? null,
    managerKey: row.manager_user_id && row.manager_user_id !== row.id ? keyById.get(row.manager_user_id) ?? null : null,
    isSelf: row.id === viewerId,
  }))
}

/** Reads the minimum columns for the caller's own organization only (the organization comes from the verified account). */
export async function loadStaffChart(admin: any, organizationId: string, viewerId: string): Promise<StaffChartNode[]> {
  const { data, error } = await admin
    .from('users')
    .select(`
      id, full_name, manager_user_id,
      positions:position_id (name),
      departments:department_id (dept_name),
      hr_employees!hr_employees_user_id_fkey!inner (organization_id, onboarding_status)
    `)
    .eq('organization_id', organizationId)
    .eq('hr_employees.organization_id', organizationId)
    .eq('hr_employees.onboarding_status', 'completed')
    .eq('is_active', true)
    .order('full_name', { ascending: true })
    .limit(STAFF_CHART_LIMIT)
  if (error) throw new Error('staff_chart_unavailable')
  return projectStaffChart((data ?? []) as Row[], viewerId)
}
