'use client'

import { useEffect, useState } from 'react'
import { Check, Share2 } from 'lucide-react'
import { buildAffiliateLink } from '@/lib/affiliate/program'

/** "Share & earn" for approved affiliates on products that earn commission; renders nothing otherwise. */
export default function AffiliateShareButton({ productId }: { productId: string }) {
  const [share, setShare] = useState<{ code: string; percent: number | null } | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    fetch(`/api/affiliate/me?productId=${encodeURIComponent(productId)}`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (alive && json?.canShare && json.code) setShare({ code: json.code, percent: json.commissionPercent ?? null })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [productId])

  if (!share) return null
  const link = buildAffiliateLink(`${window.location.origin}/store/products/${productId}`, share.code)
  if (!link) return null

  return (
    <button
      type="button"
      onClick={async () => {
        if ('share' in navigator) {
          try {
            await navigator.share({ url: link })
            return
          } catch {
            // Closed the share sheet: fall back to copying.
          }
        }
        try {
          await navigator.clipboard.writeText(link)
          setCopied(true)
          setTimeout(() => setCopied(false), 1800)
        } catch {
          window.prompt('Copy this link', link)
        }
      }}
      className="w-full h-11 rounded-xl border border-[var(--sera-orange)]/40 text-sm font-semibold text-[var(--sera-orange)] flex items-center justify-center gap-2 transition-colors hover:bg-[var(--sera-orange)]/[0.06]"
    >
      {copied ? <Check className="h-4 w-4" /> : <Share2 className="h-4 w-4" />}
      {copied ? 'Link copied' : `Share & earn${share.percent != null ? ` ${share.percent}%` : ''}`}
    </button>
  )
}
