'use client'

import { useEffect, useState } from 'react'
import { useCart } from '@/lib/storefront/cart-context'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { getStoredLandingPageAttribution, trackLandingPageEvent } from '@/lib/storefront/landing-attribution'
import type { LandingPageAttribution } from '@/lib/landing-pages/types'
import { checkoutAffiliateFields } from '@/components/affiliate/AffiliateRefCapture'
import {
  ArrowLeft,
  CreditCard,
  Loader2,
  ShoppingBag,
  Lock,
  User,
  Phone,
  Mail,
  MapPin,
  Sparkles,
} from 'lucide-react'

function formatPrice(price: number) {
  return new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(price)
}

interface CheckoutForm {
  name: string
  email: string
  phone: string
  addressLine1: string
  addressLine2: string
  city: string
  state: string
  postcode: string
}

const INITIAL_FORM: CheckoutForm = {
  name: '',
  email: '',
  phone: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  postcode: '',
}

const MY_STATES = [
  'Johor',
  'Kedah',
  'Kelantan',
  'Kuala Lumpur',
  'Labuan',
  'Melaka',
  'Negeri Sembilan',
  'Pahang',
  'Penang',
  'Perak',
  'Perlis',
  'Putrajaya',
  'Sabah',
  'Sarawak',
  'Selangor',
  'Terengganu',
]

