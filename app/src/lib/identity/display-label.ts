/**
 * Ordinary presentation of "what kind of user is this" for the sidebar and profile screens.
 *
 * The legacy classification (role code and level) stays exactly as stored and keeps driving compatibility behavior, but
 * it is not the explanation of the access model: a person who holds only the baseline legacy classification (GUEST or
 * USER) is a staff member of their organization, with their actual access coming from assigned Group Policies. Roles
 * that carry a real meaning (administrators, managers) keep their name. This is display only: it never changes access.
 */
export interface UserCategoryInput {
  orgTypeCode?: string | null
  roleCode?: string | null
  roleName?: string | null
}

const BASELINE_CLASSIFICATIONS = new Set(['GUEST', 'USER'])

const STAFF_LABELS: Record<string, string> = {
  HQ: 'HQ staff',
  MFG: 'Manufacturer staff',
  MANU: 'Manufacturer staff',
  DIST: 'Distributor staff',
  WH: 'Warehouse staff',
  SHOP: 'Shop staff',
}

export function userCategoryLabel({ orgTypeCode, roleCode, roleName }: UserCategoryInput): string {
  const code = String(roleCode ?? '').trim().toUpperCase()
  const name = String(roleName ?? '').trim()
  if (!code && !name) return 'Staff'
  if (!BASELINE_CLASSIFICATIONS.has(code)) return name || String(roleCode ?? 'Staff')
  return STAFF_LABELS[String(orgTypeCode ?? '').trim().toUpperCase()] ?? 'Staff'
}

/** "Platform Admin" style names are shown as stored; this joins the category with the organization for a subtitle. */
export function userSubtitle(input: UserCategoryInput & { organizationName?: string | null }): string {
  return `${userCategoryLabel(input)} • ${input.organizationName || 'No Org'}`
}
