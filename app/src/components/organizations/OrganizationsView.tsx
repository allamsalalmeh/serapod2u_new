'use client'

import { useState, useEffect } from 'react'
import { useSupabaseAuth } from '@/lib/hooks/useSupabaseAuth'
import { useToast } from '@/components/ui/use-toast'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { normalizePersistedOrganizationLogo, resolveOrganizationLogoUrl } from '@/lib/organizations/logo'
import {
  Building2,
  Search,
  Filter,
  Plus,
  Edit,
  Eye,
  MapPin,
  Phone,
  Mail,
  Calendar,
  Users,
  Package,
  LayoutGrid,
  List,
  Link as LinkIcon,
  Trash2,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  AlertTriangle,
  X,
  Loader2,
  CheckCircle,
  XCircle,
  Info,
  ChevronLeft,
  ChevronRight
} from 'lucide-react'
import SupplyChainPageHeader from '@/modules/supply-chain/components/SupplyChainPageHeader'
import Link from 'next/link'
import ManufacturerCategoryBadges from './ManufacturerCategoryBadges'
import {
  loadCategoryOptions,
  loadManufacturerCategorySummaries,
  manufacturerProductsHref,
  matchesManufacturerCategoryFilter,
  type CategoryOption,
  type ManufacturerCategorySummary,
} from '@/lib/organizations/manufacturer-categories'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import ShopDistributorsManager from '@/components/shops/ShopDistributorsManager'
import DistributorShopsManager from '@/components/distributors/DistributorShopsManager'
import {
  SeraModalOverlay,
  SeraModalPanel,
  SeraModalHeader,
  SeraModalBody,
} from '@/components/ui/sera-modal'
import { buildSetDefaultFulfillmentConfirmMessage } from '@/lib/organizations/distributor-fulfillment-default'
import { ALL_STATES_VALUE, deriveStateOptions, matchesStateFilter } from '@/lib/organizations/state-filter'

