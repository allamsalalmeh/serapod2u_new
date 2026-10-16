'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Truck } from 'lucide-react'
import { useCart, type CartItem } from '@/lib/storefront/cart-context'
import { clearOutdoorBuyNow, readOutdoorBuyNow } from '@/lib/outdoor/buy-now'
import { createClient } from '@/lib/supabase/client'
import { MALAYSIA_STATES } from '@/lib/shipping/malaysia-states'
import { socialAccountLabel } from '@/lib/auth/social-oauth'
import {
  OUTDOOR_FREE_SHIPPING_OVER_RM,
  pickOutdoorShipping,
  type OutdoorShippingQuote,
} from '@/lib/outdoor/shipping'
import type { OutdoorCheckoutPrefill } from '@/lib/outdoor/checkout-prefill'
import { validateCheckoutCustomer, type CheckoutFieldErrors } from '@/lib/storefront/customer-validation'
import type { OutdoorOrderBumpOffer } from '@/lib/outdoor/sales-tools'
import { readOutdoorRef } from '@/components/outdoor/OutdoorRefCapture'

function loginForCheckout() {
  const here = `${window.location.pathname}${window.location.search}`
  return `/outdoor/login?next=${encodeURIComponent(here.startsWith('/outdoor/checkout') ? here : '/outdoor/checkout')}`
}

function money(n: number) {
  return new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(n)
}

