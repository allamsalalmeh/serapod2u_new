'use client'

import { Suspense, useEffect } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { normalizeAffiliateCode } from '@/lib/outdoor/sales-tools'
import { AFFILIATE_REF_STORAGE_KEY, normalizeSubId, storedAffiliateRef, type StoredAffiliateRef } from '@/lib/affiliate/program'

function CaptureAffiliateRef() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const query = searchParams.toString()
  useEffect(() => {
    const params = new URLSearchParams(query)
    const code = normalizeAffiliateCode(params.get('ref'))
    if (!code) return
    const sub = normalizeSubId(params.get('sub'))
    const controller = new AbortController()

    // Do not let an older affiliate survive a newer ref click if signing fails.
    try { localStorage.removeItem(AFFILIATE_REF_STORAGE_KEY) } catch { /* private mode */ }

    void fetch('/api/affiliate/ref', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, sub }),
      signal: controller.signal,
    })
      .then(async (response) => response.ok ? response.json() : null)
      .then((claim) => {
        if (!claim || normalizeAffiliateCode(claim.code) !== code || typeof claim.token !== 'string') return
        const at = Number(claim.issuedAt)
        if (!Number.isFinite(at)) return
        try {
          localStorage.setItem(AFFILIATE_REF_STORAGE_KEY, JSON.stringify({ code, sub: normalizeSubId(claim.sub), at, token: claim.token }))
        } catch {
          // Storage full / private mode
        }
      })
      .catch(() => {
        // Abort/network failure: checkout fails closed for program commission.
      })

    return () => controller.abort()
  }, [pathname, query])
  return null
}

/** Exchanges a public ?ref= click for a server-signed claim. The latest link wins. */
export default function AffiliateRefCapture() {
  return <Suspense fallback={null}><CaptureAffiliateRef /></Suspense>
}

export function readAffiliateRef(): StoredAffiliateRef | null {
  try {
    return storedAffiliateRef(JSON.parse(localStorage.getItem(AFFILIATE_REF_STORAGE_KEY) || 'null'))
  } catch {
    return null
  }
}

/** Checkout fields for the saved link; the Outdoor host code (if any) keeps priority as before. */
export function checkoutAffiliateFields(primaryCode = '') {
  const saved = readAffiliateRef()
  const code = primaryCode || saved?.code || ''
  const sameLink = saved && saved.code === code
  return {
    affiliateCode: code || undefined,
    affiliateSubId: sameLink && saved.sub ? saved.sub : undefined,
    affiliateClickedAt: sameLink ? saved.clickedAt : undefined,
    affiliateRefToken: sameLink ? saved.token : undefined,
  }
}
