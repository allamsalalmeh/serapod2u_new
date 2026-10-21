'use client'

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useTheme } from '@/components/providers/ThemeProvider'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
    AreaChart,
    Area,
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    PieChart,
    Pie,
    Cell,
} from 'recharts'
import {
    Download,
    Users,
    Package,
    ShoppingCart,
    Loader2,
    RefreshCw,
    DollarSign,
    Activity,
    ArrowUpRight,
    ArrowDownRight,
    Wallet,
    Receipt,
    Building2,
    Truck,
    BoxIcon,
    Clock,
    CheckCircle2,
    AlertCircle,
    Store,
    XCircle,
} from 'lucide-react'
import ConsumerAnalyticsTab from './ConsumerAnalyticsTab'
import DistributorReportsTab from './DistributorReportsTab'
import ExecutiveKpiValue from './ExecutiveKpiValue'
import OperationsTab from './OperationsTab'
import ProductsTab from './ProductsTab'
import ShopReportsTab from './ShopReportsTab'
import ReportingMonthSelector from './ReportingMonthSelector'
import CommissionReportingTab from '@/components/reporting/commission/CommissionReportingTab'
import { currentReportingMonthKey, parseReportingMonthParam } from '@/lib/reporting/consumer-analytics'
import { resolveExecutiveOverviewPeriod, type ExecutiveOverviewReport } from '@/lib/reporting/executive-overview'
import { formatReportDate } from '@/lib/reporting/product-analytics'
import { useCommissionAccess } from '@/lib/hr/commission/use-commission-access'
import ModuleLightHeader from '@/components/layout/ModuleLightHeader'
import { SeraLoader, SeraLoadingState } from '@/components/ui/SeraLoader'

interface ReportingViewProps {
    userProfile: any
}

const COLORS = {
    primary: '#e85d04',
    success: '#059669',
    warning: '#d97706',
    danger: '#dc2626',
    ink: '#141210',
    soft: '#2a2622',
    muted: '#9ca3af',
    slate: '#64748b',
}

const CHART_COLORS = [
    COLORS.primary,
    COLORS.ink,
    COLORS.warning,
    COLORS.success,
    COLORS.slate,
    COLORS.muted,
]

const numberFormatterCache = new Map<string, Intl.NumberFormat>()

function formatAnimatedValue(value: number, decimals: number) {
    const key = `en-MY:${decimals}`
    if (!numberFormatterCache.has(key)) {
        numberFormatterCache.set(key, new Intl.NumberFormat('en-MY', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
        }))
    }

    return numberFormatterCache.get(key)!.format(value)
}

// Animated counter component
const AnimatedCounter = ({ value, duration = 1000, prefix = '', suffix = '', decimals = 0 }: {
    value: number
    duration?: number
    prefix?: string
    suffix?: string
    decimals?: number
}) => {
    const [displayValue, setDisplayValue] = useState(0)

    useEffect(() => {
        let startTime: number
        let animationFrame: number

        const animate = (currentTime: number) => {
            if (!startTime) startTime = currentTime
            const progress = Math.min((currentTime - startTime) / duration, 1)

            // Easing function for smooth animation
            const easeOutQuart = 1 - Math.pow(1 - progress, 4)
            setDisplayValue(easeOutQuart * value)

            if (progress < 1) {
                animationFrame = requestAnimationFrame(animate)
            }
        }

        animationFrame = requestAnimationFrame(animate)
        return () => cancelAnimationFrame(animationFrame)
    }, [value, duration])

    const formattedValue = formatAnimatedValue(displayValue, decimals)

    return (
        <span className="inline-flex min-w-0 items-baseline whitespace-nowrap tabular-nums leading-none">
            {prefix ? <span className="mr-1 shrink-0 text-[0.72em] leading-none">{prefix}</span> : null}
            <span className="shrink-0">{formattedValue}</span>
            {suffix ? <span className="ml-1 shrink-0 text-[0.72em] leading-none">{suffix}</span> : null}
        </span>
    )
}

