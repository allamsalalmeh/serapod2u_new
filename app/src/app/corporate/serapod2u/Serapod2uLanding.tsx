'use client'

import Image from 'next/image'
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react'
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
} from 'framer-motion'
import { ArrowRight, ArrowUpRight, LogIn, ShoppingBag } from 'lucide-react'
import './serapod2u.css'

export interface LandingProduct {
  id: string
  name: string
  category: string | null
  image: string
  price: number | null
}

/** Store, login and product links are relative: the middleware sends each to its own address. */
const STORE_HREF = '/store'
const LOGIN_HREF = '/login'
const CUSTOMER_LOGIN_HREF = '/login?mode=store'

const EASE = [0.22, 1, 0.36, 1] as const

interface Brand {
  id: string
  name: string
  line: string
  href: string
  cta: string
  mark: ReactNode
}

function brands(outdoorUrl: string): Brand[] {
  return [
    {
      id: 'store',
      name: 'Serapod2U Store',
      line: 'The online store for Serapod devices, electronics, pet food and accessories.',
      href: STORE_HREF,
      cta: 'Shop the store',
      mark: (
        <span className="flex h-full w-full items-center justify-center rounded-2xl bg-[var(--s2u-orange)] text-white">
          <ShoppingBag className="h-6 w-6" />
        </span>
      ),
    },
    {
      id: 'outdoor',
      name: 'Serapod Outdoor',
      line: 'Moonchairs, camping mats and tumblers in Serapod Outdoor colourways.',
      href: outdoorUrl,
      cta: 'Explore Outdoor',
      mark: (
        // eslint-disable-next-line @next/next/no-img-element
        <img src="/outdoor/brand/icon-1.png" alt="" className="h-full w-full rounded-2xl bg-white object-contain p-1.5" />
      ),
    },
    {
      id: 'cellera',
      name: 'Cellera Hero',
      line: 'Cellera cartridges and the Serapod S.Box and S.Line devices.',
      href: '/store/products',
      cta: 'See in the store',
      mark: (
        // eslint-disable-next-line @next/next/no-img-element
        <img src="/images/serapod-return-pdf-assets/Cellera Hero.png" alt="" className="h-full w-full rounded-2xl bg-white object-contain p-1.5" />
      ),
    },
    {
      id: 'ellbow',
      name: 'Ellbow',
      line: 'Ellbow cat treats, available in the Serapod2U Store.',
      href: '/store/products',
      cta: 'See in the store',
      mark: (
        // eslint-disable-next-line @next/next/no-img-element
        <img src="/images/ellbow-mobile-ready-assets/webp/03-ellbow-cat-face-icon.webp" alt="" className="h-full w-full rounded-2xl bg-white object-contain p-1" />
      ),
    },
  ]
}

function money(value: number) {
  return `RM ${value.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/* ── Shared pieces ─────────────────────────────────────────────────────── */

function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.8, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  )
}

/** Card that leans toward the pointer in 3D. */
function TiltCard({ children, className, max = 10 }: { children: ReactNode; className?: string; max?: number }) {
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

/* ── Header ────────────────────────────────────────────────────────────── */

function Header({ outdoorUrl }: { outdoorUrl: string }) {
  const [solid, setSolid] = useState(false)
  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 40)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-all duration-500 ${solid ? 'bg-[#121417]/85 backdrop-blur-xl border-b border-white/10' : 'bg-transparent'}`}
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/serapod-wordmark-light.png" alt="Serapod" className="h-7 w-auto sm:h-8" width={160} height={44} />
        <nav className="flex items-center gap-1 sm:gap-2">
          <a href={STORE_HREF} className="hidden rounded-full px-3 py-2 text-sm font-medium text-white/75 transition-colors hover:text-white sm:inline-flex">
            Store
          </a>
          <a href={outdoorUrl} className="hidden rounded-full px-3 py-2 text-sm font-medium text-white/75 transition-colors hover:text-white sm:inline-flex">
            Outdoor
          </a>
          <a
            href={LOGIN_HREF}
            className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold text-white backdrop-blur transition-colors hover:border-[var(--s2u-orange)] hover:bg-[var(--s2u-orange)]"
          >
            <LogIn className="h-4 w-4" />
            Business Login
          </a>
        </nav>
      </div>
    </header>
  )
}

