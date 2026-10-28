import Link from 'next/link'
import { listProducts, listCategories } from '@/lib/storefront/products'
import { listActiveStoreBanners, getHeroConfig } from '@/lib/storefront/banners'
import StorefrontProductCard from '@/components/storefront/ProductCard'
import StoreHeroSlider from '@/components/storefront/StoreHeroSlider'
import SplitHeroLayout from '@/components/storefront/SplitHeroLayout'
import StoreBrandMark from '@/components/storefront/StoreBrandMark'
import StoreReveal from '@/components/storefront/StoreReveal'
import StoreSpotlightMedia from '@/components/storefront/StoreSpotlightMedia'
import { ArrowRight, Package, ShieldCheck, Truck, Sparkles, LayoutGrid } from 'lucide-react'
import { headers } from 'next/headers'
import { isStoreSiteHost } from '@/lib/hosts/site-split'

export const dynamic = 'force-dynamic'

export default async function StorefrontHomePage() {
  const [{ products }, categories, banners, heroConfig, requestHeaders] = await Promise.all([
    listProducts({ sort: 'newest', limit: 6 }),
    listCategories(),
    listActiveStoreBanners(),
    getHeroConfig(),
    headers(),
  ])
  const showBusinessLogin = !isStoreSiteHost((requestHeaders.get('x-forwarded-host') || requestHeaders.get('host') || '').split(',')[0])

  const [leadProduct, ...restProducts] = products

  return (
    <div>
      {/* Hero — banners when available; clean brand hero otherwise */}
      {banners.length > 0 ? (
        (() => {
          const carouselBanners = banners.filter(
            (b) => !b.layout_slot || b.layout_slot === 'carousel' || b.layout_slot === 'split_main'
          ).slice(0, heroConfig.max_slides)
          const sideTop = banners.find((b) => b.layout_slot === 'split_side_top') || null
          const sideBottom = banners.find((b) => b.layout_slot === 'split_side_bottom') || null

          if (heroConfig.layout_type === 'split' && (sideTop || sideBottom)) {
            return (
              <SplitHeroLayout
                mainBanners={carouselBanners}
                sideBanners={[sideTop, sideBottom]}
                interval={heroConfig.auto_rotate_interval}
              />
            )
          }

          return (
            <StoreHeroSlider
              banners={carouselBanners}
              interval={heroConfig.auto_rotate_interval}
              showBusinessLogin={showBusinessLogin}
            />
          )
        })()
      ) : (
        <section className="relative overflow-hidden border-b border-[var(--sera-line)]">
          <div
            className="pointer-events-none absolute inset-0 store-glow"
            style={{
              background:
                'radial-gradient(ellipse 60% 50% at 8% 20%, rgba(232,93,4,0.12), transparent 50%), radial-gradient(ellipse 50% 45% at 92% 0%, rgba(20,18,16,0.06), transparent 45%), linear-gradient(165deg, #f0f0f2 0%, var(--sera-paper) 45%, var(--sera-mist) 100%)',
            }}
          />
          <div
            className="pointer-events-none absolute inset-0 opacity-[0.04]"
            style={{
              backgroundImage:
                'linear-gradient(rgba(20,18,16,0.55) 1px, transparent 1px), linear-gradient(90deg, rgba(20,18,16,0.55) 1px, transparent 1px)',
              backgroundSize: '44px 44px',
            }}
          />
          <div className="relative mx-auto grid max-w-7xl items-center gap-10 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-2 lg:gap-12 lg:px-8 lg:py-24">
            <div className="max-w-xl">
              <div className="store-rise">
                <StoreBrandMark className="h-9 w-auto sm:h-11" priority />
              </div>
              <div className="store-rise store-rise-delay-1 mt-4 h-0.5 w-14 rounded-full bg-[var(--sera-orange)] store-accent-bar" />
              <h1 className="store-rise store-rise-delay-2 mt-6 font-display text-4xl font-semibold leading-[1.08] tracking-tight text-[var(--sera-ink)] sm:text-5xl lg:text-[3.25rem]">
                Shop quality products, delivered with care.
              </h1>
              <p className="store-rise store-rise-delay-3 mt-5 max-w-lg text-base leading-relaxed text-[var(--sera-muted)] sm:text-lg">
                Curated devices and accessories — fast checkout, secure payments.
              </p>
              <div className="store-rise store-rise-delay-4 mt-8 flex flex-wrap gap-3">
                <Link
                  href="/store/products"
                  className="inline-flex items-center gap-2 rounded-xl bg-[var(--sera-orange)] px-6 py-3 text-sm font-semibold text-white shadow-[0_10px_28px_-12px_rgba(232,93,4,0.65)] transition-colors hover:bg-[var(--sera-orange-deep)]"
                >
                  Shop Now
                  <ArrowRight className="h-4 w-4" />
                </Link>
                {showBusinessLogin && (
                  <Link
                    href="/login"
                    className="inline-flex items-center gap-2 rounded-xl border border-[var(--sera-line)] bg-[var(--sera-surface)] px-6 py-3 text-sm font-semibold text-[var(--sera-ink)] shadow-sm transition-colors hover:border-[var(--sera-orange)]/30 hover:text-[var(--sera-orange)]"
                  >
                    Business Login
                  </Link>
                )}
              </div>
            </div>

            <div className="store-rise store-rise-delay-3 relative mx-auto flex w-full max-w-md justify-center lg:max-w-none lg:justify-end lg:pr-6">
              <div
                className="pointer-events-none absolute left-1/2 top-1/2 h-[85%] w-[70%] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-80 blur-3xl lg:left-auto lg:right-[12%] lg:translate-x-0"
                style={{
                  background:
                    'radial-gradient(circle, rgba(232,93,4,0.2) 0%, rgba(20,18,16,0.08) 45%, transparent 70%)',
                }}
              />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/brand/serapod-device-hero.png"
                alt="Serapod Black Edition"
                className="store-float relative z-[1] h-auto w-auto max-h-[420px] max-w-[140px] object-contain drop-shadow-[0_28px_50px_rgba(20,18,16,0.4)] sm:max-h-[480px] sm:max-w-[160px] lg:max-h-[520px] lg:max-w-[180px]"
                width={437}
                height={2030}
                decoding="async"
                fetchPriority="high"
              />
            </div>
          </div>
        </section>
      )}

      {/* Trust strip */}
      <section className="border-b border-[var(--sera-line)] bg-[var(--sera-surface)]/80">
        <div className="mx-auto max-w-7xl px-4 py-7 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
            {[
              { icon: Truck, title: 'Reliable Delivery', sub: 'Nationwide coverage' },
              { icon: ShieldCheck, title: 'Secure Payments', sub: 'SSL encrypted checkout' },
              { icon: Package, title: 'Quality Guaranteed', sub: 'Authentic products only' },
            ].map((item, i) => (
              <StoreReveal key={item.title} delay={i * 80}>
                <div className="flex items-center gap-3 rounded-2xl border border-[var(--sera-line)]/80 bg-[var(--sera-surface)] px-4 py-3 shadow-[0_10px_28px_-22px_rgba(20,18,16,0.35)]">
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-[var(--sera-orange)]/[0.1]">
                    <item.icon className="h-5 w-5 text-[var(--sera-orange)]" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-[var(--sera-ink)]">{item.title}</p>
                    <p className="text-xs text-[var(--sera-muted)]">{item.sub}</p>
                  </div>
                </div>
              </StoreReveal>
            ))}
          </div>
        </div>
      </section>

      {/* Categories */}
      {categories.length > 0 && (
        <section className="relative overflow-hidden border-b border-[var(--sera-line)] bg-[var(--sera-paper)] py-14 sm:py-20">
          <div
            className="pointer-events-none absolute -left-20 top-0 h-56 w-56 rounded-full opacity-30 blur-3xl"
            style={{ background: 'radial-gradient(circle, rgba(232,93,4,0.18), transparent 70%)' }}
          />
          <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <StoreReveal>
              <div className="mb-10 flex flex-col gap-4 sm:mb-12 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <div className="mb-3 inline-flex items-center gap-2 rounded-lg bg-[var(--sera-orange)]/[0.12] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--sera-orange)]">
                    <LayoutGrid className="h-3.5 w-3.5" />
                    Browse
                  </div>
                  <h2 className="font-display text-2xl font-semibold text-[var(--sera-ink)] sm:text-3xl">
                    Shop by Category
                  </h2>
                  <p className="mt-1.5 max-w-md text-sm text-[var(--sera-muted)]">
                    Jump straight into the collections that match what you need.
                  </p>
                  <div className="mt-3 h-0.5 w-12 rounded-full bg-[var(--sera-orange)] store-accent-bar" />
                </div>
                <Link
                  href="/store/products"
                  className="hidden items-center gap-1.5 self-start rounded-xl border border-[var(--sera-line)] bg-[var(--sera-surface)] px-4 py-2.5 text-sm font-medium text-[var(--sera-ink)] shadow-sm transition-colors hover:border-[var(--sera-orange)]/30 hover:text-[var(--sera-orange)] sm:inline-flex"
                >
                  All Products
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>
            </StoreReveal>

            <div
              className={`grid gap-3 sm:gap-4 ${
                categories.length <= 2
                  ? 'grid-cols-1 sm:grid-cols-2'
                  : categories.length === 3
                    ? 'grid-cols-1 sm:grid-cols-3'
                    : categories.length === 4
                      ? 'grid-cols-2 lg:grid-cols-4'
                      : categories.length <= 6
                        ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-6'
                        : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6'
              }`}
            >
              {categories.map((cat, i) => (
                <StoreReveal key={cat.id} delay={Math.min(i * 55, 330)} variant="up">
                  <Link
                    href={`/store/products?category=${cat.id}`}
                    className="store-category-card group relative flex h-full flex-col overflow-hidden rounded-2xl border border-[var(--sera-line)] bg-[var(--sera-surface)] shadow-[0_12px_32px_-24px_rgba(20,18,16,0.35)] transition-colors hover:border-[var(--sera-orange)]/35"
                  >
                    <div className="relative flex aspect-[5/4] items-center justify-center overflow-hidden bg-gradient-to-b from-[var(--sera-surface)] to-[var(--sera-mist)]">
                      <div
                        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                        style={{
                          background:
                            'radial-gradient(ellipse at 50% 80%, rgba(232,93,4,0.12), transparent 60%)',
                        }}
                      />
                      {cat.image_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={cat.image_url}
                          alt={cat.name}
                          className="relative z-[1] h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                          loading="lazy"
                        />
                      ) : (
                        <div className="relative z-[1] flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--sera-surface)] shadow-[0_8px_24px_-12px_rgba(20,18,16,0.35)] transition-transform duration-300 group-hover:scale-110">
                          <Package className="h-6 w-6 text-[var(--sera-muted)] transition-colors group-hover:text-[var(--sera-orange)]" />
                        </div>
                      )}
                    </div>
                    <div className="flex flex-1 flex-col gap-1 border-t border-[var(--sera-line)] px-3 py-3.5 sm:px-4">
                      <span className="line-clamp-2 font-display text-sm font-semibold text-[var(--sera-ink)] transition-colors group-hover:text-[var(--sera-orange)]">
                        {cat.name}
                      </span>
                      <span className="text-[11px] text-[var(--sera-muted)]">
                        {cat.product_count > 0
                          ? `${cat.product_count} product${cat.product_count !== 1 ? 's' : ''}`
                          : 'Explore'}
                      </span>
                    </div>
                    <span className="pointer-events-none absolute bottom-3.5 right-3 flex h-7 w-7 translate-y-1 items-center justify-center rounded-full bg-[var(--sera-ink)] text-white opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100">
                      <ArrowRight className="h-3.5 w-3.5" />
                    </span>
                  </Link>
                </StoreReveal>
              ))}
            </div>

            <div className="mt-8 text-center sm:hidden">
              <Link
                href="/store/products"
                className="inline-flex items-center gap-1 text-sm font-medium text-[var(--sera-muted)] hover:text-[var(--sera-orange)]"
              >
                View All Products
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </section>
      )}

      {/* Featured Products */}
      <section className="relative overflow-hidden bg-[var(--sera-mist)] py-14 sm:py-20">
        <div
          className="pointer-events-none absolute -right-24 top-10 h-64 w-64 rounded-full opacity-35 blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(232,93,4,0.22), transparent 70%)' }}
        />
        <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <StoreReveal>
            <div className="mb-10 flex flex-col gap-4 sm:mb-12 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="mb-3 inline-flex items-center gap-2 rounded-lg bg-[var(--sera-orange)]/[0.12] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--sera-orange)]">
                  <Sparkles className="h-3.5 w-3.5" />
                  Featured
                </div>
                <h2 className="font-display text-2xl font-semibold text-[var(--sera-ink)] sm:text-3xl">
                  Featured Products
                </h2>
                <p className="mt-1.5 max-w-md text-sm text-[var(--sera-muted)]">
                  Hand-picked picks from our latest and best-selling lineup.
                </p>
                <div className="mt-3 h-0.5 w-12 rounded-full bg-[var(--sera-orange)] store-accent-bar" />
              </div>
              <Link
                href="/store/products"
                className="hidden items-center gap-1.5 self-start rounded-xl border border-[var(--sera-line)] bg-[var(--sera-surface)] px-4 py-2.5 text-sm font-medium text-[var(--sera-ink)] shadow-sm transition-colors hover:border-[var(--sera-orange)]/30 hover:text-[var(--sera-orange)] sm:inline-flex"
              >
                View All
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </StoreReveal>

          {products.length > 0 ? (
            <div className="space-y-5 sm:space-y-6">
              {leadProduct && (
                <StoreReveal variant="up">
                  <div className="store-featured-card grid overflow-hidden rounded-2xl border border-[var(--sera-line)] bg-[var(--sera-surface)] shadow-[0_22px_55px_-28px_rgba(20,18,16,0.35)] lg:grid-cols-2 lg:min-h-[360px]">
                    <StoreSpotlightMedia
                      imageUrl={leadProduct.image_url}
                      animationUrl={leadProduct.animation_url}
                      alt={leadProduct.product_name}
                    />
                    <div className="flex flex-col justify-center p-6 sm:p-8 lg:p-10">
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--sera-orange)]">
                        Spotlight
                      </p>
                      <h3 className="mt-2 font-display text-xl font-semibold text-[var(--sera-ink)] sm:text-2xl">
                        {leadProduct.product_name}
                      </h3>
                      {leadProduct.tags.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {leadProduct.tags.slice(0, 3).map((tag) => (
                            <span
                              key={tag}
                              className="rounded-md bg-[var(--sera-mist)] px-2 py-0.5 text-[10px] font-medium text-[var(--sera-muted)]"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                      {leadProduct.starting_price != null && leadProduct.starting_price > 0 && (
                        <p className="mt-4 font-display text-2xl font-semibold text-[var(--sera-ink)]">
                          From{' '}
                          {new Intl.NumberFormat('en-MY', {
                            style: 'currency',
                            currency: 'MYR',
                          }).format(leadProduct.starting_price)}
                        </p>
                      )}
                      <p className="mt-3 text-sm leading-relaxed text-[var(--sera-muted)]">
                        Explore variants, pricing, and details — ready to add to your cart.
                      </p>
                      <div className="mt-6 flex flex-wrap gap-3">
                        <Link
                          href={`/store/products/${leadProduct.id}`}
                          className="inline-flex items-center gap-2 rounded-xl bg-[var(--sera-orange)] px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--sera-orange-deep)]"
                        >
                          View Product
                          <ArrowRight className="h-4 w-4" />
                        </Link>
                        <Link
                          href="/store/products"
                          className="inline-flex items-center gap-2 rounded-xl border border-[var(--sera-line)] bg-[var(--sera-surface)] px-5 py-2.5 text-sm font-medium text-[var(--sera-ink)] transition-colors hover:border-[var(--sera-orange)]/30"
                        >
                          Browse Catalog
                        </Link>
                      </div>
                    </div>
                  </div>
                </StoreReveal>
              )}

              {(leadProduct ? restProducts : products).length > 0 && (
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3">
                  {(leadProduct ? restProducts : products).map((product, i) => (
                    <StoreReveal key={product.id} delay={Math.min(i * 90, 270)} variant="up">
                      <div className="store-featured-card h-full">
                        <StorefrontProductCard product={product} />
                      </div>
                    </StoreReveal>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <StoreReveal>
              <div className="rounded-2xl border border-[var(--sera-line)] bg-[var(--sera-surface)] py-16 text-center shadow-sm">
                <Package className="mx-auto mb-3 h-12 w-12 text-[var(--sera-muted)]/40" />
                <p className="font-medium text-[var(--sera-muted)]">No products available yet</p>
                <p className="mt-1 text-sm text-[var(--sera-muted)]/70">Check back soon for new arrivals</p>
              </div>
            </StoreReveal>
          )}

          <div className="mt-8 text-center sm:hidden">
            <Link
              href="/store/products"
              className="inline-flex items-center gap-1 text-sm font-medium text-[var(--sera-muted)] hover:text-[var(--sera-orange)]"
            >
              View All Products
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="relative overflow-hidden border-t border-[var(--sera-line)] bg-[var(--sera-surface)] py-14 sm:py-16">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 50% 70% at 50% 100%, rgba(232,93,4,0.1), transparent 60%)',
          }}
        />
        <div className="relative mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
          <StoreReveal variant="fade">
            <StoreBrandMark className="mx-auto h-8 w-auto" />
            <div className="mx-auto mt-4 h-0.5 w-12 rounded-full bg-[var(--sera-orange)] store-accent-bar" />
            <h2 className="mt-5 font-display text-2xl font-semibold text-[var(--sera-ink)] sm:text-3xl">
              Ready to get started?
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-[var(--sera-muted)]">
              Browse our full catalog and find exactly what you need.
            </p>
            <Link
              href="/store/products"
              className="mt-7 inline-flex items-center gap-2 rounded-xl bg-[var(--sera-orange)] px-8 py-3 text-sm font-semibold text-white shadow-[0_10px_28px_-12px_rgba(232,93,4,0.55)] transition-colors hover:bg-[var(--sera-orange-deep)]"
            >
              Browse Products
              <ArrowRight className="h-4 w-4" />
            </Link>
          </StoreReveal>
        </div>
      </section>
    </div>
  )
}
