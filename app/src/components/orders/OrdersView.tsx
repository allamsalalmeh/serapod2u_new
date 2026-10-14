'use client'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/use-toast'
import { formatNumber } from '@/lib/utils/formatters'
import { usePermissions } from '@/hooks/usePermissions'
import { useSaCapability } from '@/hooks/useSaCapability'
import { canCreateH2MOrder } from '@/modules/supply-chain/h2m-access'
import { queryByIdChunks } from '@/lib/orders/chunked-id-query'
import { getOrderDisplayOrgName, orderMatchesSearch } from '@/lib/orders/order-search'
import { calculateOrderTotal, sortOrders } from '@/lib/orders/order-list-sort'
import {
  FileText,
  Plus,
  Search,
  Filter,
  Download,
  Eye,
  Edit,
  CheckCircle,
  Clock,
  XCircle,
  AlertCircle,
  Package,
  Building2,
  Calendar,
  Grid3x3,
  List,
  Trash2,
  ShoppingCart,
  Store,
  TrendingUp,
  Copy,
  User,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight
} from 'lucide-react'
import type { Order, OrderStatus, OrderType, OrderSummary } from '@/types/order'
import { MessagingWarehouseInboxPanel } from '@/components/orders/MessagingWarehouseInboxPanel'
import SupplyChainPageHeader from '@/modules/supply-chain/components/SupplyChainPageHeader'
import { formatDateKey, formatDateKeyShort, orderBusinessDate } from '@/lib/orders/order-date'
import {
  SeraModalOverlay,
  SeraModalPanel,
  SeraModalHeader,
  SeraModalBody,
  SeraModalFooter,
} from '@/components/ui/sera-modal'

interface UserProfile {
  id: string
  email: string
  role_code: string
  organization_id: string
  department_id?: string | null
  organizations: {
    id: string
    org_name: string
    org_type_code: string
    org_code: string
  }
  roles: {
    role_name: string
    role_level: number
  }
}

interface OrdersViewProps {
  userProfile: UserProfile
  onViewChange?: (view: string) => void
}

/**
 * How many orders one load pulls back.
 *
 * The Order Type / Seller / Status choices used to be applied to whatever this
 * limit happened to return, so a company with 161 orders across H2M, D2H and
 * S2D loaded only the 50 most recent and then showed the 11 of them that were
 * H2M — everything older than that window simply vanished from the list. The
 * Order Type and Status choices are now pushed into the query itself, so the
 * window is per type instead of across all of them, and the limit is high
 * enough that a normal company's full history for one type comes back in one
 * page. Seller stays client-side on purpose: the Seller dropdown is built from
 * the loaded rows, so filtering it server-side would leave the dropdown with
 * only the seller already chosen.
 */
const ORDER_FETCH_LIMIT = 1000

/**
 * The messaging warehouse flow (Telegram submit → prepare → ready → ship) is
 * not released yet, so the Orders page keeps it off unless an environment opts
 * in with NEXT_PUBLIC_MESSAGING_FULFILLMENT_ENABLED=true. Until now the panel
 * was rendered unconditionally and only self-hid on an empty queue, so it
 * appeared wherever the optional messaging migrations happened to be installed
 * and carried open rows — visible on developer databases, invisible in
 * production. The gate makes that difference explicit instead of incidental.
 * The panel, its API routes and the Serapp/Telegram wiring are untouched.
 */
const MESSAGING_FULFILLMENT_ENABLED =
  process.env.NEXT_PUBLIC_MESSAGING_FULFILLMENT_ENABLED === 'true'

type OrderActor = {
  id: string
  email: string
  full_name?: string | null
  roles?: {
    role_level: number
  } | null
}

function mergeOrderActor(existing: OrderActor | undefined, fallback: OrderActor | undefined) {
  if (!existing) return fallback
  if (!fallback) return existing

  return {
    ...fallback,
    ...existing,
    full_name: existing.full_name || fallback.full_name,
    email: existing.email || fallback.email,
    roles: existing.roles || fallback.roles,
  }
}

async function hydrateOrderActors<T extends { id: string; created_by?: string; approved_by?: string; created_by_user?: OrderActor; approved_by_user?: OrderActor }>(ordersData: T[]) {
  const orderIdsNeedingActors = ordersData
    .filter(order => (order.created_by && !order.created_by_user) || (order.approved_by && !order.approved_by_user))
    .map(order => order.id)

  if (orderIdsNeedingActors.length === 0) {
    return ordersData
  }

  try {
    const response = await fetch('/api/orders/actors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderIds: orderIdsNeedingActors })
    })

    if (!response.ok) {
      console.warn('Failed to hydrate order actors:', response.status)
      return ordersData
    }

    const payload = await response.json()
    const users = Array.isArray(payload?.users) ? payload.users as OrderActor[] : []
    if (users.length === 0) {
      return ordersData
    }

    const usersById = new Map(users.map(user => [user.id, user]))

    return ordersData.map(order => ({
      ...order,
      created_by_user: mergeOrderActor(order.created_by_user, order.created_by ? usersById.get(order.created_by) : undefined),
      approved_by_user: mergeOrderActor(order.approved_by_user, order.approved_by ? usersById.get(order.approved_by) : undefined),
    }))
  } catch (error) {
    console.warn('Failed to hydrate order actors:', error)
    return ordersData
  }
}