// Metric Card — light Serapod paper chrome
const MetricCard = ({ title, value, change, changeType, icon: Icon, color, subtitle, loading, currency }: {
    title: string
    /** Render as RM with 2 decimals (defaults to titles containing Revenue/Value). */
    currency?: boolean
    value: number | string
    change?: number
    changeType?: 'increase' | 'decrease' | 'neutral'
    icon: any
    color: string
    subtitle?: string
    loading?: boolean
}) => {
    const isPositive = changeType === 'increase'
    const isNegative = changeType === 'decrease'

    return (
        <div className="group relative overflow-hidden rounded-xl border border-[var(--sera-line,#e8eaed)] bg-white p-5 transition-colors hover:border-[var(--sera-orange)]/35">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-2">
                    <p className="text-sm font-medium text-[var(--sera-muted)]">{title}</p>
                    {loading ? (
                        <SeraLoader size="sm" className="text-[var(--sera-muted)]" />
                    ) : (
                        <div className="flex min-h-[2rem] min-w-0 items-center overflow-hidden">
                            <ExecutiveKpiValue>
                                {typeof value === 'number' ? (
                                    <AnimatedCounter
                                        value={value}
                                        prefix={(currency ?? /Revenue|Value/.test(title)) ? 'RM' : ''}
                                        decimals={(currency ?? /Revenue|Value/.test(title)) ? 2 : 0}
                                    />
                                ) : (
                                    <span className="inline-flex max-w-full min-w-0 items-baseline whitespace-nowrap leading-none">{value}</span>
                                )}
                            </ExecutiveKpiValue>
                        </div>
                    )}
                    <div className="flex items-center gap-2 flex-wrap">
                        {change !== undefined && (
                            <Badge
                                variant="secondary"
                                className={`text-xs font-medium border-0 ${isPositive ? 'bg-emerald-50 text-emerald-700' :
                                    isNegative ? 'bg-red-50 text-red-700' :
                                        'bg-[var(--sera-mist)] text-[var(--sera-muted)]'
                                    }`}
                            >
                                {isPositive && <ArrowUpRight className="w-3 h-3 mr-0.5" />}
                                {isNegative && <ArrowDownRight className="w-3 h-3 mr-0.5" />}
                                {Math.abs(change).toFixed(1)}%
                            </Badge>
                        )}
                        {subtitle && <span className="text-xs text-[var(--sera-muted)]">{subtitle}</span>}
                    </div>
                </div>
                <div
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
                    style={{ backgroundColor: `${color}14` }}
                >
                    <Icon className="w-5 h-5" style={{ color }} strokeWidth={1.75} />
                </div>
            </div>
        </div>
    )
}

const REPORTING_TABS = ['overview', 'operations', 'finance', 'products', 'consumer-analytics', 'shop-performance', 'distributors', 'commission'] as const
/** Tabs that read the Executive Overview report. */
const OVERVIEW_DATA_TABS = new Set(['overview', 'finance'])

const STATUS_LABEL: Record<string, string> = {
    approved: 'Approved',
    warehouse_packed: 'Packed',
    shipped_distributor: 'Shipped',
    closed: 'Closed',
}

function readSearchParam(name: string): string | null {
    if (typeof window === 'undefined') return null
    return new URLSearchParams(window.location.search).get(name)
}

