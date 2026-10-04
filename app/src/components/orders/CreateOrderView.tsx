'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/use-toast'
import { ArrowLeft, User, Package, CheckSquare, Loader2, Trash2 } from 'lucide-react'
import { canCreateH2MOrder } from '@/modules/supply-chain/h2m-access'
import { DEFAULT_QR_BUFFER_PERCENT, allocateQrBufferCases, qrBufferCases, resolveQrBufferPercent } from '@/lib/orders/qr-buffer'
import { formatOrderExpectedBoxes } from '@/lib/orders/packaging'
import {
  PRODUCT_SEPARATOR,
  variantIdentityLabel,
  variantNameWithProductCodeBullet,
  variantSelectorLabel,
} from '@/lib/inventory/variant-display-label'

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

interface CreateOrderViewProps {
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
}

interface Product {
  id: string
  product_code: string
  product_name: string
  brand_name?: string
  category_name?: string
  manufacturer_id?: string
}

interface ProductVariant {
  id: string
  product_id: string
  product_name: string
  /** Parent products.product_code — identical across every flavour. */
  product_code: string
  /** product_variants.product_code — the Product Code column of Products > Master Data > Variants. */
  variant_product_code?: string | null
  variant_name: string
  attributes?: Record<string, any>
  barcode?: string | null
  manufacturer_sku?: string | null
  base_cost: number
  suggested_retail_price: number
  is_default: boolean
  manufacturer_id?: string
}

interface OrderItem {
  id?: string
  order_id?: string
  product_id: string
  variant_id: string
  product_name: string
  variant_name: string
  /** product_variants.product_code, carried for display only. */
  variant_product_code?: string | null
  attributes?: Record<string, any>
  manufacturer_sku?: string | null
  qty: number
  unit_price: number
  line_total?: number
  company_id?: string
  units_per_case?: number  // Individual units per case for this product (when useIndividualCases is true)
}

interface DistributorOption {
  id: string
  org_name: string
  org_code: string
  is_preferred: boolean
}

