'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Copy, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { bundleItemsLabel, defaultOrderBumpText, type OutdoorBundle, type OutdoorCheckoutSettings } from '@/lib/outdoor/sales-tools'

type Variant = { id: string; productId: string; label: string; retailPrice: number | null }
type Bundle = OutdoorBundle & { isActive: boolean; sortOrder: number; complete: boolean }
type Affiliate = { id: string; code: string; name: string; kind: 'host' | 'affiliate'; commissionPercent: number; isActive: boolean; notes: string }
type Report = {
  from: string
  to: string
  rows: Array<{ affiliateId: string; orders: number; goods: number; commission: number }>
  orders: Array<{ orderRef: string; affiliateId: string; status: string; createdAt: string; goods: number }>
}
type Data = { settings: OutdoorCheckoutSettings; bundles: Bundle[]; affiliates: Affiliate[]; variants: Variant[]; report: Report }

const input = 'h-10 w-full rounded-md border border-[var(--out-line)] bg-white px-3 text-sm'
const button = 'inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[var(--out-bark)] px-4 text-sm font-semibold text-[var(--out-cream)] disabled:opacity-50'
const ghost = 'inline-flex h-10 items-center justify-center gap-2 rounded-md border border-[var(--out-line)] px-4 text-sm font-medium hover:bg-white disabled:opacity-50'

