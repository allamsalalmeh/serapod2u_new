'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Check, Copy, Loader2, Search, Share2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
  termsVersion: number
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
  termsVersionAccepted: number | null
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
  email?: string
  program: Program
  affiliate: Account | null
  totals?: { pending: number; confirmed: number; paid: number; cancelled: number; orders: number }
  commissions?: Commission[]
  payouts?: Payout[]
}

type LinkProduct = { id: string; name: string; imageUrl: string | null; channel: 'store' | 'outdoor'; path: string }

type BankForm = { bankName: string; bankAccountNo: string; bankAccountName: string }

const SIGNED_OUT_PROGRAM: Program = {
  open: false,
  joinMode: 'open',
  commissionPercent: null,
  attributionDays: 30,
  confirmAfterDays: 7,
  minPayoutAmount: 0,
  terms: '',
  termsVersion: 1,
}

const card = 'rounded-2xl border border-[var(--sera-line)] bg-[var(--sera-surface)] p-5 sm:p-6'
const field = 'h-11 rounded-xl'

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

function mediaUrl(raw: string | null) {
  if (!raw) return null
  if (/\.(mp4|webm|mov)(\?|$)/i.test(raw)) return null
  if (/^https?:\/\//.test(raw)) return raw
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!base) return null
  const path = raw.replace(/^\/+/, '')
  const bucket = ['product-variants', 'avatars'].find((b) => path.startsWith(`${b}/`))
  return bucket
    ? `${base}/storage/v1/object/public/${bucket}/${path.slice(bucket.length + 1)}`
    : `${base}/storage/v1/object/public/avatars/${path}`
}

function Notice({ tone, children }: { tone: 'ok' | 'error'; children: React.ReactNode }) {
  return (
    <div className={`rounded-xl border p-3 text-sm ${tone === 'ok' ? 'border-green-200 bg-green-50 text-green-700' : 'border-red-200 bg-red-50 text-red-700'}`}>
      {children}
    </div>
  )
}

function BankFields({ value, onChange }: { value: BankForm; onChange: (next: BankForm) => void }) {
  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label className="text-sm font-medium text-[var(--sera-ink)]/80">Bank</Label>
        <Input className={field} value={value.bankName} maxLength={80} placeholder="Maybank, CIMB…"
          onChange={(e) => onChange({ ...value, bankName: e.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label className="text-sm font-medium text-[var(--sera-ink)]/80">Account number</Label>
        <Input className={`${field} tabular-nums`} value={value.bankAccountNo} inputMode="numeric" maxLength={30} placeholder="Digits only"
          onChange={(e) => onChange({ ...value, bankAccountNo: e.target.value })} />
      </div>
      <div className="space-y-1.5">
        <Label className="text-sm font-medium text-[var(--sera-ink)]/80">Name on the account</Label>
        <Input className={field} value={value.bankAccountName} maxLength={120} placeholder="As shown on your statement"
          onChange={(e) => onChange({ ...value, bankAccountName: e.target.value })} />
      </div>
    </div>
  )
}

function CopyButton({ text, label = 'Copy link' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      type="button"
      disabled={!text}
      className="h-11 rounded-xl bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange-deep)]"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 2000)
        } catch {
          window.prompt('Copy this link', text)
        }
      }}
    >
      {done ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
      {done ? 'Copied' : label}
    </Button>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:py-12">
      <Link href="/store/account" className="mb-6 inline-flex items-center gap-1 text-sm text-[var(--sera-muted)] hover:text-[var(--sera-ink)]">
        <ArrowLeft className="h-4 w-4" />
        Back
      </Link>
      <div className="space-y-6">{children}</div>
    </div>
  )
}

