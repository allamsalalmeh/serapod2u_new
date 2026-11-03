'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, CreditCard, Loader2, Package, Truck } from 'lucide-react'
import StoreOrderRequestDialog from '@/components/storefront/StoreOrderRequestDialog'
import {
  ORDER_REQUEST_CUSTOMER_LABELS,
  ORDER_REQUEST_TYPE_LABELS,
  canRaiseOrderRequest,
  isOpenOrderRequest,
  type OrderRequestView,
} from '@/lib/storefront/order-requests'

export type StoreOrderRow = {
  orderRef: string
  status: string
  totalAmount: number
  currency: string
  createdAt: string
  itemCount: number
  preview: string[]
  shippingTrackingNo?: string | null
  shippingCourierName?: string | null
}

const STATUS: Record<string, { label: string; tone: string }> = {
  pending_payment: { label: 'Waiting for payment', tone: 'bg-amber-50 text-amber-800 ring-amber-200' },
  payment_failed: { label: 'Payment failed', tone: 'bg-red-50 text-red-700 ring-red-200' },
  paid: { label: 'Paid', tone: 'bg-sky-50 text-sky-800 ring-sky-200' },
  processing: { label: 'Preparing your order', tone: 'bg-sky-50 text-sky-800 ring-sky-200' },
  shipped: { label: 'On the way', tone: 'bg-violet-50 text-violet-800 ring-violet-200' },
  delivered: { label: 'Delivered', tone: 'bg-emerald-50 text-emerald-800 ring-emerald-200' },
  cancelled: { label: 'Cancelled', tone: 'bg-[var(--sera-mist)] text-[var(--sera-muted)] ring-[var(--sera-line)]' },
  refunded: { label: 'Refunded', tone: 'bg-orange-50 text-orange-800 ring-orange-200' },
}

function money(amount: number, currency = 'MYR') {
  return new Intl.NumberFormat('en-MY', { style: 'currency', currency }).format(Number(amount) || 0)
}

function placedOn(iso: string) {
  const at = Date.parse(iso)
  return Number.isFinite(at)
    ? new Date(at).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' })
    : ''
}

