import type { QrTokenKind } from '@/modules/event-management/types/event'

/**
 * Attribution rules (first successful source is fixed, including booth).
 *
 *   booth  -> staff A   stays booth    (attributed_staff_user_id stays NULL)
 *   staff A -> staff B  stays staff A
 *
 * The single authoritative field is `attributed_staff_user_id` (NULL = booth)
 * on event_registrations. It is set once on first success and never
 * overwritten. Staff-vs-booth kind is derived from the original QR token's
 * kind — never stored twice, so the two fields cannot disagree.
 */

/** Resolve the attributed staff id for a NEW registration from the source token. */
export function resolveAttributedStaff(tokenKind: QrTokenKind, staffUserId: string | null): string | null {
  return tokenKind === 'staff' ? staffUserId : null
}

/** Booth registrations never inflate a staff ranking. */
export function isBoothRegistration(attributedStaffUserId: string | null | undefined): boolean {
  return attributedStaffUserId == null
}

/**
 * Whether a NEW submission may overwrite existing attribution. Always false:
 * the first successful source is fixed, so duplicates never overwrite
 * attribution (enforced by the atomic RPC and the UNIQUE constraints).
 */
export function mayOverwriteAttribution(_existing: string | null, _next: string | null): boolean {
  return false
}
