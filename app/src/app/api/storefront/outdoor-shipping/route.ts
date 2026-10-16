import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolveOutdoorShipping } from '@/lib/outdoor/shipping-server'
import { pickOutdoorShipping } from '@/lib/outdoor/shipping'
import { bundleIdFromCartId, isBundleCartId } from '@/lib/outdoor/sales-tools'
import { loadOrderBumpOffer, loadOutdoorBundles, loadOutdoorCheckoutSettings } from '@/lib/outdoor/sales-tools-server'

/** POST /api/storefront/outdoor-shipping — the delivery line the Outdoor checkout will charge. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const items: Array<{ variantId?: string; quantity?: number }> = Array.isArray(body?.items) ? body.items.slice(0, 50) : []
    const quantityOf = (item: { quantity?: number }) => Math.max(0, Math.floor(Number(item?.quantity) || 0))
    const bundleItems = items.filter((item) => isBundleCartId(String(item?.variantId || '')))
    const plainItems = items.filter((item) => !isBundleCartId(String(item?.variantId || '')))
    const variantIds = [...new Set(plainItems.map((item) => String(item?.variantId || '')).filter(Boolean))]
    if (variantIds.length === 0 && bundleItems.length === 0) {
      return NextResponse.json({ shipping: pickOutdoorShipping([], 0) })
    }

    const supabase: any = createAdminClient()
    const settings = await loadOutdoorCheckoutSettings(supabase)
    let subtotal = 0
    const productIds: string[] = []

    if (variantIds.length > 0) {
      const { data: variants, error } = await supabase
        .from('product_variants')
        .select('id, product_id, suggested_retail_price')
        .in('id', variantIds)
        .eq('is_active', true)
      if (error) {
        console.error('[outdoor-shipping] variants', error)
        return NextResponse.json({ error: 'Could not load delivery' }, { status: 500 })
      }
      const byId = new Map((variants || []).map((variant: any) => [variant.id, variant]))
      for (const item of plainItems) {
        const variant: any = byId.get(String(item?.variantId || ''))
        if (variant) subtotal += Number(variant.suggested_retail_price || 0) * quantityOf(item)
      }
      productIds.push(...(variants || []).map((variant: any) => String(variant.product_id || '')))
    }

    if (bundleItems.length > 0) {
      const bundles = await loadOutdoorBundles(supabase, {
        ids: [...new Set(bundleItems.map((item) => bundleIdFromCartId(String(item.variantId))))],
        withStock: false,
      })
      const byId = new Map(bundles.map((bundle) => [bundle.id, bundle]))
      for (const item of bundleItems) {
        const bundle = byId.get(bundleIdFromCartId(String(item.variantId)))
        if (!bundle) continue
        subtotal += bundle.price * quantityOf(item)
        productIds.push(...bundle.components.map((c) => c.productId))
      }
    }

    if (body?.orderBump === true) {
      const offer = await loadOrderBumpOffer(supabase, settings)
      if (offer) {
        subtotal += offer.price
        productIds.push(offer.productId)
      }
    }

    const shipping = await resolveOutdoorShipping(supabase, productIds, subtotal, {
      customerSharePercent: settings.shippingCustomerSharePercent,
    })
    return NextResponse.json({ shipping })
  } catch (err) {
    console.error('[outdoor-shipping]', err)
    return NextResponse.json({ error: 'Could not load delivery' }, { status: 500 })
  }
}