interface UserProfile {
  id: string
  email: string
  role_code: string
  organization_id: string
  is_active: boolean
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

interface Organization {
  id: string
  org_code: string
  org_name: string
  org_name_short: string
  org_type_code: string
  parent_org_id: string | null
  default_warehouse_org_id: string | null
  contact_name: string
  contact_phone: string
  contact_email: string
  address: string
  address_line2: string
  city: string
  state_id: string | null
  district_id: string | null
  postal_code: string
  country_code: string
  is_active: boolean
  is_verified: boolean
  created_at: string
  updated_at: string
  logo_url: string | null
  branch?: string | null
  org_types: {
    type_name: string
    description: string
  }
  parent_org?: {
    org_name: string
    org_code: string
  }
  states?: {
    state_name: string
  }
  children_count?: number
  users_count?: number
  products_count?: number
  distributors_count?: number
  shops_count?: number
  orders_count?: number
  loyalty_program_organization_memberships?: Array<{
    status: string | null
    loyalty_programs?: { code: string | null; name: string | null } | Array<{ code: string | null; name: string | null }> | null
  }>
}

interface OrganizationsViewProps {
  userProfile: UserProfile
  onViewChange?: (view: string) => void
}

type SortField = 'org_name' | 'org_type_code' | 'contact_name' | 'state' | 'is_active'
type SortDirection = 'asc' | 'desc'
const PROGRAM_FILTER_OPTIONS = [
  { value: 'all', label: 'All Programs' },
  { value: 'Cellera', label: 'Cellera' },
  { value: 'Ellbow', label: 'Ellbow' },
  { value: 'Cellera + Ellbow', label: 'Cellera + Ellbow' },
  { value: 'Not Enrolled', label: 'Not Enrolled' },
] as const

interface BlockingRecord {
  table_name: string
  display_name: string
  count: number
  description: string
  action: string
  priority: number
  auto_delete?: boolean
  can_force_delete?: boolean
  records?: Array<{
    id: string
    reference: string
    code?: string
    status?: string
    type?: string
    role?: string
  }> | null
}

interface DependencyCheckResult {
  success: boolean
  org_id?: string
  org_name?: string
  org_code?: string
  org_type?: string
  can_delete?: boolean
  has_blocking_records?: boolean
  blocking_records?: BlockingRecord[]
  deletion_order?: string
  error?: string
  error_code?: string
}

function normalizePhoneForSearch(value?: string | null) {
  return String(value || '').replace(/\D/g, '')
}

function matchesOrganizationSearch(org: Organization, searchValue: string) {
  const normalizedSearch = searchValue.trim().toLowerCase()
  if (!normalizedSearch) return true

  const normalizedDigits = normalizePhoneForSearch(searchValue)

  return (
    org.org_name.toLowerCase().includes(normalizedSearch) ||
    org.org_code.toLowerCase().includes(normalizedSearch) ||
    (org.contact_name && org.contact_name.toLowerCase().includes(normalizedSearch)) ||
    (org.contact_phone && (
      org.contact_phone.toLowerCase().includes(normalizedSearch) ||
      (normalizedDigits.length > 0 && normalizePhoneForSearch(org.contact_phone).includes(normalizedDigits))
    ))
  )
}

function getSingleRelation<T>(relation: T | T[] | null | undefined): T | null {
  if (Array.isArray(relation)) return relation[0] ?? null
  return relation ?? null
}

function getSupabaseErrorFields(error: unknown) {
  if (!error || typeof error !== 'object') {
    return {
      message: error instanceof Error ? error.message : String(error || 'Unknown error'),
      code: null,
      details: null,
      hint: null,
    }
  }

  const supabaseError = error as {
    message?: unknown
    code?: unknown
    details?: unknown
    hint?: unknown
  }

  return {
    message: typeof supabaseError.message === 'string' ? supabaseError.message : 'Unknown Supabase error',
    code: typeof supabaseError.code === 'string' ? supabaseError.code : null,
    details: typeof supabaseError.details === 'string' ? supabaseError.details : null,
    hint: typeof supabaseError.hint === 'string' ? supabaseError.hint : null,
  }
}

function logSupabaseError(context: string, error: unknown) {
  console.error(context, getSupabaseErrorFields(error))
}

function getProgramLabel(org: Organization) {
  const activeCodes = new Set(
    (org.loyalty_program_organization_memberships || [])
      .filter((membership) => (membership.status || 'active') === 'active')
      .map((membership) => getSingleRelation(membership.loyalty_programs)?.code)
      .filter((code): code is string => code === 'cellera' || code === 'ellbow'),
  )

  if (activeCodes.has('cellera') && activeCodes.has('ellbow')) return 'Cellera + Ellbow'
  if (activeCodes.has('cellera')) return 'Cellera'
  if (activeCodes.has('ellbow')) return 'Ellbow'
  return 'Not Enrolled'
}

export default function OrganizationsView({ userProfile, onViewChange }: OrganizationsViewProps) {
  const [organizations, setOrganizations] = useState<Organization[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [filterType, setFilterType] = useState<string>('all')
  const [filterStatus, setFilterStatus] = useState<string>('all')
  const [filterProgram, setFilterProgram] = useState<string>('all')
  const [filterState, setFilterState] = useState<string>(ALL_STATES_VALUE)
  // Manufacturer classification: 'all' | 'unclassified' | category id. Summaries: undefined = loading, null = unavailable.
  const [filterCategory, setFilterCategory] = useState<string>('all')
  const [categorySummaries, setCategorySummaries] = useState<Map<string, ManufacturerCategorySummary> | null | undefined>(undefined)
  const [categoryFilterOptions, setCategoryFilterOptions] = useState<CategoryOption[]>([])
  const [viewMode, setViewMode] = useState<'card' | 'list'>('list')
  const [sortField, setSortField] = useState<SortField>('org_name')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [selectedShopForDistributors, setSelectedShopForDistributors] = useState<Organization | null>(null)
  const [selectedDistributorForShops, setSelectedDistributorForShops] = useState<Organization | null>(null)
  const [shopsWithDistributors, setShopsWithDistributors] = useState<Set<string>>(new Set())
  const [distributorsWithShops, setDistributorsWithShops] = useState<Set<string>>(new Set())
  const [shopLinkedDistributors, setShopLinkedDistributors] = useState<Map<string, string[]>>(new Map())
  const [distributorLinkedShops, setDistributorLinkedShops] = useState<Map<string, string[]>>(new Map())
  const [deleteConfirmation, setDeleteConfirmation] = useState<{ show: boolean; orgId: string | null }>({ show: false, orgId: null })
  const [editingField, setEditingField] = useState<{ orgId: string; field: 'name' | 'phone' } | null>(null)
  const [editValue, setEditValue] = useState('')
  const [isSavingQuickEdit, setIsSavingQuickEdit] = useState(false)
  // Pagination state
  const [currentPage, setCurrentPage] = useState(1)
  const [itemsPerPage, setItemsPerPage] = useState(10)
  // Delete dependencies modal state
  const [deleteDependenciesModal, setDeleteDependenciesModal] = useState<{
    show: boolean
    loading: boolean
    deleting: boolean
    orgId: string | null
    data: DependencyCheckResult | null
  }>({ show: false, loading: false, deleting: false, orgId: null, data: null })
  const [deleteOtpStep, setDeleteOtpStep] = useState<'confirm' | 'otp' | 'deleting'>('confirm')
  const [deleteOtpCode, setDeleteOtpCode] = useState('')
  const [deleteOtpCodeId, setDeleteOtpCodeId] = useState('')
  const [deleteOtpMaskedPhone, setDeleteOtpMaskedPhone] = useState('')
  const [deleteOtpChannel, setDeleteOtpChannel] = useState<'email' | 'whatsapp'>('whatsapp')
  const [deleteOtpError, setDeleteOtpError] = useState('')
  const [deleteOtpSending, setDeleteOtpSending] = useState(false)
  const { isReady, supabase } = useSupabaseAuth()
  const { toast } = useToast()
  const canDeleteOrganizations = (userProfile.roles?.role_level ?? Number.MAX_SAFE_INTEGER) <= 10
  const [isHqAdmin, setIsHqAdmin] = useState(false)

  useEffect(() => {
    if (!isReady) return
    void supabase.rpc('is_hq_admin').then(({ data, error }) => {
      if (error) {
        setIsHqAdmin((userProfile.roles?.role_level ?? Number.MAX_SAFE_INTEGER) <= 10)
        return
      }
      setIsHqAdmin(Boolean(data))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady])

  useEffect(() => {
    if (isReady) {
      // Check if we need to refresh links after creating/editing organization
      const needsRefresh = sessionStorage.getItem('needsLinkRefresh')
      if (needsRefresh === 'true') {
        console.log('🔄 Refresh flag detected, will refresh link data...')

        sessionStorage.removeItem('needsLinkRefresh')

        // Longer delay to ensure DB writes are complete and indexes updated (1.5 seconds)
        setTimeout(() => {
          console.log('🔄 Refreshing organization and link data...')
          fetchOrganizations()
          checkShopDistributorLinks()
          checkDistributorShopLinks()
        }, 1500)
      } else {
        fetchOrganizations()
        checkShopDistributorLinks()
        checkDistributorShopLinks()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady])

  const checkShopDistributorLinks = async () => {
    try {
      const { data, error } = await supabase
        .from('shop_distributors')
        .select(`
          shop_id,
          distributor_id,
          distributor:organizations!shop_distributors_distributor_id_fkey(org_name)
        `)
        .eq('is_active', true)

      if (error) throw error

      console.log('📊 Shop-Distributor links found:', data?.length || 0, data)

      const shopIds = new Set((data || []).map((sd: { shop_id: string }) => sd.shop_id))
      setShopsWithDistributors(shopIds)

      // Build map of shop_id -> [distributor names]
      const shopDistMap = new Map<string, string[]>()
        ; (data || []).forEach((sd: any) => {
          if (!shopDistMap.has(sd.shop_id)) {
            shopDistMap.set(sd.shop_id, [])
          }
          if (sd.distributor?.org_name) {
            shopDistMap.get(sd.shop_id)!.push(sd.distributor.org_name)
          }
        })
      setShopLinkedDistributors(shopDistMap)
      console.log('🏪 Shops with distributors:', Array.from(shopIds))
    } catch (error) {
      console.error('Error checking shop distributor links:', error)
    }
  }

  const checkDistributorShopLinks = async () => {
    try {
      const { data, error } = await supabase
        .from('shop_distributors')
        .select(`
          shop_id,
          distributor_id,
          shop:organizations!shop_distributors_shop_id_fkey(org_name)
        `)
        .eq('is_active', true)

      if (error) throw error

      console.log('📊 Distributor-Shop links found:', data?.length || 0, data)

      const distributorIds = new Set((data || []).map((sd: { distributor_id: string }) => sd.distributor_id))
      setDistributorsWithShops(distributorIds)

      // Build map of distributor_id -> [shop names]
      const distShopMap = new Map<string, string[]>()
        ; (data || []).forEach((sd: any) => {
          if (!distShopMap.has(sd.distributor_id)) {
            distShopMap.set(sd.distributor_id, [])
          }
          if (sd.shop?.org_name) {
            distShopMap.get(sd.distributor_id)!.push(sd.shop.org_name)
          }
        })
      setDistributorLinkedShops(distShopMap)
      console.log('🚚 Distributors with shops:', Array.from(distributorIds))
    } catch (error) {
      console.error('Error checking distributor shop links:', error)
    }
  }

  const fetchOrganizations = async () => {
    if (!isReady) return

    try {
      setLoading(true)

      // Build the query based on user role and organization
      let query = (supabase as any)
        .from('organizations')
        .select(`
          *,
          org_types:organization_types(type_name, type_description),
          parent_org:organizations!parent_org_id(org_name, org_code),
          payment_terms(term_name, deposit_percentage, balance_percentage),
          states(state_name)
        `)
        .eq('is_active', true)  // Only fetch active organizations

      // Apply access control based on user role
      // Super admin (role_level 1-50) can see all organizations
      // Others see their org and its children
      if (userProfile.roles.role_level > 50) {
        // Non-super admin: see own org and children
        query = query.or(`id.eq.${userProfile.organization_id},parent_org_id.eq.${userProfile.organization_id}`)
      }
      // If role_level <= 50 (Super Admin), no filter applied - sees all

      const { data, error } = await query.order('created_at', { ascending: false })

      if (error) {
        logSupabaseError('Error fetching organizations:', error)
        return
      }

      // Get all org IDs for batch stats query
      const orgIds = (data as any[])?.map((org: any) => org.id) || []

      let loyaltyMembershipsByOrgId = new Map<string, any[]>()
      if (orgIds.length > 0) {
        try {
          const response = await fetch('/api/loyalty/memberships/organizations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organizationIds: orgIds }),
          })
          const membershipPayload = await response.json().catch(() => null)

          if (!response.ok) {
            logSupabaseError('Error fetching organization loyalty memberships:', membershipPayload?.error || {
              message: `Request failed with status ${response.status}`,
              details: response.statusText,
            })
          }

          const membershipData = response.ok && Array.isArray(membershipPayload?.memberships)
            ? membershipPayload.memberships
            : []

          loyaltyMembershipsByOrgId = (membershipData || []).reduce((map: Map<string, any[]>, membership: any) => {
            const orgMemberships = map.get(membership.member_organization_id) || []
            orgMemberships.push({
              status: membership.status,
              loyalty_programs: membership.loyalty_programs,
            })
            map.set(membership.member_organization_id, orgMemberships)
            return map
          }, new Map<string, any[]>())
        } catch (membershipError) {
          logSupabaseError('Error fetching organization loyalty memberships:', membershipError)
        }
      }

      console.log('🔍 Fetching stats for org IDs:', orgIds)

      // Use the database function to get all stats in ONE efficient query
      const { data: statsData, error: statsError } = await (supabase as any)
        .rpc('get_org_stats_batch', { p_org_ids: orgIds })

      if (statsError) {
        logSupabaseError('❌ Error fetching org stats:', statsError)
      } else {
        console.log('✅ Stats data received:', statsData)
      }

      // Create a map of stats by org_id for quick lookup
      const statsMap = new Map<string, any>()
        ; (statsData || []).forEach((stat: any) => {
          console.log(`📊 Org ${stat.org_type_code}:`, {
            org_id: stat.org_id,
            distributors_count: stat.distributors_count,
            shops_count: stat.shops_count,
            products_count: stat.products_count,
            users_count: stat.users_count,
            orders_count: stat.orders_count
          })
          statsMap.set(stat.org_id, stat)
        })

      console.log('📊 Organization Stats:', statsMap)

      // Transform the data to match our interface with stats
      const transformedData = (data as any[])?.map((org: any) => {
        const stats = statsMap.get(org.id) || {
          children_count: 0,
          users_count: 0,
          products_count: 0,
          distributors_count: 0,
          shops_count: 0,
          orders_count: 0
        }

        return {
          ...org,
          logo_url: normalizePersistedOrganizationLogo(org.logo_url),
          org_types: Array.isArray(org.org_types) ? org.org_types[0] : org.org_types,
          parent_org: Array.isArray(org.parent_org) ? org.parent_org[0] : org.parent_org,
          loyalty_program_organization_memberships: loyaltyMembershipsByOrgId.get(org.id) || [],
          children_count: stats.children_count,
          users_count: stats.users_count,
          products_count: stats.products_count,
          distributors_count: stats.distributors_count,
          shops_count: stats.shops_count,
          orders_count: stats.orders_count
        }
      }) || []

      setOrganizations(transformedData)
      void refreshCategorySummaries(transformedData)
    } catch (error) {
      console.error('Error in fetchOrganizations:', error)
    } finally {
      setLoading(false)
    }
  }

  // One aggregated row per loaded manufacturer (computed in SQL; products are never loaded here).
  const refreshCategorySummaries = async (orgs: Organization[]) => {
    const manufacturerIds = orgs.filter((org) => org.org_type_code === 'MFG').map((org) => org.id)
    const [summaries, options] = await Promise.all([
      loadManufacturerCategorySummaries(supabase, manufacturerIds),
      loadCategoryOptions(supabase).catch((loadError) => {
        console.error('Error fetching product categories:', loadError)
        return [] as CategoryOption[]
      }),
    ])
    setCategorySummaries(summaries)
    setCategoryFilterOptions(options)
  }

  useEffect(() => {
    if (filterType !== 'MFG') setFilterCategory('all')
  }, [filterType])

  // State filter options are derived from the loaded records so the dropdown
  // reflects the states actually present (no hardcoded list).
  const stateFilterOptions = deriveStateOptions(organizations)

  const filteredOrganizations = organizations.filter(org => {
    const matchesSearch = matchesOrganizationSearch(org, searchTerm)

    const matchesType = filterType === 'all' || org.org_type_code === filterType
    const matchesStatus =
      filterStatus === 'all' ||
      (filterStatus === 'active' && org.is_active) ||
      (filterStatus === 'inactive' && !org.is_active)
    const matchesProgram =
      filterProgram === 'all' || getProgramLabel(org) === filterProgram
    const matchesState = matchesStateFilter(org, filterState)

    return matchesSearch && matchesType && matchesStatus && matchesProgram && matchesState && matchesManufacturerCategoryFilter(org, filterCategory, categorySummaries)
  }).sort((a, b) => {
    let aVal: any = a[sortField]
    let bVal: any = b[sortField]

    // Handle null values
    if (aVal === null || aVal === undefined) return 1
    if (bVal === null || bVal === undefined) return -1

    // Handle different data types
    if (sortField === 'org_name' || sortField === 'contact_name') {
      aVal = (aVal || '').toLowerCase()
      bVal = (bVal || '').toLowerCase()
    } else if (sortField === 'state') {
      // Sort by state name
      aVal = (a.states?.state_name || '').toLowerCase()
      bVal = (b.states?.state_name || '').toLowerCase()
    } else if (sortField === 'org_type_code') {
      // Sort by type name instead of code
      aVal = a.org_types?.type_name || a.org_type_code
      bVal = b.org_types?.type_name || b.org_type_code
      aVal = aVal.toLowerCase()
      bVal = bVal.toLowerCase()
    } else if (sortField === 'is_active') {
      aVal = aVal ? 1 : 0
      bVal = bVal ? 1 : 0
    }

    if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1
    if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1
    return 0
  })

  // Pagination calculations
  const totalOrganizations = filteredOrganizations.length
  const totalPages = Math.ceil(totalOrganizations / itemsPerPage)
  const startIndex = (currentPage - 1) * itemsPerPage
  const endIndex = startIndex + itemsPerPage
  const paginatedOrganizations = filteredOrganizations.slice(startIndex, endIndex)

  // Reset to first page when filters change
  useEffect(() => {
    setCurrentPage(1)
  }, [searchTerm, filterType, filterStatus, filterProgram, filterState, filterCategory])

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      // Toggle direction if clicking same field
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
    } else {
      // Set new field with default ascending direction
      setSortField(field)
      setSortDirection('asc')
    }
  }

  const getOrgTypeColor = (typeCode: string) => {
    const colors = {
      'HQ': 'bg-purple-100 text-purple-700',
      'MFG': 'bg-[var(--sera-orange)]/10 text-[var(--sera-orange-deep)]',
      'DIST': 'bg-green-100 text-green-700',
      'WH': 'bg-orange-100 text-orange-700',
      'SHOP': 'bg-pink-100 text-pink-700'
    }
    return colors[typeCode as keyof typeof colors] || 'bg-gray-100 text-gray-700'
  }

  const getStatusColor = (isActive: boolean, isVerified: boolean) => {
    if (!isActive) return 'bg-red-100 text-red-700'
    // Active organizations show green (verified status is secondary)
    return 'bg-green-100 text-green-700'
  }

  const getStatusText = (isActive: boolean, isVerified: boolean) => {
    if (!isActive) return 'Inactive'
    // Organizations that are active are considered Active (verified status is secondary)
    return 'Active'
  }

  const getOrgInitials = (name: string) => {
    if (!name) return 'ORG'
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
  }

  const handleEditOrganization = (org: Organization) => {
    // Store selected org for parent to handle
    sessionStorage.setItem('selectedOrgId', org.id)
    sessionStorage.setItem('selectedOrgType', org.org_type_code)

    // Only HQ goes to Settings
    if (org.org_type_code === 'HQ') {
      if (onViewChange) {
        onViewChange('edit-organization-hq')
      }
    } else {
      // Other org types go to dedicated edit page
      if (onViewChange) {
        onViewChange('edit-organization')
      }
    }
  }

  const handleViewOrganization = (orgId: string) => {
    sessionStorage.setItem('selectedOrgId', orgId)
    if (onViewChange) {
      onViewChange('view-organization')
    }
  }

  const handleSetDefaultWarehouse = async (warehouse: Organization) => {
    try {
      if (!isHqAdmin) {
        toast({
          title: "Permission denied",
          description: "Only HQ Admin can change the default fulfillment warehouse. Open the warehouse Edit page to manage this setting.",
          variant: "destructive"
        })
        return
      }

      // Find the parent HQ organization
      const parentHQ = organizations.find(o => o.id === warehouse.parent_org_id && o.org_type_code === 'HQ')

      if (!parentHQ) {
        toast({
          title: "Error",
          description: "Parent HQ not found. Only warehouses under an HQ can be set as default.",
          variant: "destructive"
        })
        return
      }

      // Confirm with user
      const isAlreadyDefault = parentHQ.default_warehouse_org_id === warehouse.id
      if (isAlreadyDefault) {
        toast({
          title: "Already Default",
          description: `${warehouse.org_name} is already the default fulfillment warehouse for ${parentHQ.org_name}.`,
        })
        return
      }

      const confirmMsg = buildSetDefaultFulfillmentConfirmMessage(warehouse.org_name, parentHQ.org_name)
      if (!confirm(confirmMsg)) return

      // Call the API to set default warehouse on the parent HQ
      const response = await fetch('/api/organizations/set-default-warehouse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hq_org_id: parentHQ.id,
          warehouse_org_id: warehouse.id
        })
      })

      const result = await response.json()

      if (!response.ok) {
        throw new Error(result.error || 'Failed to set default warehouse')
      }

      toast({
        title: "✓ Default fulfillment warehouse updated",
        description: `${warehouse.org_name} is now the default for new distributor orders under ${parentHQ.org_name}.`,
      })

      // Refresh organizations to show updated default status
      fetchOrganizations()

    } catch (error: any) {
      console.error('Error setting default warehouse:', error)
      toast({
        title: "Error",
        description: error.message || 'Failed to set default warehouse',
        variant: "destructive"
      })
    }
  }

