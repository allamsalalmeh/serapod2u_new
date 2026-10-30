'use client'

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, AreaChart, Area, Cell,
} from 'recharts'
import {
  RefreshCw, Loader2, TrendingUp, TrendingDown, MapPin,
  Store, Scan, Crown, Eye,
  Download, FileSpreadsheet, Search, Map as MapIcon,
} from 'lucide-react'
import {
  buildNegeriReport,
  type NegeriScanRow,
  type NegeriOrgRow,
  type NegeriStateRow,
  type NegeriRegionRow,
} from '@/lib/reporting/shop-by-negeri'
import {
  previousReportingPeriod,
  reportingPeriodDateWindow,
  reportingPeriodFilenameLabel,
  reportingPeriodFromKey,
  reportingPeriodRangeLabel,
} from '@/lib/reporting/reporting-period'
import { readShopScans } from '@/lib/reporting/shop-performance'
import {
  buildCanonicalStates,
  type CanonicalState,
} from '@/lib/reporting/canonical-state'
import ExecutiveKpiValue from './ExecutiveKpiValue'
import MalaysiaStateMap, { type StateMapMetric } from './MalaysiaStateMap'
import StateFlag from './StateFlag'
import ReportingMonthSelector from './ReportingMonthSelector'

interface ShopByNegeriTabProps {
  userProfile: any
  chartGridColor: string
  chartTickColor: string
  isDark: boolean
  /** Selected Reporting Month, `YYYY-MM`. */
  month: string
  onMonthChange: (month: string) => void
  /** Months with scans; only the earliest bounds the selector. */
  availableMonths: string[]
  onRefreshPeriods: () => Promise<void>
}

const CHART_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#6366f1', '#ef4444', '#14b8a6', '#f97316']

function formatNum(val: number): string {
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}K`
  return val.toLocaleString()
}

function GrowthBadge({ value }: { value: number | null }) {
  if (value === null) {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  const up = value >= 0
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${up ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
      {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {Math.abs(value).toFixed(1)}%
    </span>
  )
}

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-muted ${className}`} />
}

