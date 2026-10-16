'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useCart } from '@/lib/storefront/cart-context'
import { bundleCartId, bundleItemsLabel, type OutdoorBundle } from '@/lib/outdoor/sales-tools'

function money(n: number) {
  return new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }).format(n)
}

/** Combo deals: one price, each real item leaves stock on its own. Hidden when there are none. */
export default function OutdoorCombos() {
  const router = useRouter()
  const { addItem } = useCart()
  const [bundles, setBundles] = useState<OutdoorBundle[]>([])
  const [added, setAdded] = useState('')

  useEffect(() => {
    void fetch('/api/storefront/outdoor-offers')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setBundles(Array.isArray(data?.bundles) ? data.bundles : []))
      .catch(() => setBundles([]))
  }, [])

  if (bundles.length === 0) return null

  const add = (bundle: OutdoorBundle, goToCheckout: boolean) => {
    addItem(
      {
        productId: bundleCartId(bundle.id),
        variantId: bundleCartId(bundle.id),
        productName: bundle.name,
        variantName: bundleItemsLabel(bundle),
        price: bundle.price,
        imageUrl: bundle.imageUrl || bundle.components[0]?.imageUrl || null,
      },
      1,
    )
    if (goToCheckout) router.push('/outdoor/cart')
    else setAdded(bundle.id)
  }

  return (
    <section className="mt-6">
      <h2 className="font-display text-2xl tracking-tight text-[var(--out-ink)]">Combo deals</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {bundles.map((bundle) => {
          const soldOut = bundle.available === 0
          const saving = bundle.comparePrice - bundle.price
          const pictures = bundle.imageUrl ? [bundle.imageUrl] : bundle.components.map((c) => c.imageUrl).filter(Boolean).slice(0, 3)
          return (
            <article key={bundle.id} className="out-card flex flex-col gap-3 p-4">
              <div className="flex h-28 items-center justify-center gap-2 overflow-hidden rounded-2xl bg-[var(--out-ivory)] p-2">
                {pictures.map((src, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={`${src}-${i}`} src={src!} alt="" className="h-full min-w-0 flex-1 object-contain" />
                ))}
              </div>
              <div className="min-w-0">
                <p className="font-display text-lg text-[var(--out-bark)]">{bundle.name}</p>
                <p className="text-xs text-[var(--out-muted)]">{bundleItemsLabel(bundle)}</p>
                {bundle.description ? <p className="mt-1 text-xs text-[var(--out-muted)]">{bundle.description}</p> : null}
              </div>
              <div className="flex items-baseline gap-2">
                <span className="font-display text-xl text-[var(--out-bark)]">{money(bundle.price)}</span>
                {saving > 0 ? (
                  <>
                    <span className="text-xs text-[var(--out-muted)] line-through">{money(bundle.comparePrice)}</span>
                    <span className="text-xs font-semibold text-[var(--out-ember)]">Save {money(saving)}</span>
                  </>
                ) : null}
              </div>
              <div className="mt-auto flex gap-2">
                <button type="button" disabled={soldOut} onClick={() => add(bundle, false)} className="out-btn flex-1">
                  {soldOut ? 'Sold out' : added === bundle.id ? 'Added' : 'Add combo'}
                </button>
                {soldOut ? null : (
                  <button
                    type="button"
                    onClick={() => add(bundle, true)}
                    className="inline-flex h-12 items-center justify-center rounded-full border border-[var(--out-bark)]/15 px-4 text-sm font-semibold text-[var(--out-bark)]"
                  >
                    Buy now
                  </button>
                )}
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
