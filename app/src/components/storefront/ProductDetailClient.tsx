'use client'

import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import {
  Package,
  ShoppingCart,
  Check,
  Minus,
  Plus,
  ChevronLeft,
  ChevronRight,
  Play,
} from 'lucide-react'
import { useCart } from '@/lib/storefront/cart-context'
import AffiliateShareButton from '@/components/affiliate/AffiliateShareButton'
import type {
  StorefrontProductDetail,
  StorefrontVariant,
  StorefrontMediaItem,
} from '@/lib/storefront/products'

interface Props {
  product: StorefrontProductDetail
}

/* ── helpers ────────────────────────────────────────────────── */

function resolveUrl(rawPath: string | null | undefined) {
  if (!rawPath) return null
  if (rawPath.startsWith('http://') || rawPath.startsWith('https://')) return rawPath
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!supabaseUrl) return rawPath
  const cleanPath = rawPath.replace(/^\/+/, '')
  const knownBuckets = ['product-variants', 'avatars']
  for (const bucket of knownBuckets) {
    if (cleanPath.startsWith(`${bucket}/`)) {
      const objectPath = cleanPath.slice(bucket.length + 1)
      return `${supabaseUrl}/storage/v1/object/public/${bucket}/${objectPath}`
    }
  }
  return `${supabaseUrl}/storage/v1/object/public/avatars/${cleanPath}`
}

function formatPrice(price: number | null) {
  if (price == null || price <= 0) return null
  return new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(price)
}

/* ── Gallery media item (unified) ──────────────────────────── */

interface GalleryItem {
  type: 'image' | 'video'
  url: string
  thumbnailUrl?: string | null
}

/* ── Component ─────────────────────────────────────────────── */

