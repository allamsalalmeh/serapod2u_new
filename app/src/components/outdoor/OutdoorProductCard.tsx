'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Eye } from 'lucide-react'
import type { StorefrontProduct } from '@/lib/storefront/products'
import { isSellablePrice } from '@/lib/storefront/price-rules'
import { outdoorStaticImage, showOutdoorSwatches } from '@/lib/outdoor/merch'
import OutdoorPhoto, { OutdoorSoldOutTag } from '@/components/outdoor/OutdoorPhoto'

function formatPrice(price: number | null) {
  if (price == null || !isSellablePrice(price)) return 'Currently unavailable'
  return `RM ${price.toFixed(2)}`
}

export default function OutdoorProductCard({ product }: { product: StorefrontProduct }) {
  const swatches = product.colorSwatches || []
  const defaultIndex = swatches.findIndex((swatch) => swatch.isDefault)
  const [active, setActive] = useState(defaultIndex >= 0 ? defaultIndex : 0)
  const index = swatches.length === 0 ? 0 : Math.min(active, swatches.length - 1)
  const activeSwatch = swatches[index]
  const soldOutVariants = product.sold_out_variant_ids || []
  const showingSoldOut =
    Boolean(product.sold_out) ||
    Boolean(activeSwatch?.variantId && soldOutVariants.includes(activeSwatch.variantId))
  const frames = swatches.length > 0
    ? swatches.map((swatch) => swatch.imageUrl || product.image_url || '')
    : [product.image_url || '']
  const backups = swatches.length > 0
    ? swatches.map((swatch) => outdoorStaticImage(product.product_name, swatch.hex))
    : [outdoorStaticImage(product.product_name, 'burgundy')]
  const swatchPrice = Number(activeSwatch?.price)
  const price = Number.isFinite(swatchPrice) && swatchPrice > 0
    ? swatchPrice
    : product.display_price ?? product.starting_price

  return (
    <article className="flex h-full flex-col">
      <Link href={`/outdoor/shop/${product.id}`} className={`relative block${showingSoldOut ? ' out-sold-out' : ''}`}>
        {showingSoldOut ? <OutdoorSoldOutTag /> : null}
        <div className="aspect-[4/5] overflow-hidden rounded-[1.35rem] bg-white">
          <div className="out-carousel" style={{ transform: `translate3d(-${index * 100}%, 0, 0)` }}>
            {frames.map((src, frame) => (
              <div key={`${frame}-${src}`} className="out-carousel-slide p-3 sm:p-4">
                {src ? (
                  <OutdoorPhoto src={src} backup={backups[frame]} alt={product.product_name} className="h-full w-full object-contain" />
                ) : (
                  <div className="h-full w-full rounded-xl bg-[var(--out-sand)]/40" />
                )}
              </div>
            ))}
          </div>
        </div>
      </Link>

      {showOutdoorSwatches(swatches) ? (
        <div className="mt-3 flex items-center gap-1.5 px-1">
          {swatches.map((swatch, i) => (
            <button
              key={`${swatch.hex}-${i}`}
              type="button"
              aria-label={swatch.label}
              onClick={() => setActive(i)}
              className={`h-3.5 w-3.5 rounded-full border transition-transform duration-300 ${
                i === index ? 'scale-110 border-[var(--out-bark)]' : 'border-black/10'
              }`}
              style={{ background: swatch.hex }}
            />
          ))}
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap items-start justify-between gap-x-2 gap-y-0.5 px-1">
        <h3 className="min-w-min flex-1 text-sm font-semibold leading-snug text-[var(--out-bark)]">
          {product.product_name}
        </h3>
        {product.specLabel ? (
          <p className="max-w-full shrink-0 text-xs text-[var(--out-muted)]">{product.specLabel}</p>
        ) : null}
      </div>
      <p key={price ?? 'ask'} className="out-swap mt-1 px-1 text-sm font-medium text-[var(--out-bark)]">{formatPrice(price)}</p>

      <div className="mt-3 flex items-center gap-2">
        <Link
          href={`/outdoor/shop/${product.id}`}
          className="inline-flex h-10 flex-1 items-center justify-center rounded-full bg-[var(--out-moss)] text-sm font-semibold text-white hover:bg-[var(--out-moss-deep)]"
        >
          {product.sold_out ? 'View' : 'Buy Now'}
        </Link>
        <Link
          href={`/outdoor/shop/${product.id}`}
          aria-label={`View ${product.product_name}`}
          className="group/hint relative inline-flex h-10 w-10 items-center justify-center rounded-full border border-[var(--out-bark)]/15 text-[var(--out-bark)]"
        >
          <Eye className="h-4 w-4" />
          <span
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-[calc(100%+6px)] z-20 -translate-x-1/2 whitespace-nowrap rounded-md bg-[var(--out-bark)] px-2 py-1 text-[11px] font-medium leading-none text-[var(--out-cream)] opacity-0 shadow-md transition-opacity duration-150 group-hover/hint:opacity-100"
          >
            View product
          </span>
        </Link>
      </div>
    </article>
  )
}
