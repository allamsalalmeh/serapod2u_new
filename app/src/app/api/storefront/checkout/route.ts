import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { createPaymentIntent } from '@/lib/payments'
import { MIN_ORDER_TOTAL, customerPaymentError, isSellablePrice } from '@/lib/storefront/price-rules'
import { normalizeMalaysianPhone, validateCheckoutCustomer } from '@/lib/storefront/customer-validation'
import { publicOriginFromRequest } from '@/lib/http/public-origin'
import { resolveOutdoorShipping } from '@/lib/outdoor/shipping-server'
import { easyParcelRateCheck, isEasyParcelBookingEnabled, isEasyParcelConfigured } from '@/lib/shipping/easyparcel'
import { toEasyParcelState } from '@/lib/shipping/malaysia-states'
import { recordOrderEvent } from '@/lib/storefront/order-events'
import { sellableStock, stockShortfall } from '@/lib/storefront/order-stock'
import { allocateBundlePrice, bundleIdFromCartId, isBundleCartId } from '@/lib/outdoor/sales-tools'
import {
  loadOrderBumpOffer,
  loadOutdoorBundles,
  loadOutdoorCheckoutSettings,
  resolveOutdoorAffiliate,
} from '@/lib/outdoor/sales-tools-server'

// NOTE: storefront_orders / storefront_order_items are not in the
// auto-generated database types yet. After running STOREFRONT_MIGRATION.sql
// and regenerating types (`npx supabase gen types`) the `as any` casts
// can be removed.

// ── Types ─────────────────────────────────────────────────────────

interface CheckoutBody {
  customer: {
    name: string
    email: string
    phone: string
    addressLine1: string
    addressLine2?: string
    city: string
    state: string
    postcode: string
  }
  items: {
    variantId: string
    quantity: number
  }[]
  /** Optional success-path base. Default `/store` keeps existing storefront behaviour. */
  returnBasePath?: string
  /** store (default) | outdoor — tags the order channel without affecting /store. */
  salesChannel?: 'store' | 'outdoor'
  shipping?: {
    serviceId?: string
    courierName?: string
    amount?: number
  }
  landingPageAttribution?: {
    landingPageId?: string
    landingPageSlug?: string
    landingPageSessionId?: string
    sourceCode?: string
    utmSource?: string
    utmMedium?: string
    utmCampaign?: string
    utmContent?: string
    utmTerm?: string
    fbclid?: string
    referrerDomain?: string
  } | null
  paymentProvider?: string
  /** Outdoor: the shopper ticked the checkout offer. */
  orderBump?: boolean
  /** Outdoor: live host / affiliate code from a ?ref= link. */
  affiliateCode?: string
}

const MAX_LINE_QUANTITY = 999

async function cheapestOutdoorCourier(postcode: string, state: string) {
  try {
    if (!isEasyParcelBookingEnabled() || !(await isEasyParcelConfigured())) return null
    const quoted = await easyParcelRateCheck({
      sendCode: String(postcode || '').trim(),
      sendState: toEasyParcelState(state),
      sendCountry: 'MY',
    })
    if (!quoted.ok || quoted.rates.length === 0) return null
    return quoted.rates[0]
  } catch (err) {
    console.error('[checkout] outdoor courier quote', err)
    return null
  }
}

function cleanAttributionText(value: unknown, max = 300) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

async function validateLandingPageCheckoutAttribution(supabase: any, attribution: CheckoutBody['landingPageAttribution']) {
  if (!attribution?.landingPageId || !attribution?.landingPageSlug || !attribution?.landingPageSessionId) return null

  const { data: page, error } = await supabase
    .from('landing_pages')
    .select('id, slug, status')
    .eq('id', attribution.landingPageId)
    .eq('slug', attribution.landingPageSlug)
    .eq('status', 'published')
    .maybeSingle()

  if (error || !page) return null

  return {
    landing_page_id: page.id,
    landing_page_slug: page.slug,
    landing_page_session_id: cleanAttributionText(attribution.landingPageSessionId, 80),
    source_code: cleanAttributionText(attribution.sourceCode),
    utm_source: cleanAttributionText(attribution.utmSource),
    utm_medium: cleanAttributionText(attribution.utmMedium),
    utm_campaign: cleanAttributionText(attribution.utmCampaign),
    utm_content: cleanAttributionText(attribution.utmContent),
    utm_term: cleanAttributionText(attribution.utmTerm),
    fbclid: cleanAttributionText(attribution.fbclid, 500),
    referrer_domain: cleanAttributionText(attribution.referrerDomain),
  }
}

