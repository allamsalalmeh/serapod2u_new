'use client'

import { useCallback, useEffect, useMemo, useState, type PointerEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'framer-motion'
import '@/app/corporate/serapod2u/serapod2u.css'
import {
  ArrowLeft,
  BadgeCheck,
  Banknote,
  Check,
  Clock3,
  Copy,
  Landmark,
  Link2,
  Loader2,
  Package,
  PauseCircle,
  Search,
  Share2,
  ShieldAlert,
  ShoppingBag,
  Wallet,
} from 'lucide-react'
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
  email?: string
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

const panel = 'rounded-3xl border border-[var(--sera-line)] bg-white shadow-[0_18px_40px_-30px_rgba(20,18,16,0.35)]'
const field =
  'h-12 w-full rounded-2xl border border-[var(--sera-line)] bg-[var(--sera-surface)] px-4 text-sm text-[var(--sera-ink)] placeholder:text-[var(--sera-muted)]/60 transition-colors focus:border-[var(--sera-orange)]/50 focus:bg-white focus:outline-none focus:ring-4 focus:ring-[var(--sera-orange)]/10'
const primary =
  'inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-[var(--sera-orange)] px-6 text-sm font-semibold text-white shadow-[0_12px_24px_-12px_rgba(232,93,4,0.8)] transition-all hover:bg-[var(--sera-orange-deep)] active:scale-[0.98] disabled:opacity-50 disabled:shadow-none'
const secondary =
  'inline-flex h-11 items-center justify-center gap-2 rounded-2xl border border-[var(--sera-line)] bg-white px-4 text-sm font-medium text-[var(--sera-ink)] transition-colors hover:bg-[var(--sera-surface)] disabled:opacity-50'

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

const STATUS_TONE: Record<AffiliateCommissionStatus, string> = {
  pending: 'bg-amber-50 text-amber-800 ring-amber-200',
  confirmed: 'bg-sky-50 text-sky-800 ring-sky-200',
  paid: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  cancelled: 'bg-[var(--sera-surface)] text-[var(--sera-muted)] ring-[var(--sera-line)]',
}

function Notice({ tone, icon, title, children }: { tone: 'ok' | 'error' | 'info'; icon?: React.ReactNode; title?: string; children: React.ReactNode }) {
  const styles = {
    ok: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    error: 'border-red-200 bg-red-50 text-red-800',
    info: 'border-[var(--sera-line)] bg-white text-[var(--sera-ink)]',
  }
  return (
    <div className={`flex gap-3 rounded-2xl border p-4 text-sm ${styles[tone]}`}>
      {icon ? <span className="mt-0.5 flex-none">{icon}</span> : null}
      <div>
        {title ? <p className="font-semibold">{title}</p> : null}
        <div className={title ? 'mt-0.5 opacity-90' : ''}>{children}</div>
      </div>
    </div>
  )
}

function SectionTitle({ eyebrow, title, hint }: { eyebrow?: string; title: string; hint?: string }) {
  return (
    <div>
      {eyebrow ? <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--sera-orange)]">{eyebrow}</p> : null}
      <h2 className="mt-1 font-display text-xl font-semibold tracking-tight text-[var(--sera-ink)]">{title}</h2>
      {hint ? <p className="mt-1 text-sm text-[var(--sera-muted)]">{hint}</p> : null}
    </div>
  )
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
      <label className="block">
        <span className="text-xs font-semibold text-[var(--sera-ink)]/80">Bank</span>
        <input className={`${field} mt-1.5`} value={value.bankName} maxLength={80} placeholder="e.g. Maybank"
          onChange={(e) => onChange({ ...value, bankName: e.target.value })} />
      </label>
      <label className="block">
        <span className="text-xs font-semibold text-[var(--sera-ink)]/80">Account number</span>
        <input className={`${field} mt-1.5 tabular-nums`} value={value.bankAccountNo} inputMode="numeric" maxLength={30} placeholder="Digits only"
          onChange={(e) => onChange({ ...value, bankAccountNo: e.target.value })} />
      </label>
      <label className="block sm:col-span-2">
        <span className="text-xs font-semibold text-[var(--sera-ink)]/80">Name on the account</span>
        <input className={`${field} mt-1.5`} value={value.bankAccountName} maxLength={120} placeholder="As shown on your bank account"
          onChange={(e) => onChange({ ...value, bankAccountName: e.target.value })} />
      </label>
    </div>
  )
}

function CopyButton({ text, label = 'Copy', className = secondary }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className={className}
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
      {done ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {done ? 'Copied' : label}
    </button>
  )
}