/* ── Hero with 3D device stage ─────────────────────────────────────────── */

function HeroStage() {
  const reduce = useReducedMotion()
  const px = useMotionValue(0)
  const py = useMotionValue(0)
  const rotateY = useSpring(useTransform(px, [-0.5, 0.5], [-22, 22]), { stiffness: 120, damping: 16 })
  const rotateX = useSpring(useTransform(py, [-0.5, 0.5], [14, -14]), { stiffness: 120, damping: 16 })
  const shiftX = useSpring(useTransform(px, [-0.5, 0.5], [-18, 18]), { stiffness: 80, damping: 20 })

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (reduce) return
    const r = e.currentTarget.getBoundingClientRect()
    px.set((e.clientX - r.left) / r.width - 0.5)
    py.set((e.clientY - r.top) / r.height - 0.5)
  }

  const chips = [
    { label: 'Serapod2U Store', className: 'left-0 top-[18%]', delay: '0s' },
    { label: 'Serapod Outdoor', className: 'right-0 top-[30%]', delay: '1.2s' },
    { label: 'Cellera Hero', className: 'left-[4%] bottom-[22%]', delay: '2.1s' },
    { label: 'Ellbow', className: 'right-[6%] bottom-[14%]', delay: '0.6s' },
  ]

  return (
    <div
      className="s2u-stage relative mx-auto aspect-square w-full max-w-[560px]"
      onPointerMove={onMove}
      onPointerLeave={() => { px.set(0); py.set(0) }}
    >
      <div className="absolute inset-[12%] rounded-full bg-[radial-gradient(circle,rgba(232,93,4,0.45),rgba(232,93,4,0.08)_45%,transparent_70%)] blur-2xl" />
      <div className="s2u-ring s2u-ring--1"><span className="s2u-ring-dot" /></div>
      <div className="s2u-ring s2u-ring--2" />
      <div className="s2u-ring s2u-ring--3"><span className="s2u-ring-dot" /></div>

      <motion.div
        className="absolute inset-0 flex items-center justify-center"
        style={{ rotateX, rotateY, x: shiftX, transformStyle: 'preserve-3d' }}
      >
        <div className="s2u-device-float relative h-[78%]" style={{ transform: 'translateZ(60px)' }}>
          <Image
            src="/brand/serapod-device-hero.png"
            alt="Serapod device"
            width={437}
            height={2030}
            priority
            className="h-full w-auto drop-shadow-[0_40px_60px_rgba(0,0,0,0.65)]"
          />
        </div>
      </motion.div>
      <div className="s2u-device-shadow absolute bottom-[7%] left-1/2 h-6 w-40 rounded-[50%] bg-black/70 blur-xl" />

      {chips.map((chip) => (
        <div key={chip.label} className={`absolute ${chip.className}`}>
          <div
            className="s2u-chip-bob rounded-full border border-white/15 bg-white/10 px-3.5 py-1.5 text-xs font-semibold tracking-wide text-white/90 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.6)] backdrop-blur-md sm:text-[13px]"
            style={{ animationDelay: chip.delay }}
          >
            <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-[var(--s2u-orange)] align-middle" />
            {chip.label}
          </div>
        </div>
      ))}
    </div>
  )
}

