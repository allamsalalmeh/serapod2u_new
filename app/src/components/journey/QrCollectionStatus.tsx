'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronUp, Store, User } from 'lucide-react'
import type { QrCollectionInfo } from '@/lib/consumer/qr-collection-info'

interface QrCollectionStatusProps {
  qrCode: string | null | undefined
  isAuthenticated: boolean
  allCollected: boolean
  anyCollected: boolean
}

function formatMyt(value: string | null) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function QrCollectionStatus({ qrCode, isAuthenticated, allCollected, anyCollected }: QrCollectionStatusProps) {
  const [info, setInfo] = useState<QrCollectionInfo | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setInfo(null)
    setOpen(false)
    if (!qrCode || !isAuthenticated || !anyCollected) return
    const controller = new AbortController()
    fetch(`/api/admin/qr-collection?code=${encodeURIComponent(qrCode)}`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) return
        const data = await response.json()
        if (data?.success && Array.isArray(data.collections)) setInfo(data)
      })
      .catch(() => {})
    return () => controller.abort()
  }, [qrCode, isAuthenticated, anyCollected])

  const canViewCollectors = !!info && info.collections.length > 0
  if (!allCollected && !canViewCollectors) return null

  return (
    <div className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50/90 px-3 py-2.5" data-testid="qr-collection-status">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-emerald-800">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span className="text-xs font-semibold">
            {allCollected ? 'Points for this QR code have already been collected' : 'Some points for this QR code have been collected'}
          </span>
        </div>
        {canViewCollectors && (
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="flex shrink-0 items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-emerald-700 shadow-sm ring-1 ring-emerald-200 hover:bg-emerald-100"
            aria-expanded={open}
          >
            Who collected?
            {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        )}
      </div>

      {open && info && (
        <div className="mt-2.5 space-y-2" data-testid="qr-collection-details">
          {info.collections.map((entry, index) => (
            <div key={`${entry.lane}-${entry.collected_at}-${index}`} className="rounded-xl bg-white px-3 py-2 text-xs text-gray-700 ring-1 ring-emerald-100">
              <div className="flex items-center justify-between gap-2">
                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                  {entry.lane === 'consumer' ? 'Consumer' : 'Shop'}
                </span>
                <span className="text-[11px] font-semibold text-emerald-700">+{entry.points} pts</span>
              </div>
              {entry.shop_name && (
                <div className="mt-1.5 flex items-center gap-1.5 min-w-0">
                  <Store className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                  <span className="break-words font-medium text-gray-900">{entry.shop_name}</span>
                </div>
              )}
              <div className="mt-1 flex items-center gap-1.5 min-w-0">
                <User className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                <span className="break-words">
                  {entry.person_name || 'Unknown'}
                  {entry.phone_last4 && <span className="text-gray-500"> · ***{entry.phone_last4}</span>}
                </span>
              </div>
              <div className="mt-1 text-[11px] text-gray-500">{formatMyt(entry.collected_at)} (MYT)</div>
            </div>
          ))}
          <p className="text-[10px] text-gray-500">
            Viewed {info.view_count} time{info.view_count === 1 ? '' : 's'} without collecting
            {info.last_viewed_at ? ` · last view ${formatMyt(info.last_viewed_at)}` : ''}. Visible to HQ staff only.
          </p>
        </div>
      )}
    </div>
  )
}
