'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { activeRef, normalizeAffiliateCode, OUTDOOR_REF_STORAGE_KEY } from '@/lib/outdoor/sales-tools'

/** Remembers the live host / affiliate from a ?ref=CODE link for 30 days (the latest link wins). */
export default function OutdoorRefCapture() {
  const pathname = usePathname()
  useEffect(() => {
    const code = normalizeAffiliateCode(new URLSearchParams(window.location.search).get('ref'))
    if (!code) return
    try {
      localStorage.setItem(OUTDOOR_REF_STORAGE_KEY, JSON.stringify({ code, at: Date.now() }))
    } catch {
      // Storage full / private mode
    }
  }, [pathname])
  return null
}

export function readOutdoorRef(): string {
  try {
    return activeRef(JSON.parse(localStorage.getItem(OUTDOOR_REF_STORAGE_KEY) || 'null'))
  } catch {
    return ''
  }
}
