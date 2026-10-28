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
import { ArrowRight, ArrowUpRight } from 'lucide-react'
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
      name: 'Serapod Store',
      line: 'The online store for Serapod devices, electronics, pet food and accessories.',
      href: STORE_HREF,
      cta: 'Shop the store',
      mark: (
        // eslint-disable-next-line @next/next/no-img-element
        <img src="/icons/icon-192x192.png" alt="" className="h-full w-full rounded-2xl bg-white object-contain" />
      ),
    },
    {
      id: 'outdoor',
      name: 'Serapod Outdoor',
      line: 'Moonchairs, camping mats and tumblers.',
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
      line: 'Ellbow cat treats, available in the Serapod Store.',
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
          <a href={STORE_HREF} className="rounded-full px-3 py-2 text-sm font-medium text-white/75 transition-colors hover:text-white">
            Store
          </a>
          <a href={outdoorUrl} className="rounded-full px-3 py-2 text-sm font-medium text-white/75 transition-colors hover:text-white">
            Outdoor
          </a>
        </nav>
      </div>
    </header>
  )
}

/* ── Hero with a 3D product carousel ───────────────────────────────────── */

const OUTDOOR_CAROUSEL: { image: string; label: string }[] = [
  { image: '/outdoor/products/tumbler-burgundy.png', label: 'Outdoor tumbler' },
  { image: '/outdoor/products/mat-grey.png', label: 'Camping mat' },
  { image: '/outdoor/products/tumbler-pink.png', label: 'Outdoor tumbler' },
  { image: '/outdoor/products/mat-burgundy.png', label: 'Camping mat' },
  { image: '/outdoor/products/tumbler-grey.png', label: 'Outdoor tumbler' },
  { image: '/outdoor/products/mat-pink.png', label: 'Camping mat' },
]

/** Outdoor products and store products alternate, so no single category leads. */
function carouselItems(products: LandingProduct[]) {
  const store = products.slice(0, 4).map((p) => ({ image: p.image, label: p.name }))
  const items: { image: string; label: string }[] = []
  for (let i = 0; items.length < 8 && (i < OUTDOOR_CAROUSEL.length || i < store.length); i++) {
    if (OUTDOOR_CAROUSEL[i]) items.push(OUTDOOR_CAROUSEL[i])
    if (store[i] && items.length < 8) items.push(store[i])
  }
  return items
}

function HeroStage({ products }: { products: LandingProduct[] }) {
  const reduce = useReducedMotion()
  const px = useMotionValue(0)
  const py = useMotionValue(0)
  const rotateY = useSpring(useTransform(px, [-0.5, 0.5], [-14, 14]), { stiffness: 120, damping: 18 })
  const rotateX = useSpring(useTransform(py, [-0.5, 0.5], [6, -14]), { stiffness: 120, damping: 18 })
  const items = carouselItems(products)
  const step = 360 / items.length

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (reduce) return
    const r = e.currentTarget.getBoundingClientRect()
    px.set((e.clientX - r.left) / r.width - 0.5)
    py.set((e.clientY - r.top) / r.height - 0.5)
  }

  return (
    <div
      className="s2u-stage relative mx-auto aspect-square w-full max-w-[560px]"
      onPointerMove={onMove}
      onPointerLeave={() => { px.set(0); py.set(0) }}
    >
      <div className="absolute inset-[14%] rounded-full bg-[radial-gradient(circle,rgba(232,93,4,0.4),rgba(232,93,4,0.08)_45%,transparent_70%)] blur-2xl" />
      <div className="s2u-ring s2u-ring--1" style={{ top: '62%' }}><span className="s2u-ring-dot" /></div>
      <div className="s2u-ring s2u-ring--2" style={{ top: '62%' }} />

      <motion.div
        className="s2u-carousel absolute inset-0"
        style={{ rotateX, rotateY, transformStyle: 'preserve-3d' }}
      >
        <div className="s2u-carousel-spin">
          {items.map((item, i) => (
            <div key={`${item.image}-${i}`} className="s2u-carousel-card" style={{ ['--a' as string]: `${i * step}deg` }}>
              <div className="flex h-full flex-col overflow-hidden rounded-2xl bg-white shadow-[0_30px_60px_-24px_rgba(0,0,0,0.75)] ring-1 ring-white/20">
                <div className="relative flex-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.image} alt="" className="absolute inset-0 h-full w-full object-contain p-3" loading={i < 4 ? 'eager' : 'lazy'} />
                </div>
                <p className="truncate border-t border-black/5 px-3 py-2 text-[11px] font-semibold text-[var(--s2u-ink)]">{item.label}</p>
              </div>
            </div>
          ))}
        </div>
      </motion.div>
      <div className="absolute bottom-[10%] left-1/2 h-8 w-2/3 -translate-x-1/2 rounded-[50%] bg-black/60 blur-2xl" />
    </div>
  )
}

