'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { resolveOrganizationLogoUrl } from '@/lib/organizations/logo'
import { resolveOrganizationTerms } from '@/lib/organizations/terms'
import { resolveUserSignatureUrl } from '@/lib/users/signature'
import {
  buildCounterpartyAddressLines,
  buildCounterpartyContactLines,
  resolveCounterpartyRoleLabel,
} from '@/lib/documents/counterparty'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ArrowLeft, Building2, Calendar, DollarSign, Sparkles, Gift, Trophy, QrCode, FileText, Receipt, Clock, CheckCircle2, Download, MessageCircle } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import { formatNumber, formatCurrency as formatCurrencyUtil } from '@/lib/utils/formatters'
import {
  salesOrderLineDescription,
  sortSalesOrderLinesForDisplay,
} from '@/lib/orders/sales-order-line-presentation'
import { formatExpectedDelivery, resolveOrderCasesPerBox } from '@/lib/orders/packaging'
import { formatOrderExpectedBoxes } from '@/lib/orders/packaging'
import { qrCaseTotals } from '@/lib/orders/qr-buffer'
import OrderDocumentsDialogEnhanced from '@/components/dashboard/views/orders/OrderDocumentsDialogEnhanced'
import DHReceiptDialog from '@/components/orders/DHReceiptDialog'
import { MessagingOrderTimelinePanel } from '@/components/orders/MessagingOrderTimelinePanel'
import { MessagingOrderFulfilmentPanel } from '@/components/orders/MessagingOrderFulfilmentPanel'
import { formatDateKey, orderBusinessDate } from '@/lib/orders/order-date'

interface UserProfile {
  id: string
  email: string
  organization_id: string
  organizations: {
    org_name: string
    org_code: string
    org_type_code: string
  }
  roles: {
    role_level: number
  }
}

interface ViewOrderDetailsViewProps {
  userProfile: UserProfile
  onViewChange?: (view: string) => void
  orderId?: string
}

type OrderActor = {
  id?: string
  email?: string | null
  full_name?: string | null
  signature_url?: string | null
}

function mergeOrderActor(
  existing: OrderActor | null | undefined,
  fallback: OrderActor | undefined,
): OrderActor | undefined {
  if (!existing) return fallback
  if (!fallback) return existing

  return {
    ...fallback,
    ...existing,
    full_name: existing.full_name || fallback.full_name,
    email: existing.email || fallback.email,
    // The fallback comes from the authorized actor route and contains a
    // temporary delivery URL. Never retain the raw persisted reference.
    signature_url: fallback.signature_url ?? null,
  }
}