const EASE = [0.22, 1, 0.36, 1] as const

/** The same product photos the serapod2u.com home page orbits (no vape products). */
const STAGE_PHOTOS = [
  '/outdoor/products/tumbler-burgundy.png',
  '/outdoor/products/mat-grey.png',
  '/outdoor/products/tumbler-pink.png',
  '/outdoor/products/mat-burgundy.png',
  '/outdoor/products/tumbler-grey.png',
  '/outdoor/products/mat-pink.png',
]

function stagePhotos(products: LinkProduct[] | null) {
  const store = (products || []).map((p) => mediaUrl(p.imageUrl)).filter(Boolean).slice(0, 4) as string[]
  const out: string[] = []
  for (let i = 0; out.length < 8 && (i < STAGE_PHOTOS.length || i < store.length); i++) {
    if (STAGE_PHOTOS[i]) out.push(STAGE_PHOTOS[i])
    if (store[i] && out.length < 8) out.push(store[i])
  }
  return out
}

function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: 0.8, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  )
}

/** Card that leans toward the pointer in 3D. */
function TiltCard({ children, className, max = 8 }: { children: ReactNode; className?: string; max?: number }) {
  const reduce = useReducedMotion()
  const rx = useSpring(0, { stiffness: 180, damping: 18 })
  const ry = useSpring(0, { stiffness: 180, damping: 18 })
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (reduce) return
    const r = e.currentTarget.getBoundingClientRect()
    ry.set(((e.clientX - r.left) / r.width - 0.5) * max * 2)
    rx.set(-((e.clientY - r.top) / r.height - 0.5) * max * 2)
  }
  return (
    <div style={{ perspective: 900 }} className={className}>
      <motion.div
        onPointerMove={onMove}
        onPointerLeave={() => { rx.set(0); ry.set(0) }}
        style={{ rotateX: rx, rotateY: ry, transformStyle: 'preserve-3d' }}
        className="h-full"
      >
        {children}
      </motion.div>
    </div>
  )
}

