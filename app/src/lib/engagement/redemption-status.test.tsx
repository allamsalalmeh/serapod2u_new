import { describe, expect, it } from 'vitest'
import { planRedemptionStatusChange } from './redemption-status'

const base = { actorId: 'u1', now: '2026-10-26T07:00:00.000Z' }

describe('planRedemptionStatusChange', () => {
  it('Process: pending → processing, recording who took it', () => {
    expect(planRedemptionStatusChange({ ...base, current: 'pending', next: 'processing' }))
      .toEqual({ update: { fulfillment_status: 'processing', fulfilled_by: 'u1' } })
  })

  it('treats a missing status as pending', () => {
    expect(planRedemptionStatusChange({ ...base, current: null, next: 'processing' }))
      .toEqual({ update: { fulfillment_status: 'processing', fulfilled_by: 'u1' } })
  })

  it('Fulfill: processing → fulfilled, with the time', () => {
    expect(planRedemptionStatusChange({ ...base, current: 'processing', next: 'fulfilled' }))
      .toEqual({ update: { fulfillment_status: 'fulfilled', fulfilled_by: 'u1', fulfilled_at: base.now } })
  })

  it('Cancel from pending or processing changes only the status', () => {
    expect(planRedemptionStatusChange({ ...base, current: 'pending', next: 'cancelled' })).toEqual({ update: { fulfillment_status: 'cancelled' } })
    expect(planRedemptionStatusChange({ ...base, current: 'processing', next: 'cancelled' })).toEqual({ update: { fulfillment_status: 'cancelled' } })
  })

  it('keeps notes when given', () => {
    expect(planRedemptionStatusChange({ ...base, current: 'processing', next: 'fulfilled', notes: '  Paid by transfer  ' }))
      .toEqual({ update: { fulfillment_status: 'fulfilled', fulfilled_by: 'u1', fulfilled_at: base.now, fulfillment_notes: 'Paid by transfer' } })
  })

  it('refuses steps the screen does not offer', () => {
    expect(planRedemptionStatusChange({ ...base, current: 'pending', next: 'fulfilled' })).toHaveProperty('error')
    expect(planRedemptionStatusChange({ ...base, current: 'fulfilled', next: 'cancelled' })).toHaveProperty('error')
    expect(planRedemptionStatusChange({ ...base, current: 'cancelled', next: 'processing' })).toHaveProperty('error')
    expect(planRedemptionStatusChange({ ...base, current: 'pending', next: 'deleted' })).toHaveProperty('error')
  })
})
