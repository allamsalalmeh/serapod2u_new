import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireOutdoorStaff } from '@/lib/outdoor/staff'
import { listOutdoorProducts } from '@/lib/outdoor/catalog'
import { loadOutdoorBundles, loadOutdoorCheckoutSettings } from '@/lib/outdoor/sales-tools-server'
import { normalizeAffiliateCode, summarizeAffiliateOrders } from '@/lib/outdoor/sales-tools'
import { startOfMonthMyt } from '@/lib/outdoor/desk-server'

export const dynamic = 'force-dynamic'

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

function money(raw: unknown, { allowNull = false } = {}): number | null | undefined {
  if (raw === null || raw === undefined || String(raw).trim() === '') return allowNull ? null : undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 100000) return undefined
  return Math.round(value * 100) / 100
}

function percent(raw: unknown): number | undefined {
  const value = Number(raw)
  if (raw === null || raw === undefined || String(raw).trim() === '' || !Number.isFinite(value) || value < 0 || value > 100) return undefined
  return Math.round(value * 100) / 100
}

function text(raw: unknown, max: number) {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : ''
}

function isoOr(raw: string | null, fallback: string) {
  if (!raw) return fallback
  const at = Date.parse(raw)
  return Number.isFinite(at) ? new Date(at).toISOString() : fallback
}

async function loadVariants(admin: any) {
  const { products } = await listOutdoorProducts({ sort: 'name_asc', limit: 200, includeUnpriced: true })
  if (products.length === 0) return []
  const names = new Map(products.map((p) => [p.id, p.product_name]))
  const { data } = await admin
    .from('product_variants')
    .select('id, product_id, variant_name, suggested_retail_price')
    .in('product_id', products.map((p) => p.id))
    .eq('is_active', true)
  return (data || [])
    .map((v: any) => ({
      id: String(v.id),
      productId: String(v.product_id),
      label: [names.get(String(v.product_id)), v.variant_name].filter(Boolean).join(' · '),
      retailPrice: v.suggested_retail_price == null ? null : Number(v.suggested_retail_price),
    }))
    .sort((a: any, b: any) => a.label.localeCompare(b.label))
}

async function loadAffiliates(admin: any) {
  const { data, error } = await admin
    .from('outdoor_affiliates')
    .select('id, code, name, kind, commission_percent, is_active, notes, created_at')
    .order('created_at', { ascending: true })
  if (error) return []
  return (data || []).map((a: any) => ({
    id: String(a.id),
    code: String(a.code),
    name: String(a.name),
    kind: a.kind === 'affiliate' ? 'affiliate' : 'host',
    commissionPercent: Number(a.commission_percent) || 0,
    isActive: a.is_active !== false,
    notes: a.notes || '',
  }))
}

async function loadReport(admin: any, from: string, to: string, affiliates: Array<{ id: string; commissionPercent: number }>) {
  const { data, error } = await admin
    .from('storefront_orders')
    .select('order_ref, affiliate_id, total_amount, shipping_amount, status, created_at')
    .eq('sales_channel', 'outdoor')
    .not('affiliate_id', 'is', null)
    .gte('created_at', from)
    .lt('created_at', to)
    .order('created_at', { ascending: false })
    .limit(5000)
  if (error) return { from, to, rows: [], orders: [] }
  const orders = data || []
  const rows = summarizeAffiliateOrders(orders, new Map(affiliates.map((a) => [a.id, a.commissionPercent])))
  return {
    from,
    to,
    rows,
    orders: orders.map((o: any) => ({
      orderRef: o.order_ref,
      affiliateId: o.affiliate_id,
      status: o.status,
      createdAt: o.created_at,
      goods: Math.max(0, Math.round(((Number(o.total_amount) || 0) - (Number(o.shipping_amount) || 0)) * 100) / 100),
    })),
  }
}

/** GET — settings, combos, affiliates, the variants staff can pick, and the affiliate report for from/to. */
export async function GET(request: NextRequest) {
  try {
    const staff = await requireOutdoorStaff()
    if (!staff) return bad('Unauthorized', 401)
    const admin: any = createAdminClient()
    const params = request.nextUrl.searchParams
    const from = isoOr(params.get('from'), startOfMonthMyt())
    const to = isoOr(params.get('to'), new Date(Date.now() + 60_000).toISOString())
    const [settings, bundles, affiliates, variants] = await Promise.all([
      loadOutdoorCheckoutSettings(admin),
      loadOutdoorBundles(admin, { includeInactive: true }),
      loadAffiliates(admin),
      loadVariants(admin),
    ])
    const report = await loadReport(admin, from, to, affiliates)
    return NextResponse.json({ settings, bundles, affiliates, variants, report })
  } catch (err) {
    console.error('[outdoor/sales-tools GET]', err)
    return bad('Could not load sales tools.', 500)
  }
}