/** Products orbiting a floating link card, tilting with the pointer (as on the serapod2u.com home page). */
function LinkStage({ rate, days, code, photos }: { rate: string; days: number; code: string; photos: string[] }) {
  const reduce = useReducedMotion()
  const px = useMotionValue(0)
  const py = useMotionValue(0)
  const rotateY = useSpring(useTransform(px, [-0.5, 0.5], [-14, 14]), { stiffness: 120, damping: 18 })
  const rotateX = useSpring(useTransform(py, [-0.5, 0.5], [6, -14]), { stiffness: 120, damping: 18 })
  const step = 360 / Math.max(1, photos.length)
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (reduce) return
    const r = e.currentTarget.getBoundingClientRect()
    px.set((e.clientX - r.left) / r.width - 0.5)
    py.set((e.clientY - r.top) / r.height - 0.5)
  }
  return (
    <div
      className="s2u-stage relative mx-auto aspect-square w-full max-w-[520px]"
      onPointerMove={onMove}
      onPointerLeave={() => { px.set(0); py.set(0) }}
    >
      <div className="absolute inset-[14%] rounded-full bg-[radial-gradient(circle,rgba(232,93,4,0.22),rgba(232,93,4,0.05)_45%,transparent_70%)] blur-2xl" />
      <div className="s2u-ring s2u-ring--1" style={{ top: '62%' }}><span className="s2u-ring-dot" /></div>
      <div className="s2u-ring s2u-ring--2" style={{ top: '62%' }} />

      <motion.div className="s2u-carousel absolute inset-0" style={{ rotateX, rotateY, transformStyle: 'preserve-3d' }}>
        <div className="s2u-carousel-spin">
          {photos.map((src, i) => (
            <div key={`${src}-${i}`} className="s2u-carousel-card" style={{ ['--a' as string]: `${i * step}deg` }}>
              <div className="flex h-full items-center justify-center overflow-hidden rounded-2xl bg-white shadow-[0_28px_50px_-26px_rgba(18,20,23,0.35)] ring-1 ring-black/5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt="" className="h-full w-full object-contain p-3" loading={i < 4 ? 'eager' : 'lazy'} />
              </div>
            </div>
          ))}
        </div>

        {/* In front of the orbit in depth, so the products always pass behind it. */}
        <div
          className="absolute left-1/2 top-1/2 w-[58%] max-w-[210px]"
          style={{ transform: 'translate(-50%, -50%) translateZ(calc(var(--s2u-r) + 70px))' }}
        >
        <div className="s2u-device-float">
          <div className="relative overflow-hidden rounded-3xl bg-white/95 p-5 shadow-[0_40px_80px_-32px_rgba(18,20,23,0.45)] ring-1 ring-black/5 backdrop-blur">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-xs font-semibold text-[var(--sera-ink)]">
                <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-[var(--sera-orange)]/10 text-[var(--sera-orange)]"><Link2 className="h-3.5 w-3.5" /></span>
                Your link
              </span>
              <span className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> {days} days
              </span>
            </div>
            <div className="relative mt-4 overflow-hidden rounded-2xl bg-[var(--sera-surface)] px-3 py-2.5">
              <p className="truncate font-mono text-[11px] text-[var(--sera-ink)]/80">serapod2u.com/store?ref={code || 'YOURCODE'}</p>
              <span className="s2u-sheen pointer-events-none absolute inset-0" aria-hidden="true" />
            </div>
            <div className="mt-4 flex items-end justify-between gap-3">
              <div>
                <p className="font-display text-4xl font-semibold leading-none tracking-tight text-[var(--sera-orange)]">{rate || '—'}</p>
                <p className="mt-1 text-[11px] text-[var(--sera-muted)]">of every paid order</p>
              </div>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--sera-ink)] px-3 py-1.5 text-[11px] font-semibold text-white">
                <Copy className="h-3 w-3" /> Copy
              </span>
            </div>
          </div>
        </div>
        </div>
      </motion.div>

      <div className="s2u-chip-bob absolute right-[4%] top-[14%] z-30 flex items-center gap-2 rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-[var(--sera-ink)] shadow-[0_18px_40px_-18px_rgba(18,20,23,0.35)] ring-1 ring-black/5">
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600"><ShoppingBag className="h-3.5 w-3.5" /></span>
        Paid order
      </div>
      <div className="s2u-chip-bob absolute bottom-[16%] left-[2%] z-30 flex items-center gap-2 rounded-2xl bg-white px-3 py-2 text-xs font-semibold text-[var(--sera-ink)] shadow-[0_18px_40px_-18px_rgba(18,20,23,0.35)] ring-1 ring-black/5" style={{ animationDelay: '1.2s' }}>
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-[var(--sera-orange)]/10 text-[var(--sera-orange)]"><Banknote className="h-3.5 w-3.5" /></span>
        Bank transfer
      </div>
      <div className="absolute bottom-[8%] left-1/2 h-8 w-2/3 -translate-x-1/2 rounded-[50%] bg-[rgba(18,20,23,0.12)] blur-2xl" />
    </div>
  )
}

/** Full-width hero in the serapod2u.com home page style: light warm gradient, aurora, grid, words rising in. */
function Hero({
  words,
  sub,
  rate,
  program,
  code,
  photos,
  children,
}: {
  words: string[]
  sub: string
  rate: string
  program: Program
  code: string
  photos: string[]
  children?: ReactNode
}) {
  return (
    <section className="relative isolate overflow-hidden bg-[linear-gradient(180deg,#fff6ef_0%,#fbfaf8_55%,var(--sera-paper)_100%)] pb-16 pt-6 sm:pb-24 sm:pt-8">
      <div className="s2u-aurora" aria-hidden="true" />
      <div className="s2u-grid" aria-hidden="true" />
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <Link href="/store/account" className="inline-flex items-center gap-1.5 text-sm text-[var(--sera-muted)] transition-colors hover:text-[var(--sera-orange)]">
          <ArrowLeft className="h-4 w-4" />
          My Account
        </Link>
        <div className="mt-6 grid items-center gap-10 lg:grid-cols-[1.05fr_1fr]">
          <div>
            <motion.span
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: EASE }}
              className="inline-flex items-center gap-2 rounded-full border border-[var(--sera-orange)]/20 bg-white/70 px-3 py-1 text-xs font-semibold text-[var(--sera-ink)] backdrop-blur"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--sera-orange)]" /> Affiliate program
            </motion.span>
            <h1 className="mt-5 font-display text-[2.6rem] font-semibold leading-[0.98] tracking-tight text-[var(--sera-ink)] sm:text-6xl lg:text-[4.4rem]">
              {words.map((word, i) => (
                <span key={`${word}-${i}`} className="mr-[0.22em] inline-block overflow-hidden pb-2 align-bottom">
                  <motion.span
                    className={`inline-block ${i === words.length - 1 ? 'text-[var(--sera-orange)]' : ''}`}
                    initial={{ y: '110%' }}
                    animate={{ y: 0 }}
                    transition={{ duration: 0.9, ease: EASE, delay: 0.15 + i * 0.09 }}
                  >
                    {word}
                  </motion.span>
                </span>
              ))}
            </h1>
            <motion.p
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, ease: EASE, delay: 0.55 }}
              className="mt-6 max-w-xl text-base leading-relaxed text-[var(--sera-muted)] sm:text-lg"
            >
              {sub}
            </motion.p>
            {children ? (
              <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, ease: EASE, delay: 0.7 }} className="mt-8">
                {children}
              </motion.div>
            ) : null}
          </div>
          <motion.div initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 1.1, ease: EASE, delay: 0.25 }}>
            <LinkStage rate={rate} days={program.attributionDays} code={code} photos={photos} />
          </motion.div>
        </div>
      </div>
    </section>
  )
}

