import { NextResponse } from 'next/server'
import { loadMarketplaceContext } from '@/lib/marketplace/access'
import { API_OTHER_SHIPPING, isTikTokShopApiConfigured } from '@/lib/marketplace/tiktok-api'

/**
 * GET  /api/ecommerce/tiktok-shop?shop_id=…&month=YYYY-MM — shops, imports, month summary, rows and API connection
 * POST /api/ecommerce/tiktok-shop — { action: 'add_shop', shop_name } | { action: 'disconnect', shop_id }
 */

const PAGE = 1000
const LIST_LIMIT = 500

/** Parts of "Seller shipping fee" (it is their subtotal) and informational columns that are not fees. */
const SHIPPING_FEE_PARTS = new Set([
  'actual_shipping_fee', 'international_leg_delivery_fee', 'platform_shipping_fee_discount', 'customer_shipping_fee',
  'actual_return_shipping_fee', 'refunded_customer_shipping_fee', 'shipping_subsidy', 'guarantee_program_reimbursement',
  API_OTHER_SHIPPING,
])
const NOT_FEES = new Set([
  'refund_subtotal_before_seller_discounts', 'refund_of_seller_discounts', 'seller_co_funded_voucher_discount',
  'seller_co_funded_voucher_discount_refund', 'platform_discount', 'platform_discount_refund',
  'platform_co_funded_voucher_discount', 'platform_co_funded_voucher_discount_refund', 'seller_shipping_fee_discount',
  'reserve_amount',
])

const CONNECTION_STATUS_COLUMNS =
  'external_shop_name, external_shop_code, seller_name, data_from, authorized_at, access_token_expires_at, refresh_token_expires_at, last_sync_at, last_sync_status, last_sync_error'

const isCancelled = (status: unknown) => /^cancel/i.test(String(status || ''))
const num = (v: unknown) => Number(v) || 0
const round2 = (v: number) => Math.round(v * 100) / 100

function monthRange(month: string) {
  const [y, m] = month.split('-').map(Number)
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
  return { start: `${month}-01`, end: `${next}-01` }
}