  const showDeleteFailureToast = (data: any, orgName: string) => {
    if (!data) {
      toast({
        title: "Delete Failed",
        description: 'No response received from server. There may be related records blocking deletion.',
        variant: "destructive"
      })
      return
    }

    if (data.error_code === 'HAS_ORDERS') {
      toast({
        title: "Cannot Delete",
        description: `${orgName} has ${data.order_count} order(s). Organizations with orders cannot be deleted.`,
        variant: "destructive"
      })
      return
    }

    if (data.error_code === 'HAS_CHILDREN') {
      toast({
        title: "Cannot Delete",
        description: `${orgName} has ${data.child_count} active child organization(s). Delete them first.`,
        variant: "destructive"
      })
      return
    }

    if (data.error_code === 'ORG_NOT_FOUND') {
      toast({
        title: "Not Found",
        description: 'Organization not found. It may have already been deleted.',
        variant: "destructive"
      })
      return
    }

    if (data.error_code === 'FOREIGN_KEY_VIOLATION') {
      toast({
        title: "Cannot Delete",
        description: 'There are related records that must be deleted first. Use the delete button to see details.',
        variant: "destructive"
      })
      return
    }

    toast({
      title: "Delete Failed",
      description: data.error || 'Unknown error occurred',
      variant: "destructive"
    })
  }

