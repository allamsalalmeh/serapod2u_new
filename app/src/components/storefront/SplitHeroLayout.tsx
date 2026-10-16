'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react'
import useEmblaCarousel from 'embla-carousel-react'
import Autoplay from 'embla-carousel-autoplay'
import { motion, AnimatePresence } from 'framer-motion'
import HeroMedia from './HeroMedia'

// ── Types ─────────────────────────────────────────────────────────

interface HeroBanner {
  id: string
  title: string
  subtitle: string
  badge_text: string
  image_url: string
  link_url: string
  link_text: string
  layout_slot?: string
  animation_enabled?: boolean
  animation_style?: 'none' | 'kenburns' | 'floatGlow' | 'parallax'
  animation_intensity?: 'low' | 'medium' | 'high'
}

interface SplitHeroLayoutProps {
  /** Banners assigned to the main carousel (layout_slot = 'carousel' or 'split_main') */
  mainBanners: HeroBanner[]
  /** Side banners: [top, bottom] — layout_slot 'split_side_top' / 'split_side_bottom' */
  sideBanners: [HeroBanner | null, HeroBanner | null]
  interval?: number
}

// ── Animation ─────────────────────────────────────────────────────

const textContainer = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.1, delayChildren: 0.12 } },
}

const textItem = {
  hidden: { opacity: 0, y: 16 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: [0.25, 0.46, 0.45, 0.94] as [number, number, number, number] },
  },
}

// ── Side Banner Card ──────────────────────────────────────────────

