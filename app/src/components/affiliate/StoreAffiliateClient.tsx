'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Check, Copy, Link2, Loader2, Share2 } from 'lucide-react'
import {
  buildAffiliateLink,
  COMMISSION_STATUS_LABELS,
  maskAccountNo,
  normalizeSubId,
  type AffiliateCommissionStatus,
  type AffiliateStatus,
} from '@/lib/affiliate/program'

type Program = {
  open: boolean
  joinMode: 'open' | 'approval'
  commissionPercent: number | null
  attributionDays: number
  confirmAfterDays: number
  minPayoutAmount: number
  terms: string
}

type Account = {
  code: string
  name: string
  status: AffiliateStatus
  statusLabel: string
  reviewNote: string
  bankName: string
  bankAccountNo: string
  bankAccountName: string
}

type Commission = {
  order: string
  channel: string
  subId: string
  goods: number
  percent: number
  amount: number
  status: AffiliateCommissionStatus
  orderedAt: string
}

type Payout = { amount: number; count: number; reference: string; paidAt: string }

type Data = {
  signedIn: boolean
  program: Program
  affiliate: Account | null
  totals?: { pending: number; confirmed: number; paid: number; cancelled: number; orders: number }
  commissions?: Commission[]
  payouts?: Payout[]
}

type LinkProduct = { id: string; name: string; imageUrl: string | null; channel: 'store' | 'outdoor'; path: string }

const SIGNED_OUT_PROGRAM: Program = {
  open: false,
  joinMode: 'open',
  commissionPercent: null,
  attributionDays: 30,
  confirmAfterDays: 7,
  minPayoutAmount: 0,
  terms: '',
}

const card = 'rounded-2xl border border-[var(--sera-line)] bg-white p-5 sm:p-6'
const field = 'h-11 w-full rounded-xl border border-[var(--sera-line)] bg-white px-3 text-sm text-[var(--sera-ink)] focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]/25'
const primary =
  'inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[var(--sera-orange)] px-5 text-sm font-semibold text-white transition-colors hover:bg-[var(--sera-orange-deep)] disabled:opacity-50'
const secondary =
  'inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[var(--sera-line)] bg-white px-4 text-sm font-medium text-[var(--sera-ink)] transition-colors hover:bg-[var(--sera-mist)] disabled:opacity-50'

