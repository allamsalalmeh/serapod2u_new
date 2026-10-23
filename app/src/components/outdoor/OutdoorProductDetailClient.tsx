'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Check, ChevronLeft, ChevronRight, Minus, Play, Plus } from 'lucide-react'
import { useCart } from '@/lib/storefront/cart-context'
import { OUTDOOR_BUY_NOW_CHECKOUT, saveOutdoorBuyNow } from '@/lib/outdoor/buy-now'
import { isSellablePrice } from '@/lib/storefront/price-rules'
import type { StorefrontProductDetail, StorefrontVariant } from '@/lib/storefront/products'
import { outdoorColorFromText, outdoorSpecLabel, outdoorStaticImage, outdoorSwatchesFromVariants, showOutdoorSwatches } from '@/lib/outdoor/merch'
import { outdoorGallery, outdoorSpecRows } from '@/lib/outdoor/product-page'
import OutdoorPhoto, { OutdoorSoldOutTag } from '@/components/outdoor/OutdoorPhoto'
import { useRouter } from 'next/navigation'

const AUTOPLAY_PHOTO_MS = 4500
const AUTOPLAY_VIDEO_MS = 9000
const AUTOPLAY_HOLD_AFTER_TOUCH_MS = 9000

function isKeyboardFocus(target: EventTarget) {
  try {
    return target instanceof HTMLElement && target.matches(':focus-visible')
  } catch {
    return false
  }
}

function formatPrice(price: number | null) {
  if (price == null || !isSellablePrice(price)) return 'Currently unavailable'
  return `RM ${price.toFixed(2)}`
}

