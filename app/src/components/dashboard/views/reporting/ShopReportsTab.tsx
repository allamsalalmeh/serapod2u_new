'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Store, MapPin } from 'lucide-react'
import ShopPerformanceTab from './ShopPerformanceTab'
import ShopByNegeriTab from './ShopByNegeriTab'
import { cn } from '@/lib/utils'
import { currentReportingMonthKey } from '@/lib/reporting/consumer-analytics'
import type { ReportingPeriod } from '@/lib/reporting/reporting-period'

interface ShopReportsTabProps {
  userProfile: any
  chartGridColor: string
  chartTickColor: string
  isDark: boolean
  /** Dashboard-level Reporting Month; the tab keeps its own when rendered alone. */
  month?: string
  onMonthChange?: (month: string) => void
}

type ShopReport = 'performance' | 'negeri'

const REPORTS: { id: ShopReport; label: string; description: string; icon: typeof Store }[] = [
  { id: 'performance', label: 'Shop Performance', description: 'Overall shop activity & scans', icon: Store },
  { id: 'negeri', label: 'Shop by Negeri', description: 'Performance by Malaysia state', icon: MapPin },
]

export default function ShopReportsTab({ userProfile, chartGridColor, chartTickColor, isDark, month: monthProp, onMonthChange }: ShopReportsTabProps) {
  const [report, setReport] = useState<ShopReport>('performance')
  const [localMonth, setLocalMonth] = useState<string>(() => currentReportingMonthKey())
  const month = monthProp ?? localMonth
  const setMonth = onMonthChange ?? setLocalMonth
  const [periods, setPeriods] = useState<ReportingPeriod[]>([])

  // Months with scans only fix the START of the supported range: every month
  // from the earliest one to today is selectable, so a month without scans is
  // an explicit empty report rather than a dead end. A failed list is not
  // fatal — the selected and current months are always offered.
  const fetchPeriods = useCallback(async () => {
    try {
      const response = await fetch('/api/reporting/shop-performance/periods', { cache: 'no-store' })
      const payload = await response.json()
      if (response.ok) setPeriods((payload.periods || []) as ReportingPeriod[])
    } catch {
      // Keep the months already known.
    }
  }, [])

  useEffect(() => { void fetchPeriods() }, [fetchPeriods])

  const availableMonths = useMemo(() => periods.map((period) => period.key), [periods])
  const shared = { userProfile, chartGridColor, chartTickColor, isDark, month, onMonthChange: setMonth, availableMonths, onRefreshPeriods: fetchPeriods }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {REPORTS.map((r) => {
          const Icon = r.icon
          const active = report === r.id
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => setReport(r.id)}
              className={cn(
                'flex items-center gap-3 rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)]/40 focus-visible:ring-offset-2',
                active
                  ? 'border-[var(--sera-orange)]/40 bg-[var(--sera-orange)]/8 shadow-sm'
                  : 'border-[var(--sera-line)] bg-white hover:border-[var(--sera-orange)]/25 hover:bg-[var(--sera-mist)]',
              )}
              aria-pressed={active}
            >
              <div className={cn(
                'p-2 rounded-lg',
                active ? 'bg-[var(--sera-orange)] text-white' : 'bg-[var(--sera-mist)] text-[var(--sera-muted)]',
              )}>
                <Icon className="h-5 w-5" strokeWidth={1.75} />
              </div>
              <div>
                <p className={cn('text-sm font-semibold', active ? 'text-[var(--sera-ink)]' : 'text-[var(--sera-ink-soft,#2a2622)]')}>{r.label}</p>
                <p className="text-xs text-[var(--sera-muted)]">{r.description}</p>
              </div>
            </button>
          )
        })}
      </div>

      {report === 'performance' ? <ShopPerformanceTab {...shared} /> : <ShopByNegeriTab {...shared} />}
    </div>
  )
}
