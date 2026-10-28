'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3, Boxes,
  ArrowLeft, ChevronRight, Crown, Download, Layers, Loader2,
  Megaphone, Minus, Package, PieChart as PieIcon, RefreshCw, Rocket, Search,
  ShieldAlert, ShoppingCart, Tag, Target, TrendingUp, Warehouse,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import {
  ACTION_RECOMMENDATION,
  ALL_CATEGORIES,
  ALL_CATEGORIES_LABEL,
  CONCENTRATION_THRESHOLD_PCT,
  NO_ACTION_RECOMMENDATION,
  currentReportingMonthKey,
  type ActionKey,
  type ContributionBandKey,
  type AttentionRow,
  type ProductAnalyticsReport,
  type ProductRow,
  type StrategyKey,
  type TopProductRow,
} from '@/lib/reporting/product-analytics'
import type { ReportingCategory } from '@/lib/reporting/product-analytics-source'
import type { ReportingPeriod } from '@/lib/reporting/reporting-period'
import ExecutiveKpiValue from './ExecutiveKpiValue'
import ReportingMonthSelector from './ReportingMonthSelector'
import { REPORTING_COLORS, REPORTING_PANEL_CLASS, ReportingTabLoading } from './reportingChrome'

interface ProductsTabProps {
  userProfile: any
  chartGridColor: string
  chartTickColor: string
  isDark: boolean
  /** Dashboard-level Reporting Month; the tab keeps its own when rendered alone. */
  month?: string
  onMonthChange?: (month: string) => void
}

interface ReportResponse {
  report: ProductAnalyticsReport
  meta: { source: 'rpc' | 'fallback'; degraded: boolean; notice: string | null; generatedAt: string }
}

const STRATEGY_ICON: Record<StrategyKey, typeof Rocket> = {
  rising: Rocket,
  at_risk: ShieldAlert,
  promo: Megaphone,
  top: Crown,
}

const STRATEGY_ACCENT: Record<StrategyKey, string> = {
  rising: REPORTING_COLORS.success,
  at_risk: REPORTING_COLORS.danger,
  promo: REPORTING_COLORS.warning,
  top: REPORTING_COLORS.primary,
}

const ACTION_ACCENT: Record<ActionKey, string> = {
  replenish: REPORTING_COLORS.primary,
  maintain: REPORTING_COLORS.success,
  promote: REPORTING_COLORS.warning,
  review: REPORTING_COLORS.danger,
}

const STOCK_BADGE: Record<string, string> = {
  low: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  healthy: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  excess: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  dead: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  none: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
}

/** Performance status wording for the contribution SKU detail. */
const DEMAND_STATUS_LABEL: Record<string, string> = {
  growing: 'Growing',
  stable: 'Stable',
  declining: 'Declining',
  new: 'New Activity',
  none: 'No Previous Baseline',
}

const STOCK_LABEL: Record<string, string> = {
  low: 'Low', healthy: 'Healthy', excess: 'Excess', dead: 'Dead', none: 'No stock',
}

const ATTENTION_BADGE: Record<AttentionRow['status'], string> = {
  'No Orders': 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  Declining: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  Slow: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  Watch: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
}

const PRIORITY_BADGE: Record<string, string> = {
  HIGH: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  MEDIUM: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  NORMAL: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
}

// ── Formatting ─────────────────────────────────────────────────────────────

function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-MY')
}

function formatRM(value: number | null): string {
  if (value === null) return '—'
  return `RM ${value.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Compact axis / tooltip form — "RM 82.3K". */
function formatRMCompact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `RM ${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `RM ${(value / 1_000).toFixed(1)}K`
  return `RM ${value.toFixed(0)}`
}

function formatDay(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-MY', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur',
  }).format(date)
}

function formatTimestamp(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-MY', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'Asia/Kuala_Lumpur',
  }).format(date)
}

/**
 * Growth pill. A `null` movement means the comparison window had no baseline —
 * shown as "new demand", never as a misleading 0% or an Infinity.
 */
function DeltaPill({ value, suffix = '%', nullLabel = 'new demand' }: {
  value: number | null
  suffix?: string
  nullLabel?: string
}) {
  if (value === null) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-[var(--sera-muted)]">
        <Minus className="h-3 w-3" /> {nullLabel}
      </span>
    )
  }
  const up = value >= 0
  const Icon = up ? ArrowUpRight : ArrowDownRight
  return (
    <Badge
      variant="secondary"
      className={cn(
        'gap-0.5 px-1.5 py-0 text-[11px] font-semibold',
        up
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
          : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
      )}
    >
      <Icon className="h-3 w-3" />
      {Math.abs(value).toFixed(1)}{suffix}
    </Badge>
  )
}

function KpiCard({ label, icon: Icon, accent, value, delta, caption }: {
  label: string
  icon: typeof Package
  accent: string
  value: string
  delta: React.ReactNode
  caption?: string | null
}) {
  return (
    <Card className={cn(REPORTING_PANEL_CLASS, 'transition-colors hover:border-[var(--sera-orange)]/35')}>
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
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">{delta}</div>
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

/** Clickable summary tile used by Strategy Insights and the Action Plan. */
function SummaryTile({ label, description, count, accent, icon: Icon, active, onClick }: {
  label: string
  description?: string
  count: number
  accent: string
  icon: typeof Package
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full flex-col items-start gap-1 rounded-xl border p-3 text-left transition-all',
        'hover:-translate-y-0.5 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)]/40',
        active ? 'border-[var(--sera-orange)] ring-1 ring-[var(--sera-orange)]/30' : 'border-[var(--sera-line)]',
      )}
      style={{ backgroundColor: `${accent}0f` }}
    >
      <span className="flex items-center gap-1.5 text-[11px] font-semibold sm:text-xs" style={{ color: accent }}>
        <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
        <span className="truncate">{label}</span>
      </span>
      <span className="text-2xl font-bold text-[var(--sera-ink)] sm:text-3xl">{formatCount(count)}</span>
      {description ? (
        <span className="line-clamp-2 text-[10px] leading-tight text-[var(--sera-muted)] sm:text-[11px]">{description}</span>
      ) : null}
    </button>
  )
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="py-8 text-center text-sm text-[var(--sera-muted)]">{children}</p>
}

// ── Main component ─────────────────────────────────────────────────────────