function Hero({ outdoorUrl }: { outdoorUrl: string }) {
  const words = ['One', 'house.', 'Many', 'brands.']
  return (
    <section className="relative isolate overflow-hidden bg-[var(--s2u-ink)] pb-16 pt-28 text-white sm:pt-32 lg:min-h-[100svh] lg:pb-0">
      <div className="s2u-aurora" aria-hidden="true" />
      <div className="s2u-grid" aria-hidden="true" />
      <div className="mx-auto grid max-w-7xl items-center gap-10 px-5 sm:px-8 lg:min-h-[calc(100svh-8rem)] lg:grid-cols-[1.05fr_1fr]">
        <div>
          <motion.p
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: EASE }}
            className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-white/70"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--s2u-orange)]" />
            Serapod · Malaysia
          </motion.p>
          <h1 className="font-display mt-6 text-[3.1rem] font-semibold leading-[0.95] tracking-tight sm:text-7xl lg:text-[5.6rem]">
            {words.map((word, i) => (
              <span key={word} className="mr-[0.22em] inline-block overflow-hidden pb-2 align-bottom">
                <motion.span
                  className={`inline-block ${i >= 2 ? 'text-[var(--s2u-orange)]' : ''}`}
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
            className="mt-6 max-w-xl text-base leading-relaxed text-white/70 sm:text-lg"
          >
            A Malaysian brand family built on trust, quality, and modern commerce — each business with its own identity under one Serapod house.
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: EASE, delay: 0.7 }}
            className="mt-9 flex flex-wrap gap-3"
          >
            <a
              href={STORE_HREF}
              className="group inline-flex h-12 items-center gap-2 rounded-full bg-[var(--s2u-orange)] px-6 text-sm font-semibold text-white shadow-[0_18px_40px_-14px_rgba(232,93,4,0.9)] transition-all hover:bg-[var(--s2u-orange-deep)]"
            >
              Shop Serapod2U Store
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </a>
            <a
              href={outdoorUrl}
              className="group inline-flex h-12 items-center gap-2 rounded-full border border-white/20 px-6 text-sm font-semibold text-white transition-colors hover:border-white/50 hover:bg-white/5"
            >
              Explore Serapod Outdoor
              <ArrowUpRight className="h-4 w-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
            </a>
          </motion.div>
        </div>

        <motion.div
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1.1, ease: EASE, delay: 0.25 }}
        >
          <HeroStage />
        </motion.div>
      </div>
    </section>
  )
}

/* ── Brand hub ─────────────────────────────────────────────────────────── */

const HUB_POINTS = [
  { x: 50, y: 12 },
  { x: 85, y: 50 },
  { x: 50, y: 86 },
  { x: 15, y: 50 },
]

