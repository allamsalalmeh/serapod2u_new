import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REQUIRED_NOTIFICATION_TYPES } from '@/lib/notifications/notificationEventCatalog'
import { getTemplatesForEvent } from '@/config/notificationTemplates'
import {
  DAILY_REPORT_EVENT,
  DAILY_REPORT_SCHEDULE,
  DAILY_SUMMARY_EVENT,
  buildDailyReport,
  expandSku,
  mytDate,
  mytDayBounds,
  mytHour,
  type ReportOrderLine,
} from './tiktok-daily-report'

const line = (over: Partial<ReportOrderLine>): ReportOrderLine => ({
  shop_id: 'sera',
  order_id: 'o1',
  package_id: null,
  seller_sku: null,
  product_name: null,
  variation: 'Lalai',
  quantity: 1,
  order_substatus: 'Awaiting shipment',
  created_time: '2026-10-06T05:00:00Z',
  ...over,
})

const shops = [{ id: 'sera', name: 'SeraOutdoor' }, { id: 'ellbow', name: 'Ellbow' }]

// Parcels sent on 7/10/2026 as listed in the warehouse's manual report.
const sera = [
  line({ order_id: 'a', package_id: 'p1', seller_sku: 'PROMO - HB (1) FREE MC (1)' }),
  line({ order_id: 'b', package_id: 'p2', seller_sku: 'PROMO - HB (1) FREE T1L (1)' }),
  line({ order_id: 'c', package_id: 'p3', seller_sku: 'PROMO - HB (1) FREE T1L (1)' }),
  line({ order_id: 'c', package_id: 'p3', seller_sku: 'PROMO - HB (1) FREE T1L (1)', variation: 'Lalai' }),
]
const ellbow = [
  line({ shop_id: 'ellbow', order_id: 'd', package_id: 'p4', seller_sku: 'PACK-10 MF', variation: 'Mixed Flavours' }),
  line({ shop_id: 'ellbow', order_id: 'e', package_id: 'p5', seller_sku: 'BOX-TP', variation: 'Tuna Prime' }),
  line({ shop_id: 'ellbow', order_id: 'f', package_id: 'p6', seller_sku: 'BOX-BB', variation: 'Bold Beef' }),
  line({ shop_id: 'ellbow', order_id: 'g', package_id: 'p7', seller_sku: 'BOX-SGM', variation: 'SALMON GOAT MILK', created_time: '2026-10-07T01:06:45Z' }),
  line({ shop_id: 'ellbow', order_id: 'g', package_id: 'p7', seller_sku: 'BOX-CB', variation: 'CHICKEN BOOST', created_time: '2026-10-07T01:06:45Z' }),
]

describe('expandSku', () => {
  it('reads promo and combo SKUs into physical items', () => {
    expect(expandSku('PROMO - HB (1) FREE T1L (1)', null)).toEqual([{ item: 'HIGHBACK', quantity: 1 }, { item: 'TUMBLER 1L', quantity: 1 }])
    expect(expandSku('COMBO-HB(2)', null)).toEqual([{ item: 'HIGHBACK', quantity: 2 }])
    expect(expandSku('COMBO - T1L X CM', null)).toEqual([{ item: 'TUMBLER 1L', quantity: 1 }, { item: 'CAMPING MAT', quantity: 1 }])
    expect(expandSku('COMBO-MCXHB', null)).toEqual([{ item: 'MOONCHAIR', quantity: 1 }, { item: 'HIGHBACK', quantity: 1 }])
    expect(expandSku('COMBO- CHAIR AND T1L', null)).toEqual([{ item: 'MOONCHAIR', quantity: 1 }, { item: 'TUMBLER 1L', quantity: 1 }])
    expect(expandSku('COMBO ALL IN', null).map((p) => p.item)).toEqual(['TUMBLER 1L', 'HIGHBACK', 'MOONCHAIR', 'CAMPING MAT'])
  })

  it('maps single products and Ellbow treats', () => {
    expect(expandSku('SERAPOD TUMBLER 1L', null)).toEqual([{ item: 'TUMBLER 1L', quantity: 1 }])
    expect(expandSku('BOX-SGM', null)).toEqual([{ item: 'TREAT BOX', quantity: 1 }])
    expect(expandSku('PACK-10 CCK', null)).toEqual([{ item: 'TREAT PEK JIMAT', quantity: 1 }])
  })

  it('never drops a SKU it cannot read', () => {
    expect(expandSku('COMBO - MCXHMC', null)).toEqual([{ item: 'COMBO - MCXHMC', quantity: 1 }])
    expect(expandSku(null, '[COMBO All In] Tumbler 1L/Highback Moonchair')).toHaveLength(4)
    expect(expandSku(null, 'Some New Product Name')).toEqual([{ item: 'SOME NEW PRODUCT NAME', quantity: 1 }])
  })
})

