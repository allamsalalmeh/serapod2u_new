import { describe, expect, it } from 'vitest'
import { computeDestinations, customerGrowthVisible, PAYMENT_GATEWAY_PERMISSION } from './nav-access'

const destinations = (org: string[]) => computeDestinations({ org: Object.fromEntries(org.map(p => [p, true])), self: {} })
const snapshot = (org: string[]) => ({
  userId: 'u', organizationId: 'o', sidebar: { users: false, securityAccess: false }, policies: [], destinations: destinations(org),
})

const STORE_SECTIONS = ['hero-banners', 'store-banner-manager', 'login-hero-banner']
const ORDER_SECTIONS = ['store-orders', 'ecommerce/tiktok-shop']
const GATEWAY = ['ecommerce/payment-gateway', 'settings/payment-gateway']

describe('E-Commerce navigation follows the operational permissions', () => {
  it('E-Commerce Administrator (store + order management, no module.view) opens the module and its own sections', () => {
    const d = destinations(['ecommerce.store.manage', 'ecommerce.order.manage'])
    expect(d.ecommerce).toBe(true)
    for (const id of [...STORE_SECTIONS, ...ORDER_SECTIONS]) expect(d[id], id).toBe(true)
    expect(customerGrowthVisible(snapshot(['ecommerce.store.manage', 'ecommerce.order.manage']))).toBe(true)
  })

  it('a store-only holder does not see order sections, and vice versa', () => {
    const store = destinations(['ecommerce.store.manage'])
    for (const id of STORE_SECTIONS) expect(store[id], id).toBe(true)
    for (const id of ORDER_SECTIONS) expect(store[id], id).toBe(false)
    const orders = destinations(['ecommerce.order.manage'])
    for (const id of ORDER_SECTIONS) expect(orders[id], id).toBe(true)
    for (const id of STORE_SECTIONS) expect(orders[id], id).toBe(false)
  })

  it('the module view permission keeps its existing read-only visibility of store and order sections', () => {
    const d = destinations(['ecommerce.module.view'])
    for (const id of ['ecommerce', ...STORE_SECTIONS, ...ORDER_SECTIONS]) expect(d[id], id).toBe(true)
  })

  it('without any E-Commerce permission nothing is visible', () => {
    const d = destinations(['customer.crm.view', 'reporting.analytics.view'])
    for (const id of ['ecommerce', ...STORE_SECTIONS, ...ORDER_SECTIONS, ...GATEWAY]) expect(d[id], id).toBe(false)
  })
})

describe('Payment Gateway is privileged administration', () => {
  it('is never implied by ordinary E-Commerce access', () => {
    const d = destinations(['ecommerce.module.view', 'ecommerce.store.manage', 'ecommerce.order.manage', 'ecommerce.outdoor.operate'])
    for (const id of GATEWAY) expect(d[id], id).toBe(false)
  })

  it('opens only with the payment gateway permission (the payment_gateway_settings RLS gate)', () => {
    expect(PAYMENT_GATEWAY_PERMISSION).toBe('ecommerce.channel.manage')
    const d = destinations([PAYMENT_GATEWAY_PERMISSION])
    for (const id of GATEWAY) expect(d[id], id).toBe(true)
    // Holding only the gateway permission still opens the module entry (so the section is reachable).
    expect(d.ecommerce).toBe(true)
    for (const id of [...STORE_SECTIONS, ...ORDER_SECTIONS]) expect(d[id], id).toBe(false)
  })
})