function BrandHub({ list }: { list: Brand[] }) {
  const reduce = useReducedMotion()
  const [active, setActive] = useState(0)
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    if (paused || reduce) return
    const t = setInterval(() => setActive((i) => (i + 1) % list.length), 3800)
    return () => clearInterval(t)
  }, [paused, reduce, list.length])

  return (
    <section className="relative overflow-hidden bg-[var(--s2u-paper)] py-24 sm:py-32">
      <div className="pointer-events-none absolute -right-40 top-10 h-[480px] w-[480px] rounded-full bg-[radial-gradient(circle,rgba(232,93,4,0.12),transparent_65%)]" />
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <Reveal className="max-w-2xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--s2u-orange)]">The Serapod house</p>
          <h2 className="font-display mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">Every brand, its own identity.</h2>
          <p className="mt-4 text-[var(--s2u-muted)] sm:text-lg">Choose a brand to see where to find it.</p>
        </Reveal>

        <div className="mt-14 grid items-center gap-12 lg:grid-cols-[1fr_1.1fr]">
          <div className="space-y-3" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
            {list.map((brand, i) => {
              const on = i === active
              return (
                <motion.a
                  key={brand.id}
                  href={brand.href}
                  onMouseEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  initial={{ opacity: 0, x: -24 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.6, ease: EASE, delay: i * 0.08 }}
                  className={`group relative flex items-center gap-4 overflow-hidden rounded-2xl border p-4 transition-all duration-500 sm:p-5 ${on ? 'border-[var(--s2u-orange)]/40 bg-white shadow-[0_20px_50px_-24px_rgba(232,93,4,0.55)]' : 'border-transparent bg-white/50 hover:bg-white'}`}
                >
                  <span className="h-12 w-12 shrink-0 overflow-hidden rounded-2xl shadow-sm ring-1 ring-black/5">{brand.mark}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-[var(--s2u-ink)]">{brand.name}</span>
                    <span className="mt-0.5 block text-sm text-[var(--s2u-muted)]">{brand.line}</span>
                  </span>
                  <span className={`hidden items-center gap-1 text-sm font-semibold sm:inline-flex ${on ? 'text-[var(--s2u-orange)]' : 'text-[var(--s2u-muted)]'}`}>
                    {brand.cta}
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                  </span>
                  {on && !paused && !reduce && (
                    <motion.span
                      key={`bar-${active}`}
                      className="absolute bottom-0 left-0 h-[2px] bg-[var(--s2u-orange)]"
                      initial={{ width: '0%' }}
                      animate={{ width: '100%' }}
                      transition={{ duration: 3.8, ease: 'linear' }}
                    />
                  )}
                </motion.a>
              )
            })}
          </div>

          <Reveal delay={0.15}>
            <div className="relative mx-auto aspect-square w-full max-w-[520px]">
              <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" aria-hidden="true">
                <circle cx="50" cy="50" r="39" fill="none" stroke="rgba(18,20,23,0.08)" strokeWidth="0.3" />
                <circle cx="50" cy="50" r="27" fill="none" stroke="rgba(232,93,4,0.18)" strokeWidth="0.3" strokeDasharray="1 2" />
                {HUB_POINTS.map((p, i) => (
                  <line
                    key={i}
                    x1="50"
                    y1="50"
                    x2={p.x}
                    y2={p.y}
                    className={i === active ? 's2u-flow' : undefined}
                    stroke={i === active ? '#e85d04' : 'rgba(18,20,23,0.18)'}
                    strokeWidth={i === active ? 0.7 : 0.35}
                    strokeDasharray={i === active ? undefined : '1.2 1.8'}
                  />
                ))}
                {!reduce && (
                  <motion.circle
                    key={`dot-${active}`}
                    r="1.4"
                    fill="#e85d04"
                    initial={{ cx: 50, cy: 50, opacity: 0 }}
                    animate={{ cx: HUB_POINTS[active].x, cy: HUB_POINTS[active].y, opacity: [0, 1, 1, 0] }}
                    transition={{ duration: 1.6, ease: 'easeInOut', repeat: Infinity, repeatDelay: 0.3 }}
                  />
                )}
              </svg>

              <div className="s2u-pulse absolute left-1/2 top-1/2 flex h-[30%] w-[30%] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[1.75rem] bg-[var(--s2u-ink)] shadow-[0_30px_60px_-20px_rgba(18,20,23,0.7)]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/serapod-wordmark-light.png" alt="Serapod" className="w-[72%]" />
              </div>

              {list.map((brand, i) => {
                const p = HUB_POINTS[i]
                const on = i === active
                return (
                  <button
                    key={brand.id}
                    type="button"
                    onClick={() => setActive(i)}
                    onMouseEnter={() => { setActive(i); setPaused(true) }}
                    onMouseLeave={() => setPaused(false)}
                    className="absolute -translate-x-1/2 -translate-y-1/2 text-center"
                    style={{ left: `${p.x}%`, top: `${p.y}%` }}
                    aria-label={brand.name}
                  >
                    <motion.span
                      animate={{ scale: on ? 1.12 : 1 }}
                      transition={{ type: 'spring', stiffness: 260, damping: 18 }}
                      className={`mx-auto block h-14 w-14 overflow-hidden rounded-2xl ring-2 transition-shadow sm:h-16 sm:w-16 ${on ? 'shadow-[0_18px_40px_-12px_rgba(232,93,4,0.7)] ring-[var(--s2u-orange)]' : 'shadow-md ring-white'}`}
                    >
                      {brand.mark}
                    </motion.span>
                    <span className={`mt-2 block whitespace-nowrap text-[11px] font-semibold sm:text-xs ${on ? 'text-[var(--s2u-ink)]' : 'text-[var(--s2u-muted)]'}`}>
                      {brand.name}
                    </span>
                  </button>
                )
              })}
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}

/* ── Live products from the store ──────────────────────────────────────── */

function ProductCard({ product }: { product: LandingProduct }) {
  return (
    <a href={`/store/products/${product.id}`} className="block w-[230px] shrink-0 sm:w-[260px]">
      <TiltCard max={8} className="h-full">
        <div className="group h-full overflow-hidden rounded-3xl border border-white/10 bg-white shadow-[0_24px_50px_-28px_rgba(0,0,0,0.8)]">
          <div className="relative aspect-square overflow-hidden bg-white">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={product.image}
              alt={product.name}
              loading="lazy"
              className="h-full w-full object-contain p-5 transition-transform duration-700 group-hover:scale-110"
            />
            <div className="s2u-sheen pointer-events-none absolute inset-0 opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
          <div className="p-4">
            {product.category && (
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--s2u-orange)]">{product.category}</p>
            )}
            <p className="mt-1 line-clamp-2 min-h-[2.5rem] text-sm font-semibold leading-snug text-[var(--s2u-ink)]">{product.name}</p>
            {product.price != null && product.price > 0 && (
              <p className="mt-2 text-sm text-[var(--s2u-muted)]">
                From <span className="font-semibold text-[var(--s2u-ink)]">{money(product.price)}</span>
              </p>
            )}
          </div>
        </div>
      </TiltCard>
    </a>
  )
}