// Helper function to format currency with thousand separators
const formatCurrency = (amount: number): string => {
  return amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// Helper function to detect product family from variant data
const getProductFamily = (variant: ProductVariant): string | null => {
  // Check product name first - this covers the main families
  const productName = variant.product_name || ''

  // Cellera families
  if (productName.toLowerCase().includes('cellera hero')) {
    return 'Cellera Hero'
  }
  if (productName.toLowerCase().includes('cellera zero')) {
    return 'Cellera Zero'
  }

  // Ellbow Cat Treat
  if (productName.toLowerCase().includes('ellbow cat treat') ||
    productName.toLowerCase().includes('ellbow')) {
    return 'Ellbow Cat Treat'
  }

  // Serapod Device families (check full product name for these)
  if (productName.toLowerCase().includes('serapod device s.box') ||
    productName.toLowerCase().includes('serapod device s box')) {
    return 'Serapod Device S.Box'
  }
  if (productName.toLowerCase().includes('serapod device s.line') ||
    productName.toLowerCase().includes('serapod device s line')) {
    return 'Serapod Device S.Line'
  }

  // Check subgroup in attributes (if available) - fallback for S.Box/S.Line
  const subgroupName = variant.attributes?.subgroup_name || ''
  if (subgroupName.toLowerCase().includes('s.box') || subgroupName.toLowerCase().includes('s. box')) {
    return 'Serapod Device S.Box'
  }
  if (subgroupName.toLowerCase().includes('s.line') || subgroupName.toLowerCase().includes('s. line')) {
    return 'Serapod Device S.Line'
  }

  return null
}

// Helper function to get default case size for a product family
const getDefaultCaseSize = (family: string): number => {
  switch (family) {
    case 'Cellera Hero':
    case 'Cellera Zero':
      return 100
    case 'Ellbow Cat Treat':
      return 20
    case 'Serapod Device S.Box':
      return 50
    case 'Serapod Device S.Line':
      return 200
    default:
      return 100 // Default fallback
  }
}

export default function CreateOrderView({ userProfile, onViewChange }: CreateOrderViewProps) {
  const { toast } = useToast()
  const supabase = createClient()
  const canCreateH2M = canCreateH2MOrder(userProfile.organizations.org_type_code, userProfile.roles.role_level)

  // Determine order type based on user's organization type
  const [orderType, setOrderType] = useState<'H2M' | 'D2H' | 'S2D'>('H2M')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Track if we're editing an existing order
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null)
  const [editingOrderNo, setEditingOrderNo] = useState<string | null>(null)

  // Organizations
  const [buyerOrg, setBuyerOrg] = useState<Organization | null>(null)
  const [sellerOrg, setSellerOrg] = useState<Organization | null>(null)
  const [availableSellerOrgs, setAvailableSellerOrgs] = useState<Organization[]>([])
  const [selectedSellerOrgId, setSelectedSellerOrgId] = useState('')

  // For S2D: Multiple distributor options
  const [availableDistributors, setAvailableDistributors] = useState<DistributorOption[]>([])
  const [showDistributorSelector, setShowDistributorSelector] = useState(false)

  // Customer Information (derived from organization or custom)
  const [customerName, setCustomerName] = useState('')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [deliveryAddress, setDeliveryAddress] = useState('')

  // Order Configuration
  const [unitsPerCase, setUnitsPerCase] = useState(100)
  const [customUnitsPerCase, setCustomUnitsPerCase] = useState('')
  const [useCustomUnitsPerCase, setUseCustomUnitsPerCase] = useState(false)
  const [useIndividualCases, setUseIndividualCases] = useState(false)  // Toggle for individual case sizes
  const [qrBuffer, setQrBuffer] = useState(DEFAULT_QR_BUFFER_PERCENT)
  const [masterQrDuplicates, setMasterQrDuplicates] = useState(5)  // Number of duplicate Master QR per case (0-10) - default 5
  const [enableRFID, setEnableRFID] = useState(false)
  const [hasPoints, setHasPoints] = useState(true)
  const [enableLuckyDraw, setEnableLuckyDraw] = useState(true)
  const [enableRedeem, setEnableRedeem] = useState(true)
  const [notes, setNotes] = useState('')

  // Manufacturer lock - order can only contain products from one manufacturer
  const [lockedManufacturerId, setLockedManufacturerId] = useState<string | null>(null)

  // Products and Variants
  const [availableVariants, setAvailableVariants] = useState<ProductVariant[]>([])
  const [selectedVariantId, setSelectedVariantId] = useState('')
  const [orderItems, setOrderItems] = useState<OrderItem[]>([])

  // Product filtering and search
  const [productSearchQuery, setProductSearchQuery] = useState('')
  const [selectedProductFilter, setSelectedProductFilter] = useState('')

  useEffect(() => {
    initializeOrder()
    // eslint-disable-next-line react-hooks/exhaustive-deps

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const initializeOrder = async () => {
    try {
      setLoading(true)

      // Check if we're editing an existing order
      const editingOrderId = sessionStorage.getItem('editingOrderId')
      if (editingOrderId) {
        setEditingOrderId(editingOrderId)
        await loadExistingOrder(editingOrderId)
        sessionStorage.removeItem('editingOrderId')
        return
      }

      // Check if we're copying an order
      const copyingOrderData = sessionStorage.getItem('copyingOrderData')
      if (copyingOrderData) {
        await loadCopiedOrder(JSON.parse(copyingOrderData))
        sessionStorage.removeItem('copyingOrderData')
        return
      }

      // Determine order type and buyer based on user's org type
      const userOrgType = userProfile.organizations.org_type_code

      // Fetch user's organization full details
      const { data: userOrgData } = await supabase
        .from('organizations')
        .select('*')
        .eq('id', userProfile.organization_id)
        .single()

      if (!userOrgData) throw new Error('User organization not found')

      // Set order type and buyer based on user's organization
      if (userOrgType === 'HQ') {
        setOrderType('H2M')
        setBuyerOrg(userOrgData)
        // For H2M: Load all active products first, seller will be auto-detected from products
        await loadAvailableProducts('')
      } else if (userOrgType === 'DIST') {
        setOrderType('D2H')
        setBuyerOrg(userOrgData)
        // For D2H: Distributor buys from HQ - auto-select parent org as seller
        if (userOrgData.parent_org_id) {
          const { data: parentOrg } = await supabase
            .from('organizations')
            .select('*')
            .eq('id', userOrgData.parent_org_id)
            .single()

          if (parentOrg) {
            setSellerOrg(parentOrg)
            setSelectedSellerOrgId(parentOrg.id)
            // Auto-load products for HQ
            await loadAvailableProducts(parentOrg.id)
          }
        }
      } else if (userOrgType === 'SHOP') {
        setOrderType('S2D')
        setBuyerOrg(userOrgData)

        console.log('🏪 Shop Order - Auto-filling customer info:', {
          org_name: userOrgData.org_name,
          contact_name: userOrgData.contact_name,
          contact_phone: userOrgData.contact_phone,
          address: userOrgData.address
        })

        // Auto-fill customer information from shop organization
        // For shops, customer = shop itself
        setCustomerName(userOrgData.org_name) // Use shop name as customer name
        setPhoneNumber(userOrgData.contact_phone || '')

        // Combine address and address_line2 for delivery address
        const fullAddress = [
          userOrgData.address,
          userOrgData.address_line2
        ].filter(Boolean).join(', ')

        setDeliveryAddress(fullAddress || '')

        // For S2D: Shop buys from Distributor - load available distributors
        await loadShopDistributors(userOrgData.id)
      }

      // Auto-fill customer information from organization (for HQ and DIST orders)
      if (userOrgType !== 'SHOP') {
        setCustomerName(userOrgData.contact_name || userOrgData.org_name)
        setPhoneNumber(userOrgData.contact_phone || '')

        // Combine address and address_line2 for delivery address
        const fullAddress = [
          userOrgData.address,
          userOrgData.address_line2
        ].filter(Boolean).join(', ')

        setDeliveryAddress(fullAddress || '')
      }

    } catch (error) {
      console.error('Error initializing order:', error)
    } finally {
      setLoading(false)
    }
  }

  const loadSellerOrganizations = async (orgType: string) => {
    try {
      const { data, error } = await supabase
        .from('organizations')
        .select('id, org_name, org_type_code, org_code, address, contact_phone, contact_name')
        .eq('org_type_code', orgType)
        .eq('is_active', true)
        .order('org_name')

      if (error) throw error
      setAvailableSellerOrgs(data || [])
    } catch (error) {
      console.error('Error loading seller organizations:', error)
    }
  }

  const loadShopDistributors = async (shopId: string) => {
    try {
      // Query shop_distributors table to get linked distributors
      const { data, error } = await supabase
        .from('shop_distributors')
        .select(`
          distributor_id,
          is_preferred,
          organizations:distributor_id (
            id,
            org_name,
            org_code
          )
        `)
        .eq('shop_id', shopId)
        .eq('is_active', true)

      if (error) throw error

      const distributors: DistributorOption[] = (data || [])
        .filter(item => item.organizations)
        .map(item => {
          const org: any = Array.isArray(item.organizations)
            ? item.organizations[0]
            : item.organizations
          return {
            id: org.id,
            org_name: org.org_name,
            org_code: org.org_code,
            is_preferred: item.is_preferred || false
          }
        })

      setAvailableDistributors(distributors)

      // For S2D orders, load products first (shops can order any product from distributor)
      // Don't filter by distributor - distributors act as middlemen
      await loadAvailableProducts('')

      // Then auto-select preferred distributor if exists
      const preferred = distributors.find(d => d.is_preferred)
      if (preferred) {
        setSellerOrg({
          id: preferred.id,
          org_name: preferred.org_name,
          org_code: preferred.org_code,
          org_type_code: 'DIST'
        })
        setSelectedSellerOrgId(preferred.id)
        setShowDistributorSelector(distributors.length > 1) // Show selector only if multiple options
      } else if (distributors.length === 1) {
        // If only one distributor, auto-select it
        const single = distributors[0]
        setSellerOrg({
          id: single.id,
          org_name: single.org_name,
          org_code: single.org_code,
          org_type_code: 'DIST'
        })
        setSelectedSellerOrgId(single.id)
        setShowDistributorSelector(false)
      } else if (distributors.length > 1) {
        // Multiple distributors, no preferred - show selector
        setShowDistributorSelector(true)
      } else {
        // No distributors linked
      }
    } catch (error) {
      console.error('Error loading shop distributors:', error)
    }
  }

  const handleDistributorChange = async (distributorId: string) => {
    setSelectedSellerOrgId(distributorId)
    const distributor = availableDistributors.find(d => d.id === distributorId)
    if (distributor) {
      setSellerOrg({
        id: distributor.id,
        org_name: distributor.org_name,
        org_code: distributor.org_code,
        org_type_code: 'DIST'
      })
      // For S2D orders, products are already loaded (not distributor-specific)
      // No need to reload products when changing distributor
    }
  }

  const handleSellerChange = async (sellerId: string) => {
    setSelectedSellerOrgId(sellerId)
    const seller = availableSellerOrgs.find(org => org.id === sellerId)
    if (seller) {
      setSellerOrg(seller)
      // Load products available for this seller
      await loadAvailableProducts(sellerId)
    }
  }

  /**
   * The one reading of "Product Code" shared by the variant picker, the
   * selected-item card and the Order Summary: `product_variants.product_code`,
   * carried on the item and otherwise recovered from the loaded catalog. Never
   * `variant_code`, `manufacturer_sku` or the parent `products.product_code`.
   */
  const resolveVariantProductCode = (item: OrderItem): string | null =>
    item.variant_product_code ||
    availableVariants.find(v => v.id === item.variant_id)?.variant_product_code ||
    null

  const loadAvailableProducts = async (sellerOrgId: string, manufacturerLock?: string | null) => {
    try {
      const effectiveLock = manufacturerLock !== undefined ? manufacturerLock : lockedManufacturerId
      console.log('🔍 Loading product variants - orderType:', orderType, 'sellerOrgId:', sellerOrgId, 'lockedManufacturerId:', lockedManufacturerId, 'effectiveLock:', effectiveLock)

      // Load product variants with product details including subgroups for auto-logic
      let query = supabase
        .from('product_variants')
        .select(`
          id,
          product_id,
          product_code,
          variant_name,
          attributes,
          barcode,
          manufacturer_sku,
          base_cost,
          suggested_retail_price,
          is_active,
          is_default,
          products!inner (
            id,
            product_code,
            product_name,
            manufacturer_id,
            is_active,
            subgroup_id,
            product_subgroups (
              subgroup_name
            )
          )
        `)
        .eq('is_active', true)
        .eq('products.is_active', true)

      // Filter by locked manufacturer if order already has products
      if (effectiveLock) {
        console.log('🔒 Order locked to manufacturer:', effectiveLock)
        query = query.eq('products.manufacturer_id', effectiveLock)
      }
      // Filter by manufacturer ONLY for H2M orders when seller is pre-selected AND not explicitly unlocked
      // When manufacturerLock is explicitly null (reset), skip H2M filter to show all products
      else if (orderType === 'H2M' && sellerOrgId && manufacturerLock === undefined) {
        console.log('🔍 Filtering by manufacturer (H2M pre-selected):', sellerOrgId)
        query = query.eq('products.manufacturer_id', sellerOrgId)
      } else if (orderType === 'S2D') {
        console.log('🔍 S2D order: Loading all active products for shop')
        // No manufacturer filter for S2D - shops can order any product
      } else {
        console.log('🔓 No manufacturer filter applied - showing all products')
      }

      query = query.order('variant_name')

      const { data, error } = await query

      console.log('📦 Variants query result - data:', data, 'error:', error)

      if (error) {
        console.error('❌ Error loading variants:', error)
        throw error
      }

      console.log('📦 Raw variants data (first item):', data?.[0])

      const formattedVariants = data?.map((v: any) => {
        const product = Array.isArray(v.products) ? v.products[0] : v.products
        const subgroup = Array.isArray(product?.product_subgroups) ? product.product_subgroups[0] : product?.product_subgroups

        return {
          id: v.id,
          product_id: v.product_id,
          product_name: product?.product_name || '',
          product_code: product?.product_code || '',
          variant_product_code: v.product_code || null,
          variant_name: v.variant_name,
          attributes: {
            ...(v.attributes || {}),
            subgroup_name: subgroup?.subgroup_name || '' // Add subgroup name to attributes for family detection
          },
          barcode: v.barcode,
          manufacturer_sku: v.manufacturer_sku,
          base_cost: v.base_cost || 0,
          suggested_retail_price: v.suggested_retail_price || 0,
          is_default: v.is_default || false,
          manufacturer_id: product?.manufacturer_id
        }
      }) || []

      console.log('✅ Formatted variants:', formattedVariants)

      setAvailableVariants(formattedVariants)

      if (formattedVariants.length === 0) {
        const errorMessages = {
          'H2M': 'This manufacturer has no active product variants. Please select a different manufacturer.',
          'S2D': 'No active product variants available. Please contact your administrator to ensure products are properly configured.',
          'D2H': 'No active product variants available from HQ. Please contact your administrator.'
        }
      }
    } catch (error) {
      console.error('Error loading product variants:', error)
    }
  }

  const handleBack = () => {
    if (onViewChange) {
      onViewChange('orders')
    }
  }

  const handleSaveAsDraft = async () => {
    await saveOrder('draft')
  }

  const handleCreateOrder = async () => {
    await saveOrder('submitted')
  }

  const handleAddProduct = async () => {
    if (!selectedVariantId) {
      return
    }

    const variant = availableVariants.find(v => v.id === selectedVariantId)
    if (!variant) return

    // Check if variant already added
    if (orderItems.find(item => item.variant_id === selectedVariantId)) {
      return
    }

    // Validate manufacturer - all products in an order must be from the same manufacturer
    if (!variant.manufacturer_id) {
      return
    }

    // Check manufacturer lock
    if (lockedManufacturerId && variant.manufacturer_id !== lockedManufacturerId) {
      // Get manufacturer name for better error message
      const { data: lockedManufacturer } = await supabase
        .from('organizations')
        .select('org_name')
        .eq('id', lockedManufacturerId)
        .single()

      return
    }

    // For H2M orders: Auto-set seller if not already set
    if (orderType === 'H2M' && !sellerOrg && variant.manufacturer_id) {
      try {
        const { data: manufacturer, error } = await supabase
          .from('organizations')
          .select('id, org_name, org_code, org_type_code')
          .eq('id', variant.manufacturer_id)
          .single()

        if (error) throw error

        if (manufacturer) {
          setSellerOrg(manufacturer)
          setSelectedSellerOrgId(manufacturer.id)
          // Silently set manufacturer - no notification needed
        }
      } catch (error) {
        console.error('Error fetching manufacturer:', error)
      }
    }

    // Lock manufacturer on first product
    if (!lockedManufacturerId) {
      console.log('🔒 Locking order to manufacturer:', variant.manufacturer_id)
      setLockedManufacturerId(variant.manufacturer_id)
      // Reload products to filter by locked manufacturer (pass manufacturer_id directly)
      await loadAvailableProducts(sellerOrg?.id || '', variant.manufacturer_id)

      // Show notification about manufacturer lock
      const { data: manufacturer } = await supabase
        .from('organizations')
        .select('org_name')
        .eq('id', variant.manufacturer_id)
        .single()
    }

    // Auto-logic for case size configuration
    const currentFamily = getProductFamily(variant)

    // Determine if we should apply auto-logic
    let shouldAutoSwitch = false
    let autoMessage = ''

    if (orderItems.length === 0) {
      // First product - set case size based on family
      if (currentFamily) {
        const defaultSize = getDefaultCaseSize(currentFamily)
        setUnitsPerCase(defaultSize)
        setUseIndividualCases(false)
        autoMessage = `Cases per box automatically set to ${defaultSize} for ${currentFamily}`
      }
    } else {
      // Check if all existing products are from the same family
      const existingFamilies = new Set(
        orderItems
          .map(item => {
            const itemVariant = availableVariants.find(v => v.id === item.variant_id)
            return itemVariant ? getProductFamily(itemVariant) : null
          })
          .filter(Boolean)
      )

      // Add current family to the set
      if (currentFamily) {
        existingFamilies.add(currentFamily)
      }

      // If we now have mixed families, switch to individual mode
      if (existingFamilies.size > 1 && !useIndividualCases) {
        shouldAutoSwitch = true
        setUseIndividualCases(true)

        // Update all existing items with their family-based defaults
        const updatedItems = orderItems.map(item => {
          const itemVariant = availableVariants.find(v => v.id === item.variant_id)
          if (itemVariant) {
            const itemFamily = getProductFamily(itemVariant)
            const itemDefaultSize = itemFamily ? getDefaultCaseSize(itemFamily) : unitsPerCase
            return { ...item, units_per_case: item.units_per_case || itemDefaultSize }
          }
          return { ...item, units_per_case: item.units_per_case || unitsPerCase }
        })
        setOrderItems(updatedItems)

        autoMessage = 'Switched to Individual cases per box (mixed product families detected)'
      } else if (existingFamilies.size === 1 && !useIndividualCases) {
        // All same family - ensure case size matches
        const family = Array.from(existingFamilies)[0] as string
        const defaultSize = getDefaultCaseSize(family)
        if (unitsPerCase !== defaultSize) {
          setUnitsPerCase(defaultSize)
          autoMessage = `Cases per box adjusted to ${defaultSize} for ${family}`
        }
      }
    }

    // Determine case size for new item
    let itemCaseSize = unitsPerCase
    let itemQty = unitsPerCase

    if (shouldAutoSwitch || useIndividualCases) {
      // In individual mode, use family-specific default
      itemCaseSize = currentFamily ? getDefaultCaseSize(currentFamily) : unitsPerCase
      itemQty = itemCaseSize
    }

    // Add product variant
    const newItem: OrderItem = {
      id: `temp-${Date.now()}`,
      order_id: '',
      product_id: variant.product_id,
      variant_id: variant.id,
      product_name: variant.product_name,
      variant_name: variant.variant_name,
      variant_product_code: variant.variant_product_code || null,
      attributes: variant.attributes,
      manufacturer_sku: variant.manufacturer_sku,
      qty: itemQty,
      unit_price: variant.base_cost,
      line_total: itemQty * variant.base_cost,
      units_per_case: (shouldAutoSwitch || useIndividualCases) ? itemCaseSize : undefined
    }

    setOrderItems([...orderItems, newItem])
    setSelectedVariantId('')
  }

  const handleRemoveProduct = async (variantId: string) => {
    const updatedItems = orderItems.filter(item => item.variant_id !== variantId)
    setOrderItems(updatedItems)

    // Reset manufacturer lock when all products are removed
    if (updatedItems.length === 0) {
      console.log('🔓 Unlocking manufacturer - all products removed')
      setLockedManufacturerId(null)
      // Reload products without manufacturer filter (pass null explicitly)
      await loadAvailableProducts(sellerOrg?.id || '', null)

      return // Exit early to avoid the generic "Product Removed" toast
    }
  }

  const handleUpdateQuantity = (variantId: string, qty: number) => {
    // Simply update the quantity - don't auto-adjust units per case
    // The user can manually adjust units per case if needed
    // Auto-adjusting based on keystroke intermediate values causes bugs
    // (e.g., typing "50000" passes through "50" which was incorrectly triggering case size change)
    setOrderItems(orderItems.map(item =>
      item.variant_id === variantId
        ? { ...item, qty, line_total: qty * item.unit_price }
        : item
    ))
  }

  const handleUpdatePrice = (variantId: string, price: number) => {
    setOrderItems(orderItems.map(item =>
      item.variant_id === variantId
        ? { ...item, unit_price: price, line_total: item.qty * price }
        : item
    ))
  }

  const handleUpdateIndividualUnitsPerCase = (variantId: string, units: number) => {
    setOrderItems(orderItems.map(item =>
      item.variant_id === variantId
        ? { ...item, units_per_case: units }
        : item
    ))
  }

  const handleUnitsPerCaseChange = (newUnitsPerCase: number) => {
    setUnitsPerCase(newUnitsPerCase)
    // Auto-set quantity to match units per case (minimum requirement)
    if (orderItems.length > 0) {
      setOrderItems(orderItems.map(item => {
        return {
          ...item,
          qty: newUnitsPerCase,
          line_total: newUnitsPerCase * item.unit_price
        }
      }))
    }
  }

  const loadExistingOrder = async (orderId: string) => {
    try {
      // Load order data with organizations
      const { data: orderData, error: orderError } = await supabase
        .from('orders')
        .select('*')
        .eq('id', orderId)
        .single()

      if (orderError) {
        console.error('Error loading order:', orderError)
        throw orderError
      }
      if (!orderData) throw new Error('Order not found')

      console.log('📝 Loading order for edit:', orderData)

      // Store the order number for editing
      setEditingOrderNo(orderData.order_no)

      // Load buyer organization
      const { data: buyerOrg } = await supabase
        .from('organizations')
        .select('*')
        .eq('id', orderData.buyer_org_id)
        .single()

      // Load seller organization if exists
      let sellerOrg = null
      if (orderData.seller_org_id) {
        const { data } = await supabase
          .from('organizations')
          .select('*')
          .eq('id', orderData.seller_org_id)
          .single()
        sellerOrg = data
      }

      // Load order items
      const { data: orderItems, error: itemsError } = await supabase
        .from('order_items')
        .select('*')
        .eq('order_id', orderId)

      if (itemsError) {
        console.error('Error loading order items:', itemsError)
        throw itemsError
      }

      console.log('📦 Loaded order items:', orderItems)

      // Load product details for each order item
      const itemsWithDetails = await Promise.all(
        (orderItems || []).map(async (item: any) => {
          // Load product
          const { data: product } = await supabase
            .from('products')
            .select('product_name, product_code')
            .eq('id', item.product_id)
            .single()

          // Load product variant
          const { data: variant } = await supabase
            .from('product_variants')
            .select('variant_name, product_code, attributes, manufacturer_sku')
            .eq('id', item.variant_id)
            .single()

          return {
            ...item,
            products: product,
            product_variants: variant
          }
        })
      )

      console.log('📦 Order items with details:', itemsWithDetails)

      // Cast to any to access custom fields not in generated types
      const orderDataAny = orderData as any

      console.log('📋 Order data for customer info:', {
        customer_name: orderDataAny.customer_name,
        phone_number: orderDataAny.phone_number,
        delivery_address: orderDataAny.delivery_address,
        notes: orderData.notes
      })

      // Set order type
      setOrderType(orderData.order_type)

      // Set buyer and seller organizations
      if (buyerOrg) {
        setBuyerOrg(buyerOrg)
      }
      if (sellerOrg) {
        setSellerOrg(sellerOrg)
        setSelectedSellerOrgId(orderData.seller_org_id)
      }

      // Set customer information
      // If customer info fields are empty, try to extract from notes field
      if (!orderDataAny.customer_name && !orderDataAny.phone_number && !orderDataAny.delivery_address && orderData.notes) {
        // Parse notes field (format: "Customer: Name, Phone: Number, Address: Address")
        const notesText = orderData.notes
        const customerMatch = notesText.match(/Customer:\s*([^,]+)/)
        const phoneMatch = notesText.match(/Phone:\s*([^,]+)/)
        const addressMatch = notesText.match(/Address:\s*(.+)/)

        setCustomerName(customerMatch ? customerMatch[1].trim() : '')
        setPhoneNumber(phoneMatch ? phoneMatch[1].trim() : '')
        setDeliveryAddress(addressMatch ? addressMatch[1].trim() : '')
      } else {
        setCustomerName(orderDataAny.customer_name || '')
        setPhoneNumber(orderDataAny.phone_number || '')
        setDeliveryAddress(orderDataAny.delivery_address || '')
      }

      // Set order configuration
      setUnitsPerCase(orderData.units_per_case || 100)
      setQrBuffer(resolveQrBufferPercent(orderData.qr_buffer_percent))
      setMasterQrDuplicates(orderDataAny.extra_qr_master ?? 5) // Default to 5 if not set
      setEnableRFID(orderDataAny.rfid_enabled || orderData.has_rfid || false)
      setHasPoints(orderData.has_points !== false)
      setEnableLuckyDraw(orderDataAny.enable_lucky_draw !== false || orderData.has_lucky_draw !== false)
      setEnableRedeem(orderDataAny.enable_redeem !== false || orderData.has_redeem !== false)
      setNotes(orderData.notes || '')

      // Check if order uses individual case sizes
      const hasIndividualCases = itemsWithDetails?.some((item: any) => item.units_per_case != null)
      setUseIndividualCases(hasIndividualCases)

      // Map order items to the correct format
      const items: OrderItem[] = (itemsWithDetails || []).map((item: any) => ({
        id: item.id,
        order_id: orderId,
        product_id: item.product_id,
        variant_id: item.variant_id,
        product_name: item.products?.product_name || 'Unknown Product',
        variant_name: item.product_variants?.variant_name || 'Default',
        variant_product_code: item.product_variants?.product_code || null,
        attributes: item.product_variants?.attributes,
        manufacturer_sku: item.product_variants?.manufacturer_sku,
        qty: item.qty,
        unit_price: item.unit_price,
        line_total: item.line_total,
        units_per_case: item.units_per_case
      }))

      setOrderItems(items)

      // Set manufacturer lock if order has items
      if (items.length > 0) {
        const firstVariant = await supabase
          .from('product_variants')
          .select('products!inner(manufacturer_id)')
          .eq('id', items[0].variant_id)
          .single()

        if (firstVariant.data) {
          const manufacturerId = (firstVariant.data.products as any)?.manufacturer_id
          if (manufacturerId) {
            setLockedManufacturerId(manufacturerId)
          }
        }
      }

      // Load available products for the seller
      if (orderData.seller_org_id) {
        await loadAvailableProducts(orderData.seller_org_id)
      }

    } catch (error) {
      console.error('Error loading order:', error)
    } finally {
      setLoading(false)
    }
  }

  const loadCopiedOrder = async (orderData: any) => {
    try {
      console.log('📋 Loading copied order:', orderData)

      // Set order type
      setOrderType(orderData.order_type)

      // Load buyer organization
      const { data: buyerOrg } = await supabase
        .from('organizations')
        .select('*')
        .eq('id', orderData.buyer_org_id)
        .single()

      // Load seller organization if exists
      let sellerOrg = null
      if (orderData.seller_org_id) {
        const { data } = await supabase
          .from('organizations')
          .select('*')
          .eq('id', orderData.seller_org_id)
          .single()
        sellerOrg = data
      }

      // Set buyer and seller organizations
      if (buyerOrg) {
        setBuyerOrg(buyerOrg)
      }
      if (sellerOrg) {
        setSellerOrg(sellerOrg)
        setSelectedSellerOrgId(orderData.seller_org_id)
      }

      // Set customer information from copied order
      const orderDataAny = orderData as any
      if (!orderDataAny.customer_name && !orderDataAny.phone_number && !orderDataAny.delivery_address && orderData.notes) {
        // Parse notes field (format: "Customer: Name, Phone: Number, Address: Address")
        const notesText = orderData.notes
        const customerMatch = notesText.match(/Customer:\s*([^,]+)/)
        const phoneMatch = notesText.match(/Phone:\s*([^,]+)/)
        const addressMatch = notesText.match(/Address:\s*(.+)/)

        setCustomerName(customerMatch ? customerMatch[1].trim() : '')
        setPhoneNumber(phoneMatch ? phoneMatch[1].trim() : '')
        setDeliveryAddress(addressMatch ? addressMatch[1].trim() : '')
      } else {
        setCustomerName(orderDataAny.customer_name || '')
        setPhoneNumber(orderDataAny.phone_number || '')
        setDeliveryAddress(orderDataAny.delivery_address || '')
      }

      // Set order configuration from copied order
      setUnitsPerCase(orderData.units_per_case || 100)
      // A copy is a new order: it takes the current 1% manufacturer buffer
      // rather than carrying over the old 10% default.
      setQrBuffer(DEFAULT_QR_BUFFER_PERCENT)
      setEnableRFID(orderData.rfid_enabled || false)
      setHasPoints(orderData.has_points !== false)
      setEnableLuckyDraw(orderData.enable_lucky_draw !== false)
      setEnableRedeem(orderData.enable_redeem !== false)
      setNotes(orderData.notes || '')

      // Check if order uses individual case sizes
      const hasIndividualCases = orderData.order_items?.some((item: any) => item.units_per_case != null)
      setUseIndividualCases(hasIndividualCases)

      // Map order items to the correct format (without IDs since this is a new order)
      const items: OrderItem[] = (orderData.order_items || []).map((item: any) => ({
        // Don't include id or order_id for copied items
        product_id: item.product_id,
        variant_id: item.variant_id,
        product_name: item.product?.product_name || 'Unknown Product',
        variant_name: item.product_variants?.variant_name || item.variant_name || 'Default',
        variant_product_code: item.product_variants?.product_code || item.variant_product_code || null,
        attributes: item.product_variants?.attributes || item.attributes,
        manufacturer_sku: item.product_variants?.manufacturer_sku || item.manufacturer_sku,
        qty: item.qty,
        unit_price: item.unit_price,
        line_total: item.qty * item.unit_price,
        units_per_case: item.units_per_case
      }))

      setOrderItems(items)

      // Set manufacturer lock if order has items
      if (items.length > 0) {
        const firstVariant = await supabase
          .from('product_variants')
          .select('products!inner(manufacturer_id)')
          .eq('id', items[0].variant_id)
          .single()

        if (firstVariant.data) {
          const manufacturerId = (firstVariant.data.products as any)?.manufacturer_id
          if (manufacturerId) {
            setLockedManufacturerId(manufacturerId)
          }
        }
      }

      // Load available products for the seller
      if (orderData.seller_org_id) {
        await loadAvailableProducts(orderData.seller_org_id)
      }

    } catch (error) {
      console.error('Error loading copied order:', error)
    } finally {
      setLoading(false)
    }
  }

  // Smart packing logic: Calculate how products can be packed into cases
  const calculatePackingPlan = () => {
    const plan = orderItems.map(item => {
      const itemUnitsPerCase = item.units_per_case || unitsPerCase
      const fullCases = Math.floor(item.qty / itemUnitsPerCase)
      const remainder = item.qty % itemUnitsPerCase

      return {
        variantId: item.variant_id,
        productName: item.product_name,
        variantName: item.variant_name,
        qty: item.qty,
        unitsPerCase: itemUnitsPerCase,
        fullCases,
        remainder
      }
    })

    // Get all products with remainders
    const productsWithRemainders = plan.filter(p => p.remainder > 0)

    // Calculate if remainders can be paired into complete cases
    const totalRemainder = productsWithRemainders.reduce((sum, p) => sum + p.remainder, 0)
    const canFormMixedCases = productsWithRemainders.length >= 2

    // Use the same case size from the products for mixed cases
    // Pick the first product's case size as the standard for mixed cases
    let suggestedMixedCaseSize = 0
    let mixedCasesNeeded = 0

    if (canFormMixedCases && totalRemainder > 0) {
      // Use the case size from the first product with remainder
      suggestedMixedCaseSize = productsWithRemainders[0].unitsPerCase
      // Calculate how many mixed cases are needed
      mixedCasesNeeded = Math.ceil(totalRemainder / suggestedMixedCaseSize)
    }

    return {
      plan,
      productsWithRemainders,
      canFormMixedCases,
      totalRemainder,
      suggestedMixedCaseSize,
      mixedCasesNeeded,
      hasIssue: productsWithRemainders.length === 1 // Issue if only one product has remainder
    }
  }

  const saveOrder = async (status: 'draft' | 'submitted') => {
    if (!editingOrderId && orderType === 'H2M' && !canCreateH2M) {
      toast({
        title: 'Unauthorized',
        description: 'H2M orders can only be created by Headquarters users with access level 40 or higher.',
        variant: 'destructive',
      })
      return
    }
    try {
      // Validation
      if (!sellerOrg) {
        return
      }

      if (!customerName || !deliveryAddress) {
        return
      }

      // Smart packing validation when using individual case sizes
      if (useIndividualCases) {
        const packingPlan = calculatePackingPlan()

        if (packingPlan.hasIssue) {
          const problem = packingPlan.productsWithRemainders[0]
          return
        }

        if (packingPlan.canFormMixedCases && packingPlan.totalRemainder > 0) {
          // Show info about mixed cases that will be created
          const remainderProducts = packingPlan.productsWithRemainders
            .map(p => `${p.productName}: ${p.remainder} Cases`)
            .join(', ')
        }
      }

      if (orderItems.length === 0) {
        return
      }

      setSaving(true)

      // Get company_id (root HQ)
      const { data: companyData } = await supabase
        .rpc('get_company_id', { p_org_id: userProfile.organization_id })

      const companyId = companyData || userProfile.organization_id

      // Check if we're editing an existing order
      if (editingOrderId && editingOrderNo) {
        console.log('📝 Updating existing order:', editingOrderNo)

        // STEP 1: Update order to draft status first (RLS requirement for order_items)
        const orderUpdateData: any = {
          seller_org_id: sellerOrg.id,
          status: 'draft', // Keep as draft during item updates
          units_per_case: useCustomUnitsPerCase && customUnitsPerCase ? parseInt(customUnitsPerCase) : unitsPerCase,
          qr_buffer_percent: resolveQrBufferPercent(qrBuffer),
          extra_qr_master: Math.max(0, Math.min(10, masterQrDuplicates)),
          has_rfid: enableRFID,
          has_points: hasPoints,
          has_lucky_draw: enableLuckyDraw,
          has_redeem: enableRedeem,
          notes: notes || `Customer: ${customerName}, Phone: ${phoneNumber}, Address: ${deliveryAddress}`,
          updated_at: new Date().toISOString()
        }

        const { error: updateError } = await supabase
          .from('orders')
          .update(orderUpdateData)
          .eq('id', editingOrderId)

        if (updateError) {
          console.error('Error updating order:', updateError)
          throw new Error(`Failed to update order: ${updateError.message}`)
        }

        // STEP 2: Delete existing order items
        const { error: deleteItemsError } = await supabase
          .from('order_items')
          .delete()
          .eq('order_id', editingOrderId)

        if (deleteItemsError) {
          console.error('Error deleting old order items:', deleteItemsError)
          throw new Error(`Failed to update order items: ${deleteItemsError.message}`)
        }

        // STEP 3: Insert updated order items (works because order is draft)
        const itemsToInsert = orderItems.map(item => ({
          order_id: editingOrderId,
          product_id: item.product_id,
          variant_id: item.variant_id,
          qty: item.qty,
          unit_price: item.unit_price,
          company_id: companyId,
          ...(useIndividualCases && item.units_per_case ? { units_per_case: item.units_per_case } : {})
        }))

        const { error: itemsError } = await supabase
          .from('order_items')
          .insert(itemsToInsert)

        if (itemsError) {
          console.error('Error inserting updated order items:', itemsError)
          throw new Error(`Failed to update order items: ${itemsError.message}`)
        }

        // STEP 4: Update status to submitted if requested (after items are inserted)
        if (status === 'submitted') {
          const { error: statusUpdateError } = await supabase
            .from('orders')
            .update({ status: 'submitted' })
            .eq('id', editingOrderId)

          if (statusUpdateError) {
            console.error('Error updating order status:', statusUpdateError)
            throw new Error(`Failed to submit order: ${statusUpdateError.message}`)
          }

          await fetch('/api/notifications/order-event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: editingOrderId, eventCode: 'order_submitted' })
          }).catch((error) => {
            console.warn('Failed to queue order_submitted notification:', error)
          })

          // Fire-and-forget: trigger notification worker to send WhatsApp/SMS/Email immediately
          fetch('/api/cron/notification-outbox-worker').catch(() => { })
        }

        console.log('✅ Order updated successfully:', editingOrderNo)

        // Navigate back to orders list
        if (onViewChange) {
          onViewChange('orders')
        }
        return
      }

      // CREATING NEW ORDER (not editing)
      // For H2M orders: Get the HQ's default warehouse
      let warehouseOrgId: string | null = null
      if (orderType === 'H2M' && buyerOrg) {
        const { data: hqData, error: hqError } = await supabase
          .from('organizations')
          .select('default_warehouse_org_id')
          .eq('id', buyerOrg.id)
          .single()

        if (hqError) {
          console.error('Error fetching HQ default warehouse:', hqError)
          toast({
            title: 'Error',
            description: 'Failed to fetch HQ configuration. Please contact support.',
            variant: 'destructive',
          })
          setSaving(false)
          return
        }

        // For H2M orders, if the buyer (manufacturer) doesn't have a default warehouse set,
        // we can't create the order because we don't know where to inventory the goods.
        // TODO: Allow selecting a warehouse manually if default is not set?
        if (!hqData?.default_warehouse_org_id) {
          toast({
            title: 'Configuration Error',
            description: 'Your organization does not have a default warehouse configured. Cannot route inventory.',
            variant: 'destructive',
          })
          setSaving(false)
          return
        }

        warehouseOrgId = hqData.default_warehouse_org_id
      }

      // Note: order_no is NOT set here - the database trigger orders_before_insert() 
      // will generate it in the format ORD-HM-YYMM-XX (for H2M), ORD-DH-YYMM-XX (for D2H), etc.
      // The orders_auto_display_doc_no trigger will then generate display_doc_no

      // Fetch seller organization's payment terms
      const sellerOrgResponse = await ((supabase
        .from('organizations') as any)
        .select('*, payment_terms(*)')  // Join with payment_terms table
        .eq('id', sellerOrg.id)
        .single())

      const sellerOrgData = sellerOrgResponse.data
      const sellerOrgError = sellerOrgResponse.error

      if (sellerOrgError) {
        console.error('Error fetching seller payment terms:', sellerOrgError)
      }

      // Build payment_terms jsonb based on organization's payment term
      let paymentTermsData: any = {
        deposit_pct: 0.5,
        balance_pct: 0.5,
        balance_trigger: 'on_first_receive'
      }

      const sellerOrgAny = sellerOrgData as any
      if (sellerOrgAny?.payment_terms) {
        const depositPct = sellerOrgAny.payment_terms.deposit_percentage / 100
        const balancePct = sellerOrgAny.payment_terms.balance_percentage / 100
        paymentTermsData = {
          deposit_pct: depositPct,
          balance_pct: balancePct,
          balance_trigger: 'on_first_receive'
        }
      }

      // STEP 1: Always create order in 'draft' status first (required by RLS policy)
      // Note: order_no is NOT set - database trigger will generate it
      const orderData = {
        order_type: orderType,
        // order_no is auto-generated by database trigger orders_before_insert()
        company_id: companyId,
        buyer_org_id: buyerOrg!.id,
        seller_org_id: sellerOrg.id,
        warehouse_org_id: warehouseOrgId, // Set warehouse for H2M orders
        status: 'draft' as const, // ← Always draft first! RLS policy requires this
        units_per_case: useCustomUnitsPerCase && customUnitsPerCase ? parseInt(customUnitsPerCase) : unitsPerCase,
        qr_buffer_percent: resolveQrBufferPercent(qrBuffer),
        extra_qr_master: Math.max(0, Math.min(10, masterQrDuplicates)), // Clamp between 0-10
        has_rfid: enableRFID,
        has_points: hasPoints,
        has_lucky_draw: enableLuckyDraw,
        has_redeem: enableRedeem,
        payment_terms: paymentTermsData,
        notes: notes || `Customer: ${customerName}, Phone: ${phoneNumber}, Address: ${deliveryAddress}`,
        created_by: userProfile.id
      }

      const { data: order, error: orderError } = await supabase
        .from('orders')
        .insert(orderData)
        .select()
        .single()

      if (orderError) throw orderError

      // STEP 2: Insert order items (now passes RLS check because order is 'draft')
      const itemsToInsert = orderItems.map(item => ({
        order_id: order.id,
        product_id: item.product_id,
        variant_id: item.variant_id,
        qty: item.qty,
        unit_price: item.unit_price,
        company_id: companyId,
        ...(useIndividualCases && item.units_per_case ? { units_per_case: item.units_per_case } : {})
      }))

      const { error: itemsError } = await supabase
        .from('order_items')
        .insert(itemsToInsert)

      if (itemsError) {
        console.error('Error inserting order items:', itemsError)
        // Try to delete the order if items failed
        await supabase.from('orders').delete().eq('id', order.id)
        throw new Error(`Failed to add products to order: ${itemsError.message}`)
      }

      // STEP 3: If requested status was 'submitted', update the order
      if (status === 'submitted') {
        const { error: updateError } = await supabase
          .from('orders')
          .update({ status: 'submitted' })
          .eq('id', order.id)

        if (updateError) {
          console.error('Error updating order status:', updateError)
          throw new Error(`Failed to submit order: ${updateError.message}`)
        }

        await fetch('/api/notifications/order-event', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: order.id, eventCode: 'order_submitted' })
        }).catch((error) => {
          console.warn('Failed to queue order_submitted notification:', error)
        })

        // Fire-and-forget: trigger notification worker to send WhatsApp/SMS/Email immediately
        fetch('/api/cron/notification-outbox-worker').catch(() => { })
      }

      // Navigate back to orders list
      if (onViewChange) {
        onViewChange('orders')
      }

    } catch (error: any) {
      console.error('Error saving order:', error)
      toast({
        title: 'Error Creating Order',
        description: error.message || 'An unexpected error occurred.',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const calculateTotals = () => {
    const subtotal = orderItems.reduce((sum, item) => sum + (item.qty * item.unit_price), 0)
    const tax = subtotal * 0.0 // Adjust tax rate as needed
    const total = subtotal + tax

    // Calculate total cases based on individual or global units per case
    const totalCases = useIndividualCases
      ? orderItems.reduce((sum, item) => sum + Math.ceil(item.qty / (item.units_per_case || unitsPerCase)), 0)
      : Math.ceil(orderItems.reduce((sum, item) => sum + item.qty, 0) / unitsPerCase)

    const masterQR = totalCases
    // One unique QR per ordered case plus the manufacturer buffer cases, rounded
    // exactly as QR generation rounds them (lib/orders/qr-buffer).
    const orderedCases = orderItems.reduce((sum, item) => sum + item.qty, 0)
    const bufferCases = qrBufferCases(orderedCases, resolveQrBufferPercent(qrBuffer))
    const uniqueQR = orderedCases + bufferCases

    // Expected Boxes: the shared Standard/Small Box rule the order detail page
    // and PDF use, from the same box sizes this order will be saved with.
    const expectedBoxes = formatOrderExpectedBoxes(
      orderItems.map((item) => ({
        qty: item.qty,
        units_per_case: useIndividualCases ? item.units_per_case : null,
      })),
      useCustomUnitsPerCase && customUnitsPerCase ? parseInt(customUnitsPerCase) : unitsPerCase,
    )

    return { subtotal, tax, total, totalCases, masterQR, uniqueQR, orderedCases, bufferCases, expectedBoxes }
  }

  const totals = calculateTotals()
  // Each line's share of the buffer, as generateQRBatch allocates it.
  const lineBufferShares = allocateQrBufferCases(orderItems.map((item) => item.qty), resolveQrBufferPercent(qrBuffer))
  const lineBufferCases = new Map(orderItems.map((item, index) => [item.variant_id, lineBufferShares[index]]))

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
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
        <h2 className="font-display text-2xl font-semibold text-[var(--sera-ink)]">Create New Order</h2>
        <p className="text-[var(--sera-muted)] text-sm mt-1">Fill in the details to create a new order</p>
      </div>

      {/* Main Layout - Two Columns */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column - Form */}
        <div className="lg:col-span-2 space-y-6">
          {/* Auto-determined Seller Info - Show for D2H */}
          {orderType === 'D2H' && sellerOrg && (
            <Card className="sera-sc-panel overflow-hidden shadow-none">
              <CardHeader className="border-b bg-[var(--sera-ink)]/[0.03]">
                <CardTitle className="flex items-center gap-2 text-base font-semibold">
                  <Package className="w-4 h-4" />
                  Seller Organization
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-6">
                <div className="bg-[var(--sera-orange)]/[0.06] border border-[var(--sera-orange)]/20 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-lg bg-[var(--sera-orange)]/10 flex items-center justify-center flex-shrink-0">
                      <Package className="w-5 h-5 text-[var(--sera-orange)]" />
                    </div>
                    <div className="flex-1">
                      <h4 className="font-semibold text-[var(--sera-ink)]">{sellerOrg.org_name}</h4>
                      <p className="text-sm text-[var(--sera-muted)]">{sellerOrg.org_code}</p>
                      <p className="text-xs text-[var(--sera-orange)] mt-1">
                        ✓ Auto-selected: Your Headquarters
                      </p>
                    </div>
                  </div>
                </div>
                <p className="text-xs text-[var(--sera-muted)]/80 mt-3">
                  Distributors automatically order from their parent HQ organization
                </p>
              </CardContent>
            </Card>
          )}

          {/* Seller Selection - Show for S2D if multiple distributors */}
          {orderType === 'S2D' && showDistributorSelector && (
            <Card className="sera-sc-panel overflow-hidden shadow-none">
              <CardHeader className="border-b bg-[var(--sera-ink)]/[0.03]">
                <CardTitle className="flex items-center gap-2 text-base font-semibold">
                  <Package className="w-4 h-4" />
                  Seller Organization
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-6">
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">
                    Select Distributor <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={selectedSellerOrgId}
                    onChange={(e) => handleDistributorChange(e.target.value)}
                    className="w-full px-3 py-2 border border-[var(--sera-line)] rounded-md focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]/30 bg-white"
                  >
                    <option value="">Choose distributor...</option>
                    {availableDistributors.map(dist => (
                      <option key={dist.id} value={dist.id}>
                        {dist.org_name} ({dist.org_code}) {dist.is_preferred && '★ Preferred'}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-[var(--sera-muted)]/80 mt-1">
                    Select the distributor you want to order from
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Auto-determined Seller Info - Show for S2D with single/preferred distributor */}
          {orderType === 'S2D' && !showDistributorSelector && sellerOrg && (
            <Card className="sera-sc-panel overflow-hidden shadow-none">
              <CardHeader className="border-b bg-[var(--sera-ink)]/[0.03]">
                <CardTitle className="flex items-center gap-2 text-base font-semibold">
                  <Package className="w-4 h-4" />
                  Seller Organization
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-6">
                <div className="bg-[var(--sera-orange)]/[0.06] border border-[var(--sera-orange)]/20 rounded-lg p-4">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-lg bg-[var(--sera-orange)]/10 flex items-center justify-center flex-shrink-0">
                      <Package className="w-5 h-5 text-[var(--sera-orange)]" />
                    </div>
                    <div className="flex-1">
                      <h4 className="font-semibold text-[var(--sera-ink)]">{sellerOrg.org_name}</h4>
                      <p className="text-sm text-[var(--sera-muted)]">{sellerOrg.org_code}</p>
                      <p className="text-xs text-[var(--sera-orange)] mt-1">
                        ✓ Auto-selected: Your Distributor
                      </p>
                    </div>
                  </div>
                </div>
                <p className="text-xs text-[var(--sera-muted)]/80 mt-3">
                  Shops automatically order from their linked distributor organization
                </p>
              </CardContent>
            </Card>
          )}

          {/* Customer Information */}
          <Card className="sera-sc-panel overflow-hidden shadow-none">
            <CardHeader className="border-b bg-[var(--sera-ink)]/[0.03]">
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <User className="w-4 h-4" />
                Customer Information
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">
                    Customer Name <span className="text-red-500">*</span>
                  </label>
                  <Input
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="Enter customer name"
                    className="bg-[var(--sera-ink)]/[0.03]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">
                    Phone Number
                  </label>
                  <Input
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    placeholder="Enter phone number"
                    className="bg-[var(--sera-ink)]/[0.03]"
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
                  rows={3}
                  className="w-full px-3 py-2 border border-[var(--sera-line)] rounded-md focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]/30 bg-[var(--sera-ink)]/[0.03]"
                  placeholder="Enter delivery address"
                />
              </div>
            </CardContent>
          </Card>

          {/* Order Configuration */}
          <Card className="sera-sc-panel overflow-hidden shadow-none">
            <CardHeader className="border-b bg-[var(--sera-ink)]/[0.03]">
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <Package className="w-4 h-4" />
                Order Configuration
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              {/* Auto-Logic Info Banner */}
              {orderItems.length > 0 && (
                <div className="mb-4 p-3 bg-[var(--sera-orange)]/[0.06] border border-[var(--sera-orange)]/20 rounded-lg">
                  <div className="flex items-start gap-2">
                    <svg className="w-4 h-4 text-[var(--sera-orange)] mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
                    </svg>
                    <div className="flex-1">
                      <p className="text-xs font-medium text-[var(--sera-ink)]">
                        Smart Box Configuration
                      </p>
                      <p className="text-xs text-[var(--sera-orange-deep)] mt-1">
                        {useIndividualCases
                          ? 'Individual mode: Each product has its own cases-per-box configuration based on product family (Cellera Hero/Zero: 100, Ellbow Cat Treat: 20, S.Box: 50, S.Line: 200)'
                          : `Global mode: All products use ${unitsPerCase} cases per box`}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Case Size Configuration Mode Toggle */}
              <div className="mb-6 p-4 bg-[var(--sera-ink)]/[0.03] border border-[var(--sera-line)] rounded-lg">
                <label className="block text-sm font-medium text-[var(--sera-ink)] mb-3">
                  Box Configuration
                </label>
                <div className="space-y-3">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="radio"
                      name="caseMode"
                      checked={!useIndividualCases}
                      onChange={() => {
                        setUseIndividualCases(false)
                        // Reset individual case sizes when switching to global mode
                        setOrderItems(orderItems.map(item => ({ ...item, units_per_case: undefined })))
                      }}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <span className="text-sm font-medium text-[var(--sera-ink)]">Same cases per box for all products</span>
                      <p className="text-xs text-[var(--sera-muted)]/80 mt-1">All products will use the same number of cases per box (recommended for standard orders)</p>
                    </div>
                  </label>
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="radio"
                      name="caseMode"
                      checked={useIndividualCases}
                      onChange={() => {
                        setUseIndividualCases(true)
                        // Set default individual case sizes when switching to individual mode
                        setOrderItems(orderItems.map(item => ({ ...item, units_per_case: item.units_per_case || unitsPerCase })))
                      }}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <span className="text-sm font-medium text-[var(--sera-ink)]">Individual cases per box for each product</span>
                      <p className="text-xs text-[var(--sera-muted)]/80 mt-1">Set different cases-per-box values for each product variant (flexible for mixed orders)</p>
                    </div>
                  </label>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">
                    {useIndividualCases ? 'Default Cases per Box' : 'Cases per Box'}
                  </label>
                  {useCustomUnitsPerCase ? (
                    <div className="flex gap-2">
                      <Input
                        type="number"
                        value={customUnitsPerCase}
                        onChange={(e) => {
                          setCustomUnitsPerCase(e.target.value)
                          const value = parseInt(e.target.value)
                          if (value > 0) {
                            handleUnitsPerCaseChange(value)
                          }
                        }}
                        placeholder="Enter custom cases per box"
                        className="flex-1"
                        disabled={useIndividualCases}
                        min="1"
                      />
                      <button
                        onClick={() => {
                          setUseCustomUnitsPerCase(false)
                          setCustomUnitsPerCase('')
                        }}
                        className="px-3 py-2 text-sm text-[var(--sera-muted)] hover:text-gray-800 border border-[var(--sera-line)] rounded-md"
                        disabled={useIndividualCases}
                      >
                        Presets
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <select
                        value={unitsPerCase}
                        onChange={(e) => handleUnitsPerCaseChange(parseInt(e.target.value))}
                        className="flex-1 px-3 py-2 border border-[var(--sera-line)] rounded-md focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]/30 bg-[var(--sera-ink)]/[0.03]"
                        disabled={useIndividualCases}
                      >
                        <option value="20">20 Cases per Box</option>
                        <option value="50">50 Cases per Box</option>
                        <option value="100">100 Cases per Box</option>
                        <option value="200">200 Cases per Box</option>
                      </select>
                      <button
                        onClick={() => {
                          setUseCustomUnitsPerCase(true)
                          setCustomUnitsPerCase(unitsPerCase.toString())
                        }}
                        className="px-3 py-2 text-sm text-[var(--sera-muted)] hover:text-gray-800 border border-[var(--sera-line)] rounded-md"
                        disabled={useIndividualCases}
                      >
                        Custom
                      </button>
                    </div>
                  )}
                  <p className="text-xs text-[var(--sera-muted)]/80 mt-1">
                    {useIndividualCases ? 'Default value for new products' : 'This setting applies to all products in this order'}
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">
                    QR Buffer (%)
                  </label>
                  <Input
                    type="number"
                    value={qrBuffer}
                    onChange={(e) => setQrBuffer(parseFloat(e.target.value))}
                    className="bg-[var(--sera-ink)]/[0.03]"
                    step="0.1"
                    min="0"
                  />
                  <p className="text-xs text-[var(--sera-muted)]/80 mt-1">Manufacturer buffer cases, one extra case QR each (default {DEFAULT_QR_BUFFER_PERCENT}%)</p>
                </div>
              </div>

              <div className="mb-4">
                <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">
                  Master QR copies per Box
                </label>
                <Input
                  type="number"
                  value={masterQrDuplicates}
                  onChange={(e) => {
                    const value = parseInt(e.target.value)
                    // Clamp between 0 and 10
                    if (value >= 0 && value <= 10) {
                      setMasterQrDuplicates(value)
                    }
                  }}
                  className="bg-[var(--sera-ink)]/[0.03]"
                  min="0"
                  max="10"
                />
                <p className="text-xs text-[var(--sera-muted)]/80 mt-1">
                  How many duplicate Master QR stickers to print per box (0-10). Default is 5. Example: 0 = only 1 sticker per box, 5 = 6 stickers per box, 10 = 11 stickers per box.
                </p>
              </div>

              <div className="flex items-start gap-2 p-3 bg-[var(--sera-orange)]/[0.06] border border-[var(--sera-orange)]/20 rounded-md">
                <input
                  type="checkbox"
                  id="rfid"
                  checked={enableRFID}
                  onChange={(e) => setEnableRFID(e.target.checked)}
                  className="mt-0.5"
                />
                <label htmlFor="rfid" className="flex-1">
                  <div className="flex items-center gap-2">
                    <CheckSquare className="w-4 h-4 text-[var(--sera-orange)]" />
                    <span className="text-sm font-medium text-[var(--sera-ink)]">This order supports RFID</span>
                  </div>
                  <p className="text-xs text-[var(--sera-muted)] mt-1">RFID tags will equal the total number of Master QR codes to print</p>
                </label>
              </div>
            </CardContent>
          </Card>

          {/* Product Selection - Always show, but enable/disable based on availability */}
          <Card className="sera-sc-panel overflow-hidden shadow-none">
            <CardHeader className="border-b bg-[var(--sera-ink)]/[0.03]">
              <CardTitle className="text-base font-semibold">Product Selection</CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              {/* Search and Filter */}
              <div className="space-y-3 mb-4">
                {/* Product Filter */}
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">
                    Filter by Product
                  </label>
                  <select
                    value={selectedProductFilter}
                    onChange={(e) => {
                      setSelectedProductFilter(e.target.value)
                      setSelectedVariantId('') // Reset variant selection
                    }}
                    className="w-full px-3 py-2 border border-[var(--sera-line)] rounded-md focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]/30 bg-white"
                    disabled={availableVariants.length === 0}
                  >
                    <option value="">All Products ({Array.from(new Set(availableVariants.map(v => v.product_name))).length})</option>
                    {Array.from(new Set(availableVariants.map(v => v.product_name))).sort().map(productName => {
                      const variantsCount = availableVariants.filter(v => v.product_name === productName && !orderItems.find(item => item.variant_id === v.id)).length
                      return (
                        <option key={productName} value={productName}>
                          {productName} ({variantsCount} variant{variantsCount !== 1 ? 's' : ''})
                        </option>
                      )
                    })}
                  </select>
                </div>

                {/* Search */}
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">
                    Search Variant
                  </label>
                  <Input
                    type="text"
                    placeholder="Search by variant name or attributes..."
                    value={productSearchQuery}
                    onChange={(e) => setProductSearchQuery(e.target.value)}
                    className="w-full"
                    disabled={availableVariants.length === 0}
                  />
                </div>

                {/* Variant Selection */}
                <div>
                  <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">
                    Select Variant
                  </label>
                  <div className="flex gap-2">
                    <select
                      value={selectedVariantId}
                      onChange={(e) => setSelectedVariantId(e.target.value)}
                      className="flex-1 px-3 py-2 border border-[var(--sera-line)] rounded-md focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]/30 bg-white max-h-[200px]"
                      disabled={availableVariants.length === 0}
                      size={Math.min(8, Math.max(3, availableVariants.filter(v => {
                        const alreadyAdded = orderItems.find(item => item.variant_id === v.id)
                        if (alreadyAdded) return false

                        const matchesProduct = !selectedProductFilter || v.product_name === selectedProductFilter
                        const searchLower = productSearchQuery.toLowerCase()
                        const matchesSearch = !productSearchQuery ||
                          v.variant_name.toLowerCase().includes(searchLower) ||
                          v.product_name.toLowerCase().includes(searchLower) ||
                          (v.attributes?.strength && String(v.attributes.strength).toLowerCase().includes(searchLower)) ||
                          (v.attributes?.nicotine && String(v.attributes.nicotine).toLowerCase().includes(searchLower))

                        return matchesProduct && matchesSearch
                      }).length))}
                    >
                      <option value="">
                        {(() => {
                          const filteredVariants = availableVariants.filter(v => {
                            const alreadyAdded = orderItems.find(item => item.variant_id === v.id)
                            if (alreadyAdded) return false

                            const matchesProduct = !selectedProductFilter || v.product_name === selectedProductFilter
                            const searchLower = productSearchQuery.toLowerCase()
                            const matchesSearch = !productSearchQuery ||
                              v.variant_name.toLowerCase().includes(searchLower) ||
                              v.product_name.toLowerCase().includes(searchLower) ||
                              (v.attributes?.strength && String(v.attributes.strength).toLowerCase().includes(searchLower)) ||
                              (v.attributes?.nicotine && String(v.attributes.nicotine).toLowerCase().includes(searchLower))

                            return matchesProduct && matchesSearch
                          })
                          return filteredVariants.length === 0 ? 'No variants available' : `Select a variant (${filteredVariants.length} available)`
                        })()}
                      </option>
                      {availableVariants
                        .filter(variant => {
                          const alreadyAdded = orderItems.find(item => item.variant_id === variant.id)
                          if (alreadyAdded) return false

                          const matchesProduct = !selectedProductFilter || variant.product_name === selectedProductFilter
                          const searchLower = productSearchQuery.toLowerCase()
                          const matchesSearch = !productSearchQuery ||
                            variant.variant_name.toLowerCase().includes(searchLower) ||
                            variant.product_name.toLowerCase().includes(searchLower) ||
                            (variant.attributes?.strength && String(variant.attributes.strength).toLowerCase().includes(searchLower)) ||
                            (variant.attributes?.nicotine && String(variant.attributes.nicotine).toLowerCase().includes(searchLower))

                          return matchesProduct && matchesSearch
                        })
                        .sort((a, b) => a.product_name.localeCompare(b.product_name) || a.variant_name.localeCompare(b.variant_name))
                        .map(variant => {
                          const attrText = variant.attributes?.strength || variant.attributes?.nicotine || ''
                          return (
                            <option key={variant.id} value={variant.id}>
                              {!selectedProductFilter ? `${variant.product_name}${PRODUCT_SEPARATOR}` : ''}{variantSelectorLabel(variant.variant_name, variant.variant_product_code, attrText)} - RM {formatCurrency(variant.base_cost)}
                            </option>
                          )
                        })}
                    </select>
                    <Button
                      variant="outline"
                      className="bg-[var(--sera-orange)] text-white hover:bg-[var(--sera-orange-deep)] shrink-0"
                      onClick={handleAddProduct}
                      disabled={!selectedVariantId}
                    >
                      Add Product
                    </Button>
                  </div>
                </div>

                {availableVariants.length === 0 && (
                  <p className="text-xs text-red-600 mt-1">
                    {orderType === 'H2M'
                      ? 'No active products available. Products will be filtered by manufacturer once added.'
                      : 'No active products available. Please contact your administrator.'}
                  </p>
                )}
              </div>

              {/* Product List */}
              {orderItems.length === 0 ? (
                <div className="text-center py-8 bg-[var(--sera-ink)]/[0.03] rounded-lg border border-dashed border-[var(--sera-line)]">
                  <p className="text-[var(--sera-muted)]/80 text-sm">No products selected. Add products to create your order.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {orderItems.map((item) => {
                    const itemVariant = availableVariants.find(v => v.id === item.variant_id)
                    const productFamily = itemVariant ? getProductFamily(itemVariant) : null
                    const familyDefaultSize = productFamily ? getDefaultCaseSize(productFamily) : null
                    const itemVariantProductCode = resolveVariantProductCode(item)
                    const itemAttrText = item.attributes?.strength || item.attributes?.nicotine || ''
                    // Presentation only: the outer-container count (unchanged calculation) is labelled "Box"
                    const boxCount = Math.ceil(item.qty / (item.units_per_case || unitsPerCase))

                    return (
                      <div key={item.variant_id} className="border border-[var(--sera-line)] rounded-lg p-4 bg-white">
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <h4 className="font-medium text-[var(--sera-ink)]">{item.product_name}</h4>
                              {productFamily && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800">
                                  {productFamily}
                                </span>
                              )}
                            </div>
                            <p className="text-sm text-[var(--sera-muted)] mt-1">
                              {variantNameWithProductCodeBullet(item.variant_name, itemVariantProductCode)}
                              {itemAttrText ? ` • ${itemAttrText}` : ''}
                            </p>
                            <p className="text-xs text-[var(--sera-muted)]/80 mt-1">
                              RM {formatCurrency(item.unit_price)} per case
                              {familyDefaultSize && ` • Default: ${familyDefaultSize} cases/box`}
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRemoveProduct(item.variant_id)}
                            className="text-red-600 hover:text-red-700 hover:bg-red-50 p-2"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                        <div className="grid grid-cols-3 gap-3">
                          {useIndividualCases && (
                            <div>
                              <label className="block text-xs font-medium text-[var(--sera-ink)]/80 mb-1">
                                Cases per Box
                              </label>
                              <select
                                value={item.units_per_case || unitsPerCase}
                                onChange={(e) => handleUpdateIndividualUnitsPerCase(item.variant_id, parseInt(e.target.value))}
                                className="w-full px-2 py-1.5 text-sm border border-[var(--sera-line)] rounded-md focus:outline-none focus:ring-2 focus:ring-[var(--sera-orange)]/30"
                              >
                                <option value="20">20</option>
                                <option value="50">50</option>
                                <option value="100">100</option>
                                <option value="200">200</option>
                              </select>
                            </div>
                          )}
                          <div>
                            <label className="block text-xs font-medium text-[var(--sera-ink)]/80 mb-1">
                              Quantity (Cases)
                            </label>
                            <Input
                              type="text"
                              value={item.qty ? item.qty.toLocaleString() : ''}
                              onChange={(e) => {
                                // Remove commas and non-numeric characters
                                const rawValue = e.target.value.replace(/,/g, '').replace(/\D/g, '')
                                handleUpdateQuantity(item.variant_id, parseInt(rawValue) || 0)
                              }}
                              className="text-sm"
                              placeholder="0"
                            />
                            {useIndividualCases && item.qty > 0 && item.qty % (item.units_per_case || unitsPerCase) !== 0 && (() => {
                              const itemUnitsPerCase = item.units_per_case || unitsPerCase
                              const fullCases = Math.floor(item.qty / itemUnitsPerCase)
                              const remainder = item.qty % itemUnitsPerCase
                              return (
                                <p className="text-xs text-amber-600 mt-1">
                                  {fullCases} full box(es) + {remainder} Cases remainder
                                </p>
                              )
                            })()}
                            {!useIndividualCases && item.qty > 0 && item.qty % (item.units_per_case || unitsPerCase) !== 0 && item.qty !== 50 && item.qty !== 100 && item.qty !== 200 && (
                              <p className="text-xs text-red-600 mt-1">
                                Please enter multiples of {item.units_per_case || unitsPerCase}
                              </p>
                            )}
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-[var(--sera-ink)]/80 mb-1">
                              Price per Case (RM)
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
                        </div>

                        {/* Auto-calculated summary */}
                        <div className="mt-3 pt-3 border-t border-gray-100 grid grid-cols-4 gap-2 text-xs">
                          <div>
                            <span className="text-[var(--sera-muted)]/80 block">Boxes:</span>
                            {useIndividualCases && item.qty % (item.units_per_case || unitsPerCase) !== 0 ? (
                              <>
                                <span className="font-semibold">
                                  {Math.floor(item.qty / (item.units_per_case || unitsPerCase)).toLocaleString()} full +
                                  {(item.qty % (item.units_per_case || unitsPerCase)).toLocaleString()} Cases
                                </span>
                                {useIndividualCases && (
                                  <span className="text-xs text-amber-600 block mt-0.5">⚠ Will mix with other remainders</span>
                                )}
                              </>
                            ) : (
                              <>
                                <span className="font-semibold">{boxCount.toLocaleString()} {boxCount === 1 ? 'Box' : 'Boxes'}</span>
                                {useIndividualCases && (
                                  <span className="text-xs text-[var(--sera-orange)] block mt-0.5">({item.units_per_case || unitsPerCase} cases/box)</span>
                                )}
                              </>
                            )}
                          </div>
                          <div>
                            <span className="text-[var(--sera-muted)]/80 block">Unique QR (with {qrBuffer}% buffer):</span>
                            <span className="font-semibold">{(item.qty + (lineBufferCases.get(item.variant_id) ?? 0)).toLocaleString()} QR codes</span>
                          </div>
                          <div>
                            <span className="text-[var(--sera-muted)]/80 block">Line Total:</span>
                            <span className="font-semibold text-[var(--sera-orange)]">RM {formatCurrency(item.line_total || (item.qty * item.unit_price))}</span>
                          </div>
                          <div>
                            <span className="text-[var(--sera-muted)]/80 block">QR Codes:</span>
                            <span className="font-semibold">{Math.ceil(item.qty / (item.units_per_case || unitsPerCase))} master + {(item.qty + (lineBufferCases.get(item.variant_id) ?? 0)).toLocaleString()} unique</span>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Packing Plan Summary - Show when using individual cases with remainders */}
          {useIndividualCases && orderItems.length > 0 && (() => {
            const packingPlan = calculatePackingPlan()
            if (packingPlan.productsWithRemainders.length === 0) return null

            return (
              <Card className={packingPlan.hasIssue ? 'border-red-300 bg-red-50' : 'border-amber-300 bg-amber-50'}>
                <CardHeader className="border-b bg-white">
                  <CardTitle className="flex items-center gap-2 text-base font-semibold">
                    <Package className="w-4 h-4" />
                    {packingPlan.hasIssue ? '⚠️ Packing Issue Detected' : '📦 Smart Packing Plan'}
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-4">
                  {packingPlan.hasIssue ? (
                    <div className="space-y-3">
                      <p className="text-sm font-medium text-red-800">
                        Cannot pack incomplete boxes with only one product having a remainder.
                      </p>
                      <div className="bg-white rounded-lg p-3 border border-red-200">
                        {packingPlan.productsWithRemainders.map(p => (
                          <div key={p.variantId} className="text-sm">
                            <span className="font-semibold">{p.productName}</span>: {p.qty} Cases
                            <br />
                            <span className="text-red-700">
                              → {p.fullCases} full Boxes ({p.fullCases * p.unitsPerCase} Cases) + <strong>{p.remainder} Cases remainder</strong>
                            </span>
                          </div>
                        ))}
                      </div>
                      <p className="text-xs text-red-700">
                        <strong>Solutions:</strong><br />
                        • Add another product with a remainder to create mixed Boxes<br />
                        • Adjust quantity to {packingPlan.productsWithRemainders[0].fullCases * packingPlan.productsWithRemainders[0].unitsPerCase} or {(packingPlan.productsWithRemainders[0].fullCases + 1) * packingPlan.productsWithRemainders[0].unitsPerCase} Cases<br />
                        • Change cases per box to match your quantity
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-sm font-medium text-amber-800">
                        ✓ Remainders from multiple products will be mixed into {packingPlan.mixedCasesNeeded} Box(es)
                      </p>
                      <div className="bg-white rounded-lg p-3 border border-amber-200 space-y-2">
                        <div className="text-sm font-semibold text-[var(--sera-ink)]/80">Full Boxes:</div>
                        {packingPlan.plan.filter(p => p.fullCases > 0).map(p => (
                          <div key={p.variantId} className="text-sm pl-3">
                            • {p.fullCases} Box(es) of {p.productName} - {p.variantName} ({p.unitsPerCase} cases/box)
                          </div>
                        ))}

                        {packingPlan.productsWithRemainders.length > 0 && (
                          <>
                            <div className="text-sm font-semibold text-amber-700 mt-3">Mixed Box(es):</div>
                            <div className="text-sm pl-3 text-amber-700">
                              • {packingPlan.mixedCasesNeeded} Box(es) containing:
                              {packingPlan.productsWithRemainders.map(p => (
                                <div key={p.variantId} className="pl-4">
                                  - {p.productName} - {p.variantName}: {p.remainder} Cases
                                </div>
                              ))}
                              <div className="mt-1 font-medium">
                                Total: {packingPlan.totalRemainder} Cases in {packingPlan.suggestedMixedCaseSize} cases/box format
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                      <p className="text-xs text-amber-700">
                        Mixed Boxes will be labeled clearly for warehouse and manufacturing.
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })()}

          {/* Lucky Draw & Redeem */}
          <Card className="sera-sc-panel overflow-hidden shadow-none">
            <CardHeader className="border-b bg-[var(--sera-ink)]/[0.03]">
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <CheckSquare className="w-4 h-4" />
                Lucky Draw & Redeem
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="space-y-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enableLuckyDraw}
                    onChange={(e) => setEnableLuckyDraw(e.target.checked)}
                    className="rounded"
                  />
                  <span className="text-sm text-[var(--sera-ink)]/80">Enable Lucky Draw</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={enableRedeem}
                    onChange={(e) => setEnableRedeem(e.target.checked)}
                    className="rounded"
                  />
                  <span className="text-sm text-[var(--sera-ink)]/80">Enable Redeem</span>
                </label>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Column - Order Summary */}
        <div className="lg:col-span-1">
          <Card className="sticky top-6">
            <CardHeader className="border-b bg-[var(--sera-ink)]/[0.03]">
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <Package className="w-4 h-4" />
                Order Summary
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              {/* Customer Info */}
              <div className="mb-6">
                <h4 className="text-sm font-semibold text-[var(--sera-ink)] mb-2">Customer</h4>
                <div className="text-sm space-y-1">
                  <p><span className="font-medium">Name:</span> {customerName}</p>
                  <p><span className="font-medium">Phone:</span> {phoneNumber}</p>
                  <p className="flex items-start gap-1">
                    <span className="font-medium">📍</span>
                    <span>{deliveryAddress}</span>
                  </p>
                </div>
              </div>

              {/* Products */}
              <div className="mb-6">
                <h4 className="text-sm font-semibold text-[var(--sera-ink)] mb-2">
                  Products ({orderItems.length})
                </h4>
                {orderItems.length === 0 ? (
                  <p className="text-sm text-[var(--sera-muted)]/80">No products selected</p>
                ) : (
                  <div className="space-y-2">
                    {orderItems.map((item) => {
                      // Presentation only: the outer-container count (unchanged calculation) is labelled "Box"
                      const boxCount = Math.ceil(item.qty / (item.units_per_case || unitsPerCase))
                      return (
                      <div key={item.variant_id} className="text-sm">
                        <div className="flex justify-between">
                          <span className="text-[var(--sera-ink)]/80 font-medium">{item.product_name}</span>
                        </div>
                        <div className="flex justify-between text-xs text-[var(--sera-muted)]">
                          <span>{variantIdentityLabel(item.variant_name, resolveVariantProductCode(item))}</span>
                        </div>
                        <div className="flex justify-between text-xs text-[var(--sera-muted)]/80 mt-1">
                          <span>{item.qty.toLocaleString()} Cases • {boxCount.toLocaleString()} {boxCount === 1 ? 'Box' : 'Boxes'}</span>
                          <span className="font-medium text-[var(--sera-ink)]/80">
                            RM {formatCurrency(item.line_total || (item.qty * item.unit_price))}
                          </span>
                        </div>
                      </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Calculations */}
              <div className="space-y-2 mb-6 text-sm">
                <div className="flex justify-between">
                  <span className="text-[var(--sera-muted)]">Total Boxes:</span>
                  <span className="font-medium">{totals.totalCases}</span>
                </div>
                {orderItems.length > 0 && (
                  <div className="flex justify-between gap-3">
                    <span className="text-[var(--sera-muted)] whitespace-nowrap">Expected Boxes:</span>
                    <span className="font-medium text-right">{totals.expectedBoxes}</span>
                  </div>
                )}
                {orderType === 'H2M' && orderItems.length > 0 && (
                  <div className="flex justify-between gap-3">
                    <span className="text-[var(--sera-muted)] whitespace-nowrap">Buffer Cases:</span>
                    <span className="font-medium text-right">
                      {totals.bufferCases.toLocaleString()} ({resolveQrBufferPercent(qrBuffer)}%, not boxed)
                    </span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-[var(--sera-muted)]">Master QR:</span>
                  <span className="font-medium">{totals.masterQR}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--sera-muted)]">Unique QR:</span>
                  <span className="font-medium">{totals.uniqueQR.toLocaleString()}</span>
                </div>
                {enableRFID && (
                  <div className="flex justify-between">
                    <span className="text-[var(--sera-muted)]">RFID Tags:</span>
                    <span className="font-medium">{totals.masterQR}</span>
                  </div>
                )}
              </div>

              {/* Totals */}
              <div className="border-t pt-4 space-y-2 mb-6">
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
                <h4 className="text-sm font-semibold text-[var(--sera-ink)] mb-3 flex items-center gap-2">
                  <CheckSquare className="w-4 h-4" />
                  Order Actions
                </h4>
                {(!sellerOrg || !customerName || !deliveryAddress || orderItems.length === 0) && (
                  <div className="text-xs text-amber-600 bg-amber-50 p-2 rounded border border-amber-200">
                    <strong>Required:</strong>
                    {!sellerOrg && ' Select seller organization.'}
                    {!customerName && ' Enter customer name.'}
                    {!deliveryAddress && ' Enter delivery address.'}
                    {orderItems.length === 0 && ' Add at least one product.'}
                  </div>
                )}
                <Button
                  className="w-full bg-[var(--sera-orange)] hover:bg-[var(--sera-orange-deep)] text-white disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={handleCreateOrder}
                  disabled={saving || !sellerOrg || !customerName || !deliveryAddress || orderItems.length === 0}
                >
                  {saving ? (editingOrderId ? 'Updating...' : 'Creating...') : (editingOrderId ? 'Update Order' : 'Create Order')}
                </Button>
                <Button
                  variant="outline"
                  className="w-full disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={handleSaveAsDraft}
                  disabled={saving || !sellerOrg || !customerName || !deliveryAddress || orderItems.length === 0}
                >
                  {saving ? 'Saving...' : 'Save as Draft'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