function Hero({ outdoorUrl, products }: { outdoorUrl: string; products: LandingProduct[] }) {
  const words = ['Shop', 'Serapod', 'online.']
  return (
    <section className="relative isolate overflow-hidden bg-[var(--s2u-ink)] pb-16 pt-28 text-white sm:pt-32 lg:min-h-[100svh] lg:pb-0">
      <div className="s2u-aurora" aria-hidden="true" />
      <div className="s2u-grid" aria-hidden="true" />
      <div className="mx-auto grid max-w-7xl items-center gap-10 px-5 sm:px-8 lg:min-h-[calc(100svh-8rem)] lg:grid-cols-[1.05fr_1fr]">
        <div>
          <h1 className="font-display text-[3.1rem] font-semibold leading-[0.95] tracking-tight sm:text-7xl lg:text-[5.6rem]">
            {words.map((word, i) => (
              <span key={word} className="mr-[0.22em] inline-block overflow-hidden pb-2 align-bottom">
                <motion.span
                  className={`inline-block ${i === words.length - 1 ? 'text-[var(--s2u-orange)]' : ''}`}
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
            Serapod devices, electronics, pet food and outdoor gear.
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
              Shop Serapod Store
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
          <HeroStage products={products} />
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
          <h2 className="font-display text-4xl font-semibold tracking-tight sm:text-5xl">Our brands</h2>
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

              <div className="s2u-pulse absolute left-1/2 top-1/2 flex h-[30%] w-[30%] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[1.75rem] border border-[var(--s2u-orange)]/20 bg-white shadow-[0_24px_60px_-24px_rgba(232,93,4,0.55)]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/serapod-wordmark.png" alt="Serapod" className="w-[70%]" />
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
                      className={`mx-auto block h-14 w-14 overflow-hidden rounded-2xl ring-1 transition-shadow sm:h-16 sm:w-16 ${on ? 'shadow-[0_18px_40px_-12px_rgba(232,93,4,0.6)] ring-[var(--s2u-orange)]/60' : 'shadow-md ring-black/5'}`}
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

/** Mirrors the Outdoor section: products on the left, details on the right. */
function StoreShowcase({ products }: { products: LandingProduct[] }) {
  const [index, setIndex] = useState(0)
  if (products.length === 0) return null
  const shown = products.slice(0, 6)
  const current = shown[Math.min(index, shown.length - 1)]

  return (
    <section className="relative overflow-hidden bg-white py-24 sm:py-32">
      <div className="pointer-events-none absolute -left-40 bottom-0 h-[460px] w-[460px] rounded-full bg-[radial-gradient(circle,rgba(232,93,4,0.10),transparent_65%)]" />
      <div className="mx-auto grid max-w-7xl items-center gap-14 px-5 sm:px-8 lg:grid-cols-2">
        <div className="order-2 lg:order-1">
          <Reveal>
            <TiltCard max={7}>
              <a
                href={`/store/products/${current.id}`}
                className="relative block aspect-[4/3] overflow-hidden rounded-[2rem] border border-[var(--s2u-line)] bg-white shadow-[0_40px_80px_-44px_rgba(18,20,23,0.55)]"
              >
                <AnimatePresence mode="wait">
                  <motion.div
                    key={current.id}
                    initial={{ opacity: 0, rotateY: 30, scale: 0.92 }}
                    animate={{ opacity: 1, rotateY: 0, scale: 1 }}
                    exit={{ opacity: 0, rotateY: -30, scale: 0.92 }}
                    transition={{ duration: 0.45, ease: EASE }}
                    className="absolute inset-0"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={current.image}
                      alt={current.name}
                      className="h-full w-full object-contain p-8 sm:p-10"
                      style={{ maskImage: 'linear-gradient(to bottom, #000 72%, transparent 96%)', WebkitMaskImage: 'linear-gradient(to bottom, #000 72%, transparent 96%)' }}
                    />
                  </motion.div>
                </AnimatePresence>
                {current.category && (
                  <span className="absolute left-4 top-4 rounded-full bg-[var(--s2u-ink)]/85 px-3 py-1 text-[11px] font-semibold text-white">
                    {current.category}
                  </span>
                )}
              </a>
            </TiltCard>
          </Reveal>

          {shown.length > 1 && (
            <div className="mt-5 grid grid-cols-3 gap-3 sm:grid-cols-6">
              {shown.map((p, i) => {
                const on = p.id === current.id
                return (
                  <motion.button
                    key={p.id}
                    type="button"
                    onClick={() => setIndex(i)}
                    onMouseEnter={() => setIndex(i)}
                    whileHover={{ y: -4 }}
                    aria-label={p.name}
                    className={`relative aspect-square overflow-hidden rounded-2xl border bg-white transition-shadow ${on ? 'border-[var(--s2u-orange)] shadow-[0_14px_30px_-16px_rgba(232,93,4,0.8)]' : 'border-[var(--s2u-line)] hover:shadow-md'}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.image} alt="" loading="lazy" className="h-full w-full object-contain p-2" />
                  </motion.button>
                )
              })}
            </div>
          )}
        </div>

        <div className="order-1 lg:order-2">
          <Reveal>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--s2u-orange)]">Serapod Store</p>
            <h2 className="font-display mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">Products in the store</h2>
          </Reveal>
          <Reveal delay={0.1}>
            <AnimatePresence mode="wait">
              <motion.div
                key={current.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.3, ease: EASE }}
                className="mt-8 border-l-2 border-[var(--s2u-orange)] pl-5"
              >
                <p className="text-xl font-semibold text-[var(--s2u-ink)] sm:text-2xl">{current.name}</p>
                {current.price != null && current.price > 0 && (
                  <p className="mt-2 text-[var(--s2u-muted)]">
                    From <span className="font-semibold text-[var(--s2u-ink)]">{money(current.price)}</span>
                  </p>
                )}
              </motion.div>
            </AnimatePresence>
          </Reveal>
          <Reveal delay={0.2}>
            <div className="mt-9 flex flex-wrap gap-3">
              <a
                href={`/store/products/${current.id}`}
                className="group inline-flex h-12 items-center gap-2 rounded-full bg-[var(--s2u-ink)] px-6 text-sm font-semibold text-white transition-colors hover:bg-[var(--s2u-orange)]"
              >
                View product
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
              </a>
              <a
                href="/store/products"
                className="inline-flex h-12 items-center rounded-full border border-[var(--s2u-line)] px-6 text-sm font-semibold text-[var(--s2u-ink)] transition-colors hover:border-[var(--s2u-ink)]"
              >
                View all products
              </a>
            </div>
          </Reveal>
        </div>
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
            <h2 className="font-display mt-3 text-4xl font-semibold tracking-tight sm:text-5xl">Tumblers and camping mats</h2>
            <p className="mt-4 max-w-md text-[var(--s2u-muted)] sm:text-lg">Available in burgundy, grey and pink.</p>
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

function Footer({ outdoorUrl }: { outdoorUrl: string }) {
  return (
    <footer className="bg-[var(--s2u-ink)] text-white/70">
      <div className="mx-auto grid max-w-7xl gap-10 px-5 py-14 sm:grid-cols-3 sm:px-8">
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/serapod-wordmark-light.png" alt="Serapod" className="h-8 w-auto" width={160} height={44} />
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white">Shop</p>
          <ul className="mt-4 space-y-2.5 text-sm">
            <li><a href={STORE_HREF} className="hover:text-white">Serapod Store</a></li>
            <li><a href={outdoorUrl} className="hover:text-white">Serapod Outdoor</a></li>
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
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 border-t border-white/10 px-5 py-6 text-xs text-white/45 sm:px-8">
        <span>© {new Date().getFullYear()} Serapod. All rights reserved.</span>
        <a href={LOGIN_HREF} className="hover:text-white/80">Staff login</a>
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
        <Hero outdoorUrl={outdoorUrl} products={products} />
        <BrandHub list={list} />
        <StoreShowcase products={products} />
        <OutdoorColourways outdoorUrl={outdoorUrl} />
      </main>
      <Footer outdoorUrl={outdoorUrl} />
    </div>
  )
}
