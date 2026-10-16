'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  ClipboardList,
  ExternalLink,
  Eye,
  Hourglass,
  Inbox,
  LifeBuoy,
  Mail,
  Package,
  Pencil,
  RefreshCw,
  Send,
  Store,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react'
import {
  mainAppHref,
  OUTDOOR_DESK_STATUS_LABELS,
  OUTDOOR_LOW_STOCK,
  outdoorProductEditHref,
  outdoorProductPreviewHref,
  type OutdoorDeskData,
  type OutdoorDeskProductStatus,
} from '@/lib/outdoor/desk'
import { MIN_RETAIL_PRICE } from '@/lib/storefront/price-rules'

const STATUS_CLASS: Record<OutdoorDeskProductStatus, string> = {
  live: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  sold_out: 'bg-red-50 text-red-700 ring-red-200',
  hidden_no_price: 'bg-amber-50 text-amber-800 ring-amber-200',
}

function money(amount: number) {
  return `RM ${amount.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`
}

function adminHref(path: string) {
  return mainAppHref(path, typeof window === 'undefined' ? null : window.location)
}

function SummaryCard({
  label,
  value,
  hint,
  href,
  icon: Icon,
  urgent,
}: {
  label: string
  value: string
  hint?: string
  href?: string
  icon: LucideIcon
  urgent?: boolean
}) {
  const body = (
    <>
      <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--out-muted)]">
        <Icon className="h-4 w-4" aria-hidden />
        {label}
      </span>
      <span className={`mt-2 block font-display text-3xl tracking-tight ${urgent ? 'text-[var(--out-ember)]' : ''}`}>{value}</span>
      {hint ? <span className="mt-1 block text-xs text-[var(--out-muted)]">{hint}</span> : null}
    </>
  )
  const className = 'block rounded-2xl border border-[var(--out-line)] bg-white p-4 shadow-sm'
  return href ? (
    <Link href={href} className={`${className} transition hover:-translate-y-px hover:shadow`}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  )
}

