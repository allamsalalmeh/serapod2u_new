import { OUTDOOR_SITE_DEFAULT } from '@/lib/hosts/outdoor-hosts'

const OUTDOOR_URL =
  process.env.NEXT_PUBLIC_OUTDOOR_SITE_URL?.replace(/\/$/, '')
  || OUTDOOR_SITE_DEFAULT

interface Brand {
  id: string
  name: string
  blurb: string
  href: string
  cta: string
  featured: boolean
}

const OUTDOOR_BRAND: Brand = {
  id: 'outdoor',
  name: 'Serapod Outdoor',
  blurb: 'Premium outdoor lifestyle — trails, camps, and open-air living with its own store and brand identity.',
  href: OUTDOOR_URL,
  cta: 'Explore Serapod Outdoor',
  featured: true,
}

const STORE_BRAND: Brand = {
  id: 'store',
  name: 'Serapod2U Store',
  blurb: 'Serapod devices, electronics, pet food and accessories — order online with secure checkout and nationwide delivery.',
  href: '/store',
  cta: 'Shop Serapod2U Store',
  featured: true,
}

/**
 * serapod.com shows the brand hub with a slot for the next brand. The serapod2u.com main
 * site adds the store and the staff sign-in; relative links reach their own addresses.
 */
export default function CorporateHome({ site = 'serapod' }: { site?: 'serapod' | 'serapod2u' }) {
  const isSerapod2u = site === 'serapod2u'
  const brands = isSerapod2u ? [STORE_BRAND, OUTDOOR_BRAND] : [OUTDOOR_BRAND]

  return (
    <div className="min-h-screen flex flex-col">
      <header className="relative z-10 px-6 sm:px-10 py-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/serapod-wordmark.png"
          alt="Serapod"
          className="h-8 sm:h-10 w-auto"
          width={200}
          height={56}
        />
        {isSerapod2u ? (
          <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 sm:gap-x-7">
            <a
              href="/store"
              className="text-sm font-medium text-[var(--corp-muted)] hover:text-[var(--corp-accent)] transition-colors"
            >
              Store
            </a>
            <a
              href={OUTDOOR_URL}
              className="text-sm font-medium text-[var(--corp-muted)] hover:text-[var(--corp-accent)] transition-colors"
            >
              Outdoor
            </a>
            <a
              href="/login"
              className="text-sm font-semibold text-[var(--corp-ink)] hover:text-[var(--corp-accent)] transition-colors"
            >
              Business Login
            </a>
          </nav>
        ) : (
          <a
            href={OUTDOOR_URL}
            className="text-sm font-medium text-[var(--corp-muted)] hover:text-[var(--corp-accent)] transition-colors"
          >
            Outdoor
          </a>
        )}
      </header>

      <main className="flex-1">
        <section className="relative isolate min-h-[78vh] overflow-hidden flex flex-col justify-end px-6 sm:px-10 pb-16 sm:pb-20 pt-16">
          <div
            className="absolute inset-0 -z-10"
            style={{
              backgroundImage:
                'linear-gradient(180deg, rgba(18,20,23,0.25) 0%, rgba(18,20,23,0.55) 48%, rgba(18,20,23,0.88) 100%), url(/outdoor/brand/photos/artboard-3.jpg)',
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }}
          />
          <p className="font-display text-white text-6xl sm:text-7xl lg:text-[6.5rem] font-semibold tracking-tight leading-[0.92] max-w-4xl corp-rise">
            Serapod
          </p>
          <p className="mt-5 max-w-xl text-base sm:text-lg text-white/80 leading-relaxed corp-rise corp-rise-d1">
            A Malaysian brand family built on trust, quality, and modern commerce — each business with its own identity under one Serapod house.
          </p>
        </section>

        <section className="px-6 sm:px-10 py-16 sm:py-20 bg-[var(--corp-paper)]">
          <div className="max-w-3xl">
            <h2 className="font-display text-3xl sm:text-4xl tracking-tight corp-rise">About Serapod</h2>
            <p className="mt-4 text-[var(--corp-muted)] leading-relaxed text-base sm:text-[17px] corp-rise corp-rise-d1">
              Serapod brings together product excellence and reliable operations. From outdoor lifestyle to future brand lines,
              we grow carefully — premium experiences, secure systems, and room for each label to stand on its own.
            </p>
          </div>
        </section>

        <section id="brands" className="px-6 sm:px-10 pb-24">
          <div className="max-w-6xl mx-auto">
            <h2 className="font-display text-2xl sm:text-3xl tracking-tight">Explore Serapod businesses</h2>
            <p className="mt-2 text-[var(--corp-muted)] max-w-2xl">
              {isSerapod2u
                ? 'Choose a brand below to shop online.'
                : 'Choose a brand below. The layout stays flexible so new Serapod businesses can be added without redesigning the hub.'}
            </p>

            <div className="mt-10 grid gap-5 md:grid-cols-2">
              {brands.map((brand) => (
                <article
                  key={brand.id}
                  className="rounded-2xl border border-[var(--corp-accent)]/35 bg-white p-8 sm:p-10 flex flex-col"
                >
                  <p className="text-[11px] uppercase tracking-[0.18em] text-[var(--corp-accent)] font-semibold">
                    Featured brand
                  </p>
                  <h3 className="mt-3 font-display text-3xl tracking-tight">{brand.name}</h3>
                  <p className="mt-4 text-sm sm:text-[15px] text-[var(--corp-muted)] leading-relaxed flex-1">
                    {brand.blurb}
                  </p>
                  <a
                    href={brand.href}
                    className="mt-8 inline-flex h-12 items-center justify-center rounded-lg bg-[var(--corp-accent)] hover:bg-[var(--corp-accent-deep)] px-6 text-sm font-semibold text-white transition-colors"
                  >
                    {brand.cta}
                  </a>
                </article>
              ))}

              {!isSerapod2u && (
                <article className="rounded-2xl border border-dashed border-[var(--corp-line)] bg-white/50 p-8 sm:p-10 flex flex-col justify-center min-h-[240px]">
                  <h3 className="font-display text-2xl tracking-tight text-[var(--corp-ink)]">Next Serapod brand</h3>
                  <p className="mt-3 text-sm text-[var(--corp-muted)] leading-relaxed">
                    Reserved slot for a future business. Structure is ready — add name, story, and CTA when the brand launches.
                  </p>
                </article>
              )}
            </div>
          </div>
        </section>
      </main>

      <footer className="px-6 sm:px-10 py-6 border-t border-[var(--corp-line)] text-center text-[11px] text-[var(--corp-muted)]">
        © {new Date().getFullYear()} Serapod. All rights reserved.
      </footer>
    </div>
  )
}