function LiveProducts({ products }: { products: LandingProduct[] }) {
  if (products.length === 0) return null
  const half = Math.ceil(products.length / 2)
  const rows = products.length >= 8 ? [products.slice(0, half), products.slice(half)] : [products]

  return (
    <section className="relative overflow-hidden bg-[var(--s2u-ink)] py-24 text-white sm:py-28">
      <div className="pointer-events-none absolute left-1/2 top-0 h-px w-2/3 -translate-x-1/2 bg-gradient-to-r from-transparent via-[var(--s2u-orange)]/60 to-transparent" />
      <div className="mx-auto flex max-w-7xl flex-wrap items-end justify-between gap-6 px-5 sm:px-8">
        <Reveal>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--s2u-orange)]">Serapod2U Store</p>
          <h2 className="font-display mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">New in the store.</h2>
        </Reveal>
        <Reveal delay={0.1}>
          <a href="/store/products" className="group inline-flex items-center gap-2 text-sm font-semibold text-white/80 hover:text-white">
            View all products
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
          </a>
        </Reveal>
      </div>

      <div className="mt-12 space-y-6">
        {rows.map((row, r) => {
          const moving = row.length >= 4
          const loop = moving ? [...row, ...row] : row
          return (
            <div key={r} className={moving ? 's2u-marquee overflow-hidden py-3' : 'overflow-x-auto py-3'}>
              <div
                className={`s2u-marquee-track gap-6 px-5 sm:px-8 ${r === 1 ? 's2u-marquee-track--reverse' : ''} ${moving ? '' : 'lg:mx-auto'}`}
                style={{
                  ['--s2u-marquee-duration' as string]: `${Math.max(30, row.length * 7)}s`,
                  ...(row.length < 4 ? { animation: 'none' } : {}),
                }}
              >
                {loop.map((p, i) => (
                  <ProductCard key={`${p.id}-${i}`} product={p} />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/* ── Serapod Outdoor colourways ────────────────────────────────────────── */

const COLOURWAYS = [
  { id: 'burgundy', label: 'Burgundy', swatch: '#8a1c2e' },
  { id: 'grey', label: 'Grey', swatch: '#8d969e' },
  { id: 'pink', label: 'Pink', swatch: '#e7a3b6' },
] as const

function OutdoorColourways({ outdoorUrl }: { outdoorUrl: string }) {
  const [colour, setColour] = useState<(typeof COLOURWAYS)[number]['id']>('burgundy')
  const ref = useRef<HTMLDivElement>(null)
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] })
  const y1 = useTransform(scrollYProgress, [0, 1], [60, -60])
  const y2 = useTransform(scrollYProgress, [0, 1], [-30, 50])
  const y3 = useTransform(scrollYProgress, [0, 1], [90, -30])

  return (
    <section ref={ref} className="relative overflow-hidden bg-[var(--s2u-paper)] py-24 sm:py-32">
      <div className="mx-auto grid max-w-7xl items-center gap-14 px-5 sm:px-8 lg:grid-cols-2">
        <div>
          <Reveal>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--s2u-orange)]">Serapod Outdoor</p>
            <h2 className="font-display mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">Pick your colourway.</h2>
            <p className="mt-4 max-w-md text-[var(--s2u-muted)] sm:text-lg">Tumblers and camping mats in burgundy, grey and pink.</p>
          </Reveal>

          <Reveal delay={0.1}>
            <div className="mt-8 inline-flex rounded-full border border-[var(--s2u-line)] bg-white p-1.5 shadow-sm">
              {COLOURWAYS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setColour(c.id)}
                  className={`relative flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors ${colour === c.id ? 'text-white' : 'text-[var(--s2u-muted)] hover:text-[var(--s2u-ink)]'}`}
                >
                  {colour === c.id && (
                    <motion.span layoutId="s2u-colour" className="absolute inset-0 rounded-full bg-[var(--s2u-ink)]" transition={{ type: 'spring', stiffness: 380, damping: 30 }} />
                  )}
                  <span className="relative h-3.5 w-3.5 rounded-full ring-2 ring-white/70" style={{ background: c.swatch }} />
                  <span className="relative">{c.label}</span>
                </button>
              ))}
            </div>
          </Reveal>

          <div className="mt-8 grid grid-cols-2 gap-4 sm:gap-5">
            {(['tumbler', 'mat'] as const).map((item, i) => (
              <Reveal key={item} delay={0.15 + i * 0.08}>
                <TiltCard max={9}>
                  <div className="relative aspect-square overflow-hidden rounded-3xl border border-[var(--s2u-line)] bg-white shadow-[0_30px_60px_-36px_rgba(18,20,23,0.45)]">
                    <AnimatePresence mode="wait">
                      <motion.div
                        key={`${item}-${colour}`}
                        initial={{ opacity: 0, rotateY: -35, scale: 0.9 }}
                        animate={{ opacity: 1, rotateY: 0, scale: 1 }}
                        exit={{ opacity: 0, rotateY: 35, scale: 0.9 }}
                        transition={{ duration: 0.45, ease: EASE }}
                        className="absolute inset-0"
                      >
                        <Image
                          src={`/outdoor/products/${item}-${colour}.png`}
                          alt={`Serapod Outdoor ${item === 'tumbler' ? 'tumbler' : 'camping mat'}, ${colour}`}
                          fill
                          sizes="(min-width: 1024px) 280px, 45vw"
                          className="object-contain p-3"
                        />
                      </motion.div>
                    </AnimatePresence>
                    <span className="absolute bottom-3 left-3 rounded-full bg-[var(--s2u-ink)]/85 px-3 py-1 text-[11px] font-semibold text-white">
                      {item === 'tumbler' ? 'Tumbler' : 'Camping mat'}
                    </span>
                  </div>
                </TiltCard>
              </Reveal>
            ))}
          </div>

          <Reveal delay={0.25}>
            <a
              href={outdoorUrl}
              className="group mt-9 inline-flex h-12 items-center gap-2 rounded-full bg-[var(--s2u-ink)] px-6 text-sm font-semibold text-white transition-colors hover:bg-[var(--s2u-orange)]"
            >
              Explore Serapod Outdoor
              <ArrowUpRight className="h-4 w-4 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
            </a>
          </Reveal>
        </div>

        <div className="relative h-[540px] sm:h-[720px]">
          <motion.div style={{ y: y1 }} className="absolute left-0 top-[12%] w-[54%]">
            <TiltCard max={6}>
              <div className="relative aspect-[3/4] overflow-hidden rounded-3xl shadow-[0_40px_80px_-40px_rgba(18,20,23,0.6)]">
                <Image src="/outdoor/brand/photos/artboard-2.jpg" alt="Serapod Outdoor moonchair and tumbler" fill sizes="(min-width: 1024px) 340px, 55vw" className="object-cover" />
              </div>
            </TiltCard>
          </motion.div>
          <motion.div style={{ y: y2 }} className="absolute right-0 top-0 w-[42%]">
            <TiltCard max={6}>
              <div className="relative aspect-[3/4] overflow-hidden rounded-3xl shadow-[0_40px_80px_-40px_rgba(18,20,23,0.6)]">
                <Image src="/outdoor/brand/photos/artboard-3.jpg" alt="Serapod Outdoor tumbler" fill sizes="(min-width: 1024px) 260px, 42vw" className="object-cover" />
              </div>
            </TiltCard>
          </motion.div>
          <motion.div style={{ y: y3 }} className="absolute bottom-0 right-0 w-[42%]">
            <TiltCard max={6}>
              <div className="relative aspect-[3/4] overflow-hidden rounded-3xl shadow-[0_40px_80px_-40px_rgba(18,20,23,0.6)]">
                <Image src="/outdoor/brand/photos/artboard-5.jpg" alt="Serapod Outdoor tumbler and camping mat" fill sizes="(min-width: 1024px) 260px, 42vw" className="object-cover" />
              </div>
            </TiltCard>
          </motion.div>
        </div>
      </div>
    </section>
  )
}

