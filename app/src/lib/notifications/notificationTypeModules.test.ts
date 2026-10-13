import { describe, expect, it } from 'vitest'
import {
  CATEGORY_MODULE,
  deliveryLabel,
  filterCategoryTypes,
  groupByModule,
  resolveEventDelivery,
} from './notificationTypeModules'

const type = (category: string, event_code: string, event_name = event_code, event_description = '') => ({ category, event_code, event_name, event_description })

describe('groupByModule', () => {
  it('places every known category under its S&A module in S&A order', () => {
    const types = Object.keys(CATEGORY_MODULE).map((category) => type(category, `${category}_event`))
    const sections = groupByModule(types)
    expect(sections.map((s) => s.name)).toEqual(['Supply Chain', 'Customer & Growth', 'Platform & Settings'])
    expect(sections[0].categories.map((c) => c.label)).toEqual(['Order Status', 'Order Document', 'Inventory & Stock', 'Return Product'])
    expect(sections[1].categories.map((c) => c.label)).toEqual(['QR & Consumer', 'RoadTour'])
    expect(sections[2].categories.map((c) => c.label)).toEqual(['Security & OTP', 'User Account', 'Delete Organization Masterdata', 'System Check'])
    expect(sections.flatMap((s) => s.categories.flatMap((c) => c.types)).length).toBe(types.length)
  })

  it('omits modules without types and keeps unknown categories visible', () => {
    const sections = groupByModule([type('order', 'a'), type('brand_new', 'b')])
    expect(sections.map((s) => s.id)).toEqual(['supply_chain', 'other'])
    expect(sections[1].categories[0].types[0].event_code).toBe('b')
  })
})

describe('resolveEventDelivery', () => {
  const routing = { defaultPreset: 'email_only' as const, categoryPresets: {}, eventPresets: {} }
  const t = type('order', 'order_approved')

  it('follows Default → Category → Notification', () => {
    expect(resolveEventDelivery(t, routing)).toEqual({ preset: 'email_only', source: 'default' })
    const withCategory = { ...routing, categoryPresets: { order: 'sms_only' as const } }
    expect(resolveEventDelivery(t, withCategory)).toEqual({ preset: 'sms_only', source: 'category' })
    const withEvent = { ...withCategory, eventPresets: { order_approved: 'whatsapp_email_fallback' as const } }
    expect(resolveEventDelivery(t, withEvent)).toEqual({ preset: 'whatsapp_email_fallback', source: 'custom' })
  })

  it('keeps explicit child overrides when a parent changes', () => {
    const state = { defaultPreset: 'email_only' as const, categoryPresets: { order: 'sms_only' as const }, eventPresets: { order_approved: 'whatsapp_only' as const } }
    expect(resolveEventDelivery(t, { ...state, defaultPreset: 'sms_only' }).preset).toBe('whatsapp_only')
    expect(resolveEventDelivery(t, { ...state, categoryPresets: { order: 'email_only' } }).preset).toBe('whatsapp_only')
  })

  it('lets forced presets win', () => {
    expect(resolveEventDelivery(t, routing, { order_approved: 'sms_only' })).toEqual({ preset: 'sms_only', source: 'fixed' })
  })

  it('labels source and route, including fallbacks', () => {
    expect(deliveryLabel('default', 'email_only')).toBe('Default · Email')
    expect(deliveryLabel('category', 'sms_only')).toBe('Category · SMS')
    expect(deliveryLabel('custom', 'whatsapp_sms_email_fallback')).toBe('Custom · WhatsApp → SMS → Email')
  })
})

describe('filterCategoryTypes', () => {
  const category = { category: 'order', label: 'Order Status', types: [type('order', 'a', 'Order Approved', 'Sent on approval'), type('order', 'b', 'Order Rejected', 'Sent on rejection')] }
  const enabled = (t: { event_code: string }) => t.event_code === 'a'

  it('matches names and descriptions', () => {
    expect(filterCategoryTypes(category, 'rejected', 'all', enabled).map((t) => t.event_code)).toEqual(['b'])
    expect(filterCategoryTypes(category, 'on approval', 'all', enabled).map((t) => t.event_code)).toEqual(['a'])
  })

  it('keeps every notification when the category name matches', () => {
    expect(filterCategoryTypes(category, 'order status', 'all', enabled)).toHaveLength(2)
  })

  it('applies status to individual notifications', () => {
    expect(filterCategoryTypes(category, '', 'enabled', enabled).map((t) => t.event_code)).toEqual(['a'])
    expect(filterCategoryTypes(category, '', 'disabled', enabled).map((t) => t.event_code)).toEqual(['b'])
  })
})