/** POST { action: save_settings | save_bundle | save_affiliate, ... } */
export async function POST(request: NextRequest) {
  try {
    const staff = await requireOutdoorStaff()
    if (!staff) return bad('Unauthorized', 401)
    const admin: any = createAdminClient()
    const body = await request.json().catch(() => ({}))
    const now = new Date().toISOString()

    if (body?.action === 'save_settings') {
      const share = percent(body.shippingCustomerSharePercent)
      if (share === undefined) return bad('Customer delivery share must be 0 to 100%.')
      const price = money(body.orderBumpPrice, { allowNull: true })
      const compare = money(body.orderBumpComparePrice, { allowNull: true })
      if (price === undefined || compare === undefined) return bad('Offer prices must be 0 or more.')
      const enabled = body.orderBumpEnabled === true
      const variantId = text(body.orderBumpVariantId, 64) || null
      if (enabled && (!variantId || price === null)) return bad('Choose the offer product and its price before switching the offer on.')
      const { error } = await admin.from('outdoor_checkout_settings').upsert({
        id: 1,
        shipping_customer_share_percent: share,
        order_bump_enabled: enabled,
        order_bump_variant_id: variantId,
        order_bump_price: price,
        order_bump_compare_price: compare,
        order_bump_text: text(body.orderBumpText, 200) || null,
        updated_at: now,
        updated_by: staff.userId,
      })
      if (error) return bad(error.message, 500)
      return NextResponse.json({ ok: true })
    }

    if (body?.action === 'save_bundle') {
      const name = text(body.name, 120)
      const price = money(body.price)
      if (!name) return bad('Give the combo a name.')
      if (price === undefined || price === null || price <= 0) return bad('Combo price must be more than 0.')
      const items: Array<{ variantId: string; quantity: number }> = (Array.isArray(body.items) ? body.items : [])
        .map((item: any) => ({ variantId: text(item?.variantId, 64), quantity: Math.floor(Number(item?.quantity) || 0) }))
        .filter((item: any) => item.variantId)
      if (items.length < 2) return bad('A combo needs at least two items.')
      if (items.some((item) => item.quantity < 1 || item.quantity > 99)) return bad('Each item quantity must be 1 to 99.')
      if (new Set(items.map((item) => item.variantId)).size !== items.length) return bad('Each item can be listed once; raise its quantity instead.')

      const row = {
        name,
        description: text(body.description, 500) || null,
        price,
        image_url: text(body.imageUrl, 500) || null,
        is_active: body.isActive !== false,
        sort_order: Math.floor(Number(body.sortOrder) || 0),
        updated_at: now,
      }
      let bundleId = text(body.id, 64)
      if (bundleId) {
        const { error } = await admin.from('outdoor_bundles').update(row).eq('id', bundleId)
        if (error) return bad(error.message, 500)
      } else {
        const { data, error } = await admin.from('outdoor_bundles').insert(row).select('id').single()
        if (error || !data) return bad(error?.message || 'Could not save the combo.', 500)
        bundleId = String(data.id)
      }
      const { error: clearErr } = await admin.from('outdoor_bundle_items').delete().eq('bundle_id', bundleId)
      if (clearErr) return bad(clearErr.message, 500)
      const { error: itemsErr } = await admin
        .from('outdoor_bundle_items')
        .insert(items.map((item) => ({ bundle_id: bundleId, variant_id: item.variantId, quantity: item.quantity })))
      if (itemsErr) return bad(itemsErr.message, 500)
      return NextResponse.json({ ok: true, id: bundleId })
    }

    if (body?.action === 'save_affiliate') {
      const code = normalizeAffiliateCode(body.code)
      const name = text(body.name, 120)
      const commission = percent(body.commissionPercent ?? 0)
      if (!code) return bad('Code must be 3 to 32 letters, numbers, - or _.')
      if (!name) return bad('Enter the host or affiliate name.')
      if (commission === undefined) return bad('Commission must be 0 to 100%.')
      const row = {
        code,
        name,
        kind: body.kind === 'affiliate' ? 'affiliate' : 'host',
        commission_percent: commission,
        is_active: body.isActive !== false,
        notes: text(body.notes, 500) || null,
        updated_at: now,
      }
      const id = text(body.id, 64)
      const { error } = id
        ? await admin.from('outdoor_affiliates').update(row).eq('id', id)
        : await admin.from('outdoor_affiliates').insert(row)
      if (error) return bad(/duplicate|unique/i.test(error.message || '') ? 'That code is already used.' : error.message, error.code === '23505' ? 409 : 500)
      return NextResponse.json({ ok: true })
    }

    return bad('Unknown action.')
  } catch (err) {
    console.error('[outdoor/sales-tools POST]', err)
    return bad('Could not save.', 500)
  }
}
