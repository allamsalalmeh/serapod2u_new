'use client'

import Link from 'next/link'
import { ArrowRight, ScrollText } from 'lucide-react'
import { useSystemLogsAccess } from './useSystemLogsAccess'

/**
 * Shortcut from Security & Access → Advanced → Audit & Diagnostics to Settings → System → System Logs. Shown only to
 * viewers who may open System Logs (presentation; the page decides again). The S&A diagnostics stay where they are.
 */
export default function SystemLogsShortcut() {
  const allowed = useSystemLogsAccess()
  if (!allowed) return null
  return (
    <Link href="/settings/system/logs"
      className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500">
      <span className="flex min-w-0 items-center gap-2">
        <ScrollText className="h-4 w-4 shrink-0 text-slate-600" aria-hidden />
        <span className="truncate">Application errors and user activity are in <span className="font-medium text-gray-900">System Logs</span></span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-gray-400" aria-hidden />
    </Link>
  )
}
