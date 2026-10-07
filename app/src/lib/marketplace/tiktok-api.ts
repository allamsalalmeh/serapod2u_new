import { createHash, createHmac } from 'node:crypto'
import { centsToAmount } from './tiktok-shop'

/**
 * TikTok Shop Open API (Partner Center custom app, Malaysia local seller).
 *
 * Request signing, token exchange and the read endpoints the sync uses, plus
 * mappers that turn API responses into rows of the existing marketplace tables
 * with the same columns as the Excel import. Customer personal data (names,
 * phone, address lines, buyer message, user id, email) is never mapped.
 */

export const TTS_API_ORIGIN = 'https://open-api.tiktokglobalshop.com'
export const TTS_AUTH_ORIGIN = 'https://auth.tiktok-shops.com'
export const TTS_AUTHORIZE_URL = 'https://services.tiktokshop.com/open/authorize'

const MY_OFFSET_MS = 8 * 3600 * 1000

export function getTikTokShopAppKey() {
  return String(process.env.TIKTOK_SHOP_APP_KEY || '').trim()
}

export function getTikTokShopAppSecret() {
  return String(process.env.TIKTOK_SHOP_APP_SECRET || '').trim()
}

export function getTikTokShopServiceId() {
  return String(process.env.TIKTOK_SHOP_SERVICE_ID || '').trim()
}

export function isTikTokShopApiConfigured() {
  return Boolean(getTikTokShopAppKey() && getTikTokShopAppSecret() && getTikTokShopServiceId())
}

export function tiktokAuthorizeUrl(state: string) {
  const url = new URL(TTS_AUTHORIZE_URL)
  url.searchParams.set('service_id', getTikTokShopServiceId())
  url.searchParams.set('state', state)
  return url.toString()
}

/** HMAC-SHA256 signature: secret + path + sorted key/value pairs (+ body) + secret. */
export function signTikTokRequest(path: string, query: Record<string, string>, body: string, secret: string) {
  const pairs = Object.keys(query)
    .filter(k => k !== 'sign' && k !== 'access_token')
    .sort()
    .map(k => `${k}${query[k]}`)
    .join('')
  const base = `${secret}${path}${pairs}${body}${secret}`
  return createHmac('sha256', secret).update(base).digest('hex')
}

export class TikTokApiError extends Error {
  constructor(message: string, readonly code: number | null, readonly status: number) {
    super(message)
  }
}

type Fetch = typeof fetch

export interface TikTokCallOptions {
  path: string
  method?: 'GET' | 'POST'
  accessToken: string
  shopCipher?: string
  query?: Record<string, string | number | undefined>
  body?: unknown
  fetchImpl?: Fetch
  now?: () => number
}

export async function callTikTokApi<T = any>(opts: TikTokCallOptions): Promise<T> {
  const appKey = getTikTokShopAppKey()
  const secret = getTikTokShopAppSecret()
  const query: Record<string, string> = { app_key: appKey, timestamp: String(Math.floor((opts.now ?? Date.now)() / 1000)) }
  if (opts.shopCipher) query.shop_cipher = opts.shopCipher
  for (const [k, v] of Object.entries(opts.query || {})) if (v !== undefined && v !== '') query[k] = String(v)
  const body = opts.body === undefined ? '' : JSON.stringify(opts.body)
  query.sign = signTikTokRequest(opts.path, query, body, secret)

  const url = `${TTS_API_ORIGIN}${opts.path}?${new URLSearchParams(query).toString()}`
  const res = await (opts.fetchImpl ?? fetch)(url, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', 'x-tts-access-token': opts.accessToken },
    body: body || undefined,
    signal: AbortSignal.timeout(30_000),
  })
  const json: any = await res.json().catch(() => null)
  if (!res.ok || !json || json.code !== 0) {
    throw new TikTokApiError(String(json?.message || `TikTok Shop API HTTP ${res.status}`), typeof json?.code === 'number' ? json.code : null, res.status)
  }
  return json.data as T
}