function Steps({ program }: { program: Program }) {
  const steps = [
    { icon: <Share2 className="h-5 w-5" />, title: 'Share your link', text: 'Link to any Serapod product or page, on any app you use.' },
    {
      icon: <ShoppingBag className="h-5 w-5" />,
      title: 'They buy',
      text: `The order is yours when they pay within ${program.attributionDays} days of opening your link.`,
    },
    {
      icon: <Banknote className="h-5 w-5" />,
      title: 'You get paid',
      text: `Confirmed ${program.confirmAfterDays} days after delivery, then sent to your bank. Cancelled or refunded orders earn nothing.`,
    },
  ]
  return (
    <section>
      <Reveal className="max-w-2xl">
        <h2 className="font-display text-3xl font-semibold tracking-tight text-[var(--sera-ink)] sm:text-4xl">How it works</h2>
        <p className="mt-3 text-[var(--sera-muted)]">Three steps, from your link to your bank account.</p>
      </Reveal>
      <div className="relative mt-10">
        <svg className="pointer-events-none absolute left-[16%] right-[16%] top-[52px] hidden h-2 w-[68%] md:block" viewBox="0 0 100 2" preserveAspectRatio="none" aria-hidden="true">
          <line x1="0" y1="1" x2="100" y2="1" className="s2u-flow" stroke="#e85d04" strokeOpacity="0.55" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="grid gap-4 md:grid-cols-3">
          {steps.map((s, i) => (
            <Reveal key={s.title} delay={i * 0.1}>
              <TiltCard className="h-full">
                <div className={`${panel} h-full p-6`}>
                  <div className="flex items-center justify-between">
                    <span className="relative flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-[var(--sera-orange)] shadow-[0_16px_32px_-16px_rgba(232,93,4,0.55)] ring-1 ring-[var(--sera-orange)]/15">{s.icon}</span>
                    <span className="font-display text-4xl font-semibold text-[var(--sera-line)]">0{i + 1}</span>
                  </div>
                  <p className="mt-5 text-lg font-semibold text-[var(--sera-ink)]">{s.title}</p>
                  <p className="mt-1.5 text-sm leading-relaxed text-[var(--sera-muted)]">{s.text}</p>
                </div>
              </TiltCard>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
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
  const homeLink = useMemo(() => (code && origin ? buildAffiliateLink(`${origin}/store`, code) : ''), [code, origin])
  const addressInvalid = Boolean(address.trim()) && !link
  const shownProducts = useMemo(() => {
    const q = productQuery.trim().toLowerCase()
    return (products || []).filter((p) => !q || p.name.toLowerCase().includes(q))
  }, [products, productQuery])
  const selectedProduct = (products || []).find((p) => p.path === productPath) || null

  if (loadError) {
    return (
      <Shell>
        <Notice tone="error" icon={<ShieldAlert className="h-5 w-5" />}>{loadError}</Notice>
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
  const photos = stagePhotos(products)
  const joinWords = ['Share', 'Serapod.', 'Get', 'paid.']
  const joinSub = `Send your own link to friends or followers. When they buy within ${program.attributionDays} days, you earn ${rate || 'commission'} of the products' price.`
  const heroFor = (words: string[], sub: string, children?: ReactNode) => (
    <Hero words={words} sub={sub} rate={rate} program={program} code={code} photos={photos}>{children}</Hero>
  )

  if (!data.signedIn) {
    return (
      <Shell
        hero={heroFor(
          joinWords,
          joinSub,
          <>
            <Link href="/login?next=/store/affiliate" className={`${primary} rounded-full`}>Sign in to join</Link>
            <p className="mt-3 text-xs text-[var(--sera-muted)]">Use your store account. New here? You can create one on the sign-in page.</p>
          </>,
        )}
      />
    )
  }

  if (!affiliate && !program.open) {
    return (
      <Shell>
        <Notice tone="info" icon={<Clock3 className="h-5 w-5 text-[var(--sera-muted)]" />} title="Not open yet">
          The affiliate program is not open yet. Check back soon.
        </Notice>
      </Shell>
    )
  }

  const showJoin = !affiliate || affiliate.status === 'rejected'
  const hero =
    showJoin && program.open
      ? heroFor(
          joinWords,
          joinSub,
          <a href="#join" className={`${primary} rounded-full`}>{program.joinMode === 'approval' ? 'Apply now' : 'Join and get my link'}</a>,
        )
      : affiliate?.status === 'pending'
        ? heroFor(
            ['Application', 'received.'],
            'We are reviewing it. Your link and code appear here as soon as it is approved.',
            <span className="inline-flex items-center gap-2 rounded-full bg-amber-50 px-4 py-2 text-sm font-semibold text-amber-800 ring-1 ring-amber-200">
              <Clock3 className="h-4 w-4" /> Waiting for approval
            </span>,
          )
        : approved
          ? heroFor(
              ['Your', 'link', 'is', 'ready.'],
              `Share it anywhere. Orders paid within ${program.attributionDays} days of a click earn you ${rate || 'commission'}.`,
              <div className="flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-3 rounded-full bg-white px-5 py-3 shadow-[0_18px_40px_-20px_rgba(18,20,23,0.35)] ring-1 ring-black/5">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--sera-muted)]">Code</span>
                  <span className="font-display text-xl font-semibold tracking-tight text-[var(--sera-ink)]">{code}</span>
                </span>
                <CopyButton text={homeLink} label="Copy store link" className={`${primary} rounded-full`} />
              </div>,
            )
          : heroFor(['Your', 'affiliate', 'account.'], 'Your earnings and transfers are below.')

  return (
    <Shell hero={hero}>
      {message ? (
        <Notice tone={message.ok ? 'ok' : 'error'} icon={message.ok ? <BadgeCheck className="h-5 w-5" /> : <ShieldAlert className="h-5 w-5" />}>
          {message.text}
        </Notice>
      ) : null}

      {showJoin && program.open ? (
        <>
          <Steps program={program} />

          {affiliate?.status === 'rejected' ? (
            <Notice tone="error" icon={<ShieldAlert className="h-5 w-5" />} title="Your last application was not approved">
              {affiliate.reviewNote ? `${affiliate.reviewNote} ` : ''}You can apply again below.
            </Notice>
          ) : null}

          <Reveal>
          <section id="join" className={`${panel} scroll-mt-24 overflow-hidden`}>
            <div className="grid lg:grid-cols-[1.5fr_1fr]">
              <div className="p-6 sm:p-8">
                <SectionTitle eyebrow="Join" title="Where should we send your commission?" hint="We pay confirmed commission by bank transfer to this account. You can change it later." />
                <div className="mt-6">
                  <BankFields value={bank} onChange={setBank} />
                </div>
              </div>
              <div className="border-t border-[var(--sera-line)] bg-[var(--sera-surface)] p-6 sm:p-8 lg:border-l lg:border-t-0">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--sera-muted)]">Joining as</p>
                <p className="mt-1 truncate text-sm font-semibold text-[var(--sera-ink)]">{data.email || 'your store account'}</p>
                {program.joinMode === 'approval' ? (
                  <p className="mt-4 flex gap-2 text-sm text-[var(--sera-muted)]">
                    <Clock3 className="mt-0.5 h-4 w-4 flex-none" /> We review each application. Your link starts working once it is approved.
                  </p>
                ) : (
                  <p className="mt-4 flex gap-2 text-sm text-[var(--sera-muted)]">
                    <BadgeCheck className="mt-0.5 h-4 w-4 flex-none text-emerald-600" /> Your link is ready as soon as you join.
                  </p>
                )}
                {program.terms ? (
                  <div className="mt-5 max-h-40 overflow-y-auto whitespace-pre-line rounded-2xl border border-[var(--sera-line)] bg-white p-3 text-xs leading-relaxed text-[var(--sera-muted)]">
                    {program.terms}
                  </div>
                ) : null}
                <label className="mt-5 flex cursor-pointer items-start gap-3 text-sm text-[var(--sera-ink)]/85">
                  <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--sera-orange)]" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                  <span>I agree to the affiliate program terms.</span>
                </label>
                <button
                  type="button"
                  className={`${primary} mt-6 w-full`}
                  disabled={busy || !agree}
                  onClick={() =>
                    post({ action: 'join', agree, ...bank }, program.joinMode === 'approval' ? 'Application sent. We will let you know once it is reviewed.' : 'You have joined. Your link is ready.')
                  }
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {program.joinMode === 'approval' ? 'Apply now' : 'Join and get my link'}
                </button>
              </div>
            </div>
          </section>
          </Reveal>
        </>
      ) : null}

      {affiliate && affiliate.status === 'suspended' ? (
        <Notice tone="error" icon={<PauseCircle className="h-5 w-5" />} title="Your affiliate account is suspended">
          Your link does not earn commission right now.{affiliate.reviewNote ? ` ${affiliate.reviewNote}` : ''}
        </Notice>
      ) : null}

      {affiliate && affiliate.status === 'approved' && !program.open ? (
        <Notice tone="info" icon={<PauseCircle className="h-5 w-5 text-[var(--sera-muted)]" />} title="The program is paused">
          Links do not earn commission until it reopens. Your earnings so far are kept.
        </Notice>
      ) : null}

      {affiliate && affiliate.status !== 'rejected' && affiliate.status !== 'pending' && data.totals ? (
        <section className="grid gap-4 sm:grid-cols-3">
          {[
            { label: 'Pending', value: data.totals.pending, hint: 'Paid orders, not confirmed yet', icon: <Clock3 className="h-5 w-5" />, tone: 'bg-amber-50 text-amber-700' },
            { label: 'Confirmed', value: data.totals.confirmed, hint: 'Waiting for the next transfer', icon: <BadgeCheck className="h-5 w-5" />, tone: 'bg-sky-50 text-sky-700' },
            { label: 'Paid to you', value: data.totals.paid, hint: 'Sent to your bank', icon: <Wallet className="h-5 w-5" />, tone: 'bg-emerald-50 text-emerald-700' },
          ].map((box, i) => (
            <Reveal key={box.label} delay={i * 0.08}>
              <TiltCard className="h-full" max={6}>
                <div className={`${panel} h-full p-5`}>
                  <div className="flex items-center gap-3">
                    <span className={`flex h-10 w-10 items-center justify-center rounded-2xl ${box.tone}`}>{box.icon}</span>
                    <p className="text-sm font-semibold text-[var(--sera-ink)]">{box.label}</p>
                  </div>
                  <p className="mt-4 font-display text-3xl font-semibold tracking-tight text-[var(--sera-ink)] tabular-nums">{rm(box.value)}</p>
                  <p className="mt-1 text-xs text-[var(--sera-muted)]">{box.hint}</p>
                </div>
              </TiltCard>
            </Reveal>
          ))}
        </section>
      ) : null}

      {approved ? (
        <Reveal>
        <section className={`${panel} p-6 sm:p-8`}>
          <SectionTitle eyebrow="Make a link" title="Pick what you want to share" hint="Choose a product, or paste the address of any Serapod page." />

          <div className="mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
            <div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--sera-muted)]" />
                <input className={`${field} pl-11`} value={productQuery} placeholder="Search products" onChange={(e) => setProductQuery(e.target.value)} />
              </div>
              <div className="mt-3 grid max-h-[340px] grid-cols-2 gap-3 overflow-y-auto pr-1 sm:grid-cols-3">
                <button
                  type="button"
                  onClick={() => { setProductPath(''); setAddress('') }}
                  className={`flex flex-col items-center justify-center gap-2 rounded-2xl border p-3 text-center text-xs font-semibold transition-all ${!productPath && !address.trim() ? 'border-[var(--sera-orange)] bg-[var(--sera-orange)]/5 text-[var(--sera-ink)] ring-2 ring-[var(--sera-orange)]/20' : 'border-[var(--sera-line)] bg-white text-[var(--sera-muted)] hover:border-[var(--sera-muted)]/40'}`}
                >
                  <span className="flex aspect-square w-full items-center justify-center rounded-xl bg-[var(--sera-surface)]"><ShoppingBag className="h-7 w-7 text-[var(--sera-orange)]" /></span>
                  Store home
                </button>
                {products === null ? (
                  <div className="col-span-2 flex items-center justify-center py-10 sm:col-span-2"><Loader2 className="h-5 w-5 animate-spin text-[var(--sera-muted)]" /></div>
                ) : (
                  shownProducts.map((p) => {
                    const img = mediaUrl(p.imageUrl)
                    const active = productPath === p.path && !address.trim()
                    return (
                      <button
                        key={`${p.channel}-${p.id}`}
                        type="button"
                        onClick={() => { setProductPath(p.path); setAddress('') }}
                        className={`group flex flex-col gap-2 rounded-2xl border p-2 text-left transition-all ${active ? 'border-[var(--sera-orange)] bg-[var(--sera-orange)]/5 ring-2 ring-[var(--sera-orange)]/20' : 'border-[var(--sera-line)] bg-white hover:border-[var(--sera-muted)]/40'}`}
                      >
                        <span className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-xl bg-[var(--sera-surface)]">
                          {img ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={img} alt="" className="h-full w-full object-contain p-2 transition-transform group-hover:scale-105" />
                          ) : (
                            <Package className="h-7 w-7 text-[var(--sera-muted)]/50" />
                          )}
                          {p.channel === 'outdoor' ? (
                            <span className="absolute left-1.5 top-1.5 rounded-full bg-[var(--sera-ink)]/85 px-2 py-0.5 text-[10px] font-semibold text-white">Outdoor</span>
                          ) : null}
                        </span>
                        <span className="line-clamp-2 px-1 text-xs font-semibold text-[var(--sera-ink)]">{p.name}</span>
                      </button>
                    )
                  })
                )}
              </div>
              {products !== null && shownProducts.length === 0 ? (
                <p className="mt-3 text-sm text-[var(--sera-muted)]">No products match “{productQuery}”.</p>
              ) : null}
            </div>

            <div className="flex flex-col gap-4 rounded-3xl bg-[var(--sera-surface)] p-5">
              <label className="block">
                <span className="text-xs font-semibold text-[var(--sera-ink)]/80">Or paste a Serapod page address</span>
                <input className={`${field} mt-1.5 bg-white`} value={address} placeholder={`${origin}/store/products/…`} onChange={(e) => setAddress(e.target.value)} />
                {addressInvalid ? <span className="mt-1 block text-xs text-red-600">Paste an address from the Serapod site.</span> : null}
              </label>
              <label className="block">
                <span className="text-xs font-semibold text-[var(--sera-ink)]/80">Where will you post it? <span className="font-normal text-[var(--sera-muted)]">(optional)</span></span>
                <input className={`${field} mt-1.5 bg-white`} value={sub} maxLength={40} placeholder="e.g. tiktok, instagram"
                  onChange={(e) => setSub(e.target.value.replace(/[^A-Za-z0-9_-]/g, ''))} />
                <span className="mt-1 block text-xs text-[var(--sera-muted)]">Shown next to each order, so you know which post sold it.</span>
              </label>

              <div className="mt-auto rounded-2xl border border-[var(--sera-line)] bg-white p-4">
                <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sera-muted)]">
                  <Link2 className="h-3.5 w-3.5" /> Your link{selectedProduct && !address.trim() ? ` · ${selectedProduct.name}` : ''}
                </p>
                <p className="mt-2 break-all text-sm font-medium text-[var(--sera-ink)]">{link || '—'}</p>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <CopyButton text={link} label="Copy link" className={`${primary} h-11`} />
                  <button type="button" className={secondary} disabled={!link}
                    onClick={() => {
                      if (typeof navigator !== 'undefined' && 'share' in navigator) navigator.share({ url: link }).catch(() => undefined)
                      else navigator.clipboard?.writeText(link).catch(() => undefined)
                    }}>
                    <Share2 className="h-4 w-4" /> Share
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
        </Reveal>
      ) : null}

      {affiliate && affiliate.status !== 'rejected' && affiliate.status !== 'pending' && data.totals ? (
        <>
          <Reveal>
          <section className={`${panel} p-6 sm:p-8`}>
            <SectionTitle title="Orders from your links" hint={`Commission is confirmed ${program.confirmAfterDays} days after delivery.`} />
            {data.commissions && data.commissions.length > 0 ? (
              <div className="mt-5 overflow-x-auto">
                <table className="w-full min-w-[600px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-[var(--sera-line)] text-xs uppercase tracking-wide text-[var(--sera-muted)]">
                      <th className="pb-3 pr-3 font-semibold">Date</th>
                      <th className="pb-3 pr-3 font-semibold">Order</th>
                      <th className="pb-3 pr-3 font-semibold">Posted on</th>
                      <th className="pb-3 pr-3 text-right font-semibold">Products</th>
                      <th className="pb-3 pr-3 text-right font-semibold">You earn</th>
                      <th className="pb-3 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--sera-line)]">
                    {data.commissions.map((c, i) => (
                      <tr key={`${c.order}-${i}`}>
                        <td className="py-3 pr-3 whitespace-nowrap text-[var(--sera-muted)]">{day(c.orderedAt)}</td>
                        <td className="py-3 pr-3 whitespace-nowrap">{c.channel} <span className="text-[var(--sera-muted)]">{c.order}</span></td>
                        <td className="py-3 pr-3">{c.subId || '—'}</td>
                        <td className="py-3 pr-3 text-right whitespace-nowrap tabular-nums">{rm(c.goods)}</td>
                        <td className="py-3 pr-3 text-right whitespace-nowrap font-semibold tabular-nums">{rm(c.amount)}</td>
                        <td className="py-3 whitespace-nowrap">
                          <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ${STATUS_TONE[c.status] || STATUS_TONE.cancelled}`}>
                            {COMMISSION_STATUS_LABELS[c.status] || c.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mt-5 flex flex-col items-center rounded-2xl border border-dashed border-[var(--sera-line)] py-10 text-center">
                <ShoppingBag className="h-8 w-8 text-[var(--sera-muted)]/50" />
                <p className="mt-3 text-sm font-semibold text-[var(--sera-ink)]">No orders yet</p>
                <p className="mt-1 max-w-xs text-sm text-[var(--sera-muted)]">Share your link. Paid orders from it show up here.</p>
              </div>
            )}
          </section>
          </Reveal>

          <Reveal>
          <section className="grid gap-4 lg:grid-cols-2">
            <div className={`${panel} p-6 sm:p-8`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <SectionTitle title="Bank account" hint="Where we send your commission." />
                {!editBank ? (
                  <button type="button" className={secondary} onClick={() => setEditBank(true)}>Change</button>
                ) : null}
              </div>
              {editBank ? (
                <>
                  <div className="mt-5">
                    <BankFields value={bank} onChange={setBank} />
                  </div>
                  <div className="mt-5 flex flex-wrap gap-2">
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
                <div className="mt-5 flex items-center gap-4 rounded-2xl bg-[var(--sera-surface)] p-4">
                  <span className="flex h-11 w-11 flex-none items-center justify-center rounded-2xl bg-white text-[var(--sera-ink)]"><Landmark className="h-5 w-5" /></span>
                  {affiliate.bankName ? (
                    <div className="min-w-0 text-sm">
                      <p className="font-semibold text-[var(--sera-ink)]">{affiliate.bankName} <span className="font-normal tabular-nums text-[var(--sera-muted)]">{maskAccountNo(affiliate.bankAccountNo)}</span></p>
                      <p className="truncate text-[var(--sera-muted)]">{affiliate.bankAccountName}</p>
                    </div>
                  ) : (
                    <p className="text-sm text-[var(--sera-muted)]">Not added yet.</p>
                  )}
                </div>
              )}
            </div>

            <div className={`${panel} p-6 sm:p-8`}>
              <SectionTitle title="Transfers" hint={program.minPayoutAmount > 0 ? `Sent once your confirmed commission reaches ${rm(program.minPayoutAmount)}.` : 'Confirmed commission sent to your bank.'} />
              {data.payouts && data.payouts.length > 0 ? (
                <ul className="mt-5 divide-y divide-[var(--sera-line)] text-sm">
                  {data.payouts.map((p, i) => (
                    <li key={`${p.reference}-${i}`} className="flex items-center justify-between gap-3 py-3">
                      <span>
                        <span className="block font-semibold text-[var(--sera-ink)]">{day(p.paidAt)}</span>
                        <span className="text-xs text-[var(--sera-muted)]">Ref {p.reference} · {p.count} order{p.count === 1 ? '' : 's'}</span>
                      </span>
                      <span className="font-display text-lg font-semibold tabular-nums text-[var(--sera-ink)]">{rm(p.amount)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-5 rounded-2xl bg-[var(--sera-surface)] p-4 text-sm text-[var(--sera-muted)]">No transfers yet.</p>
              )}
            </div>
          </section>
          </Reveal>
        </>
      ) : null}
    </Shell>
  )
}

function Shell({ hero, children }: { hero?: ReactNode; children?: ReactNode }) {
  return (
    <div className="s2u">
      {hero}
      {children ? (
        <div className={`mx-auto max-w-6xl space-y-8 px-4 pb-16 sm:px-6 ${hero ? 'pt-2' : 'pt-8 sm:pt-12'}`}>
          {!hero ? (
            <Link href="/store/account" className="inline-flex items-center gap-1.5 text-sm text-[var(--sera-muted)] transition-colors hover:text-[var(--sera-orange)]">
              <ArrowLeft className="h-4 w-4" />
              My Account
            </Link>
          ) : null}
          {children}
        </div>
      ) : null}
    </div>
  )
}
