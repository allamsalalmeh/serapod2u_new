'use client'

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, PieChart, Pie, AreaChart, Area,
} from 'recharts'
import {
  RefreshCw, Loader2, TrendingUp, TrendingDown, Download, AlertCircle,
  Store, Users, Scan, Target, Crown, Eye,
  ArrowUpRight, ArrowDownRight, ChevronRight,
} from 'lucide-react'
import { format } from 'date-fns'
import ExecutiveKpiValue from './ExecutiveKpiValue'
import ReportingMonthSelector from './ReportingMonthSelector'
import {
  buildShopPerformanceReport,
  readShopScans,
  resolveShopPerformancePeriod,
  type ShopInfoRow,
} from '@/lib/reporting/shop-performance'
import type { NegeriStateRow } from '@/lib/reporting/shop-by-negeri'

// ── Types ──────────────────────────────────────────────────────────────
interface ShopPerformanceTabProps {
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

interface ScanRow {
  id: string
  consumer_id: string | null
  scanned_at: string | null
  shop_id: string | null
  collected_points: boolean
  points_amount: number | null
}

type ShopInfo = ShopInfoRow

interface ShopContact {
  organization_id: string | null
  full_name: string | null
  phone: string | null
  email: string | null
  role_code: string | null
  is_active: boolean | null
}

interface ConsumerProfile {
  id: string
  full_name: string | null
  phone: string | null
  email: string | null
}

interface ContactLines {
  phone: string
  email: string
}

function formatContactLines(phone?: string | null, email?: string | null): ContactLines {
  return {
    phone: phone || '-',
    email: email || '-',
  }
}

// ── Constants ──────────────────────────────────────────────────────────
const COLORS = {
  primary: '#3b82f6',
  success: '#10b981',
  warning: '#f59e0b',
  danger: '#ef4444',
  purple: '#8b5cf6',
  cyan: '#06b6d4',
  indigo: '#6366f1',
  pink: '#ec4899',
}

const CHART_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#6366f1', '#ef4444', '#14b8a6', '#f97316']

// ── Helpers ────────────────────────────────────────────────────────────
function AnimatedCounter({ value, prefix = '', suffix = '', decimals = 0 }: {
  value: number; prefix?: string; suffix?: string; decimals?: number
}) {
  const [display, setDisplay] = useState(0)
  useEffect(() => {
    let raf: number
    const t0 = performance.now()
    const tick = (now: number) => {
      const p = Math.min((now - t0) / 900, 1)
      const ease = 1 - Math.pow(1 - p, 4)
      setDisplay(ease * value)
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [value])
  return <span>{prefix}{display.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}{suffix}</span>
}

function formatNum(val: number): string {
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}K`
  return val.toLocaleString()
}

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-muted ${className}`} />
}

// ── Main Component ─────────────────────────────────────────────────────
export default function ShopPerformanceTab({
  userProfile, chartGridColor, chartTickColor, isDark,
  month, onMonthChange, availableMonths, onRefreshPeriods,
}: ShopPerformanceTabProps) {
  const supabase = useMemo(() => createClient(), [])

  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [scans, setScans] = useState<ScanRow[]>([])
  const [scansMonth, setScansMonth] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [states, setStates] = useState<NegeriStateRow[]>([])
  const requestId = useRef(0)
  const [shops, setShops] = useState<Map<string, ShopInfo>>(new Map())
  const [shopContacts, setShopContacts] = useState<Map<string, ShopContact>>(new Map())
  const [consumerProfiles, setConsumerProfiles] = useState<Map<string, ConsumerProfile>>(new Map())
  const [drillShopId, setDrillShopId] = useState<string | null>(null)
  const [detailDialog, setDetailDialog] = useState<'shops' | 'consumers' | null>(null)
  const [detailSearch, setDetailSearch] = useState('')

  const tooltipBg = isDark ? '#1f2937' : '#ffffff'
  const tooltipStyle = {
    borderRadius: '12px',
    border: 'none',
    boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
    backgroundColor: tooltipBg,
    color: isDark ? '#f3f4f6' : undefined,
  }

  // ── Data Fetching ────────────────────────────────────────────────────
  // A slower earlier request must never overwrite a newer month: every state
  // write below is dropped unless it belongs to the latest request.
  const fetchData = useCallback(async () => {
    const id = ++requestId.current
    const isLatest = () => id === requestId.current
    try {
      setError(null)
      const period = resolveShopPerformancePeriod(month)
      // The same half-open Malaysia-time window drives every metric; it is read
      // page by page so a busy month is never truncated by the row cap.
      const [scanData, stateResult] = await Promise.all([
        readShopScans(supabase, period.startUtc, period.endUtc),
        supabase.from('states').select('id, state_name, region_id').order('state_name'),
      ])
      if (!isLatest()) return
      setStates(((stateResult as any).data as NegeriStateRow[]) || [])

      {
        setScans(scanData as unknown as ScanRow[])
        setScansMonth(month)

        // Fetch shop info for all referenced shop_ids
        const shopIds = [...new Set((scanData as any[]).map(s => s.shop_id).filter(Boolean))]
        const consumerIds = [...new Set((scanData as any[]).map(s => s.consumer_id).filter(Boolean))]
        if (shopIds.length > 0) {
          const shopMap = new Map<string, ShopInfo>()
          const batchSize = 200
          for (let i = 0; i < shopIds.length; i += batchSize) {
            const batch = shopIds.slice(i, i + batchSize)
            const { data: orgData } = await supabase
              .from('organizations')
              .select('id, org_name, org_code, branch, state_id')
              .in('id', batch)
            if (orgData) {
              (orgData as any[]).forEach(o => shopMap.set(o.id, o))
            }
          }
          if (!isLatest()) return
          setShops(shopMap)

          const contactMap = new Map<string, ShopContact>()
          for (let i = 0; i < shopIds.length; i += batchSize) {
            const batch = shopIds.slice(i, i + batchSize)
            const { data: userData } = await supabase
              .from('users')
              .select('organization_id, full_name, phone, email, role_code, is_active')
              .in('organization_id', batch)

            if (userData) {
              ; (userData as ShopContact[]).forEach((user) => {
                if (!user.organization_id) return
                const existing = contactMap.get(user.organization_id)
                const existingScore = existing
                  ? Number(existing.is_active) * 4 + Number(Boolean(existing.full_name)) * 3 + Number(Boolean(existing.phone || existing.email)) * 2 + Number(existing.role_code !== 'GUEST')
                  : -1
                const nextScore = Number(user.is_active) * 4 + Number(Boolean(user.full_name)) * 3 + Number(Boolean(user.phone || user.email)) * 2 + Number(user.role_code !== 'GUEST')
                if (!existing || nextScore > existingScore) {
                  contactMap.set(user.organization_id, user)
                }
              })
            }
          }
          if (!isLatest()) return
          setShopContacts(contactMap)
        } else {
          setShops(new Map())
          setShopContacts(new Map())
        }

        if (consumerIds.length > 0) {
          const profileMap = new Map<string, ConsumerProfile>()
          const batchSize = 200
          for (let i = 0; i < consumerIds.length; i += batchSize) {
            const batch = consumerIds.slice(i, i + batchSize)
            const { data: userData } = await supabase
              .from('users')
              .select('id, full_name, phone, email')
              .in('id', batch)

            if (userData) {
              ; (userData as ConsumerProfile[]).forEach((user) => {
                profileMap.set(user.id, user)
              })
            }
          }
          if (!isLatest()) return
          setConsumerProfiles(profileMap)
        } else {
          setConsumerProfiles(new Map())
        }
      }
    } catch (err: any) {
      console.error('ShopPerformanceTab fetch error:', err)
      // Never show the previous month's numbers under the new month's label.
      if (isLatest()) {
        setScans([])
        setScansMonth(null)
        setError(err?.message || 'Unable to load shop performance')
      }
    }
  }, [supabase, month])

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

  // ── Period scans ─────────────────────────────────────────────────────
  const periodScans = scans

  // ── Report: the one DTO the cards, charts and PDF all read ───────────
  const report = useMemo(
    () => buildShopPerformanceReport({ month: scansMonth ?? month, scans: periodScans, shops, states }),
    [scansMonth, month, periodScans, shops, states],
  )
  const kpis = report.kpis
  const top10Shops = useMemo(() => report.shopRanking.slice(0, 10), [report])

  // ── Drill-down: consumers for selected shop ──────────────────────────
  const drillData = useMemo(() => {
    if (!drillShopId) return null
    const shopScans = periodScans.filter(s => s.shop_id === drillShopId)
    const consumerMap = new Map<string, { scans: number; points: number; lastScan: string }>()

    shopScans.forEach(s => {
      const cid = s.consumer_id || 'anonymous'
      if (!consumerMap.has(cid)) consumerMap.set(cid, { scans: 0, points: 0, lastScan: '' })
      const entry = consumerMap.get(cid)!
      entry.scans++
      entry.points += (s.points_amount || 0)
      if (s.scanned_at && s.scanned_at > entry.lastScan) entry.lastScan = s.scanned_at
    })

    return [...consumerMap.entries()]
      .map(([consumerId, data]) => {
        const profile = consumerId !== 'anonymous' ? consumerProfiles.get(consumerId) : null
        const contactLines = formatContactLines(profile?.phone, profile?.email)

        return {
          consumerId,
          consumerName: consumerId === 'anonymous' ? 'Anonymous' : (profile?.full_name || 'Unnamed Consumer'),
          phone: contactLines.phone,
          email: contactLines.email,
          ...data,
        }
      })
      .sort((a, b) => b.scans - a.scans)
      .slice(0, 20)
  }, [drillShopId, periodScans, consumerProfiles])

  const monthlyTrend = report.dailyTrend
  const shopDistribution = useMemo(() => report.sizeDistribution.filter((band) => band.count > 0), [report])
  const periodLabel = report.period.label

  const handleDownloadPdf = async () => {
    setDownloading(true)
    try {
      const { buildShopPerformancePdf } = await import('@/lib/reporting/shop-performance-pdf')
      const pdf = await buildShopPerformancePdf(report, {
        generatedAt: new Date().toISOString(),
        generatedBy: userProfile?.full_name || userProfile?.email || null,
        scopeLabel: 'All shops',
      })
      const url = URL.createObjectURL(pdf.blob)
      const link = document.createElement('a')
      link.href = url
      link.download = pdf.filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err: any) {
      setError(err?.message || 'Unable to generate the PDF report')
    } finally {
      setDownloading(false)
    }
  }

  const activeShopRows = useMemo(() => {
    const shopMap = new Map<string, {
      shopId: string
      shopName: string
      contactName: string
      contactPhone: string
      contactEmail: string
      totalScans: number
      lastScanDate: string | null
      pointsIssued: number
      status: string
    }>()

    periodScans.forEach((scan) => {
      if (!scan.shop_id) return
      const info = shops.get(scan.shop_id)
      const contact = shopContacts.get(scan.shop_id)
      const existing = shopMap.get(scan.shop_id)
      const contactLines = formatContactLines(contact?.phone, contact?.email)
      const nextLastScan = !existing?.lastScanDate || (scan.scanned_at && scan.scanned_at > existing.lastScanDate)
        ? scan.scanned_at
        : existing?.lastScanDate || null

      shopMap.set(scan.shop_id, {
        shopId: scan.shop_id,
        shopName: info ? `${info.org_name}${info.branch ? ` (${info.branch})` : ''}` : 'Unknown Shop',
        contactName: contact?.full_name || '—',
        contactPhone: contactLines.phone,
        contactEmail: contactLines.email,
        totalScans: (existing?.totalScans || 0) + 1,
        lastScanDate: nextLastScan || null,
        pointsIssued: (existing?.pointsIssued || 0) + (scan.points_amount || 0),
        status: 'Active',
      })
    })

    return Array.from(shopMap.values()).sort((left, right) => right.totalScans - left.totalScans)
  }, [periodScans, shops, shopContacts])

  const consumerRows = useMemo(() => {
    const consumerMap = new Map<string, {
      consumerId: string
      consumerName: string
      phone: string
      email: string
      shopName: string
      totalScans: number
      firstScanDate: string | null
      lastScanDate: string | null
      pointsIssued: number
      status: string
    }>()

    periodScans.forEach((scan) => {
      if (!scan.consumer_id) return
      const profile = consumerProfiles.get(scan.consumer_id)
      const contactLines = formatContactLines(profile?.phone, profile?.email)
      const shopInfo = scan.shop_id ? shops.get(scan.shop_id) : null
      const shopName = shopInfo ? `${shopInfo.org_name}${shopInfo.branch ? ` (${shopInfo.branch})` : ''}` : '—'
      const existing = consumerMap.get(scan.consumer_id)

      consumerMap.set(scan.consumer_id, {
        consumerId: scan.consumer_id,
        consumerName: profile?.full_name || '—',
        phone: contactLines.phone,
        email: contactLines.email,
        shopName: scan.scanned_at && (!existing?.lastScanDate || scan.scanned_at >= existing.lastScanDate) ? shopName : existing?.shopName || shopName,
        totalScans: (existing?.totalScans || 0) + 1,
        firstScanDate: !existing?.firstScanDate || (scan.scanned_at && scan.scanned_at < existing.firstScanDate)
          ? scan.scanned_at
          : existing.firstScanDate,
        lastScanDate: !existing?.lastScanDate || (scan.scanned_at && scan.scanned_at > existing.lastScanDate)
          ? scan.scanned_at
          : existing.lastScanDate,
        pointsIssued: (existing?.pointsIssued || 0) + (scan.points_amount || 0),
        status: 'Active',
      })
    })

    return Array.from(consumerMap.values()).sort((left, right) => right.totalScans - left.totalScans)
  }, [periodScans, consumerProfiles, shops])

  const filteredActiveShopRows = useMemo(() => {
    const query = detailSearch.trim().toLowerCase()
    if (!query || detailDialog !== 'shops') return activeShopRows
    return activeShopRows.filter((row) =>
      [row.shopName, row.contactName, row.contactPhone, row.contactEmail, row.status]
        .join(' ')
        .toLowerCase()
        .includes(query)
    )
  }, [activeShopRows, detailDialog, detailSearch])

  const filteredConsumerRows = useMemo(() => {
    const query = detailSearch.trim().toLowerCase()
    if (!query || detailDialog !== 'consumers') return consumerRows
    return consumerRows.filter((row) =>
      [row.consumerName, row.phone, row.email, row.shopName, row.status]
        .join(' ')
        .toLowerCase()
        .includes(query)
    )
  }, [consumerRows, detailDialog, detailSearch])

  const openDetailDialog = (view: 'shops' | 'consumers') => {
    setDetailSearch('')
    setDetailDialog(view)
  }

  // ── Render ───────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[1, 2, 3, 4].map(i => (
            <Card key={i} className="border-0 bg-card/80 backdrop-blur overflow-hidden">
              <CardContent className="pt-6 space-y-3">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-8 w-32" />
                <Skeleton className="h-3 w-20" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    )
  }

  const drillShopInfo = drillShopId ? shops.get(drillShopId) : null

  return (
    <div className="space-y-6">
      {/* Period & Refresh */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex items-center gap-3">
          <Store className="h-5 w-5 text-purple-600" />
          <h3 className="text-lg font-semibold">Shop Performance</h3>
        </div>
        <div className="flex w-full flex-col gap-3 lg:w-auto lg:flex-row lg:items-end">
          <ReportingMonthSelector
            id="shop-performance-month"
            month={month}
            onMonthChange={onMonthChange}
            availableMonths={availableMonths}
            caption={(
              <>
                <span className="font-medium text-[var(--sera-ink)]">{report.period.rangeLabel}</span>
                {report.period.isCurrentMonth ? ' (month to date)' : ''}
              </>
            )}
          />
          <div className="flex items-center gap-2 lg:pb-[18px]">
            <Button variant="outline" className="h-10 flex-1 gap-1.5 border-[var(--sera-line)] lg:h-9 lg:flex-none" onClick={handleRefresh} disabled={refreshing}>
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button
              variant="outline"
              className="h-10 flex-1 gap-2 border-[var(--sera-line)] lg:h-9 lg:flex-none"
              onClick={handleDownloadPdf}
              disabled={downloading || loading || Boolean(error)}
              title="Download the Shop Performance report for the selected month"
            >
              {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              <span className="whitespace-nowrap">Download PDF</span>
            </Button>
          </div>
        </div>
      </div>
      {error ? (
        <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          <Button variant="outline" size="sm" onClick={handleRefresh} className="shrink-0 border-red-300 text-red-700 hover:bg-red-100">Retry</Button>
        </div>
      ) : report.isEmpty ? (
        <div className="rounded-xl border border-[var(--sera-line)] bg-[var(--sera-mist)] p-4 text-sm text-[var(--sera-muted)]">
          No shop scans were recorded in {report.period.label}. Choose another Reporting Month to review a period with activity.
        </div>
      ) : null}

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <Card className="border-0 shadow-lg bg-card/80 backdrop-blur overflow-hidden transition-all hover:-translate-y-0.5 hover:shadow-xl hover:ring-2 hover:ring-purple-400/30">
          <button
            type="button"
            onClick={() => openDetailDialog('shops')}
            className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500 focus-visible:ring-offset-2"
          >
            <CardContent className="pt-5 pb-4 cursor-pointer">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Active Shops</span>
                <div className="p-1.5 rounded-lg bg-purple-100 dark:bg-purple-900/30">
                  <Store className="h-4 w-4 text-purple-600 dark:text-purple-400" />
                </div>
              </div>
              <ExecutiveKpiValue><AnimatedCounter value={kpis.activeShops} /></ExecutiveKpiValue>
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">with scans in period <Eye className="h-3 w-3" /></p>
            </CardContent>
          </button>
        </Card>
        <Card className="border-0 shadow-lg bg-card/80 backdrop-blur overflow-hidden">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Total Scans</span>
              <div className="p-1.5 rounded-lg bg-blue-100 dark:bg-blue-900/30">
                <Scan className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              </div>
            </div>
            <ExecutiveKpiValue><AnimatedCounter value={kpis.totalScans} /></ExecutiveKpiValue>
            <p className="text-xs text-muted-foreground mt-1">across all shops</p>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-lg bg-card/80 backdrop-blur overflow-hidden transition-all hover:-translate-y-0.5 hover:shadow-xl hover:ring-2 hover:ring-green-400/30">
          <button
            type="button"
            onClick={() => openDetailDialog('consumers')}
            className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2"
          >
            <CardContent className="pt-5 pb-4 cursor-pointer">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Consumers</span>
                <div className="p-1.5 rounded-lg bg-green-100 dark:bg-green-900/30">
                  <Users className="h-4 w-4 text-green-600 dark:text-green-400" />
                </div>
              </div>
              <ExecutiveKpiValue><AnimatedCounter value={kpis.uniqueConsumers} /></ExecutiveKpiValue>
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">unique consumers <Eye className="h-3 w-3" /></p>
            </CardContent>
          </button>
        </Card>
        <Card className="border-0 shadow-lg bg-card/80 backdrop-blur overflow-hidden">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Points Issued</span>
              <div className="p-1.5 rounded-lg bg-amber-100 dark:bg-amber-900/30">
                <Target className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              </div>
            </div>
            <ExecutiveKpiValue><AnimatedCounter value={kpis.pointsIssued} /></ExecutiveKpiValue>
            <p className="text-xs text-muted-foreground mt-1">total points</p>
          </CardContent>
        </Card>
        <Card className="border-0 shadow-lg bg-card/80 backdrop-blur overflow-hidden">
          <CardContent className="pt-5 pb-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Avg / Shop</span>
              <div className="p-1.5 rounded-lg bg-cyan-100 dark:bg-cyan-900/30">
                <TrendingUp className="h-4 w-4 text-cyan-600 dark:text-cyan-400" />
              </div>
            </div>
            <ExecutiveKpiValue><AnimatedCounter value={kpis.avgScansPerShop} decimals={1} /></ExecutiveKpiValue>
            <p className="text-xs text-muted-foreground mt-1">scans per shop</p>
          </CardContent>
        </Card>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Monthly Trend */}
        <Card className="lg:col-span-2 border-0 shadow-lg bg-card/80 backdrop-blur">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg font-semibold">Daily Shop Activity</CardTitle>
            <CardDescription>Scans and active shops during {report.period.label}{report.period.isCurrentMonth ? ' (to date)' : ''}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={monthlyTrend}>
                  <defs>
                    <linearGradient id="colorShopScans" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.primary} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={COLORS.primary} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chartGridColor} />
                  <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fill: chartTickColor, fontSize: 12 }} />
                  <YAxis tickLine={false} axisLine={false} tick={{ fill: chartTickColor, fontSize: 12 }} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Area type="monotone" dataKey="scans" stroke={COLORS.primary} strokeWidth={2} fill="url(#colorShopScans)" name="Scans" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Shop Distribution Pie */}
        <Card className="border-0 shadow-lg bg-card/80 backdrop-blur">
          <CardHeader className="pb-2">
            <CardTitle className="text-lg font-semibold">Shop Size Distribution</CardTitle>
            <CardDescription>Shops grouped by scan volume</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={shopDistribution}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={80}
                    paddingAngle={4}
                    dataKey="count"
                    stroke="none"
                  >
                    {shopDistribution.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} formatter={(value: number) => [value, 'Shops']} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="space-y-2 mt-3">
              {shopDistribution.map((item, i) => (
                <div key={i} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }} />
                    <span className="text-sm text-muted-foreground">{item.name}</span>
                  </div>
                  <span className="text-sm font-semibold">{item.count} shop{item.count !== 1 ? 's' : ''}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Top 10 Shops */}
      <Card className="border-0 shadow-lg bg-card/80 backdrop-blur">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg font-semibold flex items-center gap-2">
                <Crown className="h-5 w-5 text-amber-500" />
                Top 10 Shops
              </CardTitle>
              <CardDescription>Ranked by scan volume • Click to drill down</CardDescription>
            </div>
            {drillShopId && (
              <Button variant="outline" size="sm" onClick={() => setDrillShopId(null)} className="gap-1.5 text-xs">
                ← Back to Top 10
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {!drillShopId ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Bar Chart */}
              <div className="h-[350px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={top10Shops} layout="vertical" margin={{ left: 10, right: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal vertical={false} stroke={chartGridColor} />
                    <XAxis type="number" hide />
                    <YAxis
                      dataKey="name"
                      type="category"
                      width={140}
                      tick={{ fontSize: 11, fill: chartTickColor }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip contentStyle={tooltipStyle} formatter={(value: number) => [value.toLocaleString(), 'Scans']} />
                    <Bar dataKey="scans" radius={[0, 8, 8, 0]} barSize={22} cursor="pointer"
                      onClick={(data: any) => {
                        const shopId = data?.shopId || data?.payload?.shopId
                        if (typeof shopId === 'string' && shopId) setDrillShopId(shopId)
                      }}
                    >
                      {top10Shops.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2 text-xs font-semibold uppercase text-muted-foreground">#</th>
                      <th className="text-left py-2 text-xs font-semibold uppercase text-muted-foreground">Shop</th>
                      <th className="text-right py-2 text-xs font-semibold uppercase text-muted-foreground">Scans</th>
                      <th className="text-right py-2 text-xs font-semibold uppercase text-muted-foreground">Consumers</th>
                      <th className="text-right py-2 text-xs font-semibold uppercase text-muted-foreground">Points</th>
                      <th className="py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {top10Shops.map((shop, i) => (
                      <tr key={shop.shopId} className="hover:bg-muted/30 transition-colors cursor-pointer" onClick={() => setDrillShopId(shop.shopId)}>
                        <td className="py-2.5 text-muted-foreground">{i + 1}</td>
                        <td className="py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }} />
                            <span className="font-medium">{shop.name}</span>
                          </div>
                        </td>
                        <td className="py-2.5 text-right font-semibold">{shop.scans.toLocaleString()}</td>
                        <td className="py-2.5 text-right">{shop.consumers}</td>
                        <td className="py-2.5 text-right">{shop.points.toLocaleString()}</td>
                        <td className="py-2.5 text-right"><ChevronRight className="h-4 w-4 text-muted-foreground" /></td>
                      </tr>
                    ))}
                    {top10Shops.length === 0 && (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-muted-foreground">
                          No shop scan data for this period
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            /* Drill-down: Top consumers for selected shop */
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Store className="h-4 w-4 text-purple-600" />
                <span className="font-semibold">
                  {drillShopInfo ? `${drillShopInfo.org_name}${drillShopInfo.branch ? ` (${drillShopInfo.branch})` : ''}` : drillShopId.slice(0, 8)}
                </span>
                <Badge variant="secondary" className="text-xs">
                  {periodScans.filter(s => s.shop_id === drillShopId).length} scans
                </Badge>
              </div>

              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 border-b">
                    <tr>
                      <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase text-muted-foreground">#</th>
                      <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase text-muted-foreground">Consumer Name</th>
                      <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase text-muted-foreground">Scans</th>
                      <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase text-muted-foreground">Points</th>
                      <th className="px-3 py-2.5 text-right text-xs font-semibold uppercase text-muted-foreground">Last Scan</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {drillData?.map((c, i) => (
                      <tr key={c.consumerId} className="hover:bg-muted/30">
                        <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                        <td className="px-3 py-2 font-medium">
                          <div>
                            <div className={c.consumerId === 'anonymous' ? 'text-muted-foreground italic' : ''}>{c.consumerName}</div>
                            {c.consumerId !== 'anonymous' && (c.phone !== '-' || c.email !== '-') && (
                              <div className="mt-0.5 text-xs font-normal text-muted-foreground">
                                <div>{c.phone}</div>
                                <div>{c.email}</div>
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right font-semibold">{c.scans}</td>
                        <td className="px-3 py-2 text-right">{c.points.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">
                          {c.lastScan ? format(new Date(c.lastScan), 'dd MMM yyyy HH:mm') : '—'}
                        </td>
                      </tr>
                    ))}
                    {(!drillData || drillData.length === 0) && (
                      <tr>
                        <td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">
                          No consumer data
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={detailDialog !== null} onOpenChange={(open) => { if (!open) setDetailDialog(null) }}>
        <DialogContent className="max-w-6xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>
              {detailDialog === 'shops'
                ? `Active Shops (${activeShopRows.length})`
                : `Consumers (${consumerRows.length})`}
            </DialogTitle>
            <DialogDescription>
              {periodLabel}
              {detailDialog === 'shops'
                ? ' • Shops with scan activity in the selected reporting period'
                : ' • Consumers active in the selected reporting period'}
            </DialogDescription>
          </DialogHeader>

          <div className="relative mb-3">
            <Input
              placeholder={detailDialog === 'shops' ? 'Search shops, contact, phone, or email...' : 'Search consumers, phone, email, or shop...'}
              value={detailSearch}
              onChange={(event) => setDetailSearch(event.target.value)}
              className="pl-3"
            />
          </div>

          <div className="flex-1 min-h-0 overflow-auto rounded-lg border">
            {loading || refreshing ? (
              <div className="flex h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading detail records...
              </div>
            ) : detailDialog === 'shops' ? (
              filteredActiveShopRows.length === 0 ? (
                <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
                  No active shops found for this period.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-background z-10 border-b">
                    <tr className="text-xs font-semibold uppercase text-muted-foreground">
                      <th className="px-3 py-2.5 text-left">Shop Name</th>
                      <th className="px-3 py-2.5 text-left">Owner / Contact</th>
                      <th className="px-3 py-2.5 text-left">Phone / Email</th>
                      <th className="px-3 py-2.5 text-right">Total Scans</th>
                      <th className="px-3 py-2.5 text-right">Last Scan Date</th>
                      <th className="px-3 py-2.5 text-right">Points Issued</th>
                      <th className="px-3 py-2.5 text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {filteredActiveShopRows.map((row) => (
                      <tr key={row.shopId} className="hover:bg-muted/30">
                        <td className="px-3 py-2.5 font-medium">{row.shopName}</td>
                        <td className="px-3 py-2.5">{row.contactName}</td>
                        <td className="px-3 py-2.5 text-muted-foreground">
                          <div className="space-y-0.5">
                            <div>{row.contactPhone}</div>
                            <div>{row.contactEmail}</div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right font-semibold">{row.totalScans.toLocaleString()}</td>
                        <td className="px-3 py-2.5 text-right text-muted-foreground">{row.lastScanDate ? format(new Date(row.lastScanDate), 'dd MMM yyyy HH:mm') : '—'}</td>
                        <td className="px-3 py-2.5 text-right">{row.pointsIssued.toLocaleString()}</td>
                        <td className="px-3 py-2.5 text-right"><Badge variant="secondary">{row.status}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : filteredConsumerRows.length === 0 ? (
              <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
                No consumers found for this period.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-background z-10 border-b">
                  <tr className="text-xs font-semibold uppercase text-muted-foreground">
                    <th className="px-3 py-2.5 text-left">Consumer Name</th>
                    <th className="px-3 py-2.5 text-left">Phone / Email</th>
                    <th className="px-3 py-2.5 text-left">Shop Name</th>
                    <th className="px-3 py-2.5 text-right">Total Scans</th>
                    <th className="px-3 py-2.5 text-right">First Scan Date</th>
                    <th className="px-3 py-2.5 text-right">Last Scan Date</th>
                    <th className="px-3 py-2.5 text-right">Points / Rewards</th>
                    <th className="px-3 py-2.5 text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {filteredConsumerRows.map((row) => (
                    <tr key={row.consumerId} className="hover:bg-muted/30">
                      <td className="px-3 py-2.5 font-medium">{row.consumerName}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">
                        <div className="space-y-0.5">
                          <div>{row.phone}</div>
                          <div>{row.email}</div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">{row.shopName}</td>
                      <td className="px-3 py-2.5 text-right font-semibold">{row.totalScans.toLocaleString()}</td>
                      <td className="px-3 py-2.5 text-right text-muted-foreground">{row.firstScanDate ? format(new Date(row.firstScanDate), 'dd MMM yyyy HH:mm') : '—'}</td>
                      <td className="px-3 py-2.5 text-right text-muted-foreground">{row.lastScanDate ? format(new Date(row.lastScanDate), 'dd MMM yyyy HH:mm') : '—'}</td>
                      <td className="px-3 py-2.5 text-right">{row.pointsIssued.toLocaleString()}</td>
                      <td className="px-3 py-2.5 text-right"><Badge variant="secondary">{row.status}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