describe('buildDailyReport', () => {
  const now = new Date('2026-10-07T01:35:00Z')
  const report = buildDailyReport({ slot: 'packing', now, shops, lines: [...sera, ...ellbow], lastSyncAt: '2026-10-07T01:23:00Z' })

  it('matches the manual report for SeraOutdoor', () => {
    const s = report.shops.find((r) => r.shop === 'SeraOutdoor')!
    expect(s.parcels).toBe(3)
    expect(s.items).toBe(8)
    expect(Object.fromEntries(s.itemTotals.map((r) => [r.item, r.quantity]))).toEqual({ HIGHBACK: 4, 'TUMBLER 1L': 3, MOONCHAIR: 1 })
  })

  it('matches the manual report for Ellbow, with flavours', () => {
    const e = report.shops.find((r) => r.shop === 'Ellbow')!
    expect(e.parcels).toBe(4)
    expect(e.items).toBe(5)
    const box = e.itemTotals.find((r) => r.item === 'TREAT BOX')!
    expect(box.quantity).toBe(4)
    expect(box.variations.map((v) => v.name)).toContain('Salmon Goat Milk')
    expect(e.orderFrom).toBe('6/10/2026')
    expect(e.orderTo).toBe('7/10/2026')
  })

  it('writes the email text and a short SMS', () => {
    expect(report.subject).toBe('TikTok Shop - to pack (7/10/2026, 9:35 am)')
    expect(report.text).toContain('TOTAL PARCEL : 3')
    expect(report.text).toContain('HIGHBACK : 4')
    expect(report.text).toContain('TikTok data as of 7/10/2026 9:23 am')
    expect(report.summary).toBe('[Serapod2U] TikTok to pack 7/10/2026 9:35 am: SeraOutdoor 3 parcels/8 items; Ellbow 4 parcels/5 items.')
    expect(report.summary.length).toBeLessThanOrEqual(160)
  })

  it('says so when a shop has nothing', () => {
    const empty = buildDailyReport({ slot: 'shipped', now, shops, lines: [] })
    expect(empty.text).toContain('Nothing shipped today.')
    expect(empty.summary).toContain('SeraOutdoor 0 parcels/0 items')
  })
})

describe('Malaysia time and schedule', () => {
  it('uses UTC+8 days and hours', () => {
    expect(mytDate('2026-10-06T16:30:00Z')).toBe('7/10/2026')
    expect(mytHour(new Date('2026-10-07T01:35:00Z'))).toBe(9)
    expect(mytDayBounds(new Date('2026-10-07T10:00:00Z'))).toEqual({ start: '2026-10-06T16:00:00.000Z', end: '2026-10-07T16:00:00.000Z' })
  })

  it('packs at 9 and 12, reports shipped at 18', () => {
    expect(DAILY_REPORT_SCHEDULE).toEqual({ 9: 'packing', 12: 'packing', 18: 'shipped' })
  })
})

describe('Notification Types wiring', () => {
  it('registers both events under E-Commerce, off by default', () => {
    const full = REQUIRED_NOTIFICATION_TYPES.find((t) => t.event_code === DAILY_REPORT_EVENT)!
    const short = REQUIRED_NOTIFICATION_TYPES.find((t) => t.event_code === DAILY_SUMMARY_EVENT)!
    expect(full.default_enabled).toBe(false)
    expect(full.available_channels).toEqual(['email', 'whatsapp'])
    expect(short.available_channels).toEqual(['sms', 'whatsapp'])
    expect(full.category).toBe('ecommerce')
  })

  it('the full report has no SMS; the short summary carries the SMS', () => {
    expect(getTemplatesForEvent(DAILY_REPORT_EVENT, 'email')[0].body).toBe('{{report_text}}')
    expect(getTemplatesForEvent(DAILY_REPORT_EVENT, 'sms')).toEqual([])
    expect(getTemplatesForEvent(DAILY_SUMMARY_EVENT, 'sms').map((t) => t.body)).toContain('{{summary_text}}')
    expect(getTemplatesForEvent(DAILY_SUMMARY_EVENT, 'email')).toEqual([])
  })

  it('the default SMS template fills from the report and fits one SMS', () => {
    const r = buildDailyReport({ slot: 'packing', now: new Date('2026-10-07T04:35:00Z'), shops, lines: [...sera, ...ellbow] })
    const payload: Record<string, string> = {
      report_title: r.label, report_date: r.date, report_time: r.time, shop_counts: r.shopCounts,
      total_parcels: String(r.parcels), total_items: String(r.items), summary_text: r.summary,
    }
    const body = getTemplatesForEvent(DAILY_SUMMARY_EVENT, 'sms')[0].body
    const sms = body.replace(/\{\{(\w+)\}\}/g, (_, key) => payload[key] ?? `{{${key}}}`)
    expect(sms).toBe('[Serapod2U] TikTok to pack (7/10/2026 12:35 pm): SeraOutdoor 3 parcels/8 items; Ellbow 4 parcels/5 items. Total 7 parcels, 13 items.')
    expect(sms.length).toBeLessThanOrEqual(160)
  })

  it('migration seeds the same two catalog rows and nothing else', () => {
    const sql = readFileSync(join(__dirname, '../../../../supabase/migrations/20261007160000_tiktok_daily_shipping_report_notification_types.sql'), 'utf8')
    expect(sql).toContain("'tiktok_shop_daily_report'")
    expect(sql).toContain("'tiktok_shop_daily_report_sms'")
    expect(sql).not.toMatch(/notification_settings|DELETE|DROP/i)
  })
})