export default function ViewOrderDetailsView({ userProfile, onViewChange, orderId }: ViewOrderDetailsViewProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const serappReturnPath = searchParams.get('from') === 'serapp'
    ? (searchParams.get('return') || '/serapp/history')
    : null
  const [orderData, setOrderData] = useState<any>(null)
  const [journeyData, setJourneyData] = useState<any>(null)
  const [qrStats, setQrStats] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [documentsDialogOpen, setDocumentsDialogOpen] = useState(false)
  const [receiptDialogOpen, setReceiptDialogOpen] = useState(false)
  const [logoFailed, setLogoFailed] = useState(false)
  const [companySignatureFailed, setCompanySignatureFailed] = useState(false)
  const [creatorSignatureUrl, setCreatorSignatureUrl] = useState<string | null>(null)
  const [creatorSignatureFailed, setCreatorSignatureFailed] = useState(false)
  const [approverSignatureUrl, setApproverSignatureUrl] = useState<string | null>(null)
  const [approverSignatureFailed, setApproverSignatureFailed] = useState(false)
  const printAreaRef = useRef<HTMLDivElement>(null)
  const supabase = createClient()
  const { toast } = useToast()

  useEffect(() => {
    const idToLoad = orderId || sessionStorage.getItem('viewOrderId')
    if (idToLoad) {
      loadAuthorizedOrderData(idToLoad)
    } else {
      toast({
        title: 'Error',
        description: 'No order ID found',
        variant: 'destructive'
      })
      handleBack()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Stored signature values are raw public-object URLs for the `documents`
  // bucket, which the storage gateway rejects without credentials; they must
  // be re-signed before an <img> can load them.
  const storedCreatorSignature = orderData?.created_by_user?.signature_url ?? null
  const storedApproverSignature = orderData?.approved_by_user?.signature_url ?? null

  useEffect(() => {
    let cancelled = false

    const resolve = async () => {
      const [created, approved] = await Promise.all([
        resolveUserSignatureUrl(supabase, storedCreatorSignature),
        resolveUserSignatureUrl(supabase, storedApproverSignature),
      ])

      if (cancelled) return
      setCreatorSignatureUrl(created)
      setCreatorSignatureFailed(false)
      setApproverSignatureUrl(approved)
      setApproverSignatureFailed(false)
    }

    resolve()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedCreatorSignature, storedApproverSignature])

  useEffect(() => {
    setLogoFailed(false)
    setCompanySignatureFailed(false)
  }, [orderData?.id])

  async function loadAuthorizedOrderData(orderId: string) {
    try {
      const accessResponse = await fetch(`/api/orders/${encodeURIComponent(orderId)}/access`)
      if (!accessResponse.ok) {
        const result = await accessResponse.json().catch(() => null)
        throw new Error(result?.error || 'Unauthorized')
      }

      await Promise.all([
        loadOrderData(orderId),
        loadJourneyData(orderId),
        loadQRStats(orderId),
      ])
    } catch (error: any) {
      setLoading(false)
      toast({
        title: 'Unauthorized',
        description: error?.message || 'You do not have permission to view this order',
        variant: 'destructive'
      })
    }
  }

  async function loadOrderData(orderId: string) {
    try {
      setLoading(true)

      // Fetch order data with all related data in a single query
      const { data: order, error } = await supabase
        .from('orders')
        .select(`
          *,
          buyer_org:organizations!orders_buyer_org_id_fkey(*),
          seller_org:organizations!orders_seller_org_id_fkey(*),
          created_by_user:users!orders_created_by_fkey(full_name, email, signature_url),
          approved_by_user:users!orders_approved_by_fkey(full_name, email, signature_url)
        `)
        .eq('id', orderId)
        .single()

      if (error) throw error
      if (!order) throw new Error('Order not found')

      // Resolve fulfillment warehouse display name for D2H/S2D (legacy-safe).
      const fulfillmentWarehouseId = (order as any).fulfillment_warehouse_id as string | null
      if (fulfillmentWarehouseId) {
        const { data: fulfillmentWarehouse } = await supabase
          .from('organizations')
          .select('id, org_name')
          .eq('id', fulfillmentWarehouseId)
          .maybeSingle()
        ;(order as any).fulfillment_warehouse_name = fulfillmentWarehouse?.org_name || null
      } else if (['D2H', 'S2D', 'DH'].includes(order.order_type)) {
        const { data: inventoryOrgId } = await (supabase as any).rpc('order_inventory_organization', {
          p_order_id: orderId,
        })
        if (inventoryOrgId) {
          const { data: fulfillmentWarehouse } = await supabase
            .from('organizations')
            .select('id, org_name')
            .eq('id', inventoryOrgId)
            .maybeSingle()
          ;(order as any).fulfillment_warehouse_id = inventoryOrgId
          ;(order as any).fulfillment_warehouse_name = fulfillmentWarehouse?.org_name || null
        }
      }

      // Compute resolved actors (may be hydrated from API). We keep them
      // separate from the Supabase-inferred row type to avoid type conflicts.
      let resolvedCreatedByUser = order.created_by_user as OrderActor | null | undefined
      let resolvedApprovedByUser = order.approved_by_user as OrderActor | null | undefined

      // Always hydrate through the server route: direct browser signing is now
      // owner-scoped and cannot read another actor's sensitive signature.
      {
        try {
          const actorResponse = await fetch('/api/orders/actors', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderIds: [orderId] })
          })

          if (actorResponse.ok) {
            const actorPayload: unknown = await actorResponse.json()
            const rawUsers: unknown[] = (typeof actorPayload === 'object' && actorPayload !== null && Array.isArray((actorPayload as Record<string, unknown>).users))
              ? (actorPayload as Record<string, unknown[]>).users
              : []
            const actorUsers: OrderActor[] = rawUsers.filter(
              (u): u is OrderActor => typeof u === 'object' && u !== null && typeof (u as OrderActor).id === 'string'
            )
            const actorMap = new Map(actorUsers.map((actor: OrderActor) => [actor.id, actor]))

            const fallbackCreatedBy: OrderActor | undefined = order.created_by
              ? (actorMap.get(order.created_by) ?? undefined)
              : undefined
            const fallbackApprovedBy: OrderActor | undefined = order.approved_by
              ? (actorMap.get(order.approved_by) ?? undefined)
              : undefined

            resolvedCreatedByUser = mergeOrderActor(resolvedCreatedByUser, fallbackCreatedBy)
            resolvedApprovedByUser = mergeOrderActor(resolvedApprovedByUser, fallbackApprovedBy)
          }
        } catch (actorError) {
          console.warn('Failed to hydrate order detail actors:', actorError)
        }
      }

      // Load order items with product and variant in parallel
      const [itemsResult, poDocResult, paymentDocsResult] = await Promise.all([
        supabase
          .from('order_items')
          .select(`
            *,
            product:products(product_name, product_code),
            variant:product_variants(variant_name, product_code)
          `)
          .eq('order_id', orderId),

        // Load PO document to check acknowledgement status
        supabase
          .from('documents')
          .select('status')
          .eq('order_id', orderId)
          .eq('doc_type', 'PO')
          .maybeSingle(),

        // Load acknowledged PAYMENT documents to calculate paid amount
        supabase
          .from('documents')
          .select('payment_percentage, payload')
          .eq('order_id', orderId)
          .eq('doc_type', 'PAYMENT')
          .eq('status', 'acknowledged')
      ])

      if (itemsResult.error) throw itemsResult.error

      const itemsWithDetails = itemsResult.data || []
      const poDoc = poDocResult.data
      const paymentDocs = paymentDocsResult.data

      // Calculate order total and paid amount
      const orderTotal = itemsWithDetails.reduce((sum, item) => sum + (item.line_total || 0), 0)
      let paidAmount = 0

      if (paymentDocs && paymentDocs.length > 0) {
        paymentDocs.forEach((payment: any) => {
          const paymentPct = payment.payment_percentage ||
            (payment.payload as any)?.payment_percentage ||
            (payment.payload as any)?.requested_percent ||
            30 // default deposit percentage
          paidAmount += (orderTotal * paymentPct / 100)
        })
      }

      // Determine payment status
      const poAcknowledged = poDoc?.status === 'acknowledged' || poDoc?.status === 'completed'
      let paymentStatus = 'submitted' // default
      if (order.status === 'approved' && poAcknowledged) {
        if (paidAmount >= orderTotal && orderTotal > 0) {
          paymentStatus = 'paid'
        } else if (paidAmount > 0) {
          paymentStatus = 'partial'
        } else {
          paymentStatus = 'unpaid'
        }
      } else if (order.status === 'approved') {
        paymentStatus = 'approved'
      } else if (order.status === 'closed') {
        paymentStatus = 'closed'
      } else {
        paymentStatus = order.status
      }

      // Combine all data, overriding actor fields with resolved/hydrated values.
      const completeOrderData = {
        ...order,
        created_by_user: resolvedCreatedByUser ?? order.created_by_user,
        approved_by_user: resolvedApprovedByUser ?? order.approved_by_user,
        order_items: itemsWithDetails,
        paid_amount: paidAmount,
        order_total: orderTotal,
        payment_status: paymentStatus,
        po_acknowledged: poAcknowledged
      }

      console.log('✅ Complete order data loaded:', completeOrderData)
      setOrderData(completeOrderData)
    } catch (error: any) {
      console.error('Error loading order:', error?.message || 'Unknown error', error)
      toast({
        title: 'Error',
        description: error?.message || 'Failed to load order details',
        variant: 'destructive'
      })
    } finally {
      setLoading(false)
    }
  }

  async function loadJourneyData(orderId: string) {
    try {
      // Get journey configuration linked to this order
      const { data: link, error: linkError } = await supabase
        .from('journey_order_links')
        .select('journey_config_id')
        .eq('order_id', orderId)
        .maybeSingle()

      if (linkError) {
        if (linkError.code !== 'PGRST116') {
          console.error('Error loading journey link:', linkError.message || linkError.code || 'Unknown error', linkError)
        }
        return
      }

      if (!link) {
        return // No journey linked to this order
      }

      // Get journey configuration details
      const { data: journeyConfig, error: configError } = await supabase
        .from('journey_configurations')
        .select('*')
        .eq('id', link.journey_config_id)
        .eq('is_active', true)
        .maybeSingle()

      if (configError) {
        if (configError.code !== 'PGRST116') {
          console.error('Error loading journey config:', configError.message || configError.code || 'Unknown error', configError)
        }
        return
      }

      console.log('Journey config loaded:', journeyConfig)
      setJourneyData(journeyConfig)
    } catch (error: any) {
      console.error('Error loading journey data:', error?.message || 'Unknown error', error)
    }
  }

  async function loadQRStats(orderId: string) {
    try {
      // Get batch ID from order
      const { data: batch, error: batchError } = await supabase
        .from('qr_batches')
        .select('id')
        .eq('order_id', orderId)
        .maybeSingle()

      if (batchError) {
        if (batchError.code !== 'PGRST116') {
          console.error('Error loading batch:', batchError.message || batchError.code || 'Unknown error', batchError)
        }
        return
      }

      if (!batch) {
        // No batch found, set default stats
        setQrStats({
          validLinks: 0,
          scanned: 0,
          redemptions: 0,
          luckyDraws: 0
        })
        return
      }

      // Get QR codes stats using proper count queries (avoids 1000 row limit)
      // Count total valid links (all QR codes in batch)
      const { count: validLinks } = await supabase
        .from('qr_codes')
        .select('*', { count: 'exact', head: true })
        .eq('batch_id', batch.id)

      // Count scanned - actual consumer scans from consumer_qr_scans table
      const { count: scanned } = await supabase
        .from('consumer_qr_scans')
        .select('*', { count: 'exact', head: true })
        .eq('batch_id', batch.id)

      // Get redemptions count from consumer_qr_scans where reward was redeemed
      const { count: redemptionCount } = await supabase
        .from('consumer_qr_scans')
        .select('id', { count: 'exact', head: true })
        .eq('batch_id', batch.id)
        .not('redeemed_at', 'is', null)

      // Get lucky draw entries
      const { count: luckyDrawCount } = await supabase
        .from('lucky_draw_entries')
        .select('id', { count: 'exact', head: true })
        .eq('batch_id', batch.id)

      setQrStats({
        validLinks: validLinks || 0,
        scanned: scanned || 0,
        redemptions: redemptionCount || 0,
        luckyDraws: luckyDrawCount || 0
      })
    } catch (error: any) {
      console.error('Error loading QR stats:', error?.message || 'Unknown error', error)
      // Set default stats on error
      setQrStats({
        validLinks: 0,
        scanned: 0,
        redemptions: 0,
        luckyDraws: 0
      })
    }
  }

  const handleBack = () => {
    sessionStorage.removeItem('viewOrderId')
    if (serappReturnPath) {
      router.push(serappReturnPath)
      return
    }
    window.history.replaceState({}, '', '/supply-chain')
    if (onViewChange) {
      onViewChange('orders')
    }
  }

  const handleBackToOrders = () => {
    sessionStorage.removeItem('viewOrderId')
    window.history.replaceState({}, '', '/supply-chain')
    if (onViewChange) {
      onViewChange('orders')
    }
  }

  const formatCurrency = (amount: number): string => {
    return formatCurrencyUtil(amount)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-[var(--sera-muted)]">Loading order details...</p>
        </div>
      </div>
    )
  }

  if (!orderData) {
    return (
      <div className="text-center py-12">
        <p className="text-[var(--sera-muted)]">Order not found</p>
        <Button onClick={handleBack} className="mt-4">
          {serappReturnPath ? (
            <>
              <MessageCircle className="w-4 h-4 mr-2" />
              Back to Serapp
            </>
          ) : (
            <>
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Orders
            </>
          )}
        </Button>
      </div>
    )
  }

  const subtotal = orderData.order_items?.reduce((sum: number, item: any) => sum + (item.line_total || 0), 0) || 0

  // Logic to swap display for Sales Orders (SO) vs Purchase Orders (PO)
  // For PO: Header is Buyer (Issuer), Section is Supplier
  // For SO: Header is Seller (Issuer), Section is Customer
  // Check display_doc_no first (new format like SO26000044), then fall back to order_no and order_type
  const isSalesOrder = (orderData.display_doc_no || orderData.order_no)?.startsWith('SO') || orderData.order_type === 'SO'
  const headerOrg = isSalesOrder ? orderData.seller_org : orderData.buyer_org
  const otherOrg = isSalesOrder ? orderData.buyer_org : orderData.seller_org
  // Same role classification the generated documents use, so a distributor is
  // named as such here too. The document-specific wording stays this view's own.
  const otherOrgLabel = `${resolveCounterpartyRoleLabel(otherOrg, isSalesOrder ? 'Customer' : 'Supplier')}:`
  // Address and contact lines come from the linked organization master record
  // through the same normalizers the PDFs use, so screen and PDF agree.
  const otherOrgAddressLines = buildCounterpartyAddressLines(otherOrg)
  const otherOrgContactLines = buildCounterpartyContactLines(otherOrg)
  const docTitle = isSalesOrder ? 'SALES ORDER' : 'PURCHASE ORDER'
  const docNoLabel = isSalesOrder ? 'SO#:' : 'PO#:'

  const totalQuantity = orderData.order_items?.reduce((sum: number, item: any) => sum + (item.qty || 0), 0) || 0

  // Presentation order of the line items: Hero rows first, then Zero, then any
  // other family, each group keeping the sequence it was stored in. A copy is
  // sorted, never `orderData.order_items` itself, and the totals above are
  // summed from the stored rows — nothing here can move a number.
  const displayItems: any[] = isSalesOrder
    ? sortSalesOrderLinesForDisplay<any>(orderData.order_items, (item) => item.product?.product_name)
    : (orderData.order_items ?? [])

  // Expected Delivery, from the same case total the totals row prints, at the
  // order's configured box size (100 cases = 1 box unless master data says
  // otherwise).
  const expectedDeliveryLabel = formatExpectedDelivery(
    totalQuantity,
    resolveOrderCasesPerBox(
      (orderData.order_items ?? []).map((item: any) => item.units_per_case),
      orderData.units_per_case,
    ),
  )

  // Expected Boxes for H2M / D2H orders: the same Standard/Small Box rule as the
  // SO's Expected Delivery, over the ordered cases only. The H2M manufacturer
  // buffer is stated on its own line: its cases are not boxed.
  const showExpectedBoxes = !isSalesOrder && ['H2M', 'D2H', 'DH'].includes(orderData.order_type)
  const expectedBoxesLabel = formatOrderExpectedBoxes(orderData.order_items ?? [], orderData.units_per_case)
  const manufacturerBuffer = orderData.order_type === 'H2M' ? qrCaseTotals(totalQuantity, orderData.qr_buffer_percent) : null

  // Persisted org media may be a relative storage path or a legacy-host URL;
  // the canonical resolver rebuilds it against the configured storage host.
  const headerOrgLogoUrl = resolveOrganizationLogoUrl(headerOrg?.logo_url)
  const companySignatureUrl = resolveOrganizationLogoUrl(headerOrg?.signature_url)
  const orderTerms = resolveOrganizationTerms(headerOrg)
  const headerOrgInitials = String(headerOrg?.org_name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((word: string) => word[0])
    .join('')
    .toUpperCase()

  const waitForDocumentImages = async (timeoutMs = 2500) => {
    const container = printAreaRef.current
    if (!container) return

    const pending = Array.from(container.querySelectorAll('img')).filter(
      (img) => !(img.complete && img.naturalWidth > 0)
    )
    if (pending.length === 0) return

    await Promise.race([
      Promise.all(
        pending.map(
          (img) =>
            new Promise<void>((resolve) => {
              img.addEventListener('load', () => resolve(), { once: true })
              img.addEventListener('error', () => resolve(), { once: true })
            })
        )
      ),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ])
  }

  // Helper to get status color based on payment status
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'paid': return 'text-green-600'
      case 'partial': return 'text-orange-600'
      case 'unpaid': return 'text-red-600'
      case 'approved': return 'text-green-600'
      case 'closed': return 'text-[var(--sera-muted)]'
      case 'cancelled': return 'text-red-600'
      case 'draft': return 'text-[var(--sera-muted)]'
      default: return 'text-yellow-600' // submitted/pending
    }
  }

  // Get display status (payment status takes priority for approved orders)
  const getDisplayStatus = () => {
    if (orderData.payment_status && ['paid', 'partial', 'unpaid'].includes(orderData.payment_status)) {
      return orderData.payment_status.toUpperCase()
    }
    return orderData.status === 'submitted' ? 'SUBMITTED' : orderData.status?.toUpperCase()
  }

  return (
    <div className="min-h-screen overflow-x-hidden bg-gray-50 print:bg-white">
      {/* Action Bar */}
      <div className="bg-white border-b border-gray-200 mb-0 print:hidden">
        <div className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-4">
          <div className="flex flex-wrap items-center gap-2">
            {serappReturnPath ? (
              <>
                <Button
                  onClick={handleBack}
                  className="self-start shrink-0 gap-2 bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange-deep)]"
                >
                  <MessageCircle className="w-4 h-4" />
                  Back to Serapp
                </Button>
                <Button
                  variant="ghost"
                  onClick={handleBackToOrders}
                  className="self-start hover:bg-gray-100 -ml-2 shrink-0"
                >
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  Back to Orders
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                onClick={handleBack}
                className="self-start hover:bg-gray-100 -ml-2 shrink-0"
              >
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to Orders
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-2 sm:justify-end">
            {/* Receipt Button - Only show for D2H orders that are approved */}
            {(orderData?.order_type === 'D2H' || orderData?.order_type === 'DH') && orderData?.status === 'approved' && (
              <Button
                onClick={() => setReceiptDialogOpen(true)}
                variant="outline"
                size="sm"
                className="gap-2 border-green-300 text-green-700 hover:bg-green-50"
              >
                <Receipt className="w-4 h-4" />
                Receipt
              </Button>
            )}
            <Button
              onClick={() => setDocumentsDialogOpen(true)}
              variant="outline"
              size="sm"
              className="gap-2 border-gray-300 hover:bg-gray-50"
            >
              <FileText className="w-4 h-4" />
              Documents
            </Button>
            <Button
              onClick={() => {
                // Set document title for PDF filename
                const originalTitle = document.title
                if (orderData?.order_no) {
                  document.title = `PO ${orderData.order_no}`
                }

                // Show a toast with instructions
                toast({
                  title: 'Print Dialog Opening',
                  description: 'In the print dialog, select "Save as PDF" as your printer destination to download the PDF file.',
                })
                // Trigger browser print dialog once document images are ready
                setTimeout(async () => {
                  await waitForDocumentImages()
                  window.print()
                  // Restore title after a delay to ensure print dialog picked it up
                  setTimeout(() => {
                    document.title = originalTitle
                  }, 2000)
                }, 500)
              }}
              size="sm"
              className="gap-2 bg-[var(--sera-orange)] hover:bg-[var(--sera-orange-deep)] text-white"
            >
              <FileText className="w-4 h-4" />
              <span className="hidden min-[400px]:inline">Print / </span>PDF
            </Button>
          </div>
        </div>
      </div>



      {/* Static Order View */}
      {/* Document Container - Only show for SO or PO main tabs */}
      <div ref={printAreaRef} className="bg-white shadow-lg p-4 sm:p-6 md:p-8 lg:p-12 print:shadow-none print:p-8 print:w-full">

        {/* Header Section */}
        <div className="mb-8 flex flex-col gap-6 sm:mb-12 lg:mb-12 lg:flex-row lg:items-start lg:justify-between print:mb-6">
          {/* Left: Company Logo */}
          <div className="w-full shrink-0 sm:w-32 lg:w-40">
            {headerOrgLogoUrl && !logoFailed ? (
              <img
                src={headerOrgLogoUrl}
                alt={headerOrg?.org_name || 'Company logo'}
                className="h-24 max-w-full object-contain object-left-top"
                onError={() => setLogoFailed(true)}
              />
            ) : (
              <div className="h-24 flex items-center">
                <div className="w-20 h-20 rounded-full bg-gray-100 border border-gray-200 flex items-center justify-center print:bg-white">
                  <span className="text-xl font-bold text-[var(--sera-muted)] tracking-wide">{headerOrgInitials || '?'}</span>
                </div>
              </div>
            )}
          </div>

          {/* Center: Headquarters Detail */}
          <div className="min-w-0 flex-1">
            <h2 className="font-bold text-gray-900 uppercase mb-2 text-sm tracking-wide">
              {headerOrg?.org_name}
            </h2>
            <div className="text-xs text-[var(--sera-muted)] space-y-1 leading-relaxed">
              {/* `organizations` stores these as contact_phone / contact_email;
                  the previous `phone` / `email` reads did not exist on the row,
                  so the issuer's contact details never rendered at all. */}
              <p className="whitespace-pre-line">{headerOrg?.address || 'No address provided'}</p>
              {headerOrg?.contact_phone && <p>Phone: {headerOrg.contact_phone}</p>}
              {headerOrg?.contact_email && <p>Email: {headerOrg.contact_email}</p>}
              {headerOrg?.website && <p>Website: {headerOrg.website}</p>}
            </div>
          </div>

          {/* Right: PO Detail */}
          <div className="w-full shrink-0 lg:w-auto lg:text-right">
            <h1 className="mb-3 text-lg font-light uppercase tracking-wider text-gray-900 sm:mb-4 sm:text-xl">{docTitle}</h1>
            <div className="text-xs space-y-2">
              <div className="flex justify-between gap-4">
                <span className="text-[var(--sera-muted)]">{docNoLabel}</span>
                <span className="font-medium text-gray-900">{orderData.display_doc_no || orderData.order_no}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-[var(--sera-muted)]">Date:</span>
                {/* Business SO date (order_date), not the entry timestamp; legacy rows fall back to created_at's MYT date. */}
                <span className="font-medium text-gray-900">{formatDateKey(orderBusinessDate(orderData))}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-[var(--sera-muted)]">By:</span>
                <span className="font-medium text-gray-900">{orderData.created_by_user?.full_name || 'Unknown'}</span>
              </div>
              {['D2H', 'S2D', 'DH'].includes(orderData.order_type) && (
                <div className="flex justify-between gap-4">
                  <span className="text-[var(--sera-muted)]">Fulfilled From:</span>
                  <span className="font-medium text-gray-900">
                    {(orderData as any).fulfillment_warehouse_name || 'Legacy / unresolved'}
                  </span>
                </div>
              )}
              <div className="flex justify-between gap-4">
                <span className="text-[var(--sera-muted)]">Ledger:</span>
                <span className="font-medium text-gray-900">Stock Purchased / Inventory</span>
              </div>
            </div>
          </div>
        </div>

        {/* Supplier & Status Section */}
        <div className="mb-8 flex flex-col gap-6 border-t border-gray-100 pt-6 sm:mb-12 sm:flex-row sm:items-start sm:justify-between print:mb-6 print:pt-4">
          {/* Supplier Info */}
          <div className="w-full min-w-0 sm:w-1/2">
            <h3 className="font-bold text-gray-900 mb-3 text-sm">{otherOrgLabel}</h3>
            <div className="text-xs text-[var(--sera-muted)] space-y-1 leading-relaxed">
              <p className="font-bold text-gray-800 uppercase mb-1">{otherOrg?.org_name}</p>
              {/* Only lines that actually carry master data are rendered, so a
                  sparsely filled organization shows fewer lines rather than
                  blank ones. */}
              {otherOrgAddressLines.length > 0 ? (
                <div className="max-w-full sm:max-w-xs">
                  {otherOrgAddressLines.map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </div>
              ) : (
                <p>No address provided</p>
              )}
              {otherOrgContactLines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </div>

          {/* Status Box */}
          <div className="w-full shrink-0 sm:w-48">
            <div className="border border-gray-200 p-4 text-center rounded-sm">
              <p className="text-xs text-[var(--sera-muted)] mb-1 uppercase tracking-wide">Status</p>
              <p className={`text-xl font-bold uppercase ${getStatusColor(orderData.payment_status || orderData.status)}`}>
                {getDisplayStatus()}
              </p>
            </div>
          </div>
        </div>

        {/* Items Table */}
        <div className="mb-8 -mx-4 overflow-x-auto px-4 sm:mx-0 sm:mb-12 sm:px-0 print:mb-6">
          <table className="w-full min-w-[36rem]">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="py-2 text-left text-xs font-bold text-gray-900 w-12">No</th>
                <th className="py-2 text-left text-xs font-bold text-gray-900">Description</th>
                <th className="py-2 text-left text-xs font-bold text-gray-900 w-32">Product Code</th>
                <th className="py-2 text-right text-xs font-bold text-gray-900 w-24">Cases</th>
                <th className="py-2 text-right text-xs font-bold text-gray-900 w-32">Price</th>
                <th className="py-2 text-right text-xs font-bold text-gray-900 w-32">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {displayItems.map((item: any, index: number) => (
                <tr key={item.id} className="break-inside-avoid page-break-inside-avoid">
                  <td className="py-3 text-xs text-[var(--sera-muted)] align-top pt-4">{index + 1}</td>
                  <td className="py-3 text-xs text-gray-900 align-top pt-4">
                    <p className="break-words text-sm font-medium sm:whitespace-nowrap">
                      {/* "Cellera Zero - [ Almond Corn ]" — the Product Name plus
                          the flavour, without the marketing range words master
                          data repeats inside every variant name. */}
                      {salesOrderLineDescription(item.product?.product_name, item.variant?.variant_name)}
                    </p>
                  </td>
                  {/* Master-data identity, the same code Quick Order and the
                      WhatsApp reply use. The exact warehouse stock configuration
                      is resolved and confirmed at allocation, so it is picking
                      detail rather than something to read on the order. */}
                  <td className="py-3 pr-3 text-xs text-gray-900 align-top pt-4">
                    <span className="font-medium">{item.variant?.product_code || '—'}</span>
                  </td>
                  <td className="py-3 text-xs text-gray-900 text-right align-top pt-4">{formatNumber(item.qty)}</td>
                  <td className="py-3 text-xs text-gray-900 text-right align-top pt-4">{formatCurrency(item.unit_price).replace('RM', '')}</td>
                  <td className="py-3 text-xs text-gray-900 text-right align-top pt-4">{formatCurrency(item.line_total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              {isSalesOrder ? (
                <tr className="border-t border-gray-200">
                  <td colSpan={3} className="py-4"></td>
                  <td className="py-4 text-right text-xs font-bold text-gray-900">{formatNumber(totalQuantity)}</td>
                  <td className="py-4 text-right text-xs font-bold text-gray-900">Total</td>
                  <td className="py-4 text-right text-sm font-bold text-gray-900">{formatCurrency(subtotal)}</td>
                </tr>
              ) : (
                // H2M / D2H: Grand Total | total cases (under Cases) | amount
                // (under Amount). Same sums; only the label moved ahead of the quantity.
                <tr className="border-t border-gray-200">
                  <td colSpan={3} className="py-4 pr-3 text-right text-xs font-bold text-gray-900">Grand Total</td>
                  <td className="py-4 text-right text-xs font-bold text-gray-900">{formatNumber(totalQuantity)}</td>
                  <td className="py-4"></td>
                  <td className="py-4 text-right text-sm font-bold text-gray-900">{formatCurrency(subtotal)}</td>
                </tr>
              )}
            </tfoot>
          </table>
        </div>

        {/* Expected Delivery - the ordered cases expressed in Standard/Small
            boxes, stated on one line between the order total and the Terms.
            Deliberately plain text in the document's own type scale, not a card
            or a panel: it is one more line of the order, and it must not break
            away from the flow when the document paginates. */}
        {isSalesOrder && (
          <p className="mt-2 text-sm text-gray-900 break-inside-avoid page-break-inside-avoid print:mt-1">
            <span className="font-semibold">Expected Delivery:</span>{' '}
            <span>{expectedDeliveryLabel}</span>
          </p>
        )}

        {/* Expected Boxes - H2M / D2H counterpart of the SO's Expected Delivery,
            one plain line below the Grand Total, the same in print. */}
        {showExpectedBoxes && (
          <div className="mt-2 text-sm text-gray-900 break-inside-avoid page-break-inside-avoid print:mt-1">
            <p>
              <span className="font-semibold">Expected Boxes:</span>{' '}
              <span>{expectedBoxesLabel}</span>
            </p>
            {manufacturerBuffer && manufacturerBuffer.bufferCases > 0 && (
              <p className="mt-0.5 text-xs text-[var(--sera-muted)]">
                Manufacturer buffer: {formatNumber(manufacturerBuffer.bufferCases)}{' '}
                {manufacturerBuffer.bufferCases === 1 ? 'case' : 'cases'} ({manufacturerBuffer.bufferPercent}%), not included in Expected Boxes
              </p>
            )}
          </div>
        )}

        {/* Terms & Conditions - the organization's own value, rendered verbatim */}
        {orderTerms && (
          <div className="mt-10 print:mt-6">
            <h3 className="font-bold text-gray-900 mb-3 text-sm">Terms &amp; Conditions</h3>
            <p className="text-xs text-[var(--sera-muted)] leading-relaxed whitespace-break-spaces">
              {orderTerms}
            </p>
          </div>
        )}

        {/* Footer Notes & Signature */}
        <div className="mt-8 border-t border-gray-100 pt-6 break-inside-avoid page-break-inside-avoid print:mt-4 print:pt-4 sm:mt-12 sm:pt-8">
          <div className="flex flex-col items-stretch gap-8 md:flex-row md:items-start md:justify-between">
            {/* Left: Issued By with Company Signature */}
            <div>
              {headerOrg?.signature_type === 'electronic' && companySignatureUrl && !companySignatureFailed && (
                <div className="mb-6">
                  <p className="text-sm font-bold text-gray-900 mb-2">Issued by:</p>
                  <div className="flex items-start gap-4">
                    <div className="w-32 h-24 flex items-center">
                      <img
                        src={companySignatureUrl}
                        alt="Company Signature"
                        className="max-w-full max-h-full object-contain"
                        onError={() => setCompanySignatureFailed(true)}
                      />
                    </div>
                  </div>
                </div>
              )}
              <p className="text-[10px] text-gray-400 mt-8">This is a computer generated document.</p>
            </div>

            {/* Center: Created By */}
            <div className="text-center">
              <p className="text-xs text-[var(--sera-muted)] mb-2">Created by: {orderData.created_by_user?.full_name || 'Unknown'}</p>
              {creatorSignatureUrl && !creatorSignatureFailed ? (
                <div className="flex justify-center mb-2">
                  <img
                    src={creatorSignatureUrl}
                    alt="Created by signature"
                    className="h-16 print:h-12 max-w-[12rem] object-contain"
                    onError={() => setCreatorSignatureFailed(true)}
                  />
                </div>
              ) : (
                <div className="h-16 print:h-12 mb-2 flex items-end justify-center">
                  <span className="text-[10px] italic text-gray-400">Signature not available</span>
                </div>
              )}
              <div className="border-t border-gray-300 w-48 mx-auto pt-1">
                <p className="text-xs text-[var(--sera-muted)]">{orderData.created_at ? new Date(orderData.created_at).toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric' }) : ''}</p>
              </div>
            </div>

            {/* Right: Approved By */}
            {orderData.approved_by && orderData.approved_by_user && (
              <div className="text-center">
                <p className="text-xs text-[var(--sera-muted)] mb-2">Approved by: {orderData.approved_by_user.full_name || 'Unknown'}</p>
                {approverSignatureUrl && !approverSignatureFailed ? (
                  <div className="flex justify-center mb-2">
                    <img
                      src={approverSignatureUrl}
                      alt="Approved by signature"
                      className="h-16 print:h-12 max-w-[12rem] object-contain"
                      onError={() => setApproverSignatureFailed(true)}
                    />
                  </div>
                ) : (
                  <div className="h-16 print:h-12 mb-2 flex items-end justify-center">
                    <span className="text-[10px] italic text-gray-400">Signature not available</span>
                  </div>
                )}
                <div className="border-t border-gray-300 w-48 mx-auto pt-1">
                  <p className="text-xs text-[var(--sera-muted)]">{orderData.approved_at ? new Date(orderData.approved_at).toLocaleDateString('en-MY', { day: '2-digit', month: 'short', year: 'numeric' }) : ''}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {orderData?.id && <MessagingOrderFulfilmentPanel orderId={orderData.id} />}

      {orderData?.id && <MessagingOrderTimelinePanel orderId={orderData.id} />}

      {/* Order Documents Dialog */}
      {orderData && (
        <OrderDocumentsDialogEnhanced
          orderId={orderData.id}
          orderNo={orderData.order_no}
          displayOrderNo={orderData.display_doc_no}
          userProfile={userProfile}
          open={documentsDialogOpen}
          onClose={() => setDocumentsDialogOpen(false)}
        />
      )}

      {/* DH Receipt Dialog - For recording payments from distributors */}
      {orderData && (orderData.order_type === 'D2H' || orderData.order_type === 'DH') && (
        <DHReceiptDialog
          orderId={orderData.id}
          orderNo={orderData.order_no}
          orderTotal={subtotal}
          paidAmount={orderData.paid_amount || 0}
          buyerOrgId={orderData.buyer_org_id}
          sellerOrgId={orderData.seller_org_id}
          companyId={orderData.company_id}
          open={receiptDialogOpen}
          onClose={() => setReceiptDialogOpen(false)}
          onSuccess={() => {
            // Reload order data to update paid amounts
            loadOrderData(orderData.id)
          }}
        />
      )}
    </div>
  )
}
