'use client'

import { useState, useEffect, useCallback, useMemo, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import {
    ArrowLeft,
    Loader2,
    Search,
    ShoppingBag,
    Package,
    Truck,
    CheckCircle2,
    XCircle,
    Clock,
    CreditCard,
    RefreshCw,
    ChevronLeft,
    ChevronRight,
    Eye,
    X,
    Mail,
    Phone,
    MapPin,
    Calendar,
    DollarSign,
    AlertCircle,
    Filter,
} from 'lucide-react'
import SupplyChainPageHeader from '@/modules/supply-chain/components/SupplyChainPageHeader'
import { isOwnDelivery } from '@/lib/storefront/delivery'
import { REFUND_WINDOW_DAYS, refundWindowEndsAt, refundWindowOpen } from '@/lib/storefront/refund-window'
import { OutdoorMessagesPanel, OutdoorSubscribersPanel } from '@/modules/ecommerce/components/OutdoorInboxPanels'
import { OutdoorCustomerMessagesPanel } from '@/modules/ecommerce/components/OutdoorCustomerMessagesPanel'
import { OutdoorNewsletterComposer } from '@/modules/ecommerce/components/OutdoorNewsletterComposer'
import {
    OrderRequestBadge,
    StoreOpenRequestsPanel,
    StoreOrderRequestsSection,
    useOpenRequestsByOrder,
} from '@/modules/ecommerce/components/StoreOrderRequests'

// ── Types ─────────────────────────────────────────────────────────

interface StorefrontOrderItem {
    id: string
    order_id: string
    variant_id: string | null
    product_name: string
    variant_name: string
    quantity: number
    unit_price: number
    subtotal: number
    created_at: string
}

interface StorefrontOrder {
    id: string
    order_ref: string
    status: string
    customer_name: string
    customer_email: string
    customer_phone: string
    shipping_address: {
        line1?: string
        line2?: string
        city?: string
        state?: string
        postcode?: string
    }
    total_amount: number
    currency: string
    payment_provider: string | null
    payment_ref: string | null
    paid_at: string | null
    organization_id: string | null
    sales_channel?: string | null
    shipping_amount?: number | null
    shipping_courier_name?: string | null
    shipping_tracking_no?: string | null
    /** Delivered orders: when they were marked delivered (refund window). */
    delivered_at?: string | null
    easyparcel_order_no?: string | null
    stock_out_at?: string | null
    stock_returned_at?: string | null
    created_at: string
    updated_at: string
    storefront_order_items: StorefrontOrderItem[]
}

interface CourierEvent {
    status: string
    date: string | null
    location: string | null
}

interface OrderEvent {
    id: string
    event_type: string
    from_status: string | null
    to_status: string | null
    actor_type: string
    actor_label: string | null
    note: string | null
    created_at: string
}

type ShipDetails = { deliveryMethod: 'own' } | { deliveryMethod: 'courier'; courierName: string; trackingNo: string }
type UpdateExtra = ShipDetails | { refundedOutside?: boolean; restock?: boolean }

const MONEY_TAKEN_STATUSES = ['paid', 'processing', 'shipped', 'delivered']

/** Mirrors the server: refunding or cancelling a paid order sends the money back first. */
function needsRefund(fromStatus: string, toStatus: string) {
    return (toStatus === 'refunded' || toStatus === 'cancelled') && MONEY_TAKEN_STATUSES.includes(fromStatus)
}

function isStripeCheckout(order: { payment_provider?: string | null; payment_ref?: string | null }) {
    return order.payment_provider === 'stripe' && String(order.payment_ref || '').startsWith('cs_')
}

/** The detail panel is portalled to <body>, outside `.sera-shell`, so it carries the shell palette itself. */
const PORTAL_THEME = {
    '--sera-ink': '#141210',
    '--sera-ink-soft': '#2a2622',
    '--sera-orange': '#e85d04',
    '--sera-orange-deep': '#c44a00',
    '--sera-mist': '#f2f3f5',
    '--sera-line': '#e8eaed',
    '--sera-muted': '#6b7280',
    '--sera-paper': '#fafbfc',
} as CSSProperties

const CHANNEL_OPTIONS = [
    { value: 'all', label: 'All stores' },
    { value: 'outdoor', label: 'Outdoor' },
    { value: 'store', label: 'Store' },
]

const COURIER_SUGGESTIONS = [
    'J&T Express',
    'Pos Laju',
    'DHL eCommerce',
    'Ninja Van',
    'City-Link Express',
    'GDEX',
    'SPX Express',
    'Flash Express',
    'Skynet',
    'Aramex',
]

function isOutdoorOrder(order: Pick<StorefrontOrder, 'sales_channel'>) {
    return order.sales_channel === 'outdoor'
}

interface StoreOrdersViewProps {
    userProfile: any
    onViewChange: (view: string) => void
}

// ── Status config ─────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, {
    label: string
    color: string
    bgColor: string
    icon: typeof Clock
}> = {
    pending_payment: {
        label: 'Pending Payment',
        color: 'text-amber-600 dark:text-amber-400',
        bgColor: 'bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800',
        icon: Clock,
    },
    paid: {
        label: 'Paid',
        color: 'text-emerald-600 dark:text-emerald-400',
        bgColor: 'bg-emerald-50 dark:bg-emerald-900/30 border-emerald-200 dark:border-emerald-800',
        icon: CreditCard,
    },
    payment_failed: {
        label: 'Payment Failed',
        color: 'text-red-600 dark:text-red-400',
        bgColor: 'bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800',
        icon: XCircle,
    },
    processing: {
        label: 'Processing',
        color: 'text-blue-600 dark:text-blue-400',
        bgColor: 'bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800',
        icon: Package,
    },
    shipped: {
        label: 'Shipped',
        color: 'text-indigo-600 dark:text-indigo-400',
        bgColor: 'bg-indigo-50 dark:bg-indigo-900/30 border-indigo-200 dark:border-indigo-800',
        icon: Truck,
    },
    delivered: {
        label: 'Delivered',
        color: 'text-emerald-600 dark:text-emerald-400',
        bgColor: 'bg-emerald-50 dark:bg-emerald-900/30 border-emerald-200 dark:border-emerald-800',
        icon: CheckCircle2,
    },
    cancelled: {
        label: 'Cancelled',
        color: 'text-gray-500 dark:text-gray-400',
        bgColor: 'bg-gray-50 dark:bg-gray-800/50 border-gray-200 dark:border-gray-700',
        icon: XCircle,
    },
    refunded: {
        label: 'Refunded',
        color: 'text-orange-600 dark:text-orange-400',
        bgColor: 'bg-orange-50 dark:bg-orange-900/30 border-orange-200 dark:border-orange-800',
        icon: RefreshCw,
    },
}