export default function ProductDetailClient({ product }: Props) {
  const { addItem } = useCart()
  const defaultVariant =
    product.variants.find((v) => v.is_default) || product.variants[0] || null

  const [selectedVariant, setSelectedVariant] = useState<StorefrontVariant | null>(defaultVariant)
  const [quantity, setQuantity] = useState(1)
  const [justAdded, setJustAdded] = useState(false)

  /* Build gallery items from the selected variant's media array,
     falling back to image_url + animation_url if media is empty. */
  const gallery: GalleryItem[] = useMemo(() => {
    const items: GalleryItem[] = []
    const seen = new Set<string>()
    const addUnique = (item: GalleryItem) => {
      if (!item.url || seen.has(item.url)) return
      seen.add(item.url)
      items.push(item)
    }

    // From selected variant
    if (selectedVariant) {
      if (selectedVariant.media && selectedVariant.media.length > 0) {
        for (const m of selectedVariant.media) {
          addUnique({
            type: m.type,
            url: resolveUrl(m.url) || m.url,
            thumbnailUrl: m.thumbnail_url ? resolveUrl(m.thumbnail_url) : null,
          })
        }
      } else {
        // Legacy fallback
        const imgUrl = resolveUrl(selectedVariant.image_url)
        if (imgUrl) addUnique({ type: 'image', url: imgUrl })
        const animUrl = resolveUrl(selectedVariant.animation_url)
        if (animUrl) addUnique({ type: 'video', url: animUrl })
      }
    }

    // Add other variants' media too (for a richer gallery)
    for (const v of product.variants) {
      if (v.id === selectedVariant?.id) continue
      if (v.media && v.media.length > 0) {
        for (const m of v.media) {
          addUnique({
            type: m.type,
            url: resolveUrl(m.url) || m.url,
            thumbnailUrl: m.thumbnail_url ? resolveUrl(m.thumbnail_url) : null,
          })
        }
      } else {
        const imgUrl = resolveUrl(v.image_url)
        if (imgUrl) addUnique({ type: 'image', url: imgUrl })
        const animUrl = resolveUrl(v.animation_url)
        if (animUrl) addUnique({ type: 'video', url: animUrl })
      }
    }

    return items
  }, [product.variants, selectedVariant])

  const [currentIndex, setCurrentIndex] = useState(0)

  // Reset to 0 when variant changes
  useEffect(() => {
    setCurrentIndex(0)
  }, [selectedVariant?.id])

  // Clamp index
  const safeIndex = gallery.length > 0 ? currentIndex % gallery.length : 0
  const active = gallery[safeIndex] || null

  /* ── Keyboard nav ────────────────────────────────────────── */
  useEffect(() => {
    if (gallery.length <= 1) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        setCurrentIndex((p) => (p === 0 ? gallery.length - 1 : p - 1))
      } else if (e.key === 'ArrowRight') {
        setCurrentIndex((p) => (p === gallery.length - 1 ? 0 : p + 1))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [gallery.length])

  /* ── Touch / swipe ───────────────────────────────────────── */
  const touchStartX = useRef(0)
  const touchEndX = useRef(0)
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.changedTouches[0].screenX
  }, [])
  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      touchEndX.current = e.changedTouches[0].screenX
      const diff = touchStartX.current - touchEndX.current
      if (Math.abs(diff) < 50) return // minimum swipe distance
      if (diff > 0) {
        // swiped left → next
        setCurrentIndex((p) => (p === gallery.length - 1 ? 0 : p + 1))
      } else {
        // swiped right → prev
        setCurrentIndex((p) => (p === 0 ? gallery.length - 1 : p - 1))
      }
    },
    [gallery.length],
  )

  /* ── Thumbnail strip scroll ──────────────────────────────── */
  const thumbContainerRef = useRef<HTMLDivElement>(null)
  const scrollThumbs = (dir: 'left' | 'right') => {
    if (!thumbContainerRef.current) return
    const amount = 200
    thumbContainerRef.current.scrollBy({ left: dir === 'right' ? amount : -amount, behavior: 'smooth' })
  }

  const formattedPrice = selectedVariant ? formatPrice(selectedVariant.suggested_retail_price) : null
  const stockLeft = typeof selectedVariant?.available === 'number' ? selectedVariant.available : null
  const soldOut = stockLeft !== null && stockLeft <= 0

  const handleAddToCart = () => {
    if (!selectedVariant || soldOut) return
    addItem(
      {
        productId: product.id,
        variantId: selectedVariant.id,
        productName: product.product_name,
        variantName: selectedVariant.variant_name,
        price: selectedVariant.suggested_retail_price,
        imageUrl: selectedVariant.image_url,
      },
      quantity,
    )
    setJustAdded(true)
    setTimeout(() => setJustAdded(false), 2000)
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
      {/* ── Media Gallery ── */}
      <div className="space-y-4">
        {/* Main viewer */}
        <div
          className="relative aspect-square rounded-2xl bg-[var(--sera-mist)] border border-[var(--sera-line)] overflow-hidden flex items-center justify-center"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {active ? (
            active.type === 'video' ? (
              <video
                key={active.url}
                src={active.url}
                className={`object-contain w-full h-full p-4 transition-[filter,opacity] duration-300${soldOut ? ' grayscale opacity-50' : ''}`}
                autoPlay
                loop
                muted
                playsInline
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={active.url}
                alt={product.product_name}
                className={`object-contain w-full h-full p-4 transition-[filter,opacity] duration-300${soldOut ? ' grayscale opacity-50' : ''}`}
              />
            )
          ) : (
            <Package className="h-24 w-24 text-[var(--sera-muted)]/40" />
          )}

          {soldOut && (
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center" role="status">
              <span className="rounded-full bg-[var(--sera-ink)]/90 px-5 py-2 text-sm font-semibold uppercase tracking-[0.18em] text-white shadow-lg">
                Sold out
              </span>
            </span>
          )}

          {/* Navigation arrows */}
          {gallery.length > 1 && (
            <>
              <button
                onClick={() =>
                  setCurrentIndex((p) => (p === 0 ? gallery.length - 1 : p - 1))
                }
                className="absolute left-2 top-1/2 -translate-y-1/2 h-8 w-8 rounded-full bg-white/80 backdrop-blur flex items-center justify-center shadow hover:bg-white transition"
                aria-label="Previous"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                onClick={() =>
                  setCurrentIndex((p) => (p === gallery.length - 1 ? 0 : p + 1))
                }
                className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 rounded-full bg-white/80 backdrop-blur flex items-center justify-center shadow hover:bg-white transition"
                aria-label="Next"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </>
          )}

          {/* Media type badge */}
          {active?.type === 'video' && (
            <span className="absolute top-3 left-3 bg-purple-600 text-white text-[10px] font-bold uppercase px-2 py-0.5 rounded-full flex items-center gap-1">
              <Play className="w-3 h-3 fill-current" /> Video
            </span>
          )}

          {/* Counter */}
          {gallery.length > 1 && (
            <span className="absolute bottom-3 right-3 bg-black/50 text-white text-xs px-2 py-0.5 rounded-full">
              {safeIndex + 1}/{gallery.length}
            </span>
          )}
        </div>

        {/* Thumbnail strip */}
        {gallery.length > 1 && (
          <div className="relative">
            {gallery.length > 5 && (
              <>
                <button
                  onClick={() => scrollThumbs('left')}
                  className="absolute -left-2 top-1/2 -translate-y-1/2 z-10 h-7 w-7 rounded-full bg-white shadow border border-[var(--sera-line)] flex items-center justify-center hover:bg-[var(--sera-mist)]"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => scrollThumbs('right')}
                  className="absolute -right-2 top-1/2 -translate-y-1/2 z-10 h-7 w-7 rounded-full bg-white shadow border border-[var(--sera-line)] flex items-center justify-center hover:bg-[var(--sera-mist)]"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            <div
              ref={thumbContainerRef}
              className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide"
            >
              {gallery.map((item, i) => (
                <button
                  key={`${item.url}-${i}`}
                  onClick={() => setCurrentIndex(i)}
                  className={`relative flex-none w-16 h-16 rounded-lg border overflow-hidden ${
                    safeIndex === i
                      ? 'border-[var(--sera-ink)] ring-2 ring-[var(--sera-ink)]/20'
                      : 'border-[var(--sera-line)] hover:border-[var(--sera-muted)]'
                  }`}
                >
                  {item.type === 'video' ? (
                    <>
                      {item.thumbnailUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={item.thumbnailUrl} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <video
                          src={item.url}
                          className="w-full h-full object-cover"
                          muted
                          playsInline
                          preload="metadata"
                        />
                      )}
                      <span className="absolute inset-0 flex items-center justify-center bg-black/20">
                        <Play className="w-4 h-4 text-white fill-white" />
                      </span>
                    </>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.url} alt="" className="w-full h-full object-cover" />
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Product Info ── */}
      <div className="space-y-6">
        {/* Category & Brand badges */}
        <div className="flex flex-wrap gap-2">
          {product.category_name && (
            <span className="px-2.5 py-0.5 bg-[var(--sera-mist)] text-[var(--sera-muted)] rounded-full text-xs font-medium">
              {product.category_name}
            </span>
          )}
          {product.brand_name && (
            <span className="px-2.5 py-0.5 bg-[var(--sera-orange)]/[0.08] text-[var(--sera-orange)] rounded-full text-xs font-medium">
              {product.brand_name}
            </span>
          )}
        </div>

        <h1 className="font-display text-2xl lg:text-3xl font-semibold text-[var(--sera-ink)] leading-tight">
          {product.product_name}
        </h1>

        {product.short_description && (
          <p className="text-[var(--sera-muted)] text-sm leading-relaxed">{product.short_description}</p>
        )}

        {/* Price */}
        <div>
          {formattedPrice ? (
            <span className="font-display text-3xl font-semibold text-[var(--sera-ink)]">{formattedPrice}</span>
          ) : (
            <span className="text-lg text-[var(--sera-muted)]/70">Contact for price</span>
          )}
        </div>

        {/* Variant selector */}
        {product.variants.length > 1 && (
          <div>
            <label className="text-sm font-medium text-[var(--sera-ink)]/80 mb-2 block">Variant</label>
            <div className="flex flex-wrap gap-2">
              {product.variants.map((v) => (
                <button
                  key={v.id}
                  onClick={() => {
                    setSelectedVariant(v)
                    setQuantity(1)
                  }}
                  className={`relative px-4 py-2 rounded-lg border text-sm font-medium transition-all ${
                    selectedVariant?.id === v.id
                      ? 'border-[var(--sera-ink)] bg-[var(--sera-ink)] text-white shadow-sm'
                      : 'border-[var(--sera-line)] bg-white text-[var(--sera-ink)]/80 hover:border-[var(--sera-muted)]'
                  }`}
                >
                  {v.variant_name}
                  {typeof v.available === 'number' && v.available <= 0 && (
                    <span className="ml-1.5 text-[10px] font-semibold uppercase opacity-70">Sold out</span>
                  )}
                  {selectedVariant?.id === v.id && (
                    <span className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-green-500 flex items-center justify-center">
                      <Check className="h-2.5 w-2.5 text-white" />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Quantity */}
        <div>
          <label className="text-sm font-medium text-[var(--sera-ink)]/80 mb-2 block">Quantity</label>
          <div className="inline-flex items-center border border-[var(--sera-line)] rounded-lg overflow-hidden">
            <button
              onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              className="h-10 w-10 flex items-center justify-center text-[var(--sera-muted)] hover:bg-[var(--sera-mist)] transition"
            >
              <Minus className="h-4 w-4" />
            </button>
            <span className="h-10 w-12 flex items-center justify-center text-sm font-semibold border-x border-[var(--sera-line)]">
              {quantity}
            </span>
            <button
              onClick={() => setQuantity((q) => (stockLeft !== null ? Math.min(stockLeft, q + 1) : q + 1))}
              disabled={stockLeft !== null && quantity >= stockLeft}
              className="h-10 w-10 flex items-center justify-center text-[var(--sera-muted)] hover:bg-[var(--sera-mist)] transition disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
          {stockLeft !== null && stockLeft > 0 && stockLeft <= 5 && (
            <p className="mt-2 text-xs font-medium text-amber-600">Only {stockLeft} left</p>
          )}
        </div>

        {/* Add to Cart */}
        <button
          onClick={handleAddToCart}
          disabled={!selectedVariant || justAdded || soldOut}
          className={`w-full h-12 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 transition-all ${
            justAdded
              ? 'bg-green-500 text-white'
              : 'bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange-deep)] active:scale-[0.98]'
          } disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {soldOut ? (
            <>Out of stock</>
          ) : justAdded ? (
            <>
              <Check className="h-4 w-4" /> Added to Cart
            </>
          ) : (
            <>
              <ShoppingCart className="h-4 w-4" /> Add to Cart
            </>
          )}
        </button>

        <AffiliateShareButton productId={product.id} />

        {/* Description */}
        {product.product_description && (
          <div className="border-t border-[var(--sera-line)] pt-6 mt-6">
            <h3 className="text-sm font-semibold text-[var(--sera-ink)] mb-3">Description</h3>
            <div className="prose prose-sm prose-gray max-w-none text-[var(--sera-muted)]">
              {product.product_description.split('\n').map((paragraph, i) => (
                <p key={i}>{paragraph}</p>
              ))}
            </div>
          </div>
        )}

        {/* Variant details table */}
        {selectedVariant?.attributes &&
          Object.keys(selectedVariant.attributes).length > 0 && (
            <div className="border-t border-[var(--sera-line)] pt-6">
              <h3 className="text-sm font-semibold text-[var(--sera-ink)] mb-3">Specifications</h3>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                {Object.entries(selectedVariant.attributes).map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="text-[var(--sera-muted)] capitalize">{key.replace(/_/g, ' ')}</dt>
                    <dd className="text-[var(--sera-ink)] font-medium">{String(value)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

        {/* SKU */}
        <div className="text-xs text-[var(--sera-muted)]/70 space-x-3">
          <span>SKU: {selectedVariant?.variant_code || product.product_code}</span>
          {selectedVariant?.barcode && <span>Barcode: {selectedVariant.barcode}</span>}
        </div>
      </div>
    </div>
  )
}
