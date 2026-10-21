'use client'

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ComposedChart,
  Line,
  PieChart,
  Pie,
  Cell,
} from 'recharts'
import { motion, AnimatePresence } from 'framer-motion'
import {
  RefreshCw,
  Loader2,
  TrendingUp,
  TrendingDown,
  ArrowUpRight,
  ArrowDownRight,
  Clock,
  Zap,
  Activity,
  AlertTriangle,
  CheckCircle2,
  Package,
  Truck,
  BoxIcon,
  ChevronRight,
  BarChart3,
  PieChart as PieChartIcon,
  ArrowRight,
  AlertCircle,
  ShoppingCart,
} from 'lucide-react'
import { SeraLoadingState } from '@/components/ui/SeraLoader'
import {
  differenceInHours,
  startOfDay,
  endOfDay,
} from 'date-fns'
import { addDaysToDateKey, malaysiaDateOf } from '@/lib/orders/order-date'
import { currentReportingMonthKey } from '@/lib/reporting/consumer-analytics'
import { formatReportDate, resolveProductReportPeriod } from '@/lib/reporting/product-analytics'
import ExecutiveKpiValue from './ExecutiveKpiValue'
import ReportingMonthSelector from './ReportingMonthSelector'

// ── Types ──────────────────────────────────────────────────────────────────
interface OperationsTabProps {
  userProfile: any
  chartGridColor: string
  chartTickColor: string
  isDark: boolean
  /** Dashboard-level Reporting Month; the tab keeps its own when rendered alone. */
  month?: string
  onMonthChange?: (month: string) => void
}

interface OrderRow {
  id: string
  order_no: string
  order_type: string
  status: string
  created_at: string
  updated_at: string
  approved_at: string | null
  buyer_org_id: string | null
  seller_org_id: string | null
  warehouse_org_id: string | null
}

interface DocumentRow {
  id: string
  doc_type: string
  status: string
  order_id: string | null
  created_at: string
}

interface PipelineStage {
  status: string
  label: string
  count: number
  percentage: number
  color: string
  icon: React.ReactNode
}

interface Bottleneck {
  severity: 'amber' | 'red'
  title: string
  description: string
  count: number
  oldestAge: number
  unit: string
}

interface MonthlyThroughput {
  month: string
  created: number
  closed: number
}

// ── Constants ──────────────────────────────────────────────────────────────
const COLORS = {
  primary: '#e85d04',
  success: '#059669',
  warning: '#d97706',
  danger: '#dc2626',
  purple: '#7c3aed',
  cyan: '#0891b2',
  indigo: '#6366f1',
  pink: '#db2777',
}

const STATUS_COLORS: Record<string, string> = {
  draft: COLORS.primary,
  submitted: COLORS.warning,
  approved: COLORS.purple,
  closed: COLORS.success,
}

// ── Helpers ────────────────────────────────────────────────────────────────
/**
 * Operations measure order ENTRY and processing, so they bucket on
 * `created_at` (Malaysia time) rather than the SO business date. The window is
 * the shared monthly one: a historical month is the whole month, the current
 * month runs to today and compares with the same elapsed days of last month.
 */
const PAGE_SIZE = 1000

async function readAllPages<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1)
    if (error) throw error
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE_SIZE) return out
  }
}

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

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-muted ${className}`} />
}

function KPICardSkeleton() {
  return (
    <Card className="sera-sc-panel overflow-hidden">
      <CardContent className="pt-6 space-y-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-3 w-20" />
      </CardContent>
    </Card>
  )
}

function ChartSkeleton({ height = 'h-64' }: { height?: string }) {
  return <Skeleton className={`w-full ${height}`} />
}

function formatDuration(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`
  if (hours < 24) return `${hours.toFixed(1)}h`
  const days = hours / 24
  return `${days.toFixed(1)}d`
}

function calcDelta(current: number, previous: number): { delta: number; isPositive: boolean } {
  if (previous === 0) return { delta: current > 0 ? 100 : 0, isPositive: current >= 0 }
  const delta = ((current - previous) / previous) * 100
  return { delta: Math.abs(delta), isPositive: delta >= 0 }
}

