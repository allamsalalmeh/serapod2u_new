import { getOrgTypeName } from "@/lib/utils/orgHierarchy";
import type { Organization } from "@/types/user";

/**
 * Dependent "Organization Type" → "Organization" filters for User Management.
 *
 * Source of truth is the organization catalogue the viewer is allowed to read
 * (the RLS-scoped `organizations` query), never the users on the current page.
 * A user belongs to an organization through `users.organization_id`; the type
 * comes from that organization's `org_type_code`.
 *
 * "End User" follows the data model: end users / independent consumers carry
 * no organization (`organization_id` is null). Should an organization ever be
 * typed END_USER, its members are end users too.
 */

export const END_USER_TYPE = "END_USER";

// MANU is a legacy alias of MFG (both render as "Manufacturer"); treat them as one type.
const TYPE_ALIASES: Record<string, string> = { MANU: "MFG" };
const TYPE_ORDER = ["HQ", "MFG", "DIST", "WH", "SHOP", END_USER_TYPE];

export const canonicalOrgType = (code?: string | null): string => {
  const upper = (code || "").trim().toUpperCase();
  return TYPE_ALIASES[upper] || upper;
};

export type OrgTypeOption = { value: string; label: string };

/** Types present in the authorized catalogue (hierarchy order), plus End User. */
export function buildOrgTypeOptions(organizations: Organization[]): OrgTypeOption[] {
  const types = new Set<string>();
  for (const org of organizations) {
    const type = canonicalOrgType(org.org_type_code);
    if (type) types.add(type);
  }
  types.add(END_USER_TYPE);
  const rank = (t: string) => {
    const i = TYPE_ORDER.indexOf(t);
    return i === -1 ? TYPE_ORDER.length - 1 : i; // unknown types before End User
  };
  return Array.from(types)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((value) => ({ value, label: getOrgTypeName(value) }));
}

/** Organizations selectable for a type ("" = all authorized organizations). */
export function organizationsForType(organizations: Organization[], typeFilter: string): Organization[] {
  if (!typeFilter) return organizations;
  const type = canonicalOrgType(typeFilter);
  return organizations.filter((org) => canonicalOrgType(org.org_type_code) === type);
}

export type OrgOption = { value: string; label: string };

/**
 * Options keyed by organization id. Organizations that share a name stay
 * separate entries and are disambiguated by branch / code.
 */
export function buildOrgOptions(organizations: Organization[]): OrgOption[] {
  const nameCounts = new Map<string, number>();
  for (const org of organizations) {
    const key = (org.org_name || "").trim().toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  }
  return organizations.map((org) => {
    const name = org.org_name || org.org_code || org.id;
    const duplicated = (nameCounts.get((org.org_name || "").trim().toLowerCase()) || 0) > 1;
    if (!duplicated) return { value: org.id, label: name };
    const detail = [org.branch, org.org_code].filter(Boolean).join(" · ");
    return { value: org.id, label: detail ? `${name} (${detail})` : name };
  });
}

/** Keeps the selected organization only while it is still offered for the type. */
export function reconcileOrgSelection(organizations: Organization[], typeFilter: string, orgFilter: string): string {
  if (!orgFilter) return "";
  return organizationsForType(organizations, typeFilter).some((org) => org.id === orgFilter) ? orgFilter : "";
}

/** Applies both filters to one user, using the same catalogue as the dropdowns. */
export function userMatchesOrgFilters(
  user: { organization_id?: string | null },
  orgById: Map<string, Organization>,
  typeFilter: string,
  orgFilter: string,
): boolean {
  if (orgFilter && user.organization_id !== orgFilter) return false;
  if (!typeFilter) return true;
  const type = canonicalOrgType(typeFilter);
  if (!user.organization_id) return type === END_USER_TYPE;
  const org = orgById.get(user.organization_id);
  return Boolean(org) && canonicalOrgType(org!.org_type_code) === type;
}
