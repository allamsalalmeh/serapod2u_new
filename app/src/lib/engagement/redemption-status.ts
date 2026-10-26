/**
 * Redemption fulfilment steps, as offered on Point Catalog → Redemption History:
 * pending → processing / cancelled, processing → fulfilled / cancelled.
 * The fields written are the ones the screen has always written.
 */
export type RedemptionStatus = 'pending' | 'processing' | 'fulfilled' | 'cancelled'

const NEXT_STEPS: Record<string, RedemptionStatus[]> = {
  pending: ['processing', 'cancelled'],
  processing: ['fulfilled', 'cancelled'],
}

export function planRedemptionStatusChange(input: {
  current: string | null
  next: string
  actorId: string
  now: string
  notes?: string | null
}): { update: Record<string, unknown> } | { error: string } {
  const from = input.current || 'pending'
  const allowed = NEXT_STEPS[from] || []
  if (!allowed.includes(input.next as RedemptionStatus)) {
    return { error: `A ${from} redemption cannot be marked ${input.next}.` }
  }
  const update: Record<string, unknown> = { fulfillment_status: input.next }
  if (input.next === 'processing' || input.next === 'fulfilled') update.fulfilled_by = input.actorId
  if (input.next === 'fulfilled') update.fulfilled_at = input.now
  const notes = typeof input.notes === 'string' ? input.notes.trim() : ''
  if (notes) update.fulfillment_notes = notes.slice(0, 1000)
  return { update }
}
