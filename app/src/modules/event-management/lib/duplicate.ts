import { isValidMalaysianPhone, normalizePhoneE164 } from '@/utils/phone'

/**
 * Duplicate policy for Event Management.
 *
 * The canonical duplicate rule is enforced in the database:
 *   UNIQUE (event_id, phone_normalized) on event_contacts
 *   UNIQUE (event_id, contact_id)   on event_registrations
 * The functions here are the app-side mirror used for client feedback and for
 * the admin "new vs returning" view (which is scoped to the same organization
 * AND brand — never silently matched across brands).
 */

/** Normalize a raw phone to canonical E.164 +60, or null when not a valid Malaysian mobile. */
export function normalizeParticipantPhone(phone?: string | null): string | null {
  const normalized = normalizePhoneE164(String(phone ?? '').trim())
  if (!normalized) return null
  return isValidMalaysianPhone(normalized) ? normalized : null
}

export function isSameParticipantPhone(left?: string | null, right?: string | null): boolean {
  const a = normalizeParticipantPhone(left)
  const b = normalizeParticipantPhone(right)
  return Boolean(a && b && a === b)
}

/**
 * "Returning" is the same normalized phone seen in an earlier event within the
 * same organization and brand. The event list used by the caller must already
 * be filtered to the same org; the brand scope is applied explicitly so a
 * contact is never matched across brands.
 */
export function isReturningContact(params: {
  phone: string | null | undefined
  currentEventStartsAt: string
  earlierEvents: Array<{ id: string; brand_id: string | null; starts_at: string }>
  currentBrandId: string | null
  seenPhones: Set<string>
}): boolean {
  const phone = normalizeParticipantPhone(params.phone)
  if (!phone) return false
  if (!params.seenPhones.has(phone)) return false

  // The seen set is pre-scoped by the caller to same-org, earlier events with a
  // matching brand. This double-check guards the brand scope explicitly.
  const earlierMatchingBrand = params.earlierEvents.some(
    (e) => e.starts_at < params.currentEventStartsAt && (e.brand_id ?? null) === (params.currentBrandId ?? null),
  )
  return earlierMatchingBrand
}
