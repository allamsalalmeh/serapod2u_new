import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  status: 'pending_payment',
  error: null as Error | null,
  events: vi.fn(), outdoor: vi.fn(), store: vi.fn(), sms: vi.fn(), staff: vi.fn(),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: () => {
  let next: any
  let allowed: string[] = []
  const chain: any = {
    update: (value: any) => { next = value; return chain },
    eq: () => chain,
    in: (_key: string, values: string[]) => { allowed = values; return chain },
    select: () => {
      if (!next) return chain
      if (state.error) return Promise.resolve({ data: null, error: state.error })
      const updated = allowed.includes(state.status)
      if (updated) state.status = next.status
      return Promise.resolve({ data: updated ? [{ id: 'o1' }] : [], error: null })
    },
    maybeSingle: async () => ({ data: { status: state.status } }),
  }
  return chain
} }) }))
vi.mock('@/lib/storefront/order-events', () => ({ recordOrderEvent: (...args: any[]) => state.events(...args) }))
vi.mock('@/lib/outdoor/order-paid-email', () => ({ notifyOutdoorOrderPaid: (...args: any[]) => state.outdoor(...args) }))
vi.mock('@/lib/storefront/order-paid-email', () => ({ notifyStoreOrderPaid: (...args: any[]) => state.store(...args) }))
vi.mock('@/lib/outdoor/order-sms', () => ({ notifyOutdoorOrderSms: (...args: any[]) => state.sms(...args) }))
vi.mock('@/lib/storefront/order-paid-staff-alert', () => ({ notifyStaffOrderPaid: (...args: any[]) => state.staff(...args) }))
import { applyStorefrontPaymentResult } from './apply-callback'
const paid = { verified: true, orderId: 'o1', paid: true, transactionId: 'cs_test' }

describe('paid callback notification reconciliation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    state.status = 'pending_payment'
    state.error = null
    for (const fn of [state.events, state.outdoor, state.store, state.sms, state.staff]) fn.mockReset().mockResolvedValue(undefined)
  })
  it('awaits all notification paths and never repeats them for a replay', async () => {
    let complete!: () => void
    state.staff.mockImplementation(() => new Promise<void>(resolve => { complete = resolve }))
    let finished = false
    const pending = applyStorefrontPaymentResult(paid).then(value => { finished = true; return value })
    await vi.waitFor(() => expect(state.staff).toHaveBeenCalledTimes(1))
    expect(finished).toBe(false)
    complete()
    expect(await pending).toEqual({ updated: true, paid: true })
    expect(await applyStorefrontPaymentResult(paid)).toEqual({ updated: false, paid: true })
    for (const fn of [state.events, state.outdoor, state.store, state.sms, state.staff]) expect(fn).toHaveBeenCalledTimes(1)
  })
  it('keeps payment applied when notification paths fail and does not resend on retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const fn of [state.outdoor, state.store, state.sms, state.staff]) fn.mockRejectedValue(new Error('delivery unavailable'))
    await expect(applyStorefrontPaymentResult(paid)).resolves.toEqual({ updated: true, paid: true })
    expect(state.status).toBe('paid')
    await applyStorefrontPaymentResult(paid)
    for (const fn of [state.outdoor, state.store, state.sms, state.staff]) expect(fn).toHaveBeenCalledTimes(1)
  })
  it('sends nothing for unverified, failed or already completed payments', async () => {
    await applyStorefrontPaymentResult({ ...paid, verified: false })
    state.status = 'shipped'
    await applyStorefrontPaymentResult(paid)
    state.status = 'pending_payment'
    await applyStorefrontPaymentResult({ ...paid, paid: false })
    for (const fn of [state.outdoor, state.store, state.sms, state.staff]) expect(fn).not.toHaveBeenCalled()
  })
  it('does not notify when the conditional database update fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    state.error = new Error('write failed')
    await expect(applyStorefrontPaymentResult(paid)).rejects.toThrow('write failed')
    expect(state.status).toBe('pending_payment')
    for (const fn of [state.events, state.outdoor, state.store, state.sms, state.staff]) expect(fn).not.toHaveBeenCalled()
  })
})