// ── POST /api/storefront/checkout ─────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const body: CheckoutBody = await request.json()

    // Validate basics
    if (!body.customer?.name || !body.customer?.email || !body.customer?.phone) {
      return NextResponse.json({ error: 'Missing customer information' }, { status: 400 })
    }
    if (!body.items?.length) {
      return NextResponse.json({ error: 'Cart is empty' }, { status: 400 })
    }
    if (body.items.some((item) => !Number.isInteger(item?.quantity) || item.quantity < 1 || item.quantity > MAX_LINE_QUANTITY)) {
      return NextResponse.json({ error: `Each quantity must be a whole number from 1 to ${MAX_LINE_QUANTITY}` }, { status: 400 })
    }
    if (body.salesChannel === 'outdoor') {
      const fieldErrors = validateCheckoutCustomer(body.customer)
      const firstError = Object.values(fieldErrors)[0]
      if (firstError) {
        return NextResponse.json({ error: firstError, fieldErrors }, { status: 400 })
      }
      const c = body.customer
      body.customer = {
        ...c,
        name: c.name.trim(),
        phone: normalizeMalaysianPhone(c.phone) || c.phone,
        addressLine1: c.addressLine1.trim(),
        addressLine2: c.addressLine2?.trim() || '',
        city: c.city.trim(),
        state: c.state.trim(),
        postcode: c.postcode.trim(),
      }
    }

    // Cast to any: new tables not in generated types until migration runs
    const supabase: any = createAdminClient()
    const landingPageAttribution = await validateLandingPageCheckoutAttribution(supabase, body.landingPageAttribution)

    // ── 1. Verify prices server-side ──────────────────────────────
    const isOutdoor = body.salesChannel === 'outdoor'
    const bundleItems = body.items.filter((i) => isBundleCartId(i.variantId))
    const plainItems = body.items.filter((i) => !isBundleCartId(i.variantId))
    if (bundleItems.length > 0 && !isOutdoor) {
      return NextResponse.json({ error: 'Combos are sold on the Outdoor shop.' }, { status: 400 })
    }
    const outdoorSettings = isOutdoor ? await loadOutdoorCheckoutSettings(supabase) : null
    const bundles = bundleItems.length > 0
      ? await loadOutdoorBundles(supabase, { ids: [...new Set(bundleItems.map((i) => bundleIdFromCartId(i.variantId)))], withStock: false })
      : []
    const bundleMap = new Map(bundles.map((b) => [b.id, b]))
    if (bundleItems.some((i) => !bundleMap.has(bundleIdFromCartId(i.variantId)))) {
      return NextResponse.json({ error: 'A combo in your cart is no longer available. Remove it to continue.' }, { status: 400 })
    }
    const bumpOffer = isOutdoor && body.orderBump === true ? await loadOrderBumpOffer(supabase, outdoorSettings!) : null
    if (isOutdoor && body.orderBump === true && !bumpOffer) {
      return NextResponse.json({ error: 'The checkout offer has ended. Refresh the page to continue.' }, { status: 409 })
    }

    const variantIds = [
      ...new Set([
        ...plainItems.map((i) => i.variantId),
        ...bundles.flatMap((b) => b.components.map((c) => c.variantId)),
        ...(bumpOffer ? [bumpOffer.variantId] : []),
      ]),
    ]
    const { data: variants, error: vErr } = await supabase
      .from('product_variants')
      .select('id, variant_name, suggested_retail_price, is_active, product_id, products(product_name)')
      .in('id', variantIds)
      .eq('is_active', true)

    if (vErr || !variants) {
      return NextResponse.json({ error: 'Could not verify products' }, { status: 500 })
    }

    // Map for quick lookup
    const variantMap = new Map(variants.map((v: any) => [v.id, v]))

    // Build line items with verified prices
    let orderTotal = 0
    const lineItems: {
      variant_id: string
      product_name: string
      variant_name: string
      quantity: number
      unit_price: number
      subtotal: number
      line_kind?: 'bundle' | 'order_bump'
      bundle_id?: string
    }[] = []

    for (const item of bundleItems) {
      const bundle = bundleMap.get(bundleIdFromCartId(item.variantId))!
      if (bundle.components.some((c) => !variantMap.has(c.variantId))) {
        return NextResponse.json({ error: `${bundle.name} is no longer available. Remove it to continue.` }, { status: 400 })
      }
      const parts = allocateBundlePrice(
        bundle.price * item.quantity,
        bundle.components.map((c) => ({ ...c, quantity: c.quantity * item.quantity })),
      )
      for (const part of parts) {
        const variant = variantMap.get(part.variantId) as any
        orderTotal += part.subtotal
        lineItems.push({
          variant_id: part.variantId,
          product_name: variant.products?.product_name || 'Unknown',
          variant_name: [variant.variant_name, `${bundle.name} combo`].filter(Boolean).join(' · '),
          quantity: part.quantity,
          unit_price: part.unitPrice,
          subtotal: part.subtotal,
          line_kind: 'bundle',
          bundle_id: bundle.id,
        })
      }
    }

    for (const item of plainItems) {
      const variant = variantMap.get(item.variantId) as any
      if (!variant) {
        return NextResponse.json(
          { error: `Product variant ${item.variantId} is no longer available` },
          { status: 400 },
        )
      }
      const unitPrice = variant.suggested_retail_price || 0
      if (!isSellablePrice(unitPrice)) {
        return NextResponse.json(
          { error: `${variant.products?.product_name || variant.variant_name} is not available to buy online right now.` },
          { status: 400 },
        )
      }
      const subtotal = unitPrice * item.quantity
      orderTotal += subtotal
      lineItems.push({
        variant_id: item.variantId,
        product_name: variant.products?.product_name || 'Unknown',
        variant_name: variant.variant_name,
        quantity: item.quantity,
        unit_price: unitPrice,
        subtotal,
      })
    }

    if (bumpOffer) {
      const variant = variantMap.get(bumpOffer.variantId) as any
      if (!variant) {
        return NextResponse.json({ error: 'The checkout offer has ended. Refresh the page to continue.' }, { status: 409 })
      }
      orderTotal += bumpOffer.price
      lineItems.push({
        variant_id: bumpOffer.variantId,
        product_name: variant.products?.product_name || bumpOffer.productName,
        variant_name: [variant.variant_name, 'Checkout offer'].filter(Boolean).join(' · '),
        quantity: 1,
        unit_price: bumpOffer.price,
        subtotal: bumpOffer.price,
        line_kind: 'order_bump',
      })
    }
    orderTotal = Math.round(orderTotal * 100) / 100

    const shortfall = stockShortfall(
      lineItems.map((li) => ({
        variantId: li.variant_id,
        quantity: li.quantity,
        name: [li.product_name, li.variant_name].filter(Boolean).join(' · '),
      })),
      await sellableStock(supabase, lineItems.map((li) => li.variant_id)),
    )
    if (shortfall) {
      return NextResponse.json({ error: shortfall }, { status: 409 })
    }

    // ── 2. Shipping (Outdoor may pass EasyParcel quote; /store stays free/zero) ──
    const salesChannel = body.salesChannel === 'outdoor' ? 'outdoor' : 'store'
    if (salesChannel === 'store') {
      const productIds = [...new Set(variants.map((variant: any) => variant.product_id).filter(Boolean))]
      if (productIds.length > 0) {
        const flagged = await supabase.from('products').select('id, outdoor_only').in('id', productIds)
        if (!flagged.error) {
          const outdoorIds = new Set((flagged.data || []).filter((row: any) => row.outdoor_only).map((row: any) => row.id))
          if (variants.some((variant: any) => outdoorIds.has(variant.product_id))) {
            return NextResponse.json({ error: 'That product is sold on the Outdoor shop.' }, { status: 400 })
          }
        }
      }
    }
    if (salesChannel === 'outdoor') {
      const session = await createClient()
      const { data: { user } } = await session.auth.getUser()
      const accountEmail = String(user?.email || '').trim()
      if (!accountEmail) {
        return NextResponse.json({ error: 'Sign in before paying.' }, { status: 401 })
      }
      body.customer.email = accountEmail
    }
    let shippingAmount = 0
    let shippingServiceId: string | null = null
    let shippingCourierName: string | null = null
    let shippingActualCost: number | null = null
    let shippingSubsidy: number | null = null
    let affiliate: { id: string; code: string } | null = null
    if (salesChannel === 'outdoor') {
      const delivery = await resolveOutdoorShipping(
        supabase,
        variants.map((variant: any) => String(variant.product_id || '')),
        orderTotal,
        { customerSharePercent: outdoorSettings?.shippingCustomerSharePercent },
      )
      shippingAmount = delivery.amount
      if (delivery.actualCost != null) {
        shippingActualCost = delivery.actualCost
        shippingSubsidy = delivery.subsidy ?? 0
      }
      affiliate = await resolveOutdoorAffiliate(supabase, body.affiliateCode)
      const quote = await cheapestOutdoorCourier(body.customer.postcode, body.customer.state)
      if (quote) {
        shippingServiceId = quote.serviceId.slice(0, 80)
        shippingCourierName = `${quote.courierName} — ${quote.serviceName}`.slice(0, 120)
      }
    }
    const payableTotal = orderTotal + shippingAmount
    if (payableTotal < MIN_ORDER_TOTAL) {
      return NextResponse.json(
        { error: `The order total must be at least RM ${MIN_ORDER_TOTAL.toFixed(2)} to pay online.` },
        { status: 400 },
      )
    }

    // ── 3. Generate order reference ──────────────────────────────
    const orderRef = `ORD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`

    // ── 4. Create order ──────────────────────────────────────────
    const orderPayload: Record<string, unknown> = {
      order_ref: orderRef,
      status: 'pending_payment',
      sales_channel: salesChannel,
      customer_name: body.customer.name,
      customer_email: body.customer.email,
      customer_phone: body.customer.phone,
      shipping_address: {
        line1: body.customer.addressLine1,
        line2: body.customer.addressLine2 || '',
        city: body.customer.city,
        state: body.customer.state,
        postcode: body.customer.postcode,
      },
      shipping_amount: shippingAmount,
      shipping_service_id: shippingServiceId,
      shipping_courier_name: shippingCourierName,
      total_amount: payableTotal,
      currency: 'MYR',
    }
    const salesToolColumns: Record<string, unknown> = {}
    if (shippingActualCost != null) {
      salesToolColumns.shipping_actual_cost = shippingActualCost
      salesToolColumns.shipping_subsidy_amount = shippingSubsidy
    }
    if (affiliate) {
      salesToolColumns.affiliate_id = affiliate.id
      salesToolColumns.affiliate_code = affiliate.code
    }

    let order: { id: string; order_ref: string } | null = null
    let orderErr: any = null
    {
      let first = await supabase
        .from('storefront_orders')
        .insert({ ...orderPayload, ...salesToolColumns })
        .select('id, order_ref')
        .single()
      if (first.error && Object.keys(salesToolColumns).length > 0 && /affiliate_|shipping_actual_cost|shipping_subsidy_amount/i.test(String(first.error.message || ''))) {
        first = await supabase.from('storefront_orders').insert(orderPayload).select('id, order_ref').single()
      }
      order = first.data
      orderErr = first.error
      // Pre-migration fallback: keep /store checkout working if Outdoor columns are not applied yet.
      if (orderErr && /sales_channel|shipping_amount|shipping_service|shipping_courier/i.test(String(orderErr.message || ''))) {
        const legacy = { ...orderPayload }
        delete legacy.sales_channel
        delete legacy.shipping_amount
        delete legacy.shipping_service_id
        delete legacy.shipping_courier_name
        const retry = await supabase.from('storefront_orders').insert(legacy).select('id, order_ref').single()
        order = retry.data
        orderErr = retry.error
      }
    }

    if (orderErr || !order) {
      console.error('Order creation failed:', orderErr)
      return NextResponse.json({ error: 'Could not create order' }, { status: 500 })
    }

    // ── 5. Insert line items ─────────────────────────────────────
    const lineRows = (withKinds: boolean) =>
      lineItems.map((li) => ({
        order_id: order.id,
        variant_id: li.variant_id,
        product_name: li.product_name,
        variant_name: li.variant_name,
        quantity: li.quantity,
        unit_price: li.unit_price,
        subtotal: li.subtotal,
        ...(withKinds && li.line_kind ? { line_kind: li.line_kind, bundle_id: li.bundle_id ?? null } : {}),
      }))
    const hasKinds = lineItems.some((li) => li.line_kind)
    let { error: lineErr } = await supabase.from('storefront_order_items').insert(lineRows(hasKinds))
    if (lineErr && hasKinds && /line_kind|bundle_id/i.test(String(lineErr.message || ''))) {
      ;({ error: lineErr } = await supabase.from('storefront_order_items').insert(lineRows(false)))
    }

    if (lineErr) {
      console.error('Line item creation failed:', lineErr)
      // Delete the order to be safe
      await supabase.from('storefront_orders').delete().eq('id', order.id)
      return NextResponse.json({ error: 'Could not create order items' }, { status: 500 })
    }

    await recordOrderEvent(supabase, {
      orderId: order.id,
      eventType: 'created',
      toStatus: 'pending_payment',
      actorType: 'customer',
      actorLabel: String(body.customer.email || ''),
      note: `Order placed on the ${salesChannel === 'outdoor' ? 'Outdoor' : 'online'} store`,
    })

    if (landingPageAttribution) {
      const { error: attributionErr } = await supabase
        .from('landing_page_order_attributions')
        .insert({
          ...landingPageAttribution,
          order_id: order.id,
          order_ref: order.order_ref,
          order_total: payableTotal,
          currency: 'MYR',
        })

      if (attributionErr) {
        console.error('Landing page attribution insert failed:', attributionErr)
      } else {
        await supabase
          .from('landing_page_events')
          .insert({
            landing_page_id: landingPageAttribution.landing_page_id,
            landing_page_slug: landingPageAttribution.landing_page_slug,
            landing_page_session_id: landingPageAttribution.landing_page_session_id,
            event_type: 'order_created',
            metadata: {
              orderId: order.id,
              orderRef: order.order_ref,
              orderTotal: payableTotal,
              salesChannel,
            },
          })
      }
    }

    // ── 6. Create payment intent via gateway adapter ─────────────
    const origin = publicOriginFromRequest(request)
    const returnBase =
      typeof body.returnBasePath === 'string' && body.returnBasePath.startsWith('/')
        ? body.returnBasePath.replace(/\/$/, '')
        : '/store'
    const paymentResult = await createPaymentIntent(
      {
        orderId: order.id,
        orderRef: order.order_ref,
        amount: payableTotal,
        currency: 'MYR',
        customerName: body.customer.name,
        customerEmail: body.customer.email,
        customerPhone: body.customer.phone,
        description: `Order ${order.order_ref}`,
        returnUrl: `${origin}${returnBase}/orders/success?ref=${order.order_ref}`,
        cancelUrl: returnBase === '/outdoor'
          ? `${origin}/outdoor/account?tab=orders&pending=${encodeURIComponent(order.order_ref)}`
          : undefined,
        callbackUrl: `${origin}/api/storefront/payment/webhook`,
      },
      body.paymentProvider,
    )

    if (!paymentResult.success) {
      // Update order as failed
      await supabase
        .from('storefront_orders')
        .update({ status: 'payment_failed' })
        .eq('id', order.id)

      return NextResponse.json(
        { error: customerPaymentError(paymentResult.error) },
        { status: 502 },
      )
    }

    // Update order with payment reference
    await supabase
      .from('storefront_orders')
      .update({
        payment_provider: paymentResult.provider,
        payment_ref: paymentResult.paymentRef,
      })
      .eq('id', order.id)

    return NextResponse.json({
      orderRef: order.order_ref,
      paymentUrl: paymentResult.paymentUrl,
    })
  } catch (err: any) {
    console.error('Checkout error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
