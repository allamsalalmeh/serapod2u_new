'use client'

import { useState, useEffect, useMemo } from 'react'
import { useSupabaseAuth } from '@/lib/hooks/useSupabaseAuth'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import MovementTypeBadge from './MovementTypeBadge'
import ProductThumbnail from './ProductThumbnail'
import { subscribeToInventoryDataRefresh } from '@/lib/inventory/inventory-data-refresh'
import { withStockStrengthUnit } from '@/lib/inventory/stock-config-unit-label'
import {
  formatSignedMovementImpact,
  resolveStockMovementConfiguration,
  resolveStockMovementHistoryValues,
} from '@/lib/inventory/stock-movement-history'
import { canonicalOrderNumber, orderIdsForMovements, resolveMovementReferenceNo } from '@/lib/inventory/stock-movement-reference'
import {
  STOCK_MOVEMENT_ACCESS_DENIED_MESSAGE,
  STOCK_MOVEMENT_REPORT_SOURCE,
  isStockMovementAccessDenied,
} from '@/lib/inventory/stock-movement-access'
import {
  BarChart3,
  Search,
  Filter,
  Download,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Calendar,
  ArrowUpDown,
  ArrowUp,
  ArrowDown
} from 'lucide-react'

interface StockMovement {
  id: string
  movement_type: string
  reference_type: string | null
  reference_id: string | null
  reference_no: string | null
  quantity_change: number
  quantity_before: number
  quantity_after: number
  unit_cost: number | null
  total_cost: number | null
  reason: string | null
  notes: string | null
  warehouse_location: string | null
  created_at: string
  distributor_order_no?: string | null
  variant_code?: string | null
  variant_name?: string | null
  product_name?: string | null
  organization_name?: string | null
  organization_code?: string | null
  manufacturer_name?: string | null
  created_by_email?: string | null
  stock_config_id?: string | null
  config_code?: string | null
  config_label?: string | null
  stock_sku?: string | null
  volume_ml?: number | null
  packaging?: string | null
  stock_config_status?: string | null
  configuration_display_label?: string
  is_legacy_configuration?: boolean
  product_variants?: {
    variant_code: string
    variant_name: string
    image_url?: string | null
    base_cost?: number | null
    products?: {
      product_name: string
    } | null
  } | null
  organizations?: {
    org_name: string
    org_code: string
  } | null
  manufacturers?: {
    org_name: string
  } | null
  users?: {
    email: string
  } | null
}

interface StockMovementReportViewProps {
  userProfile: any
  onViewChange?: (view: string) => void
  /** Seeds the search box (deep link: /dashboard?view=stock-movements&id=<reference no>). */
  initialSearch?: string
}

