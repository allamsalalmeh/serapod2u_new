'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronRight, Link2 } from 'lucide-react'

/** My Account entry to the affiliate page; hidden while the program is closed and the person has no account. */
export default function AffiliateAccountCard() {
  const [show, setShow] = useState<{ joined: boolean; rate: number | null } | null>(null)

  useEffect(() => {
    let alive = true
    fetch('/api/affiliate/me', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!alive || !json?.signedIn) return
        if (json.affiliate || json.program?.open) setShow({ joined: Boolean(json.affiliate), rate: json.program?.commissionPercent ?? null })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  if (!show) return null
  return (
    <div className="mx-auto max-w-2xl px-4 pb-12">
      <Link
        href="/store/affiliate"
        className="flex items-center gap-4 rounded-2xl border border-[var(--sera-line)] bg-white p-4 transition-colors hover:bg-[var(--sera-mist)]"
      >
        <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-[var(--sera-orange)]/10 text-[var(--sera-orange)]">
          <Link2 className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-[var(--sera-ink)]">Affiliate program</span>
          <span className="block text-sm text-[var(--sera-muted)]">
            {show.joined
              ? 'Your links, orders and commission.'
              : `Share Serapod products with your link${show.rate != null ? ` and earn ${show.rate}% commission` : ''}.`}
          </span>
        </span>
        <ChevronRight className="h-4 w-4 text-[var(--sera-muted)]" />
      </Link>
    </div>
  )
}