export default function CheckoutPage() {
  const { items, subtotal, clearCart } = useCart()
  const router = useRouter()
  const [form, setForm] = useState<CheckoutForm>(INITIAL_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [landingAttribution, setLandingAttribution] = useState<LandingPageAttribution | null>(null)
  const [payMethods, setPayMethods] = useState<{ key: string; label: string; isDefault: boolean }[]>([])
  const [payProvider, setPayProvider] = useState('')

  useEffect(() => {
    setLandingAttribution(getStoredLandingPageAttribution())
    void fetch('/api/storefront/payment/methods')
      .then((res) => res.json())
      .then((data) => {
        const methods = Array.isArray(data?.methods) ? data.methods : []
        setPayMethods(methods)
        const def = methods.find((m: { isDefault: boolean }) => m.isDefault) || methods[0]
        if (def?.key) setPayProvider(def.key)
      })
      .catch(() => setPayMethods([]))
  }, [])

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }))
  }

  const isValid =
    form.name.trim() &&
    form.email.trim() &&
    form.phone.trim() &&
    form.addressLine1.trim() &&
    form.city.trim() &&
    form.state &&
    form.postcode.trim()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!isValid || submitting) return
    setSubmitting(true)
    setError(null)

    try {
      const landingPageAttribution = getStoredLandingPageAttribution()
      if (landingPageAttribution) {
        trackLandingPageEvent('checkout_start', {
          landingPageId: landingPageAttribution.landingPageId,
          landingPageSlug: landingPageAttribution.landingPageSlug,
          landingPageSessionId: landingPageAttribution.landingPageSessionId,
          attribution: landingPageAttribution,
        })
      }

      const res = await fetch('/api/storefront/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer: form,
          items: items.map((i) => ({
            variantId: i.variantId,
            quantity: i.quantity,
          })),
          landingPageAttribution,
          paymentProvider: payProvider || undefined,
          ...checkoutAffiliateFields(),
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Something went wrong. Please try again.')
        setSubmitting(false)
        return
      }

      // If the API returns a payment redirect URL, navigate there
      if (data.paymentUrl) {
        if (landingPageAttribution) {
          trackLandingPageEvent('order_created', {
            landingPageId: landingPageAttribution.landingPageId,
            landingPageSlug: landingPageAttribution.landingPageSlug,
            landingPageSessionId: landingPageAttribution.landingPageSessionId,
            attribution: landingPageAttribution,
            metadata: { orderRef: data.orderRef },
          })
        }
        clearCart()
        window.location.href = data.paymentUrl
        return
      }

      // Otherwise, go to success page
      if (landingPageAttribution) {
        trackLandingPageEvent('order_created', {
          landingPageId: landingPageAttribution.landingPageId,
          landingPageSlug: landingPageAttribution.landingPageSlug,
          landingPageSessionId: landingPageAttribution.landingPageSessionId,
          attribution: landingPageAttribution,
          metadata: { orderRef: data.orderRef },
        })
      }
      clearCart()
      router.push(`/store/orders/success?ref=${data.orderRef}`)
    } catch {
      setError('Network error. Please try again.')
      setSubmitting(false)
    }
  }

  if (items.length === 0) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 text-center">
        <ShoppingBag className="h-20 w-20 text-[var(--sera-muted)]/40 mx-auto mb-6" />
        <h1 className="font-display text-2xl font-semibold text-[var(--sera-ink)] mb-2">Nothing to checkout</h1>
        <p className="text-[var(--sera-muted)] mb-8">Add some products to your cart first.</p>
        <Link
          href="/store/products"
          className="inline-flex items-center gap-2 h-11 px-6 bg-[var(--sera-ink)] text-white rounded-xl text-sm font-semibold hover:bg-[var(--sera-ink-soft)] transition"
        >
          Browse Products
        </Link>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Back */}
      <Link
        href="/store/cart"
        className="inline-flex items-center gap-1.5 text-sm text-[var(--sera-muted)] hover:text-[var(--sera-ink)] transition-colors mb-6"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to cart
      </Link>

      <h1 className="font-display text-2xl font-semibold text-[var(--sera-ink)] mb-2">Checkout</h1>

      {landingAttribution && (
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800">
          <Sparkles className="h-3.5 w-3.5" />
          Source: {landingAttribution.landingPageTitle || landingAttribution.landingPageSlug}
        </div>
      )}


      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-8">
          {/* ── Left: Form ── */}
          <div className="lg:col-span-3 space-y-6">
            {/* Contact */}
            <fieldset className="bg-white rounded-xl border border-[var(--sera-line)] p-5 shadow-sm">
              <legend className="text-sm font-semibold text-[var(--sera-ink)] px-1">Contact Information</legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
                <InputField
                  icon={<User className="h-4 w-4" />}
                  name="name"
                  label="Full Name"
                  value={form.name}
                  onChange={handleChange}
                  required
                />
                <InputField
                  icon={<Mail className="h-4 w-4" />}
                  name="email"
                  label="Email"
                  type="email"
                  value={form.email}
                  onChange={handleChange}
                  required
                />
                <InputField
                  icon={<Phone className="h-4 w-4" />}
                  name="phone"
                  label="Phone Number"
                  type="tel"
                  value={form.phone}
                  onChange={handleChange}
                  required
                  className="sm:col-span-2"
                />
              </div>
            </fieldset>

            {/* Shipping */}
            <fieldset className="bg-white rounded-xl border border-[var(--sera-line)] p-5 shadow-sm">
              <legend className="text-sm font-semibold text-[var(--sera-ink)] px-1">Shipping Address</legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
                <InputField
                  icon={<MapPin className="h-4 w-4" />}
                  name="addressLine1"
                  label="Address Line 1"
                  value={form.addressLine1}
                  onChange={handleChange}
                  required
                  className="sm:col-span-2"
                />
                <InputField
                  name="addressLine2"
                  label="Address Line 2 (optional)"
                  value={form.addressLine2}
                  onChange={handleChange}
                  className="sm:col-span-2"
                />
                <InputField
                  name="city"
                  label="City"
                  value={form.city}
                  onChange={handleChange}
                  required
                />
                <div className="flex flex-col">
                  <label className="text-xs font-medium text-[var(--sera-muted)] mb-1">State *</label>
                  <select
                    name="state"
                    value={form.state}
                    onChange={handleChange}
                    required
                    className="h-10 rounded-lg border border-[var(--sera-line)] bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900/10"
                  >
                    <option value="">Select state</option>
                    {MY_STATES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
                <InputField
                  name="postcode"
                  label="Postcode"
                  value={form.postcode}
                  onChange={handleChange}
                  required
                  inputMode="numeric"
                  maxLength={5}
                />
              </div>
            </fieldset>
          </div>

          {/* ── Right: Order Summary ── */}
          <div className="lg:col-span-2">
            <div className="sticky top-24 bg-[var(--sera-mist)] rounded-xl border border-[var(--sera-line)] p-5">
              <h3 className="text-sm font-semibold text-[var(--sera-ink)] mb-4">Order Summary</h3>
              <div className="space-y-3 max-h-60 overflow-y-auto">
                {items.map((item) => (
                  <div key={item.variantId} className="flex items-start gap-3">
                    <div className="flex-none w-10 h-10 rounded-lg bg-white border border-[var(--sera-line)] overflow-hidden flex items-center justify-center">
                      {item.imageUrl ? (
                        <img src={item.imageUrl} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <ShoppingBag className="h-4 w-4 text-[var(--sera-muted)]/40" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-[var(--sera-ink)] line-clamp-1">
                        {item.productName}
                      </p>
                      <p className="text-xs text-[var(--sera-muted)]/70">
                        {item.variantName} × {item.quantity}
                      </p>
                    </div>
                    <p className="text-xs font-semibold text-[var(--sera-ink)] flex-none">
                      {item.price ? formatPrice(item.price * item.quantity) : '-'}
                    </p>
                  </div>
                ))}
              </div>

              <div className="border-t border-[var(--sera-line)] mt-4 pt-4 space-y-2">
                <div className="flex justify-between text-sm text-[var(--sera-muted)]">
                  <span>Subtotal</span>
                  <span>{formatPrice(subtotal)}</span>
                </div>
                <div className="flex justify-between text-sm text-[var(--sera-muted)]">
                  <span>Shipping</span>
                  <span className="text-[var(--sera-muted)]/70">Free</span>
                </div>
                <div className="border-t border-[var(--sera-line)] pt-3 flex justify-between text-base font-bold text-[var(--sera-ink)]">
                  <span>Total</span>
                  <span>{formatPrice(subtotal)}</span>
                </div>
              </div>

              {payMethods.length > 1 ? (
                <div className="mt-5 space-y-2">
                  <p className="text-sm font-semibold text-[var(--sera-ink)]">Pay with</p>
                  {payMethods.map((m) => (
                    <button
                      key={m.key}
                      type="button"
                      onClick={() => setPayProvider(m.key)}
                      className={`w-full rounded-xl border px-3 py-2.5 text-left text-sm ${
                        payProvider === m.key
                          ? 'border-[var(--sera-ink)] bg-white'
                          : 'border-[var(--sera-line)]'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              ) : null}

              {/* Error */}
              {error && (
                <div className="mt-4 rounded-lg bg-red-50 border border-red-100 p-3 text-xs text-red-600">
                  {error}
                </div>
              )}

              {/* Submit */}
              <button
                type="submit"
                disabled={!isValid || submitting}
                className="mt-6 w-full h-12 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange-deep)] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Processing…
                  </>
                ) : (
                  <>
                    <CreditCard className="h-4 w-4" />
                    Place Order & Pay
                  </>
                )}
              </button>

              <p className="mt-3 text-[10px] text-[var(--sera-muted)]/70 flex items-center justify-center gap-1">
                <Lock className="h-3 w-3" />
                Secured payment via payment gateway
              </p>
            </div>
          </div>
        </div>
      </form>
    </div>
  )
}

// ── Reusable Input ────────────────────────────────────────────────

function InputField({
  icon,
  name,
  label,
  type = 'text',
  value,
  onChange,
  required,
  className,
  inputMode,
  maxLength,
}: {
  icon?: React.ReactNode
  name: string
  label: string
  type?: string
  value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  required?: boolean
  className?: string
  inputMode?: 'numeric' | 'text'
  maxLength?: number
}) {
  return (
    <div className={`flex flex-col ${className || ''}`}>
      <label htmlFor={name} className="text-xs font-medium text-[var(--sera-muted)] mb-1">
        {label}
        {required && ' *'}
      </label>
      <div className="relative">
        {icon && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--sera-muted)]/70">{icon}</span>
        )}
        <input
          id={name}
          name={name}
          type={type}
          value={value}
          onChange={onChange}
          required={required}
          inputMode={inputMode}
          maxLength={maxLength}
          className={`w-full h-10 rounded-lg border border-[var(--sera-line)] bg-white text-sm focus:outline-none focus:ring-2 focus:ring-gray-900/10 transition-shadow ${
            icon ? 'pl-10' : 'pl-3'
          } pr-3`}
        />
      </div>
    </div>
  )
}