export interface TikTokTokenSet {
  accessToken: string
  accessTokenExpiresAt: string
  refreshToken: string
  refreshTokenExpiresAt: string | null
  openId: string
  sellerName: string | null
  sellerBaseRegion: string | null
  userType: number | null
  grantedScopes: string[]
}

const unixToIso = (value: unknown) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null
}

async function tokenRequest(path: string, params: Record<string, string>, fetchImpl?: Fetch): Promise<TikTokTokenSet> {
  const url = `${TTS_AUTH_ORIGIN}${path}?${new URLSearchParams({ app_key: getTikTokShopAppKey(), app_secret: getTikTokShopAppSecret(), ...params })}`
  const res = await (fetchImpl ?? fetch)(url, { method: 'GET', signal: AbortSignal.timeout(30_000) })
  const json: any = await res.json().catch(() => null)
  const d = json?.data
  if (!res.ok || !json || json.code !== 0 || !d?.access_token) {
    throw new TikTokApiError(String(json?.message || `TikTok Shop token HTTP ${res.status}`), typeof json?.code === 'number' ? json.code : null, res.status)
  }
  return {
    accessToken: String(d.access_token),
    accessTokenExpiresAt: unixToIso(d.access_token_expire_in) ?? new Date(Date.now() + 6 * 86400_000).toISOString(),
    refreshToken: String(d.refresh_token || ''),
    refreshTokenExpiresAt: unixToIso(d.refresh_token_expire_in),
    openId: String(d.open_id || ''),
    sellerName: d.seller_name ? String(d.seller_name) : null,
    sellerBaseRegion: d.seller_base_region ? String(d.seller_base_region) : null,
    userType: typeof d.user_type === 'number' ? d.user_type : null,
    grantedScopes: Array.isArray(d.granted_scopes) ? d.granted_scopes.map(String) : [],
  }
}

export function exchangeTikTokAuthCode(authCode: string, fetchImpl?: Fetch) {
  return tokenRequest('/api/v2/token/get', { auth_code: authCode, grant_type: 'authorized_code' }, fetchImpl)
}

export function refreshTikTokToken(refreshToken: string, fetchImpl?: Fetch) {
  return tokenRequest('/api/v2/token/refresh', { refresh_token: refreshToken, grant_type: 'refresh_token' }, fetchImpl)
}

export interface TikTokAuthorizedShop {
  id: string
  name: string
  region: string
  sellerType: string
  cipher: string
  code: string
}

export async function getAuthorizedShops(accessToken: string, fetchImpl?: Fetch): Promise<TikTokAuthorizedShop[]> {
  const data = await callTikTokApi<{ shops?: any[] }>({ path: '/authorization/202309/shops', accessToken, fetchImpl })
  return (data?.shops || []).map(s => ({
    id: String(s.id || ''),
    name: String(s.name || ''),
    region: String(s.region || ''),
    sellerType: String(s.seller_type || ''),
    cipher: String(s.cipher || ''),
    code: String(s.code || ''),
  }))
}

export function searchOrders(accessToken: string, shopCipher: string, params: { updateTimeGe: number; pageToken?: string }, fetchImpl?: Fetch) {
  return callTikTokApi<{ orders?: any[]; next_page_token?: string; total_count?: number }>({
    path: '/order/202309/orders/search',
    method: 'POST',
    accessToken,
    shopCipher,
    query: { page_size: 100, sort_field: 'update_time', sort_order: 'ASC', page_token: params.pageToken },
    body: { update_time_ge: params.updateTimeGe },
    fetchImpl,
  })
}

export function getStatements(accessToken: string, shopCipher: string, params: { statementTimeGe: number; pageToken?: string }, fetchImpl?: Fetch) {
  return callTikTokApi<{ statements?: any[]; next_page_token?: string }>({
    path: '/finance/202309/statements',
    accessToken,
    shopCipher,
    query: { page_size: 100, sort_field: 'statement_time', sort_order: 'ASC', statement_time_ge: params.statementTimeGe, page_token: params.pageToken },
    fetchImpl,
  })
}