export default function OutdoorAdminClient() {
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [desk, setDesk] = useState<OutdoorDeskData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const loadDesk = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/outdoor/desk')
      const data = await res.json().catch(() => null)
      if (res.status === 401) {
        setAllowed(false)
        return
      }
      if (!res.ok || !data) throw new Error(data?.error || 'Could not load the desk.')
      setDesk(data)
    } catch (err: any) {
      setError(err.message || 'Could not load the desk.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const load = async () => {
      const access = await fetch('/api/outdoor/fulfilment/access')
      const accessData = await access.json().catch(() => null)
      if (!accessData?.allowed) {
        setAllowed(false)
        return
      }
      setAllowed(true)
      await loadDesk()
    }
    void load()
  }, [loadDesk])

  if (allowed === null) return <div className="mx-auto max-w-6xl px-5 py-16 text-sm text-[var(--out-muted)]">Loading…</div>
  if (!allowed) return <div className="mx-auto max-w-6xl px-5 py-16 text-sm text-[var(--out-bark)]">This desk is for Outdoor staff.</div>

  const summary = desk?.summary
  const products = desk?.products || []
  const hidden = products.filter((p) => p.status === 'hidden_no_price').length
  const soldOut = products.filter((p) => p.status === 'sold_out').length
  const stockPhoto = products.filter((p) => !p.hasOwnPhoto).length

  return (
    <div className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--out-muted)]">Admin</p>
          <h1 className="mt-2 font-display text-4xl tracking-tight">Outdoor desk</h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--out-muted)]">
            What needs doing today, and how each Outdoor product shows in the shop. Prices, photos and stock are
            set in the main admin.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/outdoor/admin/sales-tools"
            className="inline-flex h-10 items-center gap-2 rounded-md bg-[var(--out-bark)] px-4 text-sm font-semibold text-[var(--out-cream)]"
          >
            <TrendingUp className="h-4 w-4" aria-hidden />
            Sales tools
          </Link>
          <Link
            href="/outdoor/shop"
            className="inline-flex h-10 items-center gap-2 rounded-md border border-[var(--out-line)] px-4 text-sm font-medium hover:bg-white"
          >
            <Store className="h-4 w-4" aria-hidden />
            Preview shop
          </Link>
          <button
            type="button"
            onClick={() => void loadDesk()}
            disabled={loading}
            className="inline-flex h-10 items-center gap-2 rounded-md border border-[var(--out-line)] px-4 text-sm font-medium hover:bg-white disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error ? <p className="mt-6 text-sm text-red-600">{error}</p> : null}

      {summary ? (
        <div className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <SummaryCard
            label="To send out"
            value={String(summary.toSend)}
            hint="Paid, waiting to ship"
            href="/outdoor/fulfilment"
            icon={Send}
            urgent={summary.toSend > 0}
          />
          <SummaryCard
            label="Awaiting payment"
            value={String(summary.awaitingPayment)}
            hint="Checkout not paid yet"
            href="/outdoor/fulfilment?status=pending_payment"
            icon={Hourglass}
          />
          <SummaryCard
            label="Open requests"
            value={summary.openRequests == null ? '—' : String(summary.openRequests)}
            hint="Returns and order help"
            href="/outdoor/fulfilment?tab=requests"
            icon={LifeBuoy}
            urgent={(summary.openRequests || 0) > 0}
          />
          <SummaryCard
            label="Messages"
            value={summary.messagesThisWeek == null ? '—' : String(summary.messagesThisWeek)}
            hint="Last 7 days"
            href="/outdoor/fulfilment?tab=inbox"
            icon={Inbox}
          />
          <SummaryCard
            label="Sales this month"
            value={money(summary.salesThisMonth.amount)}
            hint={plural(summary.salesThisMonth.orders, 'paid order', 'paid orders')}
            icon={TrendingUp}
          />
        </div>
      ) : null}

      {hidden + soldOut + stockPhoto > 0 ? (
        <ul className="mt-6 space-y-2 text-sm">
          {hidden > 0 ? (
            <li className="rounded-xl bg-amber-50 px-4 py-3 text-amber-900">
              {plural(hidden, 'product is', 'products are')} hidden from the shop: no retail price, or a price under RM{' '}
              {MIN_RETAIL_PRICE.toFixed(2)}. Set the price in the main admin to show {hidden === 1 ? 'it' : 'them'}.
            </li>
          ) : null}
          {soldOut > 0 ? (
            <li className="rounded-xl bg-red-50 px-4 py-3 text-red-800">
              {plural(soldOut, 'product is', 'products are')} sold out in the online shop warehouse. Customers can
              see {soldOut === 1 ? 'it' : 'them'} but cannot buy.
            </li>
          ) : null}
          {stockPhoto > 0 ? (
            <li className="rounded-xl bg-slate-100 px-4 py-3 text-slate-700">
              {plural(stockPhoto, 'product shows', 'products show')} a standard picture because no photo is uploaded.
              Add a real photo in the main admin.
            </li>
          ) : null}
        </ul>
      ) : null}

      <section className="mt-10">
        <h2 className="flex items-center gap-2 font-display text-2xl tracking-tight">
          <Package className="h-5 w-5" aria-hidden />
          Products{desk ? ` (${products.length})` : ''}
        </h2>
        {desk && products.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--out-muted)]">No Outdoor products yet.</p>
        ) : null}
        {products.length > 0 ? (
          <div className="mt-4 overflow-x-auto rounded-2xl border border-[var(--out-line)] bg-white shadow-sm">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-[var(--out-line)] text-xs uppercase tracking-[0.12em] text-[var(--out-muted)]">
                <tr>
                  <th className="px-4 py-3 font-semibold">Product</th>
                  <th className="px-4 py-3 font-semibold">Price</th>
                  <th className="px-4 py-3 font-semibold">Stock</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.id} className="border-b border-[var(--out-line)] last:border-0">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-[var(--out-cream)]">
                          {product.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={product.imageUrl} alt="" className="h-full w-full object-cover" />
                          ) : null}
                        </div>
                        <div className="min-w-0">
                          <p className="font-semibold">{product.name}</p>
                          <p className="text-xs text-[var(--out-muted)]">
                            {product.code}
                            {product.variantCount > 1 ? ` · ${product.variantCount} options` : ''}
                            {product.hasOwnPhoto ? '' : ' · standard picture'}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">{product.price != null && product.price > 0 ? money(product.price) : '—'}</td>
                    <td
                      className={`px-4 py-3 whitespace-nowrap ${
                        product.stock != null && product.stock > 0 && product.stock <= OUTDOOR_LOW_STOCK ? 'font-semibold text-amber-700' : ''
                      }`}
                    >
                      {product.stock == null ? '—' : product.stock}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${STATUS_CLASS[product.status]}`}>
                        {OUTDOOR_DESK_STATUS_LABELS[product.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        {product.status === 'hidden_no_price' ? null : (
                          <Link
                            href={outdoorProductPreviewHref(product.id)}
                            className="inline-flex h-9 items-center gap-1.5 rounded-md border border-[var(--out-line)] px-3 text-xs font-semibold hover:bg-[var(--out-cream)]"
                          >
                            <Eye className="h-3.5 w-3.5" aria-hidden />
                            Preview
                          </Link>
                        )}
                        <a
                          href={adminHref(outdoorProductEditHref(product.id))}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--out-bark)] px-3 text-xs font-semibold text-[var(--out-cream)]"
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden />
                          Edit
                        </a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="mt-10">
        <h2 className="font-display text-2xl tracking-tight">Main admin</h2>
        <p className="mt-1 text-sm text-[var(--out-muted)]">Opens in a new tab. You may need to sign in there.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: 'All Outdoor orders', path: '/ecommerce/store-orders?channel=outdoor', icon: ClipboardList },
            {
              label: `Newsletter${desk ? ` · ${plural(desk.subscribers, 'subscriber', 'subscribers')}` : ''}`,
              path: '/ecommerce/store-orders?tab=subscribers',
              icon: Mail,
            },
            { label: 'Customer emails & SMS', path: '/ecommerce/store-orders?tab=customer_messages', icon: Inbox },
            { label: 'All products', path: '/supply-chain/products', icon: Package },
          ].map(({ label, path, icon: Icon }) => (
            <a
              key={path}
              href={adminHref(path)}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--out-line)] bg-white px-4 py-3 text-sm font-semibold shadow-sm transition hover:-translate-y-px hover:shadow"
            >
              <span className="flex items-center gap-2">
                <Icon className="h-4 w-4" aria-hidden />
                {label}
              </span>
              <ExternalLink className="h-4 w-4 text-[var(--out-muted)]" aria-hidden />
            </a>
          ))}
        </div>
      </section>
    </div>
  )
}
