'use client'

import { useState, useEffect } from 'react'
import {
  ArrowLeft,
  Package,
  Clock,
  CheckCircle2,
  FileText,
  CreditCard,
  Truck,
  Building2,
  Calendar,
  DollarSign
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/components/ui/use-toast'
import AvailableActionsCard from './AvailableActionsCard'
import OrderDocumentsDialogEnhanced from './OrderDocumentsDialogEnhanced'
import { resolveQrBufferPercent } from '@/lib/orders/qr-buffer'

interface OrderDetails {
  id: string
  order_no: string
  display_doc_no: string | null
  order_type: 'H2M' | 'D2H' | 'S2D'
  status: 'draft' | 'submitted' | 'approved' | 'closed'
  buyer_org_name: string
  seller_org_name: string
  total_items: number
  total_amount: number
  created_at: string
  approved_at: string | null
  approved_by_name: string | null
  created_by_name: string | null
  has_lucky_draw: boolean
  has_redeem: boolean
  has_points: boolean
  has_rfid: boolean
  units_per_case: number
  qr_buffer_percent: number
  notes?: string | null
  documents: {
    po_date: string | null
    po_created_by: string | null
    deposit_invoice_date: string | null
    deposit_invoice_created_by: string | null
    deposit_payment_date: string | null
    deposit_payment_created_by: string | null
    invoice_date: string | null
    invoice_created_by: string | null
    payment_date: string | null
    payment_created_by: string | null
    receipt_date: string | null
    receipt_created_by: string | null
    balance_payment_request_id: string | null
    balance_payment_request_date: string | null
    balance_payment_request_status: string | null
    balance_payment_date: string | null
    balance_payment_created_by: string | null
    warehouse_receive_date: string | null
    warehouse_receive_by: string | null
    balance_payment_request_file_url?: string | null
  }
}

interface TimelineStep {
  label: string
  icon: any
  completed: boolean
  date: string | null
  description: string
  actionBy: string | null
  bgColor: string
  iconColor: string
  borderColor: string
  status?: string | null
  requestId?: string | null
  supportingDocUrl?: string | null
}

interface TrackOrderViewProps {
  userProfile: any
  onViewChange: (view: string) => void
}

export default function TrackOrderView({ userProfile, onViewChange }: TrackOrderViewProps) {
  const [loading, setLoading] = useState(true)
  const [orderDetails, setOrderDetails] = useState<OrderDetails | null>(null)
  const [showDocumentsDialog, setShowDocumentsDialog] = useState(false)
  const [initialDocumentTab, setInitialDocumentTab] = useState<'po' | 'invoice' | 'payment' | 'receipt' | 'depositInvoice' | 'depositPayment' | 'balanceRequest' | 'balancePayment' | null>(null)
  const [approvingPaymentRequest, setApprovingPaymentRequest] = useState(false)
  const supabase = createClient()

  useEffect(() => {
    loadOrderDetails()
    // eslint-disable-next-line react-hooks/exhaustive-deps

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const normalizeTab = (docType?: string | null): 'po' | 'invoice' | 'payment' | 'receipt' | null => {
      if (!docType) return null
      switch (docType.toUpperCase()) {
        case 'PO':
          return 'po'
        case 'INVOICE':
          return 'invoice'
        case 'PAYMENT':
          return 'payment'
        case 'RECEIPT':
          return 'receipt'
        default:
          return null
      }
    }

    // Check if we should auto-open the documents dialog
    const selectedDocumentId = sessionStorage.getItem('selectedDocumentId')
    const selectedDocumentType = sessionStorage.getItem('selectedDocumentType')
    const selectedDocumentTab = sessionStorage.getItem('selectedDocumentTab')
    if (selectedDocumentId && orderDetails) {
      // Use the explicitly set tab if available, otherwise normalize the document type
      const tabToOpen = (selectedDocumentTab || normalizeTab(selectedDocumentType) || 'po') as 'po' | 'invoice' | 'payment' | 'receipt' | 'depositInvoice' | 'depositPayment' | 'balanceRequest' | 'balancePayment'
      setInitialDocumentTab(tabToOpen)
      setShowDocumentsDialog(true)
      // Clear the flags after opening
      sessionStorage.removeItem('selectedDocumentId')
      sessionStorage.removeItem('selectedDocumentType')
      sessionStorage.removeItem('selectedDocumentTab')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderDetails])

  const loadOrderDetails = async () => {
    try {
      setLoading(true)

      // Get order ID from sessionStorage
      const trackingOrderId = sessionStorage.getItem('trackingOrderId')

      if (!trackingOrderId) {
        toast({
          title: "Error",
          description: "No order selected for tracking",
          variant: "destructive"
        })
        onViewChange('orders')
        return
      }

      // Fetch order details with user information
      const { data: order, error: orderError } = await supabase
        .from('orders')
        .select(`
          id,
          order_no,
          display_doc_no,
          order_type,
          status,
          created_at,
          approved_at,
          buyer_org_id,
          seller_org_id,
          created_by,
          approved_by,
          has_lucky_draw,
          has_redeem,
          has_points,
          has_rfid,
          units_per_case,
          qr_buffer_percent,
          notes
        `)
        .eq('id', trackingOrderId)
        .single()

      if (orderError) throw orderError

      // Fetch buyer org name
      const { data: buyerOrg } = await supabase
        .from('organizations')
        .select('org_name')
        .eq('id', order.buyer_org_id)
        .single()

      // Fetch seller org name
      const { data: sellerOrg } = await supabase
        .from('organizations')
        .select('org_name')
        .eq('id', order.seller_org_id)
        .single()

      // Fetch created by user
      const { data: createdByUser } = await supabase
        .from('users')
        .select('full_name')
        .eq('id', order.created_by)
        .single()

      // Fetch approved by user
      let approvedByUser = null
      if (order.approved_by) {
        const { data } = await supabase
          .from('users')
          .select('full_name')
          .eq('id', order.approved_by)
          .single()
        approvedByUser = data
      }

      // Fetch order items to calculate totals
      const { data: items, error: itemsError } = await supabase
        .from('order_items')
        .select('qty, line_total')
        .eq('order_id', trackingOrderId)

      if (itemsError) throw itemsError

      const totalItems = items?.reduce((sum, item) => sum + item.qty, 0) || 0
      const totalAmount = items?.reduce((sum, item) => sum + (item.line_total || 0), 0) || 0

      // Fetch documents timeline with creator info
      const { data: documents, error: docsError } = await supabase
        .from('documents')
        .select(`
          id,
          doc_type, 
          doc_no,
          status,
          acknowledged_at, 
          created_at,
          created_by,
          acknowledged_by
        `)
        .eq('order_id', trackingOrderId)
        .order('created_at', { ascending: true })

      if (docsError) throw docsError

      // Get user names for document creators
      const getUserName = async (userId: string | null) => {
        if (!userId) return null
        const { data } = await supabase
          .from('users')
          .select('full_name')
          .eq('id', userId)
          .single()
        return data?.full_name || null
      }

      const poDoc = documents?.find(d => d.doc_type === 'PO')
      const invoiceDocs = documents?.filter(d => d.doc_type === 'INVOICE').sort((a, b) => {
        const dateA = a.created_at ? new Date(a.created_at).getTime() : 0
        const dateB = b.created_at ? new Date(b.created_at).getTime() : 0
        return dateA - dateB
      })
      const depositInvoiceDoc = invoiceDocs?.[0] // First invoice = deposit
      const finalInvoiceDoc = invoiceDocs?.[1] // Second invoice = final (if exists)

      const paymentDocs = documents?.filter(d => d.doc_type === 'PAYMENT').sort((a, b) => {
        const dateA = a.created_at ? new Date(a.created_at).getTime() : 0
        const dateB = b.created_at ? new Date(b.created_at).getTime() : 0
        return dateA - dateB
      })
      const depositPaymentDoc = paymentDocs?.[0] // First payment = deposit
      const balancePaymentDoc = paymentDocs?.[1] // Second payment = balance (created from request approval)

      const paymentRequestDoc = documents?.find(d => d.doc_type === 'PAYMENT_REQUEST')
      const receiptDoc = documents?.find(d => d.doc_type === 'RECEIPT')

      let balanceRequestFileUrl: string | null = null
      if (paymentRequestDoc) {
        const { data: balanceFiles, error: balanceFileError } = await supabase
          .from('document_files')
          .select('file_url')
          .eq('document_id', paymentRequestDoc.id)
          .limit(1)

        if (balanceFileError) {
          console.error('Error fetching balance payment support file:', balanceFileError)
        }

        balanceRequestFileUrl = balanceFiles?.[0]?.file_url ?? null
      }

      // Extract document dates and creators
      const docDates = {
        po_date: poDoc?.created_at || null,
        po_created_by: poDoc ? await getUserName(poDoc.created_by) : null,

        // Deposit invoice (first invoice)
        deposit_invoice_date: depositInvoiceDoc?.acknowledged_at || depositInvoiceDoc?.created_at || null,
        deposit_invoice_created_by: depositInvoiceDoc ? await getUserName(depositInvoiceDoc.acknowledged_by || depositInvoiceDoc.created_by) : null,

        // Deposit payment (first payment)
        deposit_payment_date: depositPaymentDoc?.acknowledged_at || null,
        deposit_payment_created_by: depositPaymentDoc ? await getUserName(depositPaymentDoc.acknowledged_by) : null,

        // Legacy invoice (for backwards compatibility)
        invoice_date: finalInvoiceDoc?.acknowledged_at || finalInvoiceDoc?.created_at || depositInvoiceDoc?.acknowledged_at || depositInvoiceDoc?.created_at || null,
        invoice_created_by: finalInvoiceDoc ? await getUserName(finalInvoiceDoc.acknowledged_by || finalInvoiceDoc.created_by) : depositInvoiceDoc ? await getUserName(depositInvoiceDoc.acknowledged_by || depositInvoiceDoc.created_by) : null,

        // Legacy payment (for backwards compatibility)
        payment_date: balancePaymentDoc?.acknowledged_at || depositPaymentDoc?.acknowledged_at || null,
        payment_created_by: balancePaymentDoc ? await getUserName(balancePaymentDoc.acknowledged_by) : depositPaymentDoc ? await getUserName(depositPaymentDoc.acknowledged_by) : null,

        // Receipt
        receipt_date: receiptDoc?.created_at || null,
        receipt_created_by: receiptDoc ? await getUserName(receiptDoc.created_by) : null,

        // Balance Payment Request (NEW)
        balance_payment_request_id: paymentRequestDoc?.id || null,
        balance_payment_request_date: paymentRequestDoc?.created_at || null,
        balance_payment_request_status: paymentRequestDoc?.status || null,
        balance_payment_request_file_url: balanceRequestFileUrl,

        // Balance Payment (from request approval)
        balance_payment_date: balancePaymentDoc?.acknowledged_at || null,
        balance_payment_created_by: balancePaymentDoc ? await getUserName(balancePaymentDoc.acknowledged_by) : null,
      }

      // Fetch warehouse receive data
      const { data: warehouseReceive } = await supabase
        .from('qr_master_codes')
        .select(`
          warehouse_received_at,
          warehouse_received_by,
          qr_batches!inner (order_id)
        `)
        .eq('qr_batches.order_id', trackingOrderId)
        .eq('status', 'received_warehouse')
        .order('warehouse_received_at', { ascending: true })
        .limit(1)
        .maybeSingle()

      let warehouseReceiveBy = null
      if (warehouseReceive?.warehouse_received_by) {
        warehouseReceiveBy = await getUserName(warehouseReceive.warehouse_received_by)
      }

      const docDatesWithWarehouse = {
        ...docDates,
        warehouse_receive_date: warehouseReceive?.warehouse_received_at || null,
        warehouse_receive_by: warehouseReceiveBy
      }

      setOrderDetails({
        id: order.id,
        order_no: order.order_no,
        display_doc_no: order.display_doc_no || null,
        order_type: order.order_type,
        status: order.status,
        buyer_org_name: buyerOrg?.org_name || 'Unknown',
        seller_org_name: sellerOrg?.org_name || 'Unknown',
        total_items: totalItems,
        total_amount: totalAmount,
        created_at: order.created_at!,
        approved_at: order.approved_at,
        created_by_name: createdByUser?.full_name || 'Unknown',
        approved_by_name: approvedByUser?.full_name || null,
        has_lucky_draw: order.has_lucky_draw || false,
        has_redeem: order.has_redeem || false,
        has_points: order.has_points || false,
        has_rfid: order.has_rfid || false,
        units_per_case: order.units_per_case || 100,
        qr_buffer_percent: resolveQrBufferPercent(order.qr_buffer_percent),
        notes: order.notes || null,
        documents: docDatesWithWarehouse
      })

    } catch (error: any) {
      console.error('Error loading order details:', error)
      toast({
        title: "Error",
        description: error.message || "Failed to load order details",
        variant: "destructive"
      })
    } finally {
      setLoading(false)
    }
  }

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case 'draft': return 'bg-gray-500'
      case 'submitted': return 'bg-blue-500'
      case 'approved': return 'bg-green-500'
      case 'closed': return 'bg-purple-500'
      default: return 'bg-gray-500'
    }
  }

  const getOrderTypeLabel = (type: string) => {
    switch (type) {
      case 'H2M': return 'HQ to Manufacturer'
      case 'D2H': return 'Distributor to HQ'
      case 'S2D': return 'Shop to Distributor'
      default: return type
    }
  }

  const formatDate = (dateString: string | null) => {
    if (!dateString) return 'Pending'
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    })
  }

  const formatTimeAgo = (dateString: string | null) => {
    if (!dateString) return ''

    const now = new Date()
    const date = new Date(dateString)
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000)

    if (diffInSeconds < 60) return 'just now'
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`
    if (diffInSeconds < 2592000) return `${Math.floor(diffInSeconds / 86400)}d ago`
    if (diffInSeconds < 31536000) return `${Math.floor(diffInSeconds / 2592000)}mo ago`
    return `${Math.floor(diffInSeconds / 31536000)}y ago`
  }

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-MY', {
      style: 'currency',
      currency: 'MYR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount).replace('MYR', 'RM')
  }

  const handleApproveBalancePaymentRequest = async (requestId: string) => {
    try {
      setApprovingPaymentRequest(true)

      const response = await fetch(`/api/documents/payment-request/${requestId}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      })

      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || 'Failed to approve payment request')
      }

      toast({
        title: "Success",
        description: `Balance payment request approved. Payment document ${data.payment_doc_no} has been created.`,
      })

      // Reload order details to refresh timeline
      await loadOrderDetails()

    } catch (error: any) {
      console.error('Error approving payment request:', error)
      toast({
        title: "Error",
        description: error.message || "Failed to approve payment request",
        variant: "destructive"
      })
    } finally {
      setApprovingPaymentRequest(false)
    }
  }

  const isHQAdmin = () => {
    return userProfile?.role_code === 'HQ_ADMIN' ||
      userProfile?.role_code === 'POWER_USER' ||
      userProfile?.organizations?.org_type_code === 'HQ'
  }

  // Timeline steps based on order workflow
  const getTimelineSteps = () => {
    if (!orderDetails) return []

    const steps = [
      {
        label: 'Order Created',
        icon: Package,
        completed: true,
        date: orderDetails.created_at,
        description: 'Order placed successfully',
        actionBy: orderDetails.created_by_name,
        bgColor: 'bg-green-50',
        iconColor: 'bg-green-100 text-green-600',
        borderColor: 'border-green-200'
      },
      {
        label: 'Awaiting Approval',
        icon: Clock,
        completed: orderDetails.status !== 'draft' && orderDetails.status !== 'submitted',
        date: orderDetails.status === 'submitted' ? orderDetails.created_at : null,
        description: orderDetails.status === 'draft' ? 'Order in draft' : 'Pending approval',
        actionBy: null,
        bgColor: 'bg-yellow-50',
        iconColor: 'bg-yellow-100 text-yellow-600',
        borderColor: 'border-yellow-200'
      },
      {
        label: 'Order Approved',
        icon: CheckCircle2,
        completed: orderDetails.status === 'approved' || orderDetails.status === 'closed',
        date: orderDetails.approved_at,
        description: 'Order approved by seller',
        actionBy: orderDetails.approved_by_name,
        bgColor: 'bg-blue-50',
        iconColor: 'bg-blue-100 text-blue-600',
        borderColor: 'border-blue-200'
      },
      {
        label: 'PO Generation',
        icon: FileText,
        completed: !!orderDetails.documents.po_date,
        date: orderDetails.documents.po_date,
        description: 'Purchase Order generated',
        actionBy: orderDetails.documents.po_created_by || 'System Auto-Generation',
        bgColor: 'bg-purple-50',
        iconColor: 'bg-purple-100 text-purple-600',
        borderColor: 'border-purple-200'
      },
      {
        label: 'Deposit Invoice Sent',
        icon: FileText,
        completed: !!orderDetails.documents.deposit_invoice_date,
        date: orderDetails.documents.deposit_invoice_date,
        description: 'Deposit invoice (50%) acknowledged by buyer',
        actionBy: orderDetails.documents.deposit_invoice_created_by,
        bgColor: 'bg-indigo-50',
        iconColor: 'bg-indigo-100 text-indigo-600',
        borderColor: 'border-indigo-200'
      },
      {
        label: 'Deposit Payment',
        icon: CreditCard,
        completed: !!orderDetails.documents.deposit_payment_date,
        date: orderDetails.documents.deposit_payment_date,
        description: 'Deposit payment (50%) processed',
        actionBy: orderDetails.documents.deposit_payment_created_by,
        bgColor: 'bg-amber-50',
        iconColor: 'bg-amber-100 text-amber-600',
        borderColor: 'border-amber-200'
      },
      {
        label: 'Delivery to Warehouse',
        icon: Truck,
        completed: !!orderDetails.documents.warehouse_receive_date,
        date: orderDetails.documents.warehouse_receive_date,
        description: 'Products received at warehouse',
        actionBy: orderDetails.documents.warehouse_receive_by || 'Warehouse Receive',
        bgColor: 'bg-teal-50',
        iconColor: 'bg-teal-100 text-teal-600',
        borderColor: 'border-teal-200'
      },
      {
        label: 'Balance Payment Request Created',
        icon: DollarSign,
        completed: !!orderDetails.documents.balance_payment_request_date,
        date: orderDetails.documents.balance_payment_request_date,
        description: 'Balance payment request (50%) auto-generated',
        actionBy: 'System Auto-Generation',
        bgColor: 'bg-orange-50',
        iconColor: 'bg-orange-100 text-orange-600',
        borderColor: 'border-orange-200',
        status: orderDetails.documents.balance_payment_request_status,
        requestId: orderDetails.documents.balance_payment_request_id,
        supportingDocUrl: orderDetails.documents.balance_payment_request_file_url
      },
      {
        label: 'Balance Payment Approved',
        icon: CheckCircle2,
        completed: orderDetails.documents.balance_payment_request_status === 'acknowledged',
        date: orderDetails.documents.balance_payment_request_status === 'acknowledged' ? orderDetails.documents.balance_payment_request_date : null,
        description: 'Balance payment request approved by HQ',
        actionBy: orderDetails.documents.balance_payment_request_status === 'acknowledged' ? 'HQ Admin' : null,
        bgColor: 'bg-cyan-50',
        iconColor: 'bg-cyan-100 text-cyan-600',
        borderColor: 'border-cyan-200'
      },
      {
        label: 'Final Payment',
        icon: CreditCard,
        completed: !!orderDetails.documents.balance_payment_date,
        date: orderDetails.documents.balance_payment_date,
        description: 'Balance payment (50%) processed',
        actionBy: orderDetails.documents.balance_payment_created_by,
        bgColor: 'bg-rose-50',
        iconColor: 'bg-rose-100 text-rose-600',
        borderColor: 'border-rose-200'
      },
      {
        label: 'Final Receipt',
        icon: FileText,
        completed: !!orderDetails.documents.receipt_date,
        date: orderDetails.documents.receipt_date,
        description: 'Receipt acknowledged',
        actionBy: orderDetails.documents.receipt_created_by,
        bgColor: 'bg-emerald-50',
        iconColor: 'bg-emerald-100 text-emerald-600',
        borderColor: 'border-emerald-200'
      },
      {
        label: 'Order Completed',
        icon: CheckCircle2,
        completed: orderDetails.status === 'closed',
        date: orderDetails.documents.receipt_date,
        description: 'Order completed',
        actionBy: null,
        bgColor: 'bg-green-50',
        iconColor: 'bg-green-100 text-green-600',
        borderColor: 'border-green-200'
      }
    ]

    return steps
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <Package className="w-12 h-12 text-gray-400 mx-auto mb-4 animate-pulse" />
          <p className="text-gray-600">Loading order details...</p>
        </div>
      </div>
    )
  }

  if (!orderDetails) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <Package className="w-12 h-12 text-gray-400 mx-auto mb-4" />
          <p className="text-gray-600">Order not found</p>
          <Button
            onClick={() => onViewChange('orders')}
            variant="outline"
            className="mt-4"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Orders
          </Button>
        </div>
      </div>
    )
  }

  const timelineSteps = getTimelineSteps()
  const completedSteps = timelineSteps.filter(s => s.completed).length

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button
            onClick={() => onViewChange('orders')}
            variant="ghost"
            size="sm"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
          <div>
            <h2 className="text-2xl font-bold text-gray-900">{orderDetails.display_doc_no || orderDetails.order_no}</h2>
            {orderDetails.display_doc_no && orderDetails.display_doc_no !== orderDetails.order_no && (
              <p className="text-xs text-gray-400">Legacy: {orderDetails.order_no}</p>
            )}
            <p className="text-sm text-gray-500">{getOrderTypeLabel(orderDetails.order_type)}</p>
          </div>
        </div>
        <Badge className={`${getStatusBadgeColor(orderDetails.status)} text-white`}>
          {orderDetails.status.toUpperCase()}
        </Badge>
      </div>

      {/* Order Summary Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Order Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div className="flex items-start gap-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Building2 className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Buyer</p>
                <p className="font-semibold text-gray-900">{orderDetails.buyer_org_name}</p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="p-2 bg-green-100 rounded-lg">
                <Building2 className="w-5 h-5 text-green-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Seller</p>
                <p className="font-semibold text-gray-900">{orderDetails.seller_org_name}</p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="p-2 bg-purple-100 rounded-lg">
                <Package className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Total Items</p>
                <p className="font-semibold text-gray-900">{orderDetails.total_items} units</p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="p-2 bg-amber-100 rounded-lg">
                <DollarSign className="w-5 h-5 text-amber-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Total Amount</p>
                <p className="font-semibold text-gray-900">{formatCurrency(orderDetails.total_amount)}</p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <div className="p-2 bg-indigo-100 rounded-lg">
                <Calendar className="w-5 h-5 text-indigo-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Created Date</p>
                <p className="font-semibold text-gray-900">{formatDate(orderDetails.created_at)}</p>
              </div>
            </div>

            {orderDetails.approved_at && (
              <div className="flex items-start gap-3">
                <div className="p-2 bg-green-100 rounded-lg">
                  <CheckCircle2 className="w-5 h-5 text-green-600" />
                </div>
                <div>
                  <p className="text-sm text-gray-500">Approved Date</p>
                  <p className="font-semibold text-gray-900">{formatDate(orderDetails.approved_at)}</p>
                </div>
              </div>
            )}
          </div>

          {/* Order Configuration Features */}
          <div className="mt-6 pt-6 border-t border-gray-200">
            <h4 className="text-sm font-semibold text-gray-700 mb-3">Order Configuration</h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {orderDetails.has_lucky_draw && (
                <div className="bg-purple-50 border border-purple-200 rounded-lg px-3 py-2">
                  <p className="text-xs text-purple-600 font-medium">🎁 Lucky Draw</p>
                  <p className="text-xs text-purple-500 mt-0.5">Enabled</p>
                </div>
              )}
              {orderDetails.has_redeem && (
                <div className="bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
                  <p className="text-xs text-orange-600 font-medium">🎟️ Redeem</p>
                  <p className="text-xs text-orange-500 mt-0.5">Enabled</p>
                </div>
              )}
              {orderDetails.has_points && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                  <p className="text-xs text-blue-600 font-medium">⭐ Points</p>
                  <p className="text-xs text-blue-500 mt-0.5">Enabled</p>
                </div>
              )}
              {orderDetails.has_rfid && (
                <div className="bg-green-50 border border-green-200 rounded-lg px-3 py-2">
                  <p className="text-xs text-green-600 font-medium">📡 RFID</p>
                  <p className="text-xs text-green-500 mt-0.5">Enabled</p>
                </div>
              )}
              <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                <p className="text-xs text-gray-600 font-medium">📦 Cases/Box</p>
                <p className="text-xs text-gray-500 mt-0.5">{orderDetails.units_per_case}</p>
              </div>
              <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                <p className="text-xs text-gray-600 font-medium">📊 QR Buffer</p>
                <p className="text-xs text-gray-500 mt-0.5">{orderDetails.qr_buffer_percent}%</p>
              </div>
            </div>
          </div>

          {/* Notes Section */}
          {orderDetails.notes && (
            <div className="mt-6 pt-6 border-t border-gray-200">
              <h4 className="text-sm font-semibold text-gray-700 mb-2">Notes</h4>
              <p className="text-sm text-gray-600 bg-gray-50 p-3 rounded-lg">{orderDetails.notes}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Available Actions */}
      <AvailableActionsCard
        orderId={orderDetails.id}
        orderNo={orderDetails.order_no}
        onViewDocuments={() => {
          setInitialDocumentTab('po')
          setShowDocumentsDialog(true)
        }}
        onReportIssue={() => {
          toast({
            title: "Report Issue",
            description: "Issue reporting feature coming soon!"
          })
        }}
      />

      {/* Documents Dialog */}
      <OrderDocumentsDialogEnhanced
        orderId={orderDetails.id}
        orderNo={orderDetails.order_no}
        displayOrderNo={orderDetails.display_doc_no}
        userProfile={userProfile}
        initialTab={initialDocumentTab ?? undefined}
        open={showDocumentsDialog}
        onClose={() => {
          setShowDocumentsDialog(false)
          setInitialDocumentTab(null)
          // Reload order details to refresh timeline after any document changes
          loadOrderDetails()
        }}
      />
    </div>
  )
}
