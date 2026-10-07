import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TikTokApiError,
  callTikTokApi,
  mapOrderToLines,
  mapStatementTransaction,
  mapWithdrawal,
  myDateToUnix,
  signTikTokRequest,
  tiktokAuthorizeUrl,
  unixToMyDate,
} from './tiktok-api'
import { pickTikTokShop, readTikTokStateCookie, tiktokStateCookie } from './tiktok-oauth'
import { claimSyncRun } from './tiktok-sync'

const env = { ...process.env }
beforeEach(() => {
  process.env.TIKTOK_SHOP_APP_KEY = 'appkey1'
  process.env.TIKTOK_SHOP_APP_SECRET = 'secret1'
  process.env.TIKTOK_SHOP_SERVICE_ID = '7000000000000000001'
})
afterEach(() => {
  process.env = { ...env }
})

describe('signTikTokRequest', () => {
  it('signs secret + path + sorted params (without sign and access_token) + body + secret with HMAC-SHA256', () => {
    const sign = signTikTokRequest(
      '/order/202309/orders/search',
      { timestamp: '1700000000', shop_cipher: 'ROW_abc', app_key: 'appkey1', page_size: '100', sign: 'old', access_token: 'tok' },
      '{"update_time_ge":1}',
      'secret1',
    )
    const base = 'secret1/order/202309/orders/searchapp_keyappkey1page_size100shop_cipherROW_abctimestamp1700000000{"update_time_ge":1}secret1'
    expect(sign).toBe(createHmac('sha256', 'secret1').update(base).digest('hex'))
    expect(sign).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('callTikTokApi', () => {
  it('sends app_key, timestamp, shop_cipher and sign in the query and the token in x-tts-access-token', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { ok: true } }), { status: 200 }))
    const data = await callTikTokApi({
      path: '/finance/202309/statements',
      accessToken: 'tok',
      shopCipher: 'ROW_abc',
      query: { page_size: 100, page_token: 'a/b+c' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_700_000_000_500,
    })
    expect(data).toEqual({ ok: true })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://open-api.tiktokglobalshop.com/finance/202309/statements')
    expect(u.searchParams.get('timestamp')).toBe('1700000000')
    expect(u.searchParams.get('page_token')).toBe('a/b+c')
    const query = Object.fromEntries(u.searchParams.entries())
    expect(query.sign).toBe(signTikTokRequest('/finance/202309/statements', query, '', 'secret1'))
    expect((init.headers as Record<string, string>)['x-tts-access-token']).toBe('tok')
    expect(init.body).toBeUndefined()
  })

  it('throws TikTokApiError when the response code is not 0', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: 105002, message: 'Expired credentials' }), { status: 200 }))
    await expect(callTikTokApi({ path: '/x', accessToken: 't', fetchImpl: fetchImpl as unknown as typeof fetch }))
      .rejects.toMatchObject({ code: 105002, message: 'Expired credentials' })
    await expect(callTikTokApi({ path: '/x', accessToken: 't', fetchImpl: fetchImpl as unknown as typeof fetch })).rejects.toBeInstanceOf(TikTokApiError)
  })
})

describe('authorization helpers', () => {
  it('builds the authorize link with service_id and state', () => {
    const u = new URL(tiktokAuthorizeUrl('abc123'))
    expect(u.origin + u.pathname).toBe('https://services.tiktokshop.com/open/authorize')
    expect(u.searchParams.get('service_id')).toBe('7000000000000000001')
    expect(u.searchParams.get('state')).toBe('abc123')
  })

  it('round-trips the state cookie with the shop id', () => {
    const cookie = tiktokStateCookie('s1', '0b5c3f2e-0000-4000-8000-000000000001').split(';')[0]
    expect(readTikTokStateCookie(`a=1; ${cookie}; b=2`)).toEqual({ state: 's1', shopId: '0b5c3f2e-0000-4000-8000-000000000001' })
    expect(readTikTokStateCookie('a=1')).toBeNull()
  })

  it('picks the authorized shop and refuses a TikTok account that is another Serapod shop', () => {
    const tt = (name: string, id = '1') => ({ id, name, region: 'MY', sellerType: 'LOCAL', cipher: `ROW_${id}`, code: 'MYLC' })
    const shops = [{ id: 'a', shop_name: 'SeraOutdoor' }, { id: 'b', shop_name: 'Ellbow' }]
    expect(pickTikTokShop([tt('SERAOUTDOOR')], shops[0], shops)).toEqual({ shop: tt('SERAOUTDOOR') })
    expect(pickTikTokShop([tt('Ellbow')], shops[0], shops)).toEqual({ error: 'wrong_shop' })
    expect(pickTikTokShop([tt('Ellbow', '1'), tt('Sera Outdoor', '2')], shops[0], shops)).toEqual({ shop: tt('Sera Outdoor', '2') })
    expect(pickTikTokShop([tt('X', '1'), tt('Y', '2')], shops[0], shops)).toEqual({ error: 'multiple_shops' })
    expect(pickTikTokShop([], shops[0], shops)).toEqual({ error: 'no_shop' })
  })
})

