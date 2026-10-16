'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Scan, Users, TrendingUp, Calendar, MapPin, Filter, ArrowUpDown, ChevronLeft, ChevronRight, Trophy, MessageSquare, Clock, CheckCircle2, Eye, Trash2, ExternalLink, MessageCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useToast } from '@/components/ui/use-toast'
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import ScanIssuesTab from '@/components/dashboard/views/consumer-engagement/ScanIssuesTab'
import SupplyChainPageHeader from '@/modules/supply-chain/components/SupplyChainPageHeader'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import UserDialogNew from '@/components/users/UserDialogNew'
import type { User, Role, Organization } from '@/types/user'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

interface UserProfile {
  id: string
  organization_id: string
  organizations: { id: string; org_name: string }
  roles?: { role_name: string; role_level: number }
}

interface ConsumerActivationsViewProps {
  userProfile: UserProfile
  onViewChange: (view: string) => void
}

export default function ConsumerActivationsView({ userProfile, onViewChange }: ConsumerActivationsViewProps) {
  const organizationId = userProfile.organization_id
  const [activeTab, setActiveTab] = useState<'activations' | 'feedback' | 'whatsapp' | 'scan_issues'>('activations')
  const [activations, setActivations] = useState<any[]>([])
  const [orders, setOrders] = useState<any[]>([])
  const [products, setProducts] = useState<any[]>([])
  const [selectedOrderId, setSelectedOrderId] = useState<string>('all')
  const [selectedActivityType, setSelectedActivityType] = useState<string>('all')

  // Filters
  const [filterProduct, setFilterProduct] = useState('all')
  const [filterMMYY, setFilterMMYY] = useState('')
  const [filterConsumer, setFilterConsumer] = useState('')
  const [filterShop, setFilterShop] = useState('')

  // Column ordering for drag-and-drop
  const [columnOrder, setColumnOrder] = useState(['order', 'product'])
  const [draggedColumn, setDraggedColumn] = useState<string | null>(null)

  // Sorting & Pagination
  const [sortColumn, setSortColumn] = useState('updated_at')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc')
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [totalCount, setTotalCount] = useState(0)

  // Feedback state
  const [feedback, setFeedback] = useState<any[]>([])
  const [feedbackLoading, setFeedbackLoading] = useState(false)
  const [feedbackSummary, setFeedbackSummary] = useState({ total: 0, pending: 0, reviewed: 0, resolved: 0 })
  const [feedbackStatusFilter, setFeedbackStatusFilter] = useState<string>('all')
  const [feedbackPage, setFeedbackPage] = useState(1)
  const [feedbackTotal, setFeedbackTotal] = useState(0)
  const [selectedFeedback, setSelectedFeedback] = useState<any>(null)
  const [updatingFeedback, setUpdatingFeedback] = useState(false)
  const [feedbackToDelete, setFeedbackToDelete] = useState<any>(null)
  const [deletingFeedback, setDeletingFeedback] = useState(false)

  // WhatsApp Activity state
  const [waEvents, setWaEvents] = useState<any[]>([])
  const [waLoading, setWaLoading] = useState(false)
  const [waPage, setWaPage] = useState(1)
  const [waTotal, setWaTotal] = useState(0)
  const [waFilterPurpose, setWaFilterPurpose] = useState('all')
  const [waFilterStatus, setWaFilterStatus] = useState('all')
  const [waFilterPhone, setWaFilterPhone] = useState('')
  const waPageSize = 20

  // Check if user is super admin (role_level = 1)
  const isSuperAdmin = userProfile.roles?.role_level === 1

  // Load WhatsApp activity events
  async function loadWhatsAppActivity() {
    setWaLoading(true)
    try {
      const supabase = createClient()
      let query = supabase
        .from('notification_events')
        .select('*', { count: 'exact' })
        .eq('channel', 'whatsapp')
        .order('created_at', { ascending: false })
        .range((waPage - 1) * waPageSize, waPage * waPageSize - 1)

      if (waFilterPurpose !== 'all') query = query.eq('purpose', waFilterPurpose)
      if (waFilterStatus !== 'all') query = query.eq('status', waFilterStatus)
      if (waFilterPhone.trim()) query = query.ilike('recipient_phone', `%${waFilterPhone.trim()}%`)

      const { data, count, error } = await query
      if (error) {
        console.error('Error loading WhatsApp activity:', error)
        return
      }
      setWaEvents(data || [])
      setWaTotal(count || 0)
    } catch (err) {
      console.error('Error loading WhatsApp activity:', err)
    } finally {
      setWaLoading(false)
    }
  }

  // Reload WA events when tab or filters change
  useEffect(() => {
    if (activeTab === 'whatsapp') loadWhatsAppActivity()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, waPage, waFilterPurpose, waFilterStatus, waFilterPhone])

  const [stats, setStats] = useState({
    total_scans: 0,
    unique_consumers: 0,
    total_points: 0,
    today_scans: 0,
    total_cost: 0
  })
  const [loading, setLoading] = useState(true)

  // Unique consumers dialog (Issue 3)
  const [showUniqueConsumers, setShowUniqueConsumers] = useState(false)
  const [uniqueConsumersList, setUniqueConsumersList] = useState<any[]>([])
  const [loadingUniqueConsumers, setLoadingUniqueConsumers] = useState(false)

  // Consumer detail dialog (Issue 4)
  const [selectedConsumerUser, setSelectedConsumerUser] = useState<User | null>(null)
  const [consumerDialogOpen, setConsumerDialogOpen] = useState(false)
  const [consumerRoles, setConsumerRoles] = useState<Role[]>([])
  const [consumerOrgs, setConsumerOrgs] = useState<Organization[]>([])
  const [loadingConsumerDetail, setLoadingConsumerDetail] = useState(false)

  const { toast } = useToast()
  const supabase = createClient()

  useEffect(() => {
    if (userProfile?.organizations?.id) {
      loadOrders()
      loadProducts()
      loadStats()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userProfile])

  useEffect(() => {
    if (userProfile?.organizations?.id) {
      loadActivations()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrderId, selectedActivityType, filterProduct, filterMMYY, filterConsumer, filterShop, sortColumn, sortDirection, currentPage, userProfile])

  const loadOrders = async () => {
    try {
      if (!userProfile?.organizations?.id) return

      const { data, error } = await supabase
        .from('orders')
        .select('id, order_no, created_at')
        .eq('company_id', userProfile.organizations.id)
        .order('created_at', { ascending: false })

      if (error) throw error
      setOrders(data || [])
    } catch (error: any) {
      console.error('Error loading orders:', error.message || error)
    }
  }

  const loadProducts = async () => {
    try {
      if (!userProfile?.organizations?.id) return

      const { data, error } = await supabase
        .from('products')
        .select('id, product_name, product_variants(image_url)')
        .eq('manufacturer_id', userProfile.organizations.id)
        .order('product_name', { ascending: true })

      if (error) throw error
      setProducts(data || [])
    } catch (error: any) {
      console.error('Error loading products:', error.message || error)
    }
  }

  const loadActivations = async () => {
    try {
      setLoading(true)
      // Query qr_codes directly as it now holds consumer data
      let query = supabase
        .from('qr_codes')
        .select(`
          id,
          consumer_name,
          consumer_phone,
          consumer_email,
          updated_at,
          redeemed_at,
          points_collected_at,
          lucky_draw_entered_at,
          first_consumer_scan_at,
          is_redeemed,
          is_lucky_draw_entered,
          is_points_collected,
          is_shop_points_collected,
          is_consumer_points_collected,
          points_value,
          product_id,
          order_id,
          sequence_number,
          orders ( order_no, display_doc_no ),
          products ( id, product_name ),
          product_variants ( variant_name, image_url ),
          redeem_items ( item_name, item_image_url ),
          redeem_gifts ( gift_name, gift_image_url ),
          scratch_card_plays (
            is_win,
            scratch_card_rewards (
              name,
              type,
              product_id
            )
          ),
          consumer_qr_scans ( 
            location_lat, 
            location_lng,
            shop_id,
            consumer_id,
            points_amount,
            scanned_at,
            organizations ( org_name, org_type_code ),
            users!consumer_qr_scans_consumer_id_fkey ( id, full_name, phone, email, organization_id, shop_name, organizations!fk_users_organization ( org_type_code ) )
          )
        `, { count: 'exact' })
        .eq('company_id', userProfile.organizations.id)
        .or('is_redeemed.eq.true,is_lucky_draw_entered.eq.true,is_points_collected.eq.true')

      // Apply Filters
      if (selectedOrderId && selectedOrderId !== 'all') {
        query = query.eq('order_id', selectedOrderId)
      }

      if (selectedActivityType && selectedActivityType !== 'all') {
        if (selectedActivityType === 'lucky_draw') {
          query = query.eq('is_lucky_draw_entered', true)
        } else if (selectedActivityType === 'points') {
          query = query.eq('is_points_collected', true)
        } else if (selectedActivityType === 'gift') {
          query = query.eq('is_redeemed', true)
        }
      }

      if (filterProduct && filterProduct !== 'all') {
        query = query.eq('product_id', filterProduct)
      }

      if (filterConsumer) {
        query = query.ilike('consumer_name', `%${filterConsumer}%`)
      }

      // Server-side MMYY filter: convert "MMYY" (e.g. "0226" → Feb 2026) into a date-range
      if (filterMMYY && filterMMYY.length === 4) {
        const mm = parseInt(filterMMYY.substring(0, 2), 10)
        const yy = parseInt(filterMMYY.substring(2, 4), 10)
        if (mm >= 1 && mm <= 12 && !isNaN(yy)) {
          const year = 2000 + yy
          const startOfMonth = new Date(year, mm - 1, 1).toISOString()
          const startOfNextMonth = new Date(year, mm, 1).toISOString()
          query = query.gte('updated_at', startOfMonth).lt('updated_at', startOfNextMonth)
        }
      }

      // Sorting
      // Note: Sorting by related fields (product name, shop name) is also tricky. 
      // We'll stick to sorting by fields on qr_codes table for server-side sort.
      if (['updated_at', 'sequence_number', 'points_value', 'consumer_name'].includes(sortColumn)) {
        query = query.order(sortColumn, { ascending: sortDirection === 'asc' })
      } else {
        // Default sort
        query = query.order('updated_at', { ascending: false })
      }

      // Pagination
      const from = (currentPage - 1) * pageSize
      const to = from + pageSize - 1
      query = query.range(from, to)

      const { data, error, count } = await query

      if (error) throw error

      setTotalCount(count || 0)

      let transformedData = data?.map((qr: any) => {
        // Get location and shop from the most recent scan if available
        const scans = qr.consumer_qr_scans?.sort((a: any, b: any) =>
          new Date(b.scanned_at).getTime() - new Date(a.scanned_at).getTime()
        ) || []

        const lastScan = scans[0]

        const location = lastScan?.location_lat && lastScan?.location_lng
          ? `${lastScan.location_lat.toFixed(4)}, ${lastScan.location_lng.toFixed(4)}`
          : null

        // Points logic: try qr_codes first, then scan record
        let points = 0
        if (qr.is_points_collected) {
          points = qr.points_value || lastScan?.points_amount || 0
        }

        // Gift logic: try redeem_gifts (free gift) first, then redeem_items (points catalog)
        const giftName = qr.redeem_gifts?.gift_name || qr.redeem_items?.item_name;
        const giftImage = qr.redeem_gifts?.gift_image_url || qr.redeem_items?.item_image_url;

        // Game Card logic
        const play = qr.scratch_card_plays?.[0];
        const gameCardWon = play?.is_win;
        const reward = play?.scratch_card_rewards;
        const gameCardName = reward?.name;

        // Try to get image from loaded products since we can't join directly due to missing FK
        let gameCardImage = null;
        if (reward?.product_id && products.length > 0) {
          const prod = products.find((p: any) => p.id === reward.product_id);
          gameCardImage = prod?.product_variants?.[0]?.image_url;
        }

        // Consumer name priority: 
        // 1) User's full_name from scan (registered user who collected points)
        // 2) qr_codes consumer_name (from gift claim / lucky draw / points collection by independent user)
        // 3) User's phone/email if available (fallback identifier)
        // 4) Check if shop collected (shop_id present but no consumer info)
        // 5) Legacy data (no tracking info available)
        const scanUser = lastScan?.users;
        const consumerNameFromScan = scanUser?.full_name;
        const fallbackIdentifier = scanUser?.phone || scanUser?.email || qr.consumer_phone || qr.consumer_email;

        let consumerName = 'Anonymous';
        if (consumerNameFromScan) {
          consumerName = consumerNameFromScan;
        } else if (qr.consumer_name) {
          consumerName = qr.consumer_name;
        } else if (fallbackIdentifier) {
          consumerName = `User: ${fallbackIdentifier}`;
        } else if (qr.is_shop_points_collected) {
          // Shop-lane claim: shop staff scanned on behalf of walk-in customer.
          // Points were credited via the shop's authority; no consumer login was required.
          const shopLabel = lastScan?.organizations?.org_name
            || (lastScan?.shop_id ? `Shop ${lastScan.shop_id.substring(0, 6)}` : 'Shop')
          consumerName = `Walk-in @ ${shopLabel}`;
        } else if (lastScan?.shop_id) {
          // Points collected by shop but consumer unknown
          consumerName = 'Shop Collected';
        } else if (lastScan?.consumer_id) {
          // Has consumer_id but couldn't join to users (shouldn't happen normally)
          consumerName = 'Registered User';
        }
        // Else stays 'Anonymous' for legacy data without tracking

        // Check if user is independent (org_type_code = 'INDEP')
        const isIndependentUser = scanUser?.organizations?.org_type_code === 'INDEP';
        const independentUserName = isIndependentUser ? scanUser?.full_name : null;

        // Shop name: prefer scan org name; for independent users fall back to their shop_name field
        const shopName = lastScan?.organizations?.org_name
          || (isIndependentUser && scanUser?.shop_name ? scanUser.shop_name : null)
          || (lastScan?.shop_id ? 'Shop ID: ' + lastScan.shop_id.substring(0, 8) : '-')

        // Order document numbers
        const orderDocNo = qr.orders?.display_doc_no || qr.orders?.order_no || 'N/A';
        const legacyOrderNo = qr.orders?.display_doc_no ? qr.orders?.order_no : null;

        return {
          id: qr.id,
          consumer_name: consumerName,
          consumer_phone: qr.consumer_phone,
          consumer_email: qr.consumer_email,
          consumer_user_id: scanUser?.id || null,
          activated_at: qr.first_consumer_scan_at || qr.points_collected_at || qr.redeemed_at || qr.lucky_draw_entered_at || qr.updated_at,
          points_awarded: points,
          lucky_draw_entered: qr.is_lucky_draw_entered,
          gift_redeemed: qr.is_redeemed,
          activation_location: location,
          shop_name: shopName,
          independent_user_name: independentUserName,
          order_doc_no: orderDocNo,
          legacy_order_no: legacyOrderNo,
          product_name: qr.products?.product_name || 'Unknown Product',
          variant_name: qr.product_variants?.variant_name,
          variant_image: qr.product_variants?.image_url,
          sequence_number: qr.sequence_number,
          gift_name: giftName,
          gift_image: giftImage,
          game_card_won: gameCardWon,
          game_card_name: gameCardName,
          game_card_image: gameCardImage
        }
      }) || []

      // Client-side filtering for Shop Name (related tables can't be filtered server-side easily)
      if (filterShop) {
        transformedData = transformedData.filter(item =>
          item.shop_name.toLowerCase().includes(filterShop.toLowerCase())
        )
      }

      // MMYY is now filtered server-side above — no client filter needed

      setActivations(transformedData)
    } catch (error: any) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  const handleSort = (column: string) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
    } else {
      setSortColumn(column)
      setSortDirection('asc')
    }
  }

  const handleDragStart = (column: string) => {
    setDraggedColumn(column)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const handleDrop = (targetColumn: string) => {
    if (!draggedColumn || draggedColumn === targetColumn) return

    const newOrder = [...columnOrder]
    const draggedIndex = newOrder.indexOf(draggedColumn)
    const targetIndex = newOrder.indexOf(targetColumn)

    if (draggedIndex !== -1 && targetIndex !== -1) {
      newOrder[draggedIndex] = targetColumn
      newOrder[targetIndex] = draggedColumn
      setColumnOrder(newOrder)
    }
    setDraggedColumn(null)
  }

  const totalPages = Math.ceil(totalCount / pageSize)

  const loadStats = async () => {
    try {
      // Use server-side RPC to get all stats in a single query (no 1000-row cap)
      // Unset filters are omitted so the functions' DEFAULT NULL applies.
      const { data: statsData, error: statsError } = await supabase.rpc('fn_consumer_activity_stats', {
        p_company_id: userProfile.organizations.id,
        p_order_id: (selectedOrderId && selectedOrderId !== 'all') ? selectedOrderId : undefined,
        p_activity_type: (selectedActivityType && selectedActivityType !== 'all') ? selectedActivityType : undefined,
      })

      if (statsError) throw statsError

      const row = Array.isArray(statsData) ? statsData[0] : statsData

      // Fetch point value from organization settings for cost calculation
      let pointValueRM = 0
      const { data: orgData } = await supabase
        .from('organizations')
        .select('settings')
        .eq('id', userProfile.organizations.id)
        .single()

      if (orgData?.settings && typeof orgData.settings === 'object') {
        const settings = orgData.settings as any
        if (settings.point_value_rm !== undefined) {
          pointValueRM = Number(settings.point_value_rm) || 0
        }
      }

      const totalPoints = Number(row?.total_points) || 0
      const totalCost = totalPoints * pointValueRM

      setStats({
        total_scans: Number(row?.total_scans) || 0,
        unique_consumers: Number(row?.unique_consumers) || 0,
        total_points: totalPoints,
        today_scans: Number(row?.today_scans) || 0,
        total_cost: totalCost,
      })
    } catch (error: any) {
      console.error('Error loading stats:', error)
    }
  }

  // ── Issue 3: load unique consumers list ──────────────────────────
  const loadUniqueConsumersList = async () => {
    setLoadingUniqueConsumers(true)
    try {
      // Use server-side RPC to aggregate and enrich (no 1000-row cap)
      const { data, error } = await supabase.rpc('fn_consumer_unique_list', {
        p_company_id: userProfile.organizations.id,
        p_order_id: (selectedOrderId && selectedOrderId !== 'all') ? selectedOrderId : undefined,
        p_activity_type: (selectedActivityType && selectedActivityType !== 'all') ? selectedActivityType : undefined,
      })

      if (error) throw error

      const list = (data || []).map((row: any) => ({
        phone: row.phone,
        name: row.name || '',
        email: row.email || '',
        count: Number(row.scan_count),
        lastActive: row.last_active,
      }))

      setUniqueConsumersList(list)
      setShowUniqueConsumers(true)
    } catch (error: any) {
      console.error('Error loading unique consumers:', error)
      toast({ title: 'Error', description: 'Failed to load unique consumers list', variant: 'destructive' })
    } finally {
      setLoadingUniqueConsumers(false)
    }
  }

  // ── Issue 4: open consumer detail dialog ─────────────────────────
  const openConsumerDetail = async (consumerUserId: string | null, consumerPhone: string | null) => {
    if (!consumerUserId && !consumerPhone) return
    setLoadingConsumerDetail(true)
    try {
      // Fetch the user record
      let userQuery = supabase
        .from('users')
        .select('*')
      if (consumerUserId) {
        userQuery = userQuery.eq('id', consumerUserId)
      } else {
        userQuery = userQuery.eq('phone', consumerPhone!)
      }
      const { data: userData } = await userQuery.maybeSingle()

      if (!userData) {
        toast({ title: 'User not found', description: 'No registered user found for this consumer.', variant: 'destructive' })
        return
      }

      // Fetch roles and organizations for the dialog
      const [rolesRes, orgsRes] = await Promise.all([
        supabase.from('roles').select('*').order('role_level'),
        supabase.from('organizations').select('*').eq('id', userProfile.organizations.id)
      ])

      setConsumerRoles(rolesRes.data || [])
      setConsumerOrgs(orgsRes.data || [])
      setSelectedConsumerUser(userData as User)
      setConsumerDialogOpen(true)
    } catch (error: any) {
      console.error('Error loading consumer detail:', error)
      toast({ title: 'Error', description: 'Failed to load consumer details', variant: 'destructive' })
    } finally {
      setLoadingConsumerDetail(false)
    }
  }

  const loadFeedback = async () => {
    if (!organizationId) return
    setFeedbackLoading(true)
    try {
      const { data, error } = await supabase
        .from('consumer_feedback')
        .select('*')
        .eq('org_id', organizationId)
        .order('created_at', { ascending: false })
        .limit(100)

      if (error) throw error
      setFeedback(data || [])
    } catch (error: any) {
      console.error('Error loading feedback:', error)
    } finally {
      setFeedbackLoading(false)
    }
  }

  // Delete feedback (Super Admin only)
  const handleDeleteFeedback = async (feedbackId: string) => {
    if (!isSuperAdmin) {
      toast({
        title: 'Permission Denied',
        description: 'Only Super Admin can delete feedback.',
        variant: 'destructive'
      })
      return
    }

    setDeletingFeedback(true)
    try {
      const { error } = await supabase
        .from('consumer_feedback')
        .delete()
        .eq('id', feedbackId)

      if (error) throw error

      // Remove from local state
      setFeedback(prev => prev.filter(f => f.id !== feedbackId))
      setFeedbackToDelete(null)

      toast({
        title: 'Feedback Deleted',
        description: 'The feedback has been successfully deleted.',
      })
    } catch (error: any) {
      console.error('Error deleting feedback:', error)
      toast({
        title: 'Error',
        description: 'Failed to delete feedback. Please try again.',
        variant: 'destructive'
      })
    } finally {
      setDeletingFeedback(false)
    }
  }

  // Load feedback when switching to feedback tab
  useEffect(() => {
    if (activeTab === 'feedback' && feedback.length === 0 && !feedbackLoading) {
      loadFeedback()
    }
  }, [activeTab])

  return (
    <div className="sera-sc-page sera-page-enter">
      <SupplyChainPageHeader
        eyebrow="Customer & Growth"
        title="Consumer Activity"
        description="Track consumer QR code scans and engagement"
        actions={
          <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
            <div className="w-full sm:w-48">
              <Select value={selectedActivityType} onValueChange={setSelectedActivityType}>
                <SelectTrigger className="border-[var(--sera-line)] bg-white">
                  <div className="flex items-center gap-2">
                    <Filter className="w-4 h-4 text-[var(--sera-muted)]" />
                    <SelectValue placeholder="Activity Type" />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Activities</SelectItem>
                  <SelectItem value="lucky_draw">Lucky Draw</SelectItem>
                  <SelectItem value="points">Points Collected</SelectItem>
                  <SelectItem value="gift">Gift Redeemed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="w-full sm:w-64">
              <Select value={selectedOrderId} onValueChange={setSelectedOrderId}>
                <SelectTrigger className="border-[var(--sera-line)] bg-white">
                  <div className="flex items-center gap-2">
                    <Filter className="w-4 h-4 text-[var(--sera-muted)]" />
                    <SelectValue placeholder="Filter by Order" />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Orders</SelectItem>
                  {orders.map((order) => (
                    <SelectItem key={order.id} value={order.id}>
                      {order.order_no}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        }
      />

      {/* Statistics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <div className="sera-sc-kpi">
          <p className="sera-sc-kpi__label">Total Scans</p>
          <p className="sera-sc-kpi__value">{stats.total_scans.toLocaleString()}</p>
        </div>

        <div className="sera-sc-kpi">
          <p className="sera-sc-kpi__label">Unique Consumers</p>
          <button
            type="button"
            onClick={loadUniqueConsumersList}
            disabled={loadingUniqueConsumers}
            className="sera-sc-kpi__value text-left text-[var(--sera-orange)] hover:text-[var(--sera-orange-deep)] underline decoration-dotted underline-offset-4 disabled:opacity-50"
            title="Click to view unique consumers list"
          >
            {loadingUniqueConsumers ? '...' : stats.unique_consumers.toLocaleString()}
          </button>
        </div>

        <div className="sera-sc-kpi">
          <p className="sera-sc-kpi__label">Points Distributed</p>
          <p className="sera-sc-kpi__value">{stats.total_points.toLocaleString()}</p>
          <p className="text-xs text-[var(--sera-muted)] mt-1">Est. Cost: RM {stats.total_cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
        </div>

        <div className="sera-sc-kpi">
          <p className="sera-sc-kpi__label">Today&apos;s Scans</p>
          <p className="sera-sc-kpi__value">{stats.today_scans.toLocaleString()}</p>
        </div>
      </div>

      {/* Tabs for Activations and Feedback */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="h-auto w-full flex flex-wrap justify-start gap-1 bg-[var(--sera-mist)] border border-[var(--sera-line)] p-1.5 rounded-xl mb-4">
          <TabsTrigger value="activations" className="rounded-lg px-4 py-2 text-[var(--sera-muted)] data-[state=active]:bg-white data-[state=active]:text-[var(--sera-ink)] data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-[var(--sera-orange)]/30">Recent Activations</TabsTrigger>
          <TabsTrigger value="feedback" className="rounded-lg px-4 py-2 text-[var(--sera-muted)] data-[state=active]:bg-white data-[state=active]:text-[var(--sera-ink)] data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-[var(--sera-orange)]/30 flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            Consumer Feedback
          </TabsTrigger>
          <TabsTrigger value="scan_issues" className="rounded-lg px-4 py-2 text-[var(--sera-muted)] data-[state=active]:bg-white data-[state=active]:text-[var(--sera-ink)] data-[state=active]:shadow-sm data-[state=active]:border data-[state=active]:border-[var(--sera-orange)]/30 flex items-center gap-2">
            ⚠️ Scan Issues
          </TabsTrigger>
        </TabsList>

        <TabsContent value="activations">
          <div className="sera-sc-panel overflow-hidden">
            <div className="sera-sc-panel__head">
              <h2 className="sera-sc-panel__title">Recent Activations</h2>
            </div>
            <div className="sera-sc-filters">
              <Select value={filterProduct} onValueChange={setFilterProduct}>
                <SelectTrigger className="border-[var(--sera-line)] bg-white">
                  <SelectValue placeholder="Filter Product" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Products</SelectItem>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.product_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Input
                className="sera-sc-input border-[var(--sera-line)]"
                placeholder="MMYY (e.g. 1125)"
                value={filterMMYY}
                onChange={(e) => setFilterMMYY(e.target.value)}
              />

              <Input
                className="sera-sc-input border-[var(--sera-line)]"
                placeholder="Consumer Name/Phone"
                value={filterConsumer}
                onChange={(e) => setFilterConsumer(e.target.value)}
              />

              <Input
                className="sera-sc-input border-[var(--sera-line)]"
                placeholder="Shop Name"
                value={filterShop}
                onChange={(e) => setFilterShop(e.target.value)}
              />
            </div>
            <div className="sera-sc-panel__body">
              <div className="overflow-x-auto -mx-1">
                <table className="sera-sc-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      {columnOrder.map((col) => {
                        if (col === 'order') {
                          return (
                            <th
                              key="order"
                              draggable
                              onDragStart={() => handleDragStart('order')}
                              onDragOver={handleDragOver}
                              onDrop={() => handleDrop('order')}
                              className="is-draggable"
                            >
                              <div className="flex items-center gap-1">
                                Ord No
                                <span className="text-[10px] sera-sc-table__meta">(Drag)</span>
                              </div>
                            </th>
                          )
                        } else {
                          return (
                            <th
                              key="product"
                              draggable
                              onDragStart={() => handleDragStart('product')}
                              onDragOver={handleDragOver}
                              onDrop={() => handleDrop('product')}
                              className="is-draggable"
                              onClick={() => handleSort('product_id')}
                            >
                              <div className="flex items-center gap-1">
                                Product <ArrowUpDown className="w-3 h-3" />
                                <span className="text-[10px] sera-sc-table__meta">(Drag)</span>
                              </div>
                            </th>
                          )
                        }
                      })}
                      <th
                        className="is-sortable"
                        onClick={() => handleSort('sequence_number')}
                      >
                        <div className="flex items-center gap-1">Seq <ArrowUpDown className="w-3 h-3" /></div>
                      </th>
                      <th
                        className="is-sortable"
                        onClick={() => handleSort('updated_at')}
                      >
                        <div className="flex items-center gap-1">Date & Time <ArrowUpDown className="w-3 h-3" /></div>
                      </th>
                      <th
                        className="is-sortable"
                        onClick={() => handleSort('consumer_name')}
                      >
                        <div className="flex items-center gap-1">Consumer <ArrowUpDown className="w-3 h-3" /></div>
                      </th>
                      <th>ID Shop</th>
                      <th>User</th>
                      <th
                        className="is-sortable"
                        onClick={() => handleSort('points_value')}
                      >
                        <div className="flex items-center gap-1">Points <ArrowUpDown className="w-3 h-3" /></div>
                      </th>
                      <th>Redeem</th>
                      <th>GameCard</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr>
                        <td colSpan={10} className="sera-sc-table__empty">Loading...</td>
                      </tr>
                    ) : activations.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="sera-sc-table__empty">No activations found</td>
                      </tr>
                    ) : (
                      activations.map((activation, index) => {
                        const rowNumber = (currentPage - 1) * pageSize + index + 1
                        return (
                          <tr key={activation.id}>
                            <td className="font-medium">
                              {rowNumber}
                            </td>
                            {columnOrder.map((col) => {
                              if (col === 'order') {
                                return (
                                  <td key="order" className="px-4 py-3">
                                    <div className="flex flex-col">
                                      <span className="text-xs font-medium text-[var(--sera-orange)]">{activation.order_doc_no}</span>
                                      {activation.legacy_order_no && (
                                        <span className="sera-sc-table__meta">Legacy: {activation.legacy_order_no}</span>
                                      )}
                                    </div>
                                  </td>
                                )
                              } else {
                                return (
                                  <td key="product" className="px-4 py-3">
                                    <div className="flex items-center gap-2">
                                      {activation.variant_image && (
                                        <Avatar className="h-8 w-8">
                                          <AvatarImage src={activation.variant_image} alt={activation.variant_name} />
                                          <AvatarFallback>{activation.variant_name?.charAt(0)}</AvatarFallback>
                                        </Avatar>
                                      )}
                                      <div>
                                        <p className="text-xs font-medium text-[var(--sera-ink)]">{activation.product_name}</p>
                                        {activation.variant_name && (
                                          <p className="sera-sc-table__meta">{activation.variant_name}</p>
                                        )}
                                      </div>
                                    </div>
                                  </td>
                                )
                              }
                            })}
                            <td className="px-4 py-3 text-xs text-gray-600">
                              {activation.sequence_number || '-'}
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-600">
                              <div className="flex flex-col">
                                <span className="font-medium">{new Date(activation.activated_at).toLocaleDateString()}</span>
                                <span className="text-[10px] text-gray-500">{new Date(activation.activated_at).toLocaleTimeString()}</span>
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <div>
                                {(activation.consumer_user_id || activation.consumer_phone) ? (
                                  <button
                                    onClick={() => openConsumerDetail(activation.consumer_user_id, activation.consumer_phone)}
                                    disabled={loadingConsumerDetail}
                                    className="text-xs font-medium text-[var(--sera-orange)] hover:text-[var(--sera-orange-deep)] hover:underline cursor-pointer text-left disabled:opacity-50"
                                    title="Click to view consumer details"
                                  >
                                    {activation.consumer_name || 'Anonymous'}
                                  </button>
                                ) : (
                                  <p className="text-xs font-medium text-[var(--sera-ink)]">
                                    {activation.consumer_name || 'Anonymous'}
                                  </p>
                                )}
                                <p className="text-[10px] text-gray-500">{activation.consumer_phone}</p>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-600">
                              {activation.shop_name}
                            </td>
                            <td className="px-4 py-3">
                              {activation.independent_user_name ? (
                                <span className="text-[var(--sera-orange)] font-medium">{activation.independent_user_name}</span>
                              ) : (
                                <span className="text-[var(--sera-muted)]">-</span>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              {activation.points_awarded > 0 ? (
                                <span className="text-[10px] font-medium text-green-600">
                                  +{activation.points_awarded}
                                </span>
                              ) : (
                                <span className="text-xs text-gray-500">-</span>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              {activation.gift_redeemed ? (
                                <div className="flex items-center gap-2">
                                  {activation.gift_image && (
                                    <Avatar className="h-6 w-6">
                                      <AvatarImage src={activation.gift_image} alt={activation.gift_name} />
                                      <AvatarFallback>R</AvatarFallback>
                                    </Avatar>
                                  )}
                                  <span className="text-xs text-gray-700">
                                    {activation.gift_name || 'Redeemed'}
                                  </span>
                                </div>
                              ) : (
                                <span className="text-xs text-gray-500">-</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-600">
                              {activation.game_card_won ? (
                                <div className="flex items-center gap-2">
                                  {activation.game_card_image ? (
                                    <Avatar className="h-6 w-6">
                                      <AvatarImage src={activation.game_card_image} alt={activation.game_card_name} />
                                      <AvatarFallback>W</AvatarFallback>
                                    </Avatar>
                                  ) : (
                                    <Trophy className="h-4 w-4 text-yellow-500" />
                                  )}
                                  <span className="text-xs text-gray-700">
                                    {activation.game_card_name || 'Won'}
                                  </span>
                                </div>
                              ) : (
                                <span className="text-xs text-gray-500">-</span>
                              )}
                            </td>
                          </tr>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="flex items-center justify-between mt-4 pt-4 border-t border-[var(--sera-line)]">
                <div className="text-sm text-[var(--sera-muted)]">
                  Showing {((currentPage - 1) * pageSize) + 1} to {Math.min(currentPage * pageSize, totalCount)} of {totalCount} results
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <span className="text-sm font-medium">Page {currentPage} of {totalPages || 1}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages || totalPages === 0}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="feedback">
          <div className="space-y-4">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              <div className="sera-sc-kpi">
                <p className="sera-sc-kpi__label">Total Feedback</p>
                <p className="sera-sc-kpi__value">{feedbackSummary.total}</p>
              </div>
              <div className="sera-sc-kpi">
                <p className="sera-sc-kpi__label">Pending</p>
                <p className="sera-sc-kpi__value text-[var(--sera-orange)]">{feedbackSummary.pending}</p>
              </div>
              <div className="sera-sc-kpi">
                <p className="sera-sc-kpi__label">Reviewed</p>
                <p className="sera-sc-kpi__value">{feedbackSummary.reviewed}</p>
              </div>
              <div className="sera-sc-kpi">
                <p className="sera-sc-kpi__label">Resolved</p>
                <p className="sera-sc-kpi__value">{feedbackSummary.resolved}</p>
              </div>
            </div>

            <div className="sera-sc-panel overflow-hidden">
              <div className="sera-sc-panel__head">
                <h2 className="sera-sc-panel__title flex items-center gap-2">
                  <MessageSquare className="h-5 w-5 text-[var(--sera-orange)]" />
                  Consumer Feedback
                </h2>
              </div>
              <div className="sera-sc-panel__body">
              {feedbackLoading ? (
                <div className="sera-sc-table__empty">Loading feedback...</div>
              ) : feedback.length === 0 ? (
                <div className="sera-sc-empty">
                  <div className="sera-sc-empty__icon">
                    <MessageSquare className="h-8 w-8" />
                  </div>
                  <p className="sera-sc-empty__title">No feedback yet</p>
                  <p className="sera-sc-empty__text">Consumer feedback will appear here when submitted through the app.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {feedback.map((item: any) => (
                    <div key={item.id} className="sera-sc-feed-card">
                      <div className="flex justify-between items-start gap-3 mb-2">
                        <div className="min-w-0">
                          <h4 className="font-semibold text-[var(--sera-ink)]">{item.title}</h4>
                          <p className="text-sm text-[var(--sera-muted)] mt-0.5">
                            From: {item.consumer_name || 'Anonymous'}
                            {item.consumer_phone && ` • ${item.consumer_phone}`}
                            {item.consumer_email && ` • ${item.consumer_email}`}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className={`sera-sc-badge ${
                            item.status === 'new' ? 'sera-sc-badge--info' :
                            item.status === 'reviewed' ? 'sera-sc-badge--orange' :
                            item.status === 'resolved' ? 'sera-sc-badge--success' :
                            'sera-sc-badge--ink'
                          }`}>
                            {item.status || 'new'}
                          </span>
                          <span className="text-xs text-[var(--sera-muted)]">
                            {new Date(item.created_at).toLocaleDateString()}
                          </span>
                          {isSuperAdmin && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 text-red-500 hover:text-red-700 hover:bg-red-50"
                              onClick={() => setFeedbackToDelete(item)}
                              title="Delete Feedback (Super Admin Only)"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </div>
                      <p className="text-sm text-[var(--sera-ink-soft)] whitespace-pre-wrap leading-relaxed">{item.message}</p>
                    </div>
                  ))}
                </div>
              )}
              </div>
            </div>
          </div>
        </TabsContent>

        {/* Scan Issues Tab */}
        <TabsContent value="scan_issues">
          <ScanIssuesTab />
        </TabsContent>

        {/* WhatsApp Activity Tab */}
        <TabsContent value="whatsapp">
          <div className="sera-sc-panel overflow-hidden">
            <div className="sera-sc-panel__head">
              <h2 className="sera-sc-panel__title flex items-center gap-2">
                <MessageCircle className="h-5 w-5 text-[var(--sera-orange)]" />
                WhatsApp Activity
              </h2>
            </div>
            <div className="sera-sc-filters sm:grid-cols-3">
              <Select value={waFilterPurpose} onValueChange={(v) => { setWaFilterPurpose(v); setWaPage(1) }}>
                <SelectTrigger className="border-[var(--sera-line)] bg-white">
                  <SelectValue placeholder="All Purposes" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Purposes</SelectItem>
                  <SelectItem value="password_reset">Password Reset</SelectItem>
                  <SelectItem value="registration_verification">Registration</SelectItem>
                  <SelectItem value="phone_verification">Phone Verification</SelectItem>
                </SelectContent>
              </Select>
              <Select value={waFilterStatus} onValueChange={(v) => { setWaFilterStatus(v); setWaPage(1) }}>
                <SelectTrigger className="border-[var(--sera-line)] bg-white">
                  <SelectValue placeholder="All Statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="sent">Sent</SelectItem>
                  <SelectItem value="delivered">Delivered</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="verified">Verified</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="rate_limited">Rate Limited</SelectItem>
                  <SelectItem value="no_account">No Account</SelectItem>
                  <SelectItem value="send_failed">Send Failed</SelectItem>
                </SelectContent>
              </Select>
              <Input
                className="sera-sc-input border-[var(--sera-line)]"
                placeholder="Filter by phone..."
                value={waFilterPhone}
                onChange={(e) => { setWaFilterPhone(e.target.value); setWaPage(1) }}
              />
            </div>
            <div className="sera-sc-panel__body">
              {waLoading ? (
                <div className="sera-sc-table__empty">Loading WhatsApp activity...</div>
              ) : waEvents.length === 0 ? (
                <div className="sera-sc-table__empty">No WhatsApp activity found</div>
              ) : (
                <>
                  <div className="overflow-x-auto -mx-1">
                    <table className="sera-sc-table">
                      <thead>
                        <tr>
                          <th>Date & Time</th>
                          <th>Phone</th>
                          <th>Event</th>
                          <th>Purpose</th>
                          <th>Status</th>
                          <th>Provider</th>
                          <th>Error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {waEvents.map((evt: any) => (
                          <tr key={evt.id}>
                            <td className="whitespace-nowrap">
                              {new Date(evt.created_at).toLocaleString()}
                            </td>
                            <td className="font-mono text-[var(--sera-ink)]">
                              {evt.recipient_phone || '-'}
                            </td>
                            <td>
                              {(evt.event_type || '').replace(/_/g, ' ')}
                            </td>
                            <td>
                              <Badge variant="outline" className="text-[10px] border-[var(--sera-line)]">
                                {(evt.purpose || '').replace(/_/g, ' ')}
                              </Badge>
                            </td>
                            <td>
                              <span className={`sera-sc-badge ${
                                evt.status === 'sent' || evt.status === 'completed' ? 'sera-sc-badge--success' :
                                evt.status === 'failed' || evt.status === 'send_failed' ? 'sera-sc-badge--ink bg-red-50 text-red-700' :
                                evt.status === 'verified' ? 'sera-sc-badge--info' :
                                evt.status === 'rate_limited' ? 'sera-sc-badge--orange' :
                                'sera-sc-badge--ink'
                              }`}>
                                {evt.status}
                              </span>
                            </td>
                            <td className="text-[var(--sera-muted)]">{evt.provider || '-'}</td>
                            <td className="text-red-600 max-w-[200px] truncate" title={evt.error_message || ''}>
                              {evt.error_message || '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex items-center justify-between mt-4 pt-4 border-t border-[var(--sera-line)]">
                    <p className="text-sm text-[var(--sera-muted)]">
                      Showing {(waPage - 1) * waPageSize + 1} to {Math.min(waPage * waPageSize, waTotal)} of {waTotal} results
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-[var(--sera-line)]"
                        disabled={waPage <= 1}
                        onClick={() => setWaPage((p) => Math.max(1, p - 1))}
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </Button>
                      <span className="text-sm text-[var(--sera-ink)]">
                        Page {waPage} of {Math.max(1, Math.ceil(waTotal / waPageSize))}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-[var(--sera-line)]"
                        disabled={waPage * waPageSize >= waTotal}
                        onClick={() => setWaPage((p) => p + 1)}
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </TabsContent>
      </Tabs>

      {/* Delete Feedback Confirmation Dialog */}
      <AlertDialog open={!!feedbackToDelete} onOpenChange={(open) => !open && setFeedbackToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Feedback</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this feedback? This action cannot be undone.
              <div className="mt-4 p-3 bg-gray-50 rounded-lg">
                <p className="font-medium text-gray-900">{feedbackToDelete?.title}</p>
                <p className="text-sm text-gray-600 mt-1">{feedbackToDelete?.message?.substring(0, 100)}{feedbackToDelete?.message?.length > 100 ? '...' : ''}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletingFeedback}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => feedbackToDelete && handleDeleteFeedback(feedbackToDelete.id)}
              disabled={deletingFeedback}
              className="bg-red-600 hover:bg-red-700"
            >
              {deletingFeedback ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Unique Consumers Dialog (Issue 3) */}
      <Dialog open={showUniqueConsumers} onOpenChange={setShowUniqueConsumers}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="h-5 w-5 text-green-600" />
              Unique Consumers ({uniqueConsumersList.length})
            </DialogTitle>
          </DialogHeader>
          <div className="overflow-y-auto flex-1 -mx-6 px-6">
            {loadingUniqueConsumers ? (
              <div className="text-center py-8 text-gray-500">Loading...</div>
            ) : uniqueConsumersList.length === 0 ? (
              <div className="text-center py-8 text-gray-500">No consumers found</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white border-b">
                  <tr>
                    <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">#</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">Consumer</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">Phone</th>
                    <th className="text-right px-3 py-2 text-xs font-medium text-gray-500">Scans</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-gray-500">Last Active</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {uniqueConsumersList.map((consumer, idx) => (
                    <tr key={consumer.phone} className="hover:bg-gray-50">
                      <td className="px-3 py-2 text-xs text-gray-500">{idx + 1}</td>
                      <td className="px-3 py-2">
                        <button
                          onClick={() => {
                            setShowUniqueConsumers(false)
                            openConsumerDetail(null, consumer.phone)
                          }}
                          className="text-xs font-medium text-blue-600 hover:text-blue-800 hover:underline cursor-pointer text-left"
                        >
                          {consumer.name || 'Anonymous'}
                        </button>
                        {consumer.email && (
                          <p className="text-[10px] text-gray-400">{consumer.email}</p>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-600">{consumer.phone}</td>
                      <td className="px-3 py-2 text-xs text-right font-medium text-gray-900">{consumer.count}</td>
                      <td className="px-3 py-2 text-xs text-gray-500">{new Date(consumer.lastActive).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Consumer Detail Dialog (Issue 4) */}
      <UserDialogNew
        user={selectedConsumerUser}
        roles={consumerRoles}
        organizations={consumerOrgs}
        open={consumerDialogOpen}
        currentUserRoleLevel={userProfile.roles?.role_level ?? 100}
        onOpenChange={(open) => {
          setConsumerDialogOpen(open)
          if (!open) setSelectedConsumerUser(null)
        }}
        onSave={async (userData) => {
          try {
            if (!selectedConsumerUser?.id) return
            // Server-side: profile fields only through the admin whitelist;
            // role/organization/status through the identity functions.
            const { updateUserWithAuth } = await import('@/lib/actions')
            const result = await updateUserWithAuth(selectedConsumerUser.id, userData as any)
            if (!result.success) throw new Error(result.error || 'Failed to update consumer.')
            toast({ title: 'Success', description: 'Consumer details updated.' })
            setConsumerDialogOpen(false)
            setSelectedConsumerUser(null)
            loadActivations()
          } catch (err: any) {
            toast({ title: 'Error', description: err.message || 'Failed to update consumer.', variant: 'destructive' })
          }
        }}
      />
    </div>
  )
}