function formatRm(value: number) {
    return `RM ${value.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Growth badge props for a MetricCard; nothing when the comparison window was empty. */
function changeProps(comparison?: { changePct: number | null }) {
    if (!comparison || comparison.changePct === null) return {}
    return {
        change: comparison.changePct,
        changeType: comparison.changePct > 0 ? 'increase' as const : comparison.changePct < 0 ? 'decrease' as const : 'neutral' as const,
    }
}

interface FinanceDocs {
    month: string
    pendingPayments: number
    completedPayments: number
    invoiceCount: number
}

export default function ReportingView({ userProfile }: ReportingViewProps) {
    // ── Shared reporting scope: one month for every tab, kept in the URL ────
    // Read synchronously so a refresh or shared link opens the same tab and
    // month on its very first request; an invalid or future month falls back to
    // the current month explicitly.
    const [activeTab, setActiveTab] = useState<string>(() => {
        const tab = readSearchParam('tab')
        return tab && (REPORTING_TABS as readonly string[]).includes(tab) ? tab : 'overview'
    })
    const [month, setMonth] = useState<string>(() => parseReportingMonthParam(readSearchParam('month')) ?? currentReportingMonthKey())

    const [loading, setLoading] = useState(true)
    const [overview, setOverview] = useState<ExecutiveOverviewReport | null>(null)
    const [earliestMonth, setEarliestMonth] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [downloading, setDownloading] = useState(false)
    const [financeDocs, setFinanceDocs] = useState<FinanceDocs | null>(null)
    const overviewRequest = useRef(0)
    const financeRequest = useRef(0)

    const isCommission = activeTab === 'commission'
    const needsOverview = OVERVIEW_DATA_TABS.has(activeTab)
    const commissionAccess = useCommissionAccess()
    const supabase = createClient()
    const { resolvedTheme } = useTheme()
    const isDark = resolvedTheme === 'dark'

    // Theme-aware chart colors
    const chartGridColor = isDark ? '#374151' : '#f0f0f0'
    const chartTickColor = isDark ? '#9ca3af' : '#6b7280'
    const tooltipBg = isDark ? 'rgba(31, 41, 55, 0.95)' : 'rgba(255, 255, 255, 0.95)'
    const tooltipStyle = { borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.2)', backgroundColor: tooltipBg, color: isDark ? '#f3f4f6' : undefined }

    useEffect(() => {
        if (typeof window === 'undefined') return
        const params = new URLSearchParams(window.location.search)
        params.set('tab', activeTab)
        params.set('month', month)
        // Retired rolling-period parameter.
        params.delete('dateRange')
        window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`)
    }, [activeTab, month])

    const fetchOverview = useCallback(async (targetMonth: string) => {
        const id = ++overviewRequest.current
        setLoading(true)
        setError(null)
        try {
            const res = await fetch(`/api/reporting/stats?month=${encodeURIComponent(targetMonth)}`, { cache: 'no-store', credentials: 'include' })
            const json = await res.json()
            // A slower earlier month must never overwrite the month now selected.
            if (id !== overviewRequest.current) return
            if (!res.ok) {
                setOverview(null)
                setError(json?.error || `API error: ${res.status}`)
                return
            }
            setOverview(json.report as ExecutiveOverviewReport)
            setEarliestMonth(json.earliestMonth ?? null)
        } catch (err: any) {
            if (id !== overviewRequest.current) return
            setOverview(null)
            setError(err?.message || 'Failed to fetch reporting data')
        } finally {
            if (id === overviewRequest.current) setLoading(false)
        }
    }, [])

    // Only the tabs that show it request the overview — other tabs load their own report.
    useEffect(() => {
        if (needsOverview) void fetchOverview(month)
    }, [needsOverview, month, fetchOverview])

    /**
     * Finance document counts for the reporting month: payment, payment-request
     * and invoice documents CREATED in the month (Malaysia time). Their status
     * is the current state of each document.
     */
    const fetchFinanceDocs = useCallback(async (targetMonth: string) => {
        const id = ++financeRequest.current
        const period = resolveExecutiveOverviewPeriod(targetMonth)
        const count = async (docType: string, status?: string) => {
            let query = supabase
                .from('documents')
                .select('id', { count: 'exact', head: true })
                .eq('doc_type', docType as any)
                .gte('created_at', period.startUtc)
                .lt('created_at', period.endUtc)
            if (status) query = query.eq('status', status as any)
            const { count: total, error } = await query
            if (error) throw error
            return total ?? 0
        }
        try {
            const [pendingPayments, completedPayments, invoiceCount] = await Promise.all([
                count('PAYMENT_REQUEST', 'pending'),
                count('PAYMENT', 'acknowledged'),
                count('INVOICE'),
            ])
            if (id === financeRequest.current) setFinanceDocs({ month: targetMonth, pendingPayments, completedPayments, invoiceCount })
        } catch (err) {
            console.error('Error fetching finance documents', err)
            if (id === financeRequest.current) setFinanceDocs(null)
        }
    }, [supabase])

    useEffect(() => {
        if (activeTab === 'finance') void fetchFinanceDocs(month)
    }, [activeTab, month, fetchFinanceDocs])

    const handleDownloadPdf = async () => {
        if (!overview) return
        setDownloading(true)
        try {
            const { buildExecutiveOverviewPdf } = await import('@/lib/reporting/executive-overview-pdf')
            const pdf = await buildExecutiveOverviewPdf(overview, {
                generatedAt: new Date().toISOString(),
                generatedBy: userProfile?.full_name || userProfile?.email || null,
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

    // Only the report for the selected month is ever rendered.
    const report = overview && overview.period.month === month ? overview : null
    const summary = report?.summary
    const comparison = report?.comparison
    const periodLabel = report?.period.label ?? ''
    const versus = report ? `vs ${report.period.comparisonRangeLabel}` : ''
    const productMixData = useMemo(() => (report?.productMix ?? []).slice(0, 6), [report])
    const monthTabs = { month, onMonthChange: setMonth }
    const docs = financeDocs && financeDocs.month === month ? financeDocs : null

    const overviewControls = (
        <div className="flex w-full flex-col gap-3 lg:w-auto lg:flex-row lg:items-end">
            <ReportingMonthSelector
                id="executive-overview-month"
                month={month}
                onMonthChange={setMonth}
                availableMonths={earliestMonth ? [earliestMonth] : []}
                caption={report ? (
                    <>
                        <span className="font-medium text-[var(--sera-ink)]">{report.period.rangeLabel}</span>
                        {report.period.isCurrentMonth ? ' (month to date)' : ''}
                        <br className="sm:hidden" />
                        <span className="sm:ml-1">{versus}</span>
                    </>
                ) : null}
            />
            <div className="flex items-center gap-2 lg:pb-[18px]">
                <Button
                    variant="outline"
                    className="h-10 flex-1 gap-2 border-[var(--sera-line)] lg:h-9 lg:flex-none"
                    onClick={() => fetchOverview(month)}
                    disabled={loading}
                >
                    <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                    Refresh
                </Button>
                {activeTab === 'overview' ? (
                    <Button
                        variant="outline"
                        className="h-10 flex-1 gap-2 border-[var(--sera-line)] lg:h-9 lg:flex-none"
                        onClick={handleDownloadPdf}
                        disabled={!report || downloading || loading}
                        title={report ? 'Download the Executive Overview report for the selected month' : 'Report not loaded yet'}
                    >
                        {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                        <span className="whitespace-nowrap">Download PDF</span>
                    </Button>
                ) : null}
            </div>
        </div>
    )

    const sectionHeader = (title: string, description: string) => (
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
                <h2 className="text-lg font-semibold text-[var(--sera-ink)]">{title}</h2>
                <p className="text-sm text-[var(--sera-muted)]">{description}</p>
            </div>
            {overviewControls}
        </div>
    )

    const errorBanner = error ? (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
                <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
                <div className="min-w-0">
                    <p className="font-medium text-red-800">Unable to load reporting data</p>
                    <p className="text-sm text-red-600 truncate">{error}</p>
                </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => fetchOverview(month)} className="shrink-0 border-red-300 text-red-700 hover:bg-red-100">
                <RefreshCw className="w-4 h-4 mr-2" />
                Retry
            </Button>
        </div>
    ) : null

    const emptyBanner = report?.isEmpty ? (
        <div className="rounded-xl border border-[var(--sera-line)] bg-[var(--sera-mist)] p-4 text-sm text-[var(--sera-muted)]">
            No orders were recorded in {report.period.label} ({report.period.rangeLabel}). Choose another Reporting Month to review a period with activity.
        </div>
    ) : null

    const showLoader = loading && !report

    return (
        <div className="sera-module-landing">
            <ModuleLightHeader
                eyebrow="Reporting"
                title="Executive Dashboard"
                description="Monthly business intelligence & analytics"
            />

                {/* Tab Navigation */}
                <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
                    <TabsList className="h-auto w-full flex flex-wrap justify-start gap-1 bg-[var(--sera-mist)] border border-[var(--sera-line)] p-1.5 rounded-xl">
                        <TabsTrigger value="overview" className="rounded-lg px-4 py-2 text-[var(--sera-muted)] data-[state=active]:bg-white data-[state=active]:text-[var(--sera-ink)] data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-[var(--sera-orange)]/30">
                            <Activity className="w-4 h-4 mr-2" />
                            Overview
                        </TabsTrigger>
                        <TabsTrigger value="operations" className="rounded-lg px-4 py-2 text-[var(--sera-muted)] data-[state=active]:bg-white data-[state=active]:text-[var(--sera-ink)] data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-[var(--sera-orange)]/30">
                            <Truck className="w-4 h-4 mr-2" />
                            Operations
                        </TabsTrigger>
                        <TabsTrigger value="finance" className="rounded-lg px-4 py-2 text-[var(--sera-muted)] data-[state=active]:bg-white data-[state=active]:text-[var(--sera-ink)] data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-[var(--sera-orange)]/30">
                            <DollarSign className="w-4 h-4 mr-2" />
                            Finance
                        </TabsTrigger>
                        <TabsTrigger value="products" className="rounded-lg px-4 py-2 text-[var(--sera-muted)] data-[state=active]:bg-white data-[state=active]:text-[var(--sera-ink)] data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-[var(--sera-orange)]/30">
                            <Package className="w-4 h-4 mr-2" />
                            Products
                        </TabsTrigger>
                        <TabsTrigger value="consumer-analytics" className="rounded-lg px-4 py-2 text-[var(--sera-muted)] data-[state=active]:bg-white data-[state=active]:text-[var(--sera-ink)] data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-[var(--sera-orange)]/30">
                            <Users className="w-4 h-4 mr-2" />
                            Consumer Analytics
                        </TabsTrigger>
                        <TabsTrigger value="shop-performance" className="rounded-lg px-4 py-2 text-[var(--sera-muted)] data-[state=active]:bg-white data-[state=active]:text-[var(--sera-ink)] data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-[var(--sera-orange)]/30">
                            <Store className="w-4 h-4 mr-2" />
                            Shop Performance
                        </TabsTrigger>
                        <TabsTrigger value="distributors" className="rounded-lg px-4 py-2 text-[var(--sera-muted)] data-[state=active]:bg-white data-[state=active]:text-[var(--sera-ink)] data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-[var(--sera-orange)]/30">
                            <Building2 className="w-4 h-4 mr-2" />
                            Distributor
                        </TabsTrigger>
                        {commissionAccess.can('reporting.commission.view') && (
                            <TabsTrigger value="commission" className="rounded-lg px-4 py-2 text-[var(--sera-muted)] data-[state=active]:bg-white data-[state=active]:text-[var(--sera-ink)] data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-[var(--sera-orange)]/30">
                                <Wallet className="w-4 h-4 mr-2" />
                                Commission
                            </TabsTrigger>
                        )}
                    </TabsList>

                    {/* Overview Tab */}
                    <TabsContent value="overview" className="space-y-6 animate-in fade-in-50 duration-500">
                        {sectionHeader('Executive Overview', 'Approved sales, pipeline and purchases for the reporting month')}
                        {errorBanner}
                        {showLoader ? <SeraLoadingState variant="page" label="Loading executive overview" /> : (
                        <>
                        {emptyBanner}
                        {/* KPI Cards. Approved Sales = approved, warehouse packed, shipped to distributor and closed
                            D2H/S2D orders by SO date; submitted orders are pipeline, cancelled orders are reported
                            apart and H2M purchases are never sales (lib/reporting/executive-overview.ts). */}
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                            <MetricCard
                                title="Approved Sales Value"
                                value={summary?.approvedSalesValue ?? 0}
                                icon={DollarSign}
                                color={COLORS.success}
                                subtitle={versus}
                                loading={loading}
                                {...changeProps(comparison?.approvedSalesValue)}
                            />
                            <MetricCard
                                title="Confirmed Sales Orders"
                                value={summary?.approvedSalesOrders ?? 0}
                                icon={ShoppingCart}
                                color={COLORS.primary}
                                subtitle="approved, packed, shipped or closed"
                                loading={loading}
                                {...changeProps(comparison?.approvedSalesOrders)}
                            />
                            <MetricCard
                                title="Total Units Sold"
                                value={summary?.unitsSold ?? 0}
                                icon={Package}
                                color={COLORS.slate}
                                subtitle="on approved sales orders"
                                loading={loading}
                                {...changeProps(comparison?.unitsSold)}
                            />
                            <MetricCard
                                title="Active Buyers"
                                value={summary?.activeBuyers ?? 0}
                                icon={Users}
                                color={COLORS.warning}
                                subtitle={`${summary?.activeDistributorBuyers ?? 0} distributors · ${summary?.activeShopBuyers ?? 0} shops`}
                                loading={loading}
                                {...changeProps(comparison?.activeBuyers)}
                            />
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
                            <MetricCard
                                title="Distributor Sales (D2H)"
                                value={summary?.distributorSalesValue ?? 0}
                                currency
                                icon={Building2}
                                color={COLORS.success}
                                subtitle={`${summary?.distributorSalesOrders ?? 0} approved orders`}
                                loading={loading}
                                {...changeProps(comparison?.distributorSalesValue)}
                            />
                            <MetricCard
                                title="Shop Sales (S2D)"
                                value={summary?.shopSalesValue ?? 0}
                                currency
                                icon={Store}
                                color={COLORS.success}
                                subtitle={`${summary?.shopSalesOrders ?? 0} approved orders`}
                                loading={loading}
                                {...changeProps(comparison?.shopSalesValue)}
                            />
                            <MetricCard
                                title="Sales Pipeline Value"
                                value={summary?.pipelineValue ?? 0}
                                icon={Clock}
                                color={COLORS.primary}
                                subtitle={`${summary?.pipelineOrders ?? 0} submitted, awaiting approval`}
                                loading={loading}
                            />
                            <MetricCard
                                title="Cancelled Orders"
                                value={summary?.cancelledOrders ?? 0}
                                currency={false}
                                icon={XCircle}
                                color={COLORS.danger}
                                subtitle={`${formatRm(summary?.cancelledValue ?? 0)} not counted as sales`}
                                loading={loading}
                            />
                            <MetricCard
                                title="H2M Purchases Value"
                                value={summary?.purchaseValue ?? 0}
                                icon={Truck}
                                color={COLORS.slate}
                                subtitle={`${summary?.purchaseOrders ?? 0} approved manufacturer orders (not sales)`}
                                loading={loading}
                            />
                        </div>
                        {report?.meta.notice ? (
                            <p className="text-xs text-amber-700">{report.meta.notice}</p>
                        ) : null}

                        {/* Main Charts Row */}
                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                            <Card className="lg:col-span-2 border border-[var(--sera-line)] shadow-none bg-white">
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-base font-semibold text-[var(--sera-ink)]">Daily Approved Sales</CardTitle>
                                    <CardDescription className="text-[var(--sera-muted)]">
                                        Approved sales value by SO date · {report?.period.rangeLabel ?? ''}
                                    </CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <div className="h-[320px]">
                                        <ResponsiveContainer width="100%" height="100%">
                                            <AreaChart data={report?.dailyTrend ?? []}>
                                                <defs>
                                                    <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
                                                        <stop offset="5%" stopColor={COLORS.primary} stopOpacity={0.3} />
                                                        <stop offset="95%" stopColor={COLORS.primary} stopOpacity={0} />
                                                    </linearGradient>
                                                </defs>
                                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chartGridColor} />
                                                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: chartTickColor, fontSize: 12 }} minTickGap={16} />
                                                <YAxis tickLine={false} axisLine={false} tick={{ fill: chartTickColor, fontSize: 12 }} tickFormatter={(value) => value.toLocaleString('en-MY')} />
                                                <Tooltip contentStyle={tooltipStyle} formatter={(value: number) => [formatRm(value), 'Approved sales']} />
                                                <Area type="monotone" dataKey="value" stroke={COLORS.primary} strokeWidth={3} fill="url(#colorSales)" dot={false} activeDot={{ r: 6, fill: COLORS.primary, stroke: '#fff', strokeWidth: 2 }} />
                                            </AreaChart>
                                        </ResponsiveContainer>
                                    </div>
                                </CardContent>
                            </Card>

                            <Card className="border border-[var(--sera-line)] shadow-none bg-white">
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-base font-semibold text-[var(--sera-ink)]">Product Distribution</CardTitle>
                                    <CardDescription className="text-[var(--sera-muted)]">Top variants by units sold · {periodLabel}</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    {productMixData.length === 0 ? (
                                        <div className="flex h-[200px] items-center justify-center text-sm text-[var(--sera-muted)]">No products sold this month</div>
                                    ) : (
                                    <div className="h-[200px]">
                                        <ResponsiveContainer width="100%" height="100%">
                                            <PieChart>
                                                <Pie data={productMixData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={4} dataKey="units" nameKey="name" stroke="none">
                                                    {productMixData.map((entry, index) => (
                                                        <Cell key={`cell-${entry.variantId}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                                                    ))}
                                                </Pie>
                                                <Tooltip contentStyle={tooltipStyle} formatter={(value: number) => [value.toLocaleString(), 'Units']} />
                                            </PieChart>
                                        </ResponsiveContainer>
                                    </div>
                                    )}
                                    <div className="space-y-2 mt-4">
                                        {productMixData.slice(0, 4).map((item, index) => (
                                            <div key={item.variantId} className="flex items-center justify-between gap-2">
                                                <div className="flex min-w-0 items-center gap-2">
                                                    <div className="w-3 h-3 shrink-0 rounded-full" style={{ backgroundColor: CHART_COLORS[index] }} />
                                                    <span className="text-sm text-muted-foreground truncate">{item.name}</span>
                                                </div>
                                                <span className="text-sm font-semibold">{item.units.toLocaleString()}</span>
                                            </div>
                                        ))}
                                    </div>
                                </CardContent>
                            </Card>
                        </div>

                        {/* Secondary Charts */}
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                            <Card className="border border-[var(--sera-line)] shadow-none bg-white">
                                <CardHeader>
                                    <CardTitle className="text-base font-semibold text-[var(--sera-ink)]">Monthly Sales Trend</CardTitle>
                                    <CardDescription className="text-[var(--sera-muted)]">Approved sales, last {report?.monthlyTrend.length ?? 6} months{report?.period.isCurrentMonth ? ' (current month to date)' : ''}</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <div className="h-[300px]">
                                        <ResponsiveContainer width="100%" height="100%">
                                            <BarChart data={report?.monthlyTrend ?? []}>
                                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chartGridColor} />
                                                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: chartTickColor, fontSize: 12 }} />
                                                <YAxis tickLine={false} axisLine={false} tick={{ fill: chartTickColor, fontSize: 12 }} tickFormatter={(value) => value.toLocaleString('en-MY')} />
                                                <Tooltip cursor={{ fill: 'transparent' }} contentStyle={tooltipStyle} formatter={(value: number) => [formatRm(value), 'Approved sales']} />
                                                <Bar dataKey="value" radius={[8, 8, 0, 0]} barSize={32}>
                                                    {(report?.monthlyTrend ?? []).map((row) => (
                                                        <Cell key={row.month} fill={row.month === month ? COLORS.primary : COLORS.muted} />
                                                    ))}
                                                </Bar>
                                            </BarChart>
                                        </ResponsiveContainer>
                                    </div>
                                </CardContent>
                            </Card>

                            <Card className="border border-[var(--sera-line)] shadow-none bg-white">
                                <CardHeader>
                                    <CardTitle className="text-base font-semibold text-[var(--sera-ink)]">Top Buyers</CardTitle>
                                    <CardDescription className="text-[var(--sera-muted)]">Distributors and shops by approved sales value · {periodLabel}</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    {(report?.topBuyers.length ?? 0) === 0 ? (
                                        <div className="flex h-[300px] items-center justify-center text-sm text-[var(--sera-muted)]">No approved sales this month</div>
                                    ) : (
                                    <div className="h-[300px]">
                                        <ResponsiveContainer width="100%" height="100%">
                                            <BarChart data={report?.topBuyers.slice(0, 5) ?? []} layout="vertical" margin={{ left: 20 }}>
                                                <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke={chartGridColor} />
                                                <XAxis type="number" hide />
                                                <YAxis dataKey="name" type="category" width={110} tick={{ fontSize: 12, fill: chartTickColor }} tickLine={false} axisLine={false} />
                                                <Tooltip cursor={{ fill: 'transparent' }} contentStyle={tooltipStyle} formatter={(value: number) => [formatRm(value), 'Approved sales']} />
                                                <Bar dataKey="value" radius={[0, 8, 8, 0]} barSize={24}>
                                                    {(report?.topBuyers.slice(0, 5) ?? []).map((entry, index) => (
                                                        <Cell key={entry.buyerId} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                                                    ))}
                                                </Bar>
                                            </BarChart>
                                        </ResponsiveContainer>
                                    </div>
                                    )}
                                </CardContent>
                            </Card>
                        </div>

                        <Card className="border border-[var(--sera-line)] shadow-none bg-white">
                            <CardHeader>
                                <CardTitle className="text-base font-semibold text-[var(--sera-ink)]">Latest Approved Sales Orders</CardTitle>
                                <CardDescription className="text-[var(--sera-muted)]">Most recent by SO date in {periodLabel}</CardDescription>
                            </CardHeader>
                            <CardContent>
                                <div className="space-y-3">
                                    {(report?.recentOrders ?? []).slice(0, 6).map((order) => (
                                        <div key={order.id} className="flex items-center justify-between p-3 rounded-xl bg-[var(--sera-mist)] border border-[var(--sera-line)] hover:border-[var(--sera-orange)]/30 transition-colors">
                                            <div className="flex items-center gap-3 min-w-0">
                                                <div className="p-2 rounded-lg bg-[var(--sera-orange)]/10 shrink-0">
                                                    <Truck className="w-4 h-4 text-[var(--sera-orange)]" strokeWidth={1.75} />
                                                </div>
                                                <div className="min-w-0">
                                                    <p className="text-sm font-medium text-[var(--sera-ink)] truncate">{order.buyerName}</p>
                                                    <p className="text-xs text-[var(--sera-muted)]">{order.orderNo} · {order.orderType} · {STATUS_LABEL[order.status] ?? order.status}</p>
                                                </div>
                                            </div>
                                            <div className="text-right shrink-0 pl-3">
                                                <p className="text-sm font-semibold text-[var(--sera-ink)]">{formatRm(order.value)}</p>
                                                <p className="text-xs text-[var(--sera-muted)]">{order.units.toLocaleString()} units · {formatReportDate(order.orderDate)}</p>
                                            </div>
                                        </div>
                                    ))}
                                    {(report?.recentOrders.length ?? 0) === 0 && (
                                        <div className="text-center py-8 text-[var(--sera-muted)]">
                                            <BoxIcon className="w-12 h-12 mx-auto mb-3 opacity-40" />
                                            <p>No approved sales orders this month</p>
                                        </div>
                                    )}
                                </div>
                            </CardContent>
                        </Card>
                        </>
                        )}
                    </TabsContent>

                    {/* Operations Tab */}
                    <TabsContent value="operations" className="space-y-6 animate-in fade-in-50 duration-500">
                        <OperationsTab
                            userProfile={userProfile}
                            chartGridColor={chartGridColor}
                            chartTickColor={chartTickColor}
                            isDark={isDark}
                            {...monthTabs}
                        />
                    </TabsContent>

                    {/* Finance Tab — the Overview report's sales figures plus the month's finance documents */}
                    <TabsContent value="finance" className="space-y-6 animate-in fade-in-50 duration-500">
                        {sectionHeader('Finance', 'Approved sales and finance documents for the reporting month')}
                        {errorBanner}
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                            <MetricCard
                                title="Approved Sales Value"
                                value={summary?.approvedSalesValue ?? 0}
                                icon={DollarSign}
                                color={COLORS.success}
                                subtitle={`${summary?.approvedSalesOrders ?? 0} approved D2H/S2D orders · ${periodLabel}`}
                                loading={loading || !report}
                                {...changeProps(comparison?.approvedSalesValue)}
                            />
                            <MetricCard
                                title="Pending Payments"
                                value={docs?.pendingPayments ?? 0}
                                icon={Clock}
                                color={COLORS.warning}
                                subtitle="payment requests raised this month, still pending"
                                loading={!docs}
                            />
                            <MetricCard
                                title="Completed Payments"
                                value={docs?.completedPayments ?? 0}
                                icon={CheckCircle2}
                                color={COLORS.success}
                                subtitle="payments raised this month, acknowledged"
                                loading={!docs}
                            />
                            <MetricCard
                                title="Invoices Issued"
                                value={docs?.invoiceCount ?? 0}
                                icon={Receipt}
                                color={COLORS.ink}
                                subtitle={`invoice documents created in ${periodLabel || 'the month'}`}
                                loading={!docs}
                            />
                        </div>
                        <p className="text-xs text-[var(--sera-muted)]">
                            Document counts cover documents created in the reporting month (Malaysia time); their pending / acknowledged status is the current status.
                        </p>

                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                            {/* Sales vs purchases — real order values for the month, never a placeholder split */}
                            <Card className="border border-[var(--sera-line)] shadow-none bg-white">
                                <CardHeader>
                                    <CardTitle className="text-base font-semibold text-[var(--sera-ink)]">Sales &amp; Purchases by Order Type</CardTitle>
                                    <CardDescription className="text-[var(--sera-muted)]">Approved order value · {periodLabel} · H2M is a purchase, not a sale</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <div className="h-[300px]">
                                        <ResponsiveContainer width="100%" height="100%">
                                            <BarChart data={summary ? [
                                                { name: 'D2H sales', value: summary.distributorSalesValue, fill: COLORS.success },
                                                { name: 'S2D sales', value: summary.shopSalesValue, fill: COLORS.primary },
                                                { name: 'H2M purchases', value: summary.purchaseValue, fill: COLORS.slate },
                                            ] : []}>
                                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chartGridColor} />
                                                <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fill: chartTickColor, fontSize: 12 }} />
                                                <YAxis tickLine={false} axisLine={false} tick={{ fill: chartTickColor, fontSize: 12 }} tickFormatter={(value) => value.toLocaleString('en-MY')} />
                                                <Tooltip cursor={{ fill: 'transparent' }} contentStyle={tooltipStyle} formatter={(value: number) => [formatRm(value), 'Value']} />
                                                <Bar dataKey="value" radius={[8, 8, 0, 0]} barSize={48}>
                                                    {[COLORS.success, COLORS.primary, COLORS.slate].map((fill) => <Cell key={fill} fill={fill} />)}
                                                </Bar>
                                            </BarChart>
                                        </ResponsiveContainer>
                                    </div>
                                </CardContent>
                            </Card>

                            {/* Payment Status */}
                            <Card className="border border-[var(--sera-line)] shadow-none bg-white">
                                <CardHeader>
                                    <CardTitle className="text-base font-semibold text-[var(--sera-ink)]">Payment Status Overview</CardTitle>
                                    <CardDescription className="text-[var(--sera-muted)]">Documents raised in {periodLabel || 'the month'}</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <div className="space-y-4">
                                        {[
                                            { label: 'Payments acknowledged', value: docs?.completedPayments ?? 0, color: COLORS.success },
                                            { label: 'Payment requests pending', value: docs?.pendingPayments ?? 0, color: COLORS.warning },
                                            { label: 'Invoices without an acknowledged payment', value: Math.max(0, (docs?.invoiceCount ?? 0) - (docs?.completedPayments ?? 0)), color: COLORS.primary },
                                        ].map((item) => {
                                            const total = Math.max(docs?.invoiceCount ?? 0, docs?.completedPayments ?? 0, docs?.pendingPayments ?? 0, 1)
                                            return (
                                                <div key={item.label} className="space-y-2">
                                                    <div className="flex justify-between text-sm">
                                                        <span className="text-[var(--sera-muted)]">{item.label}</span>
                                                        <span className="font-semibold text-[var(--sera-ink)]">{item.value}</span>
                                                    </div>
                                                    <div className="h-2 bg-[var(--sera-mist)] rounded-full overflow-hidden">
                                                        <div
                                                            className="h-full rounded-full transition-all duration-1000 ease-out"
                                                            style={{ width: `${Math.min((item.value / total) * 100, 100)}%`, backgroundColor: item.color }}
                                                        />
                                                    </div>
                                                </div>
                                            )
                                        })}
                                    </div>

                                    <div className="mt-6 p-4 rounded-xl border border-[var(--sera-line)] bg-[var(--sera-mist)]">
                                        <div className="flex items-center gap-3">
                                            <div className="p-2 rounded-lg bg-[var(--sera-orange)]/10">
                                                <Wallet className="w-5 h-5 text-[var(--sera-orange)]" strokeWidth={1.75} />
                                            </div>
                                            <div>
                                                <p className="text-sm font-medium text-[var(--sera-ink)]">Collection Rate</p>
                                                <p className="font-display text-2xl font-semibold text-[var(--sera-ink)]">
                                                    {docs?.invoiceCount ? `${Math.round((docs.completedPayments / docs.invoiceCount) * 100)}%` : '—'}
                                                </p>
                                                <p className="text-xs text-[var(--sera-muted)]">acknowledged payments ÷ invoices raised this month</p>
                                            </div>
                                        </div>
                                    </div>
                                </CardContent>
                            </Card>
                        </div>
                    </TabsContent>

                    {/* Products Tab */}
                    <TabsContent value="products" className="space-y-6 animate-in fade-in-50 duration-500">
                        <ProductsTab
                            userProfile={userProfile}
                            chartGridColor={chartGridColor}
                            chartTickColor={chartTickColor}
                            isDark={isDark}
                            {...monthTabs}
                        />
                    </TabsContent>

                    {/* Consumer Analytics Tab */}
                    <TabsContent value="consumer-analytics" className="space-y-6 animate-in fade-in-50 duration-500">
                        <ConsumerAnalyticsTab
                            userProfile={userProfile}
                            chartGridColor={chartGridColor}
                            chartTickColor={chartTickColor}
                            isDark={isDark}
                            {...monthTabs}
                        />
                    </TabsContent>

                    {/* Shop Performance Tab */}
                    <TabsContent value="shop-performance" className="space-y-6 animate-in fade-in-50 duration-500">
                        <ShopReportsTab
                            userProfile={userProfile}
                            chartGridColor={chartGridColor}
                            chartTickColor={chartTickColor}
                            isDark={isDark}
                            {...monthTabs}
                        />
                    </TabsContent>

                    {/* Distributor Reports Tab */}
                    <TabsContent value="distributors" className="space-y-6 animate-in fade-in-50 duration-500">
                        <DistributorReportsTab
                            userProfile={userProfile}
                            chartGridColor={chartGridColor}
                            chartTickColor={chartTickColor}
                            isDark={isDark}
                            {...monthTabs}
                        />
                    </TabsContent>
                    {commissionAccess.can('reporting.commission.view') && (
                        <TabsContent value="commission" className="space-y-6 animate-in fade-in-50 duration-500">
                            {isCommission && <CommissionReportingTab canExport={commissionAccess.can('reporting.commission.export')} />}
                        </TabsContent>
                    )}
                </Tabs>

                {/* Footer */}
                <div className="text-center text-xs text-[var(--sera-muted)] pt-4 border-t border-[var(--sera-line)]">
                    <p>All reports use the selected Reporting Month in Malaysia time (Asia/Kuala_Lumpur).</p>
                </div>
        </div>
    )
}