function money(amount: number) {
  return `RM ${amount.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** datetime-local value in Malaysia time. */
function toLocalInput(iso: string) {
  const d = new Date(Date.parse(iso) + 8 * 3600_000)
  return d.toISOString().slice(0, 16)
}

function fromLocalInput(value: string) {
  return value ? new Date(Date.parse(`${value}:00+08:00`)).toISOString() : ''
}

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="mt-8 rounded-2xl border border-[var(--out-line)] bg-white p-5 shadow-sm">
      <h2 className="font-display text-2xl tracking-tight">{title}</h2>
      {hint ? <p className="mt-1 text-sm text-[var(--out-muted)]">{hint}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm font-medium">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  )
}

const emptyBundle = { id: '', name: '', description: '', price: '', isActive: true, items: [{ variantId: '', quantity: 1 }, { variantId: '', quantity: 1 }] }
const emptyAffiliate = { id: '', code: '', name: '', kind: 'host' as 'host' | 'affiliate', commissionPercent: '0', isActive: true, notes: '' }

export default function OutdoorSalesToolsClient() {
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const [data, setData] = useState<Data | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [settings, setSettings] = useState({ share: '100', enabled: false, variantId: '', price: '', compare: '', text: '' })
  const [bundle, setBundle] = useState(emptyBundle)
  const [affiliate, setAffiliate] = useState(emptyAffiliate)
  const [range, setRange] = useState({ from: '', to: '' })

  const load = useCallback(async (from?: string, to?: string) => {
    setBusy(true)
    try {
      const params = new URLSearchParams()
      if (from) params.set('from', from)
      if (to) params.set('to', to)
      const res = await fetch(`/api/outdoor/sales-tools?${params}`)
      const json = await res.json().catch(() => null)
      if (res.status === 401) return setAllowed(false)
      if (!res.ok || !json) throw new Error(json?.error || 'Could not load.')
      setAllowed(true)
      setData(json)
      const s: OutdoorCheckoutSettings = json.settings
      setSettings({
        share: String(s.shippingCustomerSharePercent),
        enabled: s.orderBumpEnabled,
        variantId: s.orderBumpVariantId || '',
        price: s.orderBumpPrice == null ? '' : String(s.orderBumpPrice),
        compare: s.orderBumpComparePrice == null ? '' : String(s.orderBumpComparePrice),
        text: s.orderBumpText,
      })
      setRange({ from: toLocalInput(json.report.from), to: toLocalInput(json.report.to) })
    } catch (err: any) {
      setMessage({ ok: false, text: err.message || 'Could not load.' })
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (payload: Record<string, unknown>, done: string) => {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch('/api/outdoor/sales-tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(json?.error || 'Could not save.')
      setMessage({ ok: true, text: done })
      await load(fromLocalInput(range.from), fromLocalInput(range.to))
      return true
    } catch (err: any) {
      setMessage({ ok: false, text: err.message || 'Could not save.' })
      return false
    } finally {
      setBusy(false)
    }
  }

  if (allowed === null) return <div className="mx-auto max-w-6xl px-5 py-16 text-sm text-[var(--out-muted)]">Loading…</div>
  if (!allowed) return <div className="mx-auto max-w-6xl px-5 py-16 text-sm">This page is for Outdoor staff.</div>

  const variants = data?.variants || []
  const variantLabel = (id: string) => variants.find((v) => v.id === id)?.label || 'Product no longer on sale'
  const affiliateName = (id: string) => data?.affiliates.find((a) => a.id === id)?.name || '—'
  const bumpVariant = variants.find((v) => v.id === settings.variantId)
  const previewText =
    settings.text.trim() ||
    (bumpVariant && settings.price ? defaultOrderBumpText(Number(settings.price), bumpVariant.label, settings.compare ? Number(settings.compare) : null) : '')
  const shareNumber = Number(settings.share)
  const linkBase =
    typeof window === 'undefined' ? '' : `${window.location.origin}${window.location.pathname.startsWith('/outdoor') ? '/outdoor' : '/'}`
  const bundleRetail = bundle.items.reduce((sum, item) => sum + (variants.find((v) => v.id === item.variantId)?.retailPrice || 0) * item.quantity, 0)

  return (
    <div className="mx-auto max-w-6xl px-5 py-12 sm:px-8 sm:py-16">
      <Link href="/outdoor/admin" className="inline-flex items-center gap-1 text-sm text-[var(--out-muted)] hover:text-[var(--out-bark)]">
        <ArrowLeft className="h-4 w-4" aria-hidden /> Outdoor desk
      </Link>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl tracking-tight">Sales tools</h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--out-muted)]">
            Checkout offer, delivery subsidy, combos and live-host links for the Outdoor shop.
          </p>
        </div>
        <button type="button" className={ghost} disabled={busy} onClick={() => void load(fromLocalInput(range.from), fromLocalInput(range.to))}>
          <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} aria-hidden /> Refresh
        </button>
      </div>
      {message ? <p className={`mt-4 text-sm ${message.ok ? 'text-emerald-700' : 'text-red-600'}`}>{message.text}</p> : null}

      <Card title="Checkout offer & delivery" hint="The offer shows as a tick box on the checkout page. Delivery price comes from each product in Master Data.">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Customer pays (% of delivery price)">
            <input className={input} type="number" min="0" max="100" step="1" value={settings.share} onChange={(e) => setSettings({ ...settings, share: e.target.value })} />
          </Field>
          <p className="self-end text-xs text-[var(--out-muted)]">
            {Number.isFinite(shareNumber) && shareNumber < 100
              ? `Example: delivery RM 20.00 → customer pays ${money((20 * shareNumber) / 100)}, company covers ${money(20 - (20 * shareNumber) / 100)}.`
              : '100% = no subsidy (the customer pays the full delivery price).'}
          </p>
          <label className="flex items-center gap-2 text-sm font-medium md:col-span-2">
            <input type="checkbox" checked={settings.enabled} onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })} />
            Show the checkout offer
          </label>
          <Field label="Offer product">
            <select className={input} value={settings.variantId} onChange={(e) => setSettings({ ...settings, variantId: e.target.value })}>
              <option value="">Choose…</option>
              {variants.map((v) => (
                <option key={v.id} value={v.id}>{v.label}</option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Offer price (RM)">
              <input className={input} type="number" min="0" step="0.01" value={settings.price} placeholder="5" onChange={(e) => setSettings({ ...settings, price: e.target.value })} />
            </Field>
            <Field label="Original price (RM)">
              <input className={input} type="number" min="0" step="0.01" value={settings.compare} placeholder="25" onChange={(e) => setSettings({ ...settings, compare: e.target.value })} />
            </Field>
          </div>
          <div className="md:col-span-2">
            <Field label="Offer text (empty = automatic)">
              <input className={input} maxLength={200} value={settings.text} placeholder={previewText || 'Add RM5 only to get a 4L Dry Bag (Original Price RM25) - Tick Here'} onChange={(e) => setSettings({ ...settings, text: e.target.value })} />
            </Field>
            {previewText ? <p className="mt-2 rounded-xl border-2 border-dashed border-[var(--out-line)] px-3 py-2 text-sm">☐ {previewText}</p> : null}
          </div>
        </div>
        <button
          type="button"
          className={`${button} mt-4`}
          disabled={busy}
          onClick={() =>
            void save(
              {
                action: 'save_settings',
                shippingCustomerSharePercent: settings.share,
                orderBumpEnabled: settings.enabled,
                orderBumpVariantId: settings.variantId,
                orderBumpPrice: settings.price,
                orderBumpComparePrice: settings.compare,
                orderBumpText: settings.text,
              },
              'Checkout settings saved.',
            )
          }
        >
          Save
        </button>
      </Card>

      <Card title="Combos" hint="Sold at one price. Each item in the combo leaves warehouse stock on its own, so no new SKU is needed.">
        {data?.bundles.length ? (
          <ul className="divide-y divide-[var(--out-line)] rounded-xl border border-[var(--out-line)]">
            {data.bundles.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <p className="font-semibold">
                    {b.name} · {money(b.price)}
                    {b.comparePrice > b.price ? <span className="ml-2 text-xs text-[var(--out-muted)] line-through">{money(b.comparePrice)}</span> : null}
                  </p>
                  <p className="text-xs text-[var(--out-muted)]">
                    {bundleItemsLabel(b)} · {b.available == null ? 'stock unknown' : `${b.available} available`}
                    {!b.isActive ? ' · hidden' : ''}
                    {!b.complete ? ' · an item is no longer on sale (hidden from the shop)' : ''}
                  </p>
                </div>
                <button
                  type="button"
                  className={ghost}
                  onClick={() =>
                    setBundle({
                      id: b.id,
                      name: b.name,
                      description: b.description,
                      price: String(b.price),
                      isActive: b.isActive,
                      items: b.components.map((c) => ({ variantId: c.variantId, quantity: c.quantity })),
                    })
                  }
                >
                  Edit
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--out-muted)]">No combos yet.</p>
        )}

        <div className="mt-5 rounded-xl bg-[var(--out-cream)] p-4">
          <p className="text-sm font-semibold">{bundle.id ? 'Edit combo' : 'New combo'}</p>
          <div className="mt-3 grid gap-3 md:grid-cols-[1fr_160px]">
            <Field label="Name">
              <input className={input} maxLength={120} value={bundle.name} placeholder="Camping set" onChange={(e) => setBundle({ ...bundle, name: e.target.value })} />
            </Field>
            <Field label="Combo price (RM)">
              <input className={input} type="number" min="0" step="0.01" value={bundle.price} onChange={(e) => setBundle({ ...bundle, price: e.target.value })} />
            </Field>
            <div className="md:col-span-2">
              <Field label="Short text (optional)">
                <input className={input} maxLength={500} value={bundle.description} onChange={(e) => setBundle({ ...bundle, description: e.target.value })} />
              </Field>
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {bundle.items.map((item, index) => (
              <div key={index} className="flex gap-2">
                <select
                  className={input}
                  value={item.variantId}
                  onChange={(e) => setBundle({ ...bundle, items: bundle.items.map((x, i) => (i === index ? { ...x, variantId: e.target.value } : x)) })}
                >
                  <option value="">Choose item…</option>
                  {item.variantId && !variants.some((v) => v.id === item.variantId) ? <option value={item.variantId}>{variantLabel(item.variantId)}</option> : null}
                  {variants.map((v) => (
                    <option key={v.id} value={v.id}>{v.label}{v.retailPrice ? ` · ${money(v.retailPrice)}` : ''}</option>
                  ))}
                </select>
                <input
                  className={`${input} w-20`}
                  type="number"
                  min="1"
                  max="99"
                  value={item.quantity}
                  onChange={(e) => setBundle({ ...bundle, items: bundle.items.map((x, i) => (i === index ? { ...x, quantity: Number(e.target.value) || 1 } : x)) })}
                />
                <button
                  type="button"
                  className={ghost}
                  aria-label="Remove item"
                  onClick={() => setBundle({ ...bundle, items: bundle.items.filter((_, i) => i !== index) })}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ))}
            <button type="button" className={ghost} onClick={() => setBundle({ ...bundle, items: [...bundle.items, { variantId: '', quantity: 1 }] })}>
              <Plus className="h-4 w-4" aria-hidden /> Add item
            </button>
            {bundleRetail > 0 ? <p className="text-xs text-[var(--out-muted)]">Items bought one by one: {money(bundleRetail)}</p> : null}
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={bundle.isActive} onChange={(e) => setBundle({ ...bundle, isActive: e.target.checked })} />
            Show in the shop
          </label>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={async () => {
                const ok = await save({ action: 'save_bundle', ...bundle, items: bundle.items.filter((i) => i.variantId) }, 'Combo saved.')
                if (ok) setBundle(emptyBundle)
              }}
            >
              Save combo
            </button>
            {bundle.id ? (
              <button type="button" className={ghost} onClick={() => setBundle(emptyBundle)}>
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      </Card>

      <Card title="Live hosts & affiliates" hint="Each one gets a link. Orders placed within 30 days of opening the link count for them (the latest link wins).">
        {data?.affiliates.length ? (
          <div className="overflow-x-auto rounded-xl border border-[var(--out-line)]">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-[var(--out-line)] text-xs uppercase tracking-[0.12em] text-[var(--out-muted)]">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Link</th>
                  <th className="px-3 py-2">Commission</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {data.affiliates.map((a) => {
                  const link = `${linkBase}?ref=${a.code}`
                  return (
                    <tr key={a.id} className="border-b border-[var(--out-line)] last:border-0">
                      <td className="px-3 py-2">
                        <p className="font-semibold">{a.name}</p>
                        <p className="text-xs text-[var(--out-muted)]">{a.kind === 'host' ? 'Live host' : 'Affiliate'}{a.isActive ? '' : ' · off'}</p>
                      </td>
                      <td className="px-3 py-2">
                        <button type="button" className="inline-flex items-center gap-1 text-xs font-mono hover:underline" onClick={() => void navigator.clipboard?.writeText(link).then(() => setMessage({ ok: true, text: `Copied ${link}` }))}>
                          <Copy className="h-3.5 w-3.5" aria-hidden /> {link}
                        </button>
                      </td>
                      <td className="px-3 py-2">{a.commissionPercent}%</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          className={ghost}
                          onClick={() => setAffiliate({ ...a, commissionPercent: String(a.commissionPercent) })}
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-[var(--out-muted)]">No hosts or affiliates yet.</p>
        )}

        <div className="mt-5 grid gap-3 rounded-xl bg-[var(--out-cream)] p-4 md:grid-cols-4">
          <Field label="Name">
            <input className={input} maxLength={120} value={affiliate.name} onChange={(e) => setAffiliate({ ...affiliate, name: e.target.value })} />
          </Field>
          <Field label="Code (in the link)">
            <input className={input} maxLength={32} value={affiliate.code} placeholder="HOST-AINA" onChange={(e) => setAffiliate({ ...affiliate, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '') })} />
          </Field>
          <Field label="Type">
            <select className={input} value={affiliate.kind} onChange={(e) => setAffiliate({ ...affiliate, kind: e.target.value === 'affiliate' ? 'affiliate' : 'host' })}>
              <option value="host">Live host</option>
              <option value="affiliate">Affiliate</option>
            </select>
          </Field>
          <Field label="Commission (% of goods)">
            <input className={input} type="number" min="0" max="100" step="0.5" value={affiliate.commissionPercent} onChange={(e) => setAffiliate({ ...affiliate, commissionPercent: e.target.value })} />
          </Field>
          <label className="flex items-center gap-2 text-sm md:col-span-2">
            <input type="checkbox" checked={affiliate.isActive} onChange={(e) => setAffiliate({ ...affiliate, isActive: e.target.checked })} />
            Link active
          </label>
          <div className="flex gap-2 md:col-span-2 md:justify-end">
            {affiliate.id ? (
              <button type="button" className={ghost} onClick={() => setAffiliate(emptyAffiliate)}>
                Cancel
              </button>
            ) : null}
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={async () => {
                const ok = await save({ action: 'save_affiliate', ...affiliate }, 'Saved.')
                if (ok) setAffiliate(emptyAffiliate)
              }}
            >
              {affiliate.id ? 'Save' : 'Add'}
            </button>
          </div>
        </div>

        <div className="mt-6">
          <p className="text-sm font-semibold">Sales by host (Malaysia time)</p>
          <p className="text-xs text-[var(--out-muted)]">Set the live session start and end to see what each host sold in it. Paid orders only; goods exclude delivery.</p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Field label="From">
              <input className={input} type="datetime-local" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
            </Field>
            <Field label="To">
              <input className={input} type="datetime-local" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
            </Field>
            <button type="button" className={button} disabled={busy} onClick={() => void load(fromLocalInput(range.from), fromLocalInput(range.to))}>
              Show
            </button>
          </div>
          {data?.report.rows.length ? (
            <div className="mt-3 overflow-x-auto rounded-xl border border-[var(--out-line)]">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead className="border-b border-[var(--out-line)] text-xs uppercase tracking-[0.12em] text-[var(--out-muted)]">
                  <tr>
                    <th className="px-3 py-2">Host / affiliate</th>
                    <th className="px-3 py-2">Paid orders</th>
                    <th className="px-3 py-2">Goods</th>
                    <th className="px-3 py-2">Commission</th>
                  </tr>
                </thead>
                <tbody>
                  {data.report.rows.map((row) => (
                    <tr key={row.affiliateId} className="border-b border-[var(--out-line)] last:border-0">
                      <td className="px-3 py-2 font-semibold">{affiliateName(row.affiliateId)}</td>
                      <td className="px-3 py-2">{row.orders}</td>
                      <td className="px-3 py-2">{money(row.goods)}</td>
                      <td className="px-3 py-2">{money(row.commission)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-3 text-sm text-[var(--out-muted)]">No paid orders from host links in this period.</p>
          )}
          {data?.report.orders.length ? (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-[var(--out-muted)]">All orders from links ({data.report.orders.length})</summary>
              <ul className="mt-2 space-y-1">
                {data.report.orders.map((o) => (
                  <li key={o.orderRef} className="flex flex-wrap gap-x-3 text-xs">
                    <span className="font-mono">{o.orderRef}</span>
                    <span>{new Date(o.createdAt).toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' })}</span>
                    <span>{affiliateName(o.affiliateId)}</span>
                    <span>{money(o.goods)}</span>
                    <span className="text-[var(--out-muted)]">{o.status}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </Card>
    </div>
  )
}