export function getStatementTransactions(accessToken: string, shopCipher: string, statementId: string, pageToken?: string, fetchImpl?: Fetch) {
  if (!/^\d{1,30}$/.test(statementId)) throw new TikTokApiError(`Invalid statement ID "${statementId.slice(0, 40)}"`, null, 0)
  return callTikTokApi<{ transactions?: any[]; next_page_token?: string; create_time?: number; currency?: string }>({
    path: `/finance/202501/statements/${statementId}/statement_transactions`,
    accessToken,
    shopCipher,
    query: { page_size: 100, sort_field: 'order_create_time', sort_order: 'ASC', page_token: pageToken },
    fetchImpl,
  })
}

export function getWithdrawals(accessToken: string, shopCipher: string, params: { createTimeGe: number; pageToken?: string }, fetchImpl?: Fetch) {
  return callTikTokApi<{ withdrawals?: any[]; next_page_token?: string }>({
    path: '/finance/202309/withdrawals',
    accessToken,
    shopCipher,
    query: { page_size: 100, types: 'WITHDRAW,SETTLE,TRANSFER,REVERSE', create_time_ge: params.createTimeGe, page_token: params.pageToken },
    fetchImpl,
  })
}

// ── Mappers ───────────────────────────────────────────────────────────

/** Unix seconds → Malaysia calendar date (YYYY-MM-DD). */
export function unixToMyDate(value: unknown): string | null {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n * 1000 + MY_OFFSET_MS).toISOString().slice(0, 10)
}

/** Malaysia midnight of a YYYY-MM-DD date → unix seconds. */
export function myDateToUnix(date: string) {
  return Math.floor(Date.parse(`${date}T00:00:00+08:00`) / 1000)
}

