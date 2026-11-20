'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Area, Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3,
  Clock, Crown, Eye, Info, Loader2, Minus, RefreshCw, Repeat,
  Scan, Target, TrendingUp, Users,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  currentReportingMonthKey,
  type ConsumerAnalyticsReport,
  type MetricDelta,
} from '@/lib/reporting/consumer-analytics'
import type { ReportingPeriod } from '@/lib/reporting/reporting-period'
import ExecutiveKpiValue from './ExecutiveKpiValue'
import ReportingMonthSelector from './ReportingMonthSelector'
import { REPORTING_COLORS, REPORTING_PANEL_CLASS, ReportingTabLoading } from './reportingChrome'

interface ConsumerAnalyticsTabProps {
  userProfile: any
  chartGridColor: string
  chartTickColor: string
  isDark: boolean
  /** Dashboard-level Reporting Month; the tab keeps its own when rendered alone. */
  month?: string
  onMonthChange?: (month: string) => void
}

interface ReportResponse {
  report: ConsumerAnalyticsReport
  meta: { source: 'rpc' | 'fallback'; degraded: boolean; notice: string | null; generatedAt: string }
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const HEATMAP_HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21]

const SERIES = {
  scans: REPORTING_COLORS.primary,
  consumers: REPORTING_COLORS.success,
  returning: REPORTING_COLORS.success,
  heat: '#3b82f6',
}

function formatCount(value: number): string {
  return value.toLocaleString('en-MY')
}

function formatRate(value: number | null, fractionDigits = 1): string {
  return value === null ? '—' : `${value.toFixed(fractionDigits)}%`
}

function formatTimestamp(value: string | null): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-MY', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'Asia/Kuala_Lumpur',
  }).format(new Date(value))
}

function formatDateOnly(value: string | null): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-MY', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kuala_Lumpur',
  }).format(new Date(value))
}

/**
 * Growth pill. A `null` movement means the comparison month had no base to
 * measure against — that is shown as "no prior data" rather than a misleading
 * 0%.
 */
function DeltaPill({ value, unit, comparisonLabel }: {
  value: number | null
  unit: '%' | 'pp'
  comparisonLabel: string
}) {
  if (value === null) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-[var(--sera-muted)]">
        <Minus className="h-3 w-3" /> no {comparisonLabel} baseline
      </span>
    )
  }
  const up = value >= 0
  const Icon = up ? ArrowUpRight : ArrowDownRight
  return (
    <span className="inline-flex items-center gap-1.5">
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
        {Math.abs(value).toFixed(1)}{unit}
      </Badge>
      <span className="text-[11px] text-[var(--sera-muted)]">vs {comparisonLabel}</span>
    </span>
  )
}

function KpiCard({ label, icon: Icon, accent, value, delta, caption, hint }: {
  label: string
  icon: typeof Scan
  accent: string
  value: string
  delta: React.ReactNode
  caption?: string | null
  hint?: string
}) {
  return (
    <Card className={cn(REPORTING_PANEL_CLASS, 'transition-colors hover:border-[var(--sera-orange)]/35')}>
      <CardContent className="pt-5 pb-4">
        <div className="mb-2 flex items-start justify-between gap-2">
          <span className="inline-flex items-center gap-1 text-xs font-semibold tracking-wider text-[var(--sera-muted)]">
            {label}
            {hint ? <Info className="h-3 w-3 opacity-70" aria-label={hint} /> : null}
          </span>
          <span className="rounded-xl p-2 shadow-sm" style={{ backgroundColor: `${accent}15` }}>
            <Icon className="h-4 w-4" style={{ color: accent }} strokeWidth={1.75} />
          </span>
        </div>
        <ExecutiveKpiValue>{value}</ExecutiveKpiValue>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">{delta}</div>
        {caption ? <p className="mt-1 text-[11px] text-[var(--sera-muted)]">{caption}</p> : null}
      </CardContent>
    </Card>
  )
}

