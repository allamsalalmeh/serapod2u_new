'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3, Building2, Calendar,
  ChevronLeft, ChevronRight, ClipboardList, Download, FileSpreadsheet, HeartPulse,
  Loader2, Minus, Package, PieChart as PieIcon, RefreshCw, Search, ShoppingCart,
  Target, TrendingUp, Users, X,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import {
  ALL_DISTRIBUTORS,
  ALL_STATUS,
  ACTION_LABEL,
  HEALTH_LABEL,
  buildReportingMonthOptions,
  currentReportingMonthKey,
  statusLabel,
  type ActionKey,
  type ComparisonRow,
  type DistributorAnalyticsReport,
  type DistributorRow,
  type HealthStatus,
  type LeaderboardRow,
} from '@/lib/reporting/distributor-analytics'
import type { ReportingPeriod } from '@/lib/reporting/reporting-period'
import type { DistributorDrilldown, DrilldownMetric, OrderRef } from '@/lib/reporting/distributor-drilldown'
import { supplyChainOrderPath } from '@/modules/supply-chain/supplyChainNav'
import ExecutiveKpiValue from './ExecutiveKpiValue'
import { REPORTING_COLORS, REPORTING_PANEL_CLASS, ReportingTabLoading } from './reportingChrome'

interface DistributorReportsTabProps {
  userProfile: any
  chartGridColor?: string
  chartTickColor?: string
  isDark?: boolean
}

interface ReportResponse {
  report: DistributorAnalyticsReport
  meta: { source: 'rpc' | 'fallback'; degraded: boolean; notice: string | null; generatedAt: string }
}

interface FilterOptions {
  months: ReportingPeriod[]
  distributors: { id: string; name: string; orgCode: string | null; isActive: boolean }[]
  statuses: { value: string; label: string }[]
}

const HEALTH_BADGE: Record<HealthStatus, string> = {
  growing: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  stable: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
  declining: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  inactive_period: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  watch: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300',
  at_risk: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  dormant: 'bg-zinc-300 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200',
}

const ACTION_ACCENT: Record<ActionKey, string> = {
  grow: REPORTING_COLORS.success,
  maintain: REPORTING_COLORS.slate,
  re_engage: REPORTING_COLORS.warning,
  review: REPORTING_COLORS.danger,
}

const PRIORITY_BADGE: Record<string, string> = {
  HIGH: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  MEDIUM: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  NORMAL: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
}

// ── Formatters ─────────────────────────────────────────────────────────────

function formatCount(value: number | null): string {
  if (value === null) return '—'
  return Math.round(value).toLocaleString('en-MY')
}

function formatRM(value: number | null): string {
  if (value === null) return '—'
  return `RM ${value.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Compact RM for chart axes and dense mobile cards: RM1.03M, RM905.6K. */
function formatRMCompact(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `RM${(value / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `RM${(value / 1_000).toFixed(1)}K`
  return `RM${value.toFixed(0)}`
}

function formatPct(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatDay(value: string | null): string {
  if (!value) return '—'
  // A business date (YYYY-MM-DD) is a calendar day: format it as-is, never
  // through a UTC-midnight instant.
  const dateKey = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (dateKey) return `${dateKey[3]} ${MONTH_SHORT[Number(dateKey[2]) - 1] ?? ''}`.trim()
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', timeZone: 'Asia/Kuala_Lumpur',
  }).format(date)
}

/**
 * Growth badge. A `null` growth is a missing baseline, not zero movement, and
 * reads "New activity" — never "Infinity%" and never a fabricated "+100%".
 */
function GrowthBadge({ value, suffix = '%', nullLabel = 'New activity', decimals = 1 }: {
  value: number | null
  suffix?: string
  nullLabel?: string
  /** 0 for headcount deltas — "+6 distributors", never "+6.0". */
  decimals?: number
}) {
  if (value === null) {
    return (
      <Badge variant="secondary" className="gap-0.5 px-1.5 py-0 text-[11px] font-medium bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
        {nullLabel}
      </Badge>
    )
  }
  const up = value >= 0
  const flat = value === 0
  const Icon = flat ? Minus : up ? ArrowUpRight : ArrowDownRight
  return (
    <Badge
      variant="secondary"
      className={cn(
        'gap-0.5 px-1.5 py-0 text-[11px] font-semibold',
        flat
          ? 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300'
          : up
            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
            : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
      )}
    >
      <Icon className="h-3 w-3" />
      {Math.abs(value).toFixed(decimals)}{suffix}
    </Badge>
  )
}

function HealthBadge({ health }: { health: HealthStatus }) {
  return (
    <Badge variant="secondary" className={cn('whitespace-nowrap px-1.5 py-0 text-[11px] font-medium', HEALTH_BADGE[health])}>
      {HEALTH_LABEL[health]}
    </Badge>
  )
}

// ── Layout primitives (shared with the Product Analytics chrome) ───────────

/** Keyboard + pointer affordance for a card that opens a drill-down. */
function interactiveProps(onClick: (() => void) | undefined, label: string) {
  if (!onClick) return {}
  return {
    role: 'button' as const,
    tabIndex: 0,
    'aria-haspopup': 'dialog' as const,
    'aria-label': `View ${label} details`,
    onClick,
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onClick()
      }
    },
  }
}

const INTERACTIVE_CARD_CLASS = 'cursor-pointer hover:-translate-y-0.5 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)]/40'

function KpiCard({ label, icon: Icon, accent, value, delta, caption, onClick }: {
  label: string
  icon: typeof Package
  accent: string
  value: string
  delta?: React.ReactNode
  caption?: string | null
  onClick?: () => void
}) {
  return (
    <Card
      className={cn(REPORTING_PANEL_CLASS, 'transition-all hover:border-[var(--sera-orange)]/35', onClick && INTERACTIVE_CARD_CLASS)}
      {...interactiveProps(onClick, label)}
    >
      <CardContent className="px-3 pb-3 pt-4 sm:px-5 sm:pt-5">
        <div className="mb-2 flex items-start justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--sera-muted)] sm:text-xs">
            {label}
          </span>
          <span className="shrink-0 rounded-xl p-1.5 shadow-sm sm:p-2" style={{ backgroundColor: `${accent}15` }}>
            <Icon className="h-4 w-4" style={{ color: accent }} strokeWidth={1.75} />
          </span>
        </div>
        <ExecutiveKpiValue>{value}</ExecutiveKpiValue>
        {delta ? <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">{delta}</div> : null}
        {caption ? <p className="mt-1 text-[10px] text-[var(--sera-muted)] sm:text-[11px]">{caption}</p> : null}
      </CardContent>
    </Card>
  )
}

function SectionCard({ title, description, icon: Icon, action, children, className }: {
  title: string
  description?: string
  icon: typeof Package
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <Card className={cn(REPORTING_PANEL_CLASS, className)}>
      <CardHeader className="flex flex-col gap-2 space-y-0 pb-3 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-sm text-[var(--sera-ink)] sm:text-base">
            <Icon className="h-4 w-4 shrink-0 text-[var(--sera-orange)]" strokeWidth={1.75} />
            <span className="truncate">{title}</span>
          </CardTitle>
          {description ? <CardDescription className="mt-0.5 text-xs sm:text-sm">{description}</CardDescription> : null}
        </div>
        {action}
      </CardHeader>
      <CardContent className="px-3 sm:px-6">{children}</CardContent>
    </Card>
  )
}

function SummaryTile({ label, description, count, accent, active, onClick }: {
  label: string
  description?: string
  count: number
  accent: string
  active?: boolean
  onClick?: () => void
}) {
  const Wrapper: any = onClick ? 'button' : 'div'
  return (
    <Wrapper
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'flex w-full flex-col items-start gap-1 rounded-xl border p-3 text-left transition-all',
        onClick && 'hover:-translate-y-0.5 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)]/40',
        active ? 'border-[var(--sera-orange)] ring-1 ring-[var(--sera-orange)]/30' : 'border-[var(--sera-line)]',
      )}
      style={{ backgroundColor: `${accent}0f` }}
    >
      <span className="flex items-center gap-1.5 text-[11px] font-semibold sm:text-xs" style={{ color: accent }}>
        <span className="truncate">{label}</span>
      </span>
      <span className="text-2xl font-bold text-[var(--sera-ink)] sm:text-3xl">{formatCount(count)}</span>
      {description ? (
        <span className="line-clamp-2 text-[10px] leading-tight text-[var(--sera-muted)] sm:text-[11px]">{description}</span>
      ) : null}
    </Wrapper>
  )
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-sm text-[var(--sera-muted)]">{children}</p>
}

/** One label/value line inside a mobile card, replacing a desktop table cell. */
function MobileField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[11px] text-[var(--sera-muted)]">{label}</span>
      <span className="text-right text-xs font-medium text-[var(--sera-ink)]">{children}</span>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