const cents = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const n = Number(String(value).replace(/,/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) : null
}
const amount = (value: unknown) => {
  const c = cents(value)
  return c === null ? null : centsToAmount(c)
}
const text = (value: unknown) => (value === null || value === undefined || String(value).trim() === '' ? null : String(value).trim())
const humanize = (value: unknown) => {
  const v = text(value)
  if (!v) return null
  const s = v.toLowerCase().replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** API order status → the status / sub-status wording of the Seller Center orders export. */
const ORDER_STATUS: Record<string, [string, string]> = {
  UNPAID: ['Unpaid', 'Unpaid'],
  ON_HOLD: ['To ship', 'On hold'],
  AWAITING_SHIPMENT: ['To ship', 'Awaiting shipment'],
  PARTIALLY_SHIPPING: ['To ship', 'Partially shipping'],
  AWAITING_COLLECTION: ['To ship', 'Awaiting collection'],
  IN_TRANSIT: ['Shipped', 'In transit'],
  DELIVERED: ['Shipped', 'Delivered'],
  COMPLETED: ['Completed', 'Completed'],
  CANCELLED: ['Canceled', 'Canceled'],
}

export interface ApiOrderLine {
  orderId: string
  skuId: string
  contentHash: string
  updateTime: number
  row: Record<string, string | number | null>
}

/**
 * One row per order and SKU, like the Excel export (the API lists every unit
 * as its own line item). Columns the API does not provide (returns, refund
 * amount, weight, category, channel, creator, warehouse name) are left out so
 * values already imported from Excel are kept.
 */
export function mapOrderToLines(order: any): ApiOrderLine[] {
  const orderId = text(order?.id)
  if (!orderId || !/^\d{6,30}$/.test(orderId)) return []
  const [status, substatus] = ORDER_STATUS[String(order.status)] ?? [humanize(order.status), humanize(order.status)]
  const payment = order.payment || {}
  const districts: any[] = Array.isArray(order.recipient_address?.district_info) ? order.recipient_address.district_info : []
  const district = (level: string) => text(districts.find(d => d?.address_level === level)?.address_name)
  const time = (v: unknown) => unixToIso(v)

  const groups = new Map<string, any[]>()
  for (const item of Array.isArray(order.line_items) ? order.line_items : []) {
    const skuId = text(item?.sku_id) ?? ''
    if (skuId && !/^\d{1,30}$/.test(skuId)) continue
    groups.set(skuId, [...(groups.get(skuId) || []), item])
  }

  const sum = (items: any[], key: string) => {
    let total = 0
    let any = false
    for (const it of items) {
      const c = cents(it?.[key])
      if (c !== null) { total += c; any = true }
    }
    return any ? centsToAmount(total) : null
  }

  return [...groups.entries()].map(([skuId, items]) => {
    const first = items[0]
    const row: Record<string, string | number | null> = {
      order_status: status,
      order_substatus: substatus,
      seller_sku: text(first.seller_sku),
      product_name: text(first.product_name),
      variation: text(first.sku_name),
      cancel_by: humanize(order.cancellation_initiator),
      cancel_reason: text(order.cancel_reason),
      fulfillment_type: humanize(order.fulfillment_type),
      delivery_option: text(order.delivery_option_name),
      shipping_provider: text(order.shipping_provider),
      payment_method: text(order.payment_method_name),
      package_id: text(first.package_id),
      buyer_state: district('L1'),
      buyer_country: district('L0'),
      quantity: items.length,
      unit_original_price: amount(first.original_price),
      subtotal_before_discount: sum(items, 'original_price'),
      platform_discount: sum(items, 'platform_discount'),
      seller_discount: sum(items, 'seller_discount'),
      subtotal_after_discount: sum(items, 'sale_price'),
      shipping_fee_after_discount: amount(payment.shipping_fee),
      original_shipping_fee: amount(payment.original_shipping_fee),
      shipping_fee_seller_discount: amount(payment.shipping_fee_seller_discount),
      shipping_fee_platform_discount: amount(payment.shipping_fee_platform_discount),
      payment_platform_discount: amount(payment.payment_platform_discount),
      taxes: amount(payment.tax),
      order_amount: amount(payment.total_amount),
      created_time: time(order.create_time),
      paid_time: time(order.paid_time),
      rts_time: time(order.rts_time),
      shipped_time: time(order.collection_time),
      delivered_time: time(order.delivery_time),
      cancelled_time: time(order.cancel_time),
    }
    return {
      orderId,
      skuId,
      updateTime: Number(order.update_time) || 0,
      contentHash: createHash('sha256').update(JSON.stringify(row)).digest('hex'),
      row,
    }
  })
}

/** Shipping cost parts → the names used by the Excel import (route treats them as parts of seller_shipping_fee). */
const API_SHIPPING_NAMES: Record<string, string> = {
  actual_shipping_fee_amount: 'actual_shipping_fee',
  international_leg_logistics_amount: 'international_leg_delivery_fee',
  shipping_fee_discount_amount: 'platform_shipping_fee_discount',
  customer_paid_shipping_fee_amount: 'customer_shipping_fee',
  return_shipping_fee_amount: 'actual_return_shipping_fee',
}
const API_FEE_NAMES: Record<string, string> = {
  platform_commission_amount: 'tiktok_shop_commission_fee',
}
export const API_OTHER_SHIPPING = 'other_shipping_cost'

const feeName = (key: string) => API_FEE_NAMES[key] ?? key.replace(/_amount$/, '')

const TRANSACTION_TYPE: Record<string, string> = {
  ORDER: 'Order',
  RESERVE: 'Reserve',
  GMV_PAYMENT_FOR_ADS: 'GMV payment for TikTok Ads',
}

export interface ApiSettlement {
  dedupeKey: string
  recordId: string
  settledDate: string | null
  row: Record<string, unknown>
}

/** One statement transaction → one settlement row (same columns as the Excel "Order details" sheet). */
export function mapStatementTransaction(statementId: string, statementTime: number, currency: string | null, tx: any): ApiSettlement | null {
  const txId = text(tx?.id)
  if (!txId) return null
  const type = String(tx.type || '')
  const recordId = text(type === 'ORDER' ? tx.order_id : type === 'RESERVE' ? tx.reserve_id : tx.adjustment_id) ?? txId
  const fees: Record<string, number> = {}
  const add = (name: string, value: unknown) => {
    const c = cents(value)
    if (c) fees[name] = Math.round(((fees[name] ?? 0) * 100 + c)) / 100
  }

  const shipping = tx.shipping_cost_breakdown || {}
  for (const [key, value] of Object.entries(shipping)) {
    if (key === 'supplementary_component' || (value !== null && typeof value === 'object')) continue
    add(API_SHIPPING_NAMES[key] ?? API_OTHER_SHIPPING, value)
  }
  if (cents(tx.shipping_cost_amount)) add('seller_shipping_fee', tx.shipping_cost_amount)
  for (const group of ['fee', 'tax']) {
    for (const [key, value] of Object.entries(tx.fee_tax_breakdown?.[group] || {})) {
      if (value !== null && typeof value === 'object') continue
      add(feeName(key), value)
    }
  }
  if (type === 'RESERVE') add('reserve_amount', tx.reserve_amount)

  const shippingCents = cents(tx.shipping_cost_amount)
  const feeTaxCents = cents(tx.fee_tax_amount)
  const totalFees = shippingCents === null && feeTaxCents === null ? null : centsToAmount((shippingCents ?? 0) + (feeTaxCents ?? 0))
  const settlement = cents(tx.settlement_amount) ?? cents(tx.adjustment_amount) ?? 0
  const revenue = tx.revenue_breakdown || {}
  const supplementary = tx.supplementary_component || {}

  return {
    dedupeKey: `api|${statementId}|${txId}`,
    recordId,
    settledDate: unixToMyDate(statementTime),
    row: {
      record_id: recordId,
      transaction_type: TRANSACTION_TYPE[type] ?? humanize(type) ?? 'Other',
      related_order_id: text(tx.order_id) ?? text(tx.adjustment_order_id) ?? text(tx.associated_order_id),
      order_created_date: unixToMyDate(tx.order_create_time),
      settled_date: unixToMyDate(statementTime),
      currency,
      total_settlement_amount: centsToAmount(settlement),
      total_revenue: amount(tx.revenue_amount),
      total_fees: totalFees,
      subtotal_before_discounts: amount(revenue.subtotal_before_discount_amount),
      seller_discounts: amount(revenue.seller_discount_amount),
      customer_payment: amount(supplementary.customer_payment_amount),
      customer_refund: amount(supplementary.customer_refund_amount),
      adjustment_amount: amount(tx.adjustment_amount),
      fee_breakdown: fees,
    },
  }
}

const PAYOUT_TYPE: Record<string, string> = { SETTLE: 'Earnings', WITHDRAW: 'Withdrawal', TRANSFER: 'Transfer', REVERSE: 'Reverse' }
const PAYOUT_STATUS: Record<string, string> = { SUCCESS: 'Transferred', PROCESSING: 'Processing', FAILED: 'Failed' }

export interface ApiPayout {
  referenceId: string
  transactionType: string
  row: Record<string, string | null>
}

/** One withdrawal record → one payout row (same wording as the Excel "Withdrawal records" sheet). */
export function mapWithdrawal(w: any): ApiPayout | null {
  const referenceId = text(w?.id)
  if (!referenceId || !/^[A-Za-z0-9_-]{4,64}$/.test(referenceId)) return null
  const transactionType = PAYOUT_TYPE[String(w.type)] ?? humanize(w.type) ?? 'Other'
  const raw = cents(w.amount)
  // The API reports withdrawals as positive; the Excel export (and the ledger) shows them as money out.
  const value = raw === null ? 0 : String(w.type) === 'WITHDRAW' ? -Math.abs(raw) : raw
  return {
    referenceId,
    transactionType,
    row: {
      reference_id: referenceId,
      transaction_type: transactionType,
      request_date: unixToMyDate(w.create_time),
      amount: centsToAmount(value),
      status: PAYOUT_STATUS[String(w.status)] ?? humanize(w.status),
    },
  }
}
