'use client'

import { useState, useEffect, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useTheme } from '@/components/providers/ThemeProvider'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
    Legend,
    ResponsiveContainer,
    LineChart,
    Line,
    PieChart,
    Pie,
    Cell,
    ComposedChart,
    RadialBarChart,
    RadialBar
} from 'recharts'
import {
    Calendar,
    Download,
    TrendingUp,
    TrendingDown,
    Users,
    Package,
    ShoppingCart,
    Loader2,
    RefreshCw,
    DollarSign,
    CreditCard,
    Activity,
    ArrowUpRight,
    ArrowDownRight,
    BarChart3,
    PieChart as PieChartIcon,
    Layers,
    Target,
    Wallet,
    Receipt,
    Building2,
    Truck,
    BoxIcon,
    Clock,
    CheckCircle2,
    AlertCircle,
    Zap,
    Store,
    XCircle,
} from 'lucide-react'
import { format, subDays, startOfMonth, endOfMonth, differenceInDays } from 'date-fns'
import ConsumerAnalyticsTab from './ConsumerAnalyticsTab'
import DistributorReportsTab from './DistributorReportsTab'
import ExecutiveKpiValue from './ExecutiveKpiValue'
import OperationsTab from './OperationsTab'
import ProductsTab from './ProductsTab'
import ShopReportsTab from './ShopReportsTab'
import CommissionReportingTab from '@/components/reporting/commission/CommissionReportingTab'
import { APPROVED_SALES_STATUSES, SALES_ORDER_TYPES } from '@/lib/reporting/sales-kpi'
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