function rm(value: number) {
  return `RM ${(Number(value) || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function day(iso: string) {
  const at = Date.parse(iso)
  return Number.isFinite(at) ? new Date(at).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' }) : ''
}

function percentText(value: number | null) {
  return value == null ? '' : `${Number(value).toLocaleString('en-MY', { maximumFractionDigits: 2 })}%`
}

function Notice({ tone, children }: { tone: 'ok' | 'error' | 'info'; children: React.ReactNode }) {
  const styles = {
    ok: 'bg-green-50 text-green-700 border-green-200',
    error: 'bg-red-50 text-red-700 border-red-200',
    info: 'bg-[var(--sera-mist)] text-[var(--sera-ink)] border-[var(--sera-line)]',
  }
  return <div className={`rounded-xl border p-3 text-sm ${styles[tone]}`}>{children}</div>
}

function BankFields({
  value,
  onChange,
}: {
  value: { bankName: string; bankAccountNo: string; bankAccountName: string }
  onChange: (next: { bankName: string; bankAccountNo: string; bankAccountName: string }) => void
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="block text-sm font-medium text-[var(--sera-ink)]/80">
        Bank
        <input className={`${field} mt-1.5`} value={value.bankName} maxLength={80} placeholder="e.g. Maybank"
          onChange={(e) => onChange({ ...value, bankName: e.target.value })} />
      </label>
      <label className="block text-sm font-medium text-[var(--sera-ink)]/80">
        Account number
        <input className={`${field} mt-1.5`} value={value.bankAccountNo} inputMode="numeric" maxLength={30}
          onChange={(e) => onChange({ ...value, bankAccountNo: e.target.value })} />
      </label>
      <label className="block text-sm font-medium text-[var(--sera-ink)]/80 sm:col-span-2">
        Name on the account
        <input className={`${field} mt-1.5`} value={value.bankAccountName} maxLength={120}
          onChange={(e) => onChange({ ...value, bankAccountName: e.target.value })} />
      </label>
    </div>
  )
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className={secondary}
      disabled={!text}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1800)
        } catch {
          window.prompt('Copy this link', text)
        }
      }}
    >
      {done ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
      {done ? 'Copied' : label}
    </button>
  )
}

export default function StoreAffiliateClient() {
  const [data, setData] = useState<Data | null>(null)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [bank, setBank] = useState({ bankName: '', bankAccountNo: '', bankAccountName: '' })
  const [agree, setAgree] = useState(false)
  const [editBank, setEditBank] = useState(false)
  const [products, setProducts] = useState<LinkProduct[] | null>(null)
  const [productPath, setProductPath] = useState('')
  const [address, setAddress] = useState('')
  const [sub, setSub] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/affiliate/me', { cache: 'no-store' })
      const json = await res.json().catch(() => null)
      if (res.status === 401) {
        setData({ signedIn: false, program: SIGNED_OUT_PROGRAM, affiliate: null })
        return
      }
      if (!res.ok || !json) throw new Error(json?.error || 'Could not load.')
      setData(json)
      const a: Account | null = json.affiliate
      if (a) setBank({ bankName: a.bankName, bankAccountNo: a.bankAccountNo, bankAccountName: a.bankAccountName })
    } catch (err: any) {
      setLoadError(err.message || 'Could not load.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const approved = data?.affiliate?.status === 'approved' && data.program.open

  useEffect(() => {
    if (!approved || products) return
    fetch('/api/affiliate/me?links=1', { cache: 'no-store' })
      .then((res) => res.json())
      .then((json) => setProducts(Array.isArray(json?.products) ? json.products : []))
      .catch(() => setProducts([]))
  }, [approved, products])

  const post = async (payload: Record<string, unknown>, done: string) => {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch('/api/affiliate/me', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(json?.error || 'Could not save.')
      setMessage({ ok: true, text: done })
      setEditBank(false)
      await load()
    } catch (err: any) {
      setMessage({ ok: false, text: err.message || 'Could not save.' })
    } finally {
      setBusy(false)
    }
  }

  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const code = data?.affiliate?.code || ''
  const subId = normalizeSubId(sub)
  const target = address.trim() || (productPath ? `${origin}${productPath}` : `${origin}/store`)
  const link = useMemo(() => (code && origin ? buildAffiliateLink(target, code, subId) : ''), [code, origin, target, subId])
  const addressInvalid = Boolean(address.trim()) && !link

  if (loadError) {
    return (
      <Shell>
        <Notice tone="error">{loadError}</Notice>
      </Shell>
    )
  }
  if (!data) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[var(--sera-orange)]" />
      </div>
    )
  }

  const { program, affiliate } = data
  const rate = percentText(program.commissionPercent)

  if (!data.signedIn) {
    return (
      <Shell>
        <div className={card}>
          <h2 className="text-lg font-semibold text-[var(--sera-ink)]">Sign in to join</h2>
          <p className="mt-1 text-sm text-[var(--sera-muted)]">Use your store account to join the affiliate program and get your link.</p>
          <Link href="/login?next=/store/affiliate" className={`${primary} mt-4`}>Sign in</Link>
        </div>
      </Shell>
    )
  }

  if (!affiliate && !program.open) {
    return (
      <Shell>
        <Notice tone="info">The affiliate program is not open yet.</Notice>
      </Shell>
    )
  }

  const showJoin = !affiliate || affiliate.status === 'rejected'

  return (
    <Shell>
      {message ? <Notice tone={message.ok ? 'ok' : 'error'}>{message.text}</Notice> : null}

      {affiliate && affiliate.status === 'pending' ? (
        <Notice tone="info">Your application is waiting for approval. Your link starts working once it is approved.</Notice>
      ) : null}
      {affiliate && affiliate.status === 'suspended' ? (
        <Notice tone="error">
          Your affiliate account is suspended, so your link does not earn commission now.
          {affiliate.reviewNote ? ` ${affiliate.reviewNote}` : ''}
        </Notice>
      ) : null}
      {affiliate && affiliate.status === 'rejected' ? (
        <Notice tone="error">
          Your last application was not approved.{affiliate.reviewNote ? ` ${affiliate.reviewNote}` : ''} You can apply again below.
        </Notice>
      ) : null}
      {affiliate && affiliate.status === 'approved' && !program.open ? (
        <Notice tone="info">The affiliate program is paused. Links do not earn commission until it reopens.</Notice>
      ) : null}

      {showJoin && program.open ? (
        <div className={card}>
          <h2 className="text-lg font-semibold text-[var(--sera-ink)]">How it works</h2>
          <ul className="mt-3 space-y-2 text-sm text-[var(--sera-muted)]">
            <li>1. Share your link to any Serapod product or page.</li>
            <li>
              2. When someone opens your link and pays within {program.attributionDays} days, the order is yours
              {rate ? `: you earn ${rate} of the products' price (delivery not included)` : ''}.
            </li>
            <li>3. Commission is confirmed {program.confirmAfterDays} days after the order is delivered. Cancelled or refunded orders earn nothing.</li>
            <li>4. We pay confirmed commission to your bank account by transfer{program.minPayoutAmount > 0 ? ` once it reaches ${rm(program.minPayoutAmount)}` : ''}.</li>
          </ul>
          {program.joinMode === 'approval' ? (
            <p className="mt-3 text-sm text-[var(--sera-muted)]">We review each application before the link starts working.</p>
          ) : null}

          <h3 className="mt-6 text-sm font-semibold text-[var(--sera-ink)]">Bank account for payouts</h3>
          <div className="mt-3">
            <BankFields value={bank} onChange={setBank} />
          </div>

          {program.terms ? (
            <div className="mt-6 max-h-48 overflow-y-auto whitespace-pre-line rounded-xl border border-[var(--sera-line)] bg-[var(--sera-paper)] p-3 text-xs text-[var(--sera-muted)]">
              {program.terms}
            </div>
          ) : null}
          <label className="mt-4 flex items-start gap-2 text-sm text-[var(--sera-ink)]/80">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--sera-orange)]" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>I agree to the affiliate program terms.</span>
          </label>
          <button
            type="button"
            className={`${primary} mt-5 w-full sm:w-auto`}
            disabled={busy || !agree}
            onClick={() =>
              post({ action: 'join', agree, ...bank }, program.joinMode === 'approval' ? 'Application sent.' : 'You have joined. Your link is ready.')
            }
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {program.joinMode === 'approval' ? 'Apply' : 'Join'}
          </button>
        </div>
      ) : null}

      {approved ? (
        <>
          <div className={card}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-[var(--sera-muted)]">Your code</p>
                <p className="font-display text-2xl font-semibold text-[var(--sera-ink)]">{code}</p>
              </div>
              {rate ? (
                <span className="rounded-full bg-[var(--sera-orange)]/10 px-3 py-1 text-sm font-semibold text-[var(--sera-orange)]">
                  {rate} commission
                </span>
              ) : null}
            </div>

            <h2 className="mt-6 flex items-center gap-2 text-sm font-semibold text-[var(--sera-ink)]">
              <Link2 className="h-4 w-4" /> Make a link
            </h2>
            <div className="mt-3 grid gap-4">
              <label className="block text-sm font-medium text-[var(--sera-ink)]/80">
                Product
                <select
                  className={`${field} mt-1.5`}
                  value={productPath}
                  onChange={(e) => {
                    setProductPath(e.target.value)
                    setAddress('')
                  }}
                >
                  <option value="">Serapod Store home</option>
                  {(products || []).map((p) => (
                    <option key={`${p.channel}-${p.id}`} value={p.path}>
                      {p.name}
                      {p.channel === 'outdoor' ? ' (Outdoor)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-sm font-medium text-[var(--sera-ink)]/80">
                Or paste any Serapod page address
                <input className={`${field} mt-1.5`} value={address} placeholder={`${origin}/store/products/…`}
                  onChange={(e) => setAddress(e.target.value)} />
                {addressInvalid ? <span className="mt-1 block text-xs text-red-600">Paste an address from the Serapod site.</span> : null}
              </label>
              <label className="block text-sm font-medium text-[var(--sera-ink)]/80">
                Where will you post it? <span className="font-normal text-[var(--sera-muted)]">(optional, e.g. tiktok, instagram)</span>
                <input className={`${field} mt-1.5`} value={sub} maxLength={40} placeholder="tiktok"
                  onChange={(e) => setSub(e.target.value.replace(/[^A-Za-z0-9_-]/g, ''))} />
                <span className="mt-1 block text-xs text-[var(--sera-muted)]">Shown next to each order so you can see which post sold it.</span>
              </label>
            </div>
            <div className="mt-4 break-all rounded-xl bg-[var(--sera-mist)] p-3 text-sm text-[var(--sera-ink)]">{link || '—'}</div>
            <div className="mt-3 flex flex-wrap gap-2">
              <CopyButton text={link} label="Copy link" />
              {typeof navigator !== 'undefined' && 'share' in navigator ? (
                <button type="button" className={secondary} disabled={!link}
                  onClick={() => navigator.share({ url: link }).catch(() => undefined)}>
                  <Share2 className="h-4 w-4" /> Share
                </button>
              ) : null}
            </div>
          </div>
        </>
      ) : null}

      {affiliate && affiliate.status !== 'rejected' && data.totals ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { label: 'Pending', value: data.totals.pending, hint: 'Paid orders not confirmed yet' },
              { label: 'Confirmed', value: data.totals.confirmed, hint: 'Waiting for the next transfer' },
              { label: 'Paid to you', value: data.totals.paid, hint: 'Transferred to your bank' },
            ].map((box) => (
              <div key={box.label} className={card}>
                <p className="text-xs uppercase tracking-wide text-[var(--sera-muted)]">{box.label}</p>
                <p className="mt-1 font-display text-xl font-semibold text-[var(--sera-ink)]">{rm(box.value)}</p>
                <p className="mt-1 text-xs text-[var(--sera-muted)]">{box.hint}</p>
              </div>
            ))}
          </div>

          <div className={card}>
            <h2 className="text-sm font-semibold text-[var(--sera-ink)]">Orders from your links</h2>
            {data.commissions && data.commissions.length > 0 ? (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-sm">
                  <thead className="text-xs uppercase text-[var(--sera-muted)]">
                    <tr>
                      <th className="py-2 pr-3">Date</th>
                      <th className="py-2 pr-3">Order</th>
                      <th className="py-2 pr-3">Post</th>
                      <th className="py-2 pr-3 text-right">Products</th>
                      <th className="py-2 pr-3 text-right">Commission</th>
                      <th className="py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--sera-line)]">
                    {data.commissions.map((c, i) => (
                      <tr key={`${c.order}-${i}`}>
                        <td className="py-2 pr-3 whitespace-nowrap">{day(c.orderedAt)}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">{c.channel} {c.order}</td>
                        <td className="py-2 pr-3">{c.subId || '—'}</td>
                        <td className="py-2 pr-3 text-right whitespace-nowrap">{rm(c.goods)}</td>
                        <td className="py-2 pr-3 text-right whitespace-nowrap font-medium">{rm(c.amount)}</td>
                        <td className="py-2 whitespace-nowrap">{COMMISSION_STATUS_LABELS[c.status] || c.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-2 text-sm text-[var(--sera-muted)]">No orders from your links yet.</p>
            )}
          </div>

          {data.payouts && data.payouts.length > 0 ? (
            <div className={card}>
              <h2 className="text-sm font-semibold text-[var(--sera-ink)]">Transfers</h2>
              <ul className="mt-3 divide-y divide-[var(--sera-line)] text-sm">
                {data.payouts.map((p, i) => (
                  <li key={`${p.reference}-${i}`} className="flex flex-wrap justify-between gap-2 py-2">
                    <span>{day(p.paidAt)} · Ref {p.reference}</span>
                    <span className="font-medium">{rm(p.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className={card}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-[var(--sera-ink)]">Bank account for payouts</h2>
              {!editBank ? (
                <button type="button" className="text-sm font-medium text-[var(--sera-orange)]" onClick={() => setEditBank(true)}>
                  Change
                </button>
              ) : null}
            </div>
            {editBank ? (
              <>
                <div className="mt-3">
                  <BankFields value={bank} onChange={setBank} />
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" className={primary} disabled={busy} onClick={() => post({ action: 'update_bank', ...bank }, 'Bank details saved.')}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    Save
                  </button>
                  <button
                    type="button"
                    className={secondary}
                    onClick={() => {
                      setEditBank(false)
                      setBank({ bankName: affiliate.bankName, bankAccountNo: affiliate.bankAccountNo, bankAccountName: affiliate.bankAccountName })
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <p className="mt-2 text-sm text-[var(--sera-muted)]">
                {affiliate.bankName ? `${affiliate.bankName} · ${maskAccountNo(affiliate.bankAccountNo)} · ${affiliate.bankAccountName}` : 'Not added yet.'}
              </p>
            )}
          </div>
        </>
      ) : null}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
      <Link href="/store/account" className="mb-6 inline-flex items-center gap-1 text-sm text-[var(--sera-muted)] hover:text-[var(--sera-ink)]/80">
        <ArrowLeft className="h-4 w-4" />
        My Account
      </Link>
      <h1 className="font-display text-2xl font-semibold text-[var(--sera-ink)]">Affiliate program</h1>
      <p className="mt-1 mb-6 text-sm text-[var(--sera-muted)]">Share Serapod products with your own link and earn commission on paid orders.</p>
      <div className="space-y-5">{children}</div>
    </div>
  )
}
