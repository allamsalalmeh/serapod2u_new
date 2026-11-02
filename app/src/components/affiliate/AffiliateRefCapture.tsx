'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { normalizeAffiliateCode } from '@/lib/outdoor/sales-tools'
import { AFFILIATE_REF_STORAGE_KEY, normalizeSubId, storedAffiliateRef, type StoredAffiliateRef } from '@/lib/affiliate/program'

/** Remembers the affiliate from a ?ref=CODE(&sub=) link (the latest link wins). Checkout applies the program window. */
export default function AffiliateRefCapture() {
  const pathname = usePathname()
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = normalizeAffiliateCode(params.get('ref'))
    if (!code) return
    try {
      localStorage.setItem(
        AFFILIATE_REF_STORAGE_KEY,
        JSON.stringify({ code, sub: normalizeSubId(params.get('sub')), at: Date.now() }),
      )
    } catch {
      // Storage full / private mode
    }
  }, [pathname])
  return null
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
  }
}