// Custom chart tooltip
function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-xl border border-border/50 bg-popover/95 backdrop-blur-md p-3 shadow-xl text-sm">
      <p className="font-medium text-foreground mb-1.5">{label}</p>
      {payload.map((entry: any, i: number) => (
        <div key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: entry.color }} />
          <span>{entry.name}:</span>
          <span className="font-semibold text-foreground">{typeof entry.value === 'number' ? entry.value.toLocaleString() : entry.value}</span>
        </div>
      ))}
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────
export default function OperationsTab({ userProfile, chartGridColor, chartTickColor, isDark, month: monthProp, onMonthChange }: OperationsTabProps) {
  const supabase = createClient()

  // State
  const [localMonth, setLocalMonth] = useState<string>(() => currentReportingMonthKey())
  const month = monthProp ?? localMonth
  const setMonth = onMonthChange ?? setLocalMonth
  const period = useMemo(() => resolveProductReportPeriod(month), [month])
  const requestId = useRef(0)
  const [earliestMonth, setEarliestMonth] = useState<string | null>(null)

  // The first order the caller can see starts the supported month range.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { data } = await supabase.from('orders').select('created_at').order('created_at', { ascending: true }).limit(1)
      const first = (data as { created_at: string }[] | null)?.[0]?.created_at
      if (!cancelled && first) setEarliestMonth(malaysiaDateOf(first)?.slice(0, 7) ?? null)
    })()
    return () => { cancelled = true }
  }, [supabase])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [prevOrders, setPrevOrders] = useState<OrderRow[]>([])
  const [documents, setDocuments] = useState<DocumentRow[]>([])
  const [error, setError] = useState<string | null>(null)

  // ── Data fetching ──────────────────────────────────────────────────────
  const fetchData = useCallback(async (showRefresh = false) => {
    try {
      if (showRefresh) setRefreshing(true)
      else setLoading(true)
      setError(null)

      const id = ++requestId.current
      const select = 'id, order_no, order_type, status, created_at, updated_at, approved_at, buyer_org_id, seller_org_id, warehouse_org_id'
      const [orderRows, prevOrderRows, docRows] = await Promise.all([
        readAllPages<OrderRow>((from, to) => supabase
          .from('orders').select(select)
          .gte('created_at', period.startUtc).lt('created_at', period.endUtc)
          .order('created_at', { ascending: false }).order('id', { ascending: true })
          .range(from, to) as any),
        readAllPages<OrderRow>((from, to) => supabase
          .from('orders').select(select)
          .gte('created_at', period.comparisonStartUtc).lt('created_at', period.comparisonEndUtc)
          .order('created_at', { ascending: false }).order('id', { ascending: true })
          .range(from, to) as any),
        readAllPages<DocumentRow>((from, to) => supabase
          .from('documents').select('id, doc_type, status, order_id, created_at')
          .gte('created_at', period.startUtc).lt('created_at', period.endUtc)
          .order('created_at', { ascending: false }).order('id', { ascending: true })
          .range(from, to) as any),
      ])
      // A slower earlier month must never overwrite the one now selected.
      if (id !== requestId.current) return
      setOrders(orderRows)
      setPrevOrders(prevOrderRows)
      setDocuments(docRows)
    } catch (err: any) {
      console.error('OperationsTab fetch error:', err)
      setError(err.message || 'Failed to load operations data')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [period, supabase])

  useEffect(() => { fetchData() }, [fetchData])

  // ── Computed data ──────────────────────────────────────────────────────

  // 1. Pipeline / Funnel
  const pipeline = useMemo<PipelineStage[]>(() => {
    const total = orders.length || 1
    const stages = [
      { status: 'draft', label: 'Draft', color: COLORS.primary, icon: <ShoppingCart className="h-4 w-4" /> },
      { status: 'submitted', label: 'Submitted', color: COLORS.warning, icon: <Clock className="h-4 w-4" /> },
      { status: 'approved', label: 'Approved', color: COLORS.purple, icon: <CheckCircle2 className="h-4 w-4" /> },
      { status: 'closed', label: 'Closed', color: COLORS.success, icon: <Package className="h-4 w-4" /> },
    ]
    return stages.map(s => {
      const count = orders.filter(o => o.status === s.status).length
      return { ...s, count, percentage: Math.round((count / total) * 100) }
    })
  }, [orders])

  // 2. Processing KPIs
  const kpis = useMemo(() => {
    const daySpan = Math.max(period.dayCount, 1)
    const prevDaySpan = Math.max(period.comparisonDayCount, 1)

    // Approval time (hours)
    const approvedOrders = orders.filter(o => o.approved_at)
    const avgApprovalHours = approvedOrders.length > 0
      ? approvedOrders.reduce((sum, o) => sum + differenceInHours(new Date(o.approved_at!), new Date(o.created_at)), 0) / approvedOrders.length
      : 0

    const prevApproved = prevOrders.filter(o => o.approved_at)
    const prevAvgApprovalHours = prevApproved.length > 0
      ? prevApproved.reduce((sum, o) => sum + differenceInHours(new Date(o.approved_at!), new Date(o.created_at)), 0) / prevApproved.length
      : 0

    // Processing time (hours) for closed
    const closedOrders = orders.filter(o => o.status === 'closed')
    const avgProcessingHours = closedOrders.length > 0
      ? closedOrders.reduce((sum, o) => sum + differenceInHours(new Date(o.updated_at), new Date(o.created_at)), 0) / closedOrders.length
      : 0

    const prevClosed = prevOrders.filter(o => o.status === 'closed')
    const prevAvgProcessingHours = prevClosed.length > 0
      ? prevClosed.reduce((sum, o) => sum + differenceInHours(new Date(o.updated_at), new Date(o.created_at)), 0) / prevClosed.length
      : 0

    // Throughput
    const throughput = orders.length / daySpan
    const prevThroughput = prevOrders.length / prevDaySpan

    // Active
    const activeCount = orders.filter(o => o.status === 'submitted' || o.status === 'approved').length
    const prevActiveCount = prevOrders.filter(o => o.status === 'submitted' || o.status === 'approved').length

    return {
      avgApprovalHours,
      prevAvgApprovalHours,
      avgProcessingHours,
      prevAvgProcessingHours,
      throughput,
      prevThroughput,
      activeCount,
      prevActiveCount,
    }
  }, [orders, prevOrders, period])

  // 3. Bottleneck Detection
  const bottlenecks = useMemo<Bottleneck[]>(() => {
    const now = new Date()
    const alerts: Bottleneck[] = []

    // Submitted > 2 days
    const stuckSubmitted = orders.filter(
      o => o.status === 'submitted' && differenceInHours(now, new Date(o.created_at)) > 48
    )
    if (stuckSubmitted.length > 0) {
      const oldest = Math.max(...stuckSubmitted.map(o => differenceInHours(now, new Date(o.created_at))))
      alerts.push({
        severity: oldest > 96 ? 'red' : 'amber',
        title: 'Pending Approval',
        description: `${stuckSubmitted.length} order(s) submitted for >2 days without approval`,
        count: stuckSubmitted.length,
        oldestAge: Math.round(oldest / 24),
        unit: 'days',
      })
    }

    // Approved > 3 days
    const stuckApproved = orders.filter(
      o => o.status === 'approved' && differenceInHours(now, new Date(o.approved_at || o.updated_at)) > 72
    )
    if (stuckApproved.length > 0) {
      const oldest = Math.max(...stuckApproved.map(o => differenceInHours(now, new Date(o.approved_at || o.updated_at))))
      alerts.push({
        severity: oldest > 120 ? 'red' : 'amber',
        title: 'Pending Closure',
        description: `${stuckApproved.length} order(s) approved for >3 days without closure`,
        count: stuckApproved.length,
        oldestAge: Math.round(oldest / 24),
        unit: 'days',
      })
    }

    return alerts
  }, [orders])

  // 4. Throughput Trend — daily across the reporting month (Malaysia days)
  const throughputTrend = useMemo<MonthlyThroughput[]>(() => {
    if (orders.length === 0) return []
    const created = new Map<string, number>()
    const closed = new Map<string, number>()
    for (const o of orders) {
      const day = malaysiaDateOf(o.created_at)
      if (day) created.set(day, (created.get(day) || 0) + 1)
      if (o.status === 'closed') {
        const closedDay = malaysiaDateOf(o.updated_at)
        if (closedDay) closed.set(closedDay, (closed.get(closedDay) || 0) + 1)
      }
    }
    return Array.from({ length: period.dayCount }, (_, index) => {
      const day = addDaysToDateKey(period.startDate, index)
      return { month: formatReportDate(day).slice(0, 6), created: created.get(day) || 0, closed: closed.get(day) || 0 }
    })
  }, [orders, period])

  // 5. Warehouse Activity
  const warehouseActivity = useMemo(() => {
    const todayStart = startOfDay(new Date())
    const todayEnd = endOfDay(new Date())

    const packedToday = orders.filter(o => {
      if (!o.approved_at) return false
      const d = new Date(o.approved_at)
      return d >= todayStart && d <= todayEnd
    }).length

    const shippedToday = orders.filter(o => {
      if (o.status !== 'closed') return false
      const d = new Date(o.updated_at)
      return d >= todayStart && d <= todayEnd
    }).length

    const pendingDeliveries = documents.filter(
      d => d.doc_type === 'DO' && (d.status === 'pending' || d.status === 'draft')
    ).length

    return { packedToday, shippedToday, pendingDeliveries }
  }, [orders, documents])

  // 6. Status Distribution (pie)
  const statusDistribution = useMemo(() => {
    const total = orders.length || 1
    const statuses = ['draft', 'submitted', 'approved', 'closed']
    return statuses.map(s => {
      const count = orders.filter(o => o.status === s).length
      return {
        name: s.charAt(0).toUpperCase() + s.slice(1),
        value: count,
        percentage: Math.round((count / total) * 100),
        fill: STATUS_COLORS[s] || COLORS.primary,
      }
    }).filter(s => s.value > 0)
  }, [orders])

  // ── Render helpers ─────────────────────────────────────────────────────

  const renderPipeline = () => {
    const total = orders.length
    return (
      <Card className="sera-sc-panel overflow-hidden">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                <Activity className="h-5 w-5 text-primary" />
                Order Pipeline
              </CardTitle>
              <CardDescription>Current status distribution across {total.toLocaleString()} orders</CardDescription>
            </div>
            <Badge variant="secondary" className="text-xs">{total} total</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {total === 0 ? (
            <div className="flex items-center justify-center h-24 text-muted-foreground text-sm">
              No orders found in this period
            </div>
          ) : (
            <div className="flex items-stretch gap-1 md:gap-2">
              {pipeline.map((stage, idx) => (
                <motion.div
                  key={stage.status}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.08, duration: 0.35 }}
                  className="flex-1 relative"
                >
                  <div
                    className="rounded-xl p-3 md:p-4 text-center relative overflow-hidden transition-transform hover:scale-[1.02]"
                    style={{ backgroundColor: `${stage.color}15`, borderLeft: `3px solid ${stage.color}` }}
                  >
                    <div className="flex items-center justify-center gap-1.5 mb-1">
                      <span style={{ color: stage.color }}>{stage.icon}</span>
                      <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        {stage.label}
                      </span>
                    </div>
                    <div className="text-2xl md:text-3xl font-bold" style={{ color: stage.color }}>
                      <AnimatedCounter value={stage.count} />
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">{stage.percentage}%</div>
                    {/* Progress bar */}
                    <div className="mt-2 h-1.5 rounded-full bg-muted/50 overflow-hidden">
                      <motion.div
                        className="h-full rounded-full"
                        style={{ backgroundColor: stage.color }}
                        initial={{ width: 0 }}
                        animate={{ width: `${stage.percentage}%` }}
                        transition={{ delay: idx * 0.08 + 0.2, duration: 0.6, ease: 'easeOut' }}
                      />
                    </div>
                  </div>
                  {/* Arrow connector */}
                  {idx < pipeline.length - 1 && (
                    <div className="absolute -right-2 md:-right-3 top-1/2 -translate-y-1/2 z-10">
                      <ChevronRight className="h-4 w-4 md:h-5 md:w-5 text-muted-foreground/40" />
                    </div>
                  )}
                </motion.div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    )
  }

  const renderKPICards = () => {
    const approvalDelta = calcDelta(kpis.avgApprovalHours, kpis.prevAvgApprovalHours)
    const processingDelta = calcDelta(kpis.avgProcessingHours, kpis.prevAvgProcessingHours)
    const throughputDelta = calcDelta(kpis.throughput, kpis.prevThroughput)
    const activeDelta = calcDelta(kpis.activeCount, kpis.prevActiveCount)

    const cards = [
      {
        title: 'Avg Approval Time',
        value: formatDuration(kpis.avgApprovalHours),
        rawValue: kpis.avgApprovalHours,
        delta: approvalDelta,
        invertDelta: true, // lower is better
        icon: <Clock className="h-5 w-5" />,
        color: COLORS.primary,
      },
      {
        title: 'Avg Processing Time',
        value: formatDuration(kpis.avgProcessingHours),
        rawValue: kpis.avgProcessingHours,
        delta: processingDelta,
        invertDelta: true,
        icon: <Zap className="h-5 w-5" />,
        color: COLORS.purple,
      },
      {
        title: 'Order Throughput',
        value: `${kpis.throughput.toFixed(1)}/day`,
        rawValue: kpis.throughput,
        delta: throughputDelta,
        invertDelta: false,
        icon: <TrendingUp className="h-5 w-5" />,
        color: COLORS.success,
      },
      {
        title: 'Active Orders',
        value: kpis.activeCount.toString(),
        rawValue: kpis.activeCount,
        delta: activeDelta,
        invertDelta: false,
        icon: <Activity className="h-5 w-5" />,
        color: COLORS.cyan,
      },
    ]

    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((card, idx) => {
          const isGood = card.invertDelta ? !card.delta.isPositive : card.delta.isPositive
          return (
            <motion.div
              key={card.title}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.06, duration: 0.35 }}
            >
              <div className="sera-sc-kpi group">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <span className="sera-sc-kpi__label">{card.title}</span>
                    <div
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors"
                      style={{ backgroundColor: `${card.color}14`, color: card.color }}
                    >
                      {card.icon}
                    </div>
                  </div>
                  <div className="sera-sc-kpi__value">
                    <ExecutiveKpiValue>{card.value}</ExecutiveKpiValue>
                  </div>
                  {card.delta.delta > 0 && (
                    <div className={`flex items-center gap-1 mt-1.5 text-xs font-medium ${isGood ? 'text-emerald-600' : 'text-red-600'}`}>
                      {isGood
                        ? <ArrowUpRight className="h-3.5 w-3.5" />
                        : <ArrowDownRight className="h-3.5 w-3.5" />
                      }
                      <span>{card.delta.delta.toFixed(1)}%</span>
                      <span className="text-[var(--sera-muted)] font-normal ml-0.5">vs prev</span>
                    </div>
                  )}
              </div>
            </motion.div>
          )
        })}
      </div>
    )
  }

  const renderBottlenecks = () => {
    if (bottlenecks.length === 0) {
      return (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <Card className="sera-sc-panel overflow-hidden">
            <CardContent className="py-6">
              <div className="flex items-center gap-3 text-emerald-500">
                <CheckCircle2 className="h-5 w-5" />
                <div>
                  <p className="font-medium">All Clear</p>
                  <p className="text-xs text-muted-foreground">No operational bottlenecks detected</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )
    }

    return (
      <div className="flex gap-4 overflow-x-auto pb-2 scrollbar-thin">
        {bottlenecks.map((alert, idx) => {
          const isRed = alert.severity === 'red'
          const bgColor = isRed ? 'bg-red-500/10' : 'bg-amber-500/10'
          const borderColor = isRed ? 'border-red-500/30' : 'border-amber-500/30'
          const iconColor = isRed ? 'text-red-500' : 'text-amber-500'
          const Icon = isRed ? AlertCircle : AlertTriangle

          return (
            <motion.div
              key={alert.title}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: idx * 0.08, duration: 0.35 }}
              className="min-w-[280px] flex-shrink-0"
            >
              <Card className={`border ${borderColor} shadow-lg ${bgColor} backdrop-blur`}>
                <CardContent className="py-4">
                  <div className="flex items-start gap-3">
                    <div className={`p-2 rounded-lg ${bgColor}`}>
                      <Icon className={`h-5 w-5 ${iconColor}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold text-sm">{alert.title}</span>
                        <Badge
                          variant={isRed ? 'destructive' : 'secondary'}
                          className="text-[10px] px-1.5 py-0"
                        >
                          {isRed ? 'Critical' : 'Warning'}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">{alert.description}</p>
                      <div className="flex items-center gap-3 mt-2 text-xs">
                        <span className="font-medium">{alert.count} orders</span>
                        <span className="text-muted-foreground">
                          Oldest: {alert.oldestAge} {alert.unit}
                        </span>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          )
        })}
      </div>
    )
  }

  const renderThroughputChart = () => (
    <div className="sera-sc-panel overflow-hidden">
      <div className="border-b border-[var(--sera-line)] px-5 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-[var(--sera-ink)] flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-[var(--sera-orange)]" />
              Order Throughput Trend
            </h3>
            <p className="text-sm text-[var(--sera-muted)] mt-0.5">Daily created vs completed orders · {period.label}{period.isCurrentMonth ? ' to date' : ''}</p>
          </div>
        </div>
      </div>
      <div className="p-5">
        {throughputTrend.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
            No data for trend chart
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <ComposedChart data={throughputTrend} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
              <defs>
                <linearGradient id="createdGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={COLORS.primary} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={COLORS.primary} stopOpacity={0.05} />
                </linearGradient>
                <linearGradient id="closedGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={COLORS.success} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={COLORS.success} stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={chartGridColor} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="month" tick={{ fill: chartTickColor, fontSize: 12 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: chartTickColor, fontSize: 12 }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip content={<CustomTooltip />} />
              <Legend
                wrapperStyle={{ fontSize: 12 }}
                iconType="circle"
                iconSize={8}
              />
              <Bar dataKey="created" name="Created" fill={COLORS.primary} radius={[4, 4, 0, 0]} barSize={28} fillOpacity={0.85} />
              <Bar dataKey="closed" name="Completed" fill={COLORS.success} radius={[4, 4, 0, 0]} barSize={28} fillOpacity={0.85} />
              <Line
                type="monotone"
                dataKey="created"
                name="Created (trend)"
                stroke={COLORS.primary}
                strokeWidth={2}
                dot={false}
                strokeDasharray="5 5"
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )

  const renderWarehouseActivity = () => {
    const items = [
      {
        title: 'Packed Today',
        description: 'Orders approved today',
        value: warehouseActivity.packedToday,
        icon: <BoxIcon className="h-5 w-5" />,
        color: COLORS.purple,
      },
      {
        title: 'Shipped Today',
        description: 'Orders closed today',
        value: warehouseActivity.shippedToday,
        icon: <Truck className="h-5 w-5" />,
        color: COLORS.success,
      },
      {
        title: 'Pending Deliveries',
        description: 'DO documents pending',
        value: warehouseActivity.pendingDeliveries,
        icon: <Package className="h-5 w-5" />,
        color: COLORS.warning,
      },
    ]

    return (
      <Card className="sera-sc-panel overflow-hidden">
        <CardHeader className="pb-2">
          <CardTitle className="text-lg flex items-center gap-2">
            <Truck className="h-5 w-5 text-primary" />
            Warehouse Activity
          </CardTitle>
          <CardDescription>
            Today&apos;s warehouse operations snapshot (current state, not part of the {period.label} figures)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            {items.map((item, idx) => (
              <motion.div
                key={item.title}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: idx * 0.06, duration: 0.3 }}
                className="text-center p-4 rounded-xl transition-colors"
                style={{ backgroundColor: `${item.color}08` }}
              >
                <div
                  className="inline-flex p-2.5 rounded-xl mb-2"
                  style={{ backgroundColor: `${item.color}15`, color: item.color }}
                >
                  {item.icon}
                </div>
                <div className="text-2xl font-bold" style={{ color: item.color }}>
                  <AnimatedCounter value={item.value} />
                </div>
                <div className="text-xs font-medium text-foreground mt-1">{item.title}</div>
                <div className="text-[10px] text-muted-foreground">{item.description}</div>
              </motion.div>
            ))}
          </div>
        </CardContent>
      </Card>
    )
  }

  const renderStatusPie = () => (
    <Card className="sera-sc-panel overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <PieChartIcon className="h-5 w-5 text-primary" />
              Status Distribution
            </CardTitle>
            <CardDescription>Order breakdown by current status</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {statusDistribution.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
            No data available
          </div>
        ) : (
          <div className="flex flex-col md:flex-row items-center gap-6">
            <div className="w-full md:w-1/2">
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={statusDistribution}
                    cx="50%"
                    cy="50%"
                    innerRadius={55}
                    outerRadius={90}
                    paddingAngle={3}
                    dataKey="value"
                    stroke="none"
                  >
                    {statusDistribution.map((entry, i) => (
                      <Cell key={entry.name} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip content={<CustomTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="w-full md:w-1/2 space-y-3">
              {statusDistribution.map(entry => (
                <div key={entry.name} className="flex items-center gap-3">
                  <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: entry.fill }} />
                  <span className="text-sm text-foreground flex-1">{entry.name}</span>
                  <span className="text-sm font-semibold text-foreground">{entry.value}</span>
                  <span className="text-xs text-muted-foreground w-10 text-right">{entry.percentage}%</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )

  // ── Loading state ──────────────────────────────────────────────────────
  if (loading) {
    return <SeraLoadingState variant="section" label="Loading operations overview" />
  }

  // ── Error state ────────────────────────────────────────────────────────
  if (error) {
    return (
      <Card className="sera-sc-panel overflow-hidden">
        <CardContent className="py-12 text-center">
          <AlertCircle className="h-10 w-10 text-red-500 mx-auto mb-3" />
          <p className="text-lg font-medium mb-1">Failed to load operations data</p>
          <p className="text-sm text-muted-foreground mb-4">{error}</p>
          <Button variant="outline" onClick={() => fetchData()}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Retry
          </Button>
        </CardContent>
      </Card>
    )
  }

  // ── Main render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--sera-ink)] flex items-center gap-2">
            <Activity className="h-5 w-5 text-[var(--sera-orange)]" />
            Operations Overview
          </h2>
          <p className="text-sm text-[var(--sera-muted)] mt-0.5">
            Pipeline health, processing metrics &amp; warehouse activity
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ReportingMonthSelector
            id="operations-month"
            month={month}
            onMonthChange={setMonth}
            availableMonths={earliestMonth ? [earliestMonth] : []}
            caption={(
              <>
                <span className="font-medium text-[var(--sera-ink)]">{period.rangeLabel}</span>
                {period.isCurrentMonth ? ' (month to date)' : ''} · vs {period.comparisonRangeLabel} · by order entry date
              </>
            )}
          />
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={() => fetchData(true)}
            disabled={refreshing}
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* 1. Pipeline */}
      {renderPipeline()}

      {/* 2. KPI Cards */}
      {renderKPICards()}

      {/* 3. Bottleneck Alerts */}
      <div>
        <h3 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-1.5">
          <AlertTriangle className="h-4 w-4" />
          Operational Alerts
        </h3>
        {renderBottlenecks()}
      </div>

      {/* 4. Throughput Trend + 6. Status Pie */}
      <div className="grid lg:grid-cols-5 gap-6">
        <div className="lg:col-span-3">
          {renderThroughputChart()}
        </div>
        <div className="lg:col-span-2">
          {renderStatusPie()}
        </div>
      </div>

      {/* 5. Warehouse Activity — a live "today" snapshot, so only meaningful for the running month. */}
      {period.isCurrentMonth ? renderWarehouseActivity() : null}
    </div>
  )
}
