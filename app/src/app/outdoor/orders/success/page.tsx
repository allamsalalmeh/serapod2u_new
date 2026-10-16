import Link from 'next/link'
import { CheckCircle2, Clock, Package, Truck, XCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getGatewayByProvider, verifyPaymentCallback } from '@/lib/payments'
import { stripeReturnResult } from '@/lib/payments/providers/stripe-webhook'
import { applyStorefrontPaymentResult } from '@/lib/payments/apply-callback'
import { flattenPaymentParams } from '@/lib/payments/providers/billplz-signature'
import { outdoorStaticImage, outdoorSwatchesFromVariants } from '@/lib/outdoor/merch'
import type { CartItem } from '@/lib/storefront/cart-context'
import { OutdoorPaymentPoller, OutdoorRetryBag } from '@/components/outdoor/OutdoorOrderResult'
import OutdoorThankYouGift from '@/components/outdoor/OutdoorThankYouGift'
import { bundleCartId, bundleItemsLabel } from '@/lib/outdoor/sales-tools'
import { loadOutdoorBundles } from '@/lib/outdoor/sales-tools-server'

export const metadata = { title: 'Order confirmation' }
export const dynamic = 'force-dynamic'

const PAID_STATUSES = ['paid', 'processing', 'shipped', 'delivered']
const FAILED_STATUSES = ['payment_failed', 'cancelled']

type OrderItem = {
  variant_id: string | null
  product_name: string
  variant_name: string
  quantity: number
  unit_price: number
  subtotal: number
  line_kind?: string | null
  bundle_id?: string | null
}

type Order = {
  order_ref: string
  status: string
  customer_name: string | null
  total_amount: number
  shipping_amount: number | null
  currency: string | null
  shipping_address: { line1?: string; line2?: string; city?: string; state?: string; postcode?: string } | null
  storefront_order_items: OrderItem[] | null
}

function money(amount: number, currency = 'MYR') {
  return new Intl.NumberFormat('en-MY', { style: 'currency', currency }).format(amount)
}

function exactEmailPattern(email: string) {
  return email.trim().toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)
}

async function loadOrder(ref: string, email: string): Promise<Order | null> {
  const admin: any = createAdminClient()
  const lookup = (lineColumns: string) =>
    admin
      .from('storefront_orders')
      .select(`order_ref, status, customer_name, total_amount, shipping_amount, currency, shipping_address, storefront_order_items(${lineColumns})`)
      .eq('order_ref', ref)
      .ilike('customer_email', exactEmailPattern(email))
      .maybeSingle()
  const baseLines = 'variant_id, product_name, variant_name, quantity, unit_price, subtotal'
  let { data, error } = await lookup(`${baseLines}, line_kind, bundle_id`)
  if (error && /line_kind|bundle_id/i.test(error.message || '')) ({ data, error } = await lookup(baseLines))
  if (error) {
    console.error('[outdoor-success] order lookup', error)
    return null
  }
  return data || null
}

async function retryItems(order: Order): Promise<CartItem[]> {
  const all = order.storefront_order_items || []
  const lines = all.filter((item) => item.variant_id && !item.line_kind)
  const admin: any = createAdminClient()
  const bundleIds = [...new Set(all.filter((item) => item.line_kind === 'bundle' && item.bundle_id).map((item) => item.bundle_id!))]
  const bundleItems: CartItem[] = []
  if (bundleIds.length > 0) {
    const bundles = await loadOutdoorBundles(admin, { ids: bundleIds, withStock: false })
    for (const bundle of bundles) {
      const first = bundle.components[0]
      const line = all.find((item) => item.bundle_id === bundle.id && item.variant_id === first?.variantId)
      const quantity = first && line ? Math.max(1, Math.round(Number(line.quantity) / first.quantity)) : 1
      bundleItems.push({
        productId: bundleCartId(bundle.id),
        variantId: bundleCartId(bundle.id),
        productName: bundle.name,
        variantName: bundleItemsLabel(bundle),
        price: bundle.price,
        imageUrl: bundle.imageUrl || first?.imageUrl || null,
        quantity,
      })
    }
  }
  if (lines.length === 0) return bundleItems
  const { data } = await admin
    .from('product_variants')
    .select('id, product_id, variant_name, image_url, attributes, is_active')
    .in('id', lines.map((item) => item.variant_id))
  const variants = new Map<string, any>((data || []).map((variant: any) => [variant.id, variant]))
  const out: CartItem[] = []
  for (const line of lines) {
    const variant = variants.get(line.variant_id!)
    if (!variant || variant.is_active === false) continue
    const swatch = outdoorSwatchesFromVariants([variant], line.product_name)[0]
    out.push({
      productId: variant.product_id,
      variantId: variant.id,
      productName: line.product_name,
      variantName: line.variant_name,
      price: Number(line.unit_price) || null,
      imageUrl: swatch?.imageUrl || outdoorStaticImage(line.product_name, 'pink') || null,
      quantity: Math.max(1, Number(line.quantity) || 1),
    })
  }
  return [...bundleItems, ...out]
}