export default function StoreAffiliateClient() {
  const [data, setData] = useState<Data | null>(null)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [bank, setBank] = useState<BankForm>({ bankName: '', bankAccountNo: '', bankAccountName: '' })
  const [agree, setAgree] = useState(false)
  const [editBank, setEditBank] = useState(false)
  const [products, setProducts] = useState<LinkProduct[] | null>(null)
  const [productPath, setProductPath] = useState('')
  const [productQuery, setProductQuery] = useState('')
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
      const account: Account | null = json.affiliate
      if (account) setBank({ bankName: account.bankName, bankAccountNo: account.bankAccountNo, bankAccountName: account.bankAccountName })
    } catch (err: any) {
      setLoadError(err.message || 'Could not load.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const approved = data?.affiliate?.status === 'approved'
    && data.program.open
    && data.affiliate.termsVersionAccepted === data.program.termsVersion

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
  const homeLink = useMemo(() => (code && origin ? buildAffiliateLink(`${origin}/store`, code) : ''), [code, origin])
  const addressInvalid = Boolean(address.trim()) && !link
  const shownProducts = useMemo(() => {
    const q = productQuery.trim().toLowerCase()
    return (products || []).filter((p) => !q || p.name.toLowerCase().includes(q))
  }, [products, productQuery])

  if (loadError) {
    return <Shell><Notice tone="error">{loadError}</Notice></Shell>
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
  const needsTerms = Boolean(affiliate && affiliate.status !== 'rejected' && affiliate.termsVersionAccepted !== program.termsVersion)
  const showJoin = !affiliate || affiliate.status === 'rejected'

  if (!data.signedIn) {
    return (
      <Shell>
        <h1 className="font-display text-2xl font-semibold text-[var(--sera-ink)]">Affiliate program</h1>
        <p className="text-sm leading-relaxed text-[var(--sera-muted)]">
          Share Serapod products with your link and earn commission on paid orders.
        </p>
        <Button asChild className="h-11 rounded-xl bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange-deep)]">
          <Link href="/login?next=/store/affiliate">Sign in to join</Link>
        </Button>
      </Shell>
    )
  }

  if (!affiliate && !program.open) {
    return (
      <Shell>
        <h1 className="font-display text-2xl font-semibold text-[var(--sera-ink)]">Affiliate program</h1>
        <p className="text-sm text-[var(--sera-muted)]">The affiliate program is not open for new applications yet.</p>
      </Shell>
    )
  }

  const steps = [
    { title: 'Share your link', text: 'Send a Serapod product or page link.' },
    { title: 'They buy', text: `The order counts when they pay within ${program.attributionDays} days.` },
    { title: 'You get paid', text: `Confirmed ${program.confirmAfterDays} days after delivery, then sent to your bank.` },
  ]

  return (
    <Shell>
      <div>
        <h1 className="font-display text-2xl font-semibold text-[var(--sera-ink)]">Affiliate program</h1>
        <p className="mt-2 text-sm leading-relaxed text-[var(--sera-muted)]">
          {rate
            ? `Earn this rate on the product price when someone pays within ${program.attributionDays} days of your link. Delivery is not included.`
            : 'Share Serapod products and earn commission on paid orders.'}
        </p>
        {rate ? <p className="mt-3 font-display text-3xl font-semibold text-[var(--sera-ink)]">{rate}</p> : null}
      </div>

      {message ? <Notice tone={message.ok ? 'ok' : 'error'}>{message.text}</Notice> : null}

      {needsTerms && program.open ? (
        <section className={card}>
          <h2 className="text-base font-semibold text-[var(--sera-ink)]">Accept updated terms</h2>
          <p className="mt-1 text-sm text-[var(--sera-muted)]">The program terms changed. Accept them before your links earn again.</p>
          {program.terms ? (
            <div className="mt-4 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-xl border border-[var(--sera-line)] bg-[var(--sera-paper)] p-3 text-sm text-[var(--sera-muted)]">{program.terms}</div>
          ) : null}
          <label className="mt-4 flex items-start gap-2 text-sm text-[var(--sera-ink)]">
            <input type="checkbox" className="mt-1" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            I agree to the current affiliate program terms.
          </label>
          <Button
            type="button"
            className="mt-4 h-11 rounded-xl bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange-deep)]"
            disabled={busy || !agree}
            onClick={() => post({ action: 'accept_terms', agree }, 'Terms accepted. Your links are active again.')}
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Accept updated terms
          </Button>
        </section>
      ) : null}

      {showJoin && program.open ? (
        <>
          <ol className="grid gap-3 sm:grid-cols-3">
            {steps.map((step, index) => (
              <li key={step.title} className={card}>
                <p className="text-xs font-medium text-[var(--sera-muted)]">0{index + 1}</p>
                <p className="mt-1 text-sm font-semibold text-[var(--sera-ink)]">{step.title}</p>
                <p className="mt-1 text-sm text-[var(--sera-muted)]">{step.text}</p>
              </li>
            ))}
          </ol>

          {affiliate?.status === 'rejected' ? (
            <Notice tone="error">
              {affiliate.reviewNote ? `${affiliate.reviewNote} ` : ''}Your last application was not approved. You can send it again.
            </Notice>
          ) : null}

          <section className={card}>
            <h2 className="text-base font-semibold text-[var(--sera-ink)]">Where should we send your commission?</h2>
            <p className="mt-1 text-sm text-[var(--sera-muted)]">
              {program.joinMode === 'approval'
                ? 'We review applications before the link goes live.'
                : 'Your link is ready as soon as you join.'}
              {data.email ? ` Joining as ${data.email}.` : ''}
            </p>
            <div className="mt-5">
              <BankFields value={bank} onChange={setBank} />
            </div>
            {program.terms ? (
              <div className="mt-5 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-xl border border-[var(--sera-line)] bg-[var(--sera-paper)] p-3 text-sm text-[var(--sera-muted)]">{program.terms}</div>
            ) : null}
            <label className="mt-4 flex items-start gap-2 text-sm text-[var(--sera-ink)]">
              <input type="checkbox" className="mt-1" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              I agree to the affiliate program terms.
            </label>
            <Button
              type="button"
              className="mt-5 h-11 w-full rounded-xl bg-gradient-to-r from-[var(--sera-orange)] to-[var(--sera-orange-deep)] font-semibold text-white hover:from-[var(--sera-orange-deep)] hover:to-[var(--sera-orange-deep)]"
              disabled={busy || !agree}
              onClick={() => post(
                { action: 'join', agree, ...bank },
                program.joinMode === 'approval' ? 'Application sent. We will email you after review.' : 'You have joined. Your link is ready.',
              )}
            >
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {program.joinMode === 'approval' ? 'Apply now' : 'Join'}
            </Button>
          </section>
        </>
      ) : null}

      {affiliate && affiliate.status === 'pending' ? (
        <section className={card}>
          <h2 className="text-base font-semibold text-[var(--sera-ink)]">Application received</h2>
          <p className="mt-1 text-sm text-[var(--sera-muted)]">We are reviewing it. Your link appears here once it is approved.</p>
        </section>
      ) : null}

      {affiliate && affiliate.status === 'suspended' ? (
        <Notice tone="error">
          Your affiliate account is suspended.{affiliate.reviewNote ? ` ${affiliate.reviewNote}` : ''} Links do not earn while it stays suspended.
        </Notice>
      ) : null}

      {affiliate && affiliate.status === 'approved' && !program.open ? (
        <Notice tone="error">The affiliate program is paused. Your balance stays, and links do not earn until it opens again.</Notice>
      ) : null}

      {approved ? (
        <section className={card}>
          <p className="text-sm text-[var(--sera-muted)]">Your affiliate code</p>
          <p className="mt-1 font-display text-2xl font-semibold tracking-tight text-[var(--sera-ink)]">{code}</p>
          <p className="mt-1 text-sm text-[var(--sera-muted)]">{affiliate?.statusLabel}{rate ? ` · ${rate}` : ''}</p>
          <div className="mt-4">
            <CopyButton text={homeLink} label="Copy store link" />
          </div>
        </section>
      ) : null}

      {affiliate && affiliate.status !== 'rejected' && affiliate.status !== 'pending' && data.totals ? (
        <section className="grid gap-3 sm:grid-cols-3">
          {[
            { label: 'Pending', value: data.totals.pending, hint: 'Inside the refund window' },
            { label: 'Ready to pay', value: data.totals.confirmed, hint: 'Waiting for transfer' },
            { label: 'Paid', value: data.totals.paid, hint: 'Already sent' },
          ].map((box) => (
            <div key={box.label} className={card}>
              <p className="text-sm text-[var(--sera-muted)]">{box.label}</p>
              <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-[var(--sera-ink)]">
                <span>{rm(box.value)}</span>
              </p>
              <p className="mt-1 text-xs text-[var(--sera-muted)]">{box.hint}</p>
            </div>
          ))}
        </section>
      ) : null}

      {approved ? (
        <section className={card}>
          <h2 className="text-base font-semibold text-[var(--sera-ink)]">Make a link</h2>
          <p className="mt-1 text-sm text-[var(--sera-muted)]">Pick a product, or paste a Serapod page address.</p>
          <div className="relative mt-4">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--sera-muted)]" />
            <Input className={`${field} pl-9`} value={productQuery} placeholder="Search products" onChange={(e) => setProductQuery(e.target.value)} />
          </div>
          <div className="mt-3 grid max-h-72 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
            <button
              type="button"
              onClick={() => { setProductPath(''); setAddress('') }}
              className={`rounded-xl border p-3 text-left text-sm ${!productPath && !address.trim() ? 'border-[var(--sera-orange)] bg-white' : 'border-[var(--sera-line)] bg-white/70'}`}
            >
              Store home
            </button>
            {products === null ? <p className="col-span-full py-6 text-sm text-[var(--sera-muted)]">Loading products…</p> : shownProducts.map((product) => {
              const img = mediaUrl(product.imageUrl)
              const active = productPath === product.path && !address.trim()
              return (
                <button
                  key={`${product.channel}-${product.id}`}
                  type="button"
                  onClick={() => { setProductPath(product.path); setAddress('') }}
                  className={`rounded-xl border bg-white p-2 text-left ${active ? 'border-[var(--sera-orange)]' : 'border-[var(--sera-line)]'}`}
                >
                  <span className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-[var(--sera-paper)]">
                    {img ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={img} alt="" className="h-full w-full object-contain" />
                    ) : null}
                  </span>
                  <span className="mt-2 line-clamp-2 block text-xs font-medium text-[var(--sera-ink)]">{product.name}</span>
                </button>
              )
            })}
          </div>
          <div className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <Label className="text-sm font-medium text-[var(--sera-ink)]/80">Page address</Label>
              <Input className={field} value={address} placeholder="https://store.serapod2u.com/store/…" onChange={(e) => setAddress(e.target.value)} />
              {addressInvalid ? <p className="text-xs text-red-600">Use a Serapod page address.</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm font-medium text-[var(--sera-ink)]/80">Campaign name</Label>
              <Input className={field} value={sub} maxLength={40} placeholder="instagram"
                onChange={(e) => setSub(e.target.value.replace(/[^A-Za-z0-9_-]/g, ''))} />
            </div>
            <div className="rounded-xl border border-[var(--sera-line)] bg-[var(--sera-paper)] p-3">
              <p className="text-xs text-[var(--sera-muted)]">Your link</p>
              <p className="mt-1 break-all text-sm text-[var(--sera-ink)]">{link || 'Choose a page to build the link.'}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <CopyButton text={link} />
              <Button
                type="button"
                variant="outline"
                className="h-11 rounded-xl"
                disabled={!link}
                onClick={() => {
                  const share = navigator.share
                  if (typeof share === 'function') share.call(navigator, { url: link }).catch(() => undefined)
                  else navigator.clipboard?.writeText(link).catch(() => undefined)
                }}
              >
                <Share2 className="mr-2 h-4 w-4" /> Share
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      {affiliate && affiliate.status !== 'rejected' && affiliate.status !== 'pending' && data.totals ? (
        <>
          <section className={card}>
            <h2 className="text-base font-semibold text-[var(--sera-ink)]">Orders</h2>
            <p className="mt-1 text-sm text-[var(--sera-muted)]">Confirmed {program.confirmAfterDays} days after delivery.</p>
            {data.commissions && data.commissions.length > 0 ? (
              <ul className="mt-4 divide-y divide-[var(--sera-line)]">
                {data.commissions.map((row, index) => (
                  <li key={`${row.order}-${index}`} className="flex items-start justify-between gap-3 py-3 text-sm">
                    <div>
                      <p className="font-medium text-[var(--sera-ink)]">{row.channel} {row.order}</p>
                      <p className="mt-0.5 text-[var(--sera-muted)]">
                        {day(row.orderedAt)} · {rm(row.goods)}
                        {row.subId ? <> · <span>{row.subId}</span></> : null}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-medium tabular-nums text-[var(--sera-ink)]">{rm(row.amount)}</p>
                      <p className="text-xs text-[var(--sera-muted)]">{COMMISSION_STATUS_LABELS[row.status] || row.status}</p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-sm text-[var(--sera-muted)]">No orders yet.</p>
            )}
          </section>

          <section className="grid gap-3 lg:grid-cols-2">
            <div className={card}>
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-base font-semibold text-[var(--sera-ink)]">Bank account</h2>
                {!editBank ? (
                  <button type="button" className="text-sm text-[var(--sera-orange)]" onClick={() => setEditBank(true)}>Change</button>
                ) : null}
              </div>
              {editBank ? (
                <>
                  <div className="mt-4"><BankFields value={bank} onChange={setBank} /></div>
                  <div className="mt-4 flex gap-2">
                    <Button type="button" className="h-11 rounded-xl bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange-deep)]" disabled={busy}
                      onClick={() => post({ action: 'update_bank', ...bank }, 'Bank details saved.')}>
                      Save
                    </Button>
                    <Button type="button" variant="outline" className="h-11 rounded-xl" onClick={() => {
                      setEditBank(false)
                      setBank({ bankName: affiliate.bankName, bankAccountNo: affiliate.bankAccountNo, bankAccountName: affiliate.bankAccountName })
                    }}>Cancel</Button>
                  </div>
                </>
              ) : (
                <p className="mt-3 text-sm text-[var(--sera-ink)]">
                  {affiliate.bankName
                    ? `${affiliate.bankName} ${maskAccountNo(affiliate.bankAccountNo)} · ${affiliate.bankAccountName}`
                    : 'Add the account that should receive your commission.'}
                </p>
              )}
            </div>
            <div className={card}>
              <h2 className="text-base font-semibold text-[var(--sera-ink)]">Transfers</h2>
              <p className="mt-1 text-sm text-[var(--sera-muted)]">
                {program.minPayoutAmount > 0 ? `Sent once confirmed commission reaches ${rm(program.minPayoutAmount)}.` : 'Sent after commission is confirmed.'}
              </p>
              {data.payouts && data.payouts.length > 0 ? (
                <ul className="mt-3 divide-y divide-[var(--sera-line)]">
                  {data.payouts.map((payout, index) => (
                    <li key={`${payout.reference}-${index}`} className="flex items-center justify-between gap-3 py-3 text-sm">
                      <span className="text-[var(--sera-muted)]">
                        {day(payout.paidAt)}
                        <span className="mt-0.5 block">Ref {payout.reference} · {payout.count} order{payout.count === 1 ? '' : 's'}</span>
                      </span>
                      <span className="font-medium tabular-nums text-[var(--sera-ink)]">{rm(payout.amount)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-sm text-[var(--sera-muted)]">No transfers yet.</p>
              )}
            </div>
          </section>
        </>
      ) : null}
    </Shell>
  )
}