export default function ProductsTab({ userProfile, chartGridColor, chartTickColor, month: monthProp, onMonthChange }: ProductsTabProps) {
  const [localMonth, setLocalMonth] = useState<string>(() => currentReportingMonthKey())
  const month = monthProp ?? localMonth
  const setMonth = onMonthChange ?? setLocalMonth
  // The report opens consolidated; the user is never made to pick a category first.
  const [categoryId, setCategoryId] = useState<string>(ALL_CATEGORIES)
  const [availableMonths, setAvailableMonths] = useState<string[]>([])
  const [categories, setCategories] = useState<ReportingCategory[]>([])
  const [response, setResponse] = useState<ReportResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloading, setReloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)

  // Sub-tab selection is deliberately separate from `month`: switching between
  // Overview / Performance / Inventory & Actions must never reset the report.
  const [subTab, setSubTab] = useState('overview')
  const [topSort, setTopSort] = useState<'units' | 'value'>('units')
  const [selectedInsight, setSelectedInsight] = useState<StrategyKey | null>(null)
  const [insightSearch, setInsightSearch] = useState('')
  const [actionFilter, setActionFilter] = useState<ActionKey | null>(null)
  // Contribution drill-down. Held separately from the report filters so opening
  // or closing it never disturbs the selected month, category or sub-tab.
  const [contributionBand, setContributionBand] = useState<ContributionBandKey | null>(null)
  const [contributionSku, setContributionSku] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)

  // Months and categories arrive together in ONE request, discovered
  // independently of the report so the default view starts loading immediately
  // with no "select a month first" step.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/reporting/product-analytics/filters', { cache: 'no-store' })
        const payload = await res.json()
        if (cancelled || !res.ok) return
        setAvailableMonths(((payload.months || []) as ReportingPeriod[]).map((period) => period.key))
        setCategories((payload.categories || []) as ReportingCategory[])
      } catch {
        // Not fatal: the current month and All Categories are always offered.
      }
    })()
    return () => { cancelled = true }
  }, [])

  const loadReport = useCallback(async (targetMonth: string, targetCategory: string, isInitial: boolean) => {
    const id = ++requestId.current
    if (isInitial) setLoading(true)
    else setReloading(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/reporting/product-analytics?month=${targetMonth}&categoryId=${encodeURIComponent(targetCategory)}`,
        { cache: 'no-store' },
      )
      const payload = await res.json()
      // A slower earlier request must never overwrite a newer month/category
      // report — changing both quickly stays consistent.
      if (id !== requestId.current) return
      if (!res.ok) throw new Error(payload.error || 'Unable to load product analytics')
      setResponse(payload as ReportResponse)
    } catch (err: any) {
      if (id !== requestId.current) return
      setError(err?.message || 'Unable to load product analytics')
    } finally {
      if (id === requestId.current) {
        setLoading(false)
        setReloading(false)
      }
    }
  }, [])

  // Selecting a month OR a category reloads automatically — no Apply step.
  useEffect(() => {
    void loadReport(month, categoryId, response === null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, categoryId, loadReport])


  const report = response?.report ?? null
  const meta = response?.meta ?? null

  /**
   * The PDF is built from the report DTO already in state, so it always carries
   * every section — Overview, Performance and Inventory & Actions — regardless
   * of which sub-tab is on screen, and its numbers are the on-screen numbers.
   */
  const handleDownloadPdf = useCallback(async () => {
    if (!report) return
    setDownloading(true)
    try {
      const { buildProductAnalyticsPdf } = await import('@/lib/reporting/product-analytics-pdf')
      const pdf = await buildProductAnalyticsPdf(report, {
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

  const activeInsight = useMemo(
    () => report?.strategyInsights.find((card) => card.key === selectedInsight) ?? null,
    [report, selectedInsight],
  )

  const filteredInsightRows = useMemo(() => {
    if (!activeInsight) return []
    const query = insightSearch.trim().toLowerCase()
    if (!query) return activeInsight.rows
    return activeInsight.rows.filter((row) =>
      `${row.label} ${row.recommendation} ${row.demandTrend}`.toLowerCase().includes(query))
  }, [activeInsight, insightSearch])

  const visibleActionRows = useMemo(() => {
    if (!report) return []
    if (!actionFilter) return report.managementActions.rows
    return report.managementActions.rows.filter((row) => row.action === actionFilter)
  }, [report, actionFilter])

  const topRows: TopProductRow[] = useMemo(() => {
    if (!report) return []
    return topSort === 'units' ? report.topProducts.byUnits : report.topProducts.byOrderValue
  }, [report, topSort])

  const activeBand = useMemo(
    () => report?.productContribution.bands.find((band) => band.key === contributionBand) ?? null,
    [report, contributionBand],
  )

  /** Rows of the open band — a slice of the report DTO, never a new request. */
  const bandRows = useMemo(
    () => (contributionBand
      ? (report?.productContribution.rows ?? []).filter((row) => row.band === contributionBand)
      : []),
    [report, contributionBand],
  )

  const activeSkuRow = useMemo(
    () => bandRows.find((row) => row.variantId === contributionSku) ?? null,
    [bandRows, contributionSku],
  )

  const openContributionBand = useCallback((band: ContributionBandKey, skus: number) => {
    // An empty band opens nothing; there is no placeholder content to show.
    if (skus <= 0) return
    setContributionSku(null)
    setContributionBand(band)
  }, [])

  const contributionSlices = useMemo(() => {
    if (!report) return []
    const palette = [REPORTING_COLORS.primary, REPORTING_COLORS.warning, REPORTING_COLORS.slate]
    return report.productContribution.bands
      .filter((band) => band.orderValue > 0)
      .map((band, index) => ({ name: band.label, value: band.orderValue, fill: palette[index % palette.length] }))
  }, [report])

  // ── Header ───────────────────────────────────────────────────────────────
  const controls = (
    <div className="flex w-full flex-col gap-3 lg:w-auto lg:flex-row lg:items-end">
      <ReportingMonthSelector
        id="product-analytics-month"
        month={month}
        onMonthChange={setMonth}
        availableMonths={availableMonths}
        caption={report ? (
          <>
            <span className="font-medium text-[var(--sera-ink)]">{report.period.rangeLabel}</span>
            {report.period.isCurrentMonth ? ' (month to date)' : ''}
            <br className="sm:hidden" />
            <span className="sm:ml-1">vs {report.period.comparisonRangeLabel}</span>
          </>
        ) : null}
      />

      {/* Category is a dropdown, not another tab row: it scales as management
          adds categories and keeps the mobile header to one column. */}
      <div className="space-y-1.5">
        <label htmlFor="product-analytics-category" className="text-xs font-medium text-[var(--sera-muted)]">
          Product Category
        </label>
        <Select value={categoryId} onValueChange={setCategoryId}>
          <SelectTrigger
            id="product-analytics-category"
            className="h-10 w-full border-[var(--sera-line)] bg-white text-sm lg:h-9 lg:w-[200px]"
          >
            <Tag className="mr-2 h-3.5 w-3.5 shrink-0 text-[var(--sera-muted)]" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_CATEGORIES}>{ALL_CATEGORIES_LABEL}</SelectItem>
            {categories.map((option) => (
              <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          className="h-10 flex-1 gap-2 border-[var(--sera-line)] lg:h-9 lg:flex-none"
          onClick={() => loadReport(month, categoryId, false)}
          disabled={loading || reloading}
        >
          <RefreshCw className={cn('h-4 w-4', reloading && 'animate-spin')} />
          Refresh
        </Button>
        <Button
          variant="outline"
          className="h-10 flex-1 gap-2 border-[var(--sera-line)] lg:h-9 lg:flex-none"
          onClick={handleDownloadPdf}
          disabled={!report || downloading || loading}
          title={report ? 'Download the complete product management report' : 'Report not loaded yet'}
        >
          {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          <span className="whitespace-nowrap">Download PDF</span>
        </Button>
      </div>
    </div>
  )

  const header = (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--sera-ink)]">
          <Package className="h-5 w-5 text-[var(--sera-orange)]" strokeWidth={1.75} />
          Product Analytics
        </h2>
        <p className="mt-0.5 text-sm text-[var(--sera-muted)]">Monthly product management report</p>
      </div>
      {controls}
    </div>
  )

  if (loading && !report) {
    return (
      <div className="space-y-6">
        {header}
        <ReportingTabLoading label="Loading product report" />
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
  const skuDelta = comparison.skusOrdered.current - comparison.skusOrdered.previous

  // ── Shared row renderers ─────────────────────────────────────────────────
  /**
   * Demand movement, never an Infinity. A null growth means the comparison
   * window carried no baseline, which reads as "New Activity" when the SKU sold
   * this period and "No Previous Baseline" when neither period had demand.
   */
  const growthCell = (row: { growthPct: number | null; currentUnits: number }) => (
    <span className={cn(
      'font-medium',
      row.growthPct === null
        ? 'text-[var(--sera-muted)]'
        : row.growthPct >= 0 ? 'text-emerald-600' : 'text-red-600',
    )}>
      {row.growthPct === null
        ? (row.currentUnits > 0 ? 'New Activity' : 'No Previous Baseline')
        : `${row.growthPct >= 0 ? '+' : ''}${row.growthPct.toFixed(1)}%`}
    </span>
  )

  const stockBadge = (row: { stockStatus: ProductRow['stockStatus'] }) => (
    <Badge variant="secondary" className={cn('px-1.5 py-0 text-[11px] font-medium', STOCK_BADGE[row.stockStatus])}>
      {STOCK_LABEL[row.stockStatus]}
    </Badge>
  )

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
            { value: 'inventory', label: 'Inventory & Actions', icon: Warehouse },
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

        {/* ══ OVERVIEW ═══════════════════════════════════════════════════ */}
        <TabsContent value="overview" className="space-y-5 animate-in fade-in-50 duration-300">
          <Card className={REPORTING_PANEL_CLASS}>
            <CardHeader className="flex flex-col gap-2 space-y-0 pb-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
              <div>
                <CardTitle className="flex items-center gap-2 text-sm text-[var(--sera-ink)] sm:text-base">
                  <BarChart3 className="h-4 w-4 text-[var(--sera-orange)]" strokeWidth={1.75} />
                  Monthly Summary
                </CardTitle>
                <CardDescription className="mt-0.5 text-xs sm:text-sm">
                  {period.rangeLabel} vs {period.comparisonRangeLabel}
                </CardDescription>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-[var(--sera-muted)]">
                {reloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                <span>Data updated: {formatTimestamp(meta?.generatedAt ?? null)}</span>
              </div>
            </CardHeader>
            <CardContent className="px-3 sm:px-6">
              {/* 2 × 2 on mobile, one row on desktop. */}
              <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
                <KpiCard
                  label="Units Ordered"
                  icon={ShoppingCart}
                  accent={REPORTING_COLORS.primary}
                  value={formatCount(summary.unitsOrdered)}
                  delta={<DeltaPill value={comparison.unitsOrdered.changePct} nullLabel="no baseline" />}
                  caption={`avg ${formatCount(summary.avgUnitsPerDay)}/day`}
                />
                <KpiCard
                  label="Order Value"
                  icon={TrendingUp}
                  accent={REPORTING_COLORS.success}
                  value={formatRMCompact(summary.orderValue)}
                  delta={<DeltaPill value={comparison.orderValue.changePct} nullLabel="no baseline" />}
                  caption={`avg ${formatRMCompact(summary.avgValuePerDay)}/day`}
                />
                <KpiCard
                  label="SKUs Ordered"
                  icon={Layers}
                  accent={REPORTING_COLORS.violet}
                  value={formatCount(summary.skusOrdered)}
                  delta={
                    <Badge
                      variant="secondary"
                      className={cn(
                        'px-1.5 py-0 text-[11px] font-semibold',
                        skuDelta >= 0
                          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                          : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
                      )}
                    >
                      {skuDelta >= 0 ? '+' : ''}{skuDelta} vs comparison
                    </Badge>
                  }
                  caption={`out of ${formatCount(summary.activeSkus)} active SKUs`}
                />
                <KpiCard
                  label="Avg Value / Unit"
                  icon={Target}
                  accent={REPORTING_COLORS.cyan}
                  value={summary.avgValuePerUnit === null ? '—' : formatRM(summary.avgValuePerUnit)}
                  delta={<DeltaPill value={comparison.avgValuePerUnit.changePct} nullLabel="no baseline" />}
                  caption={
                    comparison.avgValuePerUnit.previous === null
                      ? 'no comparison baseline'
                      : `comparison ${formatRM(comparison.avgValuePerUnit.previous)}`
                  }
                />
              </div>
            </CardContent>
          </Card>

          <SectionCard
            icon={Rocket}
            title="Product Strategy Insights"
            description={`Selected period vs comparison period — tap a card for the full list`}
          >
            {/* 2 × 2 on mobile, one row on desktop. */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {report.strategyInsights.map((card) => (
                <SummaryTile
                  key={card.key}
                  label={card.title}
                  description={card.description}
                  count={card.count}
                  accent={STRATEGY_ACCENT[card.key]}
                  icon={STRATEGY_ICON[card.key]}
                  active={selectedInsight === card.key}
                  onClick={() => { setInsightSearch(''); setSelectedInsight(card.key) }}
                />
              ))}
            </div>
          </SectionCard>

          <SectionCard
            icon={BarChart3}
            title="This Period vs Previous Period"
            description={`${period.rangeLabel} vs ${period.comparisonRangeLabel}`}
          >
            <div className="-mx-3 overflow-x-auto sm:mx-0">
              <table className="w-full min-w-[420px] text-sm">
                <thead>
                  <tr className="border-b border-[var(--sera-line)] text-left text-xs uppercase tracking-wide text-[var(--sera-muted)]">
                    <th className="px-3 py-2 font-medium">Metric</th>
                    <th className="px-3 py-2 text-right font-medium">Current</th>
                    <th className="px-3 py-2 text-right font-medium">Previous</th>
                    <th className="px-3 py-2 text-right font-medium">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    {
                      label: 'Units Ordered',
                      current: formatCount(summary.unitsOrdered),
                      previous: formatCount(comparison.unitsOrdered.previous),
                      change: comparison.unitsOrdered.changePct,
                      raw: null as string | null,
                    },
                    {
                      label: 'Order Value',
                      current: formatRM(summary.orderValue),
                      previous: formatRM(comparison.orderValue.previous),
                      change: comparison.orderValue.changePct,
                      raw: null,
                    },
                    {
                      label: 'SKUs Ordered',
                      current: formatCount(summary.skusOrdered),
                      previous: formatCount(comparison.skusOrdered.previous),
                      change: null,
                      raw: `${skuDelta >= 0 ? '+' : ''}${skuDelta}`,
                    },
                    {
                      label: 'Avg Value / Unit',
                      current: formatRM(summary.avgValuePerUnit),
                      previous: formatRM(comparison.avgValuePerUnit.previous),
                      change: comparison.avgValuePerUnit.changePct,
                      raw: null,
                    },
                  ].map((row) => (
                    <tr key={row.label} className="border-b border-[var(--sera-line)]/60 last:border-0">
                      <td className="px-3 py-2.5 font-medium text-[var(--sera-ink)]">{row.label}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-[var(--sera-ink)]">{row.current}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-[var(--sera-muted)]">{row.previous}</td>
                      <td className="px-3 py-2.5 text-right">
                        {row.raw !== null ? (
                          <span className={cn('font-medium', skuDelta >= 0 ? 'text-emerald-600' : 'text-red-600')}>
                            {row.raw}
                          </span>
                        ) : (
                          <DeltaPill value={row.change} nullLabel="no baseline" />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>

          {/* ── Category Performance — consolidated report only ──────────
              Inside a drill-down the user is already within one category, so
              comparing categories has nothing left to say. */}
          {report.categoryPerformance && report.categoryPerformance.length > 0 ? (
            <SectionCard
              icon={Tag}
              title="Category Performance"
              description={`How each product category performed · ${period.rangeLabel} vs ${period.comparisonRangeLabel}`}
            >
              {/* Desktop table */}
              <div className="hidden md:block">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--sera-line)] text-left text-xs uppercase tracking-wide text-[var(--sera-muted)]">
                      <th className="px-2 py-2 font-medium">Category</th>
                      <th className="px-2 py-2 text-right font-medium">Units Ordered</th>
                      <th className="px-2 py-2 text-right font-medium">Order Value</th>
                      <th className="px-2 py-2 text-right font-medium">SKUs Ordered</th>
                      <th className="px-2 py-2 text-right font-medium">Share</th>
                      <th className="px-2 py-2 text-right font-medium">vs Previous Period</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.categoryPerformance.map((row) => (
                      <tr key={row.categoryId} className="border-b border-[var(--sera-line)]/60 last:border-0">
                        <td className="px-2 py-2.5 font-medium text-[var(--sera-ink)]">{row.categoryName}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums">{formatCount(row.unitsOrdered)}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums">{formatRM(row.orderValue)}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums text-[var(--sera-muted)]">
                          {formatCount(row.skusOrdered)} of {formatCount(row.activeSkus)}
                        </td>
                        <td className="px-2 py-2.5 text-right tabular-nums text-[var(--sera-muted)]">
                          {row.valueSharePct === null ? '—' : `${row.valueSharePct.toFixed(1)}%`}
                        </td>
                        <td className="px-2 py-2.5 text-right">
                          <DeltaPill value={row.changePct} nullLabel="no baseline" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile stacked category cards — never a crushed wide table */}
              <div className="space-y-2.5 md:hidden">
                {report.categoryPerformance.map((row) => (
                  <div key={row.categoryId} className="rounded-xl border border-[var(--sera-line)] p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--sera-ink)]">{row.categoryName}</p>
                      <DeltaPill value={row.changePct} nullLabel="no baseline" />
                    </div>
                    <dl className="mt-2 space-y-1 text-xs">
                      <div className="flex justify-between">
                        <dt className="text-[var(--sera-muted)]">Units</dt>
                        <dd className="tabular-nums">{formatCount(row.unitsOrdered)}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-[var(--sera-muted)]">Order Value</dt>
                        <dd className="tabular-nums">{formatRM(row.orderValue)}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-[var(--sera-muted)]">SKUs</dt>
                        <dd className="tabular-nums">{formatCount(row.skusOrdered)} of {formatCount(row.activeSkus)}</dd>
                      </div>
                    </dl>
                  </div>
                ))}
              </div>
            </SectionCard>
          ) : null}

          {report.isEmpty ? (
            <Card className={REPORTING_PANEL_CLASS}>
              <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
                <Package className="h-8 w-8 text-[var(--sera-muted)]" strokeWidth={1.5} />
                <p className="font-medium text-[var(--sera-ink)]">
                  No {report.category.isAll ? 'product' : report.category.name} order activity recorded for {period.label}.
                </p>
                <p className="max-w-md text-sm text-[var(--sera-muted)]">
                  {report.category.isAll
                    ? 'Pick another Reporting Month above, or open Inventory & Actions — the stock snapshot is current and stays available for any month.'
                    : `Other categories may still have activity in ${period.label}. The current ${report.category.name} inventory snapshot stays available under Inventory & Actions.`}
                </p>
              </CardContent>
            </Card>
          ) : null}
        </TabsContent>

        {/* ══ PERFORMANCE ════════════════════════════════════════════════ */}
        <TabsContent value="performance" className="space-y-5 animate-in fade-in-50 duration-300">
          <SectionCard
            icon={TrendingUp}
            title={`Daily Product Demand Trend — ${period.label}`}
            description={`Units ordered and order value per day · ${period.rangeLabel}`}
          >
            {report.dailyTrend.length === 0 ? (
              <EmptyNote>No days to report for {period.label} yet.</EmptyNote>
            ) : (
              <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={report.dailyTrend} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartGridColor} vertical={false} />
                  <XAxis
                    dataKey="shortLabel"
                    tick={{ fontSize: 11, fill: chartTickColor }}
                    tickLine={false}
                    axisLine={false}
                    // Thin the labels rather than crushing them on a narrow screen.
                    interval={report.dailyTrend.length > 14 ? 1 : 0}
                  />
                  <YAxis
                    yAxisId="units"
                    tick={{ fontSize: 11, fill: chartTickColor }}
                    tickLine={false} axisLine={false} width={44}
                  />
                  <YAxis
                    yAxisId="value" orientation="right"
                    tick={{ fontSize: 11, fill: chartTickColor }}
                    tickLine={false} axisLine={false} width={52}
                    tickFormatter={(value: number) => formatRMCompact(value)}
                  />
                  <Tooltip
                    contentStyle={{ borderRadius: 12, fontSize: 12, border: '1px solid var(--sera-line)' }}
                    labelFormatter={(_label, payload) => payload?.[0]?.payload?.label ?? ''}
                    formatter={(value: any, name: any) =>
                      name === 'Order Value' ? [formatRM(Number(value)), name] : [formatCount(Number(value)), name]}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar yAxisId="units" dataKey="units" name="Units Ordered" fill={REPORTING_COLORS.primary} radius={[4, 4, 0, 0]} maxBarSize={38} />
                  <Line yAxisId="value" type="monotone" dataKey="orderValue" name="Order Value" stroke={REPORTING_COLORS.ink} strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </SectionCard>

          <SectionCard
            icon={Crown}
            title="Top Products / Variants"
            description={`Top ${topRows.length} of ${report.productContribution.skuCount} SKUs ordered in ${period.rangeLabel}`}
            action={
              <div className="flex shrink-0 rounded-lg border border-[var(--sera-line)] p-0.5">
                {([['units', 'By Units'], ['value', 'By Order Value']] as const).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setTopSort(key)}
                    className={cn(
                      'rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                      topSort === key
                        ? 'bg-[var(--sera-orange)] text-white'
                        : 'text-[var(--sera-muted)] hover:text-[var(--sera-ink)]',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            }
          >
            {topRows.length === 0 ? (
              <EmptyNote>No products were ordered in {period.label}.</EmptyNote>
            ) : (
              <>
                {/* Desktop table */}
                <div className="hidden md:block">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--sera-line)] text-left text-xs uppercase tracking-wide text-[var(--sera-muted)]">
                        <th className="px-2 py-2 font-medium">#</th>
                        <th className="px-2 py-2 font-medium">Product / Variant</th>
                        <th className="px-2 py-2 text-right font-medium">Units</th>
                        <th className="px-2 py-2 text-right font-medium">Order Value</th>
                        <th className="px-2 py-2 text-right font-medium">Share</th>
                        <th className="px-2 py-2 text-right font-medium">vs Previous</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topRows.map((row) => (
                        <tr key={row.variantId} className="border-b border-[var(--sera-line)]/60 last:border-0">
                          <td className="px-2 py-2.5 font-semibold text-[var(--sera-muted)]">{row.rank}</td>
                          <td className="px-2 py-2.5 font-medium text-[var(--sera-ink)]">{row.label}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{formatCount(row.currentUnits)}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{formatRM(row.currentValue)}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums text-[var(--sera-muted)]">
                            {(topSort === 'units' ? row.unitsSharePct : row.valueSharePct)?.toFixed(1) ?? '—'}%
                          </td>
                          <td className="px-2 py-2.5 text-right">{growthCell(row)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile ranked cards — never a crushed table */}
                <div className="space-y-2.5 md:hidden">
                  {topRows.map((row) => (
                    <div key={row.variantId} className="rounded-xl border border-[var(--sera-line)] p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <span className="text-[11px] font-bold text-[var(--sera-orange)]">#{row.rank}</span>
                          <p className="truncate text-sm font-medium text-[var(--sera-ink)]">{row.label}</p>
                        </div>
                        {growthCell(row)}
                      </div>
                      <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                        <div>
                          <p className="text-sm font-semibold tabular-nums text-[var(--sera-ink)]">{formatCount(row.currentUnits)}</p>
                          <p className="text-[10px] text-[var(--sera-muted)]">units</p>
                        </div>
                        <div>
                          <p className="text-sm font-semibold tabular-nums text-[var(--sera-ink)]">{formatRMCompact(row.currentValue)}</p>
                          <p className="text-[10px] text-[var(--sera-muted)]">order value</p>
                        </div>
                        <div>
                          <p className="text-sm font-semibold tabular-nums text-[var(--sera-ink)]">
                            {(topSort === 'units' ? row.unitsSharePct : row.valueSharePct)?.toFixed(1) ?? '—'}%
                          </p>
                          <p className="text-[10px] text-[var(--sera-muted)]">contribution</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </SectionCard>

          <SectionCard
            icon={PieIcon}
            title="Product Contribution"
            description={`How concentrated ${formatRM(report.productContribution.totalOrderValue)} of order value is across SKUs · click a band to view its SKUs`}
          >
            {contributionSlices.length === 0 ? (
              <EmptyNote>No order value to attribute for {period.label}.</EmptyNote>
            ) : (
              <div className="grid grid-cols-1 items-center gap-4 lg:grid-cols-2">
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie
                      data={contributionSlices}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={54}
                      outerRadius={84}
                      paddingAngle={2}
                      className="cursor-pointer focus:outline-none"
                      onClick={(slice: any) => {
                        const band = report.productContribution.bands.find((b) => b.label === slice?.name)
                        if (band) openContributionBand(band.key, band.skus)
                      }}
                    >
                      {contributionSlices.map((slice) => <Cell key={slice.name} fill={slice.fill} className="cursor-pointer" />)}
                    </Pie>
                    <Tooltip
                      contentStyle={{ borderRadius: 12, fontSize: 12 }}
                      formatter={(value: any, name: any) => [formatRM(Number(value)), name]}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="space-y-2">
                  {report.productContribution.bands.map((band, index) => (
                    <button
                      key={band.key}
                      type="button"
                      onClick={() => openContributionBand(band.key, band.skus)}
                      disabled={band.skus === 0}
                      aria-label={`View the ${band.skus} SKUs in ${band.label}`}
                      className={cn(
                        'flex w-full items-center justify-between gap-3 rounded-lg border border-[var(--sera-line)] px-3 py-2 text-left transition-all',
                        band.skus > 0
                          ? 'cursor-pointer hover:-translate-y-0.5 hover:border-[var(--sera-orange)]/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)]/40'
                          : 'cursor-not-allowed opacity-60',
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: [REPORTING_COLORS.primary, REPORTING_COLORS.warning, REPORTING_COLORS.slate][index % 3] }}
                        />
                        <span className="truncate text-sm text-[var(--sera-ink)]">{band.label}</span>
                        <span className="shrink-0 text-[11px] text-[var(--sera-muted)]">({band.skus})</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-right">
                          <span className="block text-sm font-semibold tabular-nums text-[var(--sera-ink)]">
                            {band.sharePct === null ? '—' : `${band.sharePct.toFixed(1)}%`}
                          </span>
                          <span className="block text-[11px] tabular-nums text-[var(--sera-muted)]">{formatRM(band.orderValue)}</span>
                        </span>
                        {band.skus > 0 ? <ChevronRight className="h-4 w-4 text-[var(--sera-muted)]" /> : null}
                      </span>
                    </button>
                  ))}
                  <p className="pt-0.5 text-[11px] text-[var(--sera-muted)]">Click a band to view the SKUs inside it.</p>
                </div>
              </div>
            )}
          </SectionCard>
        </TabsContent>

        {/* ══ INVENTORY & ACTIONS ════════════════════════════════════════ */}
        <TabsContent value="inventory" className="space-y-5 animate-in fade-in-50 duration-300">
          <SectionCard
            icon={AlertTriangle}
            title="Products Requiring Attention"
            description={`Demand loss measured on ${period.rangeLabel} against ${period.comparisonRangeLabel}`}
          >
            {report.attentionProducts.length === 0 ? (
              <EmptyNote>No products required attention in {period.label}.</EmptyNote>
            ) : (
              <>
                <div className="hidden md:block">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--sera-line)] text-left text-xs uppercase tracking-wide text-[var(--sera-muted)]">
                        <th className="px-2 py-2 font-medium">#</th>
                        <th className="px-2 py-2 font-medium">Product / Variant</th>
                        <th className="px-2 py-2 text-right font-medium">Current</th>
                        <th className="px-2 py-2 text-right font-medium">Previous</th>
                        <th className="px-2 py-2 text-right font-medium">Change</th>
                        <th className="px-2 py-2 text-right font-medium">Current Stock</th>
                        <th className="px-2 py-2 font-medium">Last Order</th>
                        <th className="px-2 py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.attentionProducts.map((row, index) => (
                        <tr key={row.variantId} className="border-b border-[var(--sera-line)]/60 last:border-0">
                          <td className="px-2 py-2.5 text-[var(--sera-muted)]">{index + 1}</td>
                          <td className="px-2 py-2.5 font-medium text-[var(--sera-ink)]">{row.label}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{formatCount(row.currentUnits)}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums text-[var(--sera-muted)]">{formatCount(row.previousUnits)}</td>
                          <td className="px-2 py-2.5 text-right">{growthCell(row)}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{formatCount(row.currentStock)}</td>
                          <td className="px-2 py-2.5 text-[var(--sera-muted)]">{formatDay(row.lastOrderedAt)}</td>
                          <td className="px-2 py-2.5">
                            <Badge variant="secondary" className={cn('px-1.5 py-0 text-[11px]', ATTENTION_BADGE[row.status])}>
                              {row.status}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile compact cards */}
                <div className="space-y-2.5 md:hidden">
                  {report.attentionProducts.map((row) => (
                    <div key={row.variantId} className="rounded-xl border border-[var(--sera-line)] p-3">
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--sera-ink)]">{row.label}</p>
                        <Badge variant="secondary" className={cn('shrink-0 px-1.5 py-0 text-[11px]', ATTENTION_BADGE[row.status])}>
                          {row.status}
                        </Badge>
                      </div>
                      <dl className="mt-2 space-y-1 text-xs">
                        <div className="flex justify-between"><dt className="text-[var(--sera-muted)]">Current period</dt><dd className="tabular-nums">{formatCount(row.currentUnits)}</dd></div>
                        <div className="flex justify-between"><dt className="text-[var(--sera-muted)]">Previous</dt><dd className="tabular-nums">{formatCount(row.previousUnits)}</dd></div>
                        <div className="flex justify-between"><dt className="text-[var(--sera-muted)]">Change</dt><dd>{growthCell(row)}</dd></div>
                        <div className="flex justify-between"><dt className="text-[var(--sera-muted)]">Current stock</dt><dd className="tabular-nums">{formatCount(row.currentStock)}</dd></div>
                        <div className="flex justify-between"><dt className="text-[var(--sera-muted)]">Last order</dt><dd>{formatDay(row.lastOrderedAt)}</dd></div>
                      </dl>
                      <p className="mt-2 border-t border-[var(--sera-line)] pt-2 text-xs text-[var(--sera-ink)]">
                        <span className="text-[var(--sera-muted)]">Recommended: </span>{row.recommendation}
                      </p>
                    </div>
                  ))}
                </div>
              </>
            )}
          </SectionCard>

          <SectionCard
            icon={Warehouse}
            title="Current Inventory Snapshot"
            description={`Stock position as at ${formatTimestamp(report.inventorySnapshot.asOf ?? meta?.generatedAt ?? null)} — independent of the selected reporting month`}
          >
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <div className="col-span-2 rounded-xl border border-[var(--sera-line)] bg-[var(--sera-mist)] p-3 lg:col-span-1">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--sera-muted)]">Total Inventory Value</p>
                <p className="mt-1 text-xl font-bold text-[var(--sera-ink)] sm:text-2xl">{formatRMCompact(report.inventorySnapshot.totalValue)}</p>
                <p className="mt-1 text-[11px] text-[var(--sera-muted)]">
                  {formatCount(report.inventorySnapshot.totalOnHand)} units · {formatCount(report.inventorySnapshot.variantCount)} stocked SKUs
                </p>
              </div>
              {report.inventorySnapshot.categories.map((category) => (
                <div key={category.key} className="rounded-xl border border-[var(--sera-line)] p-3">
                  <p className="text-[10px] font-semibold uppercase leading-tight tracking-wider text-[var(--sera-muted)]">{category.label}</p>
                  <p className="mt-1 text-xl font-bold text-[var(--sera-ink)] sm:text-2xl">{formatCount(category.skus)}</p>
                  <p className="mt-1 text-[11px] leading-tight text-[var(--sera-muted)]">
                    {formatCount(category.units)} units · {formatRMCompact(category.value)}
                  </p>
                  <p className="mt-1 line-clamp-2 text-[10px] leading-tight text-[var(--sera-muted)]">{category.description}</p>
                </div>
              ))}
            </div>
          </SectionCard>

          <SectionCard
            icon={Boxes}
            title="Management Action Plan"
            description="Tap an action to filter the list below"
            action={actionFilter ? (
              <Button variant="ghost" size="sm" className="h-8 shrink-0 text-xs" onClick={() => setActionFilter(null)}>
                Clear filter
              </Button>
            ) : undefined}
          >
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {report.managementActions.summary.map((card) => (
                <SummaryTile
                  key={card.key}
                  label={card.label}
                  count={card.count}
                  accent={ACTION_ACCENT[card.key]}
                  icon={card.key === 'replenish' ? Package : card.key === 'maintain' ? Target : card.key === 'promote' ? Megaphone : ShieldAlert}
                  active={actionFilter === card.key}
                  onClick={() => setActionFilter(actionFilter === card.key ? null : card.key)}
                />
              ))}
            </div>

            {visibleActionRows.length === 0 ? (
              <EmptyNote>No management actions for this selection.</EmptyNote>
            ) : (
              <>
                <div className="mt-4 hidden md:block">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--sera-line)] text-left text-xs uppercase tracking-wide text-[var(--sera-muted)]">
                        <th className="px-2 py-2 font-medium">Priority</th>
                        <th className="px-2 py-2 font-medium">Product / Variant</th>
                        <th className="px-2 py-2 text-right font-medium">Current</th>
                        <th className="px-2 py-2 text-right font-medium">Previous</th>
                        <th className="px-2 py-2 text-right font-medium">Demand Change</th>
                        <th className="px-2 py-2 text-right font-medium">Current Stock</th>
                        <th className="px-2 py-2 font-medium">Stock Status</th>
                        <th className="px-2 py-2 font-medium">Recommended Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleActionRows.map((row) => (
                        <tr key={row.variantId} className="border-b border-[var(--sera-line)]/60 last:border-0">
                          <td className="px-2 py-2.5">
                            <Badge variant="secondary" className={cn('px-1.5 py-0 text-[10px] font-bold', PRIORITY_BADGE[row.actionPriority])}>
                              {row.actionPriority}
                            </Badge>
                          </td>
                          <td className="px-2 py-2.5 font-medium text-[var(--sera-ink)]">{row.label}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{formatCount(row.currentUnits)}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums text-[var(--sera-muted)]">{formatCount(row.previousUnits)}</td>
                          <td className="px-2 py-2.5 text-right">{growthCell(row)}</td>
                          <td className="px-2 py-2.5 text-right tabular-nums">{formatCount(row.currentStock)}</td>
                          <td className="px-2 py-2.5">{stockBadge(row)}</td>
                          <td className="px-2 py-2.5">
                            <span className="text-xs font-semibold" style={{ color: ACTION_ACCENT[row.action as ActionKey] }}>
                              {report.managementActions.summary.find((card) => card.key === row.action)?.label.toUpperCase()}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="mt-4 space-y-2.5 md:hidden">
                  {visibleActionRows.map((row) => (
                    <div key={row.variantId} className="rounded-xl border border-[var(--sera-line)] p-3">
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--sera-ink)]">{row.label}</p>
                        <Badge variant="secondary" className={cn('shrink-0 px-1.5 py-0 text-[10px] font-bold', PRIORITY_BADGE[row.actionPriority])}>
                          {row.actionPriority}
                        </Badge>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--sera-muted)]">
                        <span className="tabular-nums">{formatCount(row.currentUnits)} units</span>
                        <span className="tabular-nums">was {formatCount(row.previousUnits)}</span>
                        {growthCell(row)}
                        <span className="tabular-nums">stock {formatCount(row.currentStock)}</span>
                        {stockBadge(row)}
                      </div>
                      <p className="mt-2 border-t border-[var(--sera-line)] pt-2 text-xs font-semibold" style={{ color: ACTION_ACCENT[row.action as ActionKey] }}>
                        {report.managementActions.summary.find((card) => card.key === row.action)?.label.toUpperCase()}
                      </p>
                      <p className="mt-0.5 text-[11px] text-[var(--sera-muted)]">{row.recommendation}</p>
                    </div>
                  ))}
                </div>
              </>
            )}
          </SectionCard>
        </TabsContent>
      </Tabs>

      {/* ── Product Contribution drill-down ──────────────────────────────
          One sheet, two levels: the band's SKU list, and an individual SKU
          detail reached with a Back control. `w-full sm:max-w-2xl` makes it a
          full-screen sheet on mobile and a right drawer on desktop, matching the
          Distributor reports drawer. Closing it restores the Performance view
          with the month, category and sub-tab untouched. */}
      <Sheet
        open={contributionBand !== null}
        onOpenChange={(open) => {
          if (!open) {
            setContributionBand(null)
            setContributionSku(null)
          }
        }}
      >
        <SheetContent side="right" className="w-full overflow-y-auto p-0 sm:max-w-2xl">
          {activeSkuRow ? (
            <>
              <SheetHeader className="border-b border-[var(--sera-line)] px-4 py-3 text-left sm:px-6">
                <Button
                  variant="ghost"
                  size="sm"
                  className="mb-1 -ml-2 h-8 w-fit gap-1.5 text-xs text-[var(--sera-muted)]"
                  onClick={() => setContributionSku(null)}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back to {activeBand?.label}
                </Button>
                <SheetTitle className="pr-8 text-base">{activeSkuRow.label}</SheetTitle>
                <SheetDescription className="text-xs sm:text-sm">
                  Rank #{activeSkuRow.rank} · {period.label} · {report.category.name}
                </SheetDescription>
              </SheetHeader>

              {/* Stacked cards — no wide tables, no horizontal overflow. */}
              <div className="space-y-4 px-4 py-4 sm:px-6">
                <div className="rounded-xl border border-[var(--sera-line)] p-3">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--sera-muted)]">
                    Selected Period · {period.rangeLabel}
                  </p>
                  <dl className="space-y-1.5 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-[var(--sera-muted)]">Units Ordered</dt>
                      <dd className="font-semibold tabular-nums">{formatCount(activeSkuRow.currentUnits)}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-[var(--sera-muted)]">Order Value</dt>
                      <dd className="font-semibold tabular-nums">{formatRM(activeSkuRow.currentValue)}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-[var(--sera-muted)]">Contribution</dt>
                      <dd className="font-semibold tabular-nums">
                        {activeSkuRow.valueSharePct === null ? '—' : `${activeSkuRow.valueSharePct.toFixed(1)}%`}
                      </dd>
                    </div>
                  </dl>
                </div>

                <div className="rounded-xl border border-[var(--sera-line)] p-3">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--sera-muted)]">
                    Comparison Period · {period.comparisonRangeLabel}
                  </p>
                  <dl className="space-y-1.5 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-[var(--sera-muted)]">Previous Units</dt>
                      <dd className="tabular-nums">{formatCount(activeSkuRow.previousUnits)}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-[var(--sera-muted)]">Previous Order Value</dt>
                      <dd className="tabular-nums">{formatRM(activeSkuRow.previousValue)}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-[var(--sera-muted)]">Demand Change</dt>
                      <dd>{growthCell(activeSkuRow)}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-[var(--sera-muted)]">Performance Status</dt>
                      <dd className="font-medium">{DEMAND_STATUS_LABEL[activeSkuRow.demandTrend]}</dd>
                    </div>
                  </dl>
                </div>

                <div className="rounded-xl border border-[var(--sera-line)] p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--sera-muted)]">
                    Current Inventory Snapshot
                  </p>
                  {/* Current stock even when a historical month is selected. */}
                  <p className="mb-2 text-[10px] text-[var(--sera-muted)]">
                    Stock position as at {formatTimestamp(report.inventorySnapshot.asOf ?? meta?.generatedAt ?? null)} —
                    independent of the selected reporting month
                  </p>
                  <dl className="space-y-1.5 text-sm">
                    <div className="flex justify-between gap-3">
                      <dt className="text-[var(--sera-muted)]">Current Stock</dt>
                      <dd className="tabular-nums">{formatCount(activeSkuRow.currentStock)}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-[var(--sera-muted)]">Quantity Available</dt>
                      <dd className="tabular-nums">{formatCount(activeSkuRow.availableStock)}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-[var(--sera-muted)]">Reorder Point</dt>
                      <dd className="tabular-nums">
                        {activeSkuRow.reorderPoint > 0 ? formatCount(activeSkuRow.reorderPoint) : '—'}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-[var(--sera-muted)]">Stock Status</dt>
                      <dd>{stockBadge(activeSkuRow)}</dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-[var(--sera-muted)]">Stock Coverage</dt>
                      <dd className="tabular-nums">
                        {activeSkuRow.stockCoverDays === null ? '—' : `${Math.round(activeSkuRow.stockCoverDays)} days`}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-[var(--sera-muted)]">Last Ordered</dt>
                      <dd>{formatDay(activeSkuRow.lastOrderedAt)}</dd>
                    </div>
                  </dl>
                </div>

                {/* The same classification the Management Action Plan uses. */}
                <div
                  className="rounded-xl border p-3"
                  style={{
                    borderColor: `${activeSkuRow.action ? ACTION_ACCENT[activeSkuRow.action] : REPORTING_COLORS.slate}55`,
                    backgroundColor: `${activeSkuRow.action ? ACTION_ACCENT[activeSkuRow.action] : REPORTING_COLORS.slate}0f`,
                  }}
                >
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--sera-muted)]">
                    Recommended Action
                  </p>
                  <p
                    className="mt-1 text-sm font-bold"
                    style={{ color: activeSkuRow.action ? ACTION_ACCENT[activeSkuRow.action] : undefined }}
                  >
                    {activeSkuRow.action
                      ? report.managementActions.summary.find((card) => card.key === activeSkuRow.action)?.label.toUpperCase()
                      : 'NO ACTION REQUIRED'}
                  </p>
                  <p className="mt-1 text-xs text-[var(--sera-muted)]">
                    {activeSkuRow.action ? ACTION_RECOMMENDATION[activeSkuRow.action] : NO_ACTION_RECOMMENDATION}
                  </p>
                </div>
              </div>
            </>
          ) : (
            <>
              <SheetHeader className="border-b border-[var(--sera-line)] px-4 py-3 text-left sm:px-6">
                <SheetTitle className="pr-8 text-base uppercase">{activeBand?.label} Contribution</SheetTitle>
                <SheetDescription className="text-xs sm:text-sm">
                  {period.label} · {period.rangeLabel}
                  {period.isCurrentMonth ? ' (month to date)' : ''} · {report.category.name}
                </SheetDescription>
              </SheetHeader>

              <div className="px-4 py-4 sm:px-6">
                <div className="mb-3 rounded-xl border border-[var(--sera-line)] bg-[var(--sera-mist)] p-3">
                  <p className="text-2xl font-bold text-[var(--sera-ink)]">{formatRM(activeBand?.orderValue ?? 0)}</p>
                  <p className="text-xs text-[var(--sera-muted)]">
                    {activeBand?.sharePct === null || activeBand === null
                      ? 'no order value in the selected period'
                      : `${activeBand.sharePct.toFixed(1)}% of selected report Order Value`}
                  </p>
                  {/* Factual by default; the concentration sentence appears only
                      above a documented threshold. */}
                  {activeBand ? (
                    <p className="mt-2 border-t border-[var(--sera-line)] pt-2 text-xs text-[var(--sera-ink)]">
                      {activeBand.sharePct === null
                        ? `No ${activeBand.label} order value was recorded in this period.`
                        : `${activeBand.label} contribute ${activeBand.sharePct.toFixed(1)}% of selected-period Order Value.`}
                      {activeBand.key === 'top5' && activeBand.sharePct !== null
                        && activeBand.sharePct >= CONCENTRATION_THRESHOLD_PCT
                        ? ' Performance is concentrated in a small number of SKUs.'
                        : ''}
                    </p>
                  ) : null}
                </div>

                {bandRows.length === 0 ? (
                  <EmptyNote>No SKUs in this contribution band for {period.label}.</EmptyNote>
                ) : (
                  <>
                    <p className="mb-2 text-[11px] text-[var(--sera-muted)]">Select a SKU for its full detail.</p>
                    <div className="space-y-2">
                      {bandRows.map((row) => (
                        <button
                          key={row.variantId}
                          type="button"
                          onClick={() => setContributionSku(row.variantId)}
                          className="flex w-full items-start gap-3 rounded-xl border border-[var(--sera-line)] p-3 text-left transition-all hover:-translate-y-0.5 hover:border-[var(--sera-orange)]/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sera-orange)]/40"
                        >
                          <span className="mt-0.5 shrink-0 text-xs font-bold text-[var(--sera-orange)]">#{row.rank}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-[var(--sera-ink)]">{row.label}</span>
                            <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--sera-muted)]">
                              <span className="tabular-nums">{formatCount(row.currentUnits)} units</span>
                              <span className="tabular-nums">{formatRM(row.currentValue)}</span>
                              <span className="tabular-nums">
                                {row.valueSharePct === null ? '—' : `${row.valueSharePct.toFixed(1)}%`}
                              </span>
                              {growthCell(row)}
                            </span>
                          </span>
                          <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-[var(--sera-muted)]" />
                        </button>
                      ))}
                    </div>
                    {contributionBand === 'remaining' && report.productContribution.rowsTruncated ? (
                      <p className="mt-3 text-[11px] text-[var(--sera-muted)]">
                        Showing the highest-contributing SKUs of this band; the full list is longer than the report carries.
                      </p>
                    ) : null}
                  </>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* ── Strategy insight detail ─────────────────────────────────────── */}
      <Dialog open={selectedInsight !== null} onOpenChange={(open) => !open && setSelectedInsight(null)}>
        <DialogContent className="max-h-[85vh] max-w-4xl overflow-hidden p-0">
          <DialogHeader className="border-b border-[var(--sera-line)] px-4 py-3 sm:px-6">
            <DialogTitle className="text-base">{activeInsight?.title}</DialogTitle>
            <DialogDescription className="text-xs sm:text-sm">
              {activeInsight?.description} · {period.rangeLabel} vs {period.comparisonRangeLabel}
            </DialogDescription>
          </DialogHeader>
          <div className="px-4 pt-3 sm:px-6">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--sera-muted)]" />
              <Input
                value={insightSearch}
                onChange={(event) => setInsightSearch(event.target.value)}
                placeholder="Search products…"
                className="h-9 pl-9 text-sm"
              />
            </div>
          </div>
          <div className="max-h-[55vh] overflow-y-auto px-4 pb-4 pt-3 sm:px-6">
            {filteredInsightRows.length === 0 ? (
              <EmptyNote>No products match this insight.</EmptyNote>
            ) : (
              <>
                <table className="hidden w-full text-sm md:table">
                  <thead className="sticky top-0 bg-white">
                    <tr className="border-b border-[var(--sera-line)] text-left text-xs uppercase tracking-wide text-[var(--sera-muted)]">
                      <th className="px-2 py-2 font-medium">Product / Variant</th>
                      <th className="px-2 py-2 text-right font-medium">Current</th>
                      <th className="px-2 py-2 text-right font-medium">Previous</th>
                      <th className="px-2 py-2 text-right font-medium">Growth</th>
                      <th className="px-2 py-2 text-right font-medium">Order Value</th>
                      <th className="px-2 py-2 text-right font-medium">Stock</th>
                      <th className="px-2 py-2 font-medium">Coverage</th>
                      <th className="px-2 py-2 font-medium">Last Ordered</th>
                      <th className="px-2 py-2 font-medium">Recommended Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredInsightRows.map((row) => (
                      <tr key={row.variantId} className="border-b border-[var(--sera-line)]/60 last:border-0">
                        <td className="px-2 py-2.5 font-medium text-[var(--sera-ink)]">{row.label}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums">{formatCount(row.currentUnits)}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums text-[var(--sera-muted)]">{formatCount(row.previousUnits)}</td>
                        <td className="px-2 py-2.5 text-right">{growthCell(row)}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums">{formatRM(row.currentValue)}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums">{formatCount(row.currentStock)}</td>
                        <td className="px-2 py-2.5">
                          <span className="flex items-center gap-1.5">
                            {stockBadge(row)}
                            <span className="text-[11px] text-[var(--sera-muted)]">
                              {row.stockCoverDays === null ? '—' : `${Math.round(row.stockCoverDays)}d`}
                            </span>
                          </span>
                        </td>
                        <td className="px-2 py-2.5 text-[var(--sera-muted)]">{formatDay(row.lastOrderedAt)}</td>
                        <td className="px-2 py-2.5 text-xs">{row.recommendation}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="space-y-2.5 md:hidden">
                  {filteredInsightRows.map((row) => (
                    <div key={row.variantId} className="rounded-xl border border-[var(--sera-line)] p-3">
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--sera-ink)]">{row.label}</p>
                        {growthCell(row)}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--sera-muted)]">
                        <span className="tabular-nums">{formatCount(row.currentUnits)} units</span>
                        <span className="tabular-nums">was {formatCount(row.previousUnits)}</span>
                        <span className="tabular-nums">{formatRMCompact(row.currentValue)}</span>
                        <span className="tabular-nums">stock {formatCount(row.currentStock)}</span>
                        {stockBadge(row)}
                      </div>
                      <p className="mt-2 border-t border-[var(--sera-line)] pt-2 text-[11px] text-[var(--sera-ink)]">{row.recommendation}</p>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