function OrderSummary({ order }: { order: Order }) {
  const currency = order.currency || 'MYR'
  const items = order.storefront_order_items || []
  const shipping = Number(order.shipping_amount) || 0
  const addr = order.shipping_address || {}
  const address = [addr.line1, addr.line2, [addr.postcode, addr.city].filter(Boolean).join(' '), addr.state]
    .filter(Boolean)
    .join(', ')
  return (
    <div className="mt-6 rounded-2xl bg-[var(--out-ivory)] px-4 py-4 text-left">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs text-[var(--out-muted)]">Order number</p>
        <p className="break-all font-mono text-sm font-semibold text-[var(--out-bark)]">{order.order_ref}</p>
      </div>
      <ul className="mt-3 space-y-1.5 border-t border-[var(--out-bark)]/10 pt-3 text-sm text-[var(--out-bark)]">
        {items.map((item, index) => (
          <li key={`${item.variant_id}-${index}`} className="flex justify-between gap-3">
            <span className="min-w-0 truncate">
              {item.product_name}
              {item.variant_name ? <span className="text-[var(--out-muted)]"> · {item.variant_name}</span> : null} × {item.quantity}
            </span>
            <span className="shrink-0">{money(Number(item.subtotal) || 0, currency)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 space-y-1 border-t border-[var(--out-bark)]/10 pt-3 text-sm text-[var(--out-bark)]">
        <div className="flex justify-between">
          <span>Shipping</span>
          <span>{shipping > 0 ? money(shipping, currency) : 'Free'}</span>
        </div>
        <div className="flex justify-between font-display text-lg">
          <span>Total</span>
          <span>{money(Number(order.total_amount) || 0, currency)}</span>
        </div>
      </div>
      {address ? (
        <p className="mt-3 border-t border-[var(--out-bark)]/10 pt-3 text-xs leading-relaxed text-[var(--out-muted)]">
          <span className="font-semibold text-[var(--out-bark)]">Delivering to </span>
          {address}
        </p>
      ) : null}
    </div>
  )
}

const secondaryBtn =
  'inline-flex h-12 items-center justify-center rounded-full border border-[var(--out-bark)]/15 text-sm font-semibold text-[var(--out-bark)]'

export default async function OutdoorOrderSuccessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const ref = typeof params.ref === 'string' ? params.ref : ''
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const flat = flattenPaymentParams(params)
  const looksLikeBillplz = Boolean(flat['billplz[id]'] || (flat.id && (flat.paid || flat['billplz[paid]'])))

  if (looksLikeBillplz) {
    try {
      const result = await verifyPaymentCallback('billplz', flat)
      if (result.verified && result.orderId) {
        await applyStorefrontPaymentResult(result)
      }
    } catch (err) {
      console.error('[outdoor-success] billplz confirm failed:', err)
    }
  }

  const stripeSessionId = typeof params.session_id === 'string' ? params.session_id : ''
  if (stripeSessionId) {
    try {
      const gateway = await getGatewayByProvider('stripe')
      const result = await stripeReturnResult(stripeSessionId, (gateway?.credentials as Record<string, string>) || {})
      if (result.verified && result.orderId) {
        await applyStorefrontPaymentResult(result)
      }
    } catch (err) {
      console.error('[outdoor-success] stripe confirm failed:', err)
    }
  }

  const order = ref && user?.email ? await loadOrder(ref, user.email) : null
  const trackHref = ref ? `/outdoor/track?order=${encodeURIComponent(ref)}` : '/outdoor/track'
  const firstName = String(order?.customer_name || '').trim().split(/\s+/)[0]

  if (order && PAID_STATUSES.includes(order.status)) {
    return (
      <div className="mx-auto max-w-lg px-4 py-14 text-center sm:px-6">
        <div className="out-card px-6 py-10 sm:px-8">
          <OutdoorThankYouGift />
          <p
            className="out-reveal mt-4 inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--out-bark)]/60"
            style={{ '--reveal-delay': '1.5s' } as React.CSSProperties}
          >
            <CheckCircle2 className="h-3.5 w-3.5 text-[var(--out-olive)]" aria-hidden />
            Payment received
          </p>
          <h1
            className="out-reveal mt-2 font-display text-3xl tracking-tight text-[var(--out-bark)]"
            style={{ '--reveal-delay': '1.65s' } as React.CSSProperties}
          >
            Thank you{firstName ? `, ${firstName}` : ''}!
          </h1>
          <p
            className="out-reveal mt-3 text-sm leading-relaxed text-[var(--out-muted)]"
            style={{ '--reveal-delay': '1.8s' } as React.CSSProperties}
          >
            Your order is confirmed and your gear is getting ready for the trip.
          </p>
          <div className="out-reveal" style={{ '--reveal-delay': '1.95s' } as React.CSSProperties}>
            <OrderSummary order={order} />
          </div>
          <ol
            className="out-reveal mt-6 space-y-3 text-left text-sm text-[var(--out-bark)]"
            style={{ '--reveal-delay': '2.1s' } as React.CSSProperties}
          >
            <li className="flex gap-3">
              <Package className="mt-0.5 h-4 w-4 shrink-0 text-[var(--out-moss)]" aria-hidden />
              <span>We pack your order and hand it to the courier within 1–3 business days.</span>
            </li>
            <li className="flex gap-3">
              <Truck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--out-moss)]" aria-hidden />
              <span>When it ships, the tracking number appears on your order in My account.</span>
            </li>
          </ol>
          <div className="out-reveal mt-8 flex flex-col gap-2" style={{ '--reveal-delay': '2.2s' } as React.CSSProperties}>
            <Link href={trackHref} className="out-btn w-full">
              Track order
            </Link>
            <Link href="/outdoor/shop" className={secondaryBtn}>
              Keep shopping
            </Link>
          </div>
        </div>
      </div>
    )
  }

  if (order && FAILED_STATUSES.includes(order.status)) {
    const items = await retryItems(order)
    return (
      <div className="mx-auto max-w-lg px-4 py-14 text-center sm:px-6">
        <div className="out-card px-6 py-10 sm:px-8">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-red-50 text-red-600">
            <XCircle className="h-8 w-8" aria-hidden />
          </div>
          <h1 className="mt-5 font-display text-3xl tracking-tight text-[var(--out-bark)]">Payment didn’t go through</h1>
          <p className="mt-3 text-sm leading-relaxed text-[var(--out-muted)]">
            Order <span className="font-mono font-semibold text-[var(--out-bark)]">{order.order_ref}</span> was not charged.
            You can try again with the same items.
          </p>
          <div className="mt-8 flex flex-col gap-2">
            <OutdoorRetryBag items={items} />
            <Link href="/outdoor/account?tab=orders" className={secondaryBtn}>
              My orders
            </Link>
          </div>
        </div>
      </div>
    )
  }

  if (order && order.status === 'pending_payment') {
    return (
      <div className="mx-auto max-w-lg px-4 py-14 text-center sm:px-6">
        <div className="out-card px-6 py-10 sm:px-8">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[var(--out-ivory)] text-[var(--out-bark)]">
            <Clock className="h-8 w-8" aria-hidden />
          </div>
          <h1 className="mt-5 font-display text-3xl tracking-tight text-[var(--out-bark)]">Confirming your payment</h1>
          <p className="mt-3 text-sm leading-relaxed text-[var(--out-muted)]">
            We received your order and are waiting for the payment provider to confirm it. This usually takes a few seconds.
          </p>
          <OrderSummary order={order} />
          <OutdoorPaymentPoller />
          <div className="mt-8 flex flex-col gap-2">
            <Link href="/outdoor/account?tab=orders" className={secondaryBtn}>
              My orders
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-md px-4 py-14 text-center sm:px-6">
      <div className="out-card px-6 py-10 sm:px-8">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--out-bark)]/50">SeraOutdoor</p>
        <h1 className="mt-2 font-display text-3xl tracking-tight text-[var(--out-bark)]">You’re all set</h1>
        <p className="mt-3 text-sm text-[var(--out-muted)] leading-relaxed">
          We received your order. Payment shows as paid after Stripe or Billplz confirms it.
        </p>
        {ref ? (
          <div className="mt-6 rounded-2xl bg-[var(--out-ivory)] px-4 py-4 text-left">
            <p className="text-xs text-[var(--out-muted)]">Order number</p>
            <p className="mt-1 break-all font-mono text-lg font-semibold text-[var(--out-bark)]">{ref}</p>
            <p className="mt-2 text-xs text-[var(--out-muted)]">This order is saved on your account.</p>
          </div>
        ) : null}
        <div className="mt-8 flex flex-col gap-2">
          {user ? (
            <Link href={trackHref} className="out-btn w-full">
              Track order
            </Link>
          ) : null}
          <Link href="/outdoor/shop" className={secondaryBtn}>
            Keep shopping
          </Link>
        </div>
      </div>
    </div>
  )
}