  const showDeleteSuccessToast = (data: any, orgName: string, orgCode: string) => {
    const deletedRecords = data.deleted_related_records || {}
    const summary = []

    if (deletedRecords.users > 0) summary.push(`${deletedRecords.users} user(s)`)
    if (deletedRecords.shop_distributors > 0) summary.push(`${deletedRecords.shop_distributors} distributor link(s)`)
    if (deletedRecords.distributor_products > 0) summary.push(`${deletedRecords.distributor_products} product link(s)`)
    if (deletedRecords.inventory_records > 0) summary.push(`${deletedRecords.inventory_records} inventory record(s)`)

    const summaryText = summary.length > 0
      ? ` Also removed: ${summary.join(', ')}.`
      : ''

    toast({
      title: "✓ Successfully Deleted",
      description: `${orgName} (${orgCode}) has been permanently removed.${summaryText}`
    })
  }

  const refreshOrganizationData = async () => {
    await Promise.all([
      fetchOrganizations(),
      checkShopDistributorLinks(),
      checkDistributorShopLinks(),
    ])
  }

  const handleQuickEdit = (orgId: string, field: 'name' | 'phone', currentValue: string) => {
    setEditingField({ orgId, field })
    setEditValue(currentValue || '')
  }

  const handleCancelQuickEdit = () => {
    setEditingField(null)
    setEditValue('')
  }

  const handleSaveQuickEdit = async (org: Organization) => {
    if (!editingField) return

    try {
      setIsSavingQuickEdit(true)

      const updateData: Partial<Organization> = {
        updated_at: new Date().toISOString()
      }

      if (editingField.field === 'name') {
        updateData.contact_name = editValue.trim() || ''
      } else if (editingField.field === 'phone') {
        updateData.contact_phone = editValue.trim() || ''
      }

      const { error } = await (supabase as any)
        .from('organizations')
        .update(updateData)
        .eq('id', org.id)

      if (error) throw error

      toast({
        title: '✓ Updated',
        description: `${editingField.field === 'name' ? 'Contact name' : 'Contact phone'} updated successfully`
      })

      // Reset editing state
      setEditingField(null)
      setEditValue('')

      // Refresh organizations
      fetchOrganizations()
    } catch (error) {
      console.error('Error saving quick edit:', error)
      toast({
        title: '✕ Error',
        description: 'Failed to update. Please try again.',
        variant: 'destructive'
      })
    } finally {
      setIsSavingQuickEdit(false)
    }
  }

  // Check organization dependencies before deleting
  const checkDependencies = async (orgId: string) => {
    setDeleteOtpStep('confirm')
    setDeleteOtpCode('')
    setDeleteOtpCodeId('')
    setDeleteOtpMaskedPhone('')
    setDeleteOtpChannel('whatsapp')
    setDeleteOtpError('')
    setDeleteDependenciesModal({ show: true, loading: true, deleting: false, orgId, data: null })

    try {
      const { data, error } = await (supabase as any)
        .rpc('check_organization_dependencies', { p_org_id: orgId })

      if (error) {
        console.error('Error checking dependencies:', error)
        setDeleteDependenciesModal(prev => ({
          ...prev,
          loading: false,
          data: {
            success: false,
            error: error.message || 'Failed to check dependencies'
          }
        }))
        return
      }

      setDeleteDependenciesModal(prev => ({
        ...prev,
        loading: false,
        data: data as DependencyCheckResult
      }))
    } catch (err: any) {
      console.error('Error checking dependencies:', err)
      setDeleteDependenciesModal(prev => ({
        ...prev,
        loading: false,
        data: {
          success: false,
          error: err.message || 'Failed to check dependencies'
        }
      }))
    }
  }

  const confirmDelete = (orgId: string) => {
    // Instead of simple confirm, check dependencies first
    checkDependencies(orgId)
  }