function SideBannerCard({ banner }: { banner: HeroBanner }) {
  const Wrapper = banner.link_url ? Link : 'div'
  const wrapperProps = banner.link_url
    ? { href: banner.link_url }
    : {}

  return (
    <Wrapper
      {...(wrapperProps as any)}
      className="group relative block w-full h-full rounded-xl overflow-hidden"
    >
      {/* Image */}
      <div className="absolute inset-0">
        {banner.image_url ? (
          <Image
            src={banner.image_url}
            alt={banner.title || 'Promo banner'}
            fill
            className="object-cover transition-transform duration-500 group-hover:scale-105"
            sizes="(max-width: 1024px) 100vw, 33vw"
            unoptimized
          />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-gray-700 to-gray-800" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/20 to-transparent" />
      </div>

      {/* Content overlay */}
      <div className="relative h-full flex flex-col justify-end p-4">
        {banner.badge_text && (
          <span className="inline-block w-fit px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white bg-[var(--sera-orange)]/85 backdrop-blur-sm rounded-full mb-1.5">
            {banner.badge_text}
          </span>
        )}
        {banner.title && (
          <h3 className="text-sm sm:text-base font-bold text-white line-clamp-2 leading-tight">
            {banner.title}
          </h3>
        )}
        {banner.subtitle && (
          <p className="text-[11px] text-white/55 mt-0.5 line-clamp-1">
            {banner.subtitle}
          </p>
        )}
        {banner.link_url && banner.link_text && (
          <span className="inline-flex items-center gap-1 mt-2 text-[11px] font-semibold text-[var(--sera-orange)] group-hover:text-[#ff8a3d] transition-colors">
            {banner.link_text}
            <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
          </span>
        )}
      </div>
    </Wrapper>
  )
}

// ── Main Component ────────────────────────────────────────────────

export default function SplitHeroLayout({
  mainBanners,
  sideBanners,
  interval = 6000,
}: SplitHeroLayoutProps) {
  const count = mainBanners.length
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setPrefersReducedMotion(mq.matches)
    const handler = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  const autoplayRef = useRef(
    Autoplay({
      delay: interval,
      stopOnInteraction: false,
      stopOnMouseEnter: true,
      stopOnFocusIn: true,
    })
  )

  const [emblaRef, emblaApi] = useEmblaCarousel(
    { loop: count > 1, skipSnaps: false, duration: prefersReducedMotion ? 0 : 30 },
    count > 1 && !prefersReducedMotion && interval > 0 ? [autoplayRef.current] : []
  )

  const onSelect = useCallback(() => {
    if (!emblaApi) return
    setSelectedIndex(emblaApi.selectedScrollSnap())
  }, [emblaApi])

  useEffect(() => {
    if (!emblaApi) return
    emblaApi.on('select', onSelect)
    onSelect()
    return () => { emblaApi.off('select', onSelect) }
  }, [emblaApi, onSelect])

  const scrollPrev = useCallback(() => emblaApi?.scrollPrev(), [emblaApi])
  const scrollNext = useCallback(() => emblaApi?.scrollNext(), [emblaApi])
  const scrollTo = useCallback((i: number) => emblaApi?.scrollTo(i), [emblaApi])

  const [sideTop, sideBottom] = sideBanners
  const hasSides = sideTop || sideBottom

  return (
    <section
      className="bg-[var(--sera-mist)]"
      role="region"
      aria-label="Store promotions"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
        <div className={`grid gap-3 ${hasSides ? 'lg:grid-cols-[2fr_1fr]' : 'grid-cols-1'}`}>
          {/* Main carousel (left) */}
          <div className="relative rounded-xl overflow-hidden bg-[var(--sera-ink)] min-h-[280px] sm:min-h-[380px] lg:min-h-[420px]">
            {/* Gradient animation */}
            <div
              className="absolute inset-0 opacity-30 pointer-events-none z-[1]"
              style={{
                background: 'radial-gradient(ellipse at 20% 50%, rgba(59,130,246,0.12), transparent 55%)',
                animation: prefersReducedMotion ? 'none' : 'heroGradientShift 12s ease-in-out infinite alternate',
              }}
            />

            <div ref={emblaRef} className="overflow-hidden h-full">
              <div className="flex h-full" style={{ touchAction: 'pan-y pinch-zoom' }}>
                {mainBanners.map((banner, index) => (
                  <div
                    key={banner.id}
                    className="relative flex-[0_0_100%] min-w-0 h-full min-h-[280px] sm:min-h-[380px] lg:min-h-[420px]"
                    role="group"
                    aria-roledescription="slide"
                    aria-label={`Slide ${index + 1} of ${count}`}
                  >
                    {/* BG image with optional animation */}
                    <HeroMedia
                      imageUrl={banner.image_url}
                      alt={banner.title || 'Hero banner'}
                      animationEnabled={banner.animation_enabled}
                      animationStyle={banner.animation_style || 'none'}
                      intensity={banner.animation_intensity || 'low'}
                      context="landing"
                      priority={index === 0}
                    />

                    {/* Text content */}
                    <div className="relative h-full flex items-center">
                      <div className="px-6 sm:px-10 py-8 max-w-xl">
                        <AnimatePresence mode="wait">
                          {selectedIndex === index && (
                            <motion.div
                              key={banner.id}
                              variants={prefersReducedMotion ? undefined : textContainer}
                              initial={prefersReducedMotion ? undefined : 'hidden'}
                              animate={prefersReducedMotion ? undefined : 'visible'}
                              exit={prefersReducedMotion ? undefined : 'hidden'}
                            >
                              {banner.badge_text && (
                                <motion.span
                                  variants={prefersReducedMotion ? undefined : textItem}
                                  className="inline-block px-2.5 py-0.5 text-[10px] sm:text-xs font-semibold uppercase tracking-wider text-[var(--sera-orange)] bg-[var(--sera-orange)]/15 backdrop-blur-sm rounded-full mb-3 border border-[var(--sera-orange)]/25"
                                >
                                  {banner.badge_text}
                                </motion.span>
                              )}

                              {banner.title && (
                                <motion.h2
                                  variants={prefersReducedMotion ? undefined : textItem}
                                  className="text-2xl sm:text-3xl lg:text-4xl font-bold text-white leading-tight tracking-tight"
                                >
                                  {banner.title.split(',').map((part, i, arr) =>
                                    i === arr.length - 1 && arr.length > 1 ? (
                                      <span key={i} className="text-transparent bg-clip-text bg-gradient-to-r from-[var(--sera-orange)] to-[#ff8a3d]">
                                        {part}
                                      </span>
                                    ) : (
                                      <span key={i}>{part}{i < arr.length - 1 ? ',' : ''}</span>
                                    )
                                  )}
                                </motion.h2>
                              )}

                              {banner.subtitle && (
                                <motion.p
                                  variants={prefersReducedMotion ? undefined : textItem}
                                  className="mt-3 text-sm sm:text-base text-white/65 max-w-md leading-relaxed"
                                >
                                  {banner.subtitle}
                                </motion.p>
                              )}

                              {banner.link_url && (
                                <motion.div variants={prefersReducedMotion ? undefined : textItem} className="mt-5 flex flex-wrap gap-2">
                                  <Link
                                    href={banner.link_url}
                                    className="group/cta inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-[var(--sera-orange)] rounded-xl hover:bg-[var(--sera-orange-deep)] hover:scale-[1.02] hover:shadow-lg hover:shadow-[var(--sera-orange)]/25 transition-all duration-200"
                                  >
                                    {banner.link_text || 'Shop Now'}
                                    <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover/cta:translate-x-0.5" />
                                  </Link>
                                </motion.div>
                              )}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Arrows */}
            {count > 1 && (
              <>
                <button
                  onClick={scrollPrev}
                  className="absolute left-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/10 backdrop-blur-sm text-white/70 hover:bg-white/20 hover:text-white transition-all border border-white/10 hidden sm:flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-white/30"
                  aria-label="Previous slide"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  onClick={scrollNext}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-white/10 backdrop-blur-sm text-white/70 hover:bg-white/20 hover:text-white transition-all border border-white/10 hidden sm:flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-white/30"
                  aria-label="Next slide"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </>
            )}

            {/* Dots */}
            {count > 1 && (
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5" role="tablist" aria-label="Slide indicators">
                {mainBanners.map((_, i) => (
                  <button
                    key={i}
                    onClick={() => scrollTo(i)}
                    role="tab"
                    aria-selected={i === selectedIndex}
                    className={`h-1.5 rounded-full transition-all focus:outline-none ${i === selectedIndex ? 'w-5 bg-white' : 'w-1.5 bg-white/40 hover:bg-white/60'
                      }`}
                    aria-label={`Go to slide ${i + 1}`}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Side banners (right) */}
          {hasSides && (
            <div className="hidden lg:flex flex-col gap-3">
              {sideTop && (
                <div className="flex-1 min-h-[200px]">
                  <SideBannerCard banner={sideTop} />
                </div>
              )}
              {sideBottom && (
                <div className="flex-1 min-h-[200px]">
                  <SideBannerCard banner={sideBottom} />
                </div>
              )}
              {/* If only one side banner, fill the other slot with a gradient placeholder */}
              {!sideTop && sideBottom && (
                <div className="flex-1 min-h-[200px] rounded-xl bg-gradient-to-br from-gray-100 to-gray-200" />
              )}
              {sideTop && !sideBottom && (
                <div className="flex-1 min-h-[200px] rounded-xl bg-gradient-to-br from-gray-100 to-gray-200" />
              )}
            </div>
          )}
        </div>
      </div>

      <style jsx>{`
        @keyframes heroGradientShift {
          0% { transform: translateX(0) scale(1); }
          100% { transform: translateX(3%) scale(1.05); }
        }
      `}</style>
    </section>
  )
}