/* ── Staff and partners ────────────────────────────────────────────────── */

function BusinessBand() {
  return (
    <section className="bg-[var(--s2u-paper)] px-5 pb-24 sm:px-8">
      <Reveal className="mx-auto max-w-7xl">
        <div className="relative isolate overflow-hidden rounded-[2rem] bg-[var(--s2u-ink)] px-7 py-12 text-white sm:px-14 sm:py-16">
          <div className="absolute -right-24 -top-24 -z-10 h-80 w-80 rounded-full bg-[radial-gradient(circle,rgba(232,93,4,0.55),transparent_65%)] blur-2xl" />
          <div className="absolute -bottom-32 left-1/3 -z-10 h-72 w-72 rounded-full bg-[radial-gradient(circle,rgba(255,138,61,0.25),transparent_65%)] blur-2xl" />
          <div className="flex flex-col items-start justify-between gap-8 lg:flex-row lg:items-center">
            <div className="max-w-xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--s2u-orange-soft)]">Staff, distributors and partners</p>
              <h2 className="font-display mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Sign in to the Serapod business portal.</h2>
            </div>
            <div className="flex flex-wrap gap-3">
              <a
                href={LOGIN_HREF}
                className="group inline-flex h-12 items-center gap-2 rounded-full bg-[var(--s2u-orange)] px-6 text-sm font-semibold text-white transition-colors hover:bg-[var(--s2u-orange-deep)]"
              >
                <LogIn className="h-4 w-4" />
                Business Login
              </a>
              <a
                href={CUSTOMER_LOGIN_HREF}
                className="inline-flex h-12 items-center rounded-full border border-white/20 px-6 text-sm font-semibold text-white/85 transition-colors hover:border-white/50 hover:text-white"
              >
                Customer sign in
              </a>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  )
}