export default function StockMovementReportView({ userProfile, onViewChange, initialSearch }: StockMovementReportViewProps) {
  const [movements, setMovements] = useState<StockMovement[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState(initialSearch || '')
  const [movementTypeFilter, setMovementTypeFilter] = useState('all')
  const [referenceTypeFilter, setReferenceTypeFilter] = useState('all')
  const [productFilter, setProductFilter] = useState('all')
  const [variantFilter, setVariantFilter] = useState('all')
  const [locationFilter, setLocationFilter] = useState('all')
  const [quantityRangeFilter, setQuantityRangeFilter] = useState('all')
  const [stockConfigFilter, setStockConfigFilter] = useState('all')
  const [volumeFilter, setVolumeFilter] = useState('all')
  const [packagingFilter, setPackagingFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [sortColumn, setSortColumn] = useState<string | null>('created_at')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc')
  const [products, setProducts] = useState<any[]>([])
  const [variants, setVariants] = useState<any[]>([])
  const [locations, setLocations] = useState<any[]>([])
  const [stockConfigurations, setStockConfigurations] = useState<any[]>([])

  const { isReady, supabase } = useSupabaseAuth()
  const itemsPerPage = 20

  const numberFormatter = useMemo(() => new Intl.NumberFormat('en-MY'), [])
  const currencyFormatter = useMemo(
    () => new Intl.NumberFormat('en-MY', { style: 'currency', currency: 'MYR' }),
    []
  )

  const formatNumber = (value: number | null | undefined) => {
    if (value === null || value === undefined || Number.isNaN(value)) {
      return '0'
    }
    return numberFormatter.format(value)
  }

  const formatSignedNumber = (value: number | null | undefined) => {
    if (value === null || value === undefined || Number.isNaN(value)) {
      return '0'
    }
    if (value > 0) {
      return `+${numberFormatter.format(value)}`
    }
    if (value < 0) {
      return `-${numberFormatter.format(Math.abs(value))}`
    }
    return '0'
  }

  const formatCurrency = (value: number | null | undefined): string | null => {
    if (value === null || value === undefined || Number.isNaN(value)) {
      return null
    }
    return currencyFormatter.format(value)
  }

  useEffect(() => {
    if (isReady) {
      loadMovements()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, searchQuery, movementTypeFilter, referenceTypeFilter, productFilter, variantFilter, locationFilter, quantityRangeFilter, stockConfigFilter, volumeFilter, packagingFilter, dateFrom, dateTo, currentPage])

  // Authoritative invalidation: reload the movement list once when another view
  // confirms a committed inventory write (e.g. an Opening Balance post).
  useEffect(() => {
    if (!isReady) return
    return subscribeToInventoryDataRefresh(() => {
      loadMovements()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady])

  useEffect(() => {
    if (isReady) {
      fetchProducts()
      fetchVariants()
      fetchLocations()
      supabase.from('inventory_stock_configurations').select('id, config_code, stock_sku, config_label, volume_ml, packaging, status').order('stock_sku').then(({ data }) => setStockConfigurations(data || []))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady])

  const fetchProducts = async () => {
    try {
      // Fetch products that have stock movement records
      const { data, error } = await supabase
        .from('stock_movements')
        .select(`
          product_variants (
            products (
              product_name
            )
          )
        `)

      if (error) throw error

      // Extract unique product names from movement records
      const productNames = new Set<string>()
      data?.forEach((item: any) => {
        const variant = Array.isArray(item.product_variants)
          ? item.product_variants[0]
          : item.product_variants
        const product = variant?.products
          ? Array.isArray(variant.products)
            ? variant.products[0]
            : variant.products
          : null
        if (product?.product_name) {
          productNames.add(product.product_name)
        }
      })

      const uniqueProducts = Array.from(productNames).sort()
      setProducts(uniqueProducts.map(name => ({ product_name: name })))
    } catch (error) {
      console.error('Error fetching products:', error)
    }
  }

  const fetchVariants = async () => {
    try {
      // Fetch variants that have stock movement records
      const { data, error } = await supabase
        .from('stock_movements')
        .select(`
          product_variants (
            variant_code,
            variant_name,
            products (
              product_name
            )
          )
        `)

      if (error) throw error

      // Extract unique variants from movement records
      const variantMap = new Map()
      data?.forEach((item: any) => {
        const variant = Array.isArray(item.product_variants)
          ? item.product_variants[0]
          : item.product_variants
        if (variant?.variant_code) {
          variantMap.set(variant.variant_code, variant)
        }
      })

      const uniqueVariants = Array.from(variantMap.values()).sort((a, b) =>
        a.variant_code.localeCompare(b.variant_code)
      )
      setVariants(uniqueVariants)
    } catch (error) {
      console.error('Error fetching variants:', error)
    }
  }

  const fetchLocations = async () => {
    try {
      const { data, error } = await supabase
        .from('organizations')
        .select('id, org_name, org_code')
        .in('org_type_code', ['WH', 'HQ'])
        .eq('is_active', true)
        .order('org_name')

      if (error) throw error
      setLocations(data || [])
    } catch (error) {
      console.error('Error fetching locations:', error)
    }
  }

  // Filter variants based on selected product
  const filteredVariants = useMemo(() => {
    if (productFilter === 'all') {
      return variants
    }
    return variants.filter(variant => {
      const product = Array.isArray(variant.products)
        ? variant.products[0]
        : variant.products
      return product?.product_name === productFilter
    })
  }, [variants, productFilter])

  // Reset variant filter when product filter changes
  useEffect(() => {
    if (productFilter !== 'all' && variantFilter !== 'all') {
      const isValidVariant = filteredVariants.some(v => v.variant_code === variantFilter)
      if (!isValidVariant) {
        setVariantFilter('all')
      }
    }
  }, [productFilter, variantFilter, filteredVariants])

  const loadMovements = async () => {
    try {
      setLoading(true)
      setLoadError(null)

      // Pre-fetch variants matching the search query if present
      let matchingVariantIds: string[] = []
      let matchingOrderIds: string[] = []
      if (searchQuery) {
        const { data: variants } = await supabase
          .from('product_variants')
          .select('id, variant_code, variant_name, products!inner(product_name)')
          .or(`variant_code.ilike.%${searchQuery}%,variant_name.ilike.%${searchQuery}%,products.product_name.ilike.%${searchQuery}%`)

        if (variants) {
          matchingVariantIds = variants.map(v => v.id)
        }

        // The Reference column shows the current order number (display_doc_no)
        // while reference_no stores the legacy snapshot, so match orders too.
        const { data: matchingOrders } = await supabase
          .from('orders')
          .select('id')
          .or(`display_doc_no.ilike.%${searchQuery}%,order_no.ilike.%${searchQuery}%`)
          .limit(100)
        matchingOrderIds = (matchingOrders || []).map((order: any) => order.id)
      }

      // The report reads the movement view only: it filters rows to the caller's
      // inventory scope and masks costs/balances the caller may not see. The
      // stock_movements table never exposes those columns to the browser.
      let query = (supabase as any)
        .from(STOCK_MOVEMENT_REPORT_SOURCE)
        .select('*')
        .order('created_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: false })
        .range((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage - 1)

      // Apply filters
      if (searchQuery) {
        const textSearchConditions = [
          'reference_no',
          'notes',
          'movement_type',
          'variant_code',
          'variant_name',
          'product_name',
          'organization_name',
          'manufacturer_name',
          'created_by_email'
        ].map((column) => `${column}.ilike.%${searchQuery}%`)

        if (matchingVariantIds.length > 0) {
          textSearchConditions.push(`variant_id.in.(${matchingVariantIds.join(',')})`)
        }
        if (matchingOrderIds.length > 0) {
          textSearchConditions.push(`reference_id.in.(${matchingOrderIds.join(',')})`)
        }

        query = query.or(textSearchConditions.join(','))
      }

      if (movementTypeFilter !== 'all') {
        query = query.eq('movement_type', movementTypeFilter)
      }

      if (referenceTypeFilter !== 'all') {
        query = query.eq('reference_type', referenceTypeFilter)
      }

      if (locationFilter !== 'all') {
        query = query.or(`from_organization_id.eq.${locationFilter},to_organization_id.eq.${locationFilter}`)
      }

      // Note: Product and variant filters are applied client-side after transformation
      // because the view column names might not match exactly with filter values

      if (dateFrom) {
        query = query.gte('created_at', `${dateFrom}T00:00:00`)
      }

      if (dateTo) {
        query = query.lte('created_at', `${dateTo}T23:59:59`)
      }

      const { data, error } = await query

      if (error) {
        if (isStockMovementAccessDenied(error)) {
          setMovements([])
          setLoadError(STOCK_MOVEMENT_ACCESS_DENIED_MESSAGE)
          return
        }
        console.error('Query error details:', error)
        throw error
      }

      if (!data || data.length === 0) {
        setMovements([])
        return
      }

      // Fetch related data separately when not already provided by the view
      const variantIds: string[] = Array.from(new Set<string>(data.map((item: any) => item.variant_id).filter((id: unknown): id is string => typeof id === 'string')))
      const orgIds: string[] = Array.from(new Set<string>([
        ...data.map((item: any) => item.from_organization_id),
        ...data.map((item: any) => item.to_organization_id),
        ...data.map((item: any) => item.manufacturer_id)
      ].filter((id: unknown): id is string => typeof id === 'string')))
      const userIds: string[] = Array.from(new Set<string>(data.map((item: any) => item.created_by).filter((id: unknown): id is string => typeof id === 'string')))
      const stockConfigIds: string[] = Array.from(new Set<string>(
        data.map((item: any) => item.stock_config_id).filter((id: unknown): id is string => typeof id === 'string')
      ))
      // Every order-linked movement (H2M receipts, warranty bonus, D2H allocation,
      // fulfilment, distributor receipt…) resolves its order through reference_id.
      const orderIds: string[] = orderIdsForMovements(data)

      const needsVariantLookup = data.some(
        (item: any) =>
          item.variant_id && !item.variant_code && !item.variant_name && !item.product_name
      )
      const needsOrgLookup = data.some(
        (item: any) =>
          (item.to_organization_id && !item.organization_name && !item.to_organization_name) ||
          (item.from_organization_id && !item.organization_name) ||
          (item.manufacturer_id && !item.manufacturer_name && !item.manufacturer_org_name)
      )
      const needsUserLookup = data.some(
        (item: any) => item.created_by && !item.created_by_email
      )

      // Fetch variants if needed
      const variantsMap = new Map()
      if (variantIds.length > 0) {
        const { data: variants } = await supabase
          .from('product_variants')
          .select('id, variant_code, variant_name, image_url, products(product_name)')
          .in('id', variantIds)

        variants?.forEach((v: any) => {
          variantsMap.set(v.id, v)
        })
      }

      // Fetch organizations if needed
      const orgsMap = new Map()
      if (needsOrgLookup && orgIds.length > 0) {
        const { data: orgs } = await supabase
          .from('organizations')
          .select('id, org_name, org_code')
          .in('id', orgIds)

        orgs?.forEach((o: any) => {
          orgsMap.set(o.id, o)
        })
      }

      // Fetch users if needed
      const usersMap = new Map()
      if (needsUserLookup && userIds.length > 0) {
        const { data: users } = await supabase
          .from('users')
          .select('id, email')
          .in('id', userIds)

        users?.forEach((u: any) => {
          usersMap.set(u.id, u)
        })
      }

      const ordersMap = new Map()
      if (orderIds.length > 0) {
        const { data: orders } = await supabase
          .from('orders')
          .select('id, order_no, display_doc_no')
          .in('id', orderIds)

        orders?.forEach((order: any) => {
          ordersMap.set(order.id, order)
        })
      }

      // Resolve each row through its persisted stock_config_id. This also
      // protects the report from stale/missing denormalized metadata on the
      // movement view without guessing from quantity, sign, or display order.
      const stockConfigurationsMap = new Map()
      if (stockConfigIds.length > 0) {
        const { data: configurations, error: configurationsError } = await supabase
          .from('inventory_stock_configurations')
          .select('id, config_code, config_label, stock_sku, volume_ml, packaging, status')
          .in('id', stockConfigIds)

        if (configurationsError) throw configurationsError
        configurations?.forEach((configuration: any) => {
          stockConfigurationsMap.set(configuration.id, configuration)
        })
      }

      // Transform the data with fetched relations
      const transformedData: StockMovement[] = (data || []).map((item: any) => {
        const variant = variantsMap.get(item.variant_id)
        const fromOrg = orgsMap.get(item.from_organization_id)
        const toOrg = orgsMap.get(item.to_organization_id)
        const mfgOrg = orgsMap.get(item.manufacturer_id)
        const user = usersMap.get(item.created_by)
        const order = item.reference_id ? ordersMap.get(item.reference_id) : null
        const isShipment = item.movement_type === 'order_fulfillment'

        const viewVariantCode = item.variant_code || item.variant_identifier || null
        const viewVariantName = item.variant_name || null
        const viewProductName = item.product_name || item.product_display_name || null

        const resolvedVariantProducts = (() => {
          if (viewProductName) {
            return { product_name: viewProductName }
          }

          if (!variant) return null

          if (Array.isArray(variant.products)) {
            return variant.products[0] || null
          }

          return variant.products || null
        })()

        const variantBaseCost = (() => {
          const viewBaseCost = typeof item.base_cost === 'number' && !Number.isNaN(item.base_cost)
            ? Number(item.base_cost)
            : null
          const lookupBase = variant && typeof variant.base_cost === 'number' && !Number.isNaN(variant.base_cost)
            ? Number(variant.base_cost)
            : null

          if (viewBaseCost !== null) return viewBaseCost
          if (lookupBase !== null) return lookupBase
          return null
        })()

        const productVariants = (() => {
          if (viewVariantCode || viewVariantName || resolvedVariantProducts) {
            return {
              variant_code: viewVariantCode ?? variant?.variant_code ?? '',
              variant_name: viewVariantName ?? variant?.variant_name ?? '',
              image_url: variant?.image_url ?? null,
              base_cost: variantBaseCost,
              products: resolvedVariantProducts
            }
          }

          if (variant) {
            return {
              variant_code: variant.variant_code,
              variant_name: variant.variant_name,
              image_url: variant.image_url ?? null,
              base_cost: variantBaseCost,
              products: resolvedVariantProducts
            }
          }

          return null
        })()

        const quantityChange = Number(item.quantity_change ?? 0)

        const viewOrgName = item.organization_name || item.to_organization_name || null
        const viewOrgCode = item.organization_code || item.to_organization_code || null
        const organizations = (() => {
          // Logic to determine which organization to display as "Location"
          // If quantity is negative (outgoing), show FROM org
          // If quantity is positive (incoming), show TO org

          if (quantityChange < 0) {
            if (fromOrg) return fromOrg
          } else {
            if (toOrg) return toOrg
          }

          if (viewOrgName || viewOrgCode) {
            return {
              org_name: viewOrgName ?? toOrg?.org_name ?? '',
              org_code: viewOrgCode ?? toOrg?.org_code ?? ''
            }
          }

          if (toOrg) {
            return toOrg
          }

          if (fromOrg) {
            return fromOrg
          }

          return null
        })()

        const viewMfgName = item.manufacturer_name || item.manufacturer_org_name || null
        const manufacturers = (() => {
          if (viewMfgName) {
            return { org_name: viewMfgName }
          }

          if (mfgOrg) {
            return { org_name: mfgOrg.org_name }
          }

          return null
        })()

        const viewUserEmail = item.created_by_email || null
        const users = (() => {
          if (viewUserEmail) {
            return { email: viewUserEmail }
          }

          if (user) {
            return user
          }

          return null
        })()

        const resolvedUnitCost = (() => {
          // Force warranty_bonus movements to have 0 cost
          const movementType = item.movement_type ? item.movement_type.toLowerCase().trim() : ''
          if (movementType === 'warranty_bonus') {
            return 0
          }

          const directCost = typeof item.unit_cost === 'number' && !Number.isNaN(item.unit_cost)
            ? Number(item.unit_cost)
            : null
          if (directCost !== null) {
            return directCost
          }
          return null
        })()

        const resolvedTotalCost = (() => {
          const directTotal = typeof item.total_cost === 'number' && !Number.isNaN(item.total_cost)
            ? Number(item.total_cost)
            : null

          return directTotal
        })()

        const joinedConfiguration = Array.isArray(item.inventory_stock_configurations)
          ? item.inventory_stock_configurations[0] ?? null
          : item.inventory_stock_configurations ?? null
        const configuration = item.stock_config_id
          ? stockConfigurationsMap.get(item.stock_config_id) ?? joinedConfiguration
          : null
        const configuredMovement = resolveStockMovementConfiguration({
          ...item,
          config_code: item.config_code ?? joinedConfiguration?.config_code ?? null,
          config_label: item.config_label ?? joinedConfiguration?.config_label ?? null,
          stock_sku: item.stock_sku ?? joinedConfiguration?.stock_sku ?? null,
          volume_ml: item.volume_ml ?? joinedConfiguration?.volume_ml ?? null,
          packaging: item.packaging ?? joinedConfiguration?.packaging ?? null,
          stock_config_status: item.stock_config_status ?? joinedConfiguration?.status ?? null,
          unit_cost: resolvedUnitCost,
          total_cost: resolvedTotalCost,
          reference_no: resolveMovementReferenceNo(item, ordersMap),
          distributor_order_no: isShipment ? canonicalOrderNumber(order) : null,
          product_variants: productVariants,
          organizations,
          manufacturers,
          users,
          from_organization_name: fromOrg?.org_name || item.from_organization_name || null,
          to_organization_name: toOrg?.org_name || item.to_organization_name || null,
        }, configuration)

        return resolveStockMovementHistoryValues(configuredMovement)
      })

      // Apply client-side filtering for product and variant (needed when using stock_movements fallback table)
      let filteredData = transformedData

      if (productFilter !== 'all') {
        filteredData = filteredData.filter(item => {
          const productName = item.product_variants?.products?.product_name
          return productName === productFilter
        })
      }

      if (variantFilter !== 'all') {
        filteredData = filteredData.filter(item => {
          const variantCode = item.product_variants?.variant_code
          return variantCode === variantFilter
        })
      }

      if (quantityRangeFilter !== 'all') {
        filteredData = filteredData.filter(item => {
          const absQty = Math.abs(item.quantity_change)
          switch (quantityRangeFilter) {
            case 'small':
              return absQty >= 1 && absQty <= 50
            case 'medium':
              return absQty >= 51 && absQty <= 200
            case 'large':
              return absQty >= 201 && absQty <= 500
            case 'bulk':
              return absQty > 500
            default:
              return true
          }
        })
      }

      if (stockConfigFilter !== 'all') filteredData = filteredData.filter(item => item.stock_config_id === stockConfigFilter)
      if (volumeFilter !== 'all') filteredData = filteredData.filter(item => String(item.volume_ml ?? 'legacy') === volumeFilter)
      if (packagingFilter !== 'all') filteredData = filteredData.filter(item => String(item.packaging ?? 'legacy') === packagingFilter)

      setMovements(filteredData)
    } catch (error: any) {
      console.error('Failed to load movements:', error?.message ?? error, error?.code ?? '', error?.details ?? '')
      setLoadError('Failed to load stock movements. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleSort = (column: string) => {
    if (sortColumn === column) {
      // Toggle direction if same column
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
    } else {
      // New column, start with ascending
      setSortColumn(column)
      setSortDirection('asc')
    }
    setCurrentPage(1) // Reset to first page
  }

  const getSortedMovements = () => {
    if (!sortColumn) return movements

    const sorted = [...movements].sort((a, b) => {
      let aValue: any
      let bValue: any

      switch (sortColumn) {
        case 'created_at':
          aValue = new Date(a.created_at).getTime()
          bValue = new Date(b.created_at).getTime()
          break
        case 'movement_type':
          aValue = a.movement_type || ''
          bValue = b.movement_type || ''
          break
        case 'product_name':
          aValue = a.product_variants?.products?.product_name || ''
          bValue = b.product_variants?.products?.product_name || ''
          break
        case 'variant_code':
          aValue = a.product_variants?.variant_code || ''
          bValue = b.product_variants?.variant_code || ''
          break
        case 'location':
          aValue = a.organizations?.org_name || ''
          bValue = b.organizations?.org_name || ''
          break
        case 'quantity_change':
          aValue = a.quantity_change
          bValue = b.quantity_change
          break
        case 'quantity_before':
          aValue = a.quantity_before
          bValue = b.quantity_before
          break
        case 'quantity_after':
          aValue = a.quantity_after
          bValue = b.quantity_after
          break
        case 'unit_cost':
          aValue = a.unit_cost || 0
          bValue = b.unit_cost || 0
          break
        case 'reference_no':
          aValue = a.reference_no || ''
          bValue = b.reference_no || ''
          break
        case 'reason':
          aValue = a.reason || ''
          bValue = b.reason || ''
          break
        default:
          return 0
      }

      // Handle string comparison
      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return sortDirection === 'asc'
          ? aValue.localeCompare(bValue)
          : bValue.localeCompare(aValue)
      }

      // Handle number comparison
      if (sortDirection === 'asc') {
        return aValue < bValue ? -1 : aValue > bValue ? 1 : 0
      } else {
        return aValue > bValue ? -1 : aValue < bValue ? 1 : 0
      }
    })

    return sorted
  }

  const renderSortIcon = (column: string) => {
    if (sortColumn !== column) {
      return <ArrowUpDown className="w-4 h-4 ml-1 opacity-40" />
    }
    return sortDirection === 'asc'
      ? <ArrowUp className="w-4 h-4 ml-1" />
      : <ArrowDown className="w-4 h-4 ml-1" />
  }

  const getReasonText = (movement: StockMovement) => {
    if (movement.movement_type === 'order_fulfillment') {
      // If quantity is negative, it's outgoing (from Warehouse). We want to show destination.
      // But movement.organizations now reflects the "Location" column, which is the Source (Warehouse) for negative qty.
      // So we can't use movement.organizations.org_name here if we want to show destination.

      // However, the original logic was:
      // const destination = movement.organizations?.org_name
      // return `Order Fulfillment to ${destination}`

      // Since we changed movement.organizations to be the Source for negative qty, 
      // we need another way to get the destination name if we want to display "to Destination".
      // But we don't have the destination org name easily available in the transformed object unless we add it.

      // For now, let's just say "Order Fulfillment". 
      // Or if we really want, we can try to use the distributor_order_no or similar context.

      return 'Order Fulfillment'
    }

    return movement.reason || ''
  }

  // Movement type rendering is handled by a single, neutral badge component to keep the UI
  // consistent and remove coloured / variant-specific badges. See MovementTypeBadge component.

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleString('en-MY', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  const exportToCSV = () => {
    const headers = ['Date', 'Type', 'Product', 'Variant', 'Location', 'Quantity Change', 'Before', 'After', 'Cost', 'Reference', 'Reason', 'User']
    const rows = movements.map(m => [
      formatDate(m.created_at),
      m.movement_type,
      m.product_variants?.products?.product_name || '',
      m.product_variants?.variant_name || '',
      m.organizations?.org_name || '',
      m.quantity_change,
      m.quantity_before,
      m.quantity_after,
      m.unit_cost || '',
      m.reference_no || '',
      m.reason || '',
      m.users?.email || ''
    ])

    const csv = [headers, ...rows].map(row => row.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `stock-movements-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
  }

  const totalIncrease = movements
    .filter(m => m.quantity_change > 0)
    .reduce((sum, m) => sum + m.quantity_change, 0)

  const totalDecrease = movements
    .filter(m => m.quantity_change < 0)
    .reduce((sum, m) => sum + Math.abs(m.quantity_change), 0)

  return (
    <div className="sera-sc-page space-y-6">
      {/* Header */}
      <div>
        <h1 className="font-display text-3xl font-semibold text-[var(--sera-ink)]">Stock Movement Reports</h1>
        <p className="text-[var(--sera-muted)] mt-1">Complete audit trail of all inventory movements</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        <Card>
          <CardHeader className="pb-2 sm:pb-3">
            <CardTitle className="text-xs sm:text-sm font-medium text-[var(--sera-muted)]">Total Movements</CardTitle>
          </CardHeader>
          <CardContent className="px-3 sm:px-6 pb-3 sm:pb-6">
            <div className="flex items-center gap-2">
              <BarChart3 className="w-4 h-4 sm:w-5 sm:h-5 text-[var(--sera-orange)]" />
              <span className="text-xl sm:text-2xl font-bold">{formatNumber(movements.length)}</span>
            </div>
            <p className="text-xs text-[var(--sera-muted)] mt-1 hidden sm:block">Current page records</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2 sm:pb-3">
            <CardTitle className="text-xs sm:text-sm font-medium text-[var(--sera-muted)]">Stock Additions</CardTitle>
          </CardHeader>
          <CardContent className="px-3 sm:px-6 pb-3 sm:pb-6">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4 sm:w-5 sm:h-5 text-green-600" />
              <span className="text-xl sm:text-2xl font-bold text-green-600">
                {totalIncrease > 0 ? '+' : ''}{formatNumber(totalIncrease)}
              </span>
            </div>
            <p className="text-xs text-[var(--sera-muted)] mt-1 hidden sm:block">Units added</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2 sm:pb-3">
            <CardTitle className="text-xs sm:text-sm font-medium text-[var(--sera-muted)]">Stock Reductions</CardTitle>
          </CardHeader>
          <CardContent className="px-3 sm:px-6 pb-3 sm:pb-6">
            <div className="flex items-center gap-2">
              <TrendingDown className="w-4 h-4 sm:w-5 sm:h-5 text-red-600" />
              <span className="text-xl sm:text-2xl font-bold text-red-600">
                {totalDecrease > 0 ? `-${formatNumber(totalDecrease)}` : '0'}
              </span>
            </div>
            <p className="text-xs text-[var(--sera-muted)] mt-1 hidden sm:block">Units removed</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Filter className="w-5 h-5" />
              Filters & Search
            </CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={exportToCSV}
              className="gap-2"
            >
              <Download className="w-4 h-4" />
              Export CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {/* Search Bar */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" />
              <Input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search by product, variant, reference number, or reason..."
                className="pl-10"
              />
            </div>

            {/* Filter Grid Row 1 */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label className="text-xs font-medium text-[var(--sera-ink)]/80 mb-1.5 block">Movement Type</label>
                <Select value={movementTypeFilter} onValueChange={setMovementTypeFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="All Types" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    <SelectItem value="addition">Addition</SelectItem>
                    <SelectItem value="adjustment">Adjustment</SelectItem>
                    <SelectItem value="transfer_out">Transfer Out</SelectItem>
                    <SelectItem value="transfer_in">Transfer In</SelectItem>
                    <SelectItem value="allocation">Allocation</SelectItem>
                    <SelectItem value="deallocation">Deallocation</SelectItem>
                    <SelectItem value="order_fulfillment">Order Fulfillment</SelectItem>
                    <SelectItem value="order_cancelled">Order Cancelled</SelectItem>
                    <SelectItem value="manual_in">Manual In</SelectItem>
                    <SelectItem value="manual_out">Manual Out</SelectItem>
                    <SelectItem value="scratch_game_out">Scratch Game Out</SelectItem>
                    <SelectItem value="scratch_game_in">Scratch Game In</SelectItem>
                    <SelectItem value="warranty_bonus">Warranty Bonus</SelectItem>
                    <SelectItem value="repack_out">Repack Out</SelectItem>
                    <SelectItem value="repack_in">Repack In</SelectItem>
                    <SelectItem value="spin_wheel_out">Spin Wheel Out</SelectItem>
                    <SelectItem value="spin_wheel_in">Spin Wheel In</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-xs font-medium text-[var(--sera-ink)]/80 mb-1.5 block">Reference Type</label>
                <Select value={referenceTypeFilter} onValueChange={setReferenceTypeFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="All References" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All References</SelectItem>
                    <SelectItem value="order">Order</SelectItem>
                    <SelectItem value="transfer">Transfer</SelectItem>
                    <SelectItem value="adjustment">Adjustment</SelectItem>
                    <SelectItem value="manual">Manual</SelectItem>
                    <SelectItem value="repack">Repack (RPK)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-xs font-medium text-[var(--sera-ink)]/80 mb-1.5 block">Product</label>
                <Select value={productFilter} onValueChange={setProductFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="All Products" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Products</SelectItem>
                    {products.map((product, idx) => (
                      <SelectItem key={idx} value={product.product_name}>
                        {product.product_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-xs font-medium text-[var(--sera-ink)]/80 mb-1.5 block">Variant</label>
                <Select
                  value={variantFilter}
                  onValueChange={setVariantFilter}
                  disabled={productFilter === 'all'}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={productFilter === 'all' ? 'Select a product first' : 'All Variants'} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Variants</SelectItem>
                    {filteredVariants.map((variant) => (
                      <SelectItem key={variant.variant_code} value={variant.variant_code}>
                        {variant.variant_code} - {variant.variant_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-xs font-medium text-[var(--sera-ink)]/80 mb-1.5 block">Location</label>
                <Select value={locationFilter} onValueChange={setLocationFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="All Locations" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Locations</SelectItem>
                    {locations.map((location) => (
                      <SelectItem key={location.id} value={location.id}>
                        {location.org_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Filter Grid Row 2 - Date Range & Quantity */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label className="text-xs font-medium text-[var(--sera-ink)]/80 mb-1.5 block">Stock SKU / Configuration</label>
                <Select value={stockConfigFilter} onValueChange={setStockConfigFilter}><SelectTrigger><SelectValue placeholder="All configurations" /></SelectTrigger><SelectContent><SelectItem value="all">All configurations</SelectItem>{stockConfigurations.map(config => <SelectItem key={config.id} value={config.id}>{config.stock_sku} · {withStockStrengthUnit(config.config_label)}</SelectItem>)}</SelectContent></Select>
              </div>
              <div>
                <label className="text-xs font-medium text-[var(--sera-ink)]/80 mb-1.5 block">Volume</label>
                <Select value={volumeFilter} onValueChange={setVolumeFilter}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All volumes</SelectItem><SelectItem value="20">20 mg</SelectItem><SelectItem value="50">50 mg</SelectItem><SelectItem value="legacy">Standard / Legacy</SelectItem></SelectContent></Select>
              </div>
              <div>
                <label className="text-xs font-medium text-[var(--sera-ink)]/80 mb-1.5 block">Packaging</label>
                <Select value={packagingFilter} onValueChange={setPackagingFilter}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All packaging</SelectItem><SelectItem value="new_box">New Box</SelectItem><SelectItem value="old_box">Old Box</SelectItem><SelectItem value="legacy">Standard / Legacy</SelectItem></SelectContent></Select>
              </div>
              <div>
                <label className="text-xs font-medium text-[var(--sera-ink)]/80 mb-1.5 block">
                  <Calendar className="w-3 h-3 inline mr-1" />
                  Date From
                </label>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                />
              </div>

              <div>
                <label className="text-xs font-medium text-[var(--sera-ink)]/80 mb-1.5 block">
                  <Calendar className="w-3 h-3 inline mr-1" />
                  Date To
                </label>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                />
              </div>

              <div>
                <label className="text-xs font-medium text-[var(--sera-ink)]/80 mb-1.5 block">Quantity Range</label>
                <Select value={quantityRangeFilter} onValueChange={setQuantityRangeFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="All Quantities" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Quantities</SelectItem>
                    <SelectItem value="small">1 - 50 units</SelectItem>
                    <SelectItem value="medium">51 - 200 units</SelectItem>
                    <SelectItem value="large">201 - 500 units</SelectItem>
                    <SelectItem value="bulk">Over 500 units</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-end">
                <Button
                  variant="outline"
                  onClick={() => {
                    setSearchQuery('')
                    setMovementTypeFilter('all')
                    setReferenceTypeFilter('all')
                    setProductFilter('all')
                    setVariantFilter('all')
                    setLocationFilter('all')
                    setQuantityRangeFilter('all')
                    setStockConfigFilter('all')
                    setVolumeFilter('all')
                    setPackagingFilter('all')
                    setDateFrom('')
                    setDateTo('')
                    setCurrentPage(1)
                  }}
                  className="w-full"
                >
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Clear All Filters
                </Button>
              </div>
            </div>

            {/* Active Filters Display */}
            {(searchQuery || movementTypeFilter !== 'all' || referenceTypeFilter !== 'all' || productFilter !== 'all' || variantFilter !== 'all' || locationFilter !== 'all' || quantityRangeFilter !== 'all' || stockConfigFilter !== 'all' || volumeFilter !== 'all' || packagingFilter !== 'all' || dateFrom || dateTo) && (
              <div className="flex items-center gap-2 flex-wrap pt-2 border-t">
                <span className="text-sm text-[var(--sera-muted)] font-medium">Active:</span>
                {searchQuery && <Badge variant="secondary">Search: {searchQuery}</Badge>}
                {movementTypeFilter !== 'all' && <Badge variant="secondary">Type</Badge>}
                {referenceTypeFilter !== 'all' && <Badge variant="secondary">Reference</Badge>}
                {productFilter !== 'all' && <Badge variant="secondary">Product</Badge>}
                {variantFilter !== 'all' && <Badge variant="secondary">Variant</Badge>}
                {locationFilter !== 'all' && <Badge variant="secondary">Location</Badge>}
                {quantityRangeFilter !== 'all' && <Badge variant="secondary">Quantity Range</Badge>}
                {stockConfigFilter !== 'all' && <Badge variant="secondary">Stock SKU</Badge>}
                {volumeFilter !== 'all' && <Badge variant="secondary">Volume</Badge>}
                {packagingFilter !== 'all' && <Badge variant="secondary">Packaging</Badge>}
                {dateFrom && <Badge variant="secondary">From: {dateFrom}</Badge>}
                {dateTo && <Badge variant="secondary">To: {dateTo}</Badge>}
              </div>
            )}
          </div>
        </CardContent>
      </Card>



      {/* Movements Table */}
      <Card>
        <CardHeader>
          <CardTitle>Movement History</CardTitle>
          <CardDescription>
            {loading ? 'Loading...' : `Showing ${movements.length} movements`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead
                    className="cursor-pointer hover:bg-gray-100 select-none"
                    onClick={() => handleSort('created_at')}
                  >
                    <div className="flex items-center">
                      Date/Time
                      {renderSortIcon('created_at')}
                    </div>
                  </TableHead>
                  <TableHead
                    className="cursor-pointer hover:bg-gray-100 select-none"
                    onClick={() => handleSort('movement_type')}
                  >
                    <div className="flex items-center">
                      Type
                      {renderSortIcon('movement_type')}
                    </div>
                  </TableHead>
                  <TableHead
                    className="cursor-pointer hover:bg-gray-100 select-none"
                    onClick={() => handleSort('product_name')}
                  >
                    <div className="flex items-center">
                      Product Name
                      {renderSortIcon('product_name')}
                    </div>
                  </TableHead>
                  <TableHead
                    className="cursor-pointer hover:bg-gray-100 select-none"
                    onClick={() => handleSort('location')}
                  >
                    <div className="flex items-center">
                      Location
                      {renderSortIcon('location')}
                    </div>
                  </TableHead>
                  <TableHead
                    className="cursor-pointer hover:bg-gray-100 select-none text-right"
                    onClick={() => handleSort('quantity_change')}
                  >
                    <div className="flex items-center justify-end">
                      Change
                      {renderSortIcon('quantity_change')}
                    </div>
                  </TableHead>
                  <TableHead
                    className="cursor-pointer hover:bg-gray-100 select-none text-right"
                    onClick={() => handleSort('quantity_before')}
                  >
                    <div className="flex items-center justify-end">
                      Before
                      {renderSortIcon('quantity_before')}
                    </div>
                  </TableHead>
                  <TableHead
                    className="cursor-pointer hover:bg-gray-100 select-none text-right"
                    onClick={() => handleSort('quantity_after')}
                  >
                    <div className="flex items-center justify-end">
                      After
                      {renderSortIcon('quantity_after')}
                    </div>
                  </TableHead>
                  <TableHead
                    className="cursor-pointer hover:bg-gray-100 select-none text-right"
                    onClick={() => handleSort('unit_cost')}
                  >
                    <div className="flex items-center justify-end">
                      Cost
                      {renderSortIcon('unit_cost')}
                    </div>
                  </TableHead>
                  <TableHead
                    className="cursor-pointer hover:bg-gray-100 select-none"
                    onClick={() => handleSort('reference_no')}
                  >
                    <div className="flex items-center">
                      Reference
                      {renderSortIcon('reference_no')}
                    </div>
                  </TableHead>
                  <TableHead
                    className="cursor-pointer hover:bg-gray-100 select-none"
                    onClick={() => handleSort('reason')}
                  >
                    <div className="flex items-center">
                      Reason
                      {renderSortIcon('reason')}
                    </div>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-8">
                      Loading movements...
                    </TableCell>
                  </TableRow>
                ) : movements.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-8 text-[var(--sera-muted)]">
                      {loadError ?? 'No movements found'}
                    </TableCell>
                  </TableRow>
                ) : (
                  getSortedMovements().map((movement) => (
                    <TableRow key={movement.id}>
                      <TableCell className="text-xs">
                        {formatDate(movement.created_at)}
                      </TableCell>
                      <TableCell>
                        <MovementTypeBadge type={movement.movement_type} reason={movement.reason} />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <ProductThumbnail
                            src={movement.product_variants?.image_url ?? undefined}
                            alt={movement.product_variants?.variant_name || movement.product_variants?.products?.product_name || 'Product image'}
                            size={36}
                          />
                          <div>
                            <p className="text-xs font-medium text-gray-900">
                              {movement.product_variants?.products?.product_name || 'N/A'}
                            </p>
                            <p className="text-xs text-[var(--sera-muted)]">
                              {(() => {
                                const variantName = movement.product_variants?.variant_name || ''
                                // Extract text between [ and ] if it exists, otherwise show full name
                                const match = variantName.match(/\[(.*?)\]/)
                                return match ? `[ ${match[1]} ]` : variantName
                              })()}
                            </p>
                            {movement.configuration_display_label && (
                              <p className={`text-xs font-medium ${movement.is_legacy_configuration ? 'text-amber-700' : 'text-blue-700'}`}>
                                {withStockStrengthUnit(movement.configuration_display_label)}
                              </p>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        {(() => {
                          if (movement.movement_type === 'scratch_game_out') {
                            return 'Serapod Technology Sdn. Bhd'
                          }
                          if (movement.movement_type === 'scratch_game_in') {
                            return movement.organizations?.org_name || 'Serapod Warehouse'
                          }
                          const locationName = movement.organizations?.org_name || 'N/A'
                          const fromName = (movement as any).from_organization_name as string | undefined
                          const toName = (movement as any).to_organization_name as string | undefined
                          return (
                            <div>
                              <p>{locationName}</p>
                              {(fromName || toName) && (fromName !== toName) && (
                                <p className="text-[11px] text-[var(--sera-muted)]">
                                  {fromName || '—'} → {toName || '—'}
                                </p>
                              )}
                            </div>
                          )
                        })()}
                        {movement.warehouse_location && (
                          <p className="text-xs text-[var(--sera-muted)]">{movement.warehouse_location}</p>
                        )}
                      </TableCell>
                      <TableCell
                        className={`text-xs text-right font-semibold ${movement.quantity_change > 0
                            ? 'text-green-600'
                            : movement.quantity_change < 0
                              ? 'text-red-600'
                              : 'text-[var(--sera-muted)]'
                          }`}
                      >
                        {formatSignedNumber(movement.quantity_change)}
                      </TableCell>
                      <TableCell className="text-xs text-right text-[var(--sera-muted)]">
                        {formatNumber(movement.quantity_before)}
                      </TableCell>
                      <TableCell className="text-xs text-right font-semibold">
                        {formatNumber(movement.quantity_after)}
                      </TableCell>
                      <TableCell className="text-xs text-right">
                        {(() => {
                          const formattedUnitCost = formatCurrency(movement.unit_cost)
                          const formattedTotalCost = formatSignedMovementImpact(movement.total_cost)

                          if (!formattedUnitCost) {
                            return '-'
                          }

                          return (
                            <div>
                              <p className="text-xs">{formattedUnitCost}</p>
                              {formattedTotalCost && (
                                <p className={`text-xs ${movement.total_cost && movement.total_cost < 0 ? 'text-red-600' : 'text-[var(--sera-muted)]'}`}>
                                  Total impact: {formattedTotalCost}
                                </p>
                              )}
                            </div>
                          )
                        })()}
                      </TableCell>
                      <TableCell className="text-xs">
                        {movement.reference_no ? (
                          <span className="text-xs font-medium">{movement.reference_no}</span>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                        {movement.reference_type && (
                          <p className="text-xs text-[var(--sera-muted)] mt-1">{movement.reference_type}</p>
                        )}
                      </TableCell>
                      <TableCell className="text-xs max-w-xs">
                        {(() => {
                          const reasonText = getReasonText(movement)
                          if (!reasonText) return null
                          return (
                            <p className="text-[var(--sera-ink)]/80 truncate" title={reasonText}>
                              {reasonText}
                            </p>
                          )
                        })()}
                        {movement.users && (
                          <p className="text-xs text-[var(--sera-muted)] mt-1">
                            By: {movement.users.email.split('@')[0]}
                          </p>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between mt-6">
            <p className="text-sm text-[var(--sera-muted)]">
              Page {currentPage}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                disabled={currentPage === 1}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCurrentPage(currentPage + 1)}
                disabled={movements.length < itemsPerPage}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
