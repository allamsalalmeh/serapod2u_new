import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  activeRef,
  affiliateCommission,
  allocateBundlePrice,
  bundleAvailability,
  bundleCartId,
  bundleIdFromCartId,
  checkoutSettingsFromRow,
  defaultOrderBumpText,
  isBundleCartId,
  normalizeAffiliateCode,
  summarizeAffiliateOrders,
} from '@/lib/outdoor/sales-tools'
import { pickOutdoorShipping } from '@/lib/outdoor/shipping'

const chair = { variantId: 'chair', quantity: 1, retailPrice: 85 }
const mat = { variantId: 'mat', quantity: 1, retailPrice: 69 }
const tumbler = { variantId: 'tumbler', quantity: 2, retailPrice: 38 }

describe('Outdoor combos', () => {
  it('splits the combo price over the real items to the sen', () => {
    const parts = allocateBundlePrice(199, [chair, mat, tumbler])
    expect(parts.map((p) => p.variantId)).toEqual(['chair', 'mat', 'tumbler'])
    expect(Math.round(parts.reduce((sum, p) => sum + p.subtotal, 0) * 100)).toBe(19900)
    expect(parts.find((p) => p.variantId === 'tumbler')?.quantity).toBe(2)
    expect(parts[0].subtotal).toBeGreaterThan(parts[1].subtotal)
  })

  it('keeps awkward prices exact', () => {
    const parts = allocateBundlePrice(100, [
      { variantId: 'a', quantity: 3, retailPrice: 10 },
      { variantId: 'b', quantity: 3, retailPrice: 10 },
      { variantId: 'c', quantity: 3, retailPrice: 10 },
    ])
    expect(Math.round(parts.reduce((sum, p) => sum + p.subtotal, 0) * 100)).toBe(10000)
  })

  it('lets the scarcest item decide how many combos can be sold', () => {
    const stock = new Map([['chair', 5], ['mat', 2], ['tumbler', 3]])
    expect(bundleAvailability([chair, mat, tumbler], stock)).toBe(1)
    expect(bundleAvailability([chair, mat], stock)).toBe(2)
    expect(bundleAvailability([chair, { variantId: 'gone', quantity: 1 }], stock)).toBe(0)
    expect(bundleAvailability([chair], null)).toBeNull()
  })

  it('marks combo cart lines so checkout can tell them from products', () => {
    const id = bundleCartId('b1')
    expect(isBundleCartId(id)).toBe(true)
    expect(bundleIdFromCartId(id)).toBe('b1')
    expect(isBundleCartId('6f1c-variant')).toBe(false)
  })
})

describe('Outdoor checkout offer and delivery subsidy', () => {
  it('starts switched off so checkout behaves as before', () => {
    expect(checkoutSettingsFromRow(null)).toMatchObject({ shippingCustomerSharePercent: 100, orderBumpEnabled: false })
    expect(checkoutSettingsFromRow({ shipping_customer_share_percent: '70', order_bump_enabled: true, order_bump_price: '5' })).toMatchObject({
      shippingCustomerSharePercent: 70,
      orderBumpEnabled: true,
      orderBumpPrice: 5,
    })
  })

  it('writes the offer line the way management asked', () => {
    expect(defaultOrderBumpText(5, '4L Dry Bag', 25)).toBe('Add RM5 only to get a 4L Dry Bag (Original Price RM25) - Tick Here')
  })

  it('charges the customer their share of the delivery price', () => {
    expect(pickOutdoorShipping([{ outdoor_shipping_price: 20 }], 100, { customerSharePercent: 70, freeOver: null })).toMatchObject({
      amount: 14,
      actualCost: 20,
      subsidy: 6,
    })
    expect(pickOutdoorShipping([{ outdoor_shipping_price: 7.35 }], 100, { customerSharePercent: 70, freeOver: null }).amount).toBe(5.15)
  })

  it('leaves delivery untouched at 100% and when shipping is free', () => {
    expect(pickOutdoorShipping([{ outdoor_shipping_price: 20 }], 100, { customerSharePercent: 100, freeOver: null })).toEqual(
      pickOutdoorShipping([{ outdoor_shipping_price: 20 }], 100, { freeOver: null }),
    )
    expect(pickOutdoorShipping([{ outdoor_shipping_price: 0 }], 100, { customerSharePercent: 70 }).subsidy).toBeUndefined()
  })
})

describe('Outdoor affiliate links', () => {
  it('accepts simple codes only', () => {
    expect(normalizeAffiliateCode(' host-aina ')).toBe('HOST-AINA')
    expect(normalizeAffiliateCode('ab')).toBe('')
    expect(normalizeAffiliateCode('bad code!')).toBe('')
  })

  it('remembers a link for 30 days', () => {
    const now = Date.UTC(2026, 9, 7)
    expect(activeRef({ code: 'HOST1', at: now - 29 * 86_400_000 }, now)).toBe('HOST1')
    expect(activeRef({ code: 'HOST1', at: now - 31 * 86_400_000 }, now)).toBe('')
    expect(activeRef(null, now)).toBe('')
  })

  it('counts paid orders only and pays commission on goods, not delivery', () => {
    const rows = summarizeAffiliateOrders(
      [
        { affiliate_id: 'h1', total_amount: 110, shipping_amount: 10, status: 'paid' },
        { affiliate_id: 'h1', total_amount: 55, shipping_amount: 5, status: 'delivered' },
        { affiliate_id: 'h1', total_amount: 999, shipping_amount: 0, status: 'pending_payment' },
        { affiliate_id: 'h2', total_amount: 40, shipping_amount: 0, status: 'shipped' },
        { affiliate_id: null, total_amount: 40, shipping_amount: 0, status: 'paid' },
      ],
      new Map([['h1', 10], ['h2', 5]]),
    )
    expect(rows).toEqual([
      { affiliateId: 'h1', orders: 2, goods: 150, commission: 15 },
      { affiliateId: 'h2', orders: 1, goods: 40, commission: 2 },
    ])
    expect(affiliateCommission(99.99, 7.5)).toBe(7.5)
  })
})

describe('Outdoor sales tools migration', () => {
  const sql = fs
    .readFileSync(path.resolve(__dirname, '../../../../supabase/migrations/20261007140000_outdoor_sales_tools.sql'), 'utf8')
    .toLowerCase()

  it('keeps the new tables server-only', () => {
    for (const table of ['outdoor_checkout_settings', 'outdoor_bundles', 'outdoor_bundle_items', 'outdoor_affiliates']) {
      expect(sql).toContain(`alter table public.${table} enable row level security`)
      expect(sql).toContain(`revoke all on table public.${table} from public, anon, authenticated`)
    }
  })

  it('starts with no subsidy and the offer off', () => {
    expect(sql).toContain('shipping_customer_share_percent numeric(5,2) not null default 100')
    expect(sql).toContain('order_bump_enabled boolean not null default false')
  })
})