export default function ShopByNegeriTab({
  userProfile, chartGridColor, chartTickColor, isDark,
  month, onMonthChange, availableMonths, onRefreshPeriods,
}: ShopByNegeriTabProps) {
  const supabase = useMemo(() => createClient(), [])
  // Every month in the supported range is a valid period, with or without scans.
  const selectedPeriod = useMemo(() => reportingPeriodFromKey(month), [month])
  const requestId = useRef(0)

  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [exporting, setExporting] = useState(false)

  const [scans, setScans] = useState<NegeriScanRow[]>([])
  const [orgs, setOrgs] = useState<NegeriOrgRow[]>([])
  const [states, setStates] = useState<NegeriStateRow[]>([])
  const [regions, setRegions] = useState<NegeriRegionRow[]>([])

  // One authoritative filter state — every control applies immediately, there
  // is no Apply/Reset step. `searchInput` is only the raw keystrokes; `search`
  // is the debounced value the report is actually built from.
  const [region, setRegion] = useState('all')
  const [negeri, setNegeri] = useState('all')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [selectedStateKey, setSelectedStateKey] = useState<string | null>(null)

  const tooltipBg = isDark ? '#1f2937' : '#ffffff'
  const tooltipStyle = {
    borderRadius: '12px',
    border: 'none',
    boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
    backgroundColor: tooltipBg,
    color: isDark ? '#f3f4f6' : undefined,
  }

  // ── Data fetching ──────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    const id = ++requestId.current
    const isLatest = () => id === requestId.current
    try {
      // Reference data
      const [{ data: stateData }, { data: regionData }] = await Promise.all([
        supabase.from('states').select('id, state_name, region_id').order('state_name'),
        supabase.from('regions').select('id, region_name').order('region_name'),
      ])
      if (!isLatest()) return
      setStates((stateData as NegeriStateRow[]) || [])
      setRegions((regionData as NegeriRegionRow[]) || [])

      if (!selectedPeriod) {
        setScans([])
        setOrgs([])
        return
      }
      // Comparison month + report month, every page (never truncated by the row cap).
      const previousPeriod = previousReportingPeriod(selectedPeriod)
      let rows: NegeriScanRow[]
      try {
        rows = (await readShopScans(supabase, previousPeriod.startUtc, selectedPeriod.endUtc)) as unknown as NegeriScanRow[]
      } catch (scanErr) {
        console.error('ShopByNegeriTab scan fetch error:', scanErr)
        if (isLatest()) setScans([])
        return
      }
      if (!isLatest()) return
      setScans(rows)

      // Organizations for the referenced shops (with state_id)
      const shopIds = [...new Set(rows.map((s) => s.shop_id).filter(Boolean))] as string[]
      if (shopIds.length > 0) {
        const orgList: NegeriOrgRow[] = []
        const batchSize = 200
        for (let i = 0; i < shopIds.length; i += batchSize) {
          const batch = shopIds.slice(i, i + batchSize)
          const { data: orgData } = await supabase
            .from('organizations')
            .select('id, org_name, branch, state_id, contact_name, contact_phone')
            .in('id', batch)
          if (orgData) orgList.push(...(orgData as NegeriOrgRow[]))
        }
        if (!isLatest()) return
        setOrgs(orgList)
      } else {
        setOrgs([])
      }
    } catch (err) {
      console.error('ShopByNegeriTab fetch error:', err)
    }
  }, [supabase, selectedPeriod])

  useEffect(() => {
    setLoading(true)
    const id = requestId.current + 1
    fetchData().finally(() => { if (id === requestId.current) setLoading(false) })
  }, [fetchData])

  const handleRefresh = async () => {
    setRefreshing(true)
    await onRefreshPeriods()
    await fetchData()
    setRefreshing(false)
  }

  // ── Canonical Negeri options ───────────────────────────────────────
  // `states` holds duplicate rows for the same real state (two "Selangor"
  // rows today), so both dropdowns and the report are driven by canonical
  // states. Selecting one covers every underlying states.id behind it.
  const canonicalStates = useMemo(() => buildCanonicalStates(states), [states])

  const negeriOptions = useMemo<CanonicalState[]>(() => {
    if (region === 'all') return canonicalStates
    return canonicalStates.filter((s) => s.regionIds.includes(region))
  }, [canonicalStates, region])

  // Region changes apply immediately; a Negeri that no longer belongs to the
  // new region falls back to All States in the same update, so the report is
  // never built from an invalid pair.
  const handleRegionChange = (value: string) => {
    setRegion(value)
    const stillValid =
      negeri === 'all' ||
      value === 'all' ||
      canonicalStates.some((s) => s.key === negeri && s.regionIds.includes(value))
    if (!stillValid) setNegeri('all')
    setSelectedStateKey(null)
  }

  const handleNegeriChange = (value: string) => {
    setNegeri(value)
    setSelectedStateKey(null)
  }

  // Debounced free-text search. Clearing the box restores the unsearched
  // results straight away rather than after the debounce.
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleSearchChange = (value: string) => {
    setSearchInput(value)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    if (!value.trim()) {
      setSearch('')
      return
    }
    searchTimerRef.current = setTimeout(() => setSearch(value), 250)
  }
  useEffect(() => () => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
  }, [])

  // ── Report computation ─────────────────────────────────────────────
  const dateWindow = useMemo(
    () => selectedPeriod ? reportingPeriodDateWindow(selectedPeriod) : null,
    [selectedPeriod]
  )

  const report = useMemo(() => buildNegeriReport({
    scans,
    orgs,
    states,
    regionId: region,
    negeriId: negeri,
    search,
    window: dateWindow!,
  }), [scans, orgs, states, region, negeri, search, dateWindow])

  // Default selected state = top ranked
  const activeStateKey = selectedStateKey || report.ranking[0]?.stateKey || null
  const activeStateRow = report.ranking.find((r) => r.stateKey === activeStateKey) || null
  const activeStateName = activeStateRow?.negeri
    || canonicalStates.find((s) => s.key === activeStateKey)?.name
    || '—'
  const activeTopShops = useMemo(
    () => report.topShops.filter((s) => s.stateKey === activeStateKey),
    [report.topShops, activeStateKey]
  )

  // Canonical-key metrics for the Malaysia map (covers every state, zero-filled,
  // then overlaid with the filtered ranking metrics).
  const metricsByKey = useMemo(() => {
    const m = new Map<string, StateMapMetric>()
    for (const s of canonicalStates) {
      m.set(s.key, { stateKey: s.key, negeri: s.name, shops: 0, scans: 0, consumers: 0, avgPerShop: 0 })
    }
    for (const r of report.ranking) {
      m.set(r.stateKey, { stateKey: r.stateKey, negeri: r.negeri, shops: r.shops, scans: r.scans, consumers: r.consumers, avgPerShop: r.avgPerShop })
    }
    return m
  }, [canonicalStates, report.ranking])
  const selectedKey = activeStateKey

  const dateRangeLabel = selectedPeriod ? reportingPeriodRangeLabel(selectedPeriod) : ''

  // ── Excel export (server-side, follows active filters) ─────────────
  const handleDownloadExcel = async () => {
    try {
      setExporting(true)
      const params = new URLSearchParams({
        period: selectedPeriod!.key,
        region,
        negeri,
        search,
      })
      const res = await fetch(`/api/reporting/shop-by-negeri/excel?${params.toString()}`)
      if (!res.ok) {
        const msg = await res.text().catch(() => '')
        throw new Error(msg || `Export failed (${res.status})`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `Shop_by_Negeri_${reportingPeriodFilenameLabel(selectedPeriod!)}.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Shop by Negeri export error:', err)
      // eslint-disable-next-line no-alert
      alert('Could not generate the Excel report. Please try again.')
    } finally {
      setExporting(false)
    }
  }

  // ── Loading state ──────────────────────────────────────────────────
  if (!selectedPeriod) {
    return <div className="rounded-xl border bg-card/80 p-10 text-center text-sm text-muted-foreground">No transaction periods available.</div>
  }

  if (loading || !dateWindow) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-12 w-full" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <Card key={i} className="border-0 bg-card/80 backdrop-blur overflow-hidden">
              <CardContent className="pt-6 space-y-3">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-8 w-28" />
                <Skeleton className="h-3 w-20" />
              </CardContent>
            </Card>
          ))}
        </div>
        <Skeleton className="h-72 w-full" />
      </div>
    )
  }

  const { kpis, ranking, monthlyTrend } = report
  const statesPct = kpis.totalStates > 0 ? Math.round((kpis.totalStatesActive / kpis.totalStates) * 100) : 0
  const rankingChartData = ranking.slice(0, 10).map((r) => ({ name: r.negeri, scans: r.scans }))

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-blue-100 dark:bg-blue-900/30">
            <MapPin className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <h3 className="text-lg font-semibold">Shop by Negeri</h3>
            <p className="text-sm text-muted-foreground">Performance analytics across Malaysia by state</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={handleRefresh} disabled={refreshing}>
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={handleDownloadExcel} disabled={exporting || !selectedPeriod}>
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            Export Report
          </Button>
          <Button size="sm" className="h-9 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white" onClick={handleDownloadExcel} disabled={exporting || !selectedPeriod}>
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}
            Download Excel
          </Button>
        </div>
      </div>

      {/* Filter bar */}
      <Card className="border-0 shadow-sm bg-card/80 backdrop-blur">
        <CardContent className="p-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <ReportingMonthSelector
              id="shop-by-negeri-month"
              month={month}
              onMonthChange={onMonthChange}
              availableMonths={availableMonths}
            />
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Region Type</label>
              <Select value={region} onValueChange={handleRegionChange}>
                <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="All Regions" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Regions</SelectItem>
                  {regions.map((r) => (
                    <SelectItem key={r.id} value={r.id}>{r.region_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Negeri (State)</label>
              <Select value={negeri} onValueChange={handleNegeriChange}>
                <SelectTrigger className="h-9 text-sm"><SelectValue placeholder="All States" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All States</SelectItem>
                  {negeriOptions.map((s) => (
                    <SelectItem key={s.key} value={s.key}>
                      <span className="inline-flex items-center gap-1.5">
                        <StateFlag stateName={s.name} />
                        {s.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Search Negeri</label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  placeholder="Search negeri…"
                  className="h-9 pl-8 text-sm"
                />
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 mt-3 pt-3 border-t border-border">
            <p className="text-xs text-muted-foreground">{dateRangeLabel}</p>
            <p className="text-xs text-muted-foreground">Filters apply automatically</p>
          </div>
        </CardContent>
      </Card>

      {/* KPI cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <Card className="border-0 shadow-lg bg-card/80 backdrop-blur overflow-hidden">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Total States Active</span>
              <div className="p-1.5 rounded-lg bg-blue-100 dark:bg-blue-900/30">
                <MapIcon className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              </div>
            </div>
            <ExecutiveKpiValue>{kpis.totalStatesActive} / {kpis.totalStates}</ExecutiveKpiValue>
            <p className="text-xs text-muted-foreground mt-1">{statesPct}% of Malaysia</p>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-lg bg-card/80 backdrop-blur overflow-hidden">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Total Shops</span>
              <div className="p-1.5 rounded-lg bg-purple-100 dark:bg-purple-900/30">
                <Store className="h-4 w-4 text-purple-600 dark:text-purple-400" />
              </div>
            </div>
            <ExecutiveKpiValue>{kpis.totalShops.toLocaleString()}</ExecutiveKpiValue>
            <p className="text-xs text-muted-foreground mt-1">across all states</p>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-lg bg-card/80 backdrop-blur overflow-hidden">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Total Scans</span>
              <div className="p-1.5 rounded-lg bg-blue-100 dark:bg-blue-900/30">
                <Scan className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              </div>
            </div>
            <ExecutiveKpiValue>{kpis.totalScans.toLocaleString()}</ExecutiveKpiValue>
            <p className="text-xs text-muted-foreground mt-1">in selected period</p>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-lg bg-card/80 backdrop-blur overflow-hidden">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Avg Scans / Shop</span>
              <div className="p-1.5 rounded-lg bg-amber-100 dark:bg-amber-900/30">
                <TrendingUp className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              </div>
            </div>
            <ExecutiveKpiValue>{kpis.avgScansPerShop.toFixed(1)}</ExecutiveKpiValue>
            <p className="text-xs text-muted-foreground mt-1">scans per shop</p>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-lg bg-gradient-to-br from-amber-50 to-white dark:from-amber-900/20 dark:to-card overflow-hidden">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Top Performing Negeri</span>
              <div className="p-1.5 rounded-lg bg-amber-100 dark:bg-amber-900/30">
                <Crown className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              </div>
            </div>
            <ExecutiveKpiValue>
              <span className="inline-flex items-center gap-1.5">
                <StateFlag stateName={kpis.topNegeri} />
                {kpis.topNegeri}
              </span>
            </ExecutiveKpiValue>
            <p className="text-xs text-muted-foreground mt-1">{kpis.topNegeriScans.toLocaleString()} scans</p>
          </CardContent>
        </Card>
      </div>

      {/* Main panels */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Performance by Negeri (Malaysia map; bar chart fallback) */}
        <Card className="border-0 shadow-sm bg-card/80 backdrop-blur lg:col-span-2">
          <CardContent className="p-5">
            <div className="mb-4">
              <h4 className="font-semibold">Performance by Negeri</h4>
              <p className="text-sm text-muted-foreground">Total scans intensity by state</p>
            </div>
            <MalaysiaStateMap
              metricsByKey={metricsByKey}
              selectedKey={selectedKey}
              onSelectState={(stateKey) => setSelectedStateKey(stateKey)}
              isDark={isDark}
              fallback={
                rankingChartData.length === 0 ? (
                  <div className="h-72 flex items-center justify-center text-sm text-muted-foreground">
                    No scan activity for the selected filters.
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={320}>
                    <BarChart data={rankingChartData} layout="vertical" margin={{ left: 8, right: 16 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={chartGridColor} horizontal={false} />
                      <XAxis type="number" tick={{ fill: chartTickColor, fontSize: 12 }} tickFormatter={formatNum} />
                      <YAxis type="category" dataKey="name" width={90} tick={{ fill: chartTickColor, fontSize: 12 }} />
                      <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => [Number(v).toLocaleString(), 'Scans']} />
                      <Bar dataKey="scans" radius={[0, 6, 6, 0]}>
                        {rankingChartData.map((_, i) => (
                          <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )
              }
            />
          </CardContent>
        </Card>

        {/* State Detail panel */}
        <Card className="border-0 shadow-sm bg-card/80 backdrop-blur">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-4">
              <h4 className="font-semibold">State Detail</h4>
              <Select value={activeStateKey || ''} onValueChange={(v) => setSelectedStateKey(v)}>
                <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  {ranking.map((r) => (
                    <SelectItem key={r.stateKey} value={r.stateKey}>
                      <span className="inline-flex items-center gap-1.5">
                        <StateFlag stateName={r.negeri} />
                        {r.negeri}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {!activeStateRow ? (
              <div className="h-48 flex items-center justify-center text-sm text-muted-foreground">
                No state data available.
              </div>
            ) : (
              <>
                <p className="text-sm font-medium mb-1 flex items-center gap-1.5">
                  <StateFlag stateName={activeStateName} />
                  {activeStateName} Overview
                </p>
                <p className="text-xs text-muted-foreground mb-3">Top performing state in this period</p>
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground">Shops</p>
                    <p className="text-lg font-semibold">{activeStateRow.shops.toLocaleString()}</p>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground">Total Scans</p>
                    <p className="text-lg font-semibold">{activeStateRow.scans.toLocaleString()}</p>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground">Consumers</p>
                    <p className="text-lg font-semibold">{activeStateRow.consumers.toLocaleString()}</p>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs text-muted-foreground">Avg / Shop</p>
                    <p className="text-lg font-semibold">{activeStateRow.avgPerShop.toFixed(1)}</p>
                  </div>
                </div>

                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-medium flex items-center gap-1.5">
                    <StateFlag stateName={activeStateName} />
                    Top Shops in {activeStateName}
                  </p>
                </div>
                {activeTopShops.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-4 text-center">No shops with scans.</p>
                ) : (
                  <div className="space-y-2">
                    {activeTopShops.map((s, i) => (
                      <div key={s.shopId} className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-xs text-muted-foreground w-4">{i + 1}</span>
                          <span className="truncate text-blue-600 dark:text-blue-400">{s.shopName}</span>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span className="font-medium">{s.scans.toLocaleString()}</span>
                          <GrowthBadge value={s.growth} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* State Ranking + Monthly Trend */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* State Ranking table */}
        <Card className="border-0 shadow-sm bg-card/80 backdrop-blur lg:col-span-2">
          <CardContent className="p-5">
            <div className="mb-4">
              <h4 className="font-semibold">State Ranking</h4>
              <p className="text-sm text-muted-foreground">Ranked by total scans</p>
            </div>
            {ranking.length === 0 ? (
              <div className="h-40 flex items-center justify-center text-sm text-muted-foreground">
                No states match the current filters.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground border-b border-border">
                      <th className="py-2 pr-2 font-medium">#</th>
                      <th className="py-2 pr-2 font-medium">Negeri</th>
                      <th className="py-2 pr-2 font-medium text-right">Shops</th>
                      <th className="py-2 pr-2 font-medium text-right">Scans</th>
                      <th className="py-2 pr-2 font-medium text-right">Consumers</th>
                      <th className="py-2 pr-2 font-medium text-right">Avg / Shop</th>
                      <th className="py-2 pr-2 font-medium text-right">Growth</th>
                      <th className="py-2 font-medium text-center">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranking.map((r) => (
                      <tr
                        key={r.stateKey}
                        className={`border-b border-border/60 hover:bg-muted/40 transition-colors ${activeStateKey === r.stateKey ? 'bg-blue-50/60 dark:bg-blue-900/10' : ''}`}
                      >
                        <td className="py-2.5 pr-2 text-muted-foreground">{r.rank}</td>
                        <td className="py-2.5 pr-2 font-medium">
                          <span className="inline-flex items-center gap-1.5">
                            <StateFlag stateName={r.negeri} />
                            {r.negeri}
                          </span>
                        </td>
                        <td className="py-2.5 pr-2 text-right">{r.shops.toLocaleString()}</td>
                        <td className="py-2.5 pr-2 text-right">{r.scans.toLocaleString()}</td>
                        <td className="py-2.5 pr-2 text-right">{r.consumers.toLocaleString()}</td>
                        <td className="py-2.5 pr-2 text-right">{r.avgPerShop.toFixed(1)}</td>
                        <td className="py-2.5 pr-2 text-right"><GrowthBadge value={r.growth} /></td>
                        <td className="py-2.5 text-center">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => setSelectedStateKey(r.stateKey)}
                            title="View detail"
                          >
                            <Eye className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Monthly Trend */}
        <Card className="border-0 shadow-sm bg-card/80 backdrop-blur">
          <CardContent className="p-5">
            <div className="mb-4">
              <h4 className="font-semibold">Monthly Trend</h4>
              <p className="text-sm text-muted-foreground">Total scans over time</p>
            </div>
            {monthlyTrend.every((m) => m.scans === 0) ? (
              <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">
                No scan history available.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={monthlyTrend} margin={{ left: -16, right: 8 }}>
                  <defs>
                    <linearGradient id="negeriTrend" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke={chartGridColor} />
                  <XAxis dataKey="monthLabel" tick={{ fill: chartTickColor, fontSize: 11 }} tickFormatter={(v) => String(v).split(' ')[0]} />
                  <YAxis tick={{ fill: chartTickColor, fontSize: 11 }} tickFormatter={formatNum} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => [Number(v).toLocaleString(), 'Scans']} />
                  <Area type="monotone" dataKey="scans" stroke="#3b82f6" strokeWidth={2} fill="url(#negeriTrend)" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