/** The signed-in shopper's Serapod2U Store orders ("My Purchases"). */
export default function StoreOrdersClient() {
  const [orders, setOrders] = useState<StoreOrderRow[] | null>(null)
  const [signedOut, setSignedOut] = useState(false)
  const [error, setError] = useState('')
  const [requests, setRequests] = useState<OrderRequestView[]>([])
  const [requestsAvailable, setRequestsAvailable] = useState(false)
  const [reportFor, setReportFor] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [paying, setPaying] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const res = await fetch('/api/storefront/orders/mine?channel=store', { cache: 'no-store' })
      const data = await res.json().catch(() => null)
      if (res.status === 401) {
        setSignedOut(true)
        setOrders([])
        return
      }
      if (!res.ok || !data) throw new Error(data?.error || 'Could not load your orders.')
      setOrders(Array.isArray(data.orders) ? data.orders : [])
    } catch (err: any) {
      setError(err.message || 'Could not load your orders.')
      setOrders([])
    }
    try {
      const res = await fetch('/api/storefront/requests?channel=store', { cache: 'no-store' })
      const data = await res.json().catch(() => null)
      if (res.ok && data) {
        setRequestsAvailable(data.available !== false)
        setRequests(Array.isArray(data.requests) ? data.requests : [])
      }
    } catch {
      // Orders still show without the request history.
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const continuePayment = async (orderRef: string) => {
    setPaying(orderRef)
    setError('')
    try {
      const res = await fetch('/api/storefront/orders/resume-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderRef }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || 'Could not continue payment.')
      window.location.assign(data?.paymentUrl || `/store/orders/success?ref=${encodeURIComponent(orderRef)}`)
    } catch (err: any) {
      setError(err.message || 'Could not continue payment.')
      setPaying(null)
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
      <Link href="/store/account" className="mb-6 inline-flex items-center gap-1 text-sm text-[var(--sera-muted)] hover:text-[var(--sera-ink)]/80">
        <ArrowLeft className="h-4 w-4" />
        My Account
      </Link>
      <h1 className="font-display text-2xl font-semibold text-[var(--sera-ink)]">My Purchases</h1>
      <p className="mt-1 mb-8 text-sm text-[var(--sera-muted)]">Your orders from the Serapod Store.</p>

      {orders === null ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--sera-orange)]" />
        </div>
      ) : signedOut ? (
        <div className="rounded-2xl border border-[var(--sera-line)] bg-white p-6 text-center">
          <p className="text-sm text-[var(--sera-muted)]">Sign in to see your orders.</p>
          <Link
            href="/login?next=/store/orders"
            className="mt-4 inline-flex h-11 items-center justify-center rounded-xl bg-[var(--sera-orange)] px-6 text-sm font-semibold text-white hover:bg-[var(--sera-orange-deep)]"
          >
            Sign in
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {notice ? (
            <p className="rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-700">{notice}</p>
          ) : null}
          {error ? <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}

          {orders.length === 0 && !error ? (
            <div className="rounded-2xl border border-[var(--sera-line)] bg-white p-8 text-center">
              <Package className="mx-auto h-10 w-10 text-[var(--sera-muted)]/50" />
              <p className="mt-3 text-sm font-semibold text-[var(--sera-ink)]">No orders yet</p>
              <p className="mt-1 text-sm text-[var(--sera-muted)]">Orders you place in the store show up here.</p>
              <Link
                href="/store/products"
                className="mt-5 inline-flex h-11 items-center justify-center rounded-xl bg-[var(--sera-orange)] px-6 text-sm font-semibold text-white hover:bg-[var(--sera-orange-deep)]"
              >
                Browse products
              </Link>
            </div>
          ) : null}

          {orders.map((order) => {
            const status = STATUS[order.status] || { label: order.status.replace(/_/g, ' '), tone: 'bg-[var(--sera-mist)] text-[var(--sera-muted)] ring-[var(--sera-line)]' }
            const latestRequest = requests.find((request) => request.orderRef === order.orderRef)
            const hasOpenRequest = Boolean(latestRequest && isOpenOrderRequest(latestRequest.status))
            const canReport = requestsAvailable && !hasOpenRequest && canRaiseOrderRequest(order.status)
            const extra = order.itemCount - order.preview.length
            return (
              <div key={order.orderRef} className="rounded-2xl border border-[var(--sera-line)] bg-white p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-mono text-sm font-semibold text-[var(--sera-ink)]">{order.orderRef}</p>
                    <p className="mt-0.5 text-xs text-[var(--sera-muted)]">
                      Placed {placedOn(order.createdAt)} · {order.itemCount} item{order.itemCount === 1 ? '' : 's'}
                    </p>
                  </div>
                  <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${status.tone}`}>{status.label}</span>
                </div>

                {order.preview.length ? (
                  <p className="mt-3 text-sm text-[var(--sera-ink)]">
                    {order.preview.join(', ')}
                    {extra > 0 ? <span className="text-[var(--sera-muted)]"> and more</span> : null}
                  </p>
                ) : null}

                {order.shippingTrackingNo || order.shippingCourierName ? (
                  <p className="mt-3 flex items-center gap-2 text-xs text-[var(--sera-muted)]">
                    <Truck className="h-4 w-4 flex-none" />
                    <span>
                      {order.shippingCourierName || 'Courier'}
                      {order.shippingTrackingNo ? (
                        <>
                          {' · '}tracking <span className="font-mono text-[var(--sera-ink)]">{order.shippingTrackingNo}</span>
                        </>
                      ) : null}
                    </span>
                  </p>
                ) : null}

                {latestRequest ? (
                  <div className="mt-3 rounded-xl bg-[var(--sera-mist)]/60 px-3 py-2 text-xs">
                    <p>
                      <span className="font-semibold text-[var(--sera-ink)]">{ORDER_REQUEST_TYPE_LABELS[latestRequest.type]}</span>
                      <span className="text-[var(--sera-muted)]"> · {latestRequest.requestNo} · </span>
                      <span className="font-semibold text-[var(--sera-orange)]">{ORDER_REQUEST_CUSTOMER_LABELS[latestRequest.status]}</span>
                    </p>
                    {latestRequest.staffReply ? (
                      <p className="mt-1 whitespace-pre-line text-[var(--sera-ink)]">
                        <span className="font-semibold">Our reply: </span>
                        {latestRequest.staffReply}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--sera-line)] pt-4">
                  <p className="text-sm font-semibold text-[var(--sera-ink)]">{money(order.totalAmount, order.currency)}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    {canReport ? (
                      <button
                        type="button"
                        onClick={() => {
                          setNotice('')
                          setReportFor(order.orderRef)
                        }}
                        className="h-9 rounded-xl border border-[var(--sera-line)] px-4 text-xs font-semibold text-[var(--sera-ink)] hover:bg-[var(--sera-mist)]"
                      >
                        Report a problem
                      </button>
                    ) : null}
                    {order.status === 'pending_payment' ? (
                      <button
                        type="button"
                        onClick={() => void continuePayment(order.orderRef)}
                        disabled={paying !== null}
                        className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-[var(--sera-orange)] px-4 text-xs font-semibold text-white hover:bg-[var(--sera-orange-deep)] disabled:opacity-50"
                      >
                        {paying === order.orderRef ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CreditCard className="h-3.5 w-3.5" />}
                        Continue payment
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {reportFor ? (
        <StoreOrderRequestDialog
          orderRef={reportFor}
          onClose={() => setReportFor(null)}
          onSent={(request) => {
            setRequests((current) => [request, ...current])
            setReportFor(null)
            setNotice(`Request ${request.requestNo} sent. We will reply by email.`)
          }}
        />
      ) : null}
    </div>
  )
}