export default function OrdersView({ userProfile, onViewChange }: OrdersViewProps) {
  const [orders, setOrders] = useState<Order[]>([])
  // Who may approve: S&A once supply_chain.order.approve is enforced (role
  // grants such as Order Approver decide); until then Manager level or above.
  const approvePermitted = useSaCapability('supply_chain.order.approve', userProfile.roles.role_level <= 30)
  const [summary, setSummary] = useState<OrderSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<OrderStatus | 'all'>('all')
  const [typeFilter, setTypeFilter] = useState<OrderType | 'all'>('all')
  const [sellerFilter, setSellerFilter] = useState('')
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [viewMode, setViewMode] = useState<'cards' | 'list'>('list')
  const [showOrderTypeDialog, setShowOrderTypeDialog] = useState(false)

  // The list is a wide table; phones open on the card view instead.
  useEffect(() => {
    if (window.matchMedia?.('(max-width: 767px)')?.matches) setViewMode('cards')
  }, [])

  // Sorting state
  // Date column = business/SO date (order_date), newest first.
  const [sortColumn, setSortColumn] = useState<string>('order_date')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc')

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(10)

  const supabase = createClient()
  const { toast } = useToast()

  // Permission check for creating orders
  const { hasPermission, loading: permissionsLoading } = usePermissions(
    userProfile.roles.role_level,
    userProfile.role_code,
    userProfile.department_id
  )
  const canCreateOrders = hasPermission('create_orders')
  const canCreateH2M = canCreateH2MOrder(userProfile.organizations.org_type_code, userProfile.roles.role_level)

  // Debug: Log permission state
  console.log('[OrdersView] Permission check:', {
    roleLevel: userProfile.roles.role_level,
    permissionsLoading,
    canCreateOrders,
    hasCreateOrderPermission: hasPermission('create_orders')
  })

  // Extract unique sellers from orders
  const uniqueSellers = orders.reduce((acc, order) => {
    const seller = order.seller_org
    if (seller && !acc.find(s => s.id === seller.id)) {
      acc.push(seller)
    }
    return acc
  }, [] as Array<{ id: string; org_name: string }>)

  // The Name column and the free-text search share one implementation so the
  // search always matches what the table renders.
  const getDisplayOrgName = (order: Order): string =>
    getOrderDisplayOrgName(order, userProfile.organization_id)

  // Filter orders based on all criteria
  const filteredOrders = orders.filter(order => {
    // Search filter - matches the identity shown in the table: document
    // numbers, the Name column, both organizations (name and code) and notes.
    const matchesSearch = orderMatchesSearch(order, searchQuery, userProfile.organization_id)

    // Status filter
    const matchesStatus = statusFilter === 'all' || order.status === statusFilter

    // Type filter
    const matchesType = typeFilter === 'all' || order.order_type === typeFilter

    // Seller filter
    const matchesSeller = !sellerFilter || order.seller_org_id === sellerFilter

    return matchesSearch && matchesStatus && matchesType && matchesSeller
  })

  // Sort orders. The comparator lives in @/lib/orders/order-list-sort so the
  // helpers it needs are hoisted module functions rather than component consts
  // declared further down this file — sorting by Total or Balance used to reach
  // `calculateOrderTotal` before its declaration and throw.
  const sortedOrders = sortOrders(filteredOrders, sortColumn, sortDirection, userProfile.organization_id)

  // Pagination
  const totalPages = Math.ceil(sortedOrders.length / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const endIndex = startIndex + itemsPerPage
  const paginatedOrders = sortedOrders.slice(startIndex, endIndex)

  // Handle sort
  const handleSort = (column: string) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
    } else {
      setSortColumn(column)
      setSortDirection('asc')
    }
  }

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, statusFilter, typeFilter, sellerFilter])

  const handleTrackOrder = (orderId: string) => {
    // Store order ID and navigate to track view
    if (onViewChange) {
      // You can use sessionStorage to pass the order ID
      sessionStorage.setItem('trackingOrderId', orderId)
      onViewChange('track-order')
    }
  }

  const handleDeleteOrder = async (orderId: string, orderNo: string) => {
    try {
      setLoading(true)

      // Step 1: Fetch comprehensive order details and all related records
      console.log('🔍 Fetching order details for:', orderNo)

      // Get order items count
      const { data: orderItems, error: itemsError } = await supabase
        .from('order_items')
        .select('id')
        .eq('order_id', orderId)

      // Get documents count
      const { data: documents, error: docsError } = await supabase
        .from('documents')
        .select('id, doc_type, doc_no')
        .eq('order_id', orderId)

      // Get QR batches count
      const { data: qrBatches, error: batchError } = await supabase
        .from('qr_batches')
        .select('id, status')
        .eq('order_id', orderId)

      // Get QR codes count (both master and regular)
      const { data: qrCodes, error: codesError } = await supabase
        .from('qr_codes')
        .select('id')
        .eq('order_id', orderId)

      const { data: masterCodes, error: masterError } = await supabase
        .from('qr_master_codes')
        .select('id')
        .eq('order_id', orderId)

      // Get Excel files from storage
      const { data: excelFiles, error: storageError } = await supabase
        .storage
        .from('order-excel')
        .list(`${orderId}/`)

      const itemsCount = orderItems?.length || 0
      const docsCount = documents?.length || 0
      const batchesCount = qrBatches?.length || 0
      const codesCount = (qrCodes?.length || 0) + (masterCodes?.length || 0)
      const excelCount = excelFiles?.length || 0

      // Step 2: Get count of scanned QR codes (if any)
      const { data: scannedQR } = await supabase
        .from('qr_codes')
        .select('id')
        .eq('order_id', orderId)
        .neq('status', 'pending')

      // Step 2b: Get count of stock movements (inventory history)
      const { count: stockMovementsCount } = await supabase
        .from('stock_movements')
        .select('id', { count: 'exact', head: true })
        .eq('reference_type', 'order')
        .eq('reference_id', orderId)

      const scannedCount = scannedQR?.length || 0
      const docsList = documents?.map(d => `${d.doc_type}: ${d.doc_no}`).join('\n  ') || 'None'

      // Step 3: Show confirmation dialog
      const confirmMessage =
        `⚠️ DELETE ORDER ${orderNo}\n\n` +
        (scannedCount > 0
          ? `⚠️ WARNING: This order has ${scannedCount} SCANNED QR code(s)!\n⚠️ Deleting scanned QR codes affects audit trails!\n\n`
          : '') +
        `This will PERMANENTLY delete:\n` +
        `• ${itemsCount} order item(s)\n` +
        `• ${docsCount} document(s):\n  ${docsList}\n` +
        `• ${batchesCount} QR batch(es)\n` +
        `• ${codesCount} QR code(s)${scannedCount > 0 ? ` (${scannedCount} scanned)` : ''}\n` +
        `• ${stockMovementsCount || 0} inventory movement record(s)\n` +
        `• ${excelCount} Excel file(s)\n\n` +
        `⚠️ This action CANNOT be undone!\n\n` +
        `Are you sure you want to delete this order?`

      // Show confirmation dialog
      const confirmed = window.confirm(confirmMessage)

      if (!confirmed) {
        toast({
          title: 'Delete Cancelled',
          description: 'Order deletion was cancelled.'
        })
        setLoading(false)
        return
      }

      console.log('✅ User confirmed deletion')

      // Call server-side API to delete order
      console.log('🗑️ Calling server API to delete order...')
      const response = await fetch('/api/orders/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          orderId,
          forceDelete: true
        })
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to delete order')
      }

      const result = await response.json()

      toast({
        title: '✅ Order Deleted Successfully',
        description: scannedCount > 0
          ? `Order ${orderNo} and ALL related records (including ${scannedCount} scanned QR codes) have been permanently deleted.`
          : `Order ${orderNo} and all related records have been permanently deleted.`,
      })

      // Reload orders
      await loadOrders()
      await loadSummary()
    } catch (error: any) {
      console.error('Error deleting order:', error)
      toast({
        title: '❌ Delete Failed',
        description: error.message || 'Failed to delete order. Please try again or contact support.',
        variant: 'destructive'
      })
    } finally {
      setLoading(false)
    }
  }

  const handleApproveOrder = async (orderId: string, orderNo: string, displayDocNo?: string | null) => {
    // Use new display_doc_no format if available, fallback to legacy
    const displayOrderNo = displayDocNo || orderNo

    try {
      // 1. Check if current user has uploaded their digital signature
      const { data: currentUserData, error: userError } = await supabase
        .from('users')
        .select('signature_url, full_name')
        .eq('id', userProfile.id)
        .single()

      if (userError) throw userError

      if (!currentUserData.signature_url) {
        toast({
          title: 'Signature Required',
          description: 'You must upload your digital signature in My Profile before you can approve orders.',
          variant: 'destructive'
        })
        return
      }

      // 2. Check if user is trying to approve their own order
      const { data: orderData, error: orderError } = await supabase
        .from('orders')
        .select('created_by')
        .eq('id', orderId)
        .single()

      if (orderError) throw orderError

      if (orderData.created_by === userProfile.id) {
        toast({
          title: 'Action Not Allowed',
          description: 'For security reasons, you cannot approve an order you created. Please ask another admin to approve it.',
          variant: 'destructive'
        })
        return
      }

      // 3. Show confirmation dialog
      if (!confirm(`Approve order ${displayOrderNo}?\n\nThis will:\n• Change status to "Approved"\n• Reserve Inventory (Allocate)\n• Generate Purchase Order document\n\nThis action cannot be undone.`)) {
        return
      }

      setLoading(true)

      // Call the orders_approve database function
      const { data, error } = await supabase
        .rpc('orders_approve', { p_order_id: orderId })

      console.log('Approve result:', { data, error })

      if (error) {
        console.error('RPC error details:', JSON.stringify(error, null, 2))
        throw error
      }

      // Inventory deduction is now handled by the orders_approve RPC for both D2H and S2D

      // Fetch the updated order to get the newly generated display_doc_no
      const { data: updatedOrder } = await supabase
        .from('orders')
        .select('display_doc_no')
        .eq('id', orderId)
        .single()

      // Use the newly generated display_doc_no for the toast
      const newDisplayNo = updatedOrder?.display_doc_no || displayOrderNo

      toast({
        title: 'Order Approved',
        description: `Order ${newDisplayNo} has been approved successfully. PO document has been generated.`,
      })

      // Notification queueing is handled by the trigger_order_notification()
      // DB trigger, which fires automatically on the status UPDATE inside
      // orders_approve(). The explicit /api/notifications/order-event call
      // that used to be here was queueing a second, duplicate notification.

      // SerApp chat: tell the distributor Admin approved + next step (best-effort).
      fetch('/api/serapp/notify-order-approved', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId }),
      }).catch((serappError) => {
        console.warn('Failed to notify SerApp chat of approval:', serappError)
      })

      // Fire-and-forget: trigger notification outbox worker
      fetch('/api/cron/notification-outbox-worker').catch(() => { })

      // Reload orders
      await loadOrders()
      await loadSummary()
    } catch (error: any) {
      console.error('Error approving order:', error)
      console.error('Error details:', JSON.stringify(error, null, 2))

      let title = 'Approval Failed'
      let description = 'An unexpected error occurred. Please try again.'

      if (error) {
        // Handle Supabase errors
        if (error.message) {
          description = error.message

          // Map technical errors to friendly messages
          if (description.includes('Order must be in submitted')) {
            description = 'Only submitted orders can be approved.'
          } else if (description.includes('User lacks permission')) {
            description = 'You do not have permission to approve this order.'
          } else if (description.includes('Parent order must be approved')) {
            description = 'The parent order must be approved first.'
          } else if (description.includes('Order not found')) {
            description = 'Order not found.'
          } else if (description.includes('stock configuration is not confirmed')) {
            // D2H/S2D lines are allocated on submit but left unconfirmed on
            // purpose: an HQ or warehouse user picks the exact configuration
            // first. The raw message only carries an order item UUID, which
            // says nothing about what to do next.
            title = 'Stock Configuration Not Confirmed'
            description = `Open ${displayOrderNo}, confirm the exact stock configuration for every line, then approve.`
          } else if (description.includes('Insufficient confirmed configuration stock')) {
            description = 'The confirmed configuration no longer holds enough stock. Re-confirm the configuration on the order lines, then approve.'
          }
        } else if (typeof error === 'object' && Object.keys(error).length === 0) {
          // Empty error object usually means network or unknown error
          description = 'Unable to connect to the server. Please check your internet connection.'
        }
      }

      toast({
        title,
        description,
        variant: 'destructive'
      })
    } finally {
      setLoading(false)
    }
  }

  const handleCancelOrder = async (orderId: string, orderNo: string) => {
    try {
      if (!confirm(`Cancel order ${orderNo}?\n\nThis will:\n• Change status to "Cancelled"\n• Release allocated inventory\n\nThis action cannot be undone.`)) {
        return
      }

      setLoading(true)

      // Update order status to cancelled
      // The trigger 'on_order_status_change' will handle inventory deallocation
      const { error } = await supabase
        .from('orders')
        .update({ status: 'cancelled' })
        .eq('id', orderId)

      if (error) throw error

      // Notification queueing is handled by the trigger_order_notification()
      // DB trigger, which fires automatically on this status UPDATE. The
      // explicit /api/notifications/order-event call that used to be here
      // was queueing a second, duplicate notification.

      toast({
        title: 'Order Cancelled',
        description: `Order ${orderNo} has been cancelled and inventory released.`,
      })

      // Fire-and-forget: trigger notification outbox worker
      fetch('/api/cron/notification-outbox-worker').catch(() => { })

      // Reload orders
      await loadOrders()
      await loadSummary()
    } catch (error: any) {
      // Supabase/PostgREST errors serialize to `{}` under console.error, which
      // hid the real backend reason. Surface the safe diagnostic fields instead.
      const code = error?.code
      const details = error?.details
      const hint = error?.hint
      const status = error?.status ?? error?.statusCode
      console.error('Error cancelling order:', {
        message: error?.message,
        code,
        details,
        hint,
        status,
      })

      let description = error?.message || details || 'Failed to cancel order'

      // Map known backend failures to actionable guidance.
      if (typeof description === 'string') {
        if (description.includes('has no stock configuration')) {
          description = 'This order has a legacy allocation that could not be matched. Please retry, or contact support if it persists.'
        } else if (description.includes('Ambiguous allocation')) {
          description = 'This order has an ambiguous stock allocation and cannot be cancelled automatically. Please contact support.'
        } else if (description.includes('Cannot safely release')) {
          description = 'The allocated stock for this order could not be released safely. Please contact support.'
        } else if (description.includes('Buyer no longer has exact configuration stock')) {
          description = 'The receiving location no longer holds the exact stock required to cancel this order.'
        }
      } else if (!error || (typeof error === 'object' && Object.keys(error).length === 0)) {
        description = 'Unable to reach the server. Please check your connection and try again.'
      }

      toast({
        title: 'Cancellation Failed',
        description,
        variant: 'destructive'
      })
    } finally {
      setLoading(false)
    }
  }

  // Helper function to check if user can approve orders
  const canApproveOrder = (order: Order): boolean => {
    // Must be submitted status
    if (order.status !== 'submitted') return false

    // The creator never approves their own order (also enforced in
    // orders_approve); otherwise the approve permission decides.
    if (order.created_by_user?.id === userProfile.id) return false
    if (!approvePermitted) return false

    const userOrgType = userProfile.organizations.org_type_code

    // H2M: HQ Power Users can approve
    if (order.order_type === 'H2M' && userOrgType === 'HQ') return true

    // D2H: HQ Power Users or Seller (Warehouse) can approve
    // Also allow if user is HQ and order is D2H (Distributor -> HQ)
    if (order.order_type === 'D2H') {
      if (userOrgType === 'HQ') return true;
      // If user is the seller (e.g. Warehouse admin if that exists, though usually HQ manages WH)
      if (order.seller_org_id === userProfile.organization_id) return true;
    }

    // S2D: Distributor (seller) Power Users can approve
    if (order.order_type === 'S2D' && order.seller_org_id === userProfile.organization_id) return true

    return false
  }

  // Helper function to check if user can cancel orders
  const canCancelOrder = (order: Order & { approved_by_user?: any }): boolean => {
    // Can cancel Submitted, Approved or Processing orders
    // Submitted: No stock allocated yet, but can be cancelled
    // Approved/Processing: Stock allocated, will be released
    if (!['submitted', 'approved', 'processing'].includes(order.status)) return false

    const userOrgId = userProfile.organization_id
    const userOrgType = userProfile.organizations.org_type_code

    // Check if user is part of the transaction (HQ, Seller, Buyer)
    const isParticipant = userOrgType === 'HQ' || order.seller_org_id === userOrgId || order.buyer_org_id === userOrgId
    if (!isParticipant) return false

    // Issue 2: Cancel order only can be done level upper
    // If the order is approved, check the approver's level
    if (['approved', 'processing'].includes(order.status) && order.approved_by_user?.roles) {
      const approverLevel = order.approved_by_user.roles.role_level
      const myLevel = userProfile.roles.role_level

      // Current user must have a higher role (lower number) than the approver
      // e.g. If approved by 30, only 20, 10, 1 can cancel
      if (myLevel >= approverLevel) {
        return false
      }
    }

    return true
  }

  // Helper function to check if user can delete orders (Super Admin only)
  const canDeleteOrder = (): boolean => {
    // Explicitly disallow level 30 and 40
    if (userProfile.roles.role_level === 30 || userProfile.roles.role_level === 40) {
      return false
    }
    // Only Super Admin (role_level = 1) can delete orders
    return userProfile.roles.role_level === 1
  }

  // Helper function to check if user can edit orders
  const canEditOrder = (order: Order): boolean => {
    // Can only edit draft or submitted orders
    if (order.status !== 'draft' && order.status !== 'submitted') return false

    // User must be from the buyer organization
    return order.buyer_org_id === userProfile.organization_id
  }

  const canCopyOrder = (order: Order): boolean => {
    // Can copy orders from any status (excluding closed)
    if (order.status === 'closed') return false

    // User must be from the buyer organization
    return order.buyer_org_id === userProfile.organization_id
  }

  const handleEditOrder = (orderId: string) => {
    // Store order ID and navigate to edit view
    if (onViewChange) {
      sessionStorage.setItem('editingOrderId', orderId)
      onViewChange('create-order')
    }
  }

  const handleCopyOrder = async (orderId: string, orderNo: string) => {
    try {
      setLoading(true)

      // Fetch the order with all its items (including units_per_case)
      const { data: orderData, error: orderError } = await supabase
        .from('orders')
        .select(`
          *,
          order_items (
            *,
            product:products (*),
            product_variants (*)
          )
        `)
        .eq('id', orderId)
        .single()

      if (orderError) throw orderError
      if (!orderData) throw new Error('Order not found')

      // Create a copy object with the order data
      const orderCopy = {
        ...orderData,
        order_items: orderData.order_items || []
      }

      // Store in sessionStorage for the create order view to pick up
      sessionStorage.setItem('copyingOrderData', JSON.stringify(orderCopy))

      toast({
        title: 'Order Copied',
        description: `${orderNo} copied. You can now edit and submit as a new order.`,
      })

      // Navigate to create order view
      if (onViewChange) {
        onViewChange('create-order')
      }
    } catch (error: any) {
      console.error('Error copying order:', error)
      toast({
        title: 'Copy Failed',
        description: error.message || 'Failed to copy order',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadOrders()
    loadSummary()
    // eslint-disable-next-line react-hooks/exhaustive-deps

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, typeFilter])

  const handleCreateOrder = async () => {
    // Check if user has digital signature
    try {
      const { data: userData, error: userError } = await supabase
        .from('users')
        .select('signature_url')
        .eq('id', userProfile.id)
        .single()

      if (userError) throw userError

      if (!userData?.signature_url) {
        toast({
          title: 'Digital Signature Required',
          description: 'You must upload your digital signature before creating an order.',
          variant: 'destructive',
          action: (
            <Button
              variant="outline"
              size="sm"
              className="bg-white text-black hover:bg-[var(--sera-ink)]/[0.04]"
              onClick={() => {
                if (onViewChange) onViewChange('my-profile')
              }}
            >
              Go to Profile
            </Button>
          )
        })
        return
      }
    } catch (error) {
      console.error('Error checking signature:', error)
      // Continue anyway if check fails to avoid blocking user due to technical error
    }

    // If H2M filter is selected, go directly to H2M order creation
    if (typeFilter === 'H2M') {
      if (!canCreateH2M) {
        toast({ title: 'Unauthorized', description: 'H2M orders can only be created by Headquarters users with access level 40 or higher.', variant: 'destructive' })
        return
      }
      if (onViewChange) {
        onViewChange('create-order')
      }
      return
    }

    // If D2H filter is selected, go directly to D2H order creation
    if (typeFilter === 'D2H') {
      if (onViewChange) {
        onViewChange('distributor-order')
      }
      return
    }

    // If S2D filter is selected, go directly to S2D order creation
    if (typeFilter === 'S2D') {
      if (onViewChange) {
        onViewChange('shop-order')
      }
      return
    }

    // For distributors, warehouses, and HQ, show order type selection dialog
    if (userProfile.organizations.org_type_code === 'DIST' ||
      userProfile.organizations.org_type_code === 'WH' ||
      userProfile.organizations.org_type_code === 'HQ') {
      orderTypeNavigatingRef.current = false
      setShowOrderTypeDialog(true)
      return
    }

    // Navigate to create order view (regular flow)
    if (onViewChange) {
      onViewChange('create-order')
    }
  }

  // A rapid double-click on an order-type card must navigate exactly once. This
  // ref latches the first selection so the second click is ignored; it is reset
  // whenever the dialog is opened again.
  const orderTypeNavigatingRef = useRef(false)

  const handleOrderTypeSelection = (orderType: 'regular' | 'd2h' | 's2d') => {
    if (orderTypeNavigatingRef.current) return
    orderTypeNavigatingRef.current = true
    setShowOrderTypeDialog(false)

    if (orderType === 'd2h') {
      if (onViewChange) {
        onViewChange('distributor-order')
      }
    } else if (orderType === 's2d') {
      if (onViewChange) {
        onViewChange('shop-order')
      }
    } else {
      if (onViewChange) {
        onViewChange('create-order')
      }
    }
  }

  const handleViewOrderDetails = (orderId: string) => {
    // Navigate to view order details (read-only)
    if (onViewChange) {
      sessionStorage.setItem('viewOrderId', orderId)
      window.history.pushState({}, '', `/supply-chain?view=view-order&orderId=${encodeURIComponent(orderId)}`)
      onViewChange('view-order')
    }
  }

  const loadOrders = async () => {
    try {
      setLoading(true)

      // Get company_id from current org
      const { data: companyData } = await supabase
        .rpc('get_company_id', { p_org_id: userProfile.organization_id })

      const companyId = companyData || userProfile.organization_id
      const orgType = userProfile.organizations.org_type_code

      // First, get orders
      let query = supabase
        .from('orders')
        .select(`
          *,
          buyer_org:organizations!orders_buyer_org_id_fkey(id, org_name, org_code, org_type_code),
          seller_org:organizations!orders_seller_org_id_fkey(id, org_name, org_code, org_type_code),
          created_by_user:users!orders_created_by_fkey(id, email, full_name, roles:role_code(role_level)),
          approved_by_user:users!orders_approved_by_fkey(id, email, full_name, roles:role_code(role_level))
        `)

      // Order Type has to be part of the query, not a post-filter over the
      // fetched window — see ORDER_FETCH_LIMIT.
      if (typeFilter !== 'all') {
        query = query.eq('order_type', typeFilter)
      }

      // Filter based on organization type
      if (orgType === 'MFG' || orgType === 'MANU') {
        // Manufacturers see orders where they are the seller
        query = query.eq('seller_org_id', userProfile.organization_id)

        // Issue 2: Manufacturers should only see 'approved' orders (or later stages), not 'submitted'
        // They need to see approved orders to start processing them
        // Assuming 'submitted' is the initial state before approval
        query = query.neq('status', 'submitted')
        query = query.neq('status', 'draft')
      } else {
        // HQ and others see all orders in their company
        query = query.eq('company_id', companyId)
      }

      query = query.order('created_at', { ascending: false }).limit(ORDER_FETCH_LIMIT)

      // Apply status filter
      if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter)
      }

      // Search is deliberately NOT pushed into the query. It used to be an
      // `.or(order_no, display_doc_no, notes)` filter, which threw away every
      // row that only matched on the organization name shown in the table
      // (searching "skd" returned 3 rows instead of every SKD Distribution
      // order). ORDER_FETCH_LIMIT already brings back the full window, so the
      // search runs client-side over the same fields the user can see.

      const { data: ordersData, error: ordersError } = await query

      if (ordersError) throw ordersError

      const hydratedOrdersData = await hydrateOrderActors(ordersData || [])

      console.log('=== ORDER LOADING DEBUG ===')
      console.log('Orders loaded:', hydratedOrdersData.length, 'orders')
      console.log('Company ID used:', companyId)
      console.log('User org ID:', userProfile.organization_id)

      // Now get order_items for these orders separately
      if (hydratedOrdersData.length > 0) {
        const orderIds = hydratedOrdersData.map(o => o.id)

        // Each of these is keyed by the loaded order ids, so they run in
        // batches — a full order history would otherwise put thousands of
        // UUIDs in one request URL. See queryByIdChunks.

        // 1. Fetch Order Items
        const { data: itemsData, error: itemsError } = await queryByIdChunks<any>(orderIds, chunk => supabase
          .from('order_items')
          .select(`
            *,
            product:products(id, product_name, product_code),
            variant:product_variants(id, variant_name)
          `)
          .in('order_id', chunk))

        // 2. Fetch PO Documents to check acknowledgement status (for Unpaid status logic)
        const { data: poData } = await queryByIdChunks<any>(orderIds, chunk => supabase
          .from('documents')
          .select('order_id, status')
          .in('order_id', chunk)
          .eq('doc_type', 'PO'))

        // 3. Fetch acknowledged PAYMENT documents to calculate paid amounts
        const { data: paymentData } = await queryByIdChunks<any>(orderIds, chunk => supabase
          .from('documents')
          .select('order_id, status, payment_percentage, payload')
          .in('order_id', chunk)
          .eq('doc_type', 'PAYMENT')
          .eq('status', 'acknowledged'))

        // 4. Fetch RECEIPT documents for D2H orders (customer receipts)
        const { data: receiptData } = await queryByIdChunks<any>(orderIds, chunk => supabase
          .from('documents')
          .select('order_id, status, payment_percentage, payload')
          .in('order_id', chunk)
          .eq('doc_type', 'RECEIPT'))

        console.log('Order items query result:', itemsData?.length || 0, 'items')
        console.log('Acknowledged payments found:', paymentData?.length || 0)
        console.log('Receipts found:', receiptData?.length || 0)

        if (itemsError) {
          console.error('Error loading order items:', itemsError)
        } else if (itemsData) {
          // Map items to orders
          const ordersWithItems = hydratedOrdersData.map(order => {
            const items = itemsData.filter(item => item.order_id === order.id)
            const poDoc = poData?.find(d => d.order_id === order.id)

            // Calculate paid amount from acknowledged payment documents
            const orderPayments = paymentData?.filter(p => p.order_id === order.id) || []
            const orderReceipts = receiptData?.filter(r => r.order_id === order.id) || []
            const orderTotal = items.reduce((sum, item) => sum + (item.line_total || 0), 0)

            // Sum up paid amounts from payment percentages (for H2M orders)
            let paidAmount = 0
            orderPayments.forEach(payment => {
              // Get payment percentage from document or payload
              const paymentPct = payment.payment_percentage ||
                (payment.payload as any)?.payment_percentage ||
                (payment.payload as any)?.requested_percent ||
                30 // default deposit percentage
              paidAmount += (orderTotal * paymentPct / 100)
            })

            // Add receipt amounts (for D2H orders - customer receipts have amount in payload)
            orderReceipts.forEach(receipt => {
              const receiptAmount = (receipt.payload as any)?.amount || 0
              if (receiptAmount > 0) {
                paidAmount += receiptAmount
              } else if (receipt.payment_percentage) {
                // Fallback to percentage calculation
                paidAmount += (orderTotal * receipt.payment_percentage / 100)
              }
            })

            return {
              ...order,
              order_items: items,
              paid_amount: paidAmount,
              po_acknowledged: poDoc?.status === 'acknowledged' || poDoc?.status === 'completed'
            }
          })

          console.log('First order with items:', ordersWithItems[0]?.order_no)
          console.log('First order items count:', ordersWithItems[0]?.order_items?.length || 0)

          if (ordersWithItems[0]?.order_items && ordersWithItems[0].order_items.length > 0) {
            console.log('First item details:', ordersWithItems[0].order_items[0])
          } else {
            console.log('⚠️ WARNING: No order items found')
            console.log('Items data received:', itemsData)
          }

          console.log('========================')
          setOrders(ordersWithItems as any)
          return
        }
      }

      console.log('========================')
      setOrders(hydratedOrdersData as any)
    } catch (error) {
      console.error('Error loading orders:', error)
    } finally {
      setLoading(false)
    }
  }

  const loadSummary = async () => {
    try {
      // Get company_id from current org
      const { data: companyData } = await supabase
        .rpc('get_company_id', { p_org_id: userProfile.organization_id })

      const companyId = companyData || userProfile.organization_id

      const { data, error } = await supabase
        .from('orders')
        .select('status, order_items(line_total)')
        .eq('company_id', companyId)

      if (error) throw error

      const summary: OrderSummary = {
        total_orders: data?.length || 0,
        draft_orders: data?.filter(o => o.status === 'draft').length || 0,
        submitted_orders: data?.filter(o => o.status === 'submitted').length || 0,
        approved_orders: data?.filter(o => o.status === 'approved').length || 0,
        closed_orders: data?.filter(o => o.status === 'closed').length || 0,
        // Only count total amount for approved and closed orders (exclude draft and submitted)
        total_amount: data?.reduce((sum: number, order: any) => {
          // Skip draft and submitted orders - only count approved and closed
          if (order.status === 'draft' || order.status === 'submitted') {
            return sum
          }
          const orderTotal = order.order_items?.reduce((itemSum: number, item: any) =>
            itemSum + (item.line_total || 0), 0) || 0
          return sum + orderTotal
        }, 0) || 0
      }

      setSummary(summary)
    } catch (error) {
      console.error('Error loading summary:', error)
    }
  }

  const getStatusColor = (status: OrderStatus) => {
    const colors = {
      draft: 'sera-sc-badge sera-sc-badge--ink',
      submitted: 'sera-sc-badge sera-sc-badge--info',
      approved: 'sera-sc-badge sera-sc-badge--success',
      closed: 'sera-sc-badge sera-sc-badge--ink',
    }
    return colors[status] || 'sera-sc-badge sera-sc-badge--ink'
  }

  const getStatusIcon = (status: OrderStatus) => {
    const icons = {
      draft: <Edit className="w-4 h-4" />,
      submitted: <Clock className="w-4 h-4" />,
      approved: <CheckCircle className="w-4 h-4" />,
      closed: <XCircle className="w-4 h-4" />,
    }
    return icons[status] || <AlertCircle className="w-4 h-4" />
  }

  const getOrderTypeLabel = (type: OrderType) => {
    const labels = {
      H2M: 'HQ → Manufacturer',
      D2H: 'Distributor → HQ',
      S2D: 'Shop → Distributor',
    }
    return labels[type] || type
  }

  const formatCurrency = (amount: number): string => {
    return new Intl.NumberFormat('en-MY', {
      style: 'currency',
      currency: 'MYR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount).replace('MYR', 'RM')
  }

  // Helper function to shorten organization name
  const shortenOrgName = (orgName: string): string => {
    if (!orgName) return 'N/A'
    // Remove common suffixes to shorten the name
    return orgName
      .replace(/\s+(Technologies|Technology|Tech)\s+(Co\.|Company)\s+(Limited|Ltd|Sdn Bhd)/gi, '')
      .replace(/\s+(Co\.|Company)\s+(Limited|Ltd|Sdn Bhd)/gi, '')
      .replace(/\s+(Limited|Ltd|Sdn Bhd)/gi, '')
      .replace(/\s+(Corporation|Corp)/gi, '')
      .trim()
  }


  if (loading && orders.length === 0) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-[var(--sera-orange)]/25 border-t-[var(--sera-orange)] rounded-full animate-spin mx-auto mb-4" />
          <p className="text-sm text-[var(--sera-muted)]">Loading orders...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="sera-sc-page sera-page-enter text-sm">
      {/* Header */}
      <SupplyChainPageHeader
        title="Orders"
        description="Manage and track all your orders"
        actions={
          !['MANU', 'MFG'].includes(userProfile.organizations.org_type_code) && canCreateOrders ? (
            <Button
              className="gap-2 bg-[var(--sera-ink)] text-white hover:bg-[var(--sera-ink-soft)]"
              onClick={handleCreateOrder}
            >
              <Plus className="w-4 h-4" />
              Create Order
            </Button>
          ) : undefined
        }
      />

      {MESSAGING_FULFILLMENT_ENABLED && <MessagingWarehouseInboxPanel />}

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <div className="sera-sc-kpi">
            <p className="sera-sc-kpi__label">Total Orders</p>
            <p className="sera-sc-kpi__value">{summary.total_orders}</p>
          </div>

          <div className="sera-sc-kpi">
            <p className="sera-sc-kpi__label">Submitted</p>
            <p className="sera-sc-kpi__value">{summary.submitted_orders}</p>
          </div>

          <div className="sera-sc-kpi">
            <p className="sera-sc-kpi__label">Approved</p>
            <p className="sera-sc-kpi__value">{summary.approved_orders}</p>
          </div>

          <div className="sera-sc-kpi">
            <p className="sera-sc-kpi__label">Total Amount</p>
            <p className="sera-sc-kpi__value truncate text-[1.35rem] sm:text-[1.75rem]">
              RM {summary.total_amount.toLocaleString('en-MY', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
              })}
            </p>
          </div>
        </div>
      )}

      {/* Filters and View Toggle */}
      <Card className="sera-sc-panel shadow-none">
        <CardContent className="p-4 sm:pt-6 space-y-4">
          {/* Filter Row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Order Type Filter - Hidden for Manufacturers */}
            {!['MANU', 'MFG'].includes(userProfile.organizations.org_type_code) && (
              <div>
                <label className="block text-xs font-medium text-[var(--sera-ink-soft)] mb-2">Order Type</label>
                <select
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value as OrderType | 'all')}
                  className="sera-sc-select"
                >
                  <option value="all">All Types</option>
                  {canCreateH2M ? <option value="H2M">H2M (HQ → Manufacturer)</option> : null}
                  <option value="D2H">D2H (Distributor → HQ)</option>
                  <option value="S2D">S2D (Shop → Distributor)</option>
                </select>
              </div>
            )}

            {/* Manufacturer/Seller Filter - Hidden for Manufacturers */}
            {!['MANU', 'MFG'].includes(userProfile.organizations.org_type_code) && (
              <div>
                <label className="block text-xs font-medium text-[var(--sera-ink-soft)] mb-2">Seller/Manufacturer</label>
                <select
                  value={sellerFilter}
                  onChange={(e) => setSellerFilter(e.target.value)}
                  className="sera-sc-select"
                >
                  <option value="">All Sellers</option>
                  {uniqueSellers.map(seller => (
                    <option key={seller.id} value={seller.id}>
                      {seller.org_name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Status Filter - Hidden for Manufacturers */}
            {!['MANU', 'MFG'].includes(userProfile.organizations.org_type_code) && (
              <div>
                <label className="block text-xs font-medium text-[var(--sera-ink-soft)] mb-2">Status</label>
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as OrderStatus | 'all')}
                  className="sera-sc-select"
                >
                  <option value="all">All Status</option>
                  <option value="draft">Draft</option>
                  <option value="submitted">Submitted</option>
                  <option value="approved">Approved</option>
                  <option value="closed">Closed</option>
                </select>
              </div>
            )}

            {/* View Mode Toggle */}
            <div>
              <label className="block text-xs font-medium text-[var(--sera-ink-soft)] mb-2">View Mode</label>
              <div className="sera-sc-toggle">
                <Button
                  variant={viewMode === 'cards' ? 'default' : 'ghost'}
                  size="sm"
                  className={`sera-sc-toggle__btn ${viewMode === 'cards' ? 'is-active' : ''}`}
                  onClick={() => setViewMode('cards')}
                >
                  <Grid3x3 className="w-4 h-4 mr-2" />
                  Cards
                </Button>
                <Button
                  variant={viewMode === 'list' ? 'default' : 'ghost'}
                  size="sm"
                  className={`sera-sc-toggle__btn ${viewMode === 'list' ? 'is-active' : ''}`}
                  onClick={() => setViewMode('list')}
                >
                  <List className="w-4 h-4 mr-2" />
                  List
                </Button>
              </div>
            </div>
          </div>

          {/* Search Box */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-[var(--sera-muted)] w-4 h-4" />
            <Input
              placeholder="Search orders by order number or notes..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 border-[var(--sera-line)] focus-visible:ring-[var(--sera-orange)]/30"
            />
          </div>
        </CardContent>
      </Card>

      {/* Orders List - Card Layout */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--sera-ink)]">Recent Orders</h2>
          {filteredOrders.length > 0 && (
            <span className="text-sm text-[var(--sera-muted)]">{filteredOrders.length} orders found</span>
          )}
        </div>

        {filteredOrders.length === 0 ? (
          <Card className="sera-sc-panel shadow-none">
            <CardContent className="py-12">
              <div className="text-center">
                <FileText className="w-12 h-12 text-[var(--sera-muted)] mx-auto mb-4 opacity-50" />
                <h3 className="text-lg font-medium text-[var(--sera-ink)] mb-2">No orders found</h3>
                <p className="text-[var(--sera-muted)] mb-4">
                  {searchQuery || statusFilter !== 'all'
                    ? 'Try adjusting your filters'
                    : ['MANU', 'MFG'].includes(userProfile.organizations.org_type_code)
                      ? 'No orders available. Manufacturers receive orders from HQ.'
                      : 'Create your first order to get started'}
                </p>
                {/* Hide Create Order button for Manufacturer organizations or if user doesn't have permission */}
                {!['MANU', 'MFG'].includes(userProfile.organizations.org_type_code) && canCreateOrders && (
                  <Button
                    className="gap-2 bg-[var(--sera-ink)] text-white hover:bg-[var(--sera-ink-soft)]"
                    onClick={handleCreateOrder}
                  >
                    <Plus className="w-4 h-4" />
                    Create Order
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ) : viewMode === 'list' ? (
          /* LIST VIEW - Table Format */
          <div className="sera-sc-panel overflow-hidden">
              <div className="overflow-x-auto sera-sc-table-scroll">
                <table className="sera-sc-table min-w-[900px]">
                  <thead>
                    <tr>
                      <th
                        className="is-sortable"
                        onClick={() => handleSort('order_date')}
                      >
                        <div className="flex items-center gap-1">
                          Date
                          <ArrowUpDown className="w-3 h-3" />
                        </div>
                      </th>
                      <th
                        className="is-sortable"
                        onClick={() => handleSort('order_no')}
                      >
                        <div className="flex items-center gap-1">
                          Order
                          <ArrowUpDown className="w-3 h-3" />
                        </div>
                      </th>
                      <th
                        className="is-sortable"
                        onClick={() => handleSort('seller')}
                      >
                        <div className="flex items-center gap-1">
                          Name
                          <ArrowUpDown className="w-3 h-3" />
                        </div>
                      </th>
                      <th
                        className="is-sortable text-right"
                        onClick={() => handleSort('total')}
                      >
                        <div className="flex items-center justify-end gap-1">
                          Total
                          <ArrowUpDown className="w-3 h-3" />
                        </div>
                      </th>
                      <th
                        className="is-sortable text-right"
                        onClick={() => handleSort('balance')}
                      >
                        <div className="flex items-center justify-end gap-1">
                          Balance
                          <ArrowUpDown className="w-3 h-3" />
                        </div>
                      </th>
                      <th
                        className="is-sortable text-center"
                        onClick={() => handleSort('status')}
                      >
                        <div className="flex items-center justify-center gap-1">
                          Status
                          <ArrowUpDown className="w-3 h-3" />
                        </div>
                      </th>
                      <th className="text-center">Due</th>
                      <th
                        className="is-sortable"
                        onClick={() => handleSort('created_by')}
                      >
                        <div className="flex items-center gap-1">
                          <span>By</span>
                          <ArrowUpDown className="w-3 h-3" />
                        </div>
                      </th>
                      <th className="text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedOrders.map((order) => {
                      const totalAmount = calculateOrderTotal(order)
                      const totalUnits = order.order_items?.reduce((sum, item) => sum + item.qty, 0) || 0
                      const paidAmount = (order as any).paid_amount || 0
                      const balance = Math.max(0, totalAmount - paidAmount)

                      return (
                        <tr key={order.id}>
                          <td className="whitespace-nowrap">
                            {formatDateKeyShort(orderBusinessDate(order))}
                          </td>

                          <td className="whitespace-nowrap">
                            <button
                              className="font-medium text-[var(--sera-ink)] hover:text-[var(--sera-orange)] hover:underline"
                              onClick={() => handleViewOrderDetails(order.id)}
                              title={order.display_doc_no ? `Legacy: ${order.order_no}` : undefined}
                            >
                              {order.display_doc_no || order.order_no}
                              {(order.source_channel === 'telegram' || order.source_channel === 'whatsapp') && (
                                <Badge variant="outline" className="ml-2 text-[10px] uppercase tracking-wide">
                                  {order.source_channel}
                                </Badge>
                              )}
                            </button>
                          </td>

                          <td>
                            <div className="max-w-[200px] truncate" title={getDisplayOrgName(order)}>
                              {getDisplayOrgName(order)}
                            </div>
                          </td>

                          <td className="text-right font-medium">
                            {formatCurrency(totalAmount)}
                          </td>

                          <td className={`text-right font-medium ${balance > 0 ? 'text-red-600' : ''}`}>
                            {formatCurrency(balance)}
                          </td>

                          <td className="text-center">
                            {order.status === 'approved' && (order as any).po_acknowledged ? (
                              (() => {
                                const totalAmount = calculateOrderTotal(order)
                                const paidAmount = (order as any).paid_amount || 0

                                if (paidAmount >= totalAmount && totalAmount > 0) {
                                  return (
                                    <Badge className="sera-sc-badge sera-sc-badge--success">
                                      <span className="capitalize">Paid</span>
                                    </Badge>
                                  )
                                } else if (paidAmount > 0) {
                                  return (
                                    <Badge className="sera-sc-badge sera-sc-badge--orange">
                                      <span className="capitalize">Partial</span>
                                    </Badge>
                                  )
                                } else {
                                  return (
                                    <Badge className="sera-sc-badge sera-sc-badge--ink bg-red-50 text-red-700">
                                      <span className="capitalize">Unpaid</span>
                                    </Badge>
                                  )
                                }
                              })()
                            ) : (
                              <Badge className={getStatusColor(order.status)}>
                                <span className="capitalize">{order.status}</span>
                              </Badge>
                            )}
                          </td>

                          <td className="text-center">-</td>

                          <td>
                            <div className="max-w-[120px] truncate" title={order.created_by_user?.full_name || order.created_by_user?.email || 'Unknown'}>
                              {order.created_by_user?.full_name || order.created_by_user?.email || 'Unknown'}
                            </div>
                          </td>

                          <td className="text-right">
                            <div className="flex items-center justify-end gap-2">
                              {canEditOrder(order) && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 gap-1 text-xs px-2"
                                  onClick={() => handleEditOrder(order.id)}
                                  title="Edit Order"
                                >
                                  <Edit className="w-3 h-3" />
                                </Button>
                              )}
                              {canCopyOrder(order) && (userProfile.roles.role_level === 1 || userProfile.roles.role_level === 10) && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 gap-1 text-xs px-2 border-[var(--sera-line)] text-[var(--sera-orange)] hover:bg-[var(--sera-orange)]/8"
                                  onClick={() => handleCopyOrder(order.id, order.order_no)}
                                  title="Copy Order"
                                >
                                  <Copy className="w-3 h-3" />
                                </Button>
                              )}
                              {canApproveOrder(order) && (
                                <Button
                                  variant="default"
                                  size="sm"
                                  className="h-7 gap-1 text-xs px-2 sera-sc-btn-primary"
                                  onClick={() => handleApproveOrder(order.id, order.order_no, order.display_doc_no)}
                                  title="Approve Order"
                                >
                                  <CheckCircle className="w-3 h-3" />
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0"
                                onClick={() => handleViewOrderDetails(order.id)}
                                title="View Order Details"
                              >
                                <Eye className="w-4 h-4" />
                              </Button>
                              {canCancelOrder(order) && (userProfile.roles.role_level === 1 || userProfile.roles.role_level === 10) && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 w-8 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
                                  onClick={() => handleCancelOrder(order.id, order.order_no)}
                                  title="Cancel Order"
                                >
                                  <XCircle className="w-4 h-4" />
                                </Button>
                              )}
                              {canDeleteOrder() && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 w-8 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
                                  onClick={() => handleDeleteOrder(order.id, order.order_no)}
                                  title="Delete Order (Super Admin Only)"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination Controls */}
              {sortedOrders.length > 0 && (
                <div className="flex items-center justify-between px-4 py-3 border-t border-[var(--sera-line)] bg-[var(--sera-mist)]/40">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[var(--sera-muted)]">
                      Showing {startIndex + 1} to {Math.min(endIndex, sortedOrders.length)} of {sortedOrders.length} orders
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <select
                      value={itemsPerPage}
                      onChange={(e) => {
                        setItemsPerPage(Number(e.target.value))
                        setCurrentPage(1)
                      }}
                      className="px-2 py-1 text-xs border border-[var(--sera-line)] rounded-md bg-white"
                    >
                      <option value={10}>10 per page</option>
                      <option value={25}>25 per page</option>
                      <option value={50}>50 per page</option>
                      <option value={100}>100 per page</option>
                    </select>

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                      disabled={currentPage === 1}
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </Button>

                    <span className="text-xs text-[var(--sera-ink)]/80">
                      Page {currentPage} of {totalPages}
                    </span>

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                      disabled={currentPage === totalPages}
                    >
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              )}
          </div>
        ) : (
          /* CARD VIEW */
          <div className="sera-module-landing__grid">
            {filteredOrders.map((order) => {
              const totalAmount = calculateOrderTotal(order)
              const itemCount = order.order_items?.length || 0
              const totalUnits = order.order_items?.reduce((sum, item) => sum + item.qty, 0) || 0

              return (
                <div key={order.id} className="sera-module-landing__card cursor-pointer">
                    <div className="flex items-start justify-between mb-4">
                      <div className="flex-1 min-w-0">
                        <button
                          type="button"
                          className="font-display font-semibold text-lg mb-1 text-[var(--sera-ink)] hover:text-[var(--sera-orange)] hover:underline text-left"
                          onClick={() => handleViewOrderDetails(order.id)}
                          title={order.display_doc_no ? `Legacy: ${order.order_no}` : undefined}
                        >
                          {order.display_doc_no || order.order_no}
                        </button>
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant="outline" className="text-xs sera-sc-badge sera-sc-badge--info border-[var(--sera-line)]">
                            {order.order_type}
                          </Badge>
                          {(order.source_channel === 'telegram' || order.source_channel === 'whatsapp') && (
                            <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                              {order.source_channel}
                            </Badge>
                          )}
                          <span className="text-xs text-[var(--sera-muted)]">
                            {getOrderTypeLabel(order.order_type)}
                          </span>
                        </div>
                      </div>
                      {order.status === 'approved' && (order as any).po_acknowledged ? (
                        (() => {
                          const totalAmount = calculateOrderTotal(order)
                          const paidAmount = (order as any).paid_amount || 0

                          if (paidAmount >= totalAmount && totalAmount > 0) {
                            return (
                              <Badge className="sera-sc-badge sera-sc-badge--success">
                                <div className="flex items-center gap-1">
                                  <CheckCircle className="w-3 h-3" />
                                  <span className="text-xs font-medium">Paid</span>
                                </div>
                              </Badge>
                            )
                          } else if (paidAmount > 0) {
                            return (
                              <Badge className="sera-sc-badge sera-sc-badge--orange">
                                <div className="flex items-center gap-1">
                                  <Clock className="w-3 h-3" />
                                  <span className="text-xs font-medium">Partial</span>
                                </div>
                              </Badge>
                            )
                          } else {
                            return (
                              <Badge className="sera-sc-badge sera-sc-badge--ink bg-red-50 text-red-700">
                                <div className="flex items-center gap-1">
                                  <AlertCircle className="w-3 h-3" />
                                  <span className="text-xs font-medium">Unpaid</span>
                                </div>
                              </Badge>
                            )
                          }
                        })()
                      ) : (
                        <Badge className={getStatusColor(order.status)}>
                          <div className="flex items-center gap-1">
                            {getStatusIcon(order.status)}
                            <span className="text-xs font-medium">{order.status}</span>
                          </div>
                        </Badge>
                      )}
                    </div>

                    <div className="space-y-2 mb-4 border-t border-b border-[var(--sera-line)] py-3">
                      <div className="flex items-start gap-2">
                        <ShoppingCart className="w-4 h-4 text-[var(--sera-orange)] mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-[var(--sera-muted)]">Customer</div>
                          <div className="text-sm font-medium text-[var(--sera-ink)] truncate">
                            {order.buyer_org?.org_name || 'Unknown'}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-start gap-2">
                        <Store className="w-4 h-4 text-[var(--sera-orange)] mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-[var(--sera-muted)]">Seller</div>
                          <div className="text-sm font-medium text-[var(--sera-ink)] truncate" title={getDisplayOrgName(order)}>
                            {shortenOrgName(getDisplayOrgName(order))}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-3 mb-4">
                      <div className="sera-sc-kpi text-center !p-2">
                        <div className="sera-sc-kpi__label !text-[10px]">Items</div>
                        <div className="sera-sc-kpi__value !text-lg">{formatNumber(itemCount)}</div>
                      </div>
                      <div className="sera-sc-kpi text-center !p-2">
                        <div className="sera-sc-kpi__label !text-[10px]">Cases</div>
                        <div className="sera-sc-kpi__value !text-lg">{formatNumber(totalUnits)}</div>
                      </div>
                      <div className="sera-sc-kpi text-center !p-2">
                        <div className="sera-sc-kpi__label !text-[10px]">Amount</div>
                        <div className="sera-sc-kpi__value !text-sm">{formatCurrency(totalAmount)}</div>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-xs text-[var(--sera-muted)]">
                        <Calendar className="w-3 h-3" />
                        <span>Order Date {formatDateKey(orderBusinessDate(order))}</span>
                      </div>
                    </div>

                    <div className="space-y-1.5 pt-2 border-t border-[var(--sera-line)]">
                      {order.created_by_user && (
                        <div className="flex items-center gap-2 text-xs">
                          <User className="w-3 h-3 text-[var(--sera-muted)]" />
                          <span className="text-[var(--sera-muted)]">Created by:</span>
                          <span className="font-medium text-[var(--sera-ink)]">
                            {order.created_by_user.full_name || order.created_by_user.email}
                          </span>
                        </div>
                      )}
                      {order.status === 'approved' && order.approved_by_user && (
                        <div className="flex items-center gap-2 text-xs">
                          <CheckCircle className="w-3 h-3 text-[var(--sera-orange)]" />
                          <span className="text-[var(--sera-muted)]">Approved by:</span>
                          <span className="font-medium text-[var(--sera-ink)]">
                            {order.approved_by_user.full_name || order.approved_by_user.email}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2 mt-4 pt-3 border-t border-[var(--sera-line)]">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 gap-1 text-xs h-7 px-2 border-[var(--sera-line)]"
                        title="View Details"
                        onClick={() => handleViewOrderDetails(order.id)}
                      >
                        <Eye className="w-3 h-3" />
                        View
                      </Button>
                      {canEditOrder(order) && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1 gap-1 text-xs h-7 px-2 border-[var(--sera-line)]"
                          title="Edit Order"
                          onClick={() => handleEditOrder(order.id)}
                        >
                          <Edit className="w-3 h-3" />
                          Edit
                        </Button>
                      )}
                      {canCopyOrder(order) && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1 gap-1 text-xs h-7 px-2 border-[var(--sera-line)] text-[var(--sera-orange)] hover:bg-[var(--sera-orange)]/8"
                          title="Copy Order"
                          onClick={() => handleCopyOrder(order.id, order.order_no)}
                        >
                          <Copy className="w-3 h-3" />
                          Copy
                        </Button>
                      )}
                      {canApproveOrder(order) && (
                        <Button
                          variant="default"
                          size="sm"
                          className="flex-1 gap-1 text-xs h-7 px-2 sera-sc-btn-primary"
                          onClick={() => handleApproveOrder(order.id, order.order_no, order.display_doc_no)}
                          title="Approve Order"
                        >
                          <CheckCircle className="w-3 h-3" />
                          Approve
                        </Button>
                      )}
                      {canCancelOrder(order) && userProfile.roles.role_level !== 40 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
                          onClick={() => handleCancelOrder(order.id, order.order_no)}
                          title="Cancel Order"
                        >
                          <XCircle className="w-4 h-4" />
                        </Button>
                      )}
                      {canDeleteOrder() && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
                          title="Delete Order (Super Admin Only)"
                          onClick={() => handleDeleteOrder(order.id, order.order_no)}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      )}
                    </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Order Type Selection Dialog */}
      {showOrderTypeDialog && (
        <SeraModalOverlay onBackdropClick={() => setShowOrderTypeDialog(false)}>
          {/*
            Fixed size (md) intentionally: the auto-size path measures content
            and drives width/height through CSS custom properties that also carry
            a `transition`. With static card content this created a
            ResizeObserver ↔ transition feedback loop (the observed body kept
            changing size mid-animation), which re-measured and re-animated the
            panel repeatedly — the visible "flip"/flicker. A fixed size skips the
            measurement/transition path entirely and renders once, stably.
          */}
          <SeraModalPanel size="md">
            <SeraModalHeader
              title="Select Order Type"
              onClose={() => setShowOrderTypeDialog(false)}
            />
            <SeraModalBody className="space-y-3">
              <p className="text-sm text-[var(--sera-muted)] -mt-1 mb-2">
                Choose the type of order you want to create:
              </p>

              {canCreateH2M ? (
                <button
                  onClick={() => handleOrderTypeSelection('regular')}
                  className="w-full p-4 border-2 border-[var(--sera-line)] rounded-lg hover:border-gray-400 hover:bg-[var(--sera-ink)]/[0.02] transition-colors text-left"
                >
                  <div className="flex items-start gap-3">
                    <Store className="w-5 h-5 text-[var(--sera-muted)] mt-0.5" />
                    <div>
                      <h4 className="font-semibold text-[var(--sera-ink)]">HQ Order to Manufacture (H2M)</h4>
                      <p className="text-sm text-[var(--sera-muted)] mt-1">Create an order from Headquarters to a manufacturer.</p>
                    </div>
                  </div>
                </button>
              ) : null}

              <button
                onClick={() => handleOrderTypeSelection('d2h')}
                className="w-full p-4 border-2 border-[var(--sera-orange)]/20 rounded-lg hover:border-[var(--sera-orange)]/45 hover:bg-[var(--sera-orange)]/[0.06] transition-colors text-left"
              >
                <div className="flex items-start gap-3">
                  <Building2 className="w-5 h-5 text-[var(--sera-orange)] mt-0.5" />
                  <div>
                    <h4 className="font-semibold text-[var(--sera-ink)]">Order to HQ (D2H)</h4>
                    <p className="text-sm text-[var(--sera-muted)] mt-1">
                      Order products from headquarters using distributor pricing (only products with available stock)
                    </p>
                  </div>
                </div>
              </button>

              <button
                onClick={() => handleOrderTypeSelection('s2d')}
                className="w-full p-4 border-2 border-green-200 rounded-lg hover:border-green-500 hover:bg-green-50 transition-colors text-left"
              >
                <div className="flex items-start gap-3">
                  <ShoppingCart className="w-5 h-5 text-green-600 mt-0.5" />
                  <div>
                    <h4 className="font-semibold text-[var(--sera-ink)]">Shop Order (S2D)</h4>
                    <p className="text-sm text-[var(--sera-muted)] mt-1">
                      Create order for Shop from Distributor using retailer pricing (deducts from Distributor inventory)
                    </p>
                  </div>
                </div>
              </button>
            </SeraModalBody>
            <SeraModalFooter>
              <Button
                variant="ghost"
                onClick={() => setShowOrderTypeDialog(false)}
              >
                Cancel
              </Button>
            </SeraModalFooter>
          </SeraModalPanel>
        </SeraModalOverlay>
      )}
    </div>
  )
}
