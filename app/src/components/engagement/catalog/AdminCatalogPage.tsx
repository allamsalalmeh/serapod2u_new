"use client"

import Link from "next/link"
import Image from "next/image"
import { useEffect, useMemo, useState } from "react"
import { createClient } from "@/lib/supabase/client"
import type { Database } from "@/types/database"
import type { UserProfileWithRelations } from "@/lib/server/get-user-profile"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { getStorageUrl } from "@/lib/utils"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { UserPointsMonitor } from "./UserPointsMonitor"
import {
  CATEGORY_LABELS,
  EnrichedReward,
  RewardCategory,
  RewardStatus,
  enrichReward,
  formatDateLabel,
  formatNumber,
  getStatusBadgeClass
} from "./catalog-utils"
import {
  BarChart3,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  CreditCard,
  Edit,
  Filter,
  ListChecks,
  Loader2,
  User,
  Package,
  PlusCircle,
  Search,
  ShieldAlert,
  Sparkles,
  TrendingUp,
  Users,
  Save,
  Trophy,
  Settings,
  Gift,
  MapPin,
  Phone,
  Mail,
  Calendar,
  CheckCircle,
  XCircle,
  AlertCircle,
  Truck,
  MessageSquare,
  RefreshCw,
  ArrowUpDown,
  Home
} from "lucide-react"
import { PointsConfigurationSettings } from './PointsConfigurationSettings'
import { CategorySettingsDialog } from './CategorySettingsDialog'
import { ReferralMonitor } from './ReferralMonitor'
import { ReferenceChangeLog } from './ReferenceChangeLog'
import { ReferralDetail } from './ReferralDetail'
import { ShopPointsReport } from './ShopPointsReport'
import { DEFAULT_REPORT_STATUS_SETTINGS, normalizeReportStatusSettings, type ReportStatusSettings } from '@/lib/engagement/report-status-settings'
import { referenceSuffix, reportClientError } from '@/lib/system-logs/client'

type RedeemItemRow = Database["public"]["Tables"]["redeem_items"]["Row"]
type PointsTransactionRow = Database["public"]["Tables"]["points_transactions"]["Row"]

interface ShopUser {
  user_id: string
  shop_name: string
  shop_phone: string
  shop_email: string | null
  organization_id: string
  current_balance: number
  total_collected: number
  total_collected_system: number
  total_collected_manual: number
  total_redeemed: number
  last_transaction_date: string | null
  transaction_count: number
}

interface AdminCatalogPageProps {
  userProfile: UserProfileWithRelations
}

const SORT_OPTIONS = [
  { value: "updated-desc", label: "Recently Updated" },
  { value: "points-asc", label: "Points: Low to High" },
  { value: "points-desc", label: "Points: High to Low" },
  { value: "stock-asc", label: "Stock: Low to High" }
]

function getTransactionDate(txn: PointsTransactionRow): Date {
  const raw = txn.transaction_date ?? txn.created_at
  return raw ? new Date(raw) : new Date()
}

function formatRelative(date: Date): string {
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()
  const diffMinutes = Math.round(diffMs / (1000 * 60))

  if (Math.abs(diffMinutes) < 60) {
    if (diffMinutes === 0) return "just now"
    return diffMinutes > 0 ? `in ${diffMinutes}m` : `${Math.abs(diffMinutes)}m ago`
  }

  const diffHours = Math.round(diffMs / (1000 * 60 * 60))
  if (Math.abs(diffHours) < 24) {
    return diffHours > 0 ? `in ${diffHours}h` : `${Math.abs(diffHours)}h ago`
  }

  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))
  if (Math.abs(diffDays) < 14) {
    return diffDays > 0 ? `in ${diffDays}d` : `${Math.abs(diffDays)}d ago`
  }

  return new Intl.DateTimeFormat("en-MY", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(date)
}

