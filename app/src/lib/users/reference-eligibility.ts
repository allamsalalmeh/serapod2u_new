/**
 * The Reference setting (users.can_be_reference, "can be selected as a Reference in RoadTour campaigns") is available
 * to users of an HQ organization only.
 *
 * Client-safe rule shared by User Management (Add/Edit) and the server actions. The UI only hides the option; the
 * decision is taken again on the server from the organization's real type, never from a submitted type value.
 */
export const REFERENCE_HQ_ONLY_MESSAGE = 'Reference is available to HQ users only.'

export const referenceAllowedForOrgType = (orgTypeCode?: string | null) =>
  String(orgTypeCode ?? '').trim().toUpperCase() === 'HQ'

/** Returns an error message when a request turns Reference on for a non-HQ organization, otherwise null. */
export function referenceEligibilityError(canBeReference: unknown, orgTypeCode?: string | null): string | null {
  if (canBeReference === true && !referenceAllowedForOrgType(orgTypeCode)) return REFERENCE_HQ_ONLY_MESSAGE
  return null
}