describe('dates', () => {
  it('converts to Malaysia calendar dates', () => {
    expect(unixToMyDate(Date.parse('2026-09-30T15:59:59Z') / 1000)).toBe('2026-09-30')
    expect(unixToMyDate(Date.parse('2026-09-30T16:00:00Z') / 1000)).toBe('2026-10-01')
    expect(myDateToUnix('2026-10-01')).toBe(Date.parse('2026-09-30T16:00:00Z') / 1000)
    expect(unixToMyDate(0)).toBeNull()
  })
})

describe('mapOrderToLines', () => {
  const unit = (sku: string, extra: Record<string, string> = {}) => ({
    id: `li-${Math.random()}`, sku_id: sku, seller_sku: `SKU-${sku}`, product_name: 'Camping Chair', sku_name: 'Black',
    original_price: '145.00', sale_price: '130.50', platform_discount: '4.50', seller_discount: '10.00', package_id: 'PKG1', ...extra,
  })
  const order = {
    id: '583000000000000001',
    status: 'DELIVERED',
    create_time: Date.parse('2026-09-30T14:58:49Z') / 1000,
    paid_time: Date.parse('2026-09-30T15:00:00Z') / 1000,
    update_time: 1790000000,
    payment_method_name: 'Online Banking',
    delivery_option_name: 'Standard shipping',
    shipping_provider: 'J&T Express',
    fulfillment_type: 'FULFILLMENT_BY_SELLER',
    payment: { total_amount: '266.00', shipping_fee: '5.00', original_shipping_fee: '8.00', tax: '0' },
    buyer_message: 'please call me', buyer_email: 'x@chat.seller.tiktok.com', user_id: '7213489962827123654',
    recipient_address: {
      name: 'Ali Bin Abu', phone_number: '(+60)12***34', full_address: '1 Jalan Satu, Shah Alam',
      district_info: [{ address_level: 'L0', address_name: 'Malaysia' }, { address_level: 'L1', address_name: 'Selangor' }, { address_level: 'L2', address_name: 'Shah Alam' }],
    },
    line_items: [unit('111'), unit('111'), unit('222', { original_price: '20', sale_price: '20', platform_discount: '0', seller_discount: '0' })],
  }

  it('makes one line per SKU with the quantity and summed amounts', () => {
    const lines = mapOrderToLines(order)
    expect(lines.map(l => [l.orderId, l.skuId, l.row.quantity])).toEqual([['583000000000000001', '111', 2], ['583000000000000001', '222', 1]])
    const a = lines[0].row
    expect(a).toMatchObject({
      order_status: 'Shipped', order_substatus: 'Delivered', seller_sku: 'SKU-111', variation: 'Black',
      unit_original_price: '145.00', subtotal_before_discount: '290.00', seller_discount: '20.00', platform_discount: '9.00',
      subtotal_after_discount: '261.00', order_amount: '266.00', shipping_fee_after_discount: '5.00', original_shipping_fee: '8.00',
      fulfillment_type: 'Fulfillment by seller', buyer_state: 'Selangor', buyer_country: 'Malaysia',
      created_time: '2026-09-30T14:58:49.000Z',
    })
    expect(lines[0].contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('keeps no customer personal data and leaves Excel-only columns untouched', () => {
    const lines = mapOrderToLines(order)
    const json = JSON.stringify(lines)
    for (const secret of ['Ali Bin Abu', '12***34', 'Jalan Satu', 'please call me', 'chat.seller', '7213489962827123654', 'Shah Alam']) {
      expect(json).not.toContain(secret)
    }
    for (const key of ['return_quantity', 'order_refund_amount', 'weight_kg', 'product_category', 'order_channel', 'creator_handle', 'warehouse_name']) {
      expect(lines[0].row).not.toHaveProperty(key)
    }
  })

  it('maps cancelled orders to the export wording and skips bad IDs', () => {
    expect(mapOrderToLines({ ...order, status: 'CANCELLED' })[0].row.order_status).toBe('Canceled')
    expect(mapOrderToLines({ ...order, id: '5.83E+17' })).toEqual([])
  })
})

describe('mapStatementTransaction', () => {
  const statementTime = Date.parse('2026-10-01T00:00:00Z') / 1000
  const tx = {
    id: '1636700041413599290', type: 'ORDER', order_id: '583000000000000001', order_create_time: Date.parse('2026-09-25T04:00:00Z') / 1000,
    settlement_amount: '100.00', revenue_amount: '130.50', shipping_cost_amount: '-5.00', fee_tax_amount: '-25.50',
    revenue_breakdown: { subtotal_before_discount_amount: '145.00', seller_discount_amount: '-14.50' },
    shipping_cost_breakdown: { actual_shipping_fee_amount: '-8.00', customer_paid_shipping_fee_amount: '5.00', failed_delivery_subsidy_amount: '-2.00', supplementary_component: { platform_shipping_fee_discount_amount: '-1' } },
    fee_tax_breakdown: { fee: { platform_commission_amount: '-15.00', transaction_fee_amount: '-5.50', affiliate_commission_amount: '0' }, tax: { sst_amount: '-5.00' } },
    supplementary_component: { customer_payment_amount: '135.50' },
  }

  it('maps an order settlement onto the Excel settlement columns', () => {
    const s = mapStatementTransaction('7238804564097517339', statementTime, 'MYR', tx)!
    expect(s.dedupeKey).toBe('api|7238804564097517339|1636700041413599290')
    expect(s.settledDate).toBe('2026-10-01')
    expect(s.row).toMatchObject({
      record_id: '583000000000000001', transaction_type: 'Order', related_order_id: '583000000000000001',
      order_created_date: '2026-09-25', currency: 'MYR', total_settlement_amount: '100.00', total_revenue: '130.50',
      total_fees: '-30.50', subtotal_before_discounts: '145.00', seller_discounts: '-14.50', customer_payment: '135.50',
    })
    expect(s.row.fee_breakdown).toEqual({
      actual_shipping_fee: -8, customer_shipping_fee: 5, other_shipping_cost: -2, seller_shipping_fee: -5,
      tiktok_shop_commission_fee: -15, transaction_fee: -5.5, sst: -5,
    })
  })

  it('uses the adjustment ID and amount for adjustments', () => {
    const s = mapStatementTransaction('1', statementTime, 'MYR', { id: '9', type: 'GMV_PAYMENT_FOR_ADS', adjustment_id: '7238804564097517332', adjustment_amount: '-50.00' })!
    expect(s.row).toMatchObject({ record_id: '7238804564097517332', transaction_type: 'GMV payment for TikTok Ads', total_settlement_amount: '-50.00' })
  })
})

describe('mapWithdrawal', () => {
  it('maps types and statuses to the export wording', () => {
    const p = mapWithdrawal({ id: '7425000000000000001', type: 'WITHDRAW', amount: '-1200.5', status: 'SUCCESS', create_time: Date.parse('2026-10-01T16:30:00Z') / 1000 })!
    expect(p).toEqual({
      referenceId: '7425000000000000001',
      transactionType: 'Withdrawal',
      row: { reference_id: '7425000000000000001', transaction_type: 'Withdrawal', request_date: '2026-10-02', amount: '-1200.50', status: 'Transferred' },
    })
    expect(mapWithdrawal({ id: '7425000000000000002', type: 'SETTLE', amount: '80', status: 'PROCESSING', create_time: 1790000000 })!.transactionType).toBe('Earnings')
    expect(mapWithdrawal({ id: '' })).toBeNull()
  })

  it('shows withdrawals as money out even when the API amount is positive', () => {
    expect(mapWithdrawal({ id: '3683478646751987069', type: 'WITHDRAW', amount: '24761.2', status: 'SUCCESS', create_time: 1790000000 })!.row.amount).toBe('-24761.20')
    expect(mapWithdrawal({ id: '3683478646751987070', type: 'SETTLE', amount: '342.83', status: 'SUCCESS', create_time: 1790000000 })!.row.amount).toBe('342.83')
  })
})

describe('claimSyncRun', () => {
  const fakeDb = (current: any, updated = [{ shop_id: 's1' }]) => {
    const calls: any[] = []
    const builder: any = {}
    for (const m of ['select', 'eq', 'is', 'update', 'or']) builder[m] = vi.fn((...args: any[]) => { calls.push([m, ...args]); return builder })
    builder.maybeSingle = vi.fn(async () => ({ data: current, error: null }))
    builder.then = (resolve: any) => resolve({ data: updated, error: null })
    return { db: { from: () => builder }, calls }
  }
  const now = Date.parse('2026-10-06T06:30:00Z')

  it('claims an idle shop with plain filters on the values it read', async () => {
    const { db, calls } = fakeDb({ last_sync_status: null, sync_started_at: null })
    expect(await claimSyncRun(db, 's1', now)).toBe(true)
    expect(calls).toContainEqual(['update', { last_sync_status: 'running', sync_started_at: '2026-10-06T06:30:00.000Z' }])
    expect(calls).toContainEqual(['is', 'last_sync_status', null])
    expect(calls).toContainEqual(['is', 'sync_started_at', null])
    expect(calls.some((c) => c[0] === 'or')).toBe(false)
  })

  it('refuses while a recent run is active and takes over a stale one', async () => {
    const recent = fakeDb({ last_sync_status: 'running', sync_started_at: '2026-10-06T06:25:00+00:00' })
    expect(await claimSyncRun(recent.db, 's1', now)).toBe(false)
    expect(recent.calls.some((c) => c[0] === 'update')).toBe(false)

    const stale = fakeDb({ last_sync_status: 'running', sync_started_at: '2026-10-06T06:00:00+00:00' })
    expect(await claimSyncRun(stale.db, 's1', now)).toBe(true)
    expect(stale.calls).toContainEqual(['eq', 'sync_started_at', '2026-10-06T06:00:00+00:00'])
  })

  it('returns false when another run won the swap', async () => {
    const { db } = fakeDb({ last_sync_status: 'ok', sync_started_at: '2026-10-06T05:00:00+00:00' }, [])
    expect(await claimSyncRun(db, 's1', now)).toBe(false)
  })
})