export default function OutdoorCheckoutPage() {
  const router = useRouter()
  const cart = useCart()
  // undefined until the URL is read; null means a normal checkout of the whole bag.
  const [buyNow, setBuyNow] = useState<CartItem | null | undefined>(undefined)
  const items = buyNow ? [buyNow] : cart.items
  const subtotal = buyNow ? (buyNow.price ?? 0) * buyNow.quantity : cart.subtotal
  const hasItemsWithoutPrice = buyNow ? !(buyNow.price != null && buyNow.price > 0) : cart.hasItemsWithoutPrice
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<CheckoutFieldErrors>({})
  const [payMethods, setPayMethods] = useState<{ key: string; label: string; isDefault: boolean }[]>([])
  const [payProvider, setPayProvider] = useState('')
  const [accountEmail, setAccountEmail] = useState('')
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    state: '',
    postcode: '',
  })
  const [shipping, setShipping] = useState<OutdoorShippingQuote | null>(null)
  const [offer, setOffer] = useState<OutdoorOrderBumpOffer | null>(null)
  const [bumpChecked, setBumpChecked] = useState(false)
  const bump = offer && bumpChecked ? offer : null
  const bagKey = items.map((item) => `${item.variantId}:${item.quantity}`).join('|')

  useEffect(() => {
    void fetch('/api/storefront/outdoor-offers')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setOffer(data?.orderBump || null))
      .catch(() => setOffer(null))
  }, [])

  useEffect(() => {
    const mode = new URLSearchParams(window.location.search).get('mode')
    setBuyNow(mode === 'buy-now' ? readOutdoorBuyNow() : null)
  }, [])

  useEffect(() => {
    const supabase = createClient()
    void supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user?.email) {
        router.replace(loginForCheckout())
        return
      }
      setAccountEmail(user.email)
      const username = typeof user.user_metadata?.username === 'string' ? user.user_metadata.username : ''
      setForm((current) => ({
        ...current,
        email: socialAccountLabel(user.email || '', username),
      }))
      void fetch('/api/outdoor/checkout-prefill')
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          const known: Partial<OutdoorCheckoutPrefill> = data?.prefill || {}
          setForm((current) => {
            const next = { ...current }
            for (const key of ['name', 'phone', 'addressLine1', 'addressLine2', 'city', 'state', 'postcode'] as const) {
              const value = typeof known[key] === 'string' ? known[key]!.trim() : ''
              if (value && !current[key].trim()) next[key] = value
            }
            return next
          })
        })
        .catch(() => {})
    })
  }, [router])

  useEffect(() => {
    if (!bagKey) return
    let cancelled = false
    setShipping(null)
    void fetch('/api/storefront/outdoor-shipping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
        orderBump: Boolean(bump),
      }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setShipping(data?.shipping || pickOutdoorShipping([], subtotal))
      })
      .catch(() => {
        if (!cancelled) setShipping(pickOutdoorShipping([], subtotal))
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bagKey, Boolean(bump)])

  useEffect(() => {
    void fetch('/api/storefront/payment/methods')
      .then((res) => res.json())
      .then((data) => {
        const methods = Array.isArray(data?.methods) ? data.methods : []
        setPayMethods(methods)
        const def = methods.find((m: { isDefault: boolean }) => m.isDefault) || methods[0]
        if (def?.key) setPayProvider(def.key)
      })
      .catch(() => {
        setPayMethods([])
      })
  }, [])

  if (buyNow === undefined) {
    return <div className="mx-auto max-w-md px-5 py-16 text-center text-sm text-[var(--out-muted)]">Loading checkout…</div>
  }

  if (items.length === 0) {
    return (
      <div className="mx-auto max-w-md px-5 py-16 text-center">
        <div className="out-card px-6 py-12">
          <h1 className="font-display text-3xl tracking-tight text-[var(--out-bark)]">Your cart is empty</h1>
          <p className="mt-3 text-sm text-[var(--out-muted)]">Add a chair, mat, or tumbler first.</p>
          <Link href="/outdoor/shop" className="out-btn mt-8 w-full">
            Shop Outdoor
          </Link>
        </div>
      </div>
    )
  }

  const shippingReady = shipping !== null
  const shippingCost = shipping?.amount ?? 0
  const freeShipping = shippingReady && shippingCost <= 0
  const bumpPrice = bump?.price ?? 0
  const total = subtotal + bumpPrice + shippingCost

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (hasItemsWithoutPrice) {
      setError('Remove items without a valid price before paying.')
      return
    }
    if (!shippingReady) return
    const errors = validateCheckoutCustomer(form)
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) {
      setError('Please check the highlighted fields.')
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/storefront/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer: { ...form, email: accountEmail || form.email },
          items: items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
          returnBasePath: '/outdoor',
          salesChannel: 'outdoor',
          paymentProvider: payProvider || undefined,
          shipping: { amount: shippingCost },
          orderBump: Boolean(bump),
          affiliateCode: readOutdoorRef() || undefined,
        }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        if (data?.fieldErrors) setFieldErrors(data.fieldErrors)
        throw new Error(data?.error || 'Checkout failed')
      }
      if (buyNow) clearOutdoorBuyNow()
      else cart.clearCart()
      if (data?.paymentUrl) {
        sessionStorage.setItem('outdoor-pay-next', data.paymentUrl)
        window.location.replace(`/outdoor/pay?ref=${encodeURIComponent(data.orderRef || '')}`)
        return
      }
      router.push(`/outdoor/orders/success?ref=${encodeURIComponent(data.orderRef || '')}`)
    } catch (err: any) {
      setError(err.message || 'Checkout failed')
    } finally {
      setLoading(false)
    }
  }

  const updateField = (key: keyof typeof form, value: string) => {
    setForm((f) => ({ ...f, [key]: value }))
    if (error) setError('')
    if (fieldErrors[key as keyof CheckoutFieldErrors]) {
      setFieldErrors((current) => ({ ...current, [key]: undefined }))
    }
  }

  const checkField = (key: keyof typeof form) => {
    if (!form[key].trim()) return
    const message = validateCheckoutCustomer(form)[key as keyof CheckoutFieldErrors]
    setFieldErrors((current) => ({ ...current, [key]: message }))
  }

  const field = (
    key: keyof typeof form,
    label: string,
    opts?: {
      required?: boolean
      type?: string
      inputMode?: 'numeric' | 'tel'
      autoComplete?: string
      placeholder?: string
      maxLength?: number
    },
  ) => {
    const message = fieldErrors[key as keyof CheckoutFieldErrors]
    return (
      <label className="block text-sm font-medium text-[var(--out-bark)]">
        {label}
        <input
          required={opts?.required !== false}
          type={opts?.type || 'text'}
          inputMode={opts?.inputMode}
          autoComplete={opts?.autoComplete}
          placeholder={opts?.placeholder}
          maxLength={opts?.maxLength}
          value={form[key]}
          onChange={(e) => updateField(key, e.target.value)}
          onBlur={() => checkField(key)}
          aria-invalid={Boolean(message)}
          className={`out-input ${message ? 'border-red-500 ring-1 ring-red-500/30' : ''}`}
        />
        {message ? <span className="mt-1 block text-xs font-normal text-red-600">{message}</span> : null}
      </label>
    )
  }

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-8 py-8 sm:py-12">
      <p className="text-center text-xs font-semibold uppercase tracking-[0.18em] text-[var(--out-bark)]/50">
        Delivery · Shipping · Pay
      </p>
      <h1 className="mt-2 text-center font-display text-4xl tracking-tight text-[var(--out-bark)]">Checkout</h1>
      <p className="mx-auto mt-2 max-w-md text-center text-sm text-[var(--out-muted)]">
        {!shippingReady
          ? 'Where should we send your gear?'
          : freeShipping
            ? 'Where should we send your gear? Shipping is free.'
            : `Where should we send your gear? Delivery is ${money(shippingCost)}.`}
      </p>

      <div className="mt-8 grid gap-5 lg:grid-cols-[1.15fr_0.85fr] lg:items-start">
        <form className="out-card space-y-5 p-5 sm:p-7" onSubmit={submit} noValidate>
          <div>
            <h2 className="font-display text-xl text-[var(--out-bark)]">Your details</h2>
            <div className="mt-4 space-y-3">
              {field('name', 'Full name', { autoComplete: 'name', maxLength: 80 })}
              <label className="block text-sm font-medium text-[var(--out-bark)]">
                Account
                <input readOnly value={form.email} className="out-input bg-[var(--out-sand)]/40" />
              </label>
              {field('phone', 'Phone', { type: 'tel', inputMode: 'tel', autoComplete: 'tel', placeholder: '012-345 6789', maxLength: 20 })}
            </div>
          </div>

          <div>
            <h2 className="font-display text-xl text-[var(--out-bark)]">Delivery address</h2>
            <div className="mt-4 space-y-3">
              {field('addressLine1', 'Address line 1', { autoComplete: 'address-line1', placeholder: 'No. 12, Jalan Example', maxLength: 200 })}
              {field('addressLine2', 'Address line 2', { required: false, autoComplete: 'address-line2', maxLength: 200 })}
              <div className="grid gap-3 sm:grid-cols-3">
                {field('city', 'City', { autoComplete: 'address-level2', maxLength: 60 })}
                <label className="block text-sm font-medium text-[var(--out-bark)]">
                  State
                  <select
                    required
                    autoComplete="address-level1"
                    value={form.state}
                    onChange={(e) => updateField('state', e.target.value)}
                    aria-invalid={Boolean(fieldErrors.state)}
                    className={`out-input ${fieldErrors.state ? 'border-red-500 ring-1 ring-red-500/30' : ''}`}
                  >
                    <option value="" disabled>Select</option>
                    {MALAYSIA_STATES.map((s) => (
                      <option key={s.code} value={s.label}>{s.label}</option>
                    ))}
                  </select>
                  {fieldErrors.state ? <span className="mt-1 block text-xs font-normal text-red-600">{fieldErrors.state}</span> : null}
                </label>
                {field('postcode', 'Postcode', { inputMode: 'numeric', autoComplete: 'postal-code', maxLength: 5 })}
              </div>
            </div>
          </div>

          <div>
            <h2 className="font-display text-xl text-[var(--out-bark)]">Shipping</h2>
            <div className="mt-4 overflow-hidden rounded-[1.4rem] border border-[var(--out-bark)]/10 bg-[var(--out-ivory)]">
              <div className="flex items-center gap-4 px-4 py-4 sm:px-5">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[var(--out-bark)] text-[var(--out-cream)]">
                  <Truck className="h-5 w-5" aria-hidden />
                </div>
                {shipping ? (
                  <>
                    <div key={shipping.title} className="out-swap min-w-0 flex-1">
                      <p className="font-display text-xl leading-none text-[var(--out-bark)]">{shipping.title}</p>
                      <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-[var(--out-muted)]">{shipping.note}</p>
                    </div>
                    <div key={shippingCost} className="out-swap shrink-0 text-right">
                      {shipping.actualCost != null && shipping.actualCost > shippingCost ? (
                        <p className="whitespace-nowrap text-xs text-[var(--out-muted)] line-through">{money(shipping.actualCost)}</p>
                      ) : null}
                      <p className="whitespace-nowrap font-display text-xl text-[var(--out-bark)] sm:text-2xl">
                        {freeShipping ? 'Free' : money(shippingCost)}
                      </p>
                    </div>
                  </>
                ) : (
                  <div className="min-w-0 flex-1 animate-pulse space-y-2" aria-label="Loading delivery">
                    <div className="h-4 w-36 rounded-full bg-[var(--out-bark)]/10" />
                    <div className="h-3 w-52 max-w-full rounded-full bg-[var(--out-bark)]/10" />
                  </div>
                )}
              </div>
              {OUTDOOR_FREE_SHIPPING_OVER_RM != null && OUTDOOR_FREE_SHIPPING_OVER_RM > 0 ? (
                <p className="border-t border-[var(--out-bark)]/10 px-4 py-2.5 text-xs text-[var(--out-bark)] sm:px-5">
                  {freeShipping
                    ? 'Free shipping is included on this order.'
                    : `Free shipping on orders from ${money(OUTDOOR_FREE_SHIPPING_OVER_RM)}.`}
                </p>
              ) : null}
            </div>
          </div>

          {offer ? (
            <label
              className={`flex cursor-pointer items-center gap-3 rounded-[1.4rem] border-2 border-dashed px-4 py-3 transition-colors ${
                bumpChecked ? 'border-[var(--out-ember)] bg-[var(--out-ivory)]' : 'border-[var(--out-bark)]/20'
              }`}
            >
              <input
                type="checkbox"
                checked={bumpChecked}
                onChange={(e) => setBumpChecked(e.target.checked)}
                className="h-5 w-5 shrink-0 accent-[var(--out-ember)]"
              />
              {offer.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={offer.imageUrl} alt="" className="h-12 w-12 shrink-0 rounded-xl bg-white object-contain p-1" />
              ) : null}
              <span className="text-sm font-semibold text-[var(--out-bark)]">{offer.text}</span>
            </label>
          ) : null}

          {payMethods.length > 1 ? (
            <div>
              <h2 className="font-display text-xl text-[var(--out-bark)]">Pay with</h2>
              <div className="mt-4 space-y-2">
                {payMethods.map((m) => {
                  const active = payProvider === m.key
                  return (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => setPayProvider(m.key)}
                      className={`w-full rounded-2xl border px-4 py-3 text-left text-sm transition-colors ${
                        active
                          ? 'border-[var(--out-bark)] bg-[var(--out-ivory)]'
                          : 'border-[var(--out-bark)]/10 hover:border-[var(--out-bark)]/30'
                      }`}
                    >
                      <span className="font-semibold text-[var(--out-bark)]">{m.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          ) : null}

          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <button type="submit" disabled={loading || !shippingReady} className="out-btn w-full">
            {loading ? 'Processing…' : shippingReady ? `Pay ${money(total)}` : 'Loading delivery…'}
          </button>
        </form>

        <aside className="out-card p-5 sm:p-6 lg:sticky lg:top-24">
          <h2 className="font-display text-xl text-[var(--out-bark)]">{buyNow ? 'Buying now' : 'Your cart'}</h2>
          {buyNow && cart.items.length > 0 ? (
            <p className="mt-1 text-xs text-[var(--out-muted)]">
              Only this item is in this order. Your cart keeps its {cart.totalItems} other item{cart.totalItems === 1 ? '' : 's'}.
            </p>
          ) : null}
          <ul className="mt-4 space-y-3">
            {items.map((i) => (
              <li key={i.variantId} className="flex items-center gap-3">
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-2xl bg-[var(--out-ivory)]">
                  {i.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={i.imageUrl} alt="" className="h-full w-full object-contain p-1" />
                  ) : null}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-[var(--out-bark)]">{i.productName}</p>
                  <p className="text-xs text-[var(--out-muted)]">× {i.quantity}</p>
                </div>
                <span className="text-sm font-medium text-[var(--out-bark)]">
                  {i.price != null ? money(i.price * i.quantity) : '—'}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-5 space-y-2 border-t border-[var(--out-bark)]/10 pt-4 text-sm text-[var(--out-bark)]">
            <div className="flex justify-between">
              <span>Subtotal</span>
              <span>{money(subtotal)}</span>
            </div>
            {bump ? (
              <div className="flex justify-between gap-3">
                <span className="min-w-0 truncate">{bump.productName}</span>
                <span>{money(bump.price)}</span>
              </div>
            ) : null}
            <div className="flex justify-between">
              <span>Shipping</span>
              <span>{!shippingReady ? '—' : freeShipping ? 'Free' : money(shippingCost)}</span>
            </div>
            <div className="flex justify-between pt-2 font-display text-xl">
              <span>Total</span>
              <span>{money(total)}</span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