function SectionCard({ title, description, icon: Icon, action, children, className }: {
  title: string
  description?: string
  icon: typeof Scan
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <Card className={cn(REPORTING_PANEL_CLASS, className)}>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-3">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-base text-[var(--sera-ink)]">
            <Icon className="h-4 w-4 text-[var(--sera-orange)]" strokeWidth={1.75} />
            <span className="truncate">{title}</span>
          </CardTitle>
          {description ? <CardDescription className="mt-0.5">{description}</CardDescription> : null}
        </div>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

export default function ConsumerAnalyticsTab({ chartGridColor, chartTickColor, month: monthProp, onMonthChange }: ConsumerAnalyticsTabProps) {
  const [localMonth, setLocalMonth] = useState<string>(() => currentReportingMonthKey())
  const month = monthProp ?? localMonth
  const setMonth = onMonthChange ?? setLocalMonth
  const [availableMonths, setAvailableMonths] = useState<string[]>([])
  const [response, setResponse] = useState<ReportResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloading, setReloading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)

  // Month options are discovered independently so the current month's report
  // can start loading immediately, with no "select a month first" step.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/reporting/consumer-analytics/periods', { cache: 'no-store' })
        const payload = await res.json()
        if (cancelled || !res.ok) return
        setAvailableMonths(((payload.periods || []) as ReportingPeriod[]).map((period) => period.key))
      } catch {
        // A failed month list is not fatal: the current month is always offered.
      }
    })()
    return () => { cancelled = true }
  }, [])

  const loadReport = useCallback(async (targetMonth: string, isInitial: boolean) => {
    const id = ++requestId.current
    if (isInitial) setLoading(true)
    else setReloading(true)
    setError(null)
    try {
      const res = await fetch(`/api/reporting/consumer-analytics?month=${targetMonth}`, { cache: 'no-store' })
      const payload = await res.json()
      if (id !== requestId.current) return
      if (!res.ok) throw new Error(payload.error || 'Unable to load consumer analytics')
      setResponse(payload as ReportResponse)
    } catch (err: any) {
      if (id !== requestId.current) return
      setError(err?.message || 'Unable to load consumer analytics')
    } finally {
      if (id === requestId.current) {
        setLoading(false)
        setReloading(false)
      }
    }
  }, [])

  // Selecting a month reloads automatically — there is no Apply step.
  useEffect(() => {
    void loadReport(month, response === null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, loadReport])

  const report = response?.report ?? null
  const meta = response?.meta ?? null

  const heatmapGrid = useMemo(() => {
    const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0))
    for (const cell of report?.activityHeatmap ?? []) grid[cell.dayOfWeek][cell.hour] = cell.scans
    return grid
  }, [report])

  const newVsReturningSlices = useMemo(() => {
    if (!report) return []
    return [
      { name: 'New Consumers', value: report.newVsReturning.newConsumers, fill: SERIES.scans },
      { name: 'Returning Consumers', value: report.newVsReturning.returningConsumers, fill: SERIES.returning },
    ]
  }, [report])

  const controls = (
    <div className="flex flex-wrap items-end gap-3">
      <ReportingMonthSelector
        id="consumer-analytics-month"
        month={month}
        onMonthChange={setMonth}
        availableMonths={availableMonths}
        caption={report ? (
          month === currentReportingMonthKey()
            // The consumer RPC compares whole calendar months; a month-to-date
            // figure is therefore measured against a COMPLETE previous month.
            ? `Month to date · compared with all of ${report.period.previousMonthLabel} (not like-for-like days)`
            : `Comparing with ${report.period.previousMonthLabel}`
        ) : null}
      />
      <Button
        variant="outline"
        className="h-9 gap-2 border-[var(--sera-line)]"
        onClick={() => loadReport(month, false)}
        disabled={loading || reloading}
      >
        <RefreshCw className={cn('h-4 w-4', reloading && 'animate-spin')} />
        Refresh
      </Button>
    </div>
  )

  const header = (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--sera-ink)]">
          <Scan className="h-5 w-5 text-[var(--sera-orange)]" strokeWidth={1.75} />
          Consumer Analytics
        </h2>
        <p className="mt-0.5 text-sm text-[var(--sera-muted)]">Monthly consumer engagement report</p>
                    </div>
      {controls}
                </div>
  )

  if (loading && !report) {
    return (
      <div className="space-y-6">
        {header}
        <ReportingTabLoading label="Loading consumer analytics" />
                </div>
    )
  }

  if (error && !report) {
    return (
      <div className="space-y-6">
        {header}
        <Card className={REPORTING_PANEL_CLASS}>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <AlertTriangle className="h-8 w-8 text-red-500" />
            <p className="font-medium text-[var(--sera-ink)]">Unable to load consumer analytics</p>
            <p className="max-w-xl text-sm text-[var(--sera-muted)]">{error}</p>
            <Button variant="outline" onClick={() => loadReport(month, true)} className="gap-2">
              <RefreshCw className="h-4 w-4" /> Retry
            </Button>
            </CardContent>
          </Card>
      </div>
    )
  }

  if (!report) return <div className="space-y-6">{header}</div>

  const { period, summary, comparison, newVsReturning } = report
  const comparisonShort = period.previousMonthShortLabel

  return (
    <div className={cn('space-y-6 transition-opacity', reloading && 'opacity-70')}>
      {header}

      {error ? (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{error} — showing the last report that loaded successfully.</span>
        </div>
      ) : null}

      {meta?.degraded && meta.notice ? (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{meta.notice}</span>
        </div>
      ) : null}

      {/* ── Section 2 · Monthly Summary ─────────────────────────────────── */}
      <Card className={REPORTING_PANEL_CLASS}>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0 pb-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base text-[var(--sera-ink)]">
              <BarChart3 className="h-4 w-4 text-[var(--sera-orange)]" strokeWidth={1.75} />
              Monthly Summary
            </CardTitle>
            <CardDescription className="mt-0.5">
              Key metrics for {period.label} vs {period.previousMonthLabel}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-[var(--sera-muted)]">
            {reloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            <span>Data updated: {formatTimestamp(meta?.generatedAt ?? null)}</span>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label="TOTAL SCANS"
              icon={Scan}
              accent={REPORTING_COLORS.primary}
              value={formatCount(summary.totalScans)}
              delta={<DeltaPill value={comparison.totalScans.changePct} unit="%" comparisonLabel={comparisonShort} />}
              caption={`avg ${formatCount(summary.avgScansPerDay)}/day`}
            />
            <KpiCard
              label="IDENTIFIED CONSUMERS"
              icon={Users}
              accent={REPORTING_COLORS.success}
              value={formatCount(summary.identifiedConsumers)}
              delta={<DeltaPill value={comparison.identifiedConsumers.changePct} unit="%" comparisonLabel={comparisonShort} />}
              caption={
                summary.identityCoveragePct === null
                  ? 'no scans to measure identity coverage'
                  : `${formatRate(summary.identityCoveragePct)} of scans carry a consumer ID`
              }
              hint="Distinct consumer_id values. Anonymous scans are counted in Total Scans only."
            />
            <KpiCard
              label="REPEAT CONSUMERS"
              icon={Repeat}
              accent={REPORTING_COLORS.warning}
              value={formatCount(summary.repeatConsumers)}
              delta={<DeltaPill value={comparison.repeatConsumers.changePct} unit="%" comparisonLabel={comparisonShort} />}
              caption={
                summary.repeatSharePct === null
                  ? 'no identified consumers this month'
                  : `${formatRate(summary.repeatSharePct)} of identified consumers`
              }
              hint="Identified this month and known from an earlier scan before the month started."
            />
            <KpiCard
              label="RETENTION RATE"
              icon={Target}
              accent={REPORTING_COLORS.purple}
              value={formatRate(summary.retentionRate)}
              delta={<DeltaPill value={comparison.retentionRate.changePoints} unit="pp" comparisonLabel={comparisonShort} />}
              caption={`${period.previousMonthShortLabel} identified consumers who scanned again`}
              hint={`Retained ÷ ${period.previousMonthLabel} identified consumers.`}
            />
          </div>
        </CardContent>
      </Card>

      {report.isEmpty ? (
        <Card className={REPORTING_PANEL_CLASS}>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
            <Eye className="h-8 w-8 text-[var(--sera-muted)]" strokeWidth={1.5} />
            <p className="font-medium text-[var(--sera-ink)]">
              No consumer activity recorded for {period.label}.
            </p>
            <p className="max-w-md text-sm text-[var(--sera-muted)]">
              Pick another Reporting Month above to review a period with recorded scans.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* ── Sections 3 & 4 · Daily trend + month comparison ─────────── */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            <SectionCard
              className="lg:col-span-3"
              icon={TrendingUp}
              title={`Daily Scan Trend — ${period.label}`}
              description="Total scans and identified consumers per day"
            >
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={report.dailyTrend} margin={{ top: 5, right: 8, left: -18, bottom: 0 }}>
                  <defs>
                    <linearGradient id="ca-scan-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={SERIES.scans} stopOpacity={0.28} />
                      <stop offset="100%" stopColor={SERIES.scans} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartGridColor} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: chartTickColor }} interval="preserveStartEnd" minTickGap={24} />
                  <YAxis tick={{ fontSize: 11, fill: chartTickColor }} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ borderRadius: 12, fontSize: 12 }}
                    formatter={(value: any, name: any) => [formatCount(Number(value)), name]}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Area type="monotone" dataKey="scans" name="Scans" stroke={SERIES.scans} strokeWidth={2} fill="url(#ca-scan-fill)" />
                  <Line type="monotone" dataKey="consumers" name="Identified Consumers" stroke={SERIES.consumers} strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </SectionCard>

            <SectionCard
              className="lg:col-span-2"
              icon={BarChart3}
              title={`${period.label} vs ${period.previousMonthLabel}`}
              description="Key comparison"
            >
            <div className="space-y-4">
                {([
                  { label: 'Total Scans', delta: comparison.totalScans },
                  { label: 'Identified Consumers', delta: comparison.identifiedConsumers },
                  { label: 'Repeat Consumers', delta: comparison.repeatConsumers },
                ] as { label: string; delta: MetricDelta }[]).map(({ label, delta }) => {
                  const scale = Math.max(delta.current, delta.previous, 1)
                  return (
                    <div key={label} className="space-y-1.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-medium text-[var(--sera-ink)]">{label}</span>
                        <DeltaPill value={delta.changePct} unit="%" comparisonLabel={comparisonShort} />
                  </div>
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-[var(--sera-mist)]">
                            <div className="h-full rounded-full" style={{ width: `${(delta.current / scale) * 100}%`, backgroundColor: SERIES.scans }} />
                </div>
                          <span className="w-16 shrink-0 text-right text-xs font-semibold tabular-nums text-[var(--sera-ink)]">
                            {formatCount(delta.current)}
                          </span>
              </div>
                        <div className="flex items-center gap-2">
                          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-[var(--sera-mist)]">
                            <div className="h-full rounded-full" style={{ width: `${(delta.previous / scale) * 100}%`, backgroundColor: `${SERIES.scans}55` }} />
                  </div>
                          <span className="w-16 shrink-0 text-right text-xs tabular-nums text-[var(--sera-muted)]">
                            {formatCount(delta.previous)}
                          </span>
                </div>
              </div>
            </div>
                  )
                })}
                <div className="flex items-center gap-4 border-t border-[var(--sera-line)] pt-3 text-[11px] text-[var(--sera-muted)]">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SERIES.scans }} /> {period.label}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: `${SERIES.scans}55` }} /> {period.previousMonthLabel}
                  </span>
                </div>
              </div>
            </SectionCard>
      </div>

          {/* ── Sections 5 & 6 · New vs returning + 12-month trend ──────── */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
            <SectionCard
              className="lg:col-span-2"
              icon={Users}
              title="New vs Returning Consumers"
              description={`Consumer breakdown for ${period.label}`}
            >
              <div className="flex flex-col items-center gap-4 sm:flex-row">
                <div className="relative h-[190px] w-[190px] shrink-0">
            <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={newVsReturningSlices}
                        dataKey="value"
                        innerRadius={58}
                        outerRadius={88}
                        paddingAngle={2}
                        stroke="none"
                        isAnimationActive={false}
                      >
                        {newVsReturningSlices.map((slice) => <Cell key={slice.name} fill={slice.fill} />)}
                      </Pie>
                      <Tooltip formatter={(value: any, name: any) => [formatCount(Number(value)), name]} />
                    </PieChart>
            </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-xl font-semibold text-[var(--sera-ink)]">
                      {formatCount(newVsReturning.identifiedConsumers)}
                    </span>
                    <span className="text-[11px] text-[var(--sera-muted)]">Consumers</span>
          </div>
                </div>
                <div className="w-full space-y-3">
                  <div>
                    <p className="flex items-center gap-2 text-sm font-medium text-[var(--sera-ink)]">
                      <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: SERIES.scans }} />
                      New Consumers
                    </p>
                    <p className="pl-[18px] text-sm text-[var(--sera-muted)]">
                      {formatCount(newVsReturning.newConsumers)} ({formatRate(newVsReturning.newPct)})
                    </p>
                  </div>
                  <div>
                    <p className="flex items-center gap-2 text-sm font-medium text-[var(--sera-ink)]">
                      <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: SERIES.returning }} />
                      Returning Consumers
                    </p>
                    <p className="pl-[18px] text-sm text-[var(--sera-muted)]">
                      {formatCount(newVsReturning.returningConsumers)} ({formatRate(newVsReturning.returningPct)})
                    </p>
                  </div>
                  <p className="border-t border-[var(--sera-line)] pt-2 text-[11px] leading-relaxed text-[var(--sera-muted)]">
                    New = first identified scan happened in {period.label}. Returning = identified before {period.label} and scanned again.
                  </p>
                </div>
              </div>
            </SectionCard>

            <SectionCard
              className="lg:col-span-3"
              icon={BarChart3}
              title="12-Month Trend"
              description={`Scans and identified consumers, ending ${period.label}`}
            >
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={report.twelveMonthTrend} margin={{ top: 5, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartGridColor} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: chartTickColor }} />
                  <YAxis tick={{ fontSize: 11, fill: chartTickColor }} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ borderRadius: 12, fontSize: 12 }}
                    labelFormatter={(_label: any, payload: any) => payload?.[0]?.payload?.fullLabel ?? ''}
                    formatter={(value: any, name: any) => [formatCount(Number(value)), name]}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="scans" name="Scans" fill={SERIES.scans} radius={[4, 4, 0, 0]} maxBarSize={26} />
                  <Line type="monotone" dataKey="consumers" name="Identified Consumers" stroke={SERIES.consumers} strokeWidth={2} dot={{ r: 2.5 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </SectionCard>
          </div>

          {/* ── Sections 7 & 8 · Heatmap + retention cohort ─────────────── */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <SectionCard
              icon={Clock}
              title="Activity Heatmap"
              description={`Scan activity by day-of-week and hour (${period.label})`}
            >
            <div className="overflow-x-auto">
                <div className="min-w-[520px]">
                  <div className="mb-1 flex pl-9">
                    {Array.from({ length: 24 }, (_, hour) => (
                      <div key={hour} className="flex-1 text-center text-[9px] text-[var(--sera-muted)]">
                        {HEATMAP_HOUR_TICKS.includes(hour) ? `${String(hour).padStart(2, '0')}:00` : ''}
                      </div>
                  ))}
                </div>
                  {heatmapGrid.map((row, day) => (
                    <div key={day} className="mb-0.5 flex items-center">
                      <span className="w-9 shrink-0 text-[10px] text-[var(--sera-muted)]">{DAY_NAMES[day]}</span>
                      {row.map((count, hour) => (
                        <div
                          key={hour}
                          className="mx-px h-4 flex-1 rounded-[3px]"
                          style={{
                            backgroundColor: count === 0
                              ? 'var(--sera-mist, #f4f4f5)'
                              : SERIES.heat,
                            opacity: count === 0 ? 1 : 0.18 + 0.82 * (count / Math.max(report.heatmapMax, 1)),
                          }}
                          title={`${DAY_NAMES[day]} ${String(hour).padStart(2, '0')}:00 — ${formatCount(count)} scans`}
                        />
                      ))}
                  </div>
                ))}
                  <div className="mt-2 flex items-center justify-end gap-1.5 text-[10px] text-[var(--sera-muted)]">
                    <span>Less</span>
                    {[0, 0.25, 0.5, 0.75, 1].map((step) => (
                      <span
                        key={step}
                        className="h-3 w-3 rounded-[3px]"
                        style={{
                          backgroundColor: step === 0 ? 'var(--sera-mist, #f4f4f5)' : SERIES.heat,
                          opacity: step === 0 ? 1 : 0.18 + 0.82 * step,
                        }}
                      />
                    ))}
                    <span>More</span>
                </div>
              </div>
            </div>
            </SectionCard>

            <SectionCard
              icon={Target}
              title="Monthly Retention Cohort"
              description="% of a month's identified consumers who scanned again the following month"
            >
            <div className="space-y-3">
                {report.retentionCohort.map((row) => (
                  <div key={row.month} className="flex items-center gap-3">
                    <span className="w-20 shrink-0 text-xs text-[var(--sera-ink)]">{row.label}</span>
                    <div className="h-3 flex-1 overflow-hidden rounded-full bg-[var(--sera-mist)]">
                      {row.retentionRate === null ? null : (
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${Math.min(row.retentionRate, 100)}%`, backgroundColor: SERIES.returning }}
                        />
                      )}
                    </div>
                    <span className="w-32 shrink-0 text-right text-xs tabular-nums text-[var(--sera-muted)]">
                      {row.pending
                        ? 'current month'
                        : row.retentionRate === null
                          ? 'no cohort'
                          : `${formatRate(row.retentionRate, 0)} (${formatCount(row.retained ?? 0)}/${formatCount(row.consumers)})`}
                      </span>
                </div>
              ))}
                <p className="border-t border-[var(--sera-line)] pt-2 text-[11px] text-[var(--sera-muted)]">
                  {period.label} is the current cohort — its retention can only be measured once {period.label} closes and the
                  following month has recorded activity.
                </p>
            </div>
            </SectionCard>
      </div>

          {/* ── Sections 9 & 10 · Top consumers + top products ──────────── */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <SectionCard
              icon={Crown}
              title="Top Consumers"
              description={`Top ${report.topConsumers.length} consumers by total scans (${period.label})`}
            >
              {report.topConsumers.length === 0 ? (
                <p className="py-8 text-center text-sm text-[var(--sera-muted)]">
                  No identified consumer scans in {period.label}.
                </p>
          ) : (
            <div className="overflow-x-auto">
                  <table className="w-full min-w-[460px] text-sm">
                <thead>
                      <tr className="border-b border-[var(--sera-line)] text-left text-[11px] uppercase tracking-wider text-[var(--sera-muted)]">
                        <th className="py-2 pr-2 font-medium">#</th>
                        <th className="py-2 pr-2 font-medium">Consumer</th>
                        <th className="py-2 pr-2 text-right font-medium">Total Scans</th>
                        <th className="py-2 pr-2 text-right font-medium">Last Scan</th>
                        <th className="py-2 text-right font-medium">Frequency</th>
                  </tr>
                </thead>
                <tbody>
                      {report.topConsumers.map((consumer) => (
                        <tr key={consumer.consumerId} className="border-b border-[var(--sera-line)]/60 last:border-0">
                          <td className="py-2 pr-2 text-[var(--sera-muted)]">{consumer.rank}</td>
                          <td className="py-2 pr-2">
                            <p className="truncate font-medium text-[var(--sera-ink)]">{consumer.name}</p>
                            <p className="truncate text-[11px] text-[var(--sera-muted)]">{consumer.phone}</p>
                      </td>
                          <td className="py-2 pr-2 text-right font-semibold tabular-nums text-[var(--sera-ink)]">
                            {formatCount(consumer.scans)}
                      </td>
                          <td className="py-2 pr-2 text-right text-[11px] tabular-nums text-[var(--sera-muted)]">
                            {formatDateOnly(consumer.lastScan)}
                      </td>
                          <td className="py-2 text-right">
                            <Badge
                              variant="secondary"
                              className={cn(
                                'text-[11px]',
                                consumer.frequency === 'High' && 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
                                consumer.frequency === 'Medium' && 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
                                consumer.frequency === 'Low' && 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
                              )}
                            >
                              {consumer.frequency}
                            </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
            </SectionCard>

            <SectionCard
              icon={Eye}
              title="Top Products / Variants"
              description={`Most scanned products and variants (${period.label})`}
            >
              {report.topProducts.length === 0 ? (
                <p className="py-8 text-center text-sm text-[var(--sera-muted)]">
                  No product-linked scans in {period.label}.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[420px] text-sm">
                    <thead>
                      <tr className="border-b border-[var(--sera-line)] text-left text-[11px] uppercase tracking-wider text-[var(--sera-muted)]">
                        <th className="py-2 pr-2 font-medium">#</th>
                        <th className="py-2 pr-2 font-medium">Product / Variant</th>
                        <th className="py-2 pr-2 text-right font-medium">Scans</th>
                        <th className="py-2 font-medium">% of Total</th>
                  </tr>
                </thead>
                    <tbody>
                      {report.topProducts.map((product) => (
                        <tr key={`${product.productId}:${product.variantId}`} className="border-b border-[var(--sera-line)]/60 last:border-0">
                          <td className="py-2 pr-2 text-[var(--sera-muted)]">{product.rank}</td>
                          <td className="py-2 pr-2">
                            <p className="truncate font-medium text-[var(--sera-ink)]">{product.productName}</p>
                            {product.variantName ? (
                              <p className="truncate text-[11px] text-[var(--sera-muted)]">[ {product.variantName} ]</p>
                            ) : null}
                      </td>
                          <td className="py-2 pr-2 text-right font-semibold tabular-nums text-[var(--sera-ink)]">
                            {formatCount(product.scans)}
                          </td>
                          <td className="py-2">
                            <div className="flex items-center gap-2">
                              <div className="h-2 w-full min-w-[48px] overflow-hidden rounded-full bg-[var(--sera-mist)]">
                                <div
                                  className="h-full rounded-full"
                                  style={{ width: `${product.sharePct ?? 0}%`, backgroundColor: SERIES.scans }}
                                />
                              </div>
                              <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-[var(--sera-muted)]">
                                {formatRate(product.sharePct)}
                              </span>
                            </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
                </div>
            )}
            </SectionCard>
          </div>
        </>
      )}
    </div>
  )
}
