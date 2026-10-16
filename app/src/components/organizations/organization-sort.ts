export type OrganizationSortField = 'org_name' | 'org_type_code' | 'contact_name' | 'state' | 'is_active'
export type OrganizationSortDirection = 'asc' | 'desc'

export interface SortableOrganization {
  org_name: string
  org_type_code: string
  contact_name: string | null
  is_active: boolean
  org_types?: { type_name: string } | null
  // Organizations carry their state as the joined states row, not a state column.
  states?: { state_name: string } | null
}

const rawValue = (org: SortableOrganization, field: OrganizationSortField) =>
  field === 'state' ? org.states?.state_name : org[field]

/** Organizations table order: missing values last, names case-insensitive, types by type name. */
export function compareOrganizations(
  a: SortableOrganization,
  b: SortableOrganization,
  field: OrganizationSortField,
  direction: OrganizationSortDirection,
): number {
  const aRaw = rawValue(a, field)
  const bRaw = rawValue(b, field)

  if (aRaw === null || aRaw === undefined) return 1
  if (bRaw === null || bRaw === undefined) return -1

  let aVal: string | number
  let bVal: string | number
  if (field === 'is_active') {
    aVal = aRaw ? 1 : 0
    bVal = bRaw ? 1 : 0
  } else if (field === 'org_type_code') {
    aVal = (a.org_types?.type_name || a.org_type_code).toLowerCase()
    bVal = (b.org_types?.type_name || b.org_type_code).toLowerCase()
  } else {
    aVal = String(aRaw || '').toLowerCase()
    bVal = String(bRaw || '').toLowerCase()
  }

  if (aVal < bVal) return direction === 'asc' ? -1 : 1
  if (aVal > bVal) return direction === 'asc' ? 1 : -1
  return 0
}