async function fetchAll(build: (from: number, to: number) => any) {
  const rows: any[] = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await build(offset, offset + PAGE - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

export async function GET(request: Request) {
  try {
    const ctx = await loadMarketplaceContext()
    if (ctx.error) return ctx.error
    const { db, orgId } = ctx

    const { data: shops, error: shopsError } = await db
      .from('marketplace_shops')
      .select('id, platform, shop_name, is_active, created_at')
      .eq('company_id', orgId)
      .eq('platform', 'tiktok_shop')
      .order('shop_name')
    if (shopsError) return NextResponse.json({ error: shopsError.message }, { status: 500 })

    const { searchParams } = new URL(request.url)
    const shopId = searchParams.get('shop_id')
    if (!shopId) return NextResponse.json({ shops: shops || [] })
    if (!(shops || []).some((s: any) => s.id === shopId)) return NextResponse.json({ error: 'Shop not found' }, { status: 404 })

    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(searchParams.get('month') || '')
      ? (searchParams.get('month') as string)
      : new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7)
    const { start, end } = monthRange(month)

    const [connection, imports, lines, settlements, payouts] = await Promise.all([
      db.from('marketplace_shop_connections').select(CONNECTION_STATUS_COLUMNS).eq('company_id', orgId).eq('shop_id', shopId).maybeSingle(),
      db.from('marketplace_imports')
        .select('id, source, file_kind, file_name, period_start, period_end, rows_in_file, rows_inserted, rows_updated, rows_unchanged, status, imported_at')
        .eq('company_id', orgId).eq('shop_id', shopId)
        .order('imported_at', { ascending: false }).limit(50),
      fetchAll((from, to) => db.from('marketplace_order_lines')
        .select('id, order_id, sku_id, seller_sku, product_name, variation, order_status, quantity, return_quantity, subtotal_after_discount, order_amount, order_refund_amount, created_time, delivered_time, order_channel, payment_method, buyer_state')
        .eq('company_id', orgId).eq('shop_id', shopId)
        .gte('created_time', `${start}T00:00:00+08:00`).lt('created_time', `${end}T00:00:00+08:00`)
        .order('created_time', { ascending: false }).order('id').range(from, to)),
      fetchAll((from, to) => db.from('marketplace_settlements')
        .select('id, record_id, transaction_type, related_order_id, order_created_date, settled_date, total_settlement_amount, total_revenue, total_fees, fee_breakdown')
        .eq('company_id', orgId).eq('shop_id', shopId)
        .gte('settled_date', start).lt('settled_date', end)
        .order('settled_date', { ascending: false }).order('id').range(from, to)),
      fetchAll((from, to) => db.from('marketplace_payouts')
        .select('id, reference_id, transaction_type, request_date, amount, status, success_date')
        .eq('company_id', orgId).eq('shop_id', shopId)
        .gte('request_date', start).lt('request_date', end)
        .order('request_date', { ascending: false }).order('id').range(from, to)),
    ])
    if (imports.error) return NextResponse.json({ error: imports.error.message }, { status: 500 })

    const sold = lines.filter(l => !isCancelled(l.order_status))
    const skus = new Map<string, { seller_sku: string; product_name: string; units: number; sales: number }>()
    for (const l of sold) {
      const key = l.seller_sku || l.product_name || l.sku_id
      const entry = skus.get(key) || { seller_sku: l.seller_sku || '', product_name: l.product_name || '', units: 0, sales: 0 }
      entry.units += num(l.quantity)
      entry.sales += num(l.subtotal_after_discount)
      skus.set(key, entry)
    }
    const fees: Record<string, number> = {}
    for (const s of settlements) {
      for (const [k, v] of Object.entries(s.fee_breakdown || {})) fees[k] = round2((fees[k] || 0) + num(v))
    }

    const summary = {
      month,
      orders: new Set(lines.map(l => l.order_id)).size,
      cancelled_orders: new Set(lines.filter(l => isCancelled(l.order_status)).map(l => l.order_id)).size,
      units_sold: sold.reduce((s, l) => s + num(l.quantity), 0),
      gross_sales: round2(sold.reduce((s, l) => s + num(l.subtotal_after_discount), 0)),
      settlement_rows: settlements.length,
      settled_revenue: round2(settlements.reduce((s, r) => s + num(r.total_revenue), 0)),
      settled_fees: round2(settlements.reduce((s, r) => s + num(r.total_fees), 0)),
      settlement_amount: round2(settlements.reduce((s, r) => s + num(r.total_settlement_amount), 0)),
      withdrawn: round2(payouts.filter(p => /withdraw/i.test(p.transaction_type)).reduce((s, p) => s + Math.abs(num(p.amount)), 0)),
      fee_breakdown: Object.entries(fees)
        .filter(([name]) => !NOT_FEES.has(name) && !SHIPPING_FEE_PARTS.has(name))
        .sort((a, b) => a[1] - b[1])
        .map(([name, amount]) => ({ name, amount })),
      shipping_fee_parts: Object.entries(fees)
        .filter(([name]) => SHIPPING_FEE_PARTS.has(name))
        .sort((a, b) => a[1] - b[1])
        .map(([name, amount]) => ({ name, amount })),
      top_skus: [...skus.values()].map(s => ({ ...s, sales: round2(s.sales) })).sort((a, b) => b.sales - a.sales).slice(0, 10),
    }

    return NextResponse.json({
      shops: shops || [],
      api_configured: isTikTokShopApiConfigured(),
      connection: connection.error ? null : connection.data,
      imports: imports.data || [],
      summary,
      order_lines: lines.slice(0, LIST_LIMIT),
      settlements: settlements.slice(0, LIST_LIMIT).map(({ fee_breakdown: _f, ...s }) => s),
      payouts: payouts.slice(0, LIST_LIMIT),
      totals: { order_lines: lines.length, settlements: settlements.length, payouts: payouts.length },
    })
  } catch (error) {
    console.error('Error in TikTok Shop API:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await loadMarketplaceContext()
    if (ctx.error) return ctx.error
    const { db, orgId, userId } = ctx

    const body = await request.json().catch(() => null)
    if (body?.action === 'disconnect') {
      const { data, error } = await db.from('marketplace_shop_connections').delete()
        .eq('company_id', orgId).eq('shop_id', typeof body.shop_id === 'string' ? body.shop_id : '').select('shop_id')
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      if (!data?.length) return NextResponse.json({ error: 'This shop is not connected to TikTok.' }, { status: 404 })
      return NextResponse.json({ disconnected: true })
    }
    if (body?.action !== 'add_shop') return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    const shopName = typeof body.shop_name === 'string' ? body.shop_name.replace(/\s+/g, ' ').trim() : ''
    if (!shopName || shopName.length > 120) return NextResponse.json({ error: 'Shop name is required (max 120 characters)' }, { status: 400 })

    const { data, error } = await db
      .from('marketplace_shops')
      .insert({ company_id: orgId, platform: 'tiktok_shop', shop_name: shopName, created_by: userId })
      .select('id, platform, shop_name, is_active, created_at')
      .single()
    if (error) {
      if (error.code === '23505') return NextResponse.json({ error: 'A shop with this name already exists' }, { status: 409 })
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ shop: data }, { status: 201 })
  } catch (error) {
    console.error('Error adding TikTok shop:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