export function AdminCatalogPage({ userProfile }: AdminCatalogPageProps) {
  const supabase = createClient()
  const [rewards, setRewards] = useState<RedeemItemRow[]>([])
  const [transactions, setTransactions] = useState<PointsTransactionRow[]>([])
  const [shopStaffUsers, setShopStaffUsers] = useState<any[]>([])
  const [consumerUsers, setConsumerUsers] = useState<any[]>([])
  const [shopStaffLoadError, setShopStaffLoadError] = useState<string | null>(null)
  const [consumerLoadError, setConsumerLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [usersLoading, setUsersLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<"all" | RewardStatus>("all")
  const [categoryFilter, setCategoryFilter] = useState<"all" | RewardCategory>("all")
  const [searchTerm, setSearchTerm] = useState("")
  const [sortOption, setSortOption] = useState<string>("updated-desc")
  const [activeTab, setActiveTab] = useState<"rewards" | "users" | "staff" | "consumers" | "settings" | "redemptions" | "feedback" | "referral">("rewards")

  const [categoryLabels, setCategoryLabels] = useState<Record<RewardCategory, string>>(CATEGORY_LABELS)
  const [showCategorySettings, setShowCategorySettings] = useState(false)
  const [reportStatusSettings, setReportStatusSettings] = useState<ReportStatusSettings>(DEFAULT_REPORT_STATUS_SETTINGS)

  // Referral states
  const [selectedReferenceId, setSelectedReferenceId] = useState<string | null>(null)

  // Feedback states
  const [feedback, setFeedback] = useState<any[]>([])
  const [feedbackLoading, setFeedbackLoading] = useState(false)
  const [feedbackPage, setFeedbackPage] = useState(1)
  const [feedbackTotalPages, setFeedbackTotalPages] = useState(1)
  const [feedbackStatusFilter, setFeedbackStatusFilter] = useState<string>("all")
  const FEEDBACK_PAGE_SIZE = 10

  // Redemption history states
  const [redemptions, setRedemptions] = useState<any[]>([])
  const [redemptionsLoading, setRedemptionsLoading] = useState(false)
  const [redemptionSearchTerm, setRedemptionSearchTerm] = useState("")
  const [redemptionStatusFilter, setRedemptionStatusFilter] = useState<"all" | "pending" | "processing" | "fulfilled" | "cancelled">("all")
  const [redemptionPage, setRedemptionPage] = useState(1)
  const [redemptionTotalPages, setRedemptionTotalPages] = useState(1)
  const REDEMPTION_PAGE_SIZE = 10

  // Reward Inventory State
  const [rewardCurrentPage, setRewardCurrentPage] = useState(1)
  const [rewardItemsPerPage, setRewardItemsPerPage] = useState(10)
  const [rewardSortConfig, setRewardSortConfig] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null)


  useEffect(() => {
    const loadSettings = async () => {
      const { data: orgData } = await supabase
        .from('organizations')
        .select('settings')
        .eq('id', userProfile.organizations.id)
        .single()

      if (orgData?.settings && typeof orgData.settings === 'object') {
        const settings = orgData.settings as any
        if (settings.category_labels) {
          setCategoryLabels({ ...CATEGORY_LABELS, ...settings.category_labels })
        }
        setReportStatusSettings(normalizeReportStatusSettings(settings))
      }
    }
    loadSettings()
  }, [supabase, userProfile.organizations.id])

  // Points adjustment modal
  const [showAdjustPointsModal, setShowAdjustPointsModal] = useState(false)
  const [selectedUser, setSelectedUser] = useState<ShopUser | null>(null)
  const [pointsAdjustment, setPointsAdjustment] = useState({
    amount: 0,
    type: 'add' as 'add' | 'subtract',
    description: ''
  })

  const companyId = userProfile.organizations.id

  useEffect(() => {
    let cancelled = false
    const supabaseClient = createClient()

    async function loadAdminData() {
      setLoading(true)
      setError(null)

      const [rewardsRes, transactionsRes] = await Promise.all([
        supabaseClient
          .from("redeem_items")
          .select("*")
          .eq("company_id", companyId)
          .order("updated_at", { ascending: false }),
        supabaseClient
          .from("points_transactions")
          .select("*")
          .eq("company_id", companyId)
          .eq("transaction_type", "redeem")
          .order("transaction_date", { ascending: false })
          .limit(250)
      ])

      if (cancelled) return

      if (rewardsRes.error) {
        console.error("Failed to fetch rewards", rewardsRes.error)
        setError("Unable to load reward catalog. Please try again later.")
      } else {
        setRewards(rewardsRes.data ?? [])
      }

      if (transactionsRes.error) {
        console.warn("Failed to fetch redemption transactions", transactionsRes.error)
      } else {
        setTransactions(transactionsRes.data ?? [])
      }

      setLoading(false)
    }

    loadAdminData()

    return () => {
      cancelled = true
    }
  }, [companyId])

  // The 'users' tab (Shop Points Monitor) loads its own data through
  // /api/admin/shop-points-report, so only staff/consumer tabs are loaded here.
  useEffect(() => {
    if (activeTab === 'staff' && shopStaffUsers.length === 0) {
      loadShopStaffUsers()
    } else if (activeTab === 'consumers' && consumerUsers.length === 0) {
      loadConsumerUsers()
    }
  }, [activeTab])

  // Load redemptions when switching to redemptions tab
  useEffect(() => {
    if (activeTab === 'redemptions') {
      loadRedemptions()
    }
  }, [activeTab])

  // Load feedback when switching to feedback tab
  useEffect(() => {
    if (activeTab === 'feedback') {
      loadFeedback()
    }
  }, [activeTab])

  async function loadFeedback(page = 1) {
    setFeedbackLoading(true)
    try {
      const response = await fetch(`/api/admin/feedback?page=${page}&limit=${FEEDBACK_PAGE_SIZE}&status=${feedbackStatusFilter}`)
      const result = await response.json()

      if (result.success) {
        setFeedback(result.feedback || [])
        setFeedbackTotalPages(result.totalPages || 1)
        setFeedbackPage(page)
      } else {
        console.error("Failed to load feedback:", result.error)
      }
    } catch (error) {
      console.error("Error loading feedback:", error)
    } finally {
      setFeedbackLoading(false)
    }
  }

  async function updateFeedbackStatus(id: string, newStatus: string) {
    try {
      const response = await fetch('/api/admin/feedback', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id, status: newStatus }),
      })

      const result = await response.json()

      if (!result.success) {
        throw new Error(result.error || 'Failed to update status')
      }

      // Reload feedback
      loadFeedback(feedbackPage)
    } catch (error) {
      console.error("Error updating feedback status:", error)
      alert("Failed to update status")
    }
  }

  async function loadConsumerUsers() {
    setUsersLoading(true)
    setConsumerLoadError(null)
    try {
      const response = await fetch('/api/admin/consumer-performance', { cache: 'no-store' })
      const result = await response.json()

      if (!response.ok) {
        throw Object.assign(new Error(result.error || 'Failed to load consumer performance'), { response, body: result })
      }

      setConsumerUsers(result.data || [])
    } catch (error: any) {
      console.error("Error loading consumer users:", error)
      setConsumerUsers([])
      const ref = reportClientError(error, { module: 'Product Catalog', action: 'Load consumer performance', response: error?.response, body: error?.body, method: 'GET', apiRoute: '/api/admin/consumer-performance' })
      setConsumerLoadError(`${error?.message || 'Failed to load consumer performance'}${referenceSuffix(ref)}`)
    } finally {
      setUsersLoading(false)
    }
  }

  async function loadShopStaffUsers() {
    setUsersLoading(true)
    setShopStaffLoadError(null)
    try {
      const response = await fetch('/api/admin/shop-staff-performance', { cache: 'no-store' })
      const result = await response.json()

      if (!response.ok) {
        throw Object.assign(new Error(result.error || 'Failed to load shop staff performance'), { response, body: result })
      }

      setShopStaffUsers(result.data || [])
    } catch (error: any) {
      console.error('Error loading shop staff users:', error)
      setShopStaffUsers([])
      const ref = reportClientError(error, { module: 'Product Catalog', action: 'Load shop staff performance', response: error?.response, body: error?.body, method: 'GET', apiRoute: '/api/admin/shop-staff-performance' })
      setShopStaffLoadError(`${error?.message || 'Failed to load shop staff performance'}${referenceSuffix(ref)}`)
    } finally {
      setUsersLoading(false)
    }
  }

  async function loadRedemptions(page = 1) {
    setRedemptionsLoading(true)

    try {
      console.log("🎁 Loading redemptions for company:", companyId)

      // Use API endpoint to bypass RLS
      const response = await fetch(`/api/admin/redemption-history?page=${page}&limit=${REDEMPTION_PAGE_SIZE}`)
      const result = await response.json()

      if (!result.success) {
        console.error("❌ Failed to load redemptions", result.error)
        setRedemptionsLoading(false)
        return
      }

      console.log("✅ Loaded redemptions:", result.redemptions?.length || 0)
      setRedemptions(result.redemptions || [])
      setRedemptionTotalPages(result.totalPages || 1)
      setRedemptionPage(page)
    } catch (error) {
      console.error("Error loading redemptions:", error)
    } finally {
      setRedemptionsLoading(false)
    }
  }

  async function updateRedemptionStatus(transactionId: string, newStatus: string, notes?: string) {
    const supabaseClient = createClient()

    try {
      const updateData: any = {
        fulfillment_status: newStatus
      }

      if (newStatus === 'fulfilled' || newStatus === 'processing') {
        updateData.fulfilled_by = userProfile.id
      }

      if (newStatus === 'fulfilled') {
        updateData.fulfilled_at = new Date().toISOString()
      }

      if (notes) {
        updateData.fulfillment_notes = notes
      }

      const { error } = await supabaseClient
        .from('points_transactions')
        .update(updateData)
        .eq('id', transactionId)

      if (error) {
        console.error('Error updating redemption status:', error)
        alert('Failed to update status: ' + error.message)
        return
      }

      // Reload redemptions
      await loadRedemptions(redemptionPage)
      alert(`Status updated to ${newStatus}`)
    } catch (error) {
      console.error('Error updating redemption status:', error)
      alert('Failed to update status')
    }
  }

  async function handleAdjustPoints() {
    if (!selectedUser || pointsAdjustment.amount === 0) {
      alert('Please enter a valid amount')
      return
    }

    const supabaseClient = createClient()
    const finalAmount = pointsAdjustment.type === 'subtract'
      ? -Math.abs(pointsAdjustment.amount)
      : Math.abs(pointsAdjustment.amount)

    const newBalance = selectedUser.current_balance + finalAmount

    if (newBalance < 0) {
      alert('Cannot subtract more points than user has')
      return
    }

    try {
      const adjustmentType = pointsAdjustment.type === 'add' ? 'manual_add' : 'manual_subtract'
      const isConsumer = !selectedUser.organization_id && selectedUser.user_id

      // Create manual adjustment record in consumer_qr_scans for audit trail
      const scanData: any = {
        qr_code_id: null,
        collected_points: true,
        points_amount: Math.abs(finalAmount),
        points_collected_at: new Date().toISOString(),
        is_manual_adjustment: true,
        adjusted_by: userProfile.id,
        adjustment_reason: pointsAdjustment.description || `Admin ${pointsAdjustment.type} - manual adjustment`,
        adjustment_type: adjustmentType
      }

      if (isConsumer) {
        scanData.consumer_id = selectedUser.user_id
      } else {
        scanData.shop_id = selectedUser.organization_id
      }

      const { error: scanError } = await supabaseClient
        .from('consumer_qr_scans')
        .insert(scanData)

      if (scanError) {
        console.error('Error creating adjustment record:', scanError)
        alert('Failed to adjust points: ' + scanError.message)
        return
      }

      // Also create in points_transactions for backward compatibility
      const txnData: any = {
        company_id: companyId,
        transaction_type: 'adjust',
        points_amount: finalAmount,
        balance_after: newBalance,
        description: pointsAdjustment.description || 'Admin adjustment - manual modification',
        transaction_date: new Date().toISOString(),
        // Taxonomy dual-write (Phase 1)
        point_category: 'adjustment',
        point_indicator: 'manual',
        point_owner_type: isConsumer ? 'consumer' : 'shop',
        point_direction: finalAmount < 0 ? 'spend' : 'earn',
      }

      if (isConsumer) {
        txnData.user_id = selectedUser.user_id
        txnData.consumer_phone = selectedUser.consumer_phone
        txnData.consumer_email = selectedUser.consumer_email
      } else {
        txnData.consumer_phone = selectedUser.shop_phone
        txnData.consumer_email = selectedUser.shop_email
      }

      const { error: txnError } = await supabaseClient
        .from('points_transactions')
        .insert(txnData)

      if (txnError) {
        console.warn('Warning: Failed to create transaction record:', txnError)
      }

      // Reload users
      if (isConsumer) {
        await loadConsumerUsers()
      } else {
        await loadShopStaffUsers()
      }

      setShowAdjustPointsModal(false)
      setSelectedUser(null)
      setPointsAdjustment({ amount: 0, type: 'add', description: '' })

      alert(`Successfully ${pointsAdjustment.type === 'add' ? 'added' : 'subtracted'} ${Math.abs(finalAmount)} points`)
    } catch (error) {
      console.error('Error adjusting points:', error)
      alert('Failed to adjust points')
    }
  }

  const enrichedRewards = useMemo<EnrichedReward[]>(() => {
    const now = new Date()
    return rewards.map((reward) => enrichReward(reward, now))
  }, [rewards])

  const rewardMap = useMemo(() => {
    const map = new Map<string, EnrichedReward>()
    enrichedRewards.forEach((reward) => map.set(reward.id, reward))
    return map
  }, [enrichedRewards])

  const summaryStats = useMemo(() => {
    const now = new Date()
    const soonThreshold = new Date(now)
    soonThreshold.setDate(now.getDate() + 7)

    const totals = {
      total: enrichedRewards.length,
      available: 0,
      scheduled: 0,
      paused: 0,
      expired: 0,
      soldOut: 0,
      lowStock: 0,
      endingSoon: 0
    }

    enrichedRewards.forEach((reward) => {
      const statusKey = reward.status as keyof typeof totals
      if (statusKey in totals) {
        totals[statusKey] += 1
      }
      if (reward.lowStock) totals.lowStock += 1
      if (reward.valid_until && new Date(reward.valid_until) <= soonThreshold && reward.status === "available") {
        totals.endingSoon += 1
      }
    })

    return totals
  }, [enrichedRewards])

  const redemptionAnalytics = useMemo(() => {
    const now = new Date()
    const monthAgo = new Date(now)
    monthAgo.setDate(now.getDate() - 30)

    const recentTransactions = transactions.filter((txn) => getTransactionDate(txn) >= monthAgo)
    const totalRedemptions = recentTransactions.length
    const totalPointsRedeemed = recentTransactions.reduce((sum, txn) => sum + Math.abs(txn.points_amount), 0)

    const redemptionMap = new Map<
      string,
      {
        rewardId: string
        count: number
        points: number
        reward: EnrichedReward | undefined
      }
    >()

    transactions.forEach((txn) => {
      const rewardId = txn.redeem_item_id ?? "unknown"
      const entry = redemptionMap.get(rewardId) ?? {
        rewardId,
        count: 0,
        points: 0,
        reward: txn.redeem_item_id ? rewardMap.get(txn.redeem_item_id) : undefined
      }
      entry.count += 1
      entry.points += Math.abs(txn.points_amount)
      redemptionMap.set(rewardId, entry)
    })

    const topRewards = Array.from(redemptionMap.values())
      .filter((entry) => entry.reward)
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)

    const maxCount = topRewards[0]?.count ?? 0

    const recentFeed = transactions.slice(0, 8).map((txn) => {
      const reward = txn.redeem_item_id ? rewardMap.get(txn.redeem_item_id) : undefined
      const occurredAt = getTransactionDate(txn)
      return {
        id: txn.id,
        rewardName: reward?.item_name ?? "Reward redemption",
        points: Math.abs(txn.points_amount),
        when: occurredAt,
        label: formatRelative(occurredAt),
        consumer: txn.consumer_phone
      }
    })

    return {
      totalRedemptions,
      totalPointsRedeemed,
      topRewards,
      maxCount,
      recentFeed
    }
  }, [rewardMap, transactions])

  const filteredRewards = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    let base = enrichedRewards

    if (statusFilter !== "all") {
      base = base.filter((reward) => reward.status === statusFilter)
    }

    if (categoryFilter !== "all") {
      base = base.filter((reward) => reward.category === categoryFilter)
    }

    if (term) {
      base = base.filter((reward) => {
        return (
          reward.item_name.toLowerCase().includes(term) ||
          (reward.item_description ?? "").toLowerCase().includes(term) ||
          (reward.item_code ?? "").toLowerCase().includes(term)
        )
      })
    }

    return [...base].sort((a, b) => {
      if (rewardSortConfig) {
        const { key, direction } = rewardSortConfig
        let aValue = (a as any)[key]
        let bValue = (b as any)[key]

        if (aValue === bValue) return 0
        if (aValue === null || aValue === undefined) return 1
        if (bValue === null || bValue === undefined) return -1

        if (direction === 'asc') {
          return aValue < bValue ? -1 : 1
        } else {
          return aValue > bValue ? -1 : 1
        }
      }

      switch (sortOption) {
        case "points-asc":
          return a.points_required - b.points_required
        case "points-desc":
          return b.points_required - a.points_required
        case "stock-asc": {
          const stockA = typeof a.stock_quantity === "number" ? a.stock_quantity : Number.MAX_SAFE_INTEGER
          const stockB = typeof b.stock_quantity === "number" ? b.stock_quantity : Number.MAX_SAFE_INTEGER
          return stockA - stockB
        }
        case "updated-desc":
        default:
          return new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime()
      }
    })
  }, [categoryFilter, enrichedRewards, searchTerm, sortOption, statusFilter, rewardSortConfig])

  // Reward Pagination & Sorting Helpers
  const rewardTotalPages = Math.ceil(filteredRewards.length / rewardItemsPerPage)
  const rewardStartIndex = (rewardCurrentPage - 1) * rewardItemsPerPage
  const rewardEndIndex = rewardStartIndex + rewardItemsPerPage
  const paginatedRewards = filteredRewards.slice(rewardStartIndex, rewardEndIndex)

  const handleRewardSort = (key: string) => {
    let direction: 'asc' | 'desc' = 'asc'
    if (rewardSortConfig && rewardSortConfig.key === key && rewardSortConfig.direction === 'asc') {
      direction = 'desc'
    }
    setRewardSortConfig({ key, direction })
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-sm font-medium text-muted-foreground">Consumer Engagement • Admin View</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Point Catalog Management</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Manage rewards inventory and monitor shop point collections. Track shop balances earned through mobile app,
            publish new rewards, and oversee redemption activity across all shops.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline" className="gap-2">
            <Link href="/engagement/catalog">
              <Sparkles className="h-4 w-4" /> View shop experience
            </Link>
          </Button>
          <Button asChild className="gap-2">
            <Link href="/engagement/catalog/admin/new">
              <PlusCircle className="h-4 w-4" /> Create reward
            </Link>
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={(value) => { setActiveTab(value as typeof activeTab); if (value !== 'referral') setSelectedReferenceId(null); }} className="space-y-6" suppressHydrationWarning>
        <TabsList>
          <TabsTrigger value="rewards" className="gap-2">
            <Package className="h-4 w-4" /> Manage Rewards
          </TabsTrigger>
          <TabsTrigger value="users" className="gap-2">
            <Users className="h-4 w-4" /> Shop Performance
          </TabsTrigger>
          <TabsTrigger value="staff" className="gap-2">
            <Users className="h-4 w-4" /> Shop Staff Performance
          </TabsTrigger>
          <TabsTrigger value="consumers" className="gap-2">
            <Users className="h-4 w-4" /> Consumer Performance
          </TabsTrigger>
          <TabsTrigger value="redemptions" className="gap-2">
            <Gift className="h-4 w-4" /> Redemption History
          </TabsTrigger>
          <TabsTrigger value="referral" className="gap-2">
            <TrendingUp className="h-4 w-4" /> Referral Monitor
          </TabsTrigger>
          <TabsTrigger value="settings" className="gap-2">
            <Settings className="h-4 w-4" /> Settings
          </TabsTrigger>
        </TabsList>

        {/* MANAGE REWARDS TAB */}
        <TabsContent value="rewards" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Card className="border-slate-200 shadow-sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base font-semibold">
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" /> Active rewards
                </CardTitle>
                <CardDescription>Currently visible to shops</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-semibold text-emerald-600">{summaryStats.available}</p>
                <p className="mt-2 text-xs text-muted-foreground">{summaryStats.total} total rewards in catalog</p>
              </CardContent>
            </Card>

            <Card className="border-blue-200 bg-blue-50/60 shadow-none">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base font-semibold text-blue-700">
                  <Clock className="h-5 w-5" /> Scheduled or ending soon
                </CardTitle>
                <CardDescription className="text-blue-700/80">Plan upcoming launches ahead of time</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-semibold text-blue-700">{summaryStats.scheduled + summaryStats.endingSoon}</p>
                <p className="mt-2 text-xs text-blue-700/70">{summaryStats.scheduled} scheduled • {summaryStats.endingSoon} ending within 7 days</p>
              </CardContent>
            </Card>

            <Card className="border-amber-200 bg-amber-50/70">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base font-semibold text-amber-700">
                  <ShieldAlert className="h-5 w-5" /> Stock risks
                </CardTitle>
                <CardDescription className="text-amber-700/80">Keep popular rewards replenished</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-semibold text-amber-700">{summaryStats.lowStock + summaryStats.soldOut}</p>
                <p className="mt-2 text-xs text-amber-800/70">{summaryStats.lowStock} running low • {summaryStats.soldOut} sold out</p>
              </CardContent>
            </Card>

            <Card className="border-emerald-200 bg-emerald-50/70">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base font-semibold text-emerald-700">
                  <TrendingUp className="h-5 w-5" /> Redemptions (30d)
                </CardTitle>
                <CardDescription className="text-emerald-700/80">Performance snapshot across shops</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-semibold text-emerald-700">{formatNumber(redemptionAnalytics.totalRedemptions)}</p>
                <p className="mt-2 text-xs text-emerald-700/70">{formatNumber(redemptionAnalytics.totalPointsRedeemed)} points redeemed</p>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <CardHeader className="gap-4 border-b border-border/50 pb-6">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-lg">
                      <ListChecks className="h-4 w-4" /> Reward inventory
                    </CardTitle>
                    <CardDescription>Filter by status, category, or search to focus your review.</CardDescription>
                  </div>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <div className="relative w-full sm:min-w-[220px]">
                      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={searchTerm}
                        onChange={(event) => setSearchTerm(event.target.value)}
                        placeholder="Search rewards…"
                        className="pl-9"
                      />
                    </div>
                    <Select value={sortOption} onValueChange={setSortOption}>
                      <SelectTrigger className="w-full sm:w-56">
                        <SelectValue placeholder="Sort" />
                      </SelectTrigger>
                      <SelectContent>
                        {SORT_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant={statusFilter === "all" ? "default" : "outline"}
                    onClick={() => setStatusFilter("all")}
                  >
                    All statuses
                  </Button>
                  {(["available", "scheduled", "paused", "expired", "soldOut"] as RewardStatus[]).map((status) => (
                    <Button
                      key={status}
                      size="sm"
                      variant={statusFilter === status ? "default" : "outline"}
                      onClick={() => setStatusFilter(status)}
                      className="capitalize"
                    >
                      {status === "soldOut" ? "Sold out" : status}
                    </Button>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant={categoryFilter === "all" ? "default" : "outline"}
                    onClick={() => setCategoryFilter("all")}
                  >
                    All categories
                  </Button>
                  {(Object.keys(categoryLabels) as RewardCategory[]).map((category) => (
                    <Button
                      key={category}
                      size="sm"
                      variant={categoryFilter === category ? "default" : "outline"}
                      onClick={() => setCategoryFilter(category)}
                    >
                      {categoryLabels[category]}
                    </Button>
                  ))}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setShowCategorySettings(true)}
                    className="ml-2"
                  >
                    <Edit className="mr-2 h-3 w-3" /> Rename
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {loading ? (
                  <div className="flex items-center justify-center py-16 text-muted-foreground">
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading rewards…
                  </div>
                ) : error ? (
                  <div className="py-12 text-center text-sm text-destructive">{error}</div>
                ) : filteredRewards.length === 0 ? (
                  <div className="py-16 text-center text-sm text-muted-foreground">
                    No rewards match the selected filters.
                  </div>
                ) : (
                  <>
                    <div className="overflow-x-auto">
                      <table className="min-w-[720px] w-full divide-y divide-border text-sm">
                        <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                          <tr>
                            <th className="px-4 py-3 w-[50px]">#</th>
                            <th className="px-4 py-3 cursor-pointer hover:bg-muted/60" onClick={() => handleRewardSort('item_name')}>
                              <div className="flex items-center gap-1">
                                Reward
                                <ArrowUpDown className={`h-3 w-3 ${rewardSortConfig?.key === 'item_name' ? 'text-primary' : 'text-muted-foreground'}`} />
                              </div>
                            </th>
                            <th className="px-4 py-3 cursor-pointer hover:bg-muted/60" onClick={() => handleRewardSort('points_required')}>
                              <div className="flex items-center gap-1">
                                Points
                                <ArrowUpDown className={`h-3 w-3 ${rewardSortConfig?.key === 'points_required' ? 'text-primary' : 'text-muted-foreground'}`} />
                              </div>
                            </th>
                            <th className="px-4 py-3 cursor-pointer hover:bg-muted/60" onClick={() => handleRewardSort('stock_quantity')}>
                              <div className="flex items-center gap-1">
                                Stock
                                <ArrowUpDown className={`h-3 w-3 ${rewardSortConfig?.key === 'stock_quantity' ? 'text-primary' : 'text-muted-foreground'}`} />
                              </div>
                            </th>
                            <th className="px-4 py-3 cursor-pointer hover:bg-muted/60" onClick={() => handleRewardSort('status')}>
                              <div className="flex items-center gap-1">
                                Status
                                <ArrowUpDown className={`h-3 w-3 ${rewardSortConfig?.key === 'status' ? 'text-primary' : 'text-muted-foreground'}`} />
                              </div>
                            </th>
                            <th className="px-4 py-3 cursor-pointer hover:bg-muted/60" onClick={() => handleRewardSort('valid_from')}>
                              <div className="flex items-center gap-1">
                                Schedule
                                <ArrowUpDown className={`h-3 w-3 ${rewardSortConfig?.key === 'valid_from' ? 'text-primary' : 'text-muted-foreground'}`} />
                              </div>
                            </th>
                            <th className="px-4 py-3 cursor-pointer hover:bg-muted/60" onClick={() => handleRewardSort('requiresVerification')}>
                              <div className="flex items-center gap-1">
                                Verification
                                <ArrowUpDown className={`h-3 w-3 ${rewardSortConfig?.key === 'requiresVerification' ? 'text-primary' : 'text-muted-foreground'}`} />
                              </div>
                            </th>
                            <th className="px-4 py-3">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/60">
                          {paginatedRewards.map((reward, index) => (
                            <tr key={reward.id} className="hover:bg-muted/40">
                              <td className="px-4 py-4 text-muted-foreground">
                                {rewardStartIndex + index + 1}
                              </td>
                              <td className="px-4 py-4">
                                <div className="flex items-center gap-3">
                                  <div className="relative h-12 w-12 flex-shrink-0 overflow-hidden rounded-md border bg-muted">
                                    {(reward as any).animation_url ? (
                                      <video
                                        src={getStorageUrl((reward as any).animation_url) || (reward as any).animation_url}
                                        className="h-full w-full object-cover"
                                        muted
                                        loop
                                        autoPlay
                                        playsInline
                                      />
                                    ) : reward.item_image_url ? (
                                      <Image
                                        src={getStorageUrl(reward.item_image_url) || reward.item_image_url}
                                        alt={reward.item_name}
                                        fill
                                        className="object-cover"
                                        unoptimized={reward.item_image_url.startsWith('data:')}
                                      />
                                    ) : (
                                      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                                        <Package className="h-5 w-5" />
                                      </div>
                                    )}
                                  </div>
                                  <div>
                                    <div className="font-medium text-foreground">{reward.item_name}</div>
                                    <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                                      <Badge variant="outline" className="border-border/70 bg-background">
                                        {categoryLabels[reward.category]}
                                      </Badge>
                                      {reward.lowStock && (
                                        <Badge className="bg-amber-500 text-white">Low stock</Badge>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </td>
                              <td className="px-4 py-4">
                                {(reward as any).point_offer && (reward as any).point_offer > 0 ? (
                                  <div className="flex flex-col">
                                    <span className="text-xs text-muted-foreground line-through decoration-red-500/50">
                                      {formatNumber(reward.points_required)}
                                    </span>
                                    <div className="flex items-center gap-1">
                                      <span className="font-bold text-red-600">{formatNumber((reward as any).point_offer)}</span>
                                      <Badge variant="outline" className="h-4 border-red-200 px-1 text-[10px] text-red-600">
                                        PROMO
                                      </Badge>
                                    </div>
                                  </div>
                                ) : (
                                  <span className="font-semibold text-blue-600">{formatNumber(reward.points_required)}</span>
                                )}
                              </td>
                              <td className="px-4 py-4 text-sm">
                                {typeof reward.stock_quantity === "number" ? (
                                  <span className={reward.stock_quantity <= 0 ? "text-destructive" : undefined}>
                                    {reward.stock_quantity} units
                                  </span>
                                ) : (
                                  <span className="text-muted-foreground">Unlimited</span>
                                )}
                              </td>
                              <td className="px-4 py-4">
                                <Badge className={getStatusBadgeClass(reward.status)}>{reward.status}</Badge>
                              </td>
                              <td className="px-4 py-4 text-xs text-muted-foreground">
                                <div>Start: {reward.valid_from ? formatDateLabel(reward.valid_from) : "Now"}</div>
                                <div>End: {reward.valid_until ? formatDateLabel(reward.valid_until) : "Open"}</div>
                              </td>
                              <td className="px-4 py-4 text-xs text-muted-foreground">
                                {reward.requiresVerification ? "Manual check" : "Auto approve"}
                              </td>
                              <td className="px-4 py-4">
                                <div className="flex gap-2">
                                  <Button asChild size="sm" variant="outline" className="gap-1">
                                    <Link href={`/engagement/catalog/admin/edit/${reward.id}`}>
                                      <Edit className="h-4 w-4" /> Edit
                                    </Link>
                                  </Button>
                                  <Button asChild size="sm" variant="outline" className="gap-1">
                                    <Link href={`/engagement/catalog/admin?focus=${reward.id}`}>
                                      <Filter className="h-4 w-4" /> Focus
                                    </Link>
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Pagination Controls */}
                    {filteredRewards.length > 0 && (
                      <div className="flex items-center justify-between border-t p-4">
                        <div className="flex items-center gap-4">
                          <div className="text-sm text-muted-foreground">
                            Showing {rewardStartIndex + 1} to {Math.min(rewardEndIndex, filteredRewards.length)} of {filteredRewards.length} results
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm text-muted-foreground">Rows per page:</span>
                            <Select
                              value={rewardItemsPerPage.toString()}
                              onValueChange={(value) => {
                                setRewardItemsPerPage(Number(value))
                                setRewardCurrentPage(1)
                              }}
                            >
                              <SelectTrigger className="h-8 w-[70px]">
                                <SelectValue placeholder={rewardItemsPerPage} />
                              </SelectTrigger>
                              <SelectContent side="top">
                                {[10, 20, 30, 40, 50].map((pageSize) => (
                                  <SelectItem key={pageSize} value={pageSize.toString()}>
                                    {pageSize}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setRewardCurrentPage(p => Math.max(1, p - 1))}
                            disabled={rewardCurrentPage === 1}
                          >
                            Previous
                          </Button>
                          <div className="flex items-center gap-1">
                            {Array.from({ length: Math.min(5, rewardTotalPages) }, (_, i) => {
                              let pageNum: number
                              if (rewardTotalPages <= 5) {
                                pageNum = i + 1
                              } else if (rewardCurrentPage <= 3) {
                                pageNum = i + 1
                              } else if (rewardCurrentPage >= rewardTotalPages - 2) {
                                pageNum = rewardTotalPages - 4 + i
                              } else {
                                pageNum = rewardCurrentPage - 2 + i
                              }
                              return (
                                <Button
                                  key={pageNum}
                                  variant={rewardCurrentPage === pageNum ? "default" : "outline"}
                                  size="sm"
                                  onClick={() => setRewardCurrentPage(pageNum)}
                                  className="w-8"
                                >
                                  {pageNum}
                                </Button>
                              )
                            })}
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setRewardCurrentPage(p => Math.min(rewardTotalPages, p + 1))}
                            disabled={rewardCurrentPage === rewardTotalPages}
                          >
                            Next
                          </Button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>

            <div className="grid gap-6 md:grid-cols-3">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <BarChart3 className="h-4 w-4" /> Top redeemed rewards
                  </CardTitle>
                  <CardDescription>Based on redemption counts across all shops.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {redemptionAnalytics.topRewards.length === 0 ? (
                    <div className="text-sm text-muted-foreground">No redemption activity captured yet.</div>
                  ) : (
                    redemptionAnalytics.topRewards.map((entry) => (
                      <div key={entry.rewardId} className="space-y-2">
                        <div className="flex items-center justify-between text-sm font-medium">
                          <span>{entry.reward?.item_name}</span>
                          <span className="text-muted-foreground">{entry.count} redemptions</span>
                        </div>
                        <div className="h-2 rounded-full bg-muted">
                          <div
                            className="h-2 rounded-full bg-gradient-to-r from-indigo-400 to-indigo-600"
                            style={{ width: `${redemptionAnalytics.maxCount ? (entry.count / redemptionAnalytics.maxCount) * 100 : 0}%` }}
                          />
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Package className="h-4 w-4" /> Latest redemptions
                  </CardTitle>
                  <CardDescription>Live feed of the most recent redemption approvals.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {redemptionAnalytics.recentFeed.length === 0 ? (
                    <div className="text-sm text-muted-foreground">No redemptions yet.</div>
                  ) : (
                    redemptionAnalytics.recentFeed.map((item) => (
                      <div key={item.id} className="rounded-lg border border-border/60 bg-muted/30 p-3">
                        <div className="flex items-center justify-between text-sm">
                          <div className="font-medium text-foreground">{item.rewardName}</div>
                          <span className="text-xs text-muted-foreground">{item.label}</span>
                        </div>
                        <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                          <span>{item.consumer || "Unknown consumer"}</span>
                          <span className="font-semibold text-amber-600">-{formatNumber(item.points)} pts</span>
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>

              <Card className="border-dashed border-primary/30 bg-primary/5">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg text-primary">
                    <ChevronRight className="h-4 w-4" /> Next recommended action
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-primary">
                  <p>
                    {summaryStats.lowStock > 0
                      ? `Replenish inventory for ${summaryStats.lowStock} low-stock reward${summaryStats.lowStock === 1 ? "" : "s"} to keep shops engaged.`
                      : "All rewards look healthy right now—consider launching a limited-time reward to boost engagement."}
                  </p>
                  <Button asChild size="sm" variant="outline" className="gap-2 border-primary text-primary hover:bg-primary/10">
                    <Link href="/engagement/catalog/admin/new">
                      <Sparkles className="h-4 w-4" /> Launch limited reward
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            </div>
          </div>
        </TabsContent>

        {/* SHOP POINTS MONITOR TAB */}
        <TabsContent value="users" className="space-y-4">
          <ShopPointsReport userProfile={userProfile} reportStatusRule={reportStatusSettings.shopPerformance} />
        </TabsContent>

        <TabsContent value="staff" className="space-y-4">
          {shopStaffLoadError && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <span className="font-semibold">Shop staff performance failed to load.</span>{' '}
              {shopStaffLoadError} &mdash; the table below is empty because the request failed, not because there are no shop staff.
            </div>
          )}
          <UserPointsMonitor
            users={shopStaffUsers}
            loading={usersLoading}
            onAdjustPoints={(user) => {
              setSelectedUser(user)
              setPointsAdjustment({ amount: 0, type: 'add', description: '' })
              setShowAdjustPointsModal(true)
            }}
            onRefresh={() => loadShopStaffUsers()}
            storageKey="shop-staff-points-columns"
            bannerTitle="Shop Staff Performance"
            bannerDescription="Shop-attached staff accounts are tracked here based on shop-lane scan contribution. Consumer balances are tracked separately under Consumer Performance."
            badgeLabels={['Shop Staff Accounts', 'Shop-lane Contribution', 'Scan History']}
            tableTitle="Shop Staff Point Contributions"
            entityLabelSingular="shop staff"
            entityLabelPlural="shop staff"
            emptyTitle={shopStaffLoadError ? 'Shop staff could not be loaded' : 'No shop staff found'}
            emptyDescription={shopStaffLoadError
              ? 'The request failed, so no rows could be listed. Use Refresh to try again.'
              : 'Monitor point contribution and scan activity for shop staff accounts.'}
            emptySearchDescription="Try adjusting your search terms. Consumer balances appear under Consumer Performance."
            exportFilenamePrefix="shop-staff-performance"
            columnLabelOverrides={{
              consumer: 'Shop Staff',
              reference: 'Reference (AM)',
              location: 'State',
              shop_name: 'Shop',
            }}
            defaultVisibleColumnIds={['row_num', 'consumer', 'shop_name', 'location', 'reference', 'current_balance', 'collected_system', 'migration', 'transactions', 'last_activity', 'actions']}
            initialSortConfig={{ key: 'current_balance', direction: 'desc' }}
            reportStatusRule={reportStatusSettings.shopStaffPerformance}
          />
        </TabsContent>

        {/* CONSUMER POINTS MONITOR TAB */}
        <TabsContent value="consumers" className="space-y-4">
          {consumerLoadError && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              <span className="font-semibold">Consumer performance failed to load.</span>{' '}
              {consumerLoadError} &mdash; the table below is empty because the request failed, not because there are no consumers.
            </div>
          )}
          <UserPointsMonitor
            users={consumerUsers}
            loading={usersLoading}
            onAdjustPoints={(user) => {
              setSelectedUser(user)
              setPointsAdjustment({ amount: 0, type: 'add', description: '' })
              setShowAdjustPointsModal(true)
            }}
            onRefresh={() => loadConsumerUsers()}
            storageKey="consumer-points-columns"
            bannerTitle="Consumer Point Collection System"
            bannerDescription="Consumer accounts collect points through the mobile app. Shop staff performance is tracked separately under Shop Staff Performance."
            badgeLabels={['Consumer Accounts', 'Real-time Balance Updates', 'Transaction History']}
            tableTitle="Consumer Point Balances"
            entityLabelSingular="consumer"
            entityLabelPlural="consumers"
            emptyTitle={consumerLoadError ? 'Consumers could not be loaded' : 'No consumers found'}
            emptyDescription={consumerLoadError
              ? 'The request failed, so no rows could be listed. Use Refresh to try again.'
              : 'Monitor point collections and balances for consumer accounts.'}
            emptySearchDescription="Try adjusting your search terms. Shop-attached staff appear under Shop Staff Performance."
            exportFilenamePrefix="consumer-performance"
            columnLabelOverrides={{
              consumer: 'Consumer',
            }}
            reportStatusRule={reportStatusSettings.consumerPerformance}
          />
        </TabsContent>

        {/* REDEMPTION HISTORY TAB */}
        <TabsContent value="redemptions" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Gift className="h-5 w-5 text-purple-500" />
                    Redemption History
                  </CardTitle>
                  <CardDescription>
                    View and manage all reward redemptions from shops
                  </CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => loadRedemptions(1)}
                  className="gap-2 w-full sm:w-auto"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
                  </svg>
                  Refresh
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {/* Filters */}
              <div className="mb-4 flex flex-col sm:flex-row gap-3 sm:gap-4">
                <div className="flex-1 min-w-0">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder="Search by shop/consumer name, phone, or reward name..."
                      value={redemptionSearchTerm}
                      onChange={(e) => setRedemptionSearchTerm(e.target.value)}
                      className="pl-9"
                    />
                  </div>
                </div>
                <Select
                  value={redemptionStatusFilter}
                  onValueChange={(value) => setRedemptionStatusFilter(value as any)}
                >
                  <SelectTrigger className="w-full sm:w-[180px]">
                    <SelectValue placeholder="Filter by status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="processing">Processing</SelectItem>
                    <SelectItem value="fulfilled">Fulfilled</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Redemptions Table */}
              {redemptionsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              ) : redemptions.length === 0 ? (
                <div className="py-12 text-center text-muted-foreground">
                  <Gift className="mx-auto mb-4 h-12 w-12 opacity-20" />
                  <p className="text-lg font-medium">No redemptions found</p>
                  <p className="text-sm">Redemptions will appear here once shops start redeeming rewards</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {redemptions
                    .filter((r) => {
                      // Status filter
                      if (redemptionStatusFilter !== "all" && r.fulfillment_status !== redemptionStatusFilter) {
                        return false
                      }
                      // Search filter
                      if (redemptionSearchTerm) {
                        const search = redemptionSearchTerm.toLowerCase()
                        return (
                          r.shop_name?.toLowerCase().includes(search) ||
                          r.shop_phone?.toLowerCase().includes(search) ||
                          r.staff_name?.toLowerCase().includes(search) ||
                          r.staff_phone?.toLowerCase().includes(search) ||
                          r.reward_name?.toLowerCase().includes(search)
                        )
                      }
                      return true
                    })
                    .map((redemption) => {
                      const statusColors: Record<string, string> = {
                        pending: "bg-yellow-100 text-yellow-800 border-yellow-200",
                        processing: "bg-blue-100 text-blue-800 border-blue-200",
                        fulfilled: "bg-green-100 text-green-800 border-green-200",
                        cancelled: "bg-gray-100 text-gray-800 border-gray-200"
                      }
                      const statusIcons: Record<string, any> = {
                        pending: Clock,
                        processing: Truck,
                        fulfilled: CheckCircle,
                        cancelled: XCircle
                      }
                      const StatusIcon = statusIcons[redemption.fulfillment_status || "pending"] || AlertCircle

                      return (
                        <Card key={redemption.id} className="border-l-4 border-l-purple-500">
                          <CardContent className="pt-6">
                            <div className="grid gap-4 md:grid-cols-2">
                              {/* Left: Redemption Info */}
                              <div className="space-y-3">
                                <div className="flex gap-4">
                                  {/* Reward Image */}
                                  <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded-md border bg-muted">
                                    {redemption.reward_image_url ? (
                                      <Image
                                        src={getStorageUrl(redemption.reward_image_url)}
                                        alt={redemption.reward_name}
                                        width={64}
                                        height={64}
                                        className="h-full w-full object-cover"
                                      />
                                    ) : (
                                      <div className="flex h-full w-full items-center justify-center bg-gray-100">
                                        <Gift className="h-6 w-6 text-gray-400" />
                                      </div>
                                    )}
                                  </div>

                                  <div className="flex-1">
                                    <div className="flex items-start justify-between">
                                      <div className="flex-1">
                                        <h3 className="font-semibold text-lg">{redemption.reward_name}</h3>
                                        <p className="text-sm text-muted-foreground">
                                          Code: {redemption.redemption_code || "N/A"}
                                        </p>
                                      </div>
                                      <Badge
                                        className={`${statusColors[redemption.fulfillment_status || "pending"]} flex items-center gap-1`}
                                      >
                                        <StatusIcon className="h-3 w-3" />
                                        {redemption.fulfillment_status || "pending"}
                                      </Badge>
                                    </div>
                                  </div>
                                </div>

                                <div className="space-y-1 text-sm">
                                  <div className="flex items-center gap-2 text-muted-foreground">
                                    <MapPin className="h-4 w-4" />
                                    <span className="font-medium">{redemption.shop_name || redemption.staff_location || 'Unknown Location'}</span>
                                  </div>
                                  <div className="flex items-center gap-2 text-muted-foreground">
                                    <User className="h-4 w-4" />
                                    <span>{redemption.staff_name || 'Unknown User'}</span>
                                  </div>
                                  <div className="flex items-center gap-2 text-muted-foreground">
                                    <Phone className="h-4 w-4" />
                                    <span>{redemption.shop_phone || redemption.staff_phone}</span>
                                  </div>
                                  {/* Delivery Address */}
                                  {redemption.staff_address && (
                                    <div className="flex items-start gap-2 text-muted-foreground">
                                      <Home className="h-4 w-4 mt-0.5 shrink-0" />
                                      <span className="text-xs">{redemption.staff_address}</span>
                                    </div>
                                  )}
                                  <div className="flex items-center gap-2 text-muted-foreground">
                                    <Calendar className="h-4 w-4" />
                                    <span>
                                      Redeemed: {new Date(redemption.redeemed_at).toLocaleString()}
                                    </span>
                                  </div>
                                  {redemption.fulfilled_at && (
                                    <div className="flex items-center gap-2 text-muted-foreground">
                                      <CheckCircle className="h-4 w-4" />
                                      <span>
                                        Fulfilled: {new Date(redemption.fulfilled_at).toLocaleString()}
                                      </span>
                                    </div>
                                  )}
                                </div>

                                {/* Bank Details for Cashback */}
                                {redemption.reward_code?.toLowerCase().includes('cashback') && (
                                  <div className="mt-3 p-3 bg-blue-50 rounded-md border border-blue-100 text-xs space-y-2">
                                    <div className="flex items-center gap-2 text-blue-800 font-semibold border-b border-blue-200 pb-1">
                                      <CreditCard className="h-3 w-3" />
                                      <span>Bank Details</span>
                                    </div>
                                    <div className="grid grid-cols-[80px_1fr] gap-y-1 gap-x-2">
                                      <span className="text-blue-600">Bank:</span>
                                      <span className="font-medium text-blue-900">{redemption.shop_bank_name || '-'}</span>

                                      <span className="text-blue-600">Account:</span>
                                      <span className="font-medium text-blue-900">{redemption.shop_bank_account_number || '-'}</span>

                                      <span className="text-blue-600">Holder:</span>
                                      <span className="font-medium text-blue-900">{redemption.shop_bank_account_holder_name || '-'}</span>
                                    </div>
                                  </div>
                                )}

                                <div className="rounded-md bg-muted p-2">
                                  <p className="text-sm">
                                    <span className="font-semibold text-purple-700">
                                      {formatNumber(Math.abs(redemption.points_amount || 0))} points
                                    </span>
                                  </p>
                                </div>
                              </div>

                              {/* Right: Actions & Notes */}
                              <div className="space-y-3">
                                <div>
                                  <Label className="text-xs text-muted-foreground">Update Status</Label>
                                  <div className="mt-2 grid grid-cols-2 gap-2">
                                    {redemption.fulfillment_status === "pending" && (
                                      <>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          onClick={() => updateRedemptionStatus(redemption.id, "processing")}
                                          className="gap-1"
                                        >
                                          <Truck className="h-3 w-3" />
                                          Process
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          onClick={() => updateRedemptionStatus(redemption.id, "cancelled")}
                                          className="gap-1"
                                        >
                                          <XCircle className="h-3 w-3" />
                                          Cancel
                                        </Button>
                                      </>
                                    )}
                                    {redemption.fulfillment_status === "processing" && (
                                      <>
                                        <Button
                                          size="sm"
                                          variant="default"
                                          onClick={() => updateRedemptionStatus(redemption.id, "fulfilled")}
                                          className="gap-1 bg-green-600 hover:bg-green-700"
                                        >
                                          <CheckCircle className="h-3 w-3" />
                                          Fulfill
                                        </Button>
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          onClick={() => updateRedemptionStatus(redemption.id, "cancelled")}
                                          className="gap-1"
                                        >
                                          <XCircle className="h-3 w-3" />
                                          Cancel
                                        </Button>
                                      </>
                                    )}
                                    {(redemption.fulfillment_status === "fulfilled" || redemption.fulfillment_status === "cancelled") && (
                                      <div className="col-span-2 text-center text-sm text-muted-foreground">
                                        Status is final
                                      </div>
                                    )}
                                  </div>
                                </div>

                                {redemption.fulfillment_notes && (
                                  <div>
                                    <Label className="text-xs text-muted-foreground">Notes</Label>
                                    <p className="mt-1 text-sm rounded-md bg-muted p-2">
                                      {redemption.fulfillment_notes}
                                    </p>
                                  </div>
                                )}

                                {redemption.fulfilled_by_name && (
                                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                    <User className="h-4 w-4" />
                                    <span>By: {redemption.fulfilled_by_name}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      )
                    })}

                  {/* Pagination Controls */}
                  {redemptionTotalPages > 1 && (
                    <div className="flex items-center justify-center gap-2 py-4">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => loadRedemptions(redemptionPage - 1)}
                        disabled={redemptionPage <= 1}
                      >
                        <ChevronLeft className="h-4 w-4" />
                        Previous
                      </Button>
                      <span className="text-sm text-muted-foreground">
                        Page {redemptionPage} of {redemptionTotalPages}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => loadRedemptions(redemptionPage + 1)}
                        disabled={redemptionPage >= redemptionTotalPages}
                      >
                        Next
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* REFERRAL MONITOR TAB */}
        <TabsContent value="referral" className="space-y-6">
          {selectedReferenceId ? (
            <ReferralDetail
              userProfile={userProfile}
              referenceUserId={selectedReferenceId}
              onBack={() => setSelectedReferenceId(null)}
            />
          ) : (
            <>
              <ReferralMonitor
                userProfile={userProfile}
                onViewDetail={(userId: string) => setSelectedReferenceId(userId)}
              />
              <ReferenceChangeLog userProfile={userProfile} />
            </>
          )}
        </TabsContent>

        {/* POINT SETTINGS TAB */}
        <TabsContent value="settings" className="space-y-4">
          <PointsConfigurationSettings userProfile={userProfile} />
        </TabsContent>
      </Tabs>

      {/* ADJUST POINTS MODAL */}
      <Dialog open={showAdjustPointsModal} onOpenChange={setShowAdjustPointsModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adjust Points Balance</DialogTitle>
            <DialogDescription>
              Modify point balance for {selectedUser?.shop_name} ({selectedUser?.shop_phone}). Current balance: {formatNumber(selectedUser?.current_balance ?? 0)} points
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Adjustment Type</Label>
              <Select
                value={pointsAdjustment.type}
                onValueChange={(value) => setPointsAdjustment(prev => ({ ...prev, type: value as 'add' | 'subtract' }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="add">Add Points</SelectItem>
                  <SelectItem value="subtract">Subtract Points</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Amount</Label>
              <Input
                type="number"
                min="0"
                value={pointsAdjustment.amount || ''}
                onChange={(e) => setPointsAdjustment(prev => ({ ...prev, amount: parseInt(e.target.value) || 0 }))}
                placeholder="e.g., 100"
              />
            </div>

            <div className="space-y-2">
              <Label>Description (Optional)</Label>
              <Input
                value={pointsAdjustment.description}
                onChange={(e) => setPointsAdjustment(prev => ({ ...prev, description: e.target.value }))}
                placeholder="e.g., Transfer from old system"
              />
            </div>

            {pointsAdjustment.amount > 0 && (
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
                <p className="font-medium text-blue-900">
                  New Balance: {formatNumber(
                    (selectedUser?.current_balance ?? 0) +
                    (pointsAdjustment.type === 'add' ? pointsAdjustment.amount : -pointsAdjustment.amount)
                  )} points
                </p>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setShowAdjustPointsModal(false)
              setSelectedUser(null)
              setPointsAdjustment({ amount: 0, type: 'add', description: '' })
            }}>
              Cancel
            </Button>
            <Button onClick={handleAdjustPoints} disabled={pointsAdjustment.amount === 0}>
              <Save className="h-4 w-4 mr-2" />
              {pointsAdjustment.type === 'add' ? 'Add' : 'Subtract'} Points
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CategorySettingsDialog
        open={showCategorySettings}
        onOpenChange={setShowCategorySettings}
        userProfile={userProfile}
        onUpdate={setCategoryLabels}
        currentLabels={categoryLabels}
      />
    </div>
  )
}