const STATUS_TRANSITIONS: Record<string, string[]> = {
    pending_payment: ['paid', 'cancelled'],
    paid: ['processing', 'cancelled', 'refunded'],
    payment_failed: ['pending_payment', 'cancelled'],
    processing: ['shipped', 'cancelled', 'refunded'],
    shipped: ['delivered', 'refunded'],
    delivered: ['refunded'],
    cancelled: [],
    refunded: [],
}

// ── Helpers ──────────────────────────────────────────────────────

function formatCurrency(amount: number, currency = 'MYR') {
    return new Intl.NumberFormat('en-MY', {
        style: 'currency',
        currency,
        minimumFractionDigits: 2,
    }).format(amount)
}

function formatDate(dateStr: string) {
    return new Date(dateStr).toLocaleDateString('en-MY', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    })
}

function formatShortDate(dateStr: string) {
    return new Date(dateStr).toLocaleDateString('en-MY', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    })
}

// ── Component ─────────────────────────────────────────────────────

export default function StoreOrdersView({ userProfile, onViewChange }: StoreOrdersViewProps) {
    const [orders, setOrders] = useState<StorefrontOrder[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [statusFilter, setStatusFilter] = useState('all')
    const [channelFilter, setChannelFilter] = useState('all')
    const [shipForm, setShipForm] = useState<{ method: 'own' | 'courier'; courier: string; tracking: string } | null>(null)
    const [refundAsk, setRefundAsk] = useState<'refunded' | 'cancelled' | null>(null)
    const [restock, setRestock] = useState(false)
    const [notice, setNotice] = useState<string | null>(null)
    const [history, setHistory] = useState<OrderEvent[]>([])
    const [historyAvailable, setHistoryAvailable] = useState(true)
    const [historyRefresh, setHistoryRefresh] = useState(0)
    const [tab, setTab] = useState<'orders' | 'messages' | 'subscribers' | 'customer_messages'>('orders')
    const [courierEvents, setCourierEvents] = useState<CourierEvent[]>([])
    const [courierLatest, setCourierLatest] = useState<string | null>(null)
    const [courierLoading, setCourierLoading] = useState(false)
    const [searchQuery, setSearchQuery] = useState('')
    const [debouncedSearch, setDebouncedSearch] = useState('')
    const [page, setPage] = useState(1)
    const [totalPages, setTotalPages] = useState(1)
    const [totalOrders, setTotalOrders] = useState(0)
    const [selectedOrder, setSelectedOrder] = useState<StorefrontOrder | null>(null)
    const [updatingStatus, setUpdatingStatus] = useState(false)
    const [requestsRefresh, setRequestsRefresh] = useState(0)
    const openRequestsByOrder = useOpenRequestsByOrder(useMemo(() => orders.map(o => o.id), [orders]), requestsRefresh)

    useEffect(() => {
        const params = new URLSearchParams(window.location.search)
        const fromUrl = params.get('channel')
        if (fromUrl && CHANNEL_OPTIONS.some(option => option.value === fromUrl)) setChannelFilter(fromUrl)
        const tabFromUrl = params.get('tab')
        if (tabFromUrl === 'messages' || tabFromUrl === 'subscribers' || tabFromUrl === 'customer_messages') setTab(tabFromUrl)
    }, [])

    // ── Debounce search ──────────────────────────────────────────

    useEffect(() => {
        const timer = setTimeout(() => {
            setDebouncedSearch(searchQuery)
            setPage(1)
        }, 400)
        return () => clearTimeout(timer)
    }, [searchQuery])

    // ── Fetch orders ─────────────────────────────────────────────

    const fetchOrders = useCallback(async () => {
        try {
            setLoading(true)
            setError(null)

            const params = new URLSearchParams()
            params.set('page', String(page))
            params.set('limit', '25')
            if (statusFilter !== 'all') params.set('status', statusFilter)
            if (channelFilter !== 'all') params.set('salesChannel', channelFilter)
            if (debouncedSearch) params.set('search', debouncedSearch)

            const res = await fetch(`/api/admin/store/orders?${params.toString()}`)
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}))
                throw new Error(errData.error || 'Failed to fetch orders')
            }

            const data = await res.json()
            setOrders(data.orders || [])
            setTotalPages(data.totalPages || 1)
            setTotalOrders(data.total || 0)
        } catch (err: any) {
            setError(err.message)
        } finally {
            setLoading(false)
        }
    }, [page, statusFilter, channelFilter, debouncedSearch])

    useEffect(() => { fetchOrders() }, [fetchOrders])

    // ── Update order status ──────────────────────────────────────

    const handleStatusUpdate = async (
        orderId: string,
        newStatus: string,
        shipping?: UpdateExtra,
    ) => {
        if (!shipping && !confirm(`Change order status to "${STATUS_CONFIG[newStatus]?.label || newStatus}"?`)) return

        setUpdatingStatus(true)
        setError(null)
        setNotice(null)

        try {
            const res = await fetch('/api/admin/store/orders', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: orderId, status: newStatus, ...shipping }),
            })

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}))
                throw new Error(errData.error || 'Failed to update order')
            }

            const data = await res.json()
            // Update local state
            setOrders(prev => prev.map(o => o.id === orderId ? { ...o, ...data.order, storefront_order_items: o.storefront_order_items } : o))
            if (selectedOrder?.id === orderId) {
                setSelectedOrder(prev => prev ? { ...prev, ...data.order, storefront_order_items: prev.storefront_order_items } : null)
            }
            setShipForm(null)
            setRefundAsk(null)
            setNotice(typeof data.warning === 'string' ? data.warning : null)
            setHistoryRefresh(n => n + 1)
        } catch (err: any) {
            setError(err.message)
        } finally {
            setUpdatingStatus(false)
        }
    }

    // ── Courier tracking updates for the open order ──────────────

    const selectedOrderRef = selectedOrder?.order_ref
    const selectedOrderEmail = selectedOrder?.customer_email
    const selectedTrackingNo = selectedOrder?.shipping_tracking_no?.trim() || ''

    useEffect(() => {
        setShipForm(null)
        setRefundAsk(null)
        setNotice(null)
        if (selectedOrderRef) setError(null)
    }, [selectedOrderRef])

    const selectedOrderId = selectedOrder?.id
    useEffect(() => {
        setHistory([])
        if (!selectedOrderId) return
        let cancelled = false
        fetch(`/api/admin/store/orders?eventsFor=${encodeURIComponent(selectedOrderId)}`)
            .then(res => res.json().catch(() => null))
            .then(data => {
                if (cancelled) return
                setHistory(Array.isArray(data?.events) ? data.events : [])
                setHistoryAvailable(data?.historyAvailable !== false)
            })
            .catch(() => undefined)
        return () => { cancelled = true }
    }, [selectedOrderId, historyRefresh])

    useEffect(() => {
        setCourierEvents([])
        setCourierLatest(null)
        if (!selectedOrderRef || !selectedOrderEmail || !selectedTrackingNo) return
        let cancelled = false
        setCourierLoading(true)
        fetch('/api/storefront/orders/lookup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderRef: selectedOrderRef, email: selectedOrderEmail }),
        })
            .then(res => res.json().catch(() => null))
            .then(data => {
                if (cancelled) return
                setCourierEvents(Array.isArray(data?.order?.courierEvents) ? data.order.courierEvents : [])
                setCourierLatest(data?.order?.courierLatestStatus || null)
            })
            .catch(() => undefined)
            .finally(() => { if (!cancelled) setCourierLoading(false) })
        return () => { cancelled = true }
    }, [selectedOrderRef, selectedOrderEmail, selectedTrackingNo])

    // ── Status summary counts ────────────────────────────────────

    const statusCounts = useMemo(() => {
        const counts: Record<string, number> = {}
        orders.forEach(o => {
            counts[o.status] = (counts[o.status] || 0) + 1
        })
        return counts
    }, [orders])

    // ── Render status badge ──────────────────────────────────────

    const renderStatusBadge = (status: string, size: 'sm' | 'md' = 'sm') => {
        const config = STATUS_CONFIG[status] || {
            label: status,
            color: 'text-gray-500',
            bgColor: 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700',
            icon: AlertCircle,
        }
        const Icon = config.icon
        const sizeClasses = size === 'sm' ? 'text-[11px] px-2 py-0.5' : 'text-xs px-2.5 py-1'

        return (
            <span className={`inline-flex items-center gap-1 ${sizeClasses} font-medium rounded-full border ${config.bgColor} ${config.color}`}>
                <Icon className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
                {config.label}
            </span>
        )
    }

    const renderChannelBadge = (order: StorefrontOrder) => (
        <span
            className={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${
                isOutdoorOrder(order)
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
                    : 'border-gray-200 bg-gray-50 text-gray-600 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-300'
            }`}
        >
            {isOutdoorOrder(order) ? 'Outdoor' : 'Store'}
        </span>
    )

    // ── Order detail panel ───────────────────────────────────────

    const renderOrderDetail = () => {
        if (!selectedOrder) return null

        const refundClosed = selectedOrder.status === 'delivered' && !refundWindowOpen(selectedOrder.delivered_at)
        const refundEnds = selectedOrder.status === 'delivered' ? refundWindowEndsAt(selectedOrder.delivered_at) : null
        const transitions = (STATUS_TRANSITIONS[selectedOrder.status] || []).filter((s) => !(refundClosed && s === 'refunded'))
        const addr = selectedOrder.shipping_address || {}

        return (
            <div className="fixed inset-0 z-50 flex items-start justify-end" style={PORTAL_THEME}>
                {/* Backdrop */}
                <div
                    className="absolute inset-0 bg-black/40 backdrop-blur-sm"
                    onClick={() => setSelectedOrder(null)}
                />

                {/* Panel */}
                <div className="relative w-full max-w-lg h-full bg-card border-l border-border shadow-2xl overflow-y-auto animate-in slide-in-from-right-5 duration-200">
                    {/* Header */}
                    <div className="sticky top-0 z-10 bg-card border-b border-border px-5 py-4 flex items-center justify-between">
                        <div>
                            <h2 className="flex items-center gap-2 font-semibold text-base text-foreground">
                                {selectedOrder.order_ref}
                                {renderChannelBadge(selectedOrder)}
                            </h2>
                            <p className="text-xs text-muted-foreground mt-0.5">
                                Created {formatDate(selectedOrder.created_at)}
                            </p>
                        </div>
                        <button
                            onClick={() => setSelectedOrder(null)}
                            className="p-1.5 rounded-lg hover:bg-accent transition-colors"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>

                    <div className="p-5 space-y-5">
                        {/* Status */}
                        <div className="space-y-2">
                            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</label>
                            <div className="flex items-center gap-3 flex-wrap">
                                {renderStatusBadge(selectedOrder.status, 'md')}
                                {transitions.length > 0 && (
                                    <div className="flex items-center gap-1.5">
                                        <span className="text-xs text-muted-foreground">→</span>
                                        {transitions.map(nextStatus => (
                                            <button
                                                key={nextStatus}
                                                onClick={() => {
                                                    if (nextStatus === 'shipped') {
                                                        setRefundAsk(null)
                                                        setShipForm({
                                                            method: selectedOrder.shipping_tracking_no ? 'courier' : 'own',
                                                            courier: selectedOrder.shipping_tracking_no ? selectedOrder.shipping_courier_name || '' : '',
                                                            tracking: selectedOrder.shipping_tracking_no || '',
                                                        })
                                                    } else if (needsRefund(selectedOrder.status, nextStatus)) {
                                                        setShipForm(null)
                                                        setRestock(false)
                                                        setRefundAsk(nextStatus as 'refunded' | 'cancelled')
                                                    } else {
                                                        void handleStatusUpdate(selectedOrder.id, nextStatus)
                                                    }
                                                }}
                                                disabled={updatingStatus}
                                                className="text-[11px] font-medium px-2 py-0.5 rounded-full border border-border hover:bg-accent hover:border-violet-300 dark:hover:border-violet-700 transition-colors disabled:opacity-50"
                                            >
                                                {STATUS_CONFIG[nextStatus]?.label || nextStatus}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                            {refundEnds && (
                                <p className="text-xs text-muted-foreground">
                                    {refundClosed
                                        ? `Refund window ended ${formatDate(refundEnds.toISOString())} (${REFUND_WINDOW_DAYS} days after delivery).`
                                        : `Can be refunded until ${formatDate(refundEnds.toISOString())} (${REFUND_WINDOW_DAYS} days after delivery).`}
                                </p>
                            )}
                            {shipForm && (
                                <div className="mt-2 rounded-xl border border-border p-3 space-y-2">
                                    <p className="text-xs font-medium text-foreground">How is this order being delivered?</p>
                                    <div className="flex flex-wrap gap-3 text-xs">
                                        <label className="inline-flex items-center gap-1.5 cursor-pointer">
                                            <input
                                                type="radio"
                                                name="delivery-method"
                                                checked={shipForm.method === 'own'}
                                                onChange={() => setShipForm(f => f ? { ...f, method: 'own' } : f)}
                                            />
                                            Our own delivery team
                                        </label>
                                        <label className="inline-flex items-center gap-1.5 cursor-pointer">
                                            <input
                                                type="radio"
                                                name="delivery-method"
                                                checked={shipForm.method === 'courier'}
                                                onChange={() => setShipForm(f => f ? { ...f, method: 'courier' } : f)}
                                            />
                                            Courier company
                                        </label>
                                    </div>
                                    {shipForm.method === 'courier' && (
                                        <p className="text-[11px] text-muted-foreground">
                                            {isOutdoorOrder(selectedOrder)
                                                ? 'Courier and tracking number are required.'
                                                : 'Courier and tracking number are optional.'}
                                        </p>
                                    )}
                                    {shipForm.method === 'courier' && <div className="flex flex-col sm:flex-row gap-2">
                                        <input
                                            value={shipForm.courier}
                                            onChange={(e) => setShipForm(f => f ? { ...f, courier: e.target.value } : f)}
                                            list="store-orders-courier-suggestions"
                                            maxLength={120}
                                            placeholder="Courier (e.g. J&T Express)"
                                            aria-label="Courier"
                                            className="flex-1 text-sm border border-border rounded-lg bg-background px-3 py-1.5"
                                        />
                                        <input
                                            value={shipForm.tracking}
                                            onChange={(e) => setShipForm(f => f ? { ...f, tracking: e.target.value } : f)}
                                            maxLength={60}
                                            placeholder="Tracking no."
                                            aria-label="Tracking number"
                                            className="flex-1 text-sm border border-border rounded-lg bg-background px-3 py-1.5"
                                        />
                                    </div>}
                                    <datalist id="store-orders-courier-suggestions">
                                        {COURIER_SUGGESTIONS.map(name => <option key={name} value={name} />)}
                                    </datalist>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => handleStatusUpdate(selectedOrder.id, 'shipped', shipForm.method === 'own'
                                                ? { deliveryMethod: 'own' }
                                                : {
                                                    deliveryMethod: 'courier',
                                                    courierName: shipForm.courier.trim(),
                                                    trackingNo: shipForm.tracking.trim(),
                                                })}
                                            disabled={updatingStatus || (
                                                shipForm.method === 'courier'
                                                && isOutdoorOrder(selectedOrder)
                                                && (!shipForm.courier.trim() || !shipForm.tracking.trim())
                                            )}
                                            className="text-xs font-medium px-3 py-1.5 rounded-lg bg-[var(--sera-orange,#f97316)] text-white disabled:opacity-50"
                                        >
                                            Mark shipped
                                        </button>
                                        <button
                                            onClick={() => setShipForm(null)}
                                            className="text-xs font-medium px-3 py-1.5 rounded-lg border border-border hover:bg-accent"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </div>
                            )}
                            {refundAsk && (() => {
                                const viaStripe = isStripeCheckout(selectedOrder)
                                const amount = formatCurrency(selectedOrder.total_amount, selectedOrder.currency)
                                const provider = selectedOrder.payment_provider || 'another payment method'
                                const stockIsOut = Boolean(selectedOrder.stock_out_at && !selectedOrder.stock_returned_at)
                                return (
                                    <div className="mt-2 rounded-xl border border-amber-300 bg-amber-50 p-3 space-y-2 dark:border-amber-800 dark:bg-amber-950/30">
                                        <p className="text-xs font-semibold text-foreground">
                                            {refundAsk === 'refunded' ? `Refund ${amount} to the customer?` : `Cancel this order and refund ${amount}?`}
                                        </p>
                                        <p className="text-[11px] text-muted-foreground">
                                            {viaStripe
                                                ? 'The full amount goes back to the card or account they paid with, through Stripe. This can’t be undone. Banks usually show it within 5–10 business days.'
                                                : `This order was paid with ${provider}, so the money can’t be sent back from here. Refund it in ${provider} first, then confirm to update the order.`}
                                        </p>
                                        {stockIsOut ? (
                                            <label className="flex items-start gap-2 rounded-lg border border-amber-200 bg-white/70 px-2.5 py-2 text-[11px] text-foreground cursor-pointer dark:border-amber-900 dark:bg-black/20">
                                                <input
                                                    type="checkbox"
                                                    checked={restock}
                                                    onChange={(e) => setRestock(e.target.checked)}
                                                    disabled={updatingStatus}
                                                    className="mt-0.5"
                                                />
                                                <span>
                                                    <span className="font-medium">The items came back to the warehouse</span>
                                                    <span className="block text-muted-foreground">
                                                        Tick only once the parcel is physically back — this puts the stock back into Inventory. Leave it unticked if the customer keeps the items or they were lost.
                                                    </span>
                                                </span>
                                            </label>
                                        ) : (
                                            <p className="text-[11px] text-muted-foreground">
                                                {selectedOrder.stock_returned_at
                                                    ? 'The items are already back in warehouse stock.'
                                                    : 'Nothing was taken out of warehouse stock for this order, so stock stays as it is.'}
                                            </p>
                                        )}
                                        <div className="flex flex-wrap items-center gap-2">
                                            <button
                                                onClick={() => handleStatusUpdate(
                                                    selectedOrder.id,
                                                    refundAsk,
                                                    { ...(viaStripe ? {} : { refundedOutside: true }), ...(stockIsOut && restock ? { restock: true } : {}) },
                                                )}
                                                disabled={updatingStatus}
                                                className="text-xs font-medium px-3 py-1.5 rounded-lg bg-[var(--sera-orange,#f97316)] text-white disabled:opacity-50"
                                            >
                                                {updatingStatus
                                                    ? viaStripe ? 'Refunding…' : 'Saving…'
                                                    : viaStripe ? `Refund ${amount}` : 'I’ve refunded it — update the order'}
                                            </button>
                                            <button
                                                onClick={() => setRefundAsk(null)}
                                                disabled={updatingStatus}
                                                className="text-xs font-medium px-3 py-1.5 rounded-lg border border-border hover:bg-accent"
                                            >
                                                Keep the order
                                            </button>
                                        </div>
                                    </div>
                                )
                            })()}
                            {error && (
                                <p className="mt-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                                    {error}
                                </p>
                            )}
                            {notice && (
                                <p className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                                    {notice}
                                </p>
                            )}
                        </div>

                        {/* Shipping */}
                        <div className="bg-accent/40 rounded-xl p-4 space-y-2.5">
                            <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                                <Truck className="h-3.5 w-3.5" /> Shipping
                            </h3>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <span className="text-[11px] text-muted-foreground">Shipping fee</span>
                                    <p className="text-sm text-foreground">
                                        {Number(selectedOrder.shipping_amount) > 0
                                            ? formatCurrency(Number(selectedOrder.shipping_amount), selectedOrder.currency)
                                            : 'Free'}
                                    </p>
                                </div>
                                <div>
                                    <span className="text-[11px] text-muted-foreground">Delivered by</span>
                                    <p className="text-sm text-foreground">
                                        {isOwnDelivery(selectedOrder.shipping_courier_name)
                                            ? 'Our own team'
                                            : selectedOrder.shipping_tracking_no && selectedOrder.shipping_courier_name
                                                ? selectedOrder.shipping_courier_name
                                                : '—'}
                                    </p>
                                </div>
                                <div className="col-span-2">
                                    <span className="text-[11px] text-muted-foreground">Tracking number</span>
                                    <p className="text-sm font-mono text-foreground">{selectedOrder.shipping_tracking_no || '—'}</p>
                                </div>
                                {selectedOrder.easyparcel_order_no && (
                                    <div className="col-span-2">
                                        <span className="text-[11px] text-muted-foreground">EasyParcel order</span>
                                        <p className="text-sm font-mono text-foreground">{selectedOrder.easyparcel_order_no}</p>
                                    </div>
                                )}
                                {selectedOrder.stock_out_at && (
                                    <div className="col-span-2">
                                        <span className="text-[11px] text-muted-foreground">Warehouse stock</span>
                                        <p className="text-sm text-foreground">
                                            Taken out {formatDate(selectedOrder.stock_out_at)}
                                            {selectedOrder.stock_returned_at ? ` · put back ${formatDate(selectedOrder.stock_returned_at)}` : ''}
                                        </p>
                                    </div>
                                )}
                            </div>
                            {selectedOrder.shipping_tracking_no && (
                                <div className="border-t border-border pt-2.5">
                                    <span className="text-[11px] text-muted-foreground">Tracking updates</span>
                                    {courierLoading ? (
                                        <p className="text-xs text-muted-foreground mt-1">Loading…</p>
                                    ) : courierEvents.length === 0 ? (
                                        <p className="text-xs text-muted-foreground mt-1">
                                            {courierLatest || 'No courier updates yet.'}
                                        </p>
                                    ) : (
                                        <ul className="mt-1 space-y-1.5">
                                            {courierEvents.map((ev, i) => (
                                                <li key={`${ev.status}-${i}`} className="text-xs">
                                                    <span className="font-medium text-foreground">{ev.status}</span>
                                                    {ev.location ? <span className="text-muted-foreground"> · {ev.location}</span> : null}
                                                    {ev.date ? <span className="text-muted-foreground"> · {ev.date}</span> : null}
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Customer info */}
                        <div className="bg-accent/40 rounded-xl p-4 space-y-2.5">
                            <h3 className="text-sm font-semibold text-foreground">Customer</h3>
                            <div className="space-y-1.5">
                                <div className="flex items-center gap-2 text-sm">
                                    <span className="font-medium text-foreground">{selectedOrder.customer_name}</span>
                                </div>
                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Mail className="h-3 w-3 shrink-0" />
                                    <span>{selectedOrder.customer_email}</span>
                                </div>
                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <Phone className="h-3 w-3 shrink-0" />
                                    <span>{selectedOrder.customer_phone}</span>
                                </div>
                                {(addr.line1 || addr.city) && (
                                    <div className="flex items-start gap-2 text-xs text-muted-foreground">
                                        <MapPin className="h-3 w-3 shrink-0 mt-0.5" />
                                        <span>
                                            {[addr.line1, addr.line2, addr.city, addr.state, addr.postcode]
                                                .filter(Boolean)
                                                .join(', ')}
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Payment info */}
                        <div className="bg-accent/40 rounded-xl p-4 space-y-2.5">
                            <h3 className="text-sm font-semibold text-foreground">Payment</h3>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <span className="text-[11px] text-muted-foreground">Amount</span>
                                    <p className="text-sm font-semibold text-foreground">
                                        {formatCurrency(selectedOrder.total_amount, selectedOrder.currency)}
                                    </p>
                                </div>
                                <div>
                                    <span className="text-[11px] text-muted-foreground">Provider</span>
                                    <p className="text-sm text-foreground capitalize">
                                        {selectedOrder.payment_provider || '—'}
                                    </p>
                                </div>
                                {selectedOrder.payment_ref && (
                                    <div className="col-span-2 min-w-0">
                                        <span className="text-[11px] text-muted-foreground">Reference</span>
                                        <p className="text-xs font-mono text-foreground break-all">{selectedOrder.payment_ref}</p>
                                    </div>
                                )}
                                {selectedOrder.paid_at && (
                                    <div>
                                        <span className="text-[11px] text-muted-foreground">Paid At</span>
                                        <p className="text-sm text-foreground">{formatDate(selectedOrder.paid_at)}</p>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Order items */}
                        <div className="space-y-2">
                            <h3 className="text-sm font-semibold text-foreground">
                                Items ({selectedOrder.storefront_order_items?.length || 0})
                            </h3>
                            <div className="divide-y divide-border border border-border rounded-xl overflow-hidden">
                                {(selectedOrder.storefront_order_items || []).map((item) => (
                                    <div key={item.id} className="p-3 flex items-center justify-between gap-3">
                                        <div className="min-w-0 flex-1">
                                            <p className="text-sm font-medium text-foreground truncate">{item.product_name}</p>
                                            <p className="text-xs text-muted-foreground">{item.variant_name}</p>
                                        </div>
                                        <div className="text-right shrink-0">
                                            <p className="text-sm font-medium text-foreground">
                                                {formatCurrency(item.subtotal, selectedOrder.currency)}
                                            </p>
                                            <p className="text-[11px] text-muted-foreground">
                                                {item.quantity} × {formatCurrency(item.unit_price, selectedOrder.currency)}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                                {/* Total row */}
                                <div className="p-3 bg-accent/40 flex items-center justify-between">
                                    <span className="text-sm font-semibold text-foreground">Total</span>
                                    <span className="text-sm font-bold text-foreground">
                                        {formatCurrency(selectedOrder.total_amount, selectedOrder.currency)}
                                    </span>
                                </div>
                            </div>
                        </div>

                        <StoreOrderRequestsSection
                            key={selectedOrder.id}
                            orderId={selectedOrder.id}
                            onChanged={() => setRequestsRefresh(n => n + 1)}
                        />

                        {/* History */}
                        <div className="space-y-2">
                            <h3 className="text-sm font-semibold text-foreground">History</h3>
                            {!historyAvailable ? (
                                <p className="text-xs text-muted-foreground">History is not set up yet (database migration pending).</p>
                            ) : history.length === 0 ? (
                                <p className="text-xs text-muted-foreground">No history recorded yet. Changes from now on appear here.</p>
                            ) : (
                                <ol className="relative border-l border-border ml-1.5 space-y-3">
                                    {history.map(event => {
                                        const to = event.to_status ? STATUS_CONFIG[event.to_status]?.label || event.to_status : null
                                        const from = event.from_status ? STATUS_CONFIG[event.from_status]?.label || event.from_status : null
                                        const title = event.event_type === 'created'
                                            ? 'Order placed'
                                            : event.event_type === 'shipping_updated'
                                                ? 'Shipping details updated'
                                                : to
                                                    ? from ? `${from} → ${to}` : to
                                                    : 'Update'
                                        const who = event.actor_type === 'system'
                                            ? 'Automatic'
                                            : event.actor_type === 'payment'
                                                ? 'Payment gateway'
                                                : event.actor_type === 'customer'
                                                    ? `Customer${event.actor_label ? ` · ${event.actor_label}` : ''}`
                                                    : event.actor_label || 'Staff'
                                        return (
                                            <li key={event.id} className="ml-3">
                                                <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full border border-card bg-[var(--sera-orange,#f97316)]" />
                                                <p className="text-xs font-medium text-foreground">{title}</p>
                                                {event.note ? <p className="text-[11px] text-muted-foreground">{event.note}</p> : null}
                                                <p className="text-[11px] text-muted-foreground">{who} · {formatDate(event.created_at)}</p>
                                            </li>
                                        )
                                    })}
                                </ol>
                            )}
                        </div>

                        {/* Timestamps */}
                        <div className="text-[11px] text-muted-foreground space-y-1 py-2 border-t border-border">
                            <div className="flex items-center gap-1.5">
                                <Calendar className="h-3 w-3" />
                                Created: {formatDate(selectedOrder.created_at)}
                            </div>
                            <div className="flex items-center gap-1.5">
                                <Calendar className="h-3 w-3" />
                                Updated: {formatDate(selectedOrder.updated_at)}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        )
    }

    // ── Main render ──────────────────────────────────────────────

    return (
        <div className="sera-sc-page sera-page-enter w-full max-w-6xl mx-auto">
            <SupplyChainPageHeader
                eyebrow="Customer & Growth"
                title="Store Orders"
                description="View and manage online storefront orders"
                actions={
                    <button
                        onClick={() => { fetchOrders(); setRequestsRefresh(n => n + 1) }}
                        disabled={loading}
                        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-[var(--sera-line)] rounded-lg bg-white hover:bg-[var(--sera-mist)] transition-colors disabled:opacity-50 text-[var(--sera-ink)]"
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                        Refresh
                    </button>
                }
            />

            {/* Error */}
            {error && (
                <div className="bg-destructive/10 border border-destructive/20 text-destructive rounded-lg px-4 py-3 text-sm flex items-center justify-between">
                    <span>{error}</span>
                    <button onClick={() => setError(null)} className="ml-2 underline text-xs">Dismiss</button>
                </div>
            )}

            <div className="flex gap-1 border-b border-[var(--sera-line)]">
                {([
                    ['orders', 'Orders'],
                    ['messages', 'Outdoor messages'],
                    ['subscribers', 'Newsletter subscribers'],
                    ['customer_messages', 'Customer emails & SMS'],
                ] as const).map(([value, label]) => (
                    <button
                        key={value}
                        onClick={() => setTab(value)}
                        className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                            tab === value
                                ? 'border-[var(--sera-orange,#f97316)] text-[var(--sera-ink)]'
                                : 'border-transparent text-[var(--sera-muted)] hover:text-[var(--sera-ink)]'
                        }`}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {tab === 'messages' ? <OutdoorMessagesPanel /> : tab === 'subscribers' ? <div className="space-y-6"><OutdoorNewsletterComposer /><OutdoorSubscribersPanel /></div> : tab === 'customer_messages' ? <OutdoorCustomerMessagesPanel /> : (<>
            <StoreOpenRequestsPanel refreshKey={requestsRefresh} onOpenOrder={(order) => setSelectedOrder(order)} />

            {/* Filters */}
            <div className="sera-sc-panel p-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                {/* Search */}
                <div className="relative flex-1 max-w-md">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--sera-muted)]" />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Search by order ref, name, email or tracking no…"
                        className="w-full pl-9 pr-3 py-2 text-sm border border-[var(--sera-line)] rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]/25 transition-shadow"
                    />
                </div>

                {/* Status filter */}
                <div className="flex items-center gap-1.5">
                    <Filter className="h-3.5 w-3.5 text-[var(--sera-muted)]" />
                    <select
                        value={channelFilter}
                        onChange={(e) => { setChannelFilter(e.target.value); setPage(1) }}
                        aria-label="Store"
                        className="text-sm border border-[var(--sera-line)] rounded-lg bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]/25 text-[var(--sera-ink)]"
                    >
                        {CHANNEL_OPTIONS.map(option => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                    </select>
                    <select
                        value={statusFilter}
                        onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }}
                        className="text-sm border border-[var(--sera-line)] rounded-lg bg-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]/25 text-[var(--sera-ink)]"
                    >
                        <option value="all">All Statuses</option>
                        {Object.entries(STATUS_CONFIG).map(([key, config]) => (
                            <option key={key} value={key}>{config.label}</option>
                        ))}
                    </select>
                </div>
            </div>

            {/* Summary cards */}
            {!loading && orders.length > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="sera-sc-kpi">
                        <p className="sera-sc-kpi__label">Total Orders</p>
                        <p className="sera-sc-kpi__value">{totalOrders}</p>
                    </div>
                    <div className="sera-sc-kpi">
                        <p className="sera-sc-kpi__label">Pending Payment</p>
                        <p className="sera-sc-kpi__value">{statusCounts['pending_payment'] || 0}</p>
                    </div>
                    <div className="sera-sc-kpi">
                        <p className="sera-sc-kpi__label">Processing</p>
                        <p className="sera-sc-kpi__value">{statusCounts['processing'] || 0}</p>
                    </div>
                    <div className="sera-sc-kpi">
                        <p className="sera-sc-kpi__label">Delivered</p>
                        <p className="sera-sc-kpi__value">{statusCounts['delivered'] || 0}</p>
                    </div>
                </div>
            )}

            {/* Orders table */}
            {loading ? (
                <div className="flex items-center justify-center py-24">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
            ) : orders.length === 0 ? (
                <div className="bg-card border border-border rounded-xl p-12 text-center">
                    <ShoppingBag className="h-12 w-12 mx-auto text-muted-foreground/40 mb-3" />
                    <h3 className="font-semibold text-foreground mb-1">No orders found</h3>
                    <p className="text-sm text-muted-foreground mb-1">
                        {statusFilter !== 'all' || channelFilter !== 'all' || debouncedSearch
                            ? 'Try adjusting your filters or search query.'
                            : 'Orders from your online storefront will appear here.'}
                    </p>
                </div>
            ) : (
                <>
                    {/* Desktop table */}
                    <div className="hidden md:block bg-card border border-border rounded-xl overflow-hidden">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-border bg-accent/30">
                                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Order</th>
                                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Customer</th>
                                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                                    <th className="text-right px-4 py-3 font-medium text-muted-foreground">Amount</th>
                                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Date</th>
                                    <th className="text-center px-4 py-3 font-medium text-muted-foreground">Items</th>
                                    <th className="text-center px-4 py-3 font-medium text-muted-foreground"></th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {orders.map((order) => (
                                    <tr
                                        key={order.id}
                                        className="hover:bg-accent/20 transition-colors cursor-pointer"
                                        onClick={() => setSelectedOrder(order)}
                                    >
                                        <td className="px-4 py-3">
                                            <div className="flex flex-col items-start gap-1">
                                                <span className="font-mono text-xs font-medium text-foreground">
                                                    {order.order_ref}
                                                </span>
                                                {renderChannelBadge(order)}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="min-w-0">
                                                <p className="font-medium text-foreground truncate max-w-[180px]">
                                                    {order.customer_name}
                                                </p>
                                                <p className="text-[11px] text-muted-foreground truncate max-w-[180px]">
                                                    {order.customer_email}
                                                </p>
                                            </div>
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="flex flex-col items-start gap-1">
                                                {renderStatusBadge(order.status)}
                                                {openRequestsByOrder[order.id] ? <OrderRequestBadge status={openRequestsByOrder[order.id]} /> : null}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 text-right">
                                            <span className="font-semibold text-foreground">
                                                {formatCurrency(order.total_amount, order.currency)}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className="text-xs text-muted-foreground">
                                                {formatShortDate(order.created_at)}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-center">
                                            <span className="text-xs text-muted-foreground">
                                                {order.storefront_order_items?.length || 0}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-center">
                                            <button
                                                onClick={(e) => { e.stopPropagation(); setSelectedOrder(order) }}
                                                className="p-1.5 rounded-md hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
                                                title="View details"
                                            >
                                                <Eye className="h-3.5 w-3.5" />
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {/* Mobile cards */}
                    <div className="md:hidden space-y-3">
                        {orders.map((order) => (
                            <button
                                key={order.id}
                                onClick={() => setSelectedOrder(order)}
                                className="w-full bg-card border border-border rounded-xl p-4 text-left hover:border-violet-200 dark:hover:border-violet-800 transition-all"
                            >
                                <div className="flex items-start justify-between gap-2 mb-2">
                                    <div>
                                        <span className="flex items-center gap-1.5 font-mono text-xs font-medium text-foreground">
                                            {order.order_ref}
                                            {renderChannelBadge(order)}
                                        </span>
                                        <p className="text-sm font-medium text-foreground mt-1">
                                            {order.customer_name}
                                        </p>
                                    </div>
                                    <div className="flex flex-col items-end gap-1">
                                        {renderStatusBadge(order.status)}
                                        {openRequestsByOrder[order.id] ? <OrderRequestBadge status={openRequestsByOrder[order.id]} /> : null}
                                    </div>
                                </div>
                                <div className="flex items-center justify-between text-xs text-muted-foreground">
                                    <span>{formatShortDate(order.created_at)}</span>
                                    <span className="font-semibold text-foreground">
                                        {formatCurrency(order.total_amount, order.currency)}
                                    </span>
                                </div>
                            </button>
                        ))}
                    </div>

                    {/* Pagination */}
                    {totalPages > 1 && (
                        <div className="flex items-center justify-between pt-2">
                            <p className="text-xs text-muted-foreground">
                                Page {page} of {totalPages} • {totalOrders} orders total
                            </p>
                            <div className="flex items-center gap-1">
                                <button
                                    onClick={() => setPage(p => Math.max(1, p - 1))}
                                    disabled={page <= 1}
                                    className="p-1.5 rounded-md border border-border hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                >
                                    <ChevronLeft className="h-4 w-4" />
                                </button>
                                <button
                                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                                    disabled={page >= totalPages}
                                    className="p-1.5 rounded-md border border-border hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                >
                                    <ChevronRight className="h-4 w-4" />
                                </button>
                            </div>
                        </div>
                    )}
                </>
            )}

            </>)}

            {/* Order detail slide-over panel */}
            {selectedOrder && typeof document !== 'undefined' ? createPortal(renderOrderDetail(), document.body) : null}
        </div>
    )
}