function Footer({ outdoorUrl }: { outdoorUrl: string }) {
  return (
    <footer className="bg-[var(--s2u-ink)] text-white/70">
      <div className="mx-auto grid max-w-7xl gap-10 px-5 py-14 sm:grid-cols-2 sm:px-8 lg:grid-cols-4">
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/serapod-wordmark-light.png" alt="Serapod" className="h-8 w-auto" width={160} height={44} />
          <p className="mt-4 max-w-xs text-sm leading-relaxed">A Malaysian brand family under one Serapod house.</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white">Shop</p>
          <ul className="mt-4 space-y-2.5 text-sm">
            <li><a href={STORE_HREF} className="hover:text-white">Serapod2U Store</a></li>
            <li><a href={outdoorUrl} className="hover:text-white">Serapod Outdoor</a></li>
          </ul>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white">Sign in</p>
          <ul className="mt-4 space-y-2.5 text-sm">
            <li><a href={LOGIN_HREF} className="hover:text-white">Business Login</a></li>
            <li><a href={CUSTOMER_LOGIN_HREF} className="hover:text-white">Customer sign in</a></li>
          </ul>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white">Legal</p>
          <ul className="mt-4 space-y-2.5 text-sm">
            <li><a href="/privacy-policy" className="hover:text-white">Privacy Policy</a></li>
            <li><a href="/terms-of-service" className="hover:text-white">Terms of Service</a></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-white/10 px-5 py-6 text-center text-xs text-white/45 sm:px-8">
        © {new Date().getFullYear()} Serapod. All rights reserved.
      </div>
    </footer>
  )
}

export default function Serapod2uLanding({ products, outdoorUrl }: { products: LandingProduct[]; outdoorUrl: string }) {
  const list = brands(outdoorUrl)
  return (
    <div className="s2u bg-[var(--s2u-paper)] text-[var(--s2u-ink)]">
      <Header outdoorUrl={outdoorUrl} />
      <main>
        <Hero outdoorUrl={outdoorUrl} />
        <BrandHub list={list} />
        <LiveProducts products={products} />
        <OutdoorColourways outdoorUrl={outdoorUrl} />
        <BusinessBand />
      </main>
      <Footer outdoorUrl={outdoorUrl} />
    </div>
  )
}