export default function OutdoorProductDetailClient({ product }: { product: StorefrontProductDetail }) {
  const { addItem } = useCart()
  const router = useRouter()
  const swatches = useMemo(
    () =>
      outdoorSwatchesFromVariants(
        product.variants.map((v) => ({
          id: v.id,
          variant_name: v.variant_name,
          image_url: v.image_url || v.media?.find((m) => m.type === 'image')?.url || null,
          attributes: v.attributes,
          price: v.suggested_retail_price,
          is_default: v.is_default,
        })),
        product.product_name,
      ).map((swatch) => ({
        ...swatch,
        imageUrl: swatch.imageUrl || product.image_url || outdoorStaticImage(product.product_name, swatch.hex),
      })),
    [product.product_name, product.variants, product.image_url],
  )
  const showSwatches = showOutdoorSwatches(swatches)
  const shownVariants = useMemo(() => {
    const visible = product.variants.filter((v) => !v.attributes?.outdoor_hidden)
    return visible.length > 0 ? visible : product.variants
  }, [product.variants])

  const variantForSwatch = (hex: string | null) => {
    if (!hex) return product.variants.find((v) => v.is_default) || product.variants[0] || null
    const match = product.variants.find((v) => {
      const attrs = v.attributes || {}
      const fromAttr = outdoorColorFromText(String(attrs.color || attrs.colour || attrs.hex || ''))
      const fromName = outdoorColorFromText(v.variant_name)
      return (fromAttr || fromName)?.hex.toLowerCase() === hex.toLowerCase()
    })
    return match || product.variants.find((v) => v.is_default) || product.variants[0] || null
  }

  const swatchHexFor = (variantId: string | undefined) =>
    swatches.find((swatch) => swatch.variantId === variantId)?.hex || 'burgundy'

  const gallery = useMemo(() => {
    const items = outdoorGallery(
      shownVariants,
      (variantId) =>
        swatches.find((swatch) => swatch.variantId === variantId)?.imageUrl ||
        product.image_url ||
        outdoorStaticImage(product.product_name, 'burgundy'),
    )
    if (items.length > 0) return items
    const fallback = product.image_url || outdoorStaticImage(product.product_name, 'burgundy')
    return fallback ? [{ type: 'image' as const, url: fallback, thumbnailUrl: null, variantIds: [] as string[] }] : []
  }, [shownVariants, swatches, product.image_url, product.product_name])

  const firstFrameFor = (variantId: string | undefined) => {
    if (!variantId) return -1
    return gallery.findIndex((item) => item.variantIds.includes(variantId))
  }

  const defaultVariant = product.variants.find((v) => v.is_default) || product.variants[0] || null
  const [selected, setSelected] = useState<StorefrontVariant | null>(defaultVariant)
  const [frame, setFrame] = useState(() => Math.max(0, firstFrameFor(defaultVariant?.id)))
  const [qty, setQty] = useState(1)
  const [adding, setAdding] = useState(false)
  const [added, setAdded] = useState(false)

  useEffect(() => {
    if (!added) return
    const timer = window.setTimeout(() => setAdded(false), 2400)
    return () => window.clearTimeout(timer)
  }, [added])

  useEffect(() => {
    setSelected(defaultVariant)
    setFrame(Math.max(0, gallery.findIndex((item) => defaultVariant && item.variantIds.includes(defaultVariant.id))))
  }, [defaultVariant, gallery])

  const chooseVariant = (variant: StorefrontVariant) => {
    holdAutoplayUntil.current = Date.now() + AUTOPLAY_HOLD_AFTER_TOUCH_MS
    setSelected(variant)
    const first = firstFrameFor(variant.id)
    if (first >= 0) setFrame(first)
  }

  const showFrame = (next: number) => {
    if (gallery.length === 0) return
    const index = (next + gallery.length) % gallery.length
    setFrame(index)
    const owners = gallery[index].variantIds
    if (owners.length > 0 && !(selected && owners.includes(selected.id))) {
      const owner = product.variants.find((v) => v.id === owners[0])
      if (owner) setSelected(owner)
    }
  }

  const touchStartX = useRef(0)

  // The slideshow only moves the photo; the customer's chosen variant, price and cart item stay put.
  const holdAutoplayUntil = useRef(0)
  const galleryHovered = useRef(false)
  const galleryFocused = useRef(false)
  const lastSlideChange = useRef(Date.now())
  const userShowFrame = (next: number) => {
    holdAutoplayUntil.current = Date.now() + AUTOPLAY_HOLD_AFTER_TOUCH_MS
    showFrame(next)
  }

  const spec = outdoorSpecLabel(product.product_name, selected?.variant_name, selected?.attributes)
  const specRows = outdoorSpecRows(selected?.attributes)
  const selectedHex =
    outdoorSwatchesFromVariants(selected ? [selected] : [])[0]?.hex || swatches[0]?.hex || null
  const [activeHex, setActiveHex] = useState<string | null>(selectedHex)

  const slideIndex = gallery.length > 0 ? Math.min(frame, gallery.length - 1) : 0
  const activeItem = gallery[slideIndex]
  const activeIsVideo = activeItem?.type === 'video'

  useEffect(() => {
    lastSlideChange.current = Date.now()
  }, [slideIndex])

  useEffect(() => {
    if (gallery.length < 2) return
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const timer = window.setInterval(() => {
      const now = Date.now()
      if (galleryHovered.current || galleryFocused.current || document.hidden || now < holdAutoplayUntil.current) return
      if (now - lastSlideChange.current < (activeIsVideo ? AUTOPLAY_VIDEO_MS : AUTOPLAY_PHOTO_MS)) return
      lastSlideChange.current = now
      setFrame((current) => (Math.min(current, gallery.length - 1) + 1) % gallery.length)
    }, 400)
    return () => window.clearInterval(timer)
  }, [gallery.length, activeIsVideo])

  const thumbStrip = useRef<HTMLDivElement>(null)
  const [thumbScroll, setThumbScroll] = useState({ left: false, right: false })
  const updateThumbScroll = () => {
    const strip = thumbStrip.current
    if (!strip) return
    const left = strip.scrollLeft > 2
    const right = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 2
    setThumbScroll((prev) => (prev.left === left && prev.right === right ? prev : { left, right }))
  }
  const scrollThumbs = (direction: 1 | -1) => {
    const strip = thumbStrip.current
    if (strip && typeof strip.scrollBy === 'function') strip.scrollBy({ left: direction * Math.max(strip.clientWidth * 0.8, 72), behavior: 'smooth' })
  }

  useEffect(() => {
    const strip = thumbStrip.current
    if (!strip) return
    updateThumbScroll()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateThumbScroll)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [gallery.length])

  useEffect(() => {
    const strip = thumbStrip.current
    const thumb = strip?.children[slideIndex] as HTMLElement | undefined
    if (!strip || !thumb || typeof strip.scrollTo !== 'function') return
    const pad = 8
    if (thumb.offsetLeft < strip.scrollLeft + pad) {
      strip.scrollTo({ left: Math.max(0, thumb.offsetLeft - pad), behavior: 'smooth' })
    } else if (thumb.offsetLeft + thumb.offsetWidth > strip.scrollLeft + strip.clientWidth - pad) {
      strip.scrollTo({ left: thumb.offsetLeft + thumb.offsetWidth - strip.clientWidth + pad, behavior: 'smooth' })
    }
  }, [slideIndex])
  const selectedImage = gallery.find((item) => item.type === 'image' && selected && item.variantIds.includes(selected.id))?.url
  const displayImage =
    (activeItem?.type === 'image' ? activeItem.url : null) ||
    selectedImage ||
    product.image_url ||
    outdoorStaticImage(product.product_name, 'burgundy') ||
    null

  const productPrice = selected?.suggested_retail_price && selected.suggested_retail_price > 0
    ? selected.suggested_retail_price
    : defaultVariant?.suggested_retail_price ?? null

  const stockLeft = typeof selected?.available === 'number' ? selected.available : null
  const soldOut = stockLeft !== null && stockLeft <= 0
  const canBuy = isSellablePrice(productPrice) && !soldOut

  useEffect(() => {
    if (stockLeft !== null && stockLeft > 0) setQty((q) => Math.min(q, stockLeft))
  }, [stockLeft])

  const lineItem = () =>
    selected && productPrice && canBuy
      ? {
          productId: product.id,
          variantId: selected.id,
          productName: product.product_name,
          variantName: selected.variant_name,
          price: productPrice,
          imageUrl: selectedImage || displayImage || selected.image_url || null,
        }
      : null

  const handleAddToBag = () => {
    const item = lineItem()
    if (!item || adding) return
    addItem(item, qty)
    setAdded(true)
  }

  const handleBuy = () => {
    const item = lineItem()
    if (!item || adding) return
    setAdding(true)
    if (saveOutdoorBuyNow({ ...item, quantity: qty })) {
      router.push(OUTDOOR_BUY_NOW_CHECKOUT)
      return
    }
    addItem(item, qty)
    router.push('/outdoor/checkout')
  }

  const fullDescription = String(product.product_description || '').trim()
  const shortDescription = String(product.short_description || '').trim()
  const lead = fullDescription && shortDescription && shortDescription !== fullDescription ? shortDescription : ''
  const description = lead ? '' : fullDescription || shortDescription
  const sku = selected?.variant_code || product.product_code

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-10 pt-4 sm:px-8">
      <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-2 lg:gap-12">
        <div
          onPointerEnter={(event) => { galleryHovered.current = event.pointerType === 'mouse' }}
          onPointerLeave={() => { galleryHovered.current = false }}
          onFocus={(event) => { galleryFocused.current = isKeyboardFocus(event.target) }}
          onBlur={() => { galleryFocused.current = false }}
        >
          <div
            className={`relative aspect-square overflow-hidden rounded-[1.6rem] bg-white${soldOut ? ' out-sold-out' : ''}`}
            onTouchStart={(event) => {
              touchStartX.current = event.changedTouches[0].screenX
            }}
            onTouchEnd={(event) => {
              const distance = touchStartX.current - event.changedTouches[0].screenX
              if (Math.abs(distance) >= 50) userShowFrame(slideIndex + (distance > 0 ? 1 : -1))
            }}
          >
            {soldOut ? <OutdoorSoldOutTag large /> : null}
            <div className="out-carousel" style={{ transform: `translate3d(-${slideIndex * 100}%, 0, 0)` }}>
              {gallery.length > 0 ? (
                gallery.map((item, index) => (
                  <div key={`${index}-${item.url}`} className="out-carousel-slide p-4 sm:p-6">
                    {item.type === 'video' ? (
                      index === slideIndex ? (
                        <video src={item.url} className="h-full w-full object-contain" autoPlay loop muted playsInline />
                      ) : (
                        <div className="h-full w-full" />
                      )
                    ) : (
                      <OutdoorPhoto
                        src={item.url}
                        backup={outdoorStaticImage(product.product_name, swatchHexFor(item.variantIds[0]))}
                        alt={product.product_name}
                        className="h-full w-full object-contain"
                      />
                    )}
                  </div>
                ))
              ) : (
                <div className="out-carousel-slide p-4 sm:p-6">
                  <div className="h-full w-full bg-[var(--out-sand)]/30" />
                </div>
              )}
            </div>

            {gallery.length > 1 ? (
              <>
                <button
                  type="button"
                  onClick={() => userShowFrame(slideIndex - 1)}
                  className="absolute left-3 top-1/2 z-20 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/85 text-[var(--out-bark)] shadow-sm backdrop-blur transition hover:bg-white"
                  aria-label="Previous photo"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => userShowFrame(slideIndex + 1)}
                  className="absolute right-3 top-1/2 z-20 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full bg-white/85 text-[var(--out-bark)] shadow-sm backdrop-blur transition hover:bg-white"
                  aria-label="Next photo"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
                <span className="absolute bottom-3 right-3 z-20 rounded-full bg-[var(--out-bark)]/75 px-2.5 py-0.5 text-xs font-medium text-[var(--out-cream)]">
                  {slideIndex + 1}/{gallery.length}
                </span>
              </>
            ) : null}
          </div>

          {gallery.length > 1 ? (
            <div className="relative mt-3">
              <div
                ref={thumbStrip}
                onScroll={updateThumbScroll}
                className="out-thumb-strip relative flex gap-2 overflow-x-auto py-0.5"
                role="list"
                aria-label="Product photos"
              >
                {gallery.map((item, index) => (
                  <button
                    key={`${index}-${item.url}`}
                    type="button"
                    role="listitem"
                    aria-label={`Show photo ${index + 1}`}
                    aria-current={index === slideIndex}
                    onClick={() => userShowFrame(index)}
                    className={`relative h-16 w-16 flex-none overflow-hidden rounded-xl border-2 bg-white transition ${
                      index === slideIndex ? 'border-[var(--out-bark)]' : 'border-transparent opacity-80 hover:opacity-100'
                    }`}
                  >
                    {item.type === 'video' ? (
                      <>
                        {item.thumbnailUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={item.thumbnailUrl} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <video src={item.url} className="h-full w-full object-cover" muted playsInline preload="metadata" />
                        )}
                        <span className="absolute inset-0 flex items-center justify-center bg-black/20">
                          <Play className="h-4 w-4 fill-white text-white" />
                        </span>
                      </>
                    ) : (
                      <OutdoorPhoto
                        src={item.url}
                        backup={outdoorStaticImage(product.product_name, swatchHexFor(item.variantIds[0]))}
                        alt=""
                        className="h-full w-full object-contain p-1"
                      />
                    )}
                  </button>
                ))}
              </div>
              {(['left', 'right'] as const).map((side) =>
                thumbScroll[side] ? (
                  <button
                    key={side}
                    type="button"
                    onClick={() => scrollThumbs(side === 'left' ? -1 : 1)}
                    className={`absolute top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-[var(--out-bark)] shadow-md ring-1 ring-black/5 backdrop-blur transition hover:scale-105 hover:bg-white ${
                      side === 'left' ? '-left-2' : '-right-2'
                    }`}
                    aria-label={side === 'left' ? 'Earlier photos' : 'More photos'}
                  >
                    {side === 'left' ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                ) : null,
              )}
            </div>
          ) : null}
        </div>

        <div className="lg:pt-4">
          {showSwatches ? (
            <div className="flex items-center gap-2">
              {swatches.map((swatch) => {
                const selectedSwatch = swatch.variantId
                  ? selected?.id === swatch.variantId
                  : activeHex?.toLowerCase() === swatch.hex.toLowerCase()
                return (
                  <button
                    key={swatch.variantId || `${swatch.hex}-${swatch.label}`}
                    type="button"
                    aria-label={swatch.label}
                    onClick={() => {
                      setActiveHex(swatch.hex)
                      const next = product.variants.find((variant) => variant.id === swatch.variantId) || variantForSwatch(swatch.hex)
                      if (next) chooseVariant(next)
                    }}
                    className={`h-4 w-4 rounded-full border ${
                      selectedSwatch ? 'border-[var(--out-bark)] ring-2 ring-[var(--out-bark)]/20' : 'border-black/10'
                    }`}
                    style={{ background: swatch.hex }}
                  />
                )
              })}
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <h1 className="min-w-min flex-1 font-display text-3xl tracking-tight text-[var(--out-bark)]">{product.product_name}</h1>
            {spec ? <p className="max-w-full shrink-0 pt-2 text-sm text-[var(--out-muted)]">{spec}</p> : null}
          </div>
          <p key={productPrice ?? 'ask'} className="out-swap mt-1 text-lg font-semibold text-[var(--out-bark)]">
            {formatPrice(productPrice)}
          </p>
          {lead || description ? (
            <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-[var(--out-muted)]">{lead || description}</p>
          ) : null}

          {shownVariants.length > 1 ? (
            <div className="mt-5">
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--out-muted)]">Variant</p>
              <div className="flex flex-wrap gap-2">
                {shownVariants.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => chooseVariant(v)}
                    aria-pressed={selected?.id === v.id}
                    className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                      selected?.id === v.id
                        ? 'border-[var(--out-bark)] bg-[var(--out-bark)] text-[var(--out-cream)]'
                        : 'border-[var(--out-line)] text-[var(--out-bark)] hover:border-[var(--out-bark)]/40'
                    }`}
                  >
                    {v.variant_name}
                    {typeof v.available === 'number' && v.available <= 0 ? (
                      <span className="ml-1 text-[10px] font-semibold uppercase opacity-70">Sold out</span>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-6 flex items-center gap-3">
            <div className="inline-flex h-12 items-center rounded-2xl bg-white px-2 text-[var(--out-bark)]">
              <button type="button" className="p-2" onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="Decrease">
                <Minus className="h-4 w-4" />
              </button>
              <span className="w-6 text-center text-sm font-semibold">{qty}</span>
              <button
                type="button"
                className="p-2 disabled:opacity-40"
                onClick={() => setQty((q) => (stockLeft !== null ? Math.min(stockLeft, q + 1) : q + 1))}
                disabled={stockLeft !== null && qty >= stockLeft}
                aria-label="Increase"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
            <button
              type="button"
              onClick={handleAddToBag}
              disabled={!canBuy || adding}
              className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-full border-2 border-[var(--out-bark)] text-sm font-semibold text-[var(--out-bark)] transition-colors hover:bg-[var(--out-bark)] hover:text-[var(--out-cream)] disabled:opacity-40"
            >
              {added ? (
                <span key="added" className="out-swap inline-flex items-center gap-2">
                  <Check className="h-4 w-4" aria-hidden /> Added to cart
                </span>
              ) : (
                <span key="add" className="out-swap">Add to cart</span>
              )}
            </button>
          </div>
          <button
            type="button"
            onClick={handleBuy}
            disabled={!canBuy || adding}
            className="mt-3 inline-flex h-12 w-full items-center justify-center rounded-full bg-[var(--out-moss)] text-sm font-semibold text-white hover:bg-[var(--out-moss-deep)] disabled:opacity-40"
          >
            {soldOut ? 'Out of stock' : 'Buy Now'}
          </button>
          <p className="mt-2 min-h-[1.25rem] text-center text-xs text-[var(--out-muted)]" aria-live="polite">
            {soldOut ? (
              'This one is sold out for now.'
            ) : !added && stockLeft !== null && stockLeft <= 5 ? (
              <span className="font-semibold text-[var(--out-bark)]">Only {stockLeft} left</span>
            ) : added ? (
              <>
                Added to your cart ·{' '}
                <Link href="/outdoor/cart" className="font-semibold text-[var(--out-bark)] hover:underline">
                  View cart
                </Link>
              </>
            ) : null}
          </p>

          {lead ? (
            <div className="mt-6 border-t border-[var(--out-line)] pt-5">
              <h2 className="text-sm font-semibold text-[var(--out-bark)]">Description</h2>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[var(--out-muted)]">{fullDescription}</p>
            </div>
          ) : null}

          {specRows.length > 0 ? (
            <div className="mt-6 border-t border-[var(--out-line)] pt-5">
              <h2 className="text-sm font-semibold text-[var(--out-bark)]">Specifications</h2>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                {specRows.map((row, index) => (
                  <div key={`${index}-${row.label}`} className="contents">
                    <dt className="text-[var(--out-muted)]">{row.label}</dt>
                    <dd className="font-medium text-[var(--out-bark)]">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          {sku || selected?.barcode ? (
            <p className="mt-5 space-x-3 text-xs text-[var(--out-muted)]/80">
              {sku ? <span>SKU: {sku}</span> : null}
              {selected?.barcode ? <span>Barcode: {selected.barcode}</span> : null}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
