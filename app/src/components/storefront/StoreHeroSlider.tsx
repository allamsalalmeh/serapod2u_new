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
  animation_enabled?: boolean
  animation_style?: 'none' | 'kenburns' | 'floatGlow' | 'parallax'
  animation_intensity?: 'low' | 'medium' | 'high'
}

interface StoreHeroCarouselProps {
  banners: HeroBanner[]
  /** Interval in ms between auto-slides. 0 = no auto-rotate. Default: 6000 */
  interval?: number
}

// ── Animation variants (stagger: badge → title → subtitle → CTA) ──

const textContainer = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.12, delayChildren: 0.15 },
  },
}

const textItem = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: [0.25, 0.46, 0.45, 0.94] as [number, number, number, number] },
  },
}

// ── Component ─────────────────────────────────────────────────────

export default function StoreHeroSlider({
  banners,
  interval = 6000,
}: StoreHeroCarouselProps) {
  const count = banners.length
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)

  // Detect prefers-reduced-motion
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setPrefersReducedMotion(mq.matches)
    const handler = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // Autoplay plugin config
  const autoplayRef = useRef(
    Autoplay({
      delay: interval,
      stopOnInteraction: false,
      stopOnMouseEnter: true,
      stopOnFocusIn: true,
    })
  )

  const [emblaRef, emblaApi] = useEmblaCarousel(
    {
      loop: count > 1,
      skipSnaps: false,
      duration: prefersReducedMotion ? 0 : 30,
    },
    count > 1 && !prefersReducedMotion && interval > 0
      ? [autoplayRef.current]
      : []
  )

  // Track selected slide
  const onSelect = useCallback(() => {
    if (!emblaApi) return
    setSelectedIndex(emblaApi.selectedScrollSnap())
  }, [emblaApi])

  useEffect(() => {
    if (!emblaApi) return
    emblaApi.on('select', onSelect)
    onSelect()
    return () => {
      emblaApi.off('select', onSelect)
    }
  }, [emblaApi, onSelect])

  const scrollPrev = useCallback(() => emblaApi?.scrollPrev(), [emblaApi])
  const scrollNext = useCallback(() => emblaApi?.scrollNext(), [emblaApi])
  const scrollTo = useCallback(
    (index: number) => emblaApi?.scrollTo(index),
    [emblaApi]
  )

  if (count === 0) return null

  return (
    <section
      className="relative overflow-hidden bg-[var(--sera-ink)]"
      role="region"
      aria-roledescription="carousel"
      aria-label="Store hero banners"
    >
      {/* Subtle animated gradient background */}
      <div
        className="absolute inset-0 opacity-40 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse at 20% 50%, rgba(59,130,246,0.15), transparent 60%), radial-gradient(ellipse at 80% 50%, rgba(168,85,247,0.1), transparent 60%)',
          animation: prefersReducedMotion
            ? 'none'
            : 'heroGradientShift 12s ease-in-out infinite alternate',
        }}
      />

      {/* Noise overlay for texture */}
      <div
        className="absolute inset-0 opacity-[0.03] pointer-events-none mix-blend-overlay"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
          backgroundSize: '128px 128px',
        }}
      />

      {/* Embla viewport */}
      <div ref={emblaRef} className="overflow-hidden">
        <div className="flex" style={{ touchAction: 'pan-y pinch-zoom' }}>
          {banners.map((banner, index) => (
            <div
              key={banner.id}
              className="relative flex-[0_0_100%] min-w-0"
              role="group"
              aria-roledescription="slide"
              aria-label={`Slide ${index + 1} of ${count}: ${banner.title || 'Banner'}`}
            >
              {/* Background image with optional animation */}
              <HeroMedia
                imageUrl={banner.image_url}
                alt={banner.title || 'Hero banner'}
                animationEnabled={banner.animation_enabled}
                animationStyle={banner.animation_style || 'none'}
                intensity={banner.animation_intensity || 'low'}
                context="landing"
                priority={index === 0}
              />

              {/* Content */}
              <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 sm:py-28 lg:py-36">
                <AnimatePresence mode="wait">
                  {selectedIndex === index && (
                    <motion.div
                      key={banner.id}
                      className="max-w-2xl"
                      variants={prefersReducedMotion ? undefined : textContainer}
                      initial={prefersReducedMotion ? undefined : 'hidden'}
                      animate={prefersReducedMotion ? undefined : 'visible'}
                      exit={prefersReducedMotion ? undefined : 'hidden'}
                    >
                      {banner.badge_text && (
                        <motion.span
                          variants={prefersReducedMotion ? undefined : textItem}
                          className="inline-block px-3 py-1 text-xs font-medium tracking-wider uppercase text-[var(--sera-orange)] bg-[var(--sera-orange)]/15 backdrop-blur-sm rounded-full mb-4 border border-[var(--sera-orange)]/25"
                        >
                          {banner.badge_text}
                        </motion.span>
                      )}

                      {banner.title && (
                        <motion.h1
                          variants={prefersReducedMotion ? undefined : textItem}
                          className="text-3xl sm:text-5xl lg:text-6xl font-bold text-white leading-[1.1] tracking-tight"
                        >
                          {banner.title.split(',').map((part, i, arr) =>
                            i === arr.length - 1 && arr.length > 1 ? (
                              <span
                                key={i}
                                className="text-transparent bg-clip-text bg-gradient-to-r from-[var(--sera-orange)] to-[#ff8a3d]"
                              >
                                {part}
                              </span>
                            ) : (
                              <span key={i}>
                                {part}
                                {i < arr.length - 1 ? ',' : ''}
                              </span>
                            )
                          )}
                        </motion.h1>
                      )}

                      {banner.subtitle && (
                        <motion.p
                          variants={prefersReducedMotion ? undefined : textItem}
                          className="mt-5 text-base sm:text-lg text-white/65 max-w-lg leading-relaxed"
                        >
                          {banner.subtitle}
                        </motion.p>
                      )}

                      {banner.link_url && (
                        <motion.div
                          variants={prefersReducedMotion ? undefined : textItem}
                          className="mt-8 flex flex-wrap gap-3"
                        >
                          <Link
                            href={banner.link_url}
                            className="group/cta inline-flex items-center gap-2 px-6 py-3 text-sm font-semibold text-white bg-[var(--sera-orange)] rounded-xl hover:bg-[var(--sera-orange-deep)] hover:scale-[1.02] hover:shadow-xl hover:shadow-[var(--sera-orange)]/30 transition-all duration-200"
                          >
                            {banner.link_text || 'Shop Now'}
                            <ArrowRight className="h-4 w-4 transition-transform group-hover/cta:translate-x-0.5" />
                          </Link>
                          <Link
                            href="/login"
                            className="inline-flex items-center gap-2 px-6 py-3 text-sm font-semibold text-white/65 bg-white/10 backdrop-blur-sm rounded-full hover:bg-white/20 transition-all border border-white/10"
                          >
                            Business Login
                          </Link>
                        </motion.div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Previous / Next arrows (desktop only) */}
      {count > 1 && (
        <>
          <button
            onClick={scrollPrev}
            className="absolute left-4 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/10 backdrop-blur-sm text-white/80 hover:bg-white/20 hover:text-white transition-all border border-white/10 hidden sm:flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-white/40"
            aria-label="Previous slide"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            onClick={scrollNext}
            className="absolute right-4 top-1/2 -translate-y-1/2 p-2.5 rounded-full bg-white/10 backdrop-blur-sm text-white/80 hover:bg-white/20 hover:text-white transition-all border border-white/10 hidden sm:flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-white/40"
            aria-label="Next slide"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </>
      )}

      {/* Dots indicator */}
      {count > 1 && (
        <div
          className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-2"
          role="tablist"
          aria-label="Slide indicators"
        >
          {banners.map((_, i) => (
            <button
              key={i}
              onClick={() => scrollTo(i)}
              role="tab"
              aria-selected={i === selectedIndex}
              className={`h-2 rounded-full transition-all focus:outline-none focus:ring-2 focus:ring-white/40 ${i === selectedIndex
                  ? 'w-6 bg-white'
                  : 'w-2 bg-white/40 hover:bg-white/60'
                }`}
              aria-label={`Go to slide ${i + 1}`}
            />
          ))}
        </div>
      )}

      {/* CSS keyframes for gradient animation */}
      <style jsx>{`
        @keyframes heroGradientShift {
          0% {
            transform: translateX(0) scale(1);
          }
          100% {
            transform: translateX(3%) scale(1.05);
          }
        }
      `}</style>
    </section>
  )
}