  // Proceed with deletion after user confirms
  const proceedWithDeletion = async () => {
    const orgId = deleteDependenciesModal.orgId
    if (!orgId) return

    setDeleteOtpSending(true)
    setDeleteOtpError('')

    try {
      const response = await fetch('/api/organizations/delete/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId }),
      })

      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || 'Failed to send verification code')
      }

      setDeleteOtpCode('')
      setDeleteOtpCodeId(data.codeId || '')
      setDeleteOtpMaskedPhone(data.maskedRecipient || '')
      setDeleteOtpChannel(data.channel === 'email' ? 'email' : 'whatsapp')
      setDeleteOtpStep('otp')
    } catch (error: any) {
      setDeleteOtpError(error.message || 'Failed to send verification code')
    } finally {
      setDeleteOtpSending(false)
    }
  }

  const handleDeleteOtpVerify = async () => {
    const orgId = deleteDependenciesModal.orgId
    if (!orgId || deleteOtpCode.length !== 4 || !deleteOtpCodeId) return

    const org = organizations.find(o => o.id === orgId)
    const orgName = org?.org_name || deleteDependenciesModal.data?.org_name || 'Organization'
    const orgCode = org?.org_code || deleteDependenciesModal.data?.org_code || 'Unknown'

    setDeleteOtpSending(true)
    setDeleteOtpError('')

    try {
      setDeleteOtpStep('deleting')

      const response = await fetch('/api/organizations/delete/verify-and-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId, code: deleteOtpCode, codeId: deleteOtpCodeId }),
      })

      const data = await response.json()

      if (!response.ok) {
        setDeleteOtpStep('otp')
        throw new Error(data.error || 'Verification failed')
      }

      if (!data?.success) {
        setDeleteOtpStep('confirm')
        showDeleteFailureToast(data, orgName)
        return
      }

      showDeleteSuccessToast(data, orgName, orgCode)
      closeDependenciesModal()
      setDeleteConfirmation({ show: false, orgId: null })
      await refreshOrganizationData()
    } catch (error: any) {
      setDeleteOtpError(error.message || 'Verification failed')
    } finally {
      setDeleteOtpSending(false)
    }
  }

  // Close the dependencies modal
  const closeDependenciesModal = () => {
    setDeleteOtpStep('confirm')
    setDeleteOtpCode('')
    setDeleteOtpCodeId('')
    setDeleteOtpMaskedPhone('')
    setDeleteOtpChannel('whatsapp')
    setDeleteOtpError('')
    setDeleteDependenciesModal({ show: false, loading: false, deleting: false, orgId: null, data: null })
  }

  if (loading) {
    return (
      <div className="sera-sc-page">
        <SupplyChainPageHeader title="Organizations" description="Manage your supply chain network" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
          {[...Array(6)].map((_, i) => (
            <Card key={i} className="animate-pulse sera-sc-panel shadow-none">
              <CardContent className="p-6">
                <div className="h-4 bg-[var(--sera-mist)] rounded mb-4"></div>
                <div className="h-8 bg-[var(--sera-mist)] rounded mb-2"></div>
                <div className="h-4 bg-[var(--sera-mist)] rounded mb-4"></div>
                <div className="flex gap-2">
                  <div className="h-6 bg-[var(--sera-mist)] rounded flex-1"></div>
                  <div className="h-6 bg-[var(--sera-mist)] rounded w-16"></div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="sera-sc-page">
      <SupplyChainPageHeader
        title="Organizations"
        description="Manage your supply chain network"
        actions={
          <Button
            className="bg-[var(--sera-ink)] text-white hover:bg-[var(--sera-ink-soft)]"
            onClick={() => onViewChange?.('add-organization')}
          >
            <Plus className="w-4 h-4 mr-2" />
            Add Organization
          </Button>
        }
      />

      {/* Filters */}
      <Card className="sera-sc-panel shadow-none">
        <CardContent className="p-6">
          <div className="flex flex-col sm:flex-row sm:flex-wrap gap-4">
            <div className="flex-1 sm:min-w-[220px]">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-[var(--sera-muted)] w-4 h-4" />
                <Input
                  placeholder="Search organizations..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10 border-[var(--sera-line)] focus-visible:ring-[var(--sera-orange)]/30"
                />
              </div>
            </div>
            <Select value={filterType} onValueChange={setFilterType}>
              <SelectTrigger className="w-full sm:w-48 border-[var(--sera-line)]">
                <Filter className="w-4 h-4 mr-2" />
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="HQ">Headquarters</SelectItem>
                <SelectItem value="MFG">Manufacturer</SelectItem>
                <SelectItem value="DIST">Distributor</SelectItem>
                <SelectItem value="WH">Warehouse</SelectItem>
                <SelectItem value="SHOP">Shop</SelectItem>
                <SelectItem value="END_USER">End User</SelectItem>
              </SelectContent>
            </Select>
            {filterType === 'MFG' && categorySummaries && (
              <Select value={filterCategory} onValueChange={setFilterCategory}>
                <SelectTrigger className="w-full sm:w-52 border-[var(--sera-line)]" aria-label="Product category">
                  <Package className="w-4 h-4 mr-2" />
                  <SelectValue placeholder="Product category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  <SelectItem value="unclassified">Not classified</SelectItem>
                  {categoryFilterOptions.map((category) => (
                    <SelectItem key={category.id} value={category.id}>
                      {category.category_name}{category.is_active === true ? '' : ' (inactive)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger className="w-full sm:w-48 border-[var(--sera-line)]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filterProgram} onValueChange={setFilterProgram}>
              <SelectTrigger className="w-full sm:w-52 border-[var(--sera-line)]">
                <SelectValue placeholder="Program" />
              </SelectTrigger>
              <SelectContent>
                {PROGRAM_FILTER_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filterState} onValueChange={setFilterState}>
              <SelectTrigger className="w-full sm:w-48 border-[var(--sera-line)]">
                <MapPin className="w-4 h-4 mr-2" />
                <SelectValue placeholder="State" />
              </SelectTrigger>
              <SelectContent>
                {stateFilterOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex gap-2">
              <Button
                variant={viewMode === 'card' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setViewMode('card')}
                className={viewMode === 'card' ? 'bg-[var(--sera-ink)] text-white hover:bg-[var(--sera-ink-soft)]' : 'border-[var(--sera-line)]'}
              >
                <LayoutGrid className="w-4 h-4" />
              </Button>
              <Button
                variant={viewMode === 'list' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setViewMode('list')}
                className={viewMode === 'list' ? 'bg-[var(--sera-ink)] text-white hover:bg-[var(--sera-ink-soft)]' : 'border-[var(--sera-line)]'}
              >
                <List className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Organizations Grid/List */}
      {viewMode === 'card' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
          {filteredOrganizations.map((org) => (
            <Card key={org.id} className="hover:shadow-md transition-all duration-200 border border-gray-200 overflow-hidden">
              {/* Card Header with Status Badge */}
              <div className="relative px-5 pt-5 pb-4">
                {/* Status Badge - Top Right */}
                <div className="absolute top-3 right-3">
                  <Badge className={`${getStatusColor(org.is_active, org.is_verified)} text-xs font-medium`}>
                    {getStatusText(org.is_active, org.is_verified)}
                  </Badge>
                </div>

                {/* Logo and Type Badges Row */}
                <div className="flex items-start gap-4">
                  {/* Organization Logo - Fixed size container with contain */}
                  <div className="w-14 h-14 rounded-lg border border-gray-200 bg-white flex items-center justify-center overflow-hidden flex-shrink-0">
                    {org.logo_url ? (
                      <img
                        src={resolveOrganizationLogoUrl(org.logo_url)}
                        alt={`${org.org_name} logo`}
                        className="w-full h-full object-contain p-1"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[var(--sera-orange)]/10 to-[var(--sera-orange)]/15">
                        <span className="text-[var(--sera-orange)] font-semibold text-sm">
                          {getOrgInitials(org.org_name)}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Type and Payment Badges */}
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    <Badge className={`${getOrgTypeColor(org.org_type_code)} text-xs`}>
                      {org.org_types?.type_name || org.org_type_code}
                    </Badge>
                    <Badge variant="outline" className="bg-gray-50 text-gray-700 border-gray-200 text-xs">
                      {getProgramLabel(org)}
                    </Badge>
                    {(org.org_type_code === 'MFG' || org.org_type_code === 'DIST' || org.org_type_code === 'SHOP') &&
                      (org as any).payment_terms && (
                        <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-xs">
                          💰 {(org as any).payment_terms.deposit_percentage}/{(org as any).payment_terms.balance_percentage} Split
                        </Badge>
                      )}
                  </div>
                </div>

                {/* Organization Name and Code */}
                <div className="mt-4">
                  <button
                    onClick={() => handleEditOrganization(org)}
                    className="font-semibold text-[var(--sera-ink)] text-base leading-tight line-clamp-1 hover:text-[var(--sera-orange)] hover:underline text-left"
                  >
                    {org.org_name}
                  </button>
                  <p className="text-sm text-gray-500 mt-0.5">
                    {org.org_code}
                    {org.branch && (
                      <span className="text-[var(--sera-muted)] ml-1.5">• {org.branch}</span>
                    )}
                    {(org.org_type_code === 'MFG' || org.org_type_code === 'DIST' || org.org_type_code === 'SHOP') &&
                      (org as any).payment_terms && (
                        <span className="text-purple-600 ml-1.5">
                          • {(org as any).payment_terms.deposit_percentage}% / {(org as any).payment_terms.balance_percentage}% split
                        </span>
                      )}
                  </p>
                  {org.org_type_code === 'MFG' && categorySummaries && (
                    <div className="mt-2">
                      <ManufacturerCategoryBadges manufacturerId={org.id} summary={categorySummaries.get(org.id)} />
                    </div>
                  )}
                </div>
              </div>

              {/* Card Content */}
              <CardContent className="px-5 pb-5 pt-0 space-y-3">
                {/* Contact Info - Compact Grid */}
                <div className="bg-gray-50 rounded-lg p-3 space-y-2">
                  {/* Contact Name */}
                  <div className="flex items-center gap-2 text-sm">
                    <Users className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                    {(org.org_type_code === 'SHOP' || org.org_type_code === 'DIST' || org.org_type_code === 'WH' || org.org_type_code === 'MFG') &&
                      editingField?.orgId === org.id && editingField?.field === 'name' ? (
                      <div className="flex items-center gap-2 flex-1">
                        <Input
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          className="h-7 text-sm flex-1"
                          placeholder="Enter contact name"
                          disabled={isSavingQuickEdit}
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveQuickEdit(org)
                            if (e.key === 'Escape') handleCancelQuickEdit()
                          }}
                        />
                        <Button size="sm" onClick={() => handleSaveQuickEdit(org)} disabled={isSavingQuickEdit} className="h-7 px-2 text-xs">Save</Button>
                        <Button size="sm" variant="ghost" onClick={handleCancelQuickEdit} disabled={isSavingQuickEdit} className="h-7 px-2 text-xs">Cancel</Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1 flex-1 min-w-0">
                        <span className={`truncate ${!org.contact_name ? 'text-gray-400 italic' : 'text-gray-700'}`}>
                          {org.contact_name || 'Not updated'}
                        </span>
                        {(org.org_type_code === 'SHOP' || org.org_type_code === 'DIST' || org.org_type_code === 'WH' || org.org_type_code === 'MFG') && (
                          <button onClick={() => handleQuickEdit(org.id, 'name', org.contact_name)} className="text-xs text-[var(--sera-orange)] hover:text-[var(--sera-orange-deep)] hover:underline flex-shrink-0">[Edit]</button>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Contact Phone */}
                  <div className="flex items-center gap-2 text-sm">
                    <Phone className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                    {(org.org_type_code === 'SHOP' || org.org_type_code === 'DIST' || org.org_type_code === 'WH' || org.org_type_code === 'MFG') &&
                      editingField?.orgId === org.id && editingField?.field === 'phone' ? (
                      <div className="flex items-center gap-2 flex-1">
                        <Input
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          className="h-7 text-sm flex-1"
                          placeholder="Enter contact phone"
                          disabled={isSavingQuickEdit}
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSaveQuickEdit(org)
                            if (e.key === 'Escape') handleCancelQuickEdit()
                          }}
                        />
                        <Button size="sm" onClick={() => handleSaveQuickEdit(org)} disabled={isSavingQuickEdit} className="h-7 px-2 text-xs">Save</Button>
                        <Button size="sm" variant="ghost" onClick={handleCancelQuickEdit} disabled={isSavingQuickEdit} className="h-7 px-2 text-xs">Cancel</Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1 flex-1 min-w-0">
                        <span className={`truncate ${!org.contact_phone ? 'text-gray-400 italic' : 'text-gray-700'}`}>
                          {org.contact_phone || 'Not updated'}
                        </span>
                        {(org.org_type_code === 'SHOP' || org.org_type_code === 'DIST' || org.org_type_code === 'WH' || org.org_type_code === 'MFG') && (
                          <button onClick={() => handleQuickEdit(org.id, 'phone', org.contact_phone)} className="text-xs text-[var(--sera-orange)] hover:text-[var(--sera-orange-deep)] hover:underline flex-shrink-0">[Edit]</button>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Email */}
                  <div className="flex items-center gap-2 text-sm">
                    <Mail className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                    <span className={`truncate ${!org.contact_email ? 'text-gray-400 italic' : 'text-gray-700'}`}>
                      {org.contact_email || 'Not updated'}
                    </span>
                  </div>

                  {/* State */}
                  <div className="flex items-center gap-2 text-sm">
                    <MapPin className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                    <span className={`truncate ${!org.states?.state_name ? 'text-gray-400 italic' : 'text-gray-700'}`}>
                      {org.states?.state_name || 'Not updated'}
                    </span>
                  </div>
                </div>

                {/* Linked Organizations */}
                {(
                  (org.parent_org && org.org_type_code === 'SHOP') ||
                  (org.org_type_code === 'SHOP' && shopLinkedDistributors.has(org.id)) ||
                  (org.org_type_code === 'DIST' && distributorLinkedShops.has(org.id))
                ) && (
                    <div className="text-xs text-gray-500 bg-[var(--sera-orange)]/[0.06] rounded-lg px-3 py-2">
                      {/* Shop's Parent Distributor */}
                      {org.parent_org && org.org_type_code === 'SHOP' && (
                        <p className="mb-1">
                          Ordering From: <span className="font-medium text-[var(--sera-orange)]">{org.parent_org.org_name}</span>
                        </p>
                      )}

                      {/* Shop's Additional Distributors */}
                      {org.org_type_code === 'SHOP' && shopLinkedDistributors.has(org.id) && (
                        <p>
                          Additional Distributors: <span className="font-medium">
                            {shopLinkedDistributors.get(org.id)?.join(', ') || 'None'}
                          </span>
                        </p>
                      )}

                      {/* Distributor's Linked Shops */}
                      {org.org_type_code === 'DIST' && distributorLinkedShops.has(org.id) && (
                        <p>
                          Supplying To: <span className="font-medium text-green-600">
                            {distributorLinkedShops.get(org.id)?.join(', ') || 'None'}
                          </span>
                        </p>
                      )}
                    </div>
                  )}

                {/* Stats - Compact Design */}
                <div className="grid grid-cols-3 gap-1 py-3 bg-gray-50 rounded-lg">
                  {org.org_type_code === 'SHOP' ? (
                    <>
                      <div className="text-center px-2">
                        <div className="sera-sc-kpi__value !text-xl">{org.distributors_count || 0}</div>
                        <div className="text-xs text-gray-500">Distributors</div>
                      </div>
                      <div className="text-center px-2 border-x border-gray-200">
                        <div className="sera-sc-kpi__value !text-xl">{org.users_count || 0}</div>
                        <div className="text-xs text-gray-500">Users</div>
                      </div>
                      <div className="text-center px-2">
                        <div className="sera-sc-kpi__value !text-xl">{org.orders_count || 0}</div>
                        <div className="text-xs text-gray-500">Orders</div>
                      </div>
                    </>
                  ) : org.org_type_code === 'DIST' ? (
                    <>
                      <div className="text-center px-2">
                        <div className="sera-sc-kpi__value !text-xl">{org.shops_count || 0}</div>
                        <div className="text-xs text-gray-500">Shops</div>
                      </div>
                      <div className="text-center px-2 border-x border-gray-200">
                        <div className="sera-sc-kpi__value !text-xl">{org.users_count || 0}</div>
                        <div className="text-xs text-gray-500">Users</div>
                      </div>
                      <div className="text-center px-2">
                        <div className="sera-sc-kpi__value !text-xl">{org.orders_count || 0}</div>
                        <div className="text-xs text-gray-500">Orders</div>
                      </div>
                    </>
                  ) : org.org_type_code === 'WH' ? (
                    <>
                      <div className="text-center px-2" title="This warehouse automatically receives orders from its parent HQ">
                        <div className="text-sm font-bold">
                          {org.parent_org && organizations.find(o => o.id === org.parent_org_id)?.default_warehouse_org_id === org.id ? (
                            <span className="text-[var(--sera-orange)]">Yes</span>
                          ) : (
                            <span className="text-gray-400">No</span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500">Default</div>
                      </div>
                      <div className="text-center px-2 border-x border-gray-200">
                        <div className="sera-sc-kpi__value !text-xl">{org.users_count || 0}</div>
                        <div className="text-xs text-gray-500">Users</div>
                      </div>
                      <div className="text-center px-2">
                        <div className="sera-sc-kpi__value !text-xl">{org.products_count || 0}</div>
                        <div className="text-xs text-gray-500">Products</div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="text-center px-2">
                        <div className="sera-sc-kpi__value !text-xl">{org.children_count || 0}</div>
                        <div className="text-xs text-gray-500">Children</div>
                      </div>
                      <div className="text-center px-2 border-x border-gray-200">
                        <div className="sera-sc-kpi__value !text-xl">{org.users_count || 0}</div>
                        <div className="text-xs text-gray-500">Users</div>
                      </div>
                      <div className="text-center px-2">
                        <div className="sera-sc-kpi__value !text-xl">{org.products_count || 0}</div>
                        <div className="text-xs text-gray-500">Products</div>
                      </div>
                    </>
                  )}
                </div>

                {/* Actions - Clean Button Row */}
                <div className="flex gap-2 pt-3 border-t border-gray-100">
                  {org.org_type_code === 'SHOP' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 h-9 text-xs font-medium hover:bg-[var(--sera-orange)]/[0.06] hover:text-[var(--sera-orange-deep)] hover:border-[var(--sera-orange)]/30"
                      onClick={() => {
                        setSelectedShopForDistributors(org)
                        checkShopDistributorLinks()
                      }}
                    >
                      <LinkIcon className={`w-3.5 h-3.5 mr-1.5 ${shopsWithDistributors.has(org.id) ? 'text-[var(--sera-orange)]' : ''}`} />
                      Distributors
                    </Button>
                  )}
                  {org.org_type_code === 'DIST' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 h-9 text-xs font-medium hover:bg-green-50 hover:text-green-700 hover:border-green-300"
                      onClick={() => {
                        setSelectedDistributorForShops(org)
                        checkDistributorShopLinks()
                      }}
                    >
                      <LinkIcon className={`w-3.5 h-3.5 mr-1.5 ${distributorsWithShops.has(org.id) ? 'text-green-600' : ''}`} />
                      Shops
                    </Button>
                  )}
                  {org.org_type_code === 'MFG' && (
                    <Button
                      asChild
                      variant="outline"
                      size="sm"
                      className="flex-1 h-9 text-xs font-medium hover:bg-[var(--sera-orange)]/[0.06] hover:text-[var(--sera-orange-deep)] hover:border-[var(--sera-orange)]/30"
                    >
                      <Link href={manufacturerProductsHref(org.id)}>
                        <Package className="w-3.5 h-3.5 mr-1.5" />
                        View products
                      </Link>
                    </Button>
                  )}
                  {org.org_type_code === 'WH' && org.parent_org_id && isHqAdmin && (
                    <Button
                      variant="outline"
                      size="sm"
                      className={`flex-1 h-9 text-xs font-medium ${organizations.find(o => o.id === org.parent_org_id)?.default_warehouse_org_id === org.id
                        ? 'bg-[var(--sera-orange)]/10 text-[var(--sera-orange-deep)] border-[var(--sera-orange)]/30'
                        : 'hover:bg-[var(--sera-orange)]/[0.06] hover:text-[var(--sera-orange-deep)] hover:border-[var(--sera-orange)]/30'
                        }`}
                      onClick={() => handleSetDefaultWarehouse(org)}
                      disabled={organizations.find(o => o.id === org.parent_org_id)?.default_warehouse_org_id === org.id}
                      title="Prefer Edit warehouse → Distributor Order Fulfillment for the guided setting"
                    >
                      <Building2 className="w-3.5 h-3.5 mr-1.5" />
                      {organizations.find(o => o.id === org.parent_org_id)?.default_warehouse_org_id === org.id ? 'Default ✓' : 'Set Default'}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 h-9 text-xs font-medium hover:bg-gray-100"
                    onClick={() => handleEditOrganization(org)}
                  >
                    <Edit className="w-3.5 h-3.5 mr-1.5" />
                    Edit
                  </Button>
                  {canDeleteOrganizations && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 h-9 text-xs font-medium text-red-600 hover:bg-red-50 hover:text-red-700 border-red-200 hover:border-red-300"
                      onClick={() => confirmDelete(org.id)}
                    >
                      <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                      Delete
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Organizations List</CardTitle>
            <CardDescription>
              {filteredOrganizations.length} organization{filteredOrganizations.length !== 1 ? 's' : ''} found
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[50px] text-xs">No</TableHead>
                  <TableHead>
                    <button
                      onClick={() => handleSort('org_name')}
                      className="flex items-center gap-1 hover:text-[var(--sera-ink)] transition-colors font-medium text-xs"
                    >
                      Organization
                      {sortField === 'org_name' ? (
                        sortDirection === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
                      ) : (
                        <ArrowUpDown className="w-3 h-3 opacity-30" />
                      )}
                    </button>
                  </TableHead>
                  {filterType === 'SHOP' && (
                    <TableHead className="text-xs">Branch</TableHead>
                  )}
                  <TableHead>
                    <button
                      onClick={() => handleSort('org_type_code')}
                      className="flex items-center gap-1 hover:text-[var(--sera-ink)] transition-colors font-medium text-xs"
                    >
                      Type
                      {sortField === 'org_type_code' ? (
                        sortDirection === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
                      ) : (
                        <ArrowUpDown className="w-3 h-3 opacity-30" />
                      )}
                    </button>
                  </TableHead>
                  <TableHead className="text-xs">Program</TableHead>
                  {filterType === 'MFG' && (
                    <TableHead className="text-xs">Product Categories</TableHead>
                  )}
                  <TableHead>
                    <button
                      onClick={() => handleSort('contact_name')}
                      className="flex items-center gap-1 hover:text-[var(--sera-ink)] transition-colors font-medium text-xs"
                    >
                      Contact
                      {sortField === 'contact_name' ? (
                        sortDirection === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
                      ) : (
                        <ArrowUpDown className="w-3 h-3 opacity-30" />
                      )}
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      onClick={() => handleSort('state')}
                      className="flex items-center gap-1 hover:text-[var(--sera-ink)] transition-colors font-medium text-xs"
                    >
                      State
                      {sortField === 'state' ? (
                        sortDirection === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
                      ) : (
                        <ArrowUpDown className="w-3 h-3 opacity-30" />
                      )}
                    </button>
                  </TableHead>
                  <TableHead className="text-right text-xs">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginatedOrganizations.map((org, index) => (
                  <TableRow key={org.id}>
                    <TableCell className="text-xs text-gray-500">
                      {startIndex + index + 1}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div>
                          <button
                            onClick={() => handleEditOrganization(org)}
                            className="font-medium text-xs text-[var(--sera-orange)] hover:text-[var(--sera-orange-deep)] hover:underline text-left"
                          >
                            {org.org_name}
                          </button>
                        </div>
                      </div>
                    </TableCell>
                    {filterType === 'SHOP' && (
                      <TableCell className="text-xs text-[var(--sera-muted)]">
                        {org.branch || '-'}
                      </TableCell>
                    )}
                    <TableCell>
                      <Badge className={`${getOrgTypeColor(org.org_type_code)} text-[10px] px-1.5 py-0.5`}>
                        {org.org_types?.type_name || org.org_type_code}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-gray-700">
                      {getProgramLabel(org)}
                    </TableCell>
                    {filterType === 'MFG' && (
                      <TableCell className="min-w-[180px]">
                        {categorySummaries === undefined ? (
                          <span className="text-[11px] text-gray-400">Loading…</span>
                        ) : categorySummaries === null ? (
                          <span className="text-[11px] text-gray-400">Unavailable</span>
                        ) : (
                          <ManufacturerCategoryBadges manufacturerId={org.id} summary={categorySummaries.get(org.id)} />
                        )}
                      </TableCell>
                    )}
                    <TableCell>
                      <div className="text-xs">
                        <div className="font-medium">{org.contact_name || '-'}</div>
                        <div className="text-gray-500">{org.contact_phone || '-'}</div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="text-xs">
                        <div>{org.states?.state_name || 'Not updated'}</div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        {/* Manage Distributors button for SHOP organizations */}
                        {org.org_type_code === 'SHOP' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={() => {
                              setSelectedShopForDistributors(org)
                              checkShopDistributorLinks() // Refresh on open
                            }}
                            title="Manage Distributors"
                          >
                            <LinkIcon
                              className={`w-3.5 h-3.5 ${shopsWithDistributors.has(org.id) ? 'text-[var(--sera-orange)]' : 'text-gray-400'}`}
                            />
                          </Button>
                        )}
                        {/* Manage Shops button for DIST organizations */}
                        {org.org_type_code === 'DIST' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={() => {
                              setSelectedDistributorForShops(org)
                              checkDistributorShopLinks() // Refresh on open
                            }}
                            title="Manage Shops"
                          >
                            <LinkIcon
                              className={`w-3.5 h-3.5 ${distributorsWithShops.has(org.id) ? 'text-[var(--sera-orange)]' : 'text-gray-400'}`}
                            />
                          </Button>
                        )}
                        {org.org_type_code === 'MFG' && (
                          <Button asChild variant="ghost" size="sm" className="h-7 w-7 p-0" title="View products">
                            <Link href={manufacturerProductsHref(org.id)} aria-label={`View products of ${org.org_name}`}>
                              <Package className="w-3.5 h-3.5" />
                            </Link>
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={() => handleEditOrganization(org)}
                          title="Edit"
                        >
                          <Edit className="w-3.5 h-3.5" />
                        </Button>
                        {canDeleteOrganizations && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-red-600 hover:text-red-700"
                            onClick={() => confirmDelete(org.id)}
                            title="Delete"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {/* Pagination Controls */}
            {totalOrganizations > 0 && (
              <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50">
                <div className="flex items-center gap-4">
                  <span className="text-xs text-gray-700">
                    Showing {startIndex + 1} to {Math.min(endIndex, totalOrganizations)} of {totalOrganizations} organizations
                  </span>

                  <div className="flex items-center gap-2">
                    <span className="text-xs text-[var(--sera-muted)]">Rows:</span>
                    <Select
                      value={itemsPerPage.toString()}
                      onValueChange={(value) => {
                        setItemsPerPage(Number(value))
                        setCurrentPage(1)
                      }}
                    >
                      <SelectTrigger className="h-7 w-[70px] text-xs bg-white">
                        <SelectValue placeholder="10" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="10">10</SelectItem>
                        <SelectItem value="20">20</SelectItem>
                        <SelectItem value="30">30</SelectItem>
                        <SelectItem value="50">50</SelectItem>
                        <SelectItem value="100">100</SelectItem>
                        <SelectItem value="200">200</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                    disabled={currentPage === 1}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <span className="text-xs text-gray-700">
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
          </CardContent>
        </Card>
      )}

      {filteredOrganizations.length === 0 && !loading && (
        <Card>
          <CardContent className="p-12 text-center">
            <Building2 className="w-12 h-12 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-[var(--sera-ink)] mb-2">No organizations found</h3>
            <p className="text-[var(--sera-muted)] mb-4">
              {searchTerm || filterType !== 'all' || filterStatus !== 'all' || filterProgram !== 'all' || filterState !== ALL_STATES_VALUE || filterCategory !== 'all'
                ? 'Try adjusting your search criteria'
                : 'Get started by adding your first organization'
              }
            </p>
            <Button onClick={() => onViewChange?.('add-organization')}>
              <Plus className="w-4 h-4 mr-2" />
              Add Organization
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Shop Distributors Manager Modal */}
      {selectedShopForDistributors && (
        <SeraModalOverlay onBackdropClick={() => {
          setSelectedShopForDistributors(null)
          checkShopDistributorLinks()
        }}>
          <SeraModalPanel className="sera-modal-panel--scroll">
            <SeraModalHeader
              onClose={() => {
                setSelectedShopForDistributors(null)
                checkShopDistributorLinks()
              }}
            >
              <div>
                <h2 className="sera-modal-title">Manage Distributors</h2>
                <p className="mt-1 text-sm text-[var(--sera-muted)]">
                  {selectedShopForDistributors.org_name} ({selectedShopForDistributors.org_code})
                </p>
              </div>
            </SeraModalHeader>
            <SeraModalBody className="flex-1 overflow-auto">
              <ShopDistributorsManager
                shopId={selectedShopForDistributors.id}
                shopName={selectedShopForDistributors.org_name}
              />
            </SeraModalBody>
          </SeraModalPanel>
        </SeraModalOverlay>
      )}

      {/* Distributor Shops Manager Modal */}
      {selectedDistributorForShops && (
        <SeraModalOverlay onBackdropClick={() => {
          setSelectedDistributorForShops(null)
          checkDistributorShopLinks()
        }}>
          <SeraModalPanel className="sera-modal-panel--scroll">
            <SeraModalHeader
              onClose={() => {
                setSelectedDistributorForShops(null)
                checkDistributorShopLinks()
              }}
            >
              <div>
                <h2 className="sera-modal-title">Manage Shops</h2>
                <p className="mt-1 text-sm text-[var(--sera-muted)]">
                  {selectedDistributorForShops.org_name} ({selectedDistributorForShops.org_code})
                </p>
              </div>
            </SeraModalHeader>
            <SeraModalBody className="flex-1 overflow-auto">
              <DistributorShopsManager
                distributorId={selectedDistributorForShops.id}
                distributorName={selectedDistributorForShops.org_name}
              />
            </SeraModalBody>
          </SeraModalPanel>
        </SeraModalOverlay>
      )}

      {/* Delete Dependencies Modal */}
      <Dialog open={deleteDependenciesModal.show} onOpenChange={(open) => !open && closeDependenciesModal()}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {deleteDependenciesModal.loading ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin text-[var(--sera-orange)]" />
                  Checking Dependencies...
                </>
              ) : deleteOtpStep === 'otp' ? (
                <>
                  <Phone className="h-5 w-5 text-amber-500" />
                  Enter Verification Code
                </>
              ) : deleteOtpStep === 'deleting' ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin text-red-500" />
                  Deleting Organization...
                </>
              ) : deleteDependenciesModal.data?.can_delete ? (
                <>
                  <CheckCircle className="h-5 w-5 text-green-500" />
                  Ready to Delete
                </>
              ) : (
                <>
                  <AlertTriangle className="h-5 w-5 text-amber-500" />
                  Cannot Delete Organization
                </>
              )}
            </DialogTitle>
            {deleteDependenciesModal.data && (
              <DialogDescription>
                {deleteOtpStep === 'otp' ? (
                  <>A 4-digit code was sent by <strong>{deleteOtpChannel === 'email' ? 'email' : 'WhatsApp'}</strong> to <strong>{deleteOtpMaskedPhone}</strong>. Enter it below to authorize deletion.</>
                ) : deleteOtpStep === 'deleting' ? (
                  'Please wait while the organization is being deleted.'
                ) : (
                  <>
                    <span className="font-semibold">{deleteDependenciesModal.data.org_name}</span>
                    {' '}({deleteDependenciesModal.data.org_code}) - {deleteDependenciesModal.data.org_type}
                  </>
                )}
              </DialogDescription>
            )}
          </DialogHeader>

          <ScrollArea className="flex-1 pr-4">
            {deleteDependenciesModal.loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-[var(--sera-orange)]" />
              </div>
            ) : deleteDependenciesModal.data?.error ? (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <div className="flex items-center gap-2 text-red-700">
                  <XCircle className="h-5 w-5" />
                  <span className="font-medium">Error</span>
                </div>
                <p className="text-red-600 mt-2">{deleteDependenciesModal.data.error}</p>
              </div>
            ) : deleteDependenciesModal.data?.can_delete ? (
              <div className="space-y-4">
                {deleteOtpStep === 'otp' ? (
                  <div className="space-y-3">
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                      <p className="text-amber-700">
                        For protection, deletion requires the 4-digit verification code sent using the configured Delete Organization Masterdata notification route.
                      </p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Verification Code</label>
                      <Input
                        type="text"
                        maxLength={4}
                        value={deleteOtpCode}
                        onChange={(e) => setDeleteOtpCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                        placeholder="0000"
                        className="text-center text-2xl tracking-widest font-mono h-12"
                        autoFocus
                      />
                    </div>
                    <p className="text-xs text-gray-500 text-center">Code expires in 5 minutes</p>
                  </div>
                ) : deleteOtpStep === 'deleting' ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-8 w-8 animate-spin text-red-500" />
                  </div>
                ) : (
                  <>
                    <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                      <p className="text-green-700">
                        This organization has no blocking dependencies and can be safely deleted.
                      </p>
                    </div>
                    {deleteDependenciesModal.data.blocking_records && deleteDependenciesModal.data.blocking_records.length > 0 && (
                      <div className="space-y-3">
                        <p className="text-sm text-[var(--sera-muted)]">The following will be automatically removed:</p>
                        {deleteDependenciesModal.data.blocking_records
                          .filter(r => r.auto_delete)
                          .map((record, index) => (
                            <div key={index} className="bg-gray-50 border border-gray-200 rounded-lg p-3">
                              <div className="flex items-center justify-between">
                                <span className="font-medium text-gray-700">{record.display_name}</span>
                                <Badge variant="secondary">{record.count} record(s)</Badge>
                              </div>
                              <p className="text-sm text-gray-500 mt-1">{record.action}</p>
                            </div>
                          ))}
                      </div>
                    )}
                  </>
                )}
                {deleteOtpError && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                    <p className="text-sm text-red-600 text-center">{deleteOtpError}</p>
                  </div>
                )}
              </div>
            ) : deleteDependenciesModal.data?.has_blocking_records ? (
              <div className="space-y-4">
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                  <p className="text-amber-700">
                    This organization cannot be deleted because it has related records that must be removed first.
                    Please delete the following records in order:
                  </p>
                </div>

                <div className="space-y-3">
                  {deleteDependenciesModal.data.blocking_records
                    ?.filter(r => !r.auto_delete)
                    .sort((a, b) => a.priority - b.priority)
                    .map((record, index) => (
                      <div key={index} className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span className="bg-gray-100 text-[var(--sera-muted)] text-xs font-bold px-2 py-1 rounded">
                              Step {index + 1}
                            </span>
                            <span className="font-semibold text-gray-800">{record.display_name}</span>
                          </div>
                          <Badge variant={record.count > 0 ? "destructive" : "secondary"}>
                            {record.count} record(s)
                          </Badge>
                        </div>
                        <p className="text-sm text-[var(--sera-muted)] mb-2">{record.description}</p>
                        <div className="flex items-start gap-2 bg-[var(--sera-orange)]/[0.06] rounded p-2">
                          <Info className="h-4 w-4 text-[var(--sera-orange)] mt-0.5 flex-shrink-0" />
                          <p className="text-sm text-[var(--sera-orange-deep)]">{record.action}</p>
                        </div>

                        {/* Show sample records if available */}
                        {record.records && record.records.length > 0 && (
                          <div className="mt-3 pt-3 border-t border-gray-100">
                            <p className="text-xs text-gray-500 mb-2">Sample records:</p>
                            <div className="space-y-1">
                              {record.records.slice(0, 5).map((r, i) => (
                                <div key={i} className="text-xs bg-gray-50 rounded px-2 py-1 flex items-center gap-2">
                                  <span className="font-mono text-[var(--sera-muted)]">{r.reference}</span>
                                  {r.code && <span className="text-gray-400">({r.code})</span>}
                                  {r.status && (
                                    <Badge variant="outline" className="text-xs px-1 py-0">
                                      {r.status}
                                    </Badge>
                                  )}
                                </div>
                              ))}
                              {record.count > 5 && (
                                <p className="text-xs text-gray-400 italic">
                                  ... and {record.count - 5} more
                                </p>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                </div>

                {/* Show auto-delete items */}
                {deleteDependenciesModal.data.blocking_records?.filter(r => r.auto_delete).length > 0 && (
                  <div className="mt-4 pt-4 border-t border-gray-200">
                    <p className="text-sm text-gray-500 mb-2">These will be automatically removed when deleting:</p>
                    {deleteDependenciesModal.data.blocking_records
                      ?.filter(r => r.auto_delete)
                      .map((record, index) => (
                        <div key={index} className="flex items-center justify-between py-1">
                          <span className="text-sm text-[var(--sera-muted)]">{record.display_name}</span>
                          <Badge variant="secondary">{record.count}</Badge>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            ) : null}
          </ScrollArea>

          <DialogFooter className="mt-4 pt-4 border-t">
            <Button variant="outline" onClick={closeDependenciesModal} disabled={deleteOtpSending || deleteOtpStep === 'deleting'}>
              Cancel
            </Button>
            {deleteDependenciesModal.data?.can_delete && deleteOtpStep === 'confirm' && (
              <Button
                variant="destructive"
                onClick={proceedWithDeletion}
                disabled={deleteOtpSending}
              >
                {deleteOtpSending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Phone className="h-4 w-4 mr-2" />
                    Send Verification Code
                  </>
                )}
              </Button>
            )}
            {deleteDependenciesModal.data?.can_delete && deleteOtpStep === 'otp' && (
              <Button
                variant="destructive"
                onClick={handleDeleteOtpVerify}
                disabled={deleteOtpSending || deleteOtpCode.length !== 4}
              >
                {deleteOtpSending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Verifying...
                  </>
                ) : (
                  <>
                    <Trash2 className="h-4 w-4 mr-2" />
                    Verify & Delete
                  </>
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
