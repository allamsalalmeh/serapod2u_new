import { beforeEach, describe, expect, it, vi } from 'vitest'

const getUser = vi.fn()
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser } }) }))

import { resolveCheckoutAffiliate } from './server'

const host = { id: 'h1', code: 'HOSTLIVE-TUAH', kind: 'host', commission_mode: 'custom', commission_percent: 3, is_active: true }
const affiliate = {
  id: 'a1', code: 'AMINAH-7K2Q', kind: 'affiliate', commission_mode: 'program', commission_percent: 0, is_active: true,
  user_id: 'u-aff', contact_email: 'aminah@mail.com', contact_phone: '0123456789',
}

function db({ row, settings }: { row: any; settings: any }) {
  return {
    from(table: string) {
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: async () => ({
          data: [
            { id: 'p-mat', is_vape: false, category_id: 'c-out' },
            { id: 'p-vape', is_vape: true, category_id: 'c-vape' },
          ],
          error: null,
        }),
        maybeSingle: async () => ({ data: table === 'outdoor_affiliates' ? row : settings, error: null }),
      }
      return chain
    },
  }
}

const programOn = { enabled: true, join_mode: 'open', commission_percent: 5, attribution_days: 30, exclude_vape: true }
const base = {
  subId: 'tiktok',
  clickedAt: undefined as number | undefined,
  buyer: { email: 'buyer@mail.com', phone: '0198765432' },
  lines: [
    { variant_id: 'v-mat', subtotal: 120 },
    { variant_id: 'v-vape', subtotal: 80 },
  ],
  variants: [
    { id: 'v-mat', product_id: 'p-mat' },
    { id: 'v-vape', product_id: 'p-vape' },
  ],
}

describe('resolveCheckoutAffiliate', () => {
  beforeEach(() => {
    getUser.mockResolvedValue({ data: { user: { id: 'u-buyer' } } })
  })

  it('keeps a live host on Outdoor exactly as before (no program columns)', async () => {
    const out = await resolveCheckoutAffiliate(db({ row: host, settings: programOn }), {
      ...base, channel: 'outdoor', outdoorResolved: { id: 'h1', code: 'HOSTLIVE-TUAH' }, code: 'HOSTLIVE-TUAH',
    })
    expect(out).toEqual({ affiliate: { id: 'h1', code: 'HOSTLIVE-TUAH' }, columns: {} })
  })

  it('drops a host link older than 30 days and never applies a host to Store', async () => {
    const old = await resolveCheckoutAffiliate(db({ row: host, settings: programOn }), {
      ...base, channel: 'outdoor', outdoorResolved: { id: 'h1', code: 'HOSTLIVE-TUAH' }, code: 'HOSTLIVE-TUAH', clickedAt: Date.now() - 31 * 86_400_000,
    })
    expect(old.affiliate).toBeNull()
    const store = await resolveCheckoutAffiliate(db({ row: host, settings: programOn }), {
      ...base, channel: 'store', outdoorResolved: null, code: 'HOSTLIVE-TUAH',
    })
    expect(store.affiliate).toBeNull()
  })

  it('without a code keeps what Outdoor resolved and gives Store nothing', async () => {
    const out = await resolveCheckoutAffiliate(db({ row: null, settings: programOn }), { ...base, channel: 'outdoor', outdoorResolved: null, code: '' })
    expect(out).toEqual({ affiliate: null, columns: {} })
  })

  it('attributes nothing while the program is off', async () => {
    const out = await resolveCheckoutAffiliate(db({ row: affiliate, settings: { ...programOn, enabled: false } }), {
      ...base, channel: 'store', outdoorResolved: null, code: 'AMINAH-7K2Q',
    })
    expect(out.affiliate).toBeNull()
  })

  it('saves the program rate and the eligible goods value (vape left out)', async () => {
    const out = await resolveCheckoutAffiliate(db({ row: affiliate, settings: programOn }), {
      ...base, channel: 'store', outdoorResolved: null, code: 'aminah-7k2q', clickedAt: Date.now() - 86_400_000,
    })
    expect(out).toEqual({
      affiliate: { id: 'a1', code: 'AMINAH-7K2Q' },
      columns: { affiliate_sub_id: 'tiktok', affiliate_commission_percent: 5, affiliate_eligible_amount: 120 },
    })
  })

  it('refuses the affiliate buying through their own link, and clicks outside the window', async () => {
    const self = await resolveCheckoutAffiliate(db({ row: affiliate, settings: programOn }), {
      ...base, channel: 'store', outdoorResolved: null, code: 'AMINAH-7K2Q', buyer: { email: 'AMINAH@mail.com', phone: '' },
    })
    expect(self.affiliate).toBeNull()
    getUser.mockResolvedValue({ data: { user: { id: 'u-aff' } } })
    const ownAccount = await resolveCheckoutAffiliate(db({ row: affiliate, settings: programOn }), {
      ...base, channel: 'store', outdoorResolved: null, code: 'AMINAH-7K2Q',
    })
    expect(ownAccount.affiliate).toBeNull()
    getUser.mockResolvedValue({ data: { user: { id: 'u-buyer' } } })
    const late = await resolveCheckoutAffiliate(db({ row: affiliate, settings: { ...programOn, attribution_days: 7 } }), {
      ...base, channel: 'store', outdoorResolved: null, code: 'AMINAH-7K2Q', clickedAt: Date.now() - 8 * 86_400_000,
    })
    expect(late.affiliate).toBeNull()
  })

  it('uses an own rate for staff-added affiliates', async () => {
    const out = await resolveCheckoutAffiliate(db({ row: { ...affiliate, commission_mode: 'custom', commission_percent: 8 }, settings: programOn }), {
      ...base, channel: 'outdoor', outdoorResolved: { id: 'a1', code: 'AMINAH-7K2Q' }, code: 'AMINAH-7K2Q',
    })
    expect(out.columns.affiliate_commission_percent).toBe(8)
  })
})
