'use client'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ArrowLeft, User, Package, Loader2, Trash2, ShoppingCart, Building2 } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'
import QuickOrderGrid from './QuickOrderGrid'
import { orderTermsSummary, paymentTermChangeErrorMessage, type PaymentTermOption } from '@/lib/orders/payment-terms'
import {
  MISSING_DEFAULT_FULFILLMENT_WAREHOUSE_MESSAGE,
  filterEligibleHqFulfillmentWarehouses,
  resolveDefaultFulfillmentWarehouseId,
  resolveSellerHqId,
  type HqFulfillmentWarehouse,
} from '@/lib/orders/hq-fulfillment-warehouses'
import {
  D2H_ORDER_DATE_RPC_MIGRATION,
  formatDateKey,
  isMissingOrderDateRpcParameter,
  malaysiaToday,
  validateOrderDate,
} from '@/lib/orders/order-date'

interface UserProfile {
  id: string
  email: string
  role_code: string
  organization_id: string
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

interface DistributorOrderViewProps {
  userProfile: UserProfile
  onViewChange?: (view: string) => void
}

interface Organization {
  id: string
  org_name: string
  org_type_code: string
  org_code: string
  address?: string | null
  contact_phone?: string | null
  contact_name?: string | null
  address_line2?: string | null
}

interface ProductVariant {
  id: string
  product_id: string
  product_name: string
  product_code: string
  variant_product_code?: string | null
  group_name?: string
  variant_name: string
  alternative_name?: string | null
  attributes?: Record<string, any>
  barcode?: string | null
  manufacturer_sku?: string | null
  distributor_price: number
  available_qty: number
  /** Split of available_qty — see QuickOrderCatalogVariant.on_hand_qty. */
  on_hand_qty?: number
  reserved_qty?: number
  inventory_classification?: 'classified' | 'unclassified'
  pricing_status?: 'priced' | 'price_missing'
}

/**
 * The "… reserved by submitted orders" tail on a shortfall message. Submitted
 * D2H/S2D orders hold stock until they are approved or cancelled, so quoting
 * only the available figure makes a well-stocked flavour look broken.
 */
const reservedStockNote = (variant: { available_qty: number; on_hand_qty?: number; reserved_qty?: number }): string => {
  const reserved = variant.reserved_qty || 0
  if (reserved <= 0) return ''
  const onHand = variant.on_hand_qty ?? variant.available_qty + reserved
  return ` (${onHand.toLocaleString()} on hand, ${reserved.toLocaleString()} reserved by submitted orders awaiting approval)`
}

interface OrderItem {
  id?: string
  order_id?: string
  product_id: string
  variant_id: string
  product_name: string
  variant_name: string
  attributes?: Record<string, any>
  manufacturer_sku?: string | null
  qty: number
  unit_price: number
  line_total?: number
}

// Helper function to format currency with thousand separators
const formatCurrency = (amount: number): string => {
  return amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export default function DistributorOrderView({ userProfile, onViewChange }: DistributorOrderViewProps) {
  const supabase = createClient()
  const { toast } = useToast()

  // Ref to prevent duplicate toasts in React Strict Mode
  const toastShownRef = useRef(false)

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Organizations
  const [buyerOrg, setBuyerOrg] = useState<Organization | null>(null)
  const [sellerOrg, setSellerOrg] = useState<Organization | null>(null)
  const [availableDistributors, setAvailableDistributors] = useState<Organization[]>([])
  const [selectedDistributorId, setSelectedDistributorId] = useState('')

  // Payment term: the distributor's term from the master data; HQ Admin may choose another
  // one with a reason (logged, same as Order Documents).
  const [paymentTermOptions, setPaymentTermOptions] = useState<PaymentTermOption[]>([])
  const [masterTermId, setMasterTermId] = useState('')
  const [paymentTermId, setPaymentTermId] = useState('')
  const [paymentTermReason, setPaymentTermReason] = useState('')
  const [canChangePaymentTerm, setCanChangePaymentTerm] = useState(false)
  const [distributorSearchQuery, setDistributorSearchQuery] = useState('')
  const [isDistributorDropdownOpen, setIsDistributorDropdownOpen] = useState(false)
  const distributorSearchRef = useRef<HTMLDivElement>(null)
  const [hqOrgId, setHqOrgId] = useState<string>('')
  const [fulfillmentWarehouses, setFulfillmentWarehouses] = useState<HqFulfillmentWarehouse[]>([])
  const [fulfillmentWarehouseId, setFulfillmentWarehouseId] = useState('')
  const [defaultFulfillmentMissing, setDefaultFulfillmentMissing] = useState(false)
  const submitLockRef = useRef(false)

  // SO Date — the business/document date (orders.order_date). Defaults to today
  // in Asia/Kuala_Lumpur; past dates are allowed (backdated SO), future are not.
  // created_at stays the real creation time and is never backdated.
  const [orderDate, setOrderDate] = useState(() => malaysiaToday())
  const [orderDateTouched, setOrderDateTouched] = useState(false)

  // Payment terms list and who may change the term
  useEffect(() => {
    let cancelled = false
    const hqAdminByProfile =
      userProfile.organizations?.org_type_code === 'HQ' && Number(userProfile.roles?.role_level) <= 20
    if (hqAdminByProfile) setCanChangePaymentTerm(true)
    ;(async () => {
      const { data } = await supabase
        .from('payment_terms')
        .select('id, term_code, term_name, deposit_percentage, balance_percentage, is_default')
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
      if (!cancelled) setPaymentTermOptions((data || []) as PaymentTermOption[])
      const { data: isAdmin, error } = await (supabase as any).rpc('is_hq_admin')
      if (!cancelled && !error) setCanChangePaymentTerm(isAdmin === true || hqAdminByProfile)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The selected distributor's term (or the default term) - reset when the distributor changes
  useEffect(() => {
    if (paymentTermOptions.length === 0) return
    const fallback = paymentTermOptions.find((t) => t.is_default)?.id || paymentTermOptions[0].id
    if (!selectedDistributorId) {
      setMasterTermId(fallback)
      setPaymentTermId(fallback)
      return
    }
    let cancelled = false
    ;(async () => {
      const { data } = await supabase
        .from('organizations')
        .select('payment_term_id')
        .eq('id', selectedDistributorId)
        .maybeSingle()
      if (cancelled) return
      const term = (data as any)?.payment_term_id
      const id = paymentTermOptions.some((t) => t.id === term) ? term : fallback
      setMasterTermId(id)
      setPaymentTermId(id)
      setPaymentTermReason('')
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDistributorId, paymentTermOptions])

  const paymentTermChanged = Boolean(paymentTermId && masterTermId && paymentTermId !== masterTermId)

  // Customer Information
  const [customerName, setCustomerName] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [deliveryAddress, setDeliveryAddress] = useState('')

  // Products and Variants
  const [availableVariants, setAvailableVariants] = useState<ProductVariant[]>([])
  const [quickOrderVariants, setQuickOrderVariants] = useState<ProductVariant[]>([])
  const [selectedVariantId, setSelectedVariantId] = useState('')
  const [orderItems, setOrderItems] = useState<OrderItem[]>([])
  const [orderMode, setOrderMode] = useState<'quick' | 'standard'>('quick')
  const selectedFulfillmentWarehouse = fulfillmentWarehouses.find((warehouse) => warehouse.id === fulfillmentWarehouseId) || null

  // Product filtering
  const [productSearchQuery, setProductSearchQuery] = useState('')
  const [selectedProductFilter, setSelectedProductFilter] = useState('')

  useEffect(() => {
    initializeOrder()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (hqOrgId) {
      const timer = setTimeout(() => {
        loadDistributors(hqOrgId, undefined, distributorSearchQuery)
      }, 300)
      return () => clearTimeout(timer)
    }
  }, [distributorSearchQuery, hqOrgId])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (distributorSearchRef.current && !distributorSearchRef.current.contains(event.target as Node)) {
        setIsDistributorDropdownOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [])

  const initializeOrder = async () => {
    try {
      setLoading(true)

      // Load user's organization details
      const { data: userOrgData, error: userOrgError } = await supabase
        .from('organizations')
        .select('*')
        .eq('id', userProfile.organization_id)
        .single()

      if (userOrgError) throw userOrgError

      // Set SELLER as current organization (Warehouse/HQ)
      setSellerOrg(userOrgData)
      setBuyerOrg(null)

      const resolvedHqOrgId = resolveSellerHqId(userOrgData)
      if (!resolvedHqOrgId) {
        toast({
          title: 'Configuration Error',
          description: 'Your organization is not linked to a parent HQ. Please contact administrator.',
          variant: 'destructive'
        })
        return
      }

      setHqOrgId(resolvedHqOrgId)

      const [{ data: hqData, error: hqError }, { data: warehouseRows, error: warehouseError }] = await Promise.all([
        supabase
          .from('organizations')
          .select('id, default_warehouse_org_id')
          .eq('id', resolvedHqOrgId)
          .single(),
        supabase
          .from('organizations')
          .select('id, org_name, org_code, org_type_code, parent_org_id, is_active')
          .eq('parent_org_id', resolvedHqOrgId)
          .eq('org_type_code', 'WH')
          .eq('is_active', true)
          .order('org_name', { ascending: true }),
      ])
      if (hqError) throw hqError
      if (warehouseError) throw warehouseError

      const eligibleWarehouses = filterEligibleHqFulfillmentWarehouses(
        (warehouseRows || []) as HqFulfillmentWarehouse[],
        resolvedHqOrgId,
      )
      setFulfillmentWarehouses(eligibleWarehouses)

      const defaultResolution = resolveDefaultFulfillmentWarehouseId(
        hqData?.default_warehouse_org_id,
        eligibleWarehouses,
      )
      setDefaultFulfillmentMissing(defaultResolution.defaultMissingOrInvalid)
      setFulfillmentWarehouseId(defaultResolution.warehouseId || '')

      // Load available distributors (children of HQ)
      await loadDistributors(resolvedHqOrgId)

    } catch (error: any) {
      console.error('Error initializing order:', error)
      toast({
        title: 'Error',
        description: error.message || 'Failed to initialize order',
        variant: 'destructive'
      })
    } finally {
      setLoading(false)
    }
  }

  const loadDistributors = async (hqOrgId: string, inventoryOrgId?: string, search?: string) => {
    try {
      // Load all distributor organizations under the HQ
      let query = supabase
        .from('organizations')
        .select('*')
        .eq('parent_org_id', hqOrgId)
        .eq('org_type_code', 'DIST')
        .eq('is_active', true)
        .order('org_name')

      if (search && search.length >= 2) {
        query = query.ilike('org_name', `%${search}%`)
      } else {
        query = query.limit(50)
      }

      const { data, error } = await query

      if (error) throw error

      setAvailableDistributors(data || [])

      if (data && data.length === 0 && !toastShownRef.current && !search) {
        toastShownRef.current = true
        toast({
          title: 'No Distributors Found',
          description: 'No active distributors found under HQ. Please contact administrator.',
          variant: 'destructive'
        })
      }
    } catch (error: any) {
      console.error('Error loading distributors:', error)
      toast({
        title: 'Error',
        description: 'Failed to load distributors',
        variant: 'destructive'
      })
    }
  }

  const refreshAvailabilityForSelection = async (
    distributorId: string,
    warehouseId: string,
  ) => {
    if (!distributorId || !warehouseId) {
      setAvailableVariants([])
      setQuickOrderVariants([])
      return
    }
    await Promise.all([
      loadAvailableProducts(distributorId, warehouseId),
      loadQuickOrderCatalog(distributorId, warehouseId),
    ])
  }

  const handleDistributorChange = async (distributorId: string) => {
    setSelectedDistributorId(distributorId)

    const distributor = availableDistributors.find(d => d.id === distributorId)
    if (!distributor) return

    setBuyerOrg(distributor)

    // Update customer information with distributor details
    setCustomerName(distributor.contact_name || distributor.org_name)
    setPhoneNumber(distributor.contact_phone || '')

    // Combine address and address_line2 for delivery address
    const fullAddress = [
      distributor.address,
      distributor.address_line2
    ].filter(Boolean).join(', ')

    setDeliveryAddress(fullAddress || '')
    await refreshAvailabilityForSelection(distributorId, fulfillmentWarehouseId)
  }

  const handleFulfillmentWarehouseChange = async (warehouseId: string) => {
    setFulfillmentWarehouseId(warehouseId)
    if (!selectedDistributorId) return
    await refreshAvailabilityForSelection(selectedDistributorId, warehouseId)
    toast({
      title: 'Fulfillment warehouse updated',
      description: 'Available quantities were refreshed for the selected warehouse.',
    })
  }

  const loadQuickOrderCatalog = async (distributorId: string, warehouseId: string) => {
    const response = await fetch('/api/orders/d2h/quick-order-catalog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ distributorId, fulfillmentWarehouseId: warehouseId }),
    })
    const result = await response.json().catch(() => null)
    if (!response.ok) {
      setQuickOrderVariants([])
      toast({
        title: 'Quick Order Catalog Unavailable',
        description: result?.error || 'Unable to load the distributor Quick Order catalog.',
        variant: 'destructive',
      })
      return
    }
    setQuickOrderVariants(result.variants || [])

    const availability = new Map<string, ProductVariant>(
      (result.variants || []).map((variant: ProductVariant) => [variant.id, variant]),
    )
    const insufficient = orderItems.filter((item) => {
      const variant = availability.get(item.variant_id)
      return !variant || (
        variant.inventory_classification !== 'unclassified' && item.qty > variant.available_qty
      )
    })
    if (insufficient.length > 0) {
      toast({
        title: 'Insufficient stock at selected warehouse',
        description: `${insufficient.length} selected item(s) exceed available stock at ${result.fulfillmentWarehouseName || 'the selected warehouse'}. Adjust quantities before submitting.`,
        variant: 'destructive',
      })
    }
  }

  const loadAvailableProducts = async (distributorId: string, inventoryOrgId: string) => {
    if (!distributorId) return

    try {
      const response = await fetch('/api/orders/d2h/standard-order-catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ distributorId, fulfillmentWarehouseId: inventoryOrgId }),
      })
      const result = await response.json().catch(() => null)
      if (!response.ok) throw new Error(result?.error || 'Unable to load the distributor Standard Order catalog.')

      const variantsWithInventory = (result?.variants || []) as ProductVariant[]

      setAvailableVariants(variantsWithInventory)
      setSelectedVariantId('')
      setSelectedProductFilter('')

      if (variantsWithInventory.length === 0) {
        toast({
          title: 'No Products Available',
          description: 'No products with available inventory found in Warehouse. Please ensure products are in stock.',
          variant: 'destructive'
        })
      }
    } catch (error: any) {
      console.error('Error loading products:', error)
      setAvailableVariants([])
      toast({
        title: 'Error',
        description: error.message || 'Failed to load available products',
        variant: 'destructive'
      })
    }
  }

  const handleBack = () => {
    if (onViewChange) {
      onViewChange('distributor-order')
    }
  }

  const handleAddProduct = () => {
    if (!selectedVariantId) {
      toast({
        title: 'Validation Error',
        description: 'Please select a product variant',
        variant: 'destructive'
      })
      return
    }

    const variant = availableVariants.find(v => v.id === selectedVariantId)
    if (!variant) return

    // Check if price is maintained
    if (!variant.distributor_price || variant.distributor_price <= 0) {
      toast({
        title: 'Price Not Maintained',
        description: 'Please maintain the distributor price for this product first.',
        variant: 'destructive'
      })
      return
    }

    // Check if variant already added
    if (orderItems.find(item => item.variant_id === selectedVariantId)) {
      toast({
        title: 'Product Already Added',
        description: 'This product variant is already in the order',
        variant: 'destructive'
      })
      return
    }

    // Add product variant with distributor price
    const newItem: OrderItem = {
      id: `temp-${Date.now()}`,
      order_id: '',
      product_id: variant.product_id,
      variant_id: variant.id,
      product_name: variant.product_name,
      variant_name: variant.variant_name,
      attributes: variant.attributes,
      manufacturer_sku: variant.manufacturer_sku,
      qty: 1,
      unit_price: variant.distributor_price,
      line_total: variant.distributor_price
    }

    setOrderItems([...orderItems, newItem])
    setSelectedVariantId('')
    setProductSearchQuery('')

    toast({
      title: 'Product Added',
      description: `${variant.product_name} - ${variant.variant_name} added to order`
    })
  }

  const handleRemoveProduct = (variantId: string) => {
    setOrderItems(orderItems.filter(item => item.variant_id !== variantId))
    toast({
      title: 'Product Removed',
      description: 'Product removed from order'
    })
  }

  const handleUpdateQty = (variantId: string, newQty: number) => {
    const variant = availableVariants.find(v => v.id === variantId)
    if (!variant) return

    // Validate against available inventory
    if (newQty > variant.available_qty) {
      toast({
        title: 'Insufficient Stock',
        description: `Only ${variant.available_qty} cases available in inventory${reservedStockNote(variant)}`,
        variant: 'destructive'
      })
      return
    }

    setOrderItems(orderItems.map(item =>
      item.variant_id === variantId
        ? {
          ...item,
          qty: Math.max(1, newQty),
          line_total: Math.max(1, newQty) * item.unit_price
        }
        : item
    ))
  }

  const handleQuickQuantityChange = (variantId: string, requestedQty: number) => {
    const variant = quickOrderVariants.find(candidate => candidate.id === variantId)
    if (!variant) return

    const newQty = Math.max(0, Math.trunc(requestedQty))
    if (variant.pricing_status === 'price_missing') {
      toast({
        title: 'Distributor Price Not Set',
        description: `${variant.variant_name} has no Distributor Price. Set it in Product Management > Variants before ordering.`,
        variant: 'destructive'
      })
      return
    }
    if (variant.inventory_classification !== 'unclassified' && newQty > variant.available_qty) {
      toast({
        title: 'Insufficient Stock',
        description: `Only ${variant.available_qty} cases of ${variant.variant_name} are available${reservedStockNote(variant)}`,
        variant: 'destructive'
      })
      return
    }

    setOrderItems(currentItems => {
      const existing = currentItems.find(item => item.variant_id === variantId)
      if (newQty === 0) return currentItems.filter(item => item.variant_id !== variantId)
      if (existing) {
        return currentItems.map(item => item.variant_id === variantId
          ? { ...item, qty: newQty, unit_price: variant.distributor_price, line_total: newQty * variant.distributor_price }
          : item)
      }
      return [...currentItems, {
        id: `temp-${variantId}`,
        order_id: '',
        product_id: variant.product_id,
        variant_id: variant.id,
        product_name: variant.product_name,
        variant_name: variant.variant_name,
        attributes: variant.attributes,
        manufacturer_sku: variant.manufacturer_sku,
        qty: newQty,
        unit_price: variant.distributor_price,
        line_total: newQty * variant.distributor_price
      }]
    })
  }

  const handleOrderModeSwitch = () => {
    if (orderMode === 'quick') {
      setOrderMode('standard')
      return
    }

    const quickVariantsById = new Map(quickOrderVariants.map(variant => [variant.id, variant]))
    const itemsOutsideQuickCatalog = orderItems.filter(item => {
      const variant = quickVariantsById.get(item.variant_id)
      return !variant || variant.pricing_status === 'price_missing' || item.qty > variant.available_qty
    })
    if (itemsOutsideQuickCatalog.length > 0) {
      const shouldClear = window.confirm(
        `${itemsOutsideQuickCatalog.length} selected item(s) are not available in the distributor Quick Order catalog and must be cleared before switching. Continue?`
      )
      if (!shouldClear) return
    }
    setOrderItems(items => items.flatMap(item => {
      const variant = quickVariantsById.get(item.variant_id)
      if (!variant || variant.pricing_status === 'price_missing' || item.qty > variant.available_qty) return []
      return [{ ...item, unit_price: variant.distributor_price, line_total: item.qty * variant.distributor_price }]
    }))
    setOrderMode('quick')
  }

  const handleUpdatePrice = (variantId: string, newPrice: number) => {
    setOrderItems(orderItems.map(item =>
      item.variant_id === variantId
        ? {
          ...item,
          unit_price: newPrice,
          line_total: item.qty * newPrice
        }
        : item
    ))
  }

  const saveOrder = async () => {
    if (submitLockRef.current || saving) return

    try {
      setSaving(true)
      submitLockRef.current = true

      // Validation
      if (!selectedDistributorId) {
        toast({
          title: 'Validation Error',
          description: 'Please select a distributor',
          variant: 'destructive'
        })
        return
      }

      if (paymentTermChanged && paymentTermReason.trim().length < 5) {
        toast({
          title: 'Reason required',
          description: 'Enter why this order uses a different payment term (at least 5 characters).',
          variant: 'destructive'
        })
        return
      }

      if (!fulfillmentWarehouseId) {
        toast({
          title: 'Validation Error',
          description: defaultFulfillmentMissing
            ? MISSING_DEFAULT_FULFILLMENT_WAREHOUSE_MESSAGE
            : 'Please select a fulfillment warehouse',
          variant: 'destructive'
        })
        return
      }

      if (!sellerOrg || !buyerOrg) {
        toast({
          title: 'Validation Error',
          description: 'Missing organization information',
          variant: 'destructive'
        })
        return
      }

      if (!customerName || !deliveryAddress) {
        toast({
          title: 'Validation Error',
          description: 'Customer name and delivery address are required',
          variant: 'destructive'
        })
        return
      }

      // An untouched default follows the Malaysia calendar even if the page was
      // left open past midnight; a chosen date is validated as chosen.
      const orderDateCheck = validateOrderDate(orderDateTouched ? orderDate : malaysiaToday())
      if (!orderDateCheck.ok) {
        toast({
          title: 'Validation Error',
          description: orderDateCheck.error,
          variant: 'destructive'
        })
        return
      }
      const soDate = orderDateCheck.orderDate

      const positiveOrderItems = orderItems.filter(item => item.qty > 0)
      if (positiveOrderItems.length === 0) {
        toast({
          title: 'Validation Error',
          description: 'Please add at least one product to the order',
          variant: 'destructive'
        })
        return
      }

      // Re-read authoritative active variants, distributor prices, and warehouse
      // availability on the server immediately before the atomic D2H submit RPC.
      const preflightResponse = await fetch('/api/orders/d2h/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: orderMode,
          distributorId: selectedDistributorId,
          fulfillmentWarehouseId,
          items: positiveOrderItems.map(item => ({ variantId: item.variant_id, quantity: item.qty }))
        })
      })
      const preflight = await preflightResponse.json().catch(() => null)
      if (!preflightResponse.ok) {
        throw new Error(preflight?.error || 'Stock and price validation failed. Please review the order and try again.')
      }
      const authoritativeItems = new Map<string, { distributorPrice: number }>(
        preflight.items.map((item: { variantId: string; distributorPrice: number }) => [item.variantId, item])
      )

      // Get company_id
      const { data: companyData } = await supabase
        .rpc('get_company_id', { p_org_id: userProfile.organization_id })

      const companyId = companyData || userProfile.organization_id
      const idempotencyKey = typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `d2h-${Date.now()}-${Math.random().toString(36).slice(2)}`

      const submitArgs = {
        p_company_id: companyId,
        p_buyer_org_id: buyerOrg.id,
        p_seller_org_id: sellerOrg.id,
        p_fulfillment_warehouse_id: fulfillmentWarehouseId,
        p_items: positiveOrderItems.map(item => ({
          product_id: item.product_id,
          variant_id: item.variant_id,
          qty: item.qty,
          unit_price: authoritativeItems.get(item.variant_id)!.distributorPrice,
        })),
        p_notes: `Customer: ${customerName}, Phone: ${phoneNumber}, Address: ${deliveryAddress}`,
        p_created_by: userProfile.id,
        p_idempotency_key: idempotencyKey,
      }
      let { data: order, error: submitError } = await (supabase as any).rpc('submit_and_allocate_d2h_order', {
        ...submitArgs,
        p_order_date: soDate,
      })

      if (submitError && isMissingOrderDateRpcParameter(submitError)) {
        // The database has not had the SO Date migration applied yet. A
        // today-dated SO is exactly what the previous RPC creates, so it is
        // submitted through it; a backdated SO cannot be honoured and is refused
        // rather than silently created with today's date.
        if (!orderDateCheck.isBackdated) {
          console.warn(`submit_and_allocate_d2h_order has no p_order_date yet — apply ${D2H_ORDER_DATE_RPC_MIGRATION}.`)
          ;({ data: order, error: submitError } = await (supabase as any).rpc('submit_and_allocate_d2h_order', submitArgs))
        } else {
          throw new Error(
            `Backdated SO Date is not available yet: database migration ${D2H_ORDER_DATE_RPC_MIGRATION} has not been applied. `
            + 'Set SO Date to today or ask an administrator to apply the migration.'
          )
        }
      }

      if (submitError) {
        console.error('Error submitting D2H order:', submitError)
        throw new Error(submitError.message || 'Failed to submit and allocate the order')
      }

      // Notification queueing is handled by the trigger_order_notification()
      // DB trigger, which fires automatically on the status UPDATE inside
      // submit_and_allocate_d2h_order(). The explicit /api/notifications/order-event
      // call that used to be here was queueing a second, duplicate notification.

      // Fire-and-forget: trigger notification worker to send WhatsApp/SMS/Email immediately
      fetch('/api/cron/notification-outbox-worker').catch(() => { })

      console.log('✅ Order submitted and inventory allocated:', order.order_no)

      // A term other than the distributor's: same change as in Order Documents (logged).
      if (paymentTermChanged && order?.id) {
        const { error: termError } = await (supabase as any).rpc('order_change_payment_term', {
          p_order_id: order.id,
          p_term_id: paymentTermId,
          p_reason: paymentTermReason.trim(),
        })
        if (termError) {
          toast({
            title: 'Order saved, payment term not changed',
            description: `${paymentTermChangeErrorMessage(termError)} You can change it in Order Documents.`,
            variant: 'destructive'
          })
        }
      }

      toast({
        title: 'Success',
        description: `Order created from ${selectedFulfillmentWarehouse?.org_name || 'selected warehouse'} and inventory allocated. Awaiting approval.`,
      })

      // Navigate back to orders list
      if (onViewChange) {
        onViewChange('orders')
      }

    } catch (error: any) {
      console.error('Error saving order:', error)
      toast({
        title: 'Error',
        description: error.message || 'Failed to save order',
        variant: 'destructive'
      })
    } finally {
      setSaving(false)
      submitLockRef.current = false
    }
  }

  const todayMyt = malaysiaToday()
  // What is shown is what is submitted: an untouched default is always today.
  const effectiveOrderDate = orderDateTouched ? orderDate : todayMyt
  const orderDateValidation = validateOrderDate(effectiveOrderDate)
  const orderDateInvalid = orderDateValidation.ok ? null : orderDateValidation.error
  const orderDateBackdated = orderDateValidation.ok && orderDateValidation.isBackdated

  const calculateTotals = () => {
    const subtotal = orderItems.reduce((sum, item) => sum + (item.qty * item.unit_price), 0)
    const tax = 0
    const total = subtotal + tax

    return { subtotal, tax, total }
  }

  const totals = calculateTotals()

  // Filter variants based on search and product filter
  const filteredVariants = availableVariants.filter(variant => {
    const matchesSearch = !productSearchQuery ||
      variant.variant_name.toLowerCase().includes(productSearchQuery.toLowerCase()) ||
      variant.product_name.toLowerCase().includes(productSearchQuery.toLowerCase()) ||
      variant.manufacturer_sku?.toLowerCase().includes(productSearchQuery.toLowerCase())

    const matchesProductFilter = !selectedProductFilter ||
      variant.product_name === selectedProductFilter

    // Exclude already selected variants
    const isAlreadySelected = orderItems.some(item => item.variant_id === variant.id)

    return matchesSearch && matchesProductFilter && !isAlreadySelected && variant.available_qty > 0
  })

  const standardAvailableVariants = availableVariants.filter(variant => variant.available_qty > 0)

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-[var(--sera-orange)]" />
      </div>
    )
  }

  return (
    <div className="sera-sc-page space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleBack}
            className="gap-2 -ml-2"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </Button>
        </div>
        <h2 className="text-xl font-bold text-gray-900">Order to HQ (D2H)</h2>
        <p className="text-[var(--sera-muted)] text-xs mt-1">Create a D2H order to headquarters using distributor pricing</p>
      </div>

      {/* Main Layout - Two Columns */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column - Forms */}
        <div className="lg:col-span-2 space-y-6">

          {/* Distributor Selection */}
          <Card>
            <CardHeader className="border-b bg-gray-50">
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <Building2 className="w-4 h-4" />
                Select Distributor
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <div>
                <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">
                  Distributor <span className="text-red-500">*</span>
                </label>
                <div className="relative" ref={distributorSearchRef}>
                  <Input
                    value={selectedDistributorId ? (availableDistributors.find(d => d.id === selectedDistributorId)?.org_name || distributorSearchQuery) : distributorSearchQuery}
                    onChange={(e) => {
                      setDistributorSearchQuery(e.target.value)
                      if (selectedDistributorId) {
                        setSelectedDistributorId('')
                        setBuyerOrg(null)
                      }
                      setIsDistributorDropdownOpen(true)
                    }}
                    onFocus={() => setIsDistributorDropdownOpen(true)}
                    placeholder="Search distributor (min 2 chars)..."
                    className="w-full"
                  />
                  {isDistributorDropdownOpen && (
                    <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-md shadow-lg max-h-60 overflow-auto">
                      {availableDistributors.length === 0 ? (
                        <div className="p-2 text-sm text-[var(--sera-muted)]">No distributors found</div>
                      ) : (
                        availableDistributors.map((dist) => (
                          <div
                            key={dist.id}
                            className="px-3 py-2 text-sm hover:bg-gray-100 cursor-pointer"
                            onClick={() => {
                              handleDistributorChange(dist.id)
                              setDistributorSearchQuery(dist.org_name)
                              setIsDistributorDropdownOpen(false)
                            }}
                          >
                            {dist.org_name} ({dist.org_code})
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
                {!selectedDistributorId && availableDistributors.length > 0 && (
                  <p className="text-xs text-amber-600 mt-2">
                    ⚠️ Please select a distributor to view available products
                  </p>
                )}
              </div>

              <div className="mt-6">
                <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">
                  Fulfillment Warehouse <span className="text-red-500">*</span>
                </label>
                <select
                  value={fulfillmentWarehouseId}
                  onChange={(e) => handleFulfillmentWarehouseChange(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)] bg-white"
                  disabled={fulfillmentWarehouses.length === 0}
                >
                  <option value="">Select warehouse...</option>
                  {fulfillmentWarehouses.map((warehouse) => (
                    <option key={warehouse.id} value={warehouse.id}>
                      {warehouse.org_name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mt-6">
                <label htmlFor="d2h-so-date" className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">
                  SO Date <span className="text-red-500">*</span>
                </label>
                <Input
                  id="d2h-so-date"
                  type="date"
                  value={effectiveOrderDate}
                  max={todayMyt}
                  required
                  onChange={(e) => {
                    setOrderDate(e.target.value)
                    setOrderDateTouched(true)
                  }}
                  className="w-full sm:w-56"
                  aria-describedby="d2h-so-date-hint"
                />
                <div id="d2h-so-date-hint" className="mt-1.5 flex flex-wrap items-center gap-2">
                  {orderDateInvalid ? (
                    <p className="text-xs text-red-600">{orderDateInvalid}</p>
                  ) : orderDateBackdated ? (
                    <span className="inline-flex items-center rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">
                      Backdated SO
                    </span>
                  ) : null}
                </div>
              </div>

              <div>
                <p className="text-xs text-[var(--sera-muted)] mt-2">
                  Stock for this order will be allocated and fulfilled from this warehouse.
                </p>
                {defaultFulfillmentMissing && !fulfillmentWarehouseId && (
                  <p className="text-xs text-amber-600 mt-2">
                    {MISSING_DEFAULT_FULFILLMENT_WAREHOUSE_MESSAGE}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Customer Information */}
          <Card>
            <CardHeader className="border-b bg-gray-50">
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <User className="w-4 h-4" />
                Customer Information
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              {selectedDistributorId && (
                <>
                  <div className="mb-4 p-3 bg-[var(--sera-orange)]/[0.06] border border-[var(--sera-orange)]/20 rounded-md">
                    <p className="text-xs text-blue-700">
                      ℹ️ Customer information is automatically filled from the selected distributor's profile
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-4 mb-4">
                    <div>
                      <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">
                        Customer Name <span className="text-red-500">*</span>
                      </label>
                      <Input
                        value={customerName}
                        onChange={(e) => setCustomerName(e.target.value)}
                        placeholder="Customer name"
                        className="bg-gray-100"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">
                        Phone Number
                      </label>
                      <Input
                        value={phoneNumber}
                        onChange={(e) => setPhoneNumber(e.target.value)}
                        placeholder="Phone number"
                        className="bg-gray-100"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">
                      Delivery Address <span className="text-red-500">*</span>
                    </label>
                    <textarea
                      value={deliveryAddress}
                      onChange={(e) => setDeliveryAddress(e.target.value)}
                      placeholder="Delivery address"
                      rows={3}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)] bg-gray-100"
                    />
                  </div>
                </>
              )}
              {!selectedDistributorId && (
                <div className="text-center py-8 text-[var(--sera-muted)]">
                  <p>Please select a distributor first</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Payment Terms */}
          {selectedDistributorId && paymentTermOptions.length > 0 && (
            <Card>
              <CardHeader className="border-b bg-gray-50">
                <CardTitle className="flex items-center gap-2 text-base font-semibold">
                  <ShoppingCart className="w-4 h-4" />
                  Payment Terms
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-6 space-y-2">
                {canChangePaymentTerm ? (
                  <>
                    <label htmlFor="d2h-payment-term" className="block text-sm font-medium">
                      Payment terms for this order
                    </label>
                    <select
                      id="d2h-payment-term"
                      value={paymentTermId}
                      onChange={(e) => setPaymentTermId(e.target.value)}
                      className="w-full px-3 py-2 border rounded-md text-sm"
                    >
                      {paymentTermOptions.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.term_name}{t.id === masterTermId ? ' (distributor default)' : ''}
                        </option>
                      ))}
                    </select>
                  </>
                ) : (
                  <p className="text-sm font-medium">
                    {paymentTermOptions.find((t) => t.id === paymentTermId)?.term_name}
                  </p>
                )}
                {(() => {
                  const t = paymentTermOptions.find((x) => x.id === paymentTermId)
                  const total = orderItems.reduce((s, i: any) => s + (Number(i.line_total) || Number(i.qty) * Number(i.unit_price) || 0), 0)
                  if (!t) return null
                  const s = orderTermsSummary({ deposit_pct: t.deposit_percentage, balance_pct: t.balance_percentage, term_name: t.term_name }, total)
                  return (
                    <p className="text-sm text-[var(--sera-muted)]">
                      {s.kind === 'split'
                        ? `Expected: RM ${s.depositAmount.toFixed(2)} (${s.depositPercentage}%) first, then RM ${s.balanceAmount.toFixed(2)} (${s.balancePercentage}%).`
                        : `Expected: RM ${total.toFixed(2)} (100%) in one payment.`}
                    </p>
                  )
                })()}
                {paymentTermChanged && (
                  <div className="space-y-1">
                    <label htmlFor="d2h-payment-term-reason" className="block text-sm font-medium">
                      Reason for a different payment term <span className="text-red-500">*</span>
                    </label>
                    <textarea
                      id="d2h-payment-term-reason"
                      value={paymentTermReason}
                      onChange={(e) => setPaymentTermReason(e.target.value)}
                      rows={2}
                      maxLength={500}
                      placeholder="Why not the distributor default?"
                      className="w-full px-3 py-2 border rounded-md text-sm"
                    />
                  </div>
                )}
                <p className="text-xs text-[var(--sera-muted)]">
                  Defaults to the distributor&apos;s master data. HQ Admin can change it until the invoice is issued; changes are logged and shown in Order Documents.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Product Selection */}
          <Card>
            <CardHeader className="border-b bg-gray-50">
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <Package className="w-4 h-4" />
                Product Selection
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              {!selectedDistributorId || !fulfillmentWarehouseId ? (
                <div className="text-center py-12 text-[var(--sera-muted)]">
                  <Package className="w-12 h-12 mx-auto mb-3 text-gray-400" />
                  <p className="text-lg font-medium mb-1">
                    {!selectedDistributorId ? 'No Distributor Selected' : 'No Fulfillment Warehouse Selected'}
                  </p>
                  <p className="text-sm">
                    {!selectedDistributorId
                      ? 'Please select a distributor above to view available products'
                      : 'Please select a fulfillment warehouse above to view available products'}
                  </p>
                </div>
              ) : (
                <>
                  <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h4 className="text-lg font-semibold text-gray-900">{orderMode === 'quick' ? 'Quick Order' : 'Standard Order'}</h4>
                      <p className="text-xs text-[var(--sera-muted)]">{orderMode === 'quick' ? 'Add multiple products at once' : 'Add and edit products one at a time'}</p>
                    </div>
                    {/* The other mode is a plain, labelled button rather than a sentence with a link. */}
                    <Button type="button" variant="outline" onClick={handleOrderModeSwitch}
                      className="border-[var(--sera-orange)] text-[var(--sera-orange)] hover:bg-[var(--sera-orange)]/[0.08] hover:text-[var(--sera-orange)]">
                      {orderMode === 'quick' ? 'Standard order' : 'Quick Order'}
                    </Button>
                  </div>
                  {orderMode === 'quick' ? (
                    <QuickOrderGrid
                      variants={quickOrderVariants}
                      items={orderItems}
                      formatCurrency={formatCurrency}
                      onQuantityChange={handleQuickQuantityChange}
                      onClear={() => setOrderItems([])}
                    />
                  ) : (
                    <>
                  {/* Search and Filter */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    <div>
                      <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">
                        Search Variant
                      </label>
                      <Input
                        value={productSearchQuery}
                        onChange={(e) => setProductSearchQuery(e.target.value)}
                        placeholder="Search by variant name or SKU..."
                        className="bg-gray-50"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">
                        Filter by Product
                      </label>
                      <select
                        value={selectedProductFilter}
                        onChange={(e) => setSelectedProductFilter(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)] bg-white"
                      >
                        <option value="">All Products ({Array.from(new Set(standardAvailableVariants.map(v => v.product_name))).length})</option>
                        {Array.from(new Set(standardAvailableVariants.map(v => v.product_name))).sort().map(productName => (
                          <option key={productName} value={productName}>
                            {productName} ({standardAvailableVariants.filter(v => v.product_name === productName).length})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Variant Selection */}
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">
                      Select Variant ({filteredVariants.length} available)
                    </label>
                    <select
                      value={selectedVariantId}
                      onChange={(e) => setSelectedVariantId(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)] bg-white"
                      disabled={filteredVariants.length === 0}
                    >
                      <option value="">Choose variant...</option>
                      {filteredVariants.map((variant) => (
                        <option key={variant.id} value={variant.id}>
                          {variant.product_name} - {variant.variant_name} | SKU: {variant.manufacturer_sku || 'N/A'} |
                          Price: RM {formatCurrency(variant.distributor_price)} |
                          Stock: {variant.available_qty}
                        </option>
                      ))}
                    </select>
                  </div>

                  <Button
                    onClick={handleAddProduct}
                    disabled={!selectedVariantId}
                    className="w-full"
                  >
                    Add Product
                  </Button>

                  {/* Order Items List */}
                  {orderItems.length > 0 && (
                    <div className="mt-6 space-y-4">
                      <h4 className="font-semibold text-gray-900">Selected Products ({orderItems.length})</h4>
                      {orderItems.map((item) => {
                        const variant = availableVariants.find(v => v.id === item.variant_id)
                        return (
                          <div key={item.variant_id} className="border rounded-lg p-4 bg-gray-50">
                            <div className="flex justify-between items-start mb-3">
                              <div className="flex-1">
                                <h5 className="font-medium text-gray-900">{item.product_name}</h5>
                                <p className="text-sm text-[var(--sera-muted)]">{item.variant_name}</p>
                                {item.manufacturer_sku && (
                                  <p className="text-xs text-[var(--sera-muted)] mt-1">SKU: {item.manufacturer_sku}</p>
                                )}
                                {variant && (
                                  <p className="text-xs text-[var(--sera-orange)] mt-1">
                                    Available: {variant.available_qty} cases
                                    {(variant.reserved_qty || 0) > 0 && (
                                      <span className="text-[var(--sera-muted)]">
                                        {' '}({(variant.on_hand_qty ?? variant.available_qty + (variant.reserved_qty || 0)).toLocaleString()} on hand,{' '}
                                        {(variant.reserved_qty || 0).toLocaleString()} reserved by submitted orders)
                                      </span>
                                    )}
                                  </p>
                                )}
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleRemoveProduct(item.variant_id)}
                                className="text-red-600 hover:text-red-700 hover:bg-red-50"
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>

                            <div className="grid grid-cols-3 gap-3">
                              <div>
                                <label className="block text-xs font-medium text-[var(--sera-ink)]/80 mb-1">
                                  Quantity
                                </label>
                                <Input
                                  type="number"
                                  value={item.qty}
                                  onChange={(e) => handleUpdateQty(item.variant_id, parseInt(e.target.value) || 1)}
                                  min="1"
                                  max={variant?.available_qty}
                                  className="text-sm"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-[var(--sera-ink)]/80 mb-1">
                                  Unit Price (RM)
                                </label>
                                <Input
                                  type="number"
                                  value={item.unit_price}
                                  onChange={(e) => handleUpdatePrice(item.variant_id, parseFloat(e.target.value) || 0)}
                                  min="0"
                                  step="0.01"
                                  className="text-sm"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-medium text-[var(--sera-ink)]/80 mb-1">
                                  Line Total (RM)
                                </label>
                                <div className="text-sm font-semibold text-gray-900 py-2">
                                  {formatCurrency(item.line_total || 0)}
                                </div>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                    </>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Column - Order Summary */}
        <div className="lg:col-span-1">
          <Card className="sticky top-6">
            <CardHeader className="border-b bg-gray-50">
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <ShoppingCart className="w-4 h-4" />
                Order Summary
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              {/* Customer Info */}
              <div className="mb-6">
                <h4 className="text-sm font-semibold text-gray-900 mb-2">Customer</h4>
                <div className="text-sm space-y-1">
                  <p><span className="font-medium">Name:</span> {customerName || 'Not set'}</p>
                  <p><span className="font-medium">Phone:</span> {phoneNumber || 'Not set'}</p>
                  <p className="flex items-start gap-1">
                    <span className="font-medium">📍</span>
                    <span>{deliveryAddress || 'Not set'}</span>
                  </p>
                </div>
              </div>

              <div className="mb-6">
                <h4 className="text-sm font-semibold text-gray-900 mb-2">Fulfillment</h4>
                <p className="text-sm text-[var(--sera-ink)]/80">
                  Fulfilled From: {selectedFulfillmentWarehouse?.org_name || 'Not selected'}
                </p>
                <p className="text-sm text-[var(--sera-ink)]/80 mt-1">
                  SO Date: {formatDateKey(effectiveOrderDate)}
                  {orderDateBackdated && <span className="ml-1.5 text-xs text-amber-700">(backdated)</span>}
                </p>
              </div>

              {/* Order Type */}
              <div className="mb-6">
                <h4 className="text-sm font-semibold text-gray-900 mb-2">Order Type</h4>
                <div className="text-sm">
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                    D2H (Distributor → HQ)
                  </span>
                </div>
              </div>

              {/* Distributor */}
              {selectedDistributorId && (
                <div className="mb-6 pb-6 border-b">
                  <h4 className="text-sm font-semibold text-gray-900 mb-2">Selected Distributor</h4>
                  <div className="text-sm">
                    <p className="font-medium text-[var(--sera-orange)]">
                      {availableDistributors.find(d => d.id === selectedDistributorId)?.org_name}
                    </p>
                  </div>
                </div>
              )}

              {/* Organizations */}
              <div className="mb-6 pb-6 border-b">
                <h4 className="text-sm font-semibold text-gray-900 mb-2">Organizations</h4>
                <div className="text-sm space-y-2">
                  <div>
                    <span className="font-medium">Buyer:</span> {buyerOrg?.org_name || 'Not set'}
                  </div>
                  <div>
                    <span className="font-medium">Seller:</span> {sellerOrg?.org_name || 'Not set'}
                  </div>
                </div>
              </div>

              {/* Products */}
              <div className="mb-6">
                <h4 className="text-sm font-semibold text-gray-900 mb-2">
                  Products ({orderItems.length})
                </h4>
                {orderItems.length === 0 ? (
                  <p className="text-sm text-[var(--sera-muted)]">No products selected</p>
                ) : (
                  <div className="space-y-2">
                    {orderItems.map((item) => (
                      <div key={item.variant_id} className="text-sm">
                        <div className="flex justify-between">
                          <span className="text-[var(--sera-muted)]">{item.variant_name}</span>
                          <span className="font-medium">×{item.qty}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Totals */}
              <div className="space-y-2 mb-6 pb-6 border-b">
                <div className="flex justify-between text-sm">
                  <span className="text-[var(--sera-muted)]">Subtotal:</span>
                  <span className="font-medium">RM {formatCurrency(totals.subtotal)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-[var(--sera-muted)]">Tax:</span>
                  <span className="font-medium">RM {formatCurrency(totals.tax)}</span>
                </div>
                <div className="flex justify-between text-lg font-bold border-t pt-2">
                  <span>Total:</span>
                  <span>RM {formatCurrency(totals.total)}</span>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="space-y-2">
                {(!selectedDistributorId || !sellerOrg || !customerName || !deliveryAddress || orderItems.length === 0) && (
                  <div className="text-xs text-amber-600 bg-amber-50 p-2 rounded border border-amber-200">
                    <strong>Required:</strong>
                    {!selectedDistributorId && ' Select distributor.'}
                    {!sellerOrg && ' HQ organization.'}
                    {!customerName && ' Customer name.'}
                    {!deliveryAddress && ' Delivery address.'}
                    {orderItems.length === 0 && ' At least one product.'}
                  </div>
                )}
                <Button
                  className="w-full bg-[var(--sera-orange)] hover:bg-[var(--sera-orange-deep)] disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={saveOrder}
                  disabled={saving || !selectedDistributorId || !sellerOrg || !customerName || !deliveryAddress || orderItems.length === 0}
                >
                  {saving ? 'Creating Order...' : 'Create Order'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