export default function ReportingView({ userProfile }: ReportingViewProps) {
    const [loading, setLoading] = useState(true)
    const [data, setData] = useState<any>(null)
    const [error, setError] = useState<string | null>(null)
    const [dateRange, setDateRange] = useState('last30')
    const [distributors, setDistributors] = useState<any[]>([])
    const [selectedDistributor, setSelectedDistributor] = useState<string>('all')
    const [activeTab, setActiveTab] = useState('overview')
    const isConsumerAnalytics = activeTab === 'consumer-analytics'
    const isProductAnalytics = activeTab === 'products'
    const isDistributorAnalytics = activeTab === 'distributors'
    /** Tabs that drive themselves from their own Reporting Month selector. */
    const isCommission = activeTab === 'commission'
    const isMonthlyReportTab = isConsumerAnalytics || isProductAnalytics || isDistributorAnalytics || isCommission
    const commissionAccess = useCommissionAccess()
    const [financialData, setFinancialData] = useState<any>(null)
    const supabase = createClient()
    const { resolvedTheme } = useTheme()
    const isDark = resolvedTheme === 'dark'

    // Theme-aware chart colors
    const chartGridColor = isDark ? '#374151' : '#f0f0f0'
    const chartTickColor = isDark ? '#9ca3af' : '#6b7280'
    const tooltipBg = isDark ? 'rgba(31, 41, 55, 0.95)' : 'rgba(255, 255, 255, 0.95)'
    const tooltipStyle = { borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.2)', backgroundColor: tooltipBg, color: isDark ? '#f3f4f6' : undefined }

    useEffect(() => {
        const fetchDistributors = async () => {
            const { data } = await supabase
                .from('organizations')
                .select('id, org_name')
                .eq('org_type_code', 'DIST')
                .order('org_name')

            if (data) setDistributors(data)
        }
        fetchDistributors()
        fetchFinancialData()
    }, [])

    const dateParams = useMemo(() => {
        const end = new Date()
        let start = new Date()

        switch (dateRange) {
            case 'today':
                start.setHours(0, 0, 0, 0)
                break
            case 'last7':
                start = subDays(end, 7)
                break
            case 'last30':
                start = subDays(end, 30)
                break
            case 'thisMonth':
                start = startOfMonth(end)
                break
            case 'lastMonth':
                start = startOfMonth(subDays(startOfMonth(end), 1))
                end.setTime(endOfMonth(start).getTime())
                break
            case 'last90':
                start = subDays(end, 90)
                break
            default:
                start = subDays(end, 30)
        }

        return {
            startDate: start.toISOString(),
            endDate: end.toISOString()
        }
    }, [dateRange])

    const fetchData = async () => {
        setLoading(true)
        setError(null)
        try {
            const params = new URLSearchParams({
                startDate: dateParams.startDate,
                endDate: dateParams.endDate
            })

            if (selectedDistributor && selectedDistributor !== 'all') {
                params.append('distributorId', selectedDistributor)
            }

            console.log('[ReportingView] Fetching stats with params:', {
                startDate: dateParams.startDate,
                endDate: dateParams.endDate,
                distributor: selectedDistributor
            })

            const res = await fetch(`/api/reporting/stats?${params}`, {
                credentials: 'include', // Ensure cookies are sent with the request
                headers: {
                    'Content-Type': 'application/json',
                }
            })
            const json = await res.json()

            console.log('[ReportingView] API response:', {
                status: res.status,
                ok: res.ok,
                hasData: !!json,
                summary: json?.summary,
                error: json?.error,
                rawJson: JSON.stringify(json).substring(0, 500) // First 500 chars of raw response
            })

            if (!res.ok) {
                const errorMsg = json?.error || `API error: ${res.status}`
                console.error('[ReportingView] API returned error:', errorMsg)
                setError(errorMsg)
                return
            }

            if (json) {
                setData(json)
                // Log successful data load
                console.log('[ReportingView] Data loaded successfully:', {
                    totalOrders: json.summary?.totalOrders,
                    totalUnits: json.summary?.totalUnits,
                    totalRevenue: json.summary?.totalRevenue
                })
            }
        } catch (error: any) {
            console.error('[ReportingView] Error fetching reporting data:', error)
            setError(error.message || 'Failed to fetch reporting data')
        } finally {
            setLoading(false)
        }
    }

    const fetchFinancialData = async () => {
        try {
            // Fetch GL summary data
            const { data: journals } = await supabase
                .from('gl_journals' as any)
                .select('*')
                .eq('status', 'POSTED')
                .order('posting_date', { ascending: false })
                .limit(100)

            const { data: accounts } = await supabase
                .from('gl_accounts' as any)
                .select('*')
                .eq('is_active', true)

            // Fetch order payment data
            const { data: orders } = await supabase
                .from('orders')
                .select('id, order_no, status, created_at, order_items(line_total)')
                .in('status', [...APPROVED_SALES_STATUSES])
                .in('order_type', [...SALES_ORDER_TYPES])
                .order('created_at', { ascending: false })
                .limit(50)

            // Fetch documents for payment tracking
            const { data: documents } = await supabase
                .from('documents')
                .select('*')
                .in('doc_type', ['PAYMENT', 'PAYMENT_REQUEST', 'INVOICE'])
                .order('created_at', { ascending: false })
                .limit(100)

            setFinancialData({
                journals: journals || [],
                accounts: accounts || [],
                orders: orders || [],
                documents: documents || []
            })
        } catch (error) {
            console.error('Error fetching financial data', error)
        }
    }

    useEffect(() => {
        fetchData()
    }, [dateParams, selectedDistributor])

    // Calculate financial metrics
    const financialMetrics = useMemo(() => {
        if (!financialData) return null

        const totalRevenue = financialData.orders?.reduce((sum: number, o: any) => {
            const orderTotal = o.order_items?.reduce((itemSum: number, item: any) => itemSum + (item.line_total || 0), 0) || 0
            return sum + orderTotal
        }, 0) || 0

        const pendingPayments = financialData.documents?.filter((d: any) =>
            d.doc_type === 'PAYMENT_REQUEST' && d.status === 'pending'
        ).length || 0
        const completedPayments = financialData.documents?.filter((d: any) =>
            d.doc_type === 'PAYMENT' && d.status === 'acknowledged'
        ).length || 0
        const invoiceCount = financialData.documents?.filter((d: any) =>
            d.doc_type === 'INVOICE'
        ).length || 0

        return {
            totalRevenue,
            pendingPayments,
            completedPayments,
            invoiceCount
        }
    }, [financialData])

    // Generate trend data
    const trendData = useMemo(() => {
        if (!data?.trend) return []
        return data.trend.map((item: any) => ({
            ...item,
            date: item.date,
            units: item.units || 0
        }))
    }, [data?.trend])

    // Product mix data for pie chart
    const productMixData = useMemo(() => {
        if (!data?.productMix) return []
        return data.productMix.slice(0, 6)
    }, [data?.productMix])

    if (loading && !data) {
        return <SeraLoadingState variant="page" label="Loading executive dashboard" />
    }

    const periodDays = differenceInDays(new Date(dateParams.endDate), new Date(dateParams.startDate))

    return (
        <div className="sera-module-landing">
            <ModuleLightHeader
                eyebrow="Reporting"
                title="Executive Dashboard"
                description="Real-time business intelligence & analytics"
                actions={(
                    <div className="flex flex-wrap items-center gap-2.5">
                        {/* Consumer Analytics and Product Analytics are monthly
                            reports driven by their own Reporting Month selector, so
                            the generic executive date-range and distributor filters
                            are hidden while either is active rather than competing
                            with it. */}
                        {!isMonthlyReportTab && (
                          <>
                        <Select value={dateRange} onValueChange={setDateRange}>
                            <SelectTrigger className="w-[150px] h-10 bg-white border-[var(--sera-line)] text-[var(--sera-ink)]">
                                <Calendar className="w-4 h-4 mr-2 text-[var(--sera-muted)]" />
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="today">Today</SelectItem>
                                <SelectItem value="last7">Last 7 days</SelectItem>
                                <SelectItem value="last30">Last 30 days</SelectItem>
                                <SelectItem value="thisMonth">This month</SelectItem>
                                <SelectItem value="lastMonth">Last month</SelectItem>
                                <SelectItem value="last90">Last 90 days</SelectItem>
                            </SelectContent>
                        </Select>

                        <Select value={selectedDistributor} onValueChange={setSelectedDistributor}>
                            <SelectTrigger className="w-[180px] h-10 bg-white border-[var(--sera-line)] text-[var(--sera-ink)]">
                                <Building2 className="w-4 h-4 mr-2 text-[var(--sera-muted)]" />
                                <SelectValue placeholder="All distributors" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All distributors</SelectItem>
                                {distributors.map((d) => (
                                    <SelectItem key={d.id} value={d.id}>{d.org_name}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                          </>
                        )}

                        <Button
                            variant="outline"
                            size="icon"
                            onClick={fetchData}
                            disabled={loading}
                            className="h-10 w-10 border-[var(--sera-line)] text-[var(--sera-muted)] hover:text-[var(--sera-ink)] hover:border-[var(--sera-orange)]/40"
                            title="Refresh"
                        >
                            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                        </Button>
                    </div>
                )}
            />

                {/* Error Banner */}
                {error && (
                    <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3 min-w-0">
                            <AlertCircle className="w-5 h-5 text-red-500 shrink-0" />
                            <div className="min-w-0">
                                <p className="font-medium text-red-800">Unable to load reporting data</p>
                                <p className="text-sm text-red-600 truncate">{error}</p>
                            </div>
                        </div>
                        <Button variant="outline" size="sm" onClick={fetchData} className="shrink-0 border-red-300 text-red-700 hover:bg-red-100">
                            <RefreshCw className="w-4 h-4 mr-2" />
                            Retry
                        </Button>
                    </div>
                )}

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
                        {/* KPI Cards. Approved Sales = approved, warehouse packed, shipped to distributor and closed
                            sell-side orders (D2H/S2D) by SO date; submitted orders are pipeline, cancelled orders are
                            reported apart and H2M purchases are never sales (lib/reporting/sales-kpi.ts). */}
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                            <MetricCard
                                title="Approved Sales Value"
                                value={data?.summary?.approvedSalesValue ?? data?.summary?.totalRevenue ?? 0}
                                icon={DollarSign}
                                color={COLORS.success}
                                subtitle={`approved sales in ${periodDays} days`}
                                loading={loading}
                            />
                            <MetricCard
                                title="Confirmed Orders"
                                value={data?.summary?.totalOrders || 0}
                                icon={ShoppingCart}
                                color={COLORS.primary}
                                subtitle="approved, packed, shipped or closed"
                                loading={loading}
                            />
                            <MetricCard
                                title="Total Units"
                                value={data?.summary?.totalUnits || 0}
                                icon={Package}
                                color={COLORS.slate}
                                subtitle="on confirmed orders"
                                loading={loading}
                            />
                            <MetricCard
                                title="Active Buyers"
                                value={data?.summary?.activeDistributors || 0}
                                icon={Users}
                                color={COLORS.warning}
                                subtitle="distributors & shops"
                                loading={loading}
                            />
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <MetricCard
                                title="Order Pipeline Value"
                                value={data?.summary?.pipelineValue || 0}
                                icon={Clock}
                                color={COLORS.primary}
                                subtitle={`${data?.summary?.pipelineOrders || 0} submitted, awaiting approval`}
                                loading={loading}
                            />
                            <MetricCard
                                title="Cancelled Orders"
                                value={data?.summary?.cancelledOrders || 0}
                                currency={false}
                                icon={XCircle}
                                color={COLORS.danger}
                                subtitle={`RM ${(data?.summary?.cancelledValue || 0).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} not counted as sales`}
                                loading={loading}
                            />
                            <MetricCard
                                title="H2M Purchases Value"
                                value={data?.summary?.purchaseValue || 0}
                                icon={Truck}
                                color={COLORS.slate}
                                subtitle={`${data?.summary?.purchaseOrders || 0} approved manufacturer orders (not sales)`}
                                loading={loading}
                            />
                        </div>

                        {/* Main Charts Row */}
                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                            {/* Trend Chart */}
                            <Card className="lg:col-span-2 border border-[var(--sera-line)] shadow-none bg-white">
                                <CardHeader className="pb-2">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <CardTitle className="text-base font-semibold text-[var(--sera-ink)]">Shipment Trend</CardTitle>
                                            <CardDescription className="text-[var(--sera-muted)]">Volume over time with growth trajectory</CardDescription>
                                        </div>
                                        <Badge variant="secondary" className="bg-emerald-50 text-emerald-700 border-0">
                                            <TrendingUp className="w-3 h-3 mr-1" />
                                            Growing
                                        </Badge>
                                    </div>
                                </CardHeader>
                                <CardContent>
                                    <div className="h-[350px]">
                                        <ResponsiveContainer width="100%" height="100%">
                                            <AreaChart data={trendData}>
                                                <defs>
                                                    <linearGradient id="colorUnits" x1="0" y1="0" x2="0" y2="1">
                                                        <stop offset="5%" stopColor={COLORS.primary} stopOpacity={0.3} />
                                                        <stop offset="95%" stopColor={COLORS.primary} stopOpacity={0} />
                                                    </linearGradient>
                                                </defs>
                                                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chartGridColor} />
                                                <XAxis
                                                    dataKey="date"
                                                    tickFormatter={(value: string) => {
                                                        const [year, month] = value.split('-')
                                                        const date = new Date(parseInt(year), parseInt(month) - 1)
                                                        return format(date, 'MMM')
                                                    }}
                                                    tickLine={false}
                                                    axisLine={false}
                                                    tick={{ fill: chartTickColor, fontSize: 12 }}
                                                />
                                                <YAxis
                                                    tickLine={false}
                                                    axisLine={false}
                                                    tick={{ fill: chartTickColor, fontSize: 12 }}
                                                    tickFormatter={(value) => value.toLocaleString()}
                                                />
                                                <Tooltip
                                                    contentStyle={{
                                                        borderRadius: '12px',
                                                        border: 'none',
                                                        boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
                                                        backgroundColor: tooltipBg,
                                                        color: isDark ? '#f3f4f6' : undefined
                                                    }}
                                                    formatter={(value: number) => [value.toLocaleString(), 'Units']}
                                                    labelFormatter={(value: string) => {
                                                        const [year, month] = value.split('-')
                                                        const date = new Date(parseInt(year), parseInt(month) - 1)
                                                        return format(date, 'MMMM yyyy')
                                                    }}
                                                />
                                                <Area
                                                    type="monotone"
                                                    dataKey="units"
                                                    stroke={COLORS.primary}
                                                    strokeWidth={3}
                                                    fill="url(#colorUnits)"
                                                    dot={false}
                                                    activeDot={{ r: 6, fill: COLORS.primary, stroke: '#fff', strokeWidth: 2 }}
                                                />
                                            </AreaChart>
                                        </ResponsiveContainer>
                                    </div>
                                </CardContent>
                            </Card>

                            {/* Product Distribution */}
                            <Card className="border border-[var(--sera-line)] shadow-none bg-white">
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-base font-semibold text-[var(--sera-ink)]">Product Distribution</CardTitle>
                                    <CardDescription className="text-[var(--sera-muted)]">Top performing variants</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <div className="h-[200px]">
                                        <ResponsiveContainer width="100%" height="100%">
                                            <PieChart>
                                                <Pie
                                                    data={productMixData}
                                                    cx="50%"
                                                    cy="50%"
                                                    innerRadius={50}
                                                    outerRadius={80}
                                                    paddingAngle={4}
                                                    dataKey="units"
                                                    stroke="none"
                                                >
                                                    {productMixData.map((entry: any, index: number) => (
                                                        <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                                                    ))}
                                                </Pie>
                                                <Tooltip
                                                    contentStyle={tooltipStyle}
                                                    formatter={(value: number) => [value.toLocaleString(), 'Units']}
                                                />
                                            </PieChart>
                                        </ResponsiveContainer>
                                    </div>
                                    <div className="space-y-2 mt-4">
                                        {productMixData.slice(0, 4).map((item: any, index: number) => (
                                            <div key={index} className="flex items-center justify-between">
                                                <div className="flex items-center gap-2">
                                                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: CHART_COLORS[index] }} />
                                                    <span className="text-sm text-muted-foreground truncate max-w-[120px]">{item.name}</span>
                                                </div>
                                                <span className="text-sm font-semibold">{item.units?.toLocaleString()}</span>
                                            </div>
                                        ))}
                                    </div>
                                </CardContent>
                            </Card>
                        </div>

                        {/* Secondary Charts */}
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                            {/* Top Distributors */}
                            <Card className="border border-[var(--sera-line)] shadow-none bg-white">
                                <CardHeader>
                                    <CardTitle className="text-base font-semibold text-[var(--sera-ink)]">Top Distributors</CardTitle>
                                    <CardDescription className="text-[var(--sera-muted)]">By shipment volume</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <div className="h-[300px]">
                                        <ResponsiveContainer width="100%" height="100%">
                                            <BarChart data={data?.distributorPerformance?.slice(0, 5) || []} layout="vertical" margin={{ left: 20 }}>
                                                <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke={chartGridColor} />
                                                <XAxis type="number" hide />
                                                <YAxis
                                                    dataKey="name"
                                                    type="category"
                                                    width={100}
                                                    tick={{ fontSize: 12, fill: chartTickColor }}
                                                    tickLine={false}
                                                    axisLine={false}
                                                />
                                                <Tooltip
                                                    cursor={{ fill: 'transparent' }}
                                                    contentStyle={tooltipStyle}
                                                    formatter={(value: number) => [value.toLocaleString(), 'Units']}
                                                />
                                                <Bar dataKey="units" radius={[0, 8, 8, 0]} barSize={24}>
                                                    {(data?.distributorPerformance?.slice(0, 5) || []).map((entry: any, index: number) => (
                                                        <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                                                    ))}
                                                </Bar>
                                            </BarChart>
                                        </ResponsiveContainer>
                                    </div>
                                </CardContent>
                            </Card>

                            {/* Recent Activity */}
                            <Card className="border border-[var(--sera-line)] shadow-none bg-white">
                                <CardHeader>
                                    <CardTitle className="text-base font-semibold text-[var(--sera-ink)]">Recent Shipments</CardTitle>
                                    <CardDescription className="text-[var(--sera-muted)]">Latest processed orders</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <div className="space-y-3">
                                        {(data?.recentShipments || []).slice(0, 6).map((shipment: any, index: number) => (
                                            <div key={shipment.id || index} className="flex items-center justify-between p-3 rounded-xl bg-[var(--sera-mist)] border border-[var(--sera-line)] hover:border-[var(--sera-orange)]/30 transition-colors">
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <div className="p-2 rounded-lg bg-[var(--sera-orange)]/10 shrink-0">
                                                        <Truck className="w-4 h-4 text-[var(--sera-orange)]" strokeWidth={1.75} />
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p className="text-sm font-medium text-[var(--sera-ink)] truncate">{shipment.distributor}</p>
                                                        <p className="text-xs text-[var(--sera-muted)]">{shipment.orderNo}</p>
                                                    </div>
                                                </div>
                                                <div className="text-right shrink-0 pl-3">
                                                    <p className="text-sm font-semibold text-[var(--sera-ink)]">{shipment.units?.toLocaleString()} units</p>
                                                    <p className="text-xs text-[var(--sera-muted)]">{format(new Date(shipment.date), 'MMM dd, HH:mm')}</p>
                                                </div>
                                            </div>
                                        ))}
                                        {(!data?.recentShipments || data.recentShipments.length === 0) && (
                                            <div className="text-center py-8 text-[var(--sera-muted)]">
                                                <BoxIcon className="w-12 h-12 mx-auto mb-3 opacity-40" />
                                                <p>No recent shipments</p>
                                            </div>
                                        )}
                                    </div>
                                </CardContent>
                            </Card>
                        </div>
                    </TabsContent>

                    {/* Operations Tab */}
                    <TabsContent value="operations" className="space-y-6 animate-in fade-in-50 duration-500">
                        <OperationsTab
                            userProfile={userProfile}
                            chartGridColor={chartGridColor}
                            chartTickColor={chartTickColor}
                            isDark={isDark}
                        />
                    </TabsContent>

                    {/* Finance Tab */}
                    <TabsContent value="finance" className="space-y-6 animate-in fade-in-50 duration-500">
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                            <MetricCard
                                title="Approved Sales Value"
                                value={financialMetrics?.totalRevenue || 0}
                                icon={DollarSign}
                                color={COLORS.success}
                                subtitle="latest 50 approved sales orders"
                                loading={!financialMetrics}
                            />
                            <MetricCard
                                title="Pending Payments"
                                value={financialMetrics?.pendingPayments || 0}
                                icon={Clock}
                                color={COLORS.warning}
                                subtitle="awaiting approval"
                                loading={!financialMetrics}
                            />
                            <MetricCard
                                title="Completed Payments"
                                value={financialMetrics?.completedPayments || 0}
                                icon={CheckCircle2}
                                color={COLORS.success}
                                subtitle="processed"
                                loading={!financialMetrics}
                            />
                            <MetricCard
                                title="Invoices Issued"
                                value={financialMetrics?.invoiceCount || 0}
                                icon={Receipt}
                                color={COLORS.ink}
                                subtitle="total"
                                loading={!financialMetrics}
                            />
                        </div>

                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                            {/* Revenue Breakdown */}
                            <Card className="border border-[var(--sera-line)] shadow-none bg-white">
                                <CardHeader>
                                    <CardTitle className="text-base font-semibold text-[var(--sera-ink)]">Revenue by Account Type</CardTitle>
                                    <CardDescription className="text-[var(--sera-muted)]">Distribution across GL accounts</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <div className="h-[300px] flex items-center justify-center">
                                        <ResponsiveContainer width="100%" height="100%">
                                            <RadialBarChart
                                                cx="50%"
                                                cy="50%"
                                                innerRadius="30%"
                                                outerRadius="100%"
                                                data={[
                                                    { name: 'Sales Revenue', value: 85, fill: COLORS.success },
                                                    { name: 'Other Income', value: 15, fill: COLORS.primary },
                                                ]}
                                                startAngle={180}
                                                endAngle={0}
                                            >
                                                <RadialBar
                                                    background
                                                    dataKey="value"
                                                    cornerRadius={10}
                                                />
                                                <Legend
                                                    iconType="circle"
                                                    layout="horizontal"
                                                    verticalAlign="bottom"
                                                    wrapperStyle={{ paddingTop: '20px' }}
                                                />
                                                <Tooltip />
                                            </RadialBarChart>
                                        </ResponsiveContainer>
                                    </div>
                                </CardContent>
                            </Card>

                            {/* Payment Status */}
                            <Card className="border border-[var(--sera-line)] shadow-none bg-white">
                                <CardHeader>
                                    <CardTitle className="text-base font-semibold text-[var(--sera-ink)]">Payment Status Overview</CardTitle>
                                    <CardDescription className="text-[var(--sera-muted)]">Current payment pipeline</CardDescription>
                                </CardHeader>
                                <CardContent>
                                    <div className="space-y-4">
                                        {[
                                            { label: 'Approved & Collected', value: financialMetrics?.completedPayments || 0, total: 100, color: COLORS.success },
                                            { label: 'Pending Approval', value: financialMetrics?.pendingPayments || 0, total: 100, color: COLORS.warning },
                                            { label: 'Invoices Pending', value: Math.max(0, (financialMetrics?.invoiceCount || 0) - (financialMetrics?.completedPayments || 0)), total: 100, color: COLORS.primary },
                                        ].map((item, index) => (
                                            <div key={index} className="space-y-2">
                                                <div className="flex justify-between text-sm">
                                                    <span className="text-[var(--sera-muted)]">{item.label}</span>
                                                    <span className="font-semibold text-[var(--sera-ink)]">{item.value}</span>
                                                </div>
                                                <div className="h-2 bg-[var(--sera-mist)] rounded-full overflow-hidden">
                                                    <div
                                                        className="h-full rounded-full transition-all duration-1000 ease-out"
                                                        style={{
                                                            width: `${Math.min((item.value / Math.max(item.total, 1)) * 100, 100)}%`,
                                                            backgroundColor: item.color
                                                        }}
                                                    />
                                                </div>
                                            </div>
                                        ))}
                                    </div>

                                    <div className="mt-6 p-4 rounded-xl border border-[var(--sera-line)] bg-[var(--sera-mist)]">
                                        <div className="flex items-center gap-3">
                                            <div className="p-2 rounded-lg bg-[var(--sera-orange)]/10">
                                                <Wallet className="w-5 h-5 text-[var(--sera-orange)]" strokeWidth={1.75} />
                                            </div>
                                            <div>
                                                <p className="text-sm font-medium text-[var(--sera-ink)]">Collection Rate</p>
                                                <p className="font-display text-2xl font-semibold text-[var(--sera-ink)]">
                                                    {financialMetrics?.invoiceCount
                                                        ? Math.round((financialMetrics.completedPayments / financialMetrics.invoiceCount) * 100)
                                                        : 0}%
                                                </p>
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
                        />
                    </TabsContent>

                    {/* Consumer Analytics Tab */}
                    <TabsContent value="consumer-analytics" className="space-y-6 animate-in fade-in-50 duration-500">
                        <ConsumerAnalyticsTab
                            userProfile={userProfile}
                            chartGridColor={chartGridColor}
                            chartTickColor={chartTickColor}
                            isDark={isDark}
                        />
                    </TabsContent>

                    {/* Shop Performance Tab */}
                    <TabsContent value="shop-performance" className="space-y-6 animate-in fade-in-50 duration-500">
                        <ShopReportsTab
                            userProfile={userProfile}
                            chartGridColor={chartGridColor}
                            chartTickColor={chartTickColor}
                            isDark={isDark}
                        />
                    </TabsContent>

                    {/* Distributor Reports Tab */}
                    <TabsContent value="distributors" className="space-y-6 animate-in fade-in-50 duration-500">
                        <DistributorReportsTab
                            userProfile={userProfile}
                            chartGridColor={chartGridColor}
                            chartTickColor={chartTickColor}
                            isDark={isDark}
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
                    <p>Last updated: {format(new Date(), 'MMMM dd, yyyy HH:mm:ss')} • Data refreshes automatically</p>
                </div>
        </div>
    )
}