export default function DistributorReportsTab({
  userProfile,
  chartGridColor,
  chartTickColor,
  isDark = false,
}: DistributorReportsTabProps) {
  const chartGrid = chartGridColor ?? (isDark ? '#374151' : '#f0f0f0')
  const chartTick = chartTickColor ?? (isDark ? '#9ca3af' : '#6b7280')
  const tooltipStyle = {
    borderRadius: '12px',
    border: 'none',
    boxShadow: '0 10px 15px -3px rgba(0,0,0,0.15)',
    backgroundColor: isDark ? 'rgba(31,41,55,0.95)' : 'rgba(255,255,255,0.95)',
    color: isDark ? '#f3f4f6' : undefined,
  }

  // Report scope — persists across sub-tab switches because it lives above the
  // Tabs component and nothing here resets it.
  const [month, setMonth] = useState<string>(() => currentReportingMonthKey())
  const [distributorId, setDistributorId] = useState<string>(ALL_DISTRIBUTORS)
  const [status, setStatus] = useState<string>(ALL_STATUS)

  const [filters, setFilters] = useState<FilterOptions>({ months: [], distributors: [], statuses: [] })
  const [response, setResponse] = useState<ReportResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloading, setReloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)

  const [subTab, setSubTab] = useState('overview')
  const [leaderboardSearch, setLeaderboardSearch] = useState('')
  const [actionFilter, setActionFilter] = useState<ActionKey | null>(null)
  const [downloading, setDownloading] = useState(false)

  const [drawerId, setDrawerId] = useState<string | null>(null)
  const [drawerReport, setDrawerReport] = useState<DistributorAnalyticsReport | null>(null)
  const [drawerLoading, setDrawerLoading] = useState(false)
  const drawerRequestId = useRef(0)

  // ── Filter options ───────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/reporting/distributor-analytics/filters', { cache: 'no-store' })
        const payload = await res.json()
        if (cancelled || !res.ok) return
        setFilters({
          months: (payload.months || []) as ReportingPeriod[],
          distributors: (payload.distributors || []) as FilterOptions['distributors'],
          statuses: (payload.statuses || []) as FilterOptions['statuses'],
        })
      } catch {
        // A failed filter list is not fatal: the current month, All Distributors
        // and All Status are always offered.
      }
    })()
    return () => { cancelled = true }
  }, [])

  // ── Report ───────────────────────────────────────────────────────────────
  const loadReport = useCallback(async (
    targetMonth: string,
    targetDistributor: string,
    targetStatus: string,
    isInitial: boolean,
  ) => {
    const id = ++requestId.current
    if (isInitial) setLoading(true)
    else setReloading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        month: targetMonth,
        distributor: targetDistributor,
        status: targetStatus,
      })
      const res = await fetch(`/api/reporting/distributor-analytics?${params}`, { cache: 'no-store' })
      const payload = await res.json()
      // A slower earlier request must never overwrite a newer scope's report.
      if (id !== requestId.current) return
      if (!res.ok) throw new Error(payload.error || 'Unable to load distributor analytics')
      setResponse(payload as ReportResponse)
    } catch (err: any) {
      if (id !== requestId.current) return
      setError(err?.message || 'Unable to load distributor analytics')
    } finally {
      if (id === requestId.current) {
        setLoading(false)
        setReloading(false)
      }
    }
  }, [])

  // Changing month, distributor or status reloads automatically — no Apply step.
  useEffect(() => {
    void loadReport(month, distributorId, status, response === null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, distributorId, status, loadReport])

  /**
   * Distributor-scoped URL state, so a shared link reopens the same report.
   * The retired `dateRange` / `orderType` parameters are dropped rather than
   * left behind saying `last3Months` under a monthly UI.
   */
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    params.set('month', month)
    params.set('distributor', distributorId)
    params.set('status', status)
    params.delete('dateRange')
    params.delete('orderType')
    params.delete('seller')
    params.delete('search')
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`)
  }, [month, distributorId, status])

  // Restore scope from the URL once, before the first load settles.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const urlMonth = params.get('month')
    const urlDistributor = params.get('distributor')
    const urlStatus = params.get('status')
    if (urlMonth && /^\d{4}-(0[1-9]|1[0-2])$/.test(urlMonth) && urlMonth <= currentReportingMonthKey()) {
      setMonth(urlMonth)
    }
    if (urlDistributor) setDistributorId(urlDistributor)
    if (urlStatus) setStatus(urlStatus)
  }, [])

  const monthOptions = useMemo(
    () => buildReportingMonthOptions([...filters.months.map((period) => period.key), month]),
    [filters.months, month],
  )
  const monthIndex = monthOptions.findIndex((option) => option.value === month)
  const olderMonth = monthIndex >= 0 ? monthOptions[monthIndex + 1]?.value : undefined
  const newerMonth = monthIndex > 0 ? monthOptions[monthIndex - 1]?.value : undefined

  const report = response?.report ?? null
  const meta = response?.meta ?? null
  const singleDistributor = Boolean(report && !report.distributor.isAll)

  /**
   * The PDF is built from the report DTO already in state, so it always carries
   * every section — Overview, Performance and Relationship & Risk — regardless
   * of which sub-tab is on screen, and its numbers are the on-screen numbers.
   */
  const handleDownloadPdf = useCallback(async () => {
    if (!report) return
    setDownloading(true)
    try {
      const { buildDistributorAnalyticsPdf } = await import('@/lib/reporting/distributor-analytics-pdf')
      const pdf = await buildDistributorAnalyticsPdf(report, {
        generatedAt: meta?.generatedAt ?? null,
        generatedBy: userProfile?.full_name || userProfile?.email || null,
      })
      const url = URL.createObjectURL(pdf.blob)
      const link = document.createElement('a')
      link.href = url
      link.download = pdf.filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    } catch (err: any) {
      setError(err?.message || 'Unable to generate the PDF report')
    } finally {
      setDownloading(false)
    }
  }, [report, meta, userProfile])

  const handleExportCsv = useCallback(() => {
    const params = new URLSearchParams({ month, distributor: distributorId, status })
    window.open(`/api/reporting/distributor-analytics/csv?${params}`, '_blank', 'noopener')
  }, [month, distributorId, status])

  /**
   * The drawer re-reads the SAME endpoint scoped to one distributor, inheriting
   * the selected Reporting Month and Status, so its figures are the report's
   * figures rather than a second calculation.
   */
  const openDrawer = useCallback((id: string) => {
    setDrawerId(id)
    setDrawerReport(null)
    setDrawerLoading(true)
    const requestKey = ++drawerRequestId.current
    void (async () => {
      try {
        const params = new URLSearchParams({ month, distributor: id, status })
        const res = await fetch(`/api/reporting/distributor-analytics?${params}`, { cache: 'no-store' })
        const payload = await res.json()
        if (requestKey !== drawerRequestId.current) return
        if (res.ok) setDrawerReport((payload as ReportResponse).report)
      } finally {
        if (requestKey === drawerRequestId.current) setDrawerLoading(false)
      }
    })()
  }, [month, status])

  // ── Metric drill-downs ───────────────────────────────────────────────────
  // Always requested for the dashboard's CURRENT month / distributor / status;
  // rows are cleared on every open and a slower earlier response is dropped.
  const [metricOpen, setMetricOpen] = useState<DrilldownMetric | null>(null)
  const [metricData, setMetricData] = useState<DistributorDrilldown | null>(null)
  const [metricLoading, setMetricLoading] = useState(false)
  const [metricError, setMetricError] = useState<string | null>(null)
  const metricRequestId = useRef(0)

  const loadMetric = useCallback((metric: DrilldownMetric, scope: { month: string; distributor: string; status: string }) => {
    const requestKey = ++metricRequestId.current
    setMetricData(null)
    setMetricError(null)
    setMetricLoading(true)
    void (async () => {
      try {
        const params = new URLSearchParams({ metric, ...scope })
        const res = await fetch(`/api/reporting/distributor-analytics/drilldown?${params}`, { cache: 'no-store' })
        const payload = await res.json()
        if (requestKey !== metricRequestId.current) return
        if (!res.ok) throw new Error(payload.error || 'Unable to load details')
        setMetricData(payload.drilldown as DistributorDrilldown)
      } catch (err: any) {
        if (requestKey === metricRequestId.current) setMetricError(err?.message || 'Unable to load details')
      } finally {
        if (requestKey === metricRequestId.current) setMetricLoading(false)
      }
    })()
  }, [])

  const openMetric = useCallback((metric: DrilldownMetric) => {
    setMetricOpen(metric)
    loadMetric(metric, { month, distributor: distributorId, status })
  }, [loadMetric, month, distributorId, status])

  // A scope change while the drawer is open re-reads it for the new scope.
  useEffect(() => {
    if (metricOpen) loadMetric(metricOpen, { month, distributor: distributorId, status })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, distributorId, status])

  const visibleLeaderboard = useMemo(() => {
    if (!report) return []
    const query = leaderboardSearch.trim().toLowerCase()
    if (!query) return report.leaderboard
    return report.leaderboard.filter((row) => row.name.toLowerCase().includes(query))
  }, [report, leaderboardSearch])

  const visibleActionRows = useMemo(() => {
    if (!report) return []
    if (!actionFilter) return report.actionPlan.rows
    return report.actionPlan.rows.filter((row) => row.action === actionFilter)
  }, [report, actionFilter])

  const contributionSlices = useMemo(() => {
    if (!report) return []
    const palette = [REPORTING_COLORS.primary, REPORTING_COLORS.warning, REPORTING_COLORS.slate]
    return report.contribution.bands
      .filter((band) => band.orderValue > 0)
      .map((band, index) => ({ name: band.label, value: band.orderValue, fill: palette[index % palette.length] }))
  }, [report])

  const distributorName = useCallback((id: string) => {
    return filters.distributors.find((row) => row.id === id)?.name ?? 'Selected distributor'
  }, [filters.distributors])

  // ── Header ───────────────────────────────────────────────────────────────
  const controls = (
    <div className="flex w-full flex-col gap-3 xl:w-auto xl:flex-row xl:items-end">
      <div className="space-y-1.5">
        <label htmlFor="distributor-analytics-month" className="text-xs font-medium text-[var(--sera-muted)]">
          Reporting Month
        </label>
        <div className="flex items-center gap-1.5">
          <Select value={month} onValueChange={setMonth}>
            <SelectTrigger
              id="distributor-analytics-month"
              className="h-10 min-w-0 flex-1 border-[var(--sera-line)] bg-white text-sm xl:h-9 xl:w-[180px] xl:flex-none"
            >
              <Calendar className="mr-2 h-3.5 w-3.5 shrink-0 text-[var(--sera-muted)]" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {monthOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline" size="icon"
            className="h-10 w-10 shrink-0 border-[var(--sera-line)] xl:h-9 xl:w-9"
            onClick={() => olderMonth && setMonth(olderMonth)}
            disabled={!olderMonth}
            title="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline" size="icon"
            className="h-10 w-10 shrink-0 border-[var(--sera-line)] xl:h-9 xl:w-9"
            onClick={() => newerMonth && setMonth(newerMonth)}
            disabled={!newerMonth}
            title="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="distributor-analytics-distributor" className="text-xs font-medium text-[var(--sera-muted)]">
          Distributor
        </label>
        <Select value={distributorId} onValueChange={setDistributorId}>
          <SelectTrigger
            id="distributor-analytics-distributor"
            className="h-10 w-full border-[var(--sera-line)] bg-white text-sm xl:h-9 xl:w-[210px]"
          >
            <Building2 className="mr-2 h-3.5 w-3.5 shrink-0 text-[var(--sera-muted)]" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_DISTRIBUTORS}>All Distributors</SelectItem>
            {filters.distributors.map((row) => (
              <SelectItem key={row.id} value={row.id}>{row.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="distributor-analytics-status" className="text-xs font-medium text-[var(--sera-muted)]">
          Status
        </label>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger
            id="distributor-analytics-status"
            className="h-10 w-full border-[var(--sera-line)] bg-white text-sm xl:h-9 xl:w-[150px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_STATUS}>All Status</SelectItem>
            {filters.statuses.map((row) => (
              <SelectItem key={row.value} value={row.value}>{row.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          className="h-10 flex-1 gap-2 border-[var(--sera-line)] xl:h-9 xl:flex-none"
          onClick={() => loadReport(month, distributorId, status, false)}
          disabled={loading || reloading}
        >
          <RefreshCw className={cn('h-4 w-4', reloading && 'animate-spin')} />
          Refresh
        </Button>
        <Button
          variant="outline"
          className="h-10 flex-1 gap-2 border-[var(--sera-line)] xl:h-9 xl:flex-none"
          onClick={handleDownloadPdf}
          disabled={!report || downloading || loading}
          title={report ? 'Download the complete distributor management report' : 'Report not loaded yet'}
        >
          {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          <span className="whitespace-nowrap">Download PDF</span>
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-10 w-10 shrink-0 border-[var(--sera-line)] xl:h-9 xl:w-9"
          onClick={handleExportCsv}
          disabled={loading}
          title="Export the selected month's orders as CSV"
        >
          <FileSpreadsheet className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )

  const header = (
    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--sera-ink)]">
          <Building2 className="h-5 w-5 text-[var(--sera-orange)]" strokeWidth={1.75} />
          Distributor Analytics
        </h2>
        <p className="mt-0.5 text-sm text-[var(--sera-muted)]">
          Monthly distributor performance &amp; relationship report
        </p>
        {report ? (
          <p className="mt-1.5 text-[11px] leading-tight text-[var(--sera-muted)]">
            <span className="font-medium text-[var(--sera-ink)]">Report Period: {report.period.rangeLabel}</span>
            {report.period.isCurrentMonth ? ' (month to date)' : ''}
            <br />
            <span>Comparing with: {report.period.comparisonRangeLabel}</span>
            {report.period.comparisonClamped ? ' (clamped to the shorter previous month)' : ''}
          </p>
        ) : null}
      </div>
      {controls}
    </div>
  )

  if (loading && !report) {
    return (
      <div className="space-y-6">
        {header}
        <ReportingTabLoading label="Loading distributor report" />
      </div>
    )
  }

  if (!report) {
    return (
      <div className="space-y-6">
        {header}
        {error ? (
          <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}
      </div>
    )
  }

  const { period, summary, comparison } = report
  const findComparison = (key: string) => comparison.find((row) => row.key === key)
  const activeChange = findComparison('activeDistributors')?.changePoints ?? null
  const returningChange = findComparison('returningRate')?.changePoints ?? null

  const comparisonCell = (row: ComparisonRow, side: 'current' | 'previous') => {
    const value = row[side]
    if (row.format === 'currency') return formatRM(value)
    if (row.format === 'percent') return formatPct(value)
    return formatCount(value)
  }

  const comparisonChange = (row: ComparisonRow) => {
    if (row.format === 'percent') {
      return <GrowthBadge value={row.changePoints} suffix="pp" nullLabel="No baseline" />
    }
    if (row.key === 'activeDistributors') {
      return (
        <GrowthBadge
          value={row.changePoints === null ? null : Number(row.changePoints)}
          suffix=""
          decimals={0}
          nullLabel="No baseline"
        />
      )
    }
    return <GrowthBadge value={row.changePct} />
  }

  const emptyPeriodNote = 'No distributor order activity recorded for the selected period.'

  return (
    <div className={cn('space-y-6 transition-opacity', reloading && 'opacity-70')}>
      {header}

      {error ? (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{error} — showing the last report that loaded successfully.</span>
        </div>
      ) : null}

      {meta?.notice ? (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{meta.notice}</span>
        </div>
      ) : null}

      <Tabs value={subTab} onValueChange={setSubTab} className="space-y-5">
        {/* Touch-friendly and horizontally scrollable below the desktop breakpoint. */}
        <TabsList className="flex h-auto w-full justify-start gap-1 overflow-x-auto rounded-xl border border-[var(--sera-line)] bg-[var(--sera-mist)] p-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {[
            { value: 'overview', label: 'Overview', icon: BarChart3 },
            { value: 'performance', label: 'Performance', icon: TrendingUp },
            { value: 'relationship', label: 'Relationship & Risk', icon: HeartPulse },
          ].map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              className="shrink-0 whitespace-nowrap rounded-lg px-3.5 py-2 text-sm text-[var(--sera-muted)] data-[state=active]:border data-[state=active]:border-[var(--sera-orange)]/30 data-[state=active]:bg-white data-[state=active]:text-[var(--sera-ink)] data-[state=active]:shadow-sm sm:px-4"
            >
              <tab.icon className="mr-1.5 h-4 w-4" />
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* ══ OVERVIEW ══════════════════════════════════════════════════ */}
        <TabsContent value="overview" className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-5">
            <KpiCard
              label="Total Orders"
              icon={ShoppingCart}
              accent={REPORTING_COLORS.primary}
              value={formatCount(summary.totalOrders)}
              delta={<GrowthBadge value={findComparison('totalOrders')?.changePct ?? null} />}
              caption={`${summary.avgOrdersPerDay.toFixed(1)} per day`}
              onClick={() => openMetric('total_orders')}
            />
            <KpiCard
              label="Order Value"
              icon={Target}
              accent={REPORTING_COLORS.success}
              value={formatRMCompact(summary.orderValue)}
              delta={<GrowthBadge value={findComparison('orderValue')?.changePct ?? null} />}
              caption={`${formatRMCompact(summary.avgValuePerDay)} per day`}
            />
            <KpiCard
              label="Avg Order Value"
              icon={BarChart3}
              accent={REPORTING_COLORS.violet}
              value={summary.avgOrderValue === null ? '—' : formatRMCompact(summary.avgOrderValue)}
              delta={<GrowthBadge value={findComparison('avgOrderValue')?.changePct ?? null} />}
              caption={`Comparison ${findComparison('avgOrderValue')?.previous === null ? '—' : formatRMCompact(findComparison('avgOrderValue')!.previous!)}`}
            />
            <KpiCard
              label="Active Distributors"
              icon={Users}
              accent={REPORTING_COLORS.warning}
              value={formatCount(summary.activeDistributors)}
              delta={<GrowthBadge value={activeChange} suffix="" decimals={0} nullLabel="No baseline" />}
              caption={`${formatCount(summary.multipleOrderDistributors)} placed more than one order`}
              onClick={() => openMetric('active')}
            />
            <KpiCard
              label="Returning Rate"
              icon={RefreshCw}
              accent={REPORTING_COLORS.cyan}
              value={formatPct(summary.returningRatePct)}
              delta={<GrowthBadge value={returningChange} suffix="pp" nullLabel="No baseline" />}
              caption={`${formatCount(summary.returningDistributors)} of ${formatCount(summary.activeDistributors)} active traded before`}
            />
          </div>

          {report.isEmpty ? (
            <Card className={REPORTING_PANEL_CLASS}>
              <CardContent className="py-10">
                <EmptyNote>{emptyPeriodNote}</EmptyNote>
              </CardContent>
            </Card>
          ) : null}

          <SectionCard
            title="This Period vs Previous Period"
            description={`${period.rangeLabel} compared with ${period.comparisonRangeLabel}`}
            icon={TrendingUp}
          >
            <div className="hidden md:block">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-[var(--sera-line)] text-left text-xs text-[var(--sera-muted)]">
                      <th className="px-2 py-2 font-medium">Metric</th>
                      <th className="px-2 py-2 text-right font-medium">Current</th>
                      <th className="px-2 py-2 text-right font-medium">Previous</th>
                      <th className="px-2 py-2 text-right font-medium">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.map((row) => (
                      <tr key={row.key} className="border-b border-[var(--sera-line)]/60 last:border-0">
                        <td className="px-2 py-2.5 font-medium text-[var(--sera-ink)]">{row.label}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums">{comparisonCell(row, 'current')}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums text-[var(--sera-muted)]">{comparisonCell(row, 'previous')}</td>
                        <td className="px-2 py-2.5 text-right">{comparisonChange(row)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="space-y-2.5 md:hidden">
              {comparison.map((row) => (
                <div key={row.key} className="rounded-xl border border-[var(--sera-line)] p-3">
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-[var(--sera-ink)]">{row.label}</span>
                    {comparisonChange(row)}
                  </div>
                  <MobileField label="Current">{comparisonCell(row, 'current')}</MobileField>
                  <MobileField label="Previous">{comparisonCell(row, 'previous')}</MobileField>
                </div>
              ))}
            </div>
          </SectionCard>

          <SectionCard
            title="Key Management Insights"
            description="Relationship and concentration signals for the selected period"
            icon={PieIcon}
          >
            <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-3 xl:grid-cols-5">
              {report.insights
                // Concentration across one distributor is always 100%, so the
                // card is dropped rather than shown saying nothing.
                .filter((card) => !(singleDistributor && card.key === 'concentration'))
                .map((card) => {
                  const metric = INSIGHT_DRILLDOWN[card.key]
                  return (
                    <div
                      key={card.key}
                      data-testid={`insight-${card.key}`}
                      className={cn('rounded-xl border border-[var(--sera-line)] bg-[var(--sera-mist)]/40 p-3 transition-all', metric && INTERACTIVE_CARD_CLASS)}
                      {...interactiveProps(metric ? () => openMetric(metric) : undefined, card.title)}
                    >
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--sera-muted)]">{card.title}</p>
                      <p className="mt-1 text-2xl font-bold text-[var(--sera-ink)] sm:text-3xl">{card.value}</p>
                      <p className="mt-1 text-[10px] leading-tight text-[var(--sera-muted)] sm:text-[11px]">{card.description}</p>
                    </div>
                  )
                })}
            </div>
          </SectionCard>
        </TabsContent>

        {/* ══ PERFORMANCE ═══════════════════════════════════════════════ */}
        <TabsContent value="performance" className="space-y-5">
          <SectionCard
            title="Daily Sell-In Trend"
            description={`${period.rangeLabel}${period.isCurrentMonth ? ' — month to date, no future days' : ''}`}
            icon={BarChart3}
          >
            {report.dailyTrend.length === 0 || summary.totalOrders === 0 ? (
              <EmptyNote>{emptyPeriodNote}</EmptyNote>
            ) : (
              <div className="h-[260px] w-full sm:h-[320px]">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={report.dailyTrend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={chartGrid} vertical={false} />
                    <XAxis dataKey="shortLabel" tick={{ fontSize: 11, fill: chartTick }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                    <YAxis yAxisId="orders" tick={{ fontSize: 11, fill: chartTick }} tickLine={false} axisLine={false} allowDecimals={false} width={34} />
                    <YAxis
                      yAxisId="value" orientation="right" width={62}
                      tick={{ fontSize: 11, fill: chartTick }} tickLine={false} axisLine={false}
                      tickFormatter={(value: number) => formatRMCompact(value)}
                    />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      labelFormatter={(_label, payload) => payload?.[0]?.payload?.label ?? ''}
                      formatter={(value: any, name: any) => (
                        name === 'Order Value' ? formatRM(Number(value)) : formatCount(Number(value))
                      )}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar yAxisId="orders" dataKey="orders" name="Orders" fill={REPORTING_COLORS.primary} radius={[4, 4, 0, 0]} maxBarSize={26} />
                    <Line yAxisId="value" type="monotone" dataKey="orderValue" name="Order Value" stroke={REPORTING_COLORS.success} strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </SectionCard>

          {/* A leaderboard and a contribution split of one distributor say
              nothing, so the single-distributor view replaces them with the
              account's own order history. */}
          {singleDistributor ? (
            <SectionCard
              title={`Recent Orders — ${report.distributor.name}`}
              description={period.rangeLabel}
              icon={ClipboardList}
            >
              {report.recentOrders.length === 0 ? (
                <EmptyNote>{emptyPeriodNote}</EmptyNote>
              ) : (
                <>
                  <div className="hidden overflow-x-auto md:block">
                    <table className="w-full min-w-[620px] text-sm">
                      <thead>
                        <tr className="border-b border-[var(--sera-line)] text-left text-xs text-[var(--sera-muted)]">
                          <th className="px-2 py-2 font-medium">Order No</th>
                          <th className="px-2 py-2 font-medium">Date</th>
                          <th className="px-2 py-2 font-medium">Status</th>
                          <th className="px-2 py-2 text-right font-medium">Items</th>
                          <th className="px-2 py-2 text-right font-medium">Order Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.recentOrders.map((order) => (
                          <tr key={order.orderId} className="border-b border-[var(--sera-line)]/60 last:border-0">
                            <td className="px-2 py-2.5 font-medium text-[var(--sera-ink)]">{order.orderNo || order.orderId}</td>
                            <td className="px-2 py-2.5">{formatDay(order.orderDate || order.createdAt)}</td>
                            <td className="px-2 py-2.5">{statusLabel(order.status)}</td>
                            <td className="px-2 py-2.5 text-right tabular-nums">{formatCount(order.itemCount)}</td>
                            <td className="px-2 py-2.5 text-right tabular-nums">{formatRM(order.orderValue)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="space-y-2.5 md:hidden">
                    {report.recentOrders.map((order) => (
                      <div key={order.orderId} className="rounded-xl border border-[var(--sera-line)] p-3">
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <span className="truncate text-xs font-semibold text-[var(--sera-ink)]">{order.orderNo || order.orderId}</span>
                          <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[11px]">{statusLabel(order.status)}</Badge>
                        </div>
                        <MobileField label="Date">{formatDay(order.orderDate || order.createdAt)}</MobileField>
                        <MobileField label="Items">{formatCount(order.itemCount)}</MobileField>
                        <MobileField label="Order Value">{formatRM(order.orderValue)}</MobileField>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </SectionCard>
          ) : (
            <>
              <SectionCard
                title="Distributor Leaderboard"
                description="Ranked by Order Value — tap a row for the full account detail"
                icon={Users}
                action={(
                  <div className="relative w-full sm:w-[210px]">
                    <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--sera-muted)]" />
                    <Input
                      value={leaderboardSearch}
                      onChange={(event) => setLeaderboardSearch(event.target.value)}
                      placeholder="Search distributor..."
                      className="h-9 pl-8 text-sm"
                    />
                  </div>
                )}
              >
                {visibleLeaderboard.length === 0 ? (
                  <EmptyNote>
                    {report.leaderboard.length === 0 ? emptyPeriodNote : 'No distributor matches that search.'}
                  </EmptyNote>
                ) : (
                  <>
                    <div className="hidden overflow-x-auto md:block">
                      <table className="w-full min-w-[820px] text-sm">
                        <thead>
                          <tr className="border-b border-[var(--sera-line)] text-left text-xs text-[var(--sera-muted)]">
                            <th className="px-2 py-2 font-medium">#</th>
                            <th className="px-2 py-2 font-medium">Distributor</th>
                            <th className="px-2 py-2 text-right font-medium">Order Value</th>
                            <th className="px-2 py-2 text-right font-medium">Orders</th>
                            <th className="px-2 py-2 text-right font-medium">AOV</th>
                            <th className="px-2 py-2 text-right font-medium">Share</th>
                            <th className="px-2 py-2 text-right font-medium">vs Previous</th>
                            <th className="px-2 py-2 text-right font-medium">Last Order</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleLeaderboard.map((row: LeaderboardRow) => (
                            <tr
                              key={row.distributorId}
                              onClick={() => openDrawer(row.distributorId)}
                              className="cursor-pointer border-b border-[var(--sera-line)]/60 last:border-0 hover:bg-[var(--sera-mist)]/50"
                            >
                              <td className="px-2 py-2.5 text-right tabular-nums text-[var(--sera-muted)]">{row.rank}</td>
                              <td className="px-2 py-2.5 font-medium text-[var(--sera-ink)]">{row.name}</td>
                              <td className="px-2 py-2.5 text-right tabular-nums">{formatRM(row.currentValue)}</td>
                              <td className="px-2 py-2.5 text-right tabular-nums">{formatCount(row.currentOrders)}</td>
                              <td className="px-2 py-2.5 text-right tabular-nums">{formatRM(row.aov)}</td>
                              <td className="px-2 py-2.5 text-right tabular-nums">{formatPct(row.sharePct)}</td>
                              <td className="px-2 py-2.5 text-right"><GrowthBadge value={row.growthPct} /></td>
                              <td className="px-2 py-2.5 text-right tabular-nums">{formatDay(row.lastOrderAt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="space-y-2.5 md:hidden">
                      {visibleLeaderboard.map((row: LeaderboardRow) => (
                        <button
                          key={row.distributorId}
                          type="button"
                          onClick={() => openDrawer(row.distributorId)}
                          className="w-full rounded-xl border border-[var(--sera-line)] p-3 text-left transition-colors hover:border-[var(--sera-orange)]/40"
                        >
                          <div className="mb-2 flex items-start justify-between gap-2">
                            <span className="min-w-0 text-sm font-semibold text-[var(--sera-ink)]">
                              <span className="text-[var(--sera-muted)]">#{row.rank}</span> {row.name}
                            </span>
                            <GrowthBadge value={row.growthPct} />
                          </div>
                          <MobileField label="Order Value">{formatRM(row.currentValue)}</MobileField>
                          <MobileField label="Orders">{formatCount(row.currentOrders)}</MobileField>
                          <MobileField label="AOV">{formatRM(row.aov)}</MobileField>
                          <MobileField label="Share">{formatPct(row.sharePct)}</MobileField>
                          <MobileField label="Last Order">{formatDay(row.lastOrderAt)}</MobileField>
                          <p className="mt-1.5 text-[10px] text-[var(--sera-orange)]">Tap for details</p>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </SectionCard>

              <SectionCard
                title="Distributor Contribution"
                description={
                  report.contribution.topQuintileSharePct === null
                    ? 'Dependency and concentration risk'
                    : `Top 20% of active distributors carry ${report.contribution.topQuintileSharePct.toFixed(0)}% of Order Value`
                }
                icon={PieIcon}
              >
                {report.contribution.distributorCount === 0 ? (
                  <EmptyNote>{emptyPeriodNote}</EmptyNote>
                ) : (
                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="h-[220px] w-full sm:h-[240px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={contributionSlices}
                            dataKey="value"
                            nameKey="name"
                            innerRadius="52%"
                            outerRadius="80%"
                            paddingAngle={2}
                          >
                            {contributionSlices.map((slice) => (
                              <Cell key={slice.name} fill={slice.fill} />
                            ))}
                          </Pie>
                          <Tooltip contentStyle={tooltipStyle} formatter={(value: any) => formatRM(Number(value))} />
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="space-y-2 self-center">
                      {report.contribution.bands.map((band) => (
                        <div key={band.label} className="rounded-xl border border-[var(--sera-line)] p-3">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-[var(--sera-ink)]">{band.label}</span>
                            <span className="text-sm font-bold text-[var(--sera-ink)]">{formatPct(band.sharePct)}</span>
                          </div>
                          <div className="mt-1 flex items-baseline justify-between gap-2 text-[11px] text-[var(--sera-muted)]">
                            <span>{formatCount(band.distributors)} distributor{band.distributors === 1 ? '' : 's'}</span>
                            <span className="tabular-nums">{formatRM(band.orderValue)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </SectionCard>
            </>
          )}

          <SectionCard
            title={singleDistributor ? `Top Products — ${report.distributor.name}` : 'Top Products Across Distributors'}
            description={`Ordered by distributors during ${period.rangeLabel}`}
            icon={Package}
          >
            {report.topProducts.length === 0 ? (
              <EmptyNote>No products were ordered by distributors in the selected period.</EmptyNote>
            ) : (
              <>
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full min-w-[620px] text-sm">
                    <thead>
                      <tr className="border-b border-[var(--sera-line)] text-left text-xs text-[var(--sera-muted)]">
                        <th className="px-2 py-2 font-medium">#</th>
                        <th className="px-2 py-2 font-medium">Product / Variant</th>
                        <th className="px-2 py-2 text-right font-medium">Units</th>
                        <th className="px-2 py-2 text-right font-medium">Order Value</th>
                        <th className="px-2 py-2 text-right font-medium">Share</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.topProducts.map((row) => (
                        <tr key={row.variantId ?? row.label} className="border-b border-[var(--sera-line)]/60 last:border-0">
                          <td className="px-2 py-2.5 text-right tabular-nums text-[var(--sera-muted)]">{row.rank}</td>
                          <td className="px-2 py-2.5 font-medium text-[var(--sera-ink)]">{row.label}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{formatCount(row.units)}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{formatRM(row.orderValue)}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{formatPct(row.sharePct)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="space-y-2.5 md:hidden">
                  {report.topProducts.map((row) => (
                    <div key={row.variantId ?? row.label} className="rounded-xl border border-[var(--sera-line)] p-3">
                      <p className="mb-1.5 text-xs font-semibold text-[var(--sera-ink)]">
                        <span className="text-[var(--sera-muted)]">#{row.rank}</span> {row.label}
                      </p>
                      <MobileField label="Units">{formatCount(row.units)}</MobileField>
                      <MobileField label="Order Value">{formatRM(row.orderValue)}</MobileField>
                      <MobileField label="Share">{formatPct(row.sharePct)}</MobileField>
                    </div>
                  ))}
                </div>
              </>
            )}
          </SectionCard>
        </TabsContent>

        {/* ══ RELATIONSHIP & RISK ═══════════════════════════════════════ */}
        <TabsContent value="relationship" className="space-y-5">
          <SectionCard
            title="Relationship Summary"
            description={`${period.rangeLabel} compared with ${period.comparisonRangeLabel}`}
            icon={Users}
          >
            <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
              {report.relationship.rows.map((row) => (
                <SummaryTile
                  key={row.key}
                  label={row.label}
                  description={row.description}
                  count={row.count}
                  accent={
                    row.key === 'new' ? REPORTING_COLORS.success
                      : row.key === 'returning' ? REPORTING_COLORS.cyan
                        : row.key === 'inactive' ? REPORTING_COLORS.warning
                          : REPORTING_COLORS.danger
                  }
                />
              ))}
            </div>
          </SectionCard>

          <SectionCard
            title="Distributor Health / Risk"
            description={`At risk beyond ${report.meta.atRiskDays} days, or twice the distributor's own ordering cadence · dormant from ${report.meta.dormantDays} days`}
            icon={HeartPulse}
          >
            {report.health.rows.length === 0 ? (
              <EmptyNote>{emptyPeriodNote}</EmptyNote>
            ) : (
              <>
                <div className="hidden overflow-x-auto lg:block">
                  <table className="w-full min-w-[980px] text-sm">
                    <thead>
                      <tr className="border-b border-[var(--sera-line)] text-left text-xs text-[var(--sera-muted)]">
                        <th className="px-2 py-2 font-medium">Distributor</th>
                        <th className="px-2 py-2 text-right font-medium">Current Orders</th>
                        <th className="px-2 py-2 text-right font-medium">Previous Orders</th>
                        <th className="px-2 py-2 text-right font-medium">Current Value</th>
                        <th className="px-2 py-2 text-right font-medium">Previous Value</th>
                        <th className="px-2 py-2 text-right font-medium">Change</th>
                        <th className="px-2 py-2 text-right font-medium">Last Order</th>
                        <th className="px-2 py-2 text-right font-medium">Days Since</th>
                        <th className="px-2 py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.health.rows.map((row: DistributorRow) => (
                        <tr
                          key={row.distributorId}
                          onClick={() => openDrawer(row.distributorId)}
                          className="cursor-pointer border-b border-[var(--sera-line)]/60 last:border-0 hover:bg-[var(--sera-mist)]/50"
                        >
                          <td className="px-2 py-2.5 font-medium text-[var(--sera-ink)]">{row.name}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{formatCount(row.currentOrders)}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums text-[var(--sera-muted)]">{formatCount(row.previousOrders)}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{formatRM(row.currentValue)}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums text-[var(--sera-muted)]">{formatRM(row.previousValue)}</td>
                          <td className="px-2 py-2.5 text-right"><GrowthBadge value={row.growthPct} /></td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{formatDay(row.lastOrderAt)}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{row.daysSinceLastOrder === null ? '—' : formatCount(row.daysSinceLastOrder)}</td>
                          <td className="px-2 py-2.5"><HealthBadge health={row.health} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="space-y-2.5 lg:hidden">
                  {report.health.rows.map((row: DistributorRow) => (
                    <button
                      key={row.distributorId}
                      type="button"
                      onClick={() => openDrawer(row.distributorId)}
                      className="w-full rounded-xl border border-[var(--sera-line)] p-3 text-left transition-colors hover:border-[var(--sera-orange)]/40"
                    >
                      <div className="mb-2 flex items-start justify-between gap-2">
                        <span className="min-w-0 text-sm font-semibold text-[var(--sera-ink)]">{row.name}</span>
                        <HealthBadge health={row.health} />
                      </div>
                      <MobileField label="Current Value">{formatRM(row.currentValue)}</MobileField>
                      <MobileField label="Previous">{formatRMCompact(row.previousValue)}</MobileField>
                      <MobileField label="Change"><GrowthBadge value={row.growthPct} /></MobileField>
                      <MobileField label="Orders">{formatCount(row.currentOrders)} vs {formatCount(row.previousOrders)}</MobileField>
                      <MobileField label="Last Order">{formatDay(row.lastOrderAt)}</MobileField>
                    </button>
                  ))}
                </div>
              </>
            )}
          </SectionCard>

          <SectionCard
            title="Distributor Action Plan"
            description="Tap a card to filter the list to that action"
            icon={ClipboardList}
          >
            <div className="mb-4 grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
              {report.actionPlan.summary.map((card) => (
                <SummaryTile
                  key={card.key}
                  label={card.label}
                  description={card.description}
                  count={card.count}
                  accent={ACTION_ACCENT[card.key]}
                  active={actionFilter === card.key}
                  onClick={() => setActionFilter(actionFilter === card.key ? null : card.key)}
                />
              ))}
            </div>

            {actionFilter ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setActionFilter(null)}
                className="mb-2 h-8 text-xs text-[var(--sera-muted)]"
              >
                <X className="mr-1 h-3 w-3" /> Clear {ACTION_LABEL[actionFilter]} filter
              </Button>
            ) : null}

            {visibleActionRows.length === 0 ? (
              <EmptyNote>No management actions were raised for the selected report period.</EmptyNote>
            ) : (
              <>
                <div className="hidden overflow-x-auto lg:block">
                  <table className="w-full min-w-[1000px] text-sm">
                    <thead>
                      <tr className="border-b border-[var(--sera-line)] text-left text-xs text-[var(--sera-muted)]">
                        <th className="px-2 py-2 font-medium">Priority</th>
                        <th className="px-2 py-2 font-medium">Distributor</th>
                        <th className="px-2 py-2 text-right font-medium">Current Order Value</th>
                        <th className="px-2 py-2 text-right font-medium">Previous Order Value</th>
                        <th className="px-2 py-2 text-right font-medium">Change</th>
                        <th className="px-2 py-2 text-right font-medium">Orders</th>
                        <th className="px-2 py-2 text-right font-medium">Last Order</th>
                        <th className="px-2 py-2 font-medium">Status</th>
                        <th className="px-2 py-2 font-medium">Recommended Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleActionRows.map((row: DistributorRow) => (
                        <tr
                          key={row.distributorId}
                          onClick={() => openDrawer(row.distributorId)}
                          className="cursor-pointer border-b border-[var(--sera-line)]/60 last:border-0 hover:bg-[var(--sera-mist)]/50"
                        >
                          <td className="px-2 py-2.5">
                            <Badge variant="secondary" className={cn('px-1.5 py-0 text-[11px] font-semibold', PRIORITY_BADGE[row.actionPriority])}>
                              {row.actionPriority}
                            </Badge>
                          </td>
                          <td className="px-2 py-2.5 font-medium text-[var(--sera-ink)]">{row.name}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{formatRM(row.currentValue)}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums text-[var(--sera-muted)]">{formatRM(row.previousValue)}</td>
                          <td className="px-2 py-2.5 text-right"><GrowthBadge value={row.growthPct} /></td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{formatCount(row.currentOrders)}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{formatDay(row.lastOrderAt)}</td>
                          <td className="px-2 py-2.5"><HealthBadge health={row.health} /></td>
                          <td className="px-2 py-2.5">
                            <span className="text-xs font-semibold uppercase" style={{ color: ACTION_ACCENT[row.action as ActionKey] }}>
                              {ACTION_LABEL[row.action as ActionKey]}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="space-y-2.5 lg:hidden">
                  {visibleActionRows.map((row: DistributorRow) => (
                    <button
                      key={row.distributorId}
                      type="button"
                      onClick={() => openDrawer(row.distributorId)}
                      className="w-full rounded-xl border border-[var(--sera-line)] p-3 text-left transition-colors hover:border-[var(--sera-orange)]/40"
                    >
                      <div className="mb-2 flex items-start justify-between gap-2">
                        <span className="min-w-0 text-sm font-semibold text-[var(--sera-ink)]">{row.name}</span>
                        <HealthBadge health={row.health} />
                      </div>
                      <MobileField label="Current Value">{formatRM(row.currentValue)}</MobileField>
                      <MobileField label="Previous">{formatRMCompact(row.previousValue)}</MobileField>
                      <MobileField label="Change"><GrowthBadge value={row.growthPct} /></MobileField>
                      <MobileField label="Last Order">{formatDay(row.lastOrderAt)}</MobileField>
                      <div className="mt-2 flex items-center justify-between gap-2 border-t border-[var(--sera-line)] pt-2">
                        <span className="text-xs font-semibold uppercase" style={{ color: ACTION_ACCENT[row.action as ActionKey] }}>
                          {ACTION_LABEL[row.action as ActionKey]}
                        </span>
                        <Badge variant="secondary" className={cn('px-1.5 py-0 text-[11px] font-semibold', PRIORITY_BADGE[row.actionPriority])}>
                          {row.actionPriority}
                        </Badge>
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </SectionCard>

          <SectionCard
            title="Order Processing Health"
            description="Operational status mix — not a measure of the distributor relationship"
            icon={ClipboardList}
          >
            <div className="mb-4 grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
              <div className="rounded-xl border border-[var(--sera-line)] p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--sera-muted)]">Orders In Period</p>
                <p className="mt-1 text-2xl font-bold text-[var(--sera-ink)]">{formatCount(report.orderProcessing.total)}</p>
              </div>
              <div className="rounded-xl border border-[var(--sera-line)] p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--sera-muted)]">Approval Rate</p>
                <p className="mt-1 text-2xl font-bold text-[var(--sera-ink)]">{formatPct(report.orderProcessing.approvalRatePct)}</p>
                <p className="mt-0.5 text-[10px] text-[var(--sera-muted)]">{formatCount(report.orderProcessing.approvedOrders)} approved, packed, shipped or closed</p>
              </div>
              <div className="rounded-xl border border-[var(--sera-line)] p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--sera-muted)]">Completion Rate</p>
                <p className="mt-1 text-2xl font-bold text-[var(--sera-ink)]">{formatPct(report.orderProcessing.completionRatePct)}</p>
                <p className="mt-0.5 text-[10px] text-[var(--sera-muted)]">{formatCount(report.orderProcessing.completedOrders)} closed</p>
              </div>
              <div className="rounded-xl border border-[var(--sera-line)] p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--sera-muted)]">Cancellation Rate</p>
                <p className="mt-1 text-2xl font-bold text-[var(--sera-ink)]">{formatPct(report.orderProcessing.cancellationRatePct)}</p>
                <p className="mt-0.5 text-[10px] text-[var(--sera-muted)]">{formatCount(report.orderProcessing.cancelledOrders)} cancelled</p>
              </div>
            </div>

            {/* Values: Approved Sales are approved-stage orders only; submitted orders are pipeline; cancelled orders never count. */}
            <div className="mb-4 grid grid-cols-1 gap-2.5 sm:grid-cols-3 sm:gap-3">
              <div className="rounded-xl border border-[var(--sera-line)] p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--sera-muted)]">Approved Sales Value</p>
                <p className="mt-1 text-xl font-bold text-[var(--sera-ink)]">{formatRM(report.orderProcessing.approvedSalesValue)}</p>
                <p className="mt-0.5 text-[10px] text-[var(--sera-muted)]">{formatCount(report.orderProcessing.approvedOrders)} approved-stage orders</p>
              </div>
              <div className="rounded-xl border border-[var(--sera-line)] p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--sera-muted)]">Order Pipeline Value</p>
                <p className="mt-1 text-xl font-bold text-[var(--sera-ink)]">{formatRM(report.orderProcessing.pipelineValue)}</p>
                <p className="mt-0.5 text-[10px] text-[var(--sera-muted)]">{formatCount(report.orderProcessing.pipelineOrders)} submitted, awaiting approval</p>
              </div>
              <div className="rounded-xl border border-[var(--sera-line)] p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--sera-muted)]">Cancelled Orders Value</p>
                <p className="mt-1 text-xl font-bold text-[var(--sera-ink)]">{formatRM(report.orderProcessing.cancelledValue)}</p>
                <p className="mt-0.5 text-[10px] text-[var(--sera-muted)]">{formatCount(report.orderProcessing.cancelledOrders)} cancelled — not sales</p>
              </div>
            </div>

            {report.orderProcessing.statuses.length === 0 ? (
              <EmptyNote>No orders recorded for the selected period.</EmptyNote>
            ) : (
              <div className="space-y-2">
                {report.orderProcessing.statuses.map((row) => (
                  <div key={row.status} className="rounded-xl border border-[var(--sera-line)] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-[var(--sera-ink)]">{row.label}</span>
                      <span className="text-sm font-bold text-[var(--sera-ink)]">{formatCount(row.orders)}</span>
                    </div>
                    <div className="mt-1 flex items-baseline justify-between gap-2 text-[11px] text-[var(--sera-muted)]">
                      <span>{formatPct(row.sharePct)} of orders</span>
                      <span className="tabular-nums">{formatRM(row.orderValue)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </TabsContent>
      </Tabs>

      {/* ─── DISTRIBUTOR DETAIL DRAWER ─────────────────────────────────── */}
      <Sheet open={drawerId !== null} onOpenChange={(open) => { if (!open) setDrawerId(null) }}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle className="text-base">
              {drawerReport?.distributor.name ?? (drawerId ? distributorName(drawerId) : 'Distributor')}
            </SheetTitle>
            <SheetDescription className="text-xs">
              {period.label} · {period.rangeLabel}
              {period.isCurrentMonth ? ' (month to date)' : ''} · {report.status.label}
            </SheetDescription>
          </SheetHeader>

          {drawerLoading ? (
            <div className="py-10">
              <ReportingTabLoading label="Loading distributor detail" />
            </div>
          ) : !drawerReport ? (
            <EmptyNote>Unable to load this distributor&apos;s detail.</EmptyNote>
          ) : (
            <div className="mt-5 space-y-5">
              {/* Selected-period KPIs against the comparison period. */}
              <div className="grid grid-cols-2 gap-2.5">
                <div className="rounded-xl border border-[var(--sera-line)] p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--sera-muted)]">Order Value</p>
                  <p className="mt-1 text-xl font-bold text-[var(--sera-ink)]">{formatRMCompact(drawerReport.summary.orderValue)}</p>
                  <div className="mt-1"><GrowthBadge value={drawerReport.comparison.find((row) => row.key === 'orderValue')?.changePct ?? null} /></div>
                </div>
                <div className="rounded-xl border border-[var(--sera-line)] p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--sera-muted)]">Orders</p>
                  <p className="mt-1 text-xl font-bold text-[var(--sera-ink)]">{formatCount(drawerReport.summary.totalOrders)}</p>
                  <div className="mt-1"><GrowthBadge value={drawerReport.comparison.find((row) => row.key === 'totalOrders')?.changePct ?? null} /></div>
                </div>
                <div className="rounded-xl border border-[var(--sera-line)] p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--sera-muted)]">Avg Order Value</p>
                  <p className="mt-1 text-xl font-bold text-[var(--sera-ink)]">
                    {drawerReport.summary.avgOrderValue === null ? '—' : formatRMCompact(drawerReport.summary.avgOrderValue)}
                  </p>
                </div>
                <div className="rounded-xl border border-[var(--sera-line)] p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--sera-muted)]">Relationship</p>
                  <div className="mt-2">
                    {drawerReport.health.rows[0]
                      ? <HealthBadge health={drawerReport.health.rows[0].health} />
                      : <span className="text-xs text-[var(--sera-muted)]">No activity</span>}
                  </div>
                  {drawerReport.health.rows[0] ? (
                    <p className="mt-1.5 text-[10px] text-[var(--sera-muted)]">
                      Last order {formatDay(drawerReport.health.rows[0].lastOrderAt)}
                      {drawerReport.health.rows[0].daysSinceLastOrder === null
                        ? ''
                        : ` · ${drawerReport.health.rows[0].daysSinceLastOrder} days ago`}
                    </p>
                  ) : null}
                </div>
              </div>

              {/* Daily trend for the SELECTED MONTH only — this report carries
                  no twelve-month chart anywhere. */}
              <div>
                <p className="mb-2 text-xs font-semibold text-[var(--sera-ink)]">Daily Sell-In — {period.label}</p>
                {drawerReport.summary.totalOrders === 0 ? (
                  <EmptyNote>{emptyPeriodNote}</EmptyNote>
                ) : (
                  <div className="h-[180px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart data={drawerReport.dailyTrend} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke={chartGrid} vertical={false} />
                        <XAxis dataKey="shortLabel" tick={{ fontSize: 10, fill: chartTick }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                        <YAxis tick={{ fontSize: 10, fill: chartTick }} tickLine={false} axisLine={false} width={54} tickFormatter={(value: number) => formatRMCompact(value)} />
                        <Tooltip
                          contentStyle={tooltipStyle}
                          labelFormatter={(_label, payload) => payload?.[0]?.payload?.label ?? ''}
                          formatter={(value: any) => formatRM(Number(value))}
                        />
                        <Bar dataKey="orderValue" name="Order Value" fill={REPORTING_COLORS.primary} radius={[3, 3, 0, 0]} maxBarSize={18} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>

              <div>
                <p className="mb-2 text-xs font-semibold text-[var(--sera-ink)]">Top Products</p>
                {drawerReport.topProducts.length === 0 ? (
                  <EmptyNote>No products ordered in this period.</EmptyNote>
                ) : (
                  <div className="space-y-1.5">
                    {drawerReport.topProducts.map((row) => (
                      <div key={row.variantId ?? row.label} className="flex items-baseline justify-between gap-3 rounded-lg border border-[var(--sera-line)] px-3 py-2">
                        <span className="min-w-0 truncate text-xs text-[var(--sera-ink)]">{row.label}</span>
                        <span className="shrink-0 text-xs tabular-nums text-[var(--sera-muted)]">
                          {formatCount(row.units)} · {formatRMCompact(row.orderValue)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <p className="mb-2 text-xs font-semibold text-[var(--sera-ink)]">Recent Orders</p>
                {drawerReport.recentOrders.length === 0 ? (
                  <EmptyNote>No orders in this period.</EmptyNote>
                ) : (
                  <div className="space-y-1.5">
                    {drawerReport.recentOrders.map((order) => (
                      <div key={order.orderId} className="flex items-baseline justify-between gap-3 rounded-lg border border-[var(--sera-line)] px-3 py-2">
                        <span className="min-w-0 truncate text-xs text-[var(--sera-ink)]">
                          {order.orderNo || order.orderId}
                          <span className="ml-2 text-[var(--sera-muted)]">{formatDay(order.orderDate || order.createdAt)}</span>
                        </span>
                        <span className="shrink-0 text-xs tabular-nums text-[var(--sera-muted)]">
                          {statusLabel(order.status)} · {formatRMCompact(order.orderValue)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {drawerReport.health.rows[0]?.action ? (
                <div className="rounded-xl border border-[var(--sera-line)] bg-[var(--sera-mist)]/40 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--sera-muted)]">Recommended Action</p>
                  <p className="mt-1 text-sm font-semibold" style={{ color: ACTION_ACCENT[drawerReport.health.rows[0].action as ActionKey] }}>
                    {ACTION_LABEL[drawerReport.health.rows[0].action as ActionKey]}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--sera-muted)]">{drawerReport.health.rows[0].recommendation}</p>
                </div>
              ) : null}
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* ─── METRIC DRILL-DOWN DRAWER ──────────────────────────────────── */}
      <Sheet open={metricOpen !== null} onOpenChange={(open) => { if (!open) { setMetricOpen(null); metricRequestId.current++ } }}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-3xl">
          {metricOpen ? (
            <MetricDrilldownPanel
              metric={metricOpen}
              data={metricData}
              loading={metricLoading}
              error={metricError}
              periodLabel={period.label}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  )
}

const INSIGHT_DRILLDOWN: Partial<Record<string, DrilldownMetric>> = {
  new: 'new',
  inactive: 'inactive',
  returning: 'returning',
}

const METRIC_TITLE: Record<DrilldownMetric, string> = {
  total_orders: 'Total Orders',
  active: 'Active Distributors',
  new: 'New Distributors',
  inactive: 'Inactive Distributors',
  returning: 'Returning Distributors',
}

const DRILLDOWN_PAGE_SIZE = 25

function OrderRefCell({ value }: { value: OrderRef | null }) {
  if (!value) return <span className="text-[var(--sera-muted)]">—</span>
  return (
    <span className="whitespace-nowrap">
      {formatDay(value.date || value.at)}
      <span className="block text-[11px] text-[var(--sera-muted)]">{value.orderNo}</span>
    </span>
  )
}

function DistributorCell({ name, code }: { name: string; code: string | null }) {
  return (
    <span>
      <span className="font-medium text-[var(--sera-ink)]">{name}</span>
      {code ? <span className="block text-[11px] text-[var(--sera-muted)]">{code}</span> : null}
    </span>
  )
}

function MetricDrilldownPanel({ metric, data, loading, error, periodLabel }: {
  metric: DrilldownMetric
  data: DistributorDrilldown | null
  loading: boolean
  error: string | null
  periodLabel: string
}) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  useEffect(() => { setQuery(''); setPage(0) }, [metric, data])

  const isOrders = metric === 'total_orders'
  const allRows = data ? (isOrders ? data.orders : data.distributors) : []
  const needle = query.trim().toLowerCase()
  const rows = needle
    ? allRows.filter((row: any) => [row.name, row.code, row.orderNo, row.distributorName, row.distributorCode]
      .some((field) => typeof field === 'string' && field.toLowerCase().includes(needle)))
    : allRows
  const pageCount = Math.max(1, Math.ceil(rows.length / DRILLDOWN_PAGE_SIZE))
  const pageRows = rows.slice(page * DRILLDOWN_PAGE_SIZE, (page + 1) * DRILLDOWN_PAGE_SIZE)
  const th = 'px-2 py-2 font-medium'
  const td = 'px-2 py-2.5 align-top'
  const num = 'px-2 py-2.5 text-right tabular-nums align-top'

  return (
    <div data-testid="metric-drilldown">
      <SheetHeader>
        <SheetTitle className="text-base">{METRIC_TITLE[metric]} — {data?.period.label ?? periodLabel}</SheetTitle>
        <SheetDescription className="text-xs">
          {data
            ? `${data.period.rangeLabel}${data.period.isCurrentMonth ? ' (month to date)' : ''} · ${data.scope.distributorName} · ${data.scope.statusLabel}`
            : 'Loading…'}
        </SheetDescription>
      </SheetHeader>

      {loading ? (
        <div className="py-10"><ReportingTabLoading label="Loading details" /></div>
      ) : error ? (
        <EmptyNote>{error}</EmptyNote>
      ) : !data ? null : (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap gap-2" data-testid="drilldown-summary">
            {!isOrders ? (
              <Badge variant="secondary" className="px-2 py-1 text-xs">{METRIC_TITLE[metric]}: {formatCount(data.headline.count)}</Badge>
            ) : null}
            {isOrders || metric === 'active' ? (
              <>
                <Badge variant="secondary" className="px-2 py-1 text-xs">Total Orders: {formatCount(data.headline.totalOrders)}</Badge>
                <Badge variant="secondary" className="px-2 py-1 text-xs">Order Value: {formatRMCompact(data.headline.orderValue)}</Badge>
              </>
            ) : null}
          </div>
          <p className="text-xs text-[var(--sera-muted)]">{data.definition}</p>

          {!data.reconciled ? (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              These {isOrders ? 'orders' : 'rows'} ({formatCount(allRows.length)}) do not reconcile with the dashboard figure ({formatCount(data.headline.count)}). Please report this.
            </div>
          ) : null}

          {allRows.length === 0 ? (
            <EmptyNote>{data.emptyMessage}</EmptyNote>
          ) : (
            <>
              {allRows.length > 10 ? (
                <div className="relative w-full sm:w-[260px]">
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--sera-muted)]" />
                  <Input
                    value={query}
                    onChange={(event) => { setQuery(event.target.value); setPage(0) }}
                    placeholder={isOrders ? 'Search order or distributor' : 'Search distributor'}
                    aria-label="Search drill-down rows"
                    className="h-9 pl-8 text-sm"
                  />
                </div>
              ) : null}

              <div className="overflow-x-auto rounded-lg border border-[var(--sera-line)]">
                <table className="w-full min-w-[640px] text-sm" data-testid="drilldown-table">
                  <thead>
                    <tr className="border-b border-[var(--sera-line)] text-left text-xs text-[var(--sera-muted)]">
                      {isOrders ? (
                        <>
                          <th className={th}>Order Number</th>
                          <th className={th}>Order Date</th>
                          <th className={th}>Distributor</th>
                          <th className={th}>Status</th>
                          <th className={cn(th, 'text-right')}>Lines</th>
                          <th className={cn(th, 'text-right')}>Order Value</th>
                          <th className={th}>Created By</th>
                          <th className={th}>Last Updated</th>
                        </>
                      ) : metric === 'active' ? (
                        <>
                          <th className={th}>Distributor</th>
                          <th className={cn(th, 'text-right')}>Orders</th>
                          <th className={cn(th, 'text-right')}>Order Value</th>
                          <th className={cn(th, 'text-right')}>Avg Order Value</th>
                          <th className={th}>Last Order</th>
                          <th className={cn(th, 'text-right')}>Days Since Last Order</th>
                          <th className={cn(th, 'text-right')}>Previous Orders</th>
                          <th className={cn(th, 'text-right')}>Previous Value</th>
                        </>
                      ) : metric === 'new' ? (
                        <>
                          <th className={th}>Distributor</th>
                          <th className={th}>First Eligible Order</th>
                          <th className={cn(th, 'text-right')}>Orders</th>
                          <th className={cn(th, 'text-right')}>Order Value</th>
                          <th className={cn(th, 'text-right')}>Avg Order Value</th>
                        </>
                      ) : metric === 'inactive' ? (
                        <>
                          <th className={th}>Distributor</th>
                          <th className={cn(th, 'text-right')}>Comparison Orders</th>
                          <th className={cn(th, 'text-right')}>Comparison Value</th>
                          <th className={th}>Last Order</th>
                          <th className={cn(th, 'text-right')}>Days Since Last Order</th>
                          <th className={cn(th, 'text-right')}>Current Orders</th>
                        </>
                      ) : (
                        <>
                          <th className={th}>Distributor</th>
                          <th className={cn(th, 'text-right')}>Orders</th>
                          <th className={cn(th, 'text-right')}>Order Value</th>
                          <th className={th}>Previous Last Order</th>
                          <th className={th}>First Order This Period</th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {isOrders
                      ? (pageRows as DistributorDrilldown['orders']).map((order) => {
                        const path = supplyChainOrderPath('view-order', order.orderId)
                        return (
                          <tr key={order.orderId} className="border-b border-[var(--sera-line)]/60 last:border-0">
                            <td className={cn(td, 'font-medium')}>
                              {path
                                ? <a href={`/supply-chain/${path}`} className="text-[var(--sera-orange-deep)] hover:underline">{order.orderNo}</a>
                                : order.orderNo}
                            </td>
                            <td className={cn(td, 'whitespace-nowrap')}>{formatDay(order.orderDate || order.createdAt)}</td>
                            <td className={td}><DistributorCell name={order.distributorName} code={order.distributorCode} /></td>
                            <td className={td}>{statusLabel(order.status)}</td>
                            <td className={num}>{formatCount(order.lineCount)}</td>
                            <td className={num}>{formatRM(order.orderValue)}</td>
                            <td className={td}>{order.createdByName || '—'}</td>
                            <td className={cn(td, 'whitespace-nowrap')}>{formatDay(order.updatedAt)}</td>
                          </tr>
                        )
                      })
                      : (pageRows as DistributorDrilldown['distributors']).map((row) => (
                        <tr key={row.distributorId} className="border-b border-[var(--sera-line)]/60 last:border-0">
                          <td className={td}><DistributorCell name={row.name} code={row.code} /></td>
                          {metric === 'active' ? (
                            <>
                              <td className={num}>{formatCount(row.currentOrders)}</td>
                              <td className={num}>{formatRM(row.currentValue)}</td>
                              <td className={num}>{formatRM(row.aov)}</td>
                              <td className={td}><OrderRefCell value={row.lastOrder} /></td>
                              <td className={num}>{formatCount(row.daysSinceLastOrder)}</td>
                              <td className={num}>{formatCount(row.previousOrders)}</td>
                              <td className={num}>{formatRM(row.previousValue)}</td>
                            </>
                          ) : metric === 'new' ? (
                            <>
                              <td className={td}><OrderRefCell value={row.firstOrder} /></td>
                              <td className={num}>{formatCount(row.currentOrders)}</td>
                              <td className={num}>{formatRM(row.currentValue)}</td>
                              <td className={num}>{formatRM(row.aov)}</td>
                            </>
                          ) : metric === 'inactive' ? (
                            <>
                              <td className={num}>{formatCount(row.previousOrders)}</td>
                              <td className={num}>{formatRM(row.previousValue)}</td>
                              <td className={td}><OrderRefCell value={row.lastOrder} /></td>
                              <td className={num}>{formatCount(row.daysSinceLastOrder)}</td>
                              <td className={num}>{formatCount(row.currentOrders)}</td>
                            </>
                          ) : (
                            <>
                              <td className={num}>{formatCount(row.currentOrders)}</td>
                              <td className={num}>{formatRM(row.currentValue)}</td>
                              <td className={td}><OrderRefCell value={row.lastOrderBeforePeriod} /></td>
                              <td className={td}><OrderRefCell value={row.currentFirstOrder} /></td>
                            </>
                          )}
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between text-xs text-[var(--sera-muted)]">
                <span data-testid="drilldown-count">
                  {needle ? `${formatCount(rows.length)} of ` : ''}{formatCount(allRows.length)} {isOrders ? 'orders' : 'distributors'}
                </span>
                {pageCount > 1 ? (
                  <span className="flex items-center gap-2">
                    <Button variant="outline" size="sm" className="h-7 px-2" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous page">
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </Button>
                    Page {page + 1} of {pageCount}
                    <Button variant="outline" size="sm" className="h-7 px-2" disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)} aria-label="Next page">
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                ) : null}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
