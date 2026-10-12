'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSupabaseAuth } from '@/lib/hooks/useSupabaseAuth'
import { usePermissions } from '@/hooks/usePermissions'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useToast } from '@/components/ui/use-toast'
import { getStorageUrl } from '@/lib/utils'
import { normalizeBaseCost, stockCountImpact, sumStockCountImpacts } from '@/lib/inventory/stock-count-costing'
import {
  CLASSIFICATION_LEGACY_CONFIG_CODE as LEGACY_CONFIG_CODE,
  CLASSIFICATION_TARGET_CONFIG_CODES as TARGET_CONFIG_CODES,
  buildInitialClassificationGroups,
  computeClassificationEntry,
  evaluateClassificationPostable,
  getClassificationCardDisplay,
  summarizeClassificationRound,
} from '@/lib/inventory/stock-count-classification'
import { stockCountDraftSignature } from '@/lib/inventory/stock-count-snapshot'
import InventoryOpeningCutoffSection from '@/components/inventory/InventoryOpeningCutoffSection'
import StockCountQuantityInput from '@/components/inventory/StockCountQuantityInput'
import { formatPiecesAsCases } from '@/lib/inventory/stock-count-units'
import {
  buildOpeningBalanceScopeRows,
  buildStockCountCatalogRows,
  getStockCountLocationOptions,
  isStockCountCatalogRowVisible,
  matchesStockCountSearch,
  resolveOpeningBalanceVisibleRows,
  resolveStockCountDefaultWarehouseId,
  type StockCountCatalogRow,
  type StockCountLocation,
} from '@/lib/inventory/stock-count-catalog'
import { findIneligibleStockConfigs } from '@/lib/inventory/stock-count-config-eligibility'
import {
  LEGACY_HISTORY_STATUSES,
  isDraftDeletable,
  draftProtectionReason,
  stockCountHistoryLifecyclePresentation,
} from '@/lib/inventory/stock-count-draft-eligibility'
import {
  formatOpeningBalanceDraftCreatedAt,
  formatOpeningBalanceDraftProgress,
  isCancelledOpeningBalanceHistory,
  resolveActiveOpeningBalanceDraft,
  type OpeningBalanceCutoffStatus,
} from '@/lib/inventory/opening-balance-active-draft'
import {
  filterSessionsByCountType,
  stockCountHistoryEmptyMessage,
  stockCountTypeBucketLabel,
} from '@/lib/inventory/stock-count-history-filter'
import {
  STOCK_COUNT_REFERENCE_LEGACY_PLACEHOLDER,
  STOCK_COUNT_REFERENCE_MAX_LENGTH,
  isStockCountReferenceMissing,
  validateStockCountReference,
} from '@/lib/inventory/stock-count-reference'
import {
  assertImmutableOpeningScopeComplete,
  assertOpeningDraftRowsComplete,
  changedOpeningDraftItems,
  openingDraftSaveDescription,
} from '@/lib/inventory/stock-count-opening-draft-update'
import {
  buildStockCountWorksheet,
  parseStockCountWorksheet,
  buildClassificationWorksheet,
  parseClassificationWorksheet,
} from '@/lib/inventory/stock-count-excel'
import {
  STOCK_COUNT_POST_PERMISSION,
  isValidStockCountPostingNote,
  normalizeStockCountPostingNote,
  stockCountPermissionGate,
  stockCountVerificationError,
} from '@/lib/inventory/stock-count-verification-errors'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Boxes,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Columns3,
  Download,
  FileSpreadsheet,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Package,
  RotateCcw,
  Save,
  Search,
  Upload,
  Warehouse,
} from 'lucide-react'
import { withStockStrengthUnit } from '@/lib/inventory/stock-config-unit-label'
import { shouldShowConfigurationColumn } from '@/lib/inventory/canonical-stock-config'

type CountType = 'full_count' | 'cycle_count' | 'spot_check' | 'initial_configuration_classification' | 'opening_balance_cutoff'
type SessionStatus = 'draft' | 'posted' | 'archived'

interface CountRow extends StockCountCatalogRow {
  /** Live allocated qty on this configuration — classification never auto-clears it. */
}

interface DraftSession {
  id: string
  reference_name: string | null
  count_date: string
  count_type: CountType
  status: SessionStatus
  warehouse_organization_id: string
  product_category_id: string | null
  created_at: string
  updated_at: string | null
  created_by: string | null
  warehouse_name?: string
  category_name?: string
  created_by_name?: string
  scope_count?: number
  counted_count?: number
  /** Authoritative inventory_opening_cutoffs.status for this session, when any. */
  cutoff_status?: OpeningBalanceCutoffStatus
  deletable?: boolean
  // Reason this session cannot be discarded (protected/official history), or
  // undefined when it is a live deletable draft.
  protection_reason?: string
  history_badge?: string
  history_detail?: string
}

interface InvalidWarehouseDraft extends DraftSession {
  warehouse_organization_id: string
}

interface ImportSummary {
  updated: number
  unchanged: number
  failed: number
  rows: Array<{ row: number; sku: string; status: 'Updated' | 'Unchanged' | 'Failed'; message: string }>
}

interface ReviewBreakdownLine {
  key: string
  label: string
  system: number
  physical: number | null
}

interface CountBreakdownGroup {
  kind: 'count'
  variantId: string
  heading: string
  lines: ReviewBreakdownLine[]
}

interface ClassificationBreakdownGroup {
  kind: 'classification'
  variantId: string
  heading: string
  legacy: { label: string; system: number }
  lines: ReviewBreakdownLine[]
  targetTotal: number
  variance: number
  complete: boolean
}

type ReviewBreakdownGroup = CountBreakdownGroup | ClassificationBreakdownGroup

interface VerificationState {
  requestId: string
  sessionId: string
  recipients: string[]
  expiresAt: string
  resendAvailableAt: string
}

interface PreflightState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  code?: string
  message?: string
  guidance?: string
  recipientCount?: number
}

interface StockAdjustmentViewProps {
  userProfile: any
  onViewChange?: (view: string) => void
}

interface ProductCategoryOption {
  id: string
  category_name: string
  category_code: string | null
}

const ALL_GROUP_ID = 'all'
// Radix Select forbids an empty-string item value, so "All Categories" (which
// maps to selectedCategory === '') uses this sentinel in the trigger only.
const ALL_CATEGORIES_VALUE = '__all_categories__'
// Kept as one policy constant so this can move to organization settings later.
const HIGH_IMPACT_VALUE_THRESHOLD = 10_000
const todayIso = () => new Date().toISOString().slice(0, 10)
const countTypeOptions: Array<{ value: CountType; label: string }> = [
  { value: 'full_count', label: 'Full Physical Count' },
  { value: 'cycle_count', label: 'Partial / Cycle Count' },
  { value: 'spot_check', label: 'Spot Check' },
  { value: 'initial_configuration_classification', label: 'Legacy Initial Classification — Read Only' },
  { value: 'opening_balance_cutoff', label: 'Inventory Opening Balance & Initial Classification' },
]
const countTypeCreationOptions = countTypeOptions.filter(
  option => option.value !== 'initial_configuration_classification',
)
// Signature of a Stock Count draft with nothing counted yet. A fresh or reset
// session starts here so it is never falsely flagged as having unsaved changes.
const EMPTY_SIGNATURE = stockCountDraftSignature([])
const UNSAVED_CHANGES_MESSAGE = 'Imported or edited counts have not been saved yet. Save the draft, then reopen Review & Post.'
const ACTIVE_WAREHOUSE_REQUIRED_MESSAGE = 'Selected organization is not an active warehouse.'
const DISCARD_DRAFT_CONFIRMATION =
  'Discard the selected draft(s)? Unsaved Stock Count entries and imported data in these drafts will be removed. Inventory will not be affected.'
const DISCARD_SUCCESS_TOAST = 'Draft discarded successfully. Inventory, orders, stock movements and QR records were not changed.'
const DISCARD_INELIGIBLE_MESSAGE =
  'This Stock Count can no longer be discarded because final verification has started or it is no longer a draft.'
// Shown when the server aborts discard mid-cleanup (e.g. a foreign-key restrict on
// a cutoff dependent). The whole discard rolls back, so nothing was changed. Never
// surface the raw Postgres FK/constraint text to the user.
const DISCARD_CLEANUP_INCOMPLETE_MESSAGE =
  'Draft could not be discarded because its Opening Balance cleanup was incomplete. No data was changed.'
const OPENING_BALANCE_DISCARD_CONFIRMATION =
  'This will remove the unfinished Opening Balance draft and its saved draft decisions. It will not change inventory, orders, stock movements or QR records.'
const formatNumber = (value: number) => value.toLocaleString('en-MY')
const draftLabel = (draft: DraftSession) => {
  const base = `${draft.reference_name || countTypeOptions.find(option => option.value === draft.count_type)?.label || 'Draft'} · ${draft.count_date}`
  if (isCancelledOpeningBalanceHistory(draft)) return `${base} · Cancelled — Read Only`
  return base
}
const LEGACY_RESET_REQUIRED_LABEL = 'Legacy Draft – Reset Required'
// Old drafts created under the previous global (category-less) logic, or any old
// unposted Initial Classification draft. They cannot Review / request OTP / Post
// (enforced by migration 04 and prepare_stock_count_verification); an authorized
// admin may only Discard & Start New.
const isLegacyResetRequiredDraft = (draft: DraftSession) =>
  draft.status === 'draft'
  && (draft.count_type === 'initial_configuration_classification'
    || (draft.count_type === 'opening_balance_cutoff' && !draft.product_category_id))
const isDiscardNotEligibleError = (message: string) =>
  /stock_count_not_discardable|stock_count_not_discardable_posting_started|stock_count_already_posted|not a draft/i.test(message)
// A leaked DB cleanup failure (FK restrict / constraint on a cutoff dependent).
// Map it to a safe, actionable message instead of the raw Postgres error.
const isDiscardCleanupError = (message: string) =>
  /foreign key constraint|violates .*constraint|inventory_cutoff_|inventory_opening_cutoffs/i.test(message)
// Resolve a server discard error to a user-facing message, never the raw FK text.
const discardErrorMessage = (message: string) => {
  if (isDiscardNotEligibleError(message)) return DISCARD_INELIGIBLE_MESSAGE
  if (isDiscardCleanupError(message)) return DISCARD_CLEANUP_INCOMPLETE_MESSAGE
  return message || DISCARD_INELIGIBLE_MESSAGE
}
const formatMoney = (value: number) => `RM ${value.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const parseCount = (value: string) => (value.trim() === '' ? null : Number(value))
const skuForRow = (row: CountRow) => row.stockSku
const varianceForRow = (row: CountRow) => {
  const physical = parseCount(row.physicalCount)
  return physical === null ? null : physical - row.systemQuantity
}
const adjustmentValueForRow = (row: CountRow) => {
  const variance = varianceForRow(row)
  return variance === null ? null : stockCountImpact(variance, row.unitCost)
}
const formatVerificationApiError = (
  result: { error?: string; reference?: string },
  stage: 'request' | 'post',
) => {
  const fallback = stockCountVerificationError('unexpected_error', { stage }).message
  const base = String(result.error || '').trim() || fallback
  if (!result.reference || base.includes(result.reference)) return base
  return `${base} Reference: ${result.reference}.`
}

export default function StockAdjustmentView({ userProfile, onViewChange }: StockAdjustmentViewProps) {
  const { isReady, supabase } = useSupabaseAuth()
  const { hasPermission, loading: permissionLoading } = usePermissions(
    userProfile?.roles?.role_level,
    userProfile?.role_code,
    userProfile?.department_id,
  )
  const { toast } = useToast()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const postingNoteRecheckTimerRef = useRef<number | null>(null)
  const postingNoteRecheckPendingRef = useRef(false)
  const draftLoadGenerationRef = useRef(0)
  const draftCriteriaRef = useRef('')

  const [warehouseLocations, setWarehouseLocations] = useState<StockCountLocation[]>([])
  const [configuredDefaultWarehouseId, setConfiguredDefaultWarehouseId] = useState<string | null>(null)
  const [invalidWarehouseDrafts, setInvalidWarehouseDrafts] = useState<InvalidWarehouseDraft[]>([])
  const [selectedWarehouse, setSelectedWarehouse] = useState('')
  const [productCategories, setProductCategories] = useState<ProductCategoryOption[]>([])
  const [selectedCategory, setSelectedCategory] = useState('')
  const [countDate, setCountDate] = useState(todayIso())
  const [countType, setCountType] = useState<CountType>('full_count')
  const [referenceName, setReferenceName] = useState('')
  const [referenceError, setReferenceError] = useState<string | null>(null)
  const referenceInputRef = useRef<HTMLInputElement | null>(null)
  const [notes, setNotes] = useState('')
  const [rows, setRows] = useState<CountRow[]>([])
  const [catalogRows, setCatalogRows] = useState<CountRow[]>([])
  const [openingDraftScopeIds, setOpeningDraftScopeIds] = useState<Set<string>>(new Set())
  const [drafts, setDrafts] = useState<DraftSession[]>([])
  // True while loadDrafts is in flight for the selected warehouse. Existing
  // Opening Balance draft detection reads `drafts`, so Save must stay disabled
  // until this settles — otherwise a first Save races ahead of detection.
  const [draftsLoading, setDraftsLoading] = useState(false)
  const [loadedDraftCriteria, setLoadedDraftCriteria] = useState('')
  const [staleDraftIds, setStaleDraftIds] = useState<Set<string>>(new Set())
  const [managingDrafts, setManagingDrafts] = useState(false)
  const [selectedDraftIds, setSelectedDraftIds] = useState<Set<string>>(new Set())
  const [discardConfirmIds, setDiscardConfirmIds] = useState<string[] | null>(null)
  const [discardingDrafts, setDiscardingDrafts] = useState(false)
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [currentStatus, setCurrentStatus] = useState<SessionStatus>('draft')
  const [selectedGroupId, setSelectedGroupId] = useState(ALL_GROUP_ID)
  const [searchTerm, setSearchTerm] = useState('')
  const [showVarianceOnly, setShowVarianceOnly] = useState(false)
  const [showNotCountedOnly, setShowNotCountedOnly] = useState(false)
  const [showInactive, setShowInactive] = useState(false)
  const [groupExpanded, setGroupExpanded] = useState(true)
  const [saving, setSaving] = useState(false)
  const [posting, setPosting] = useState(false)
  const [loadingRows, setLoadingRows] = useState(false)
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null)
  // Signature of the row state last persisted to stock_count_session_items. The
  // draft is "dirty" whenever the on-screen counts differ from this — the exact
  // condition that let a stale import post in the incident.
  const [lastSavedSignature, setLastSavedSignature] = useState(EMPTY_SIGNATURE)
  // Set by importExcel so the effect below persists the imported counts once
  // React has committed them (setRows is async; we cannot save in the same tick).
  const [pendingAutoSave, setPendingAutoSave] = useState(false)
  // The row signature bound to the currently issued verification code. Any
  // change after the code was requested makes the code stale (requirement E/F).
  const [verifiedSignature, setVerifiedSignature] = useState<string | null>(null)
  const [confirmPostOpen, setConfirmPostOpen] = useState(false)
  const [verification, setVerification] = useState<VerificationState | null>(null)
  const [verificationCode, setVerificationCode] = useState('')
  const [verificationError, setVerificationError] = useState<string | null>(null)
  const [preflight, setPreflight] = useState<PreflightState>({ status: 'idle' })
  const [allocationTargets, setAllocationTargets] = useState<Record<string, string>>({})
  const [openingBalancePosted, setOpeningBalancePosted] = useState(false)
  const [postedOpeningCategoryIds, setPostedOpeningCategoryIds] = useState<Set<string>>(new Set())
  const [verificationNow, setVerificationNow] = useState(Date.now())
  const [visibleColumns, setVisibleColumns] = useState({ unitCost: true, adjustmentValue: true, note: true })
  const hasPostStockCountPermission = !permissionLoading && hasPermission(STOCK_COUNT_POST_PERMISSION)
  const permissionGate = stockCountPermissionGate(permissionLoading, hasPostStockCountPermission)
  const isLegacyInitialReadOnly = countType === 'initial_configuration_classification'
  // The retired type is displayed through the regular configuration table in
  // read-only mode. Its former specialised editor remains unavailable.
  const isClassificationMode = false
  const isOpeningBalanceMode = countType === 'opening_balance_cutoff'
  const draftCriteriaKey = `${selectedWarehouse}:${isOpeningBalanceMode ? selectedCategory : '*'}`
  draftCriteriaRef.current = draftCriteriaKey
  const selectedCategoryName = productCategories.find(category => category.id === selectedCategory)?.category_name || '—'
  const locationOptions = useMemo(
    () => getStockCountLocationOptions(warehouseLocations),
    [warehouseLocations],
  )
  const selectedWarehouseIsValid = locationOptions.some(location => location.id === selectedWarehouse)
  const openingCategoryLocked = Boolean(currentSessionId)
    || (isOpeningBalanceMode && Boolean(selectedCategory)
      && rows.some(row => row.categoryId === selectedCategory
        && (row.physicalCount.trim() !== '' || row.note.trim() !== '')))
  // Never expose results that belong to a previous warehouse/category key,
  // even during the render-to-effect window before the newer request starts.
  const criteriaDrafts = loadedDraftCriteria === draftCriteriaKey ? drafts : []
  const currentDraftCutoffStatus = useMemo(
    () => (currentSessionId
      ? (criteriaDrafts.find(draft => draft.id === currentSessionId)?.cutoff_status || null)
      : null),
    [criteriaDrafts, currentSessionId],
  )
  const isCancelledOpeningBalanceReadOnly = Boolean(
    isOpeningBalanceMode
    && currentSessionId
    && currentDraftCutoffStatus === 'cancelled',
  )
  const isOpeningBalanceReadOnly = isLegacyInitialReadOnly || isCancelledOpeningBalanceReadOnly
  // At most one active Opening Balance draft may exist per warehouse/category.
  // When the operator picks a warehouse+category that already has one and is not
  // already editing it, they must continue that draft rather than start a second.
  // Cancelled freeze sessions are never selected as the resumable active draft.
  const existingOpeningDraft = useMemo(
    () => (isOpeningBalanceMode && selectedCategory
      ? resolveActiveOpeningBalanceDraft(
        criteriaDrafts,
        selectedWarehouse,
        selectedCategory,
        currentSessionId,
      )
      : undefined),
    [criteriaDrafts, isOpeningBalanceMode, selectedWarehouse, selectedCategory, currentSessionId],
  )
  const mustContinueExistingOpeningDraft = Boolean(!currentSessionId && existingOpeningDraft)
  // A new Opening Balance draft is not yet safe to save while the draft list is
  // still loading: detection has not run, so we cannot yet know whether one
  // already exists. Save stays disabled and shows "Checking for existing draft…"
  const openingDraftDetectionPending = Boolean(
    isOpeningBalanceMode
    && selectedCategory
    && !currentSessionId
    && (draftsLoading || loadedDraftCriteria !== draftCriteriaKey),
  )

  useEffect(() => {
    if (!verification) return
    const timer = window.setInterval(() => setVerificationNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [verification])

  useEffect(() => {
    if (isReady) {
      loadWarehouseLocations()
      loadProductCategories()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady])

  const loadProductCategories = async () => {
    const { data, error } = await supabase
      .from('product_categories')
      .select('id, category_name, category_code')
      .eq('is_active', true)
      .order('category_name')
    if (error) {
      toast({ title: 'Product Category load failed', description: error.message, variant: 'destructive' })
      return
    }
    setProductCategories((data || []) as ProductCategoryOption[])
  }

  useEffect(() => {
    if (locationOptions.some(location => location.id === selectedWarehouse)) return
    setSelectedWarehouse(resolveStockCountDefaultWarehouseId(
      configuredDefaultWarehouseId,
      userProfile?.organization_id || userProfile?.organizations?.id,
      locationOptions,
    ))
  }, [configuredDefaultWarehouseId, locationOptions, selectedWarehouse, userProfile?.organization_id, userProfile?.organizations?.id])

  useEffect(() => {
    if (!selectedWarehouse) {
      draftLoadGenerationRef.current += 1
      setRows([])
      setDrafts([])
      setDraftsLoading(false)
      setLoadedDraftCriteria('')
      setOpeningBalancePosted(false)
      setPostedOpeningCategoryIds(new Set())
      setSelectedCategory('')
      setOpeningDraftScopeIds(new Set())
      setManagingDrafts(false)
      setSelectedDraftIds(new Set())
      setDiscardConfirmIds(null)
      return
    }
    loadCountRows(selectedWarehouse)
    loadPostedOpeningCategories(selectedWarehouse)
    setSelectedGroupId(ALL_GROUP_ID)
    setSearchTerm('')
    setCurrentSessionId(null)
    setCurrentStatus('draft')
    setLastSavedSignature(EMPTY_SIGNATURE)
    setVerification(null)
    setVerifiedSignature(null)
    setImportSummary(null)
    setAllocationTargets({})
    setManagingDrafts(false)
    setSelectedDraftIds(new Set())
    setDiscardConfirmIds(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWarehouse])

  const loadPostedOpeningCategories = async (warehouseId: string) => {
    const { data, error } = await (supabase as any)
      .from('inventory_opening_cutoffs')
      .select('product_category_id')
      .eq('warehouse_organization_id', warehouseId)
      .eq('status', 'posted')
    if (error) {
      toast({ title: 'Opening Balance status unavailable', description: error.message, variant: 'destructive' })
      return
    }
    setPostedOpeningCategoryIds(new Set((data || []).map((row: any) => row.product_category_id || '*')))
  }

  useEffect(() => {
    if (!selectedWarehouse || !isOpeningBalanceMode || !selectedCategory) {
      setOpeningBalancePosted(false)
      return
    }
    void loadOpeningBalancePosted(selectedWarehouse, selectedCategory)
    setSelectedGroupId(ALL_GROUP_ID)
    setSearchTerm('')
    setShowNotCountedOnly(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpeningBalanceMode, selectedCategory])

  // Group tabs are secondary filters *within* the selected category, so a
  // category change resets the active group tab and search to the recalculated,
  // category-scoped set for every count type.
  useEffect(() => {
    setSelectedGroupId(ALL_GROUP_ID)
    setSearchTerm('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCategory])

  const loadOpeningBalancePosted = async (warehouseId: string, categoryId: string) => {
    const { data, error } = await (supabase as any)
      .from('inventory_opening_cutoffs')
      .select('id')
      .eq('warehouse_organization_id', warehouseId)
      .eq('product_category_id', categoryId)
      .eq('status', 'posted')
      .limit(1)
    if (error) {
      toast({ title: 'Opening Balance status unavailable', description: error.message, variant: 'destructive' })
      return
    }
    setOpeningBalancePosted((data || []).length > 0)
  }

  const loadWarehouseLocations = async () => {
    const currentOrganizationId = userProfile?.organization_id || userProfile?.organizations?.id
    const [warehousesResult, defaultResult, draftCandidatesResult] = await Promise.all([
      supabase
        .from('organizations')
        .select('id, org_code, org_name, org_type_code, is_active')
        .eq('org_type_code', 'WH')
        .eq('is_active', true)
        .order('org_name'),
      currentOrganizationId
        ? supabase
          .from('organizations')
          .select('default_warehouse_org_id')
          .eq('id', currentOrganizationId)
          .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase
        .from('stock_count_sessions' as any)
        .select('id, reference_name, count_date, count_type, status, updated_at, warehouse_organization_id')
        .eq('status', 'draft')
        .order('updated_at', { ascending: false })
        .limit(100),
    ])
    const { data, error } = warehousesResult

    if (error) {
      toast({ title: 'Warehouse load failed', description: error.message, variant: 'destructive' })
      return
    }
    if (defaultResult.error) {
      toast({ title: 'Default warehouse unavailable', description: defaultResult.error.message, variant: 'destructive' })
    }

    const locations = (data || []) as StockCountLocation[]
    setWarehouseLocations(locations)
    setConfiguredDefaultWarehouseId((defaultResult.data as any)?.default_warehouse_org_id || null)
    if (draftCandidatesResult.error) {
      toast({ title: 'Draft warehouse validation unavailable', description: draftCandidatesResult.error.message, variant: 'destructive' })
      setInvalidWarehouseDrafts([])
    } else {
      const validWarehouseIds = new Set(locations.map(location => location.id))
      setInvalidWarehouseDrafts(
        ((draftCandidatesResult.data || []) as unknown as InvalidWarehouseDraft[])
          .filter(draft => !validWarehouseIds.has(draft.warehouse_organization_id)),
      )
    }
  }

  const validateActiveWarehouse = async (warehouseId = selectedWarehouse): Promise<boolean> => {
    if (!warehouseId) return false
    const { data, error } = await supabase
      .from('organizations')
      .select('id')
      .eq('id', warehouseId)
      .eq('org_type_code', 'WH')
      .eq('is_active', true)
      .maybeSingle()
    if (error) return false
    return Boolean(data)
  }

  // Minimal, authorized read of "final verification started" (OTP requested /
  // active / posted). A counting freeze alone is NOT included — pre-OTP Opening
  // Balance drafts remain discardable. Failure degrades safely: drafts are
  // treated as posting-started (not deletable) so nothing unsafe is offered.
  const loadPostingStartedIds = async (sessionIds: string[]): Promise<Set<string>> => {
    if (sessionIds.length === 0) return new Set<string>()
    try {
      const response = await fetch('/api/inventory/stock-count/drafts/posting-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds }),
      })
      if (!response.ok) return new Set<string>(sessionIds)
      const payload = await response.json()
      return new Set<string>(Array.isArray(payload?.postingStartedSessionIds) ? payload.postingStartedSessionIds : sessionIds)
    } catch {
      return new Set<string>(sessionIds)
    }
  }

  const loadDrafts = async (warehouseId: string, criteriaKey = draftCriteriaKey) => {
    const generation = ++draftLoadGenerationRef.current
    setDraftsLoading(true)
    setLoadedDraftCriteria('')
    try {
      const applied = await loadDraftsInner(warehouseId, generation)
      if (applied && generation === draftLoadGenerationRef.current) {
        setLoadedDraftCriteria(criteriaKey)
      }
    } finally {
      if (generation === draftLoadGenerationRef.current) setDraftsLoading(false)
    }
  }

  const loadDraftsInner = async (warehouseId: string, generation: number): Promise<boolean> => {
    const [draftResult, legacyHistoryResult, cancelledHistoryResult] = await Promise.all([
      supabase
        .from('stock_count_sessions' as any)
        .select('id, reference_name, count_date, count_type, status, warehouse_organization_id, product_category_id, created_at, updated_at, created_by')
        .eq('warehouse_organization_id', warehouseId)
        .eq('status', 'draft')
        .order('updated_at', { ascending: false })
        .limit(50),
      supabase
        .from('stock_count_sessions' as any)
        .select('id, reference_name, count_date, count_type, status, warehouse_organization_id, product_category_id, created_at, updated_at, created_by')
        .eq('warehouse_organization_id', warehouseId)
        .eq('count_type', 'initial_configuration_classification')
        // Only POSTED initial-classification sessions are official history.
        // `archived` sessions are already-discarded drafts — including them here
        // resurrected discarded records as "Legacy — Read Only" cards after a
        // reload (the reported bug). LEGACY_HISTORY_STATUSES excludes 'archived'.
        .in('status', LEGACY_HISTORY_STATUSES)
        .order('updated_at', { ascending: false })
        .limit(50),
      // Cancelled Opening Balance freezes soft-archive their draft session. Keep
      // those rows available under History/Audit as read-only only.
      supabase
        .from('stock_count_sessions' as any)
        .select('id, reference_name, count_date, count_type, status, warehouse_organization_id, product_category_id, created_at, updated_at, created_by')
        .eq('warehouse_organization_id', warehouseId)
        .eq('count_type', 'opening_balance_cutoff')
        .eq('status', 'archived')
        .order('updated_at', { ascending: false })
        .limit(50),
    ])
    const { data, error } = draftResult

    if (error || legacyHistoryResult.error || cancelledHistoryResult.error) {
      const loadError = error || legacyHistoryResult.error || cancelledHistoryResult.error
      if (generation === draftLoadGenerationRef.current && loadError?.code !== '42P01') {
        toast({ title: 'Saved Stock Count load failed', description: loadError?.message, variant: 'destructive' })
      }
      return false
    }
    const sessionsById = new Map<string, DraftSession>()
    for (const session of [
      ...(data || []),
      ...(legacyHistoryResult.data || []),
      ...(cancelledHistoryResult.data || []),
    ] as unknown as DraftSession[]) {
      sessionsById.set(session.id, session)
    }
    const rawDrafts = [...sessionsById.values()]
    const sessionIds = rawDrafts.map(draft => draft.id)
    const creatorIds = [...new Set(rawDrafts.map(draft => draft.created_by).filter(Boolean))] as string[]
    const categoryIds = [...new Set(rawDrafts.map(draft => draft.product_category_id).filter(Boolean))] as string[]
    const [scopeResult, itemResult, creatorResult, categoryResult, postingStatusResult, cutoffResult] = await Promise.all([
      sessionIds.length
        ? supabase.from('stock_count_session_scope' as any).select('session_id').in('session_id', sessionIds)
        : Promise.resolve({ data: [], error: null }),
      sessionIds.length
        ? supabase.from('stock_count_session_items' as any).select('session_id, physical_quantity').in('session_id', sessionIds)
        : Promise.resolve({ data: [], error: null }),
      creatorIds.length
        ? supabase.from('users').select('id, full_name, email').in('id', creatorIds)
        : Promise.resolve({ data: [], error: null }),
      categoryIds.length
        ? supabase.from('product_categories').select('id, category_name').in('id', categoryIds)
        : Promise.resolve({ data: [], error: null }),
      // OTP verification requests are server-only (they hold code hashes and are
      // REVOKEd from authenticated). Read the minimum "posting has started"
      // status through an authorized server route instead of the raw table, so
      // Manage Drafts no longer triggers "permission denied for table
      // stock_count_verification_requests".
      loadPostingStartedIds(sessionIds),
      sessionIds.length
        ? (supabase as any)
          .from('inventory_opening_cutoffs')
          .select('stock_count_session_id, status')
          .in('stock_count_session_id', sessionIds)
        : Promise.resolve({ data: [], error: null }),
    ])
    const detailError = scopeResult.error || itemResult.error || creatorResult.error || categoryResult.error || cutoffResult.error
    if (generation === draftLoadGenerationRef.current && detailError) {
      toast({ title: 'Draft details unavailable', description: detailError.message, variant: 'destructive' })
    }
    const scopeCounts = new Map<string, number>()
    for (const entry of (scopeResult.data || []) as any[]) {
      scopeCounts.set(entry.session_id, (scopeCounts.get(entry.session_id) || 0) + 1)
    }
    const countedCounts = new Map<string, number>()
    for (const item of (itemResult.data || []) as any[]) {
      if (item.physical_quantity !== null && item.physical_quantity !== undefined) {
        countedCounts.set(item.session_id, (countedCounts.get(item.session_id) || 0) + 1)
      }
    }
    const cutoffBySession = new Map<string, OpeningBalanceCutoffStatus>()
    for (const row of (cutoffResult.data || []) as any[]) {
      cutoffBySession.set(row.stock_count_session_id, row.status as OpeningBalanceCutoffStatus)
    }
    const creators = new Map((creatorResult.data || []).map((user: any) => [user.id, user.full_name || user.email]))
    const categories = new Map((categoryResult.data || []).map((category: any) => [category.id, category.category_name]))
    const postingStartedIds = postingStatusResult
    const warehouseName = warehouseLocations.find(location => location.id === warehouseId)?.org_name || warehouseId
    const nextDrafts = rawDrafts
      .map(draft => {
        const cutoffStatus = cutoffBySession.get(draft.id) || null
        const eligibility = {
          status: draft.status,
          count_type: draft.count_type,
          postingStarted: postingStartedIds.has(draft.id),
          cutoff_status: cutoffStatus,
        }
        const lifecycle = stockCountHistoryLifecyclePresentation(eligibility)
        return {
          ...draft,
          warehouse_name: warehouseName,
          category_name: draft.product_category_id ? categories.get(draft.product_category_id) || 'Unknown category' : 'Legacy / not recorded',
          created_by_name: draft.created_by ? creators.get(draft.created_by) || 'Unknown user' : 'System',
          scope_count: scopeCounts.get(draft.id) || 0,
          counted_count: countedCounts.get(draft.id) || 0,
          cutoff_status: cutoffStatus,
          deletable: isDraftDeletable(eligibility),
          protection_reason: draftProtectionReason(eligibility) || undefined,
          history_badge: lifecycle.badge,
          history_detail: lifecycle.detail,
        }
      })
      // Archived OB sessions without a cancelled cutoff are discarded drafts and
      // must not resurface in history.
      .filter(draft =>
        draft.status !== 'archived'
        || isCancelledOpeningBalanceHistory(draft),
      )
      .sort((a, b) =>
        String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    // A warehouse/category change can start a newer request while this request
    // is awaiting any of the detail queries above. Only the newest generation
    // may publish results; older responses are ignored in full.
    if (generation !== draftLoadGenerationRef.current) return false
    setDrafts(nextDrafts)
    const eligibleIds = new Set(nextDrafts.filter(draft => draft.deletable).map(draft => draft.id))
    setSelectedDraftIds(prev => new Set([...prev].filter(id => eligibleIds.has(id))))
    setStaleDraftIds(prev => new Set([...prev].filter(id => eligibleIds.has(id))))
    return true
  }

  // Existing-draft detection is criteria-bound. The key changes immediately
  // when warehouse/category/count type changes, so Save becomes disabled in
  // that same render and remains disabled until the matching request publishes.
  useEffect(() => {
    if (!selectedWarehouse) return
    void loadDrafts(selectedWarehouse, draftCriteriaKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftCriteriaKey])

  const loadCountRows = async (warehouseId: string, options: { publish?: boolean } = {}) => {
    try {
      setLoadingRows(true)
      // The configuration catalog is authoritative. Warehouse balances are an
      // optional LEFT JOIN overlay, so never-stocked configurations remain
      // countable with zero quantities.
      const [configurationResult, balanceResult] = await Promise.all([
        (supabase as any)
          .from('inventory_stock_configurations')
          .select(`
            id, variant_id, config_code, config_label, stock_sku, volume_ml, packaging, status, sort_order,
            product_variants!inner (
              id, variant_name, alternative_name, variant_code, product_code, manufacturer_sku, manual_sku, image_url, base_cost, is_active,
              products!inner (
                id, product_name, is_active, category_id, group_id, brand_id, units_per_case,
                product_categories!inner (id, category_name, is_active),
                product_groups (id, group_name, group_description, stock_config_profile),
                brands (id, brand_name, logo_url)
              )
            )
          `)
          // Inactive configurations are archived master data and cannot enter a
          // new scope. phase_out remains eligible only under the existing
          // activity-aware visibility rule so real residual stock is not hidden.
          .neq('status', 'inactive')
          .eq('product_variants.is_active', true)
          .eq('product_variants.products.is_active', true)
          .order('sort_order'),
        (supabase as any)
          .from('product_inventory')
          .select('id, variant_id, stock_config_id, quantity_on_hand, quantity_allocated, warehouse_location')
          .eq('organization_id', warehouseId)
          .eq('is_active', true),
      ])
      if (configurationResult.error) throw configurationResult.error
      if (balanceResult.error) throw balanceResult.error

      const nextRows = buildStockCountCatalogRows(configurationResult.data || [], balanceResult.data || [])
      if (options.publish !== false) {
        setCatalogRows(nextRows)
        setRows(nextRows)
      }
      return nextRows
    } catch (error: any) {
      toast({ title: 'Inventory load failed', description: error.message, variant: 'destructive' })
      return [] as CountRow[]
    } finally {
      setLoadingRows(false)
    }
  }

  // Full / Partial / Spot counts operate over every eligible configuration at
  // the warehouse. The Product Category selector is a working lens on top of
  // this set (see visibleRows) and never removes entered counts from the saved
  // draft, so switching category can never lose work.
  const countableRows = useMemo(
    () => rows.filter(row => isStockCountCatalogRowVisible(row, showInactive)),
    [rows, showInactive],
  )

  // Category is the PRIMARY scope selector for every count type. Group tabs,
  // summaries, search and Excel export all derive from this, so they are always
  // recalculated within the selected category. Opening Balance requires exactly
  // one category and is additionally bound to its immutable scope snapshot;
  // Full / Partial / Spot allow "All Categories" (selectedCategory === '').
  const visibleRows = useMemo(
    () => {
      if (isOpeningBalanceMode) {
        // Reopened drafts are bound to their immutable snapshot scope and are
        // NOT re-filtered by the live Product Category, so a saved 140-row
        // snapshot always reopens (and exports) with all 140 rows even if a
        // product later drifted from the live catalog. New drafts show the
        // live, category-scoped eligible set (row.categoryId === selectedCategory).
        return resolveOpeningBalanceVisibleRows(rows, {
          currentSessionId,
          selectedCategory,
          scopeIds: openingDraftScopeIds,
        })
      }
      return countableRows.filter(row => !selectedCategory || row.categoryId === selectedCategory)
    },
    [rows, countableRows, isOpeningBalanceMode, selectedCategory, currentSessionId, openingDraftScopeIds],
  )

  const groups = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number; logoUrl: string | null; description: string | null }>()
    visibleRows.forEach(row => {
      const existing = map.get(row.groupId)
      if (existing) existing.count += 1
      else map.set(row.groupId, { id: row.groupId, name: row.groupName, count: 1, logoUrl: row.brandLogoUrl || row.imageUrl, description: row.groupDescription })
    })
    return [{ id: ALL_GROUP_ID, name: 'All', count: visibleRows.length, logoUrl: null, description: null }, ...Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))]
  }, [visibleRows])

  const selectedGroup = groups.find(group => group.id === selectedGroupId) || groups[0]
  const selectedGroupRows = useMemo(() => {
    const scoped = selectedGroupId === ALL_GROUP_ID ? visibleRows : visibleRows.filter(row => row.groupId === selectedGroupId)
    const query = searchTerm.trim().toLowerCase()
    return scoped.filter(row => {
      const variance = varianceForRow(row)
      if (showVarianceOnly && (!variance || variance === 0)) return false
      if (showNotCountedOnly && parseCount(row.physicalCount) !== null) return false
      if (!query) return true
      return matchesStockCountSearch(row, query)
    })
  }, [visibleRows, searchTerm, selectedGroupId, showVarianceOnly, showNotCountedOnly])

  // Operational counting shows the Configuration badge only when a variant
  // genuinely carries more than one. Legacy classification (the Legacy Source →
  // target sub-table below) always shows it: there the configuration IS the
  // information being captured.
  const showConfiguration = useMemo(
    () => shouldShowConfigurationColumn(visibleRows),
    [visibleRows],
  )

  const pageSummary = useMemo(() => {
    const counted = visibleRows.filter(row => parseCount(row.physicalCount) !== null)
    const variances = counted.map(row => varianceForRow(row) || 0)
    return {
      totalItems: visibleRows.length,
      counted: counted.length,
      notCounted: visibleRows.length - counted.length,
      varianceItems: variances.filter(value => value !== 0).length,
      netAdjustment: variances.reduce((sum, value) => sum + value, 0),
      estimatedValue: sumStockCountImpacts(visibleRows.flatMap(row => {
        const variance = varianceForRow(row)
        return variance === null ? [] : [{ quantityChange: variance, baseCost: row.unitCost }]
      })),
    }
  }, [visibleRows])

  const groupSummary = useMemo(() => {
    const scoped = selectedGroupId === ALL_GROUP_ID ? visibleRows : visibleRows.filter(row => row.groupId === selectedGroupId)
    return {
      variants: scoped.length,
      systemTotal: scoped.reduce((sum, row) => sum + row.systemQuantity, 0),
      countedTotal: scoped.reduce((sum, row) => sum + (parseCount(row.physicalCount) ?? 0), 0),
      varianceTotal: scoped.reduce((sum, row) => sum + (varianceForRow(row) || 0), 0),
    }
  }, [visibleRows, selectedGroupId])

  // "Count Type History" is the saved-session list narrowed to the currently
  // selected Count Type (legacy initial_configuration_classification folds into
  // the Opening Balance & Initial Classification bucket). Purely a display lens
  // over the already-loaded `drafts` — it never refetches, mutates the list or
  // touches the active count, so switching Count Type cannot lose entered work.
  const countTypeDrafts = useMemo(
    () => filterSessionsByCountType(criteriaDrafts, countType),
    [criteriaDrafts, countType],
  )
  const countTypeHistoryLabel = stockCountTypeBucketLabel(countType)

  // Derived purely from already-loaded rows — no extra fetch. A variant is
  // in scope for classification only while it still has a real balance on
  // its Legacy/Unclassified configuration at this warehouse.
  const classificationGroups = useMemo(
    () => buildInitialClassificationGroups(rows),
    [rows],
  )

  const classificationSummary = useMemo(() => {
    const perGroup = classificationGroups.map(group => {
      const entry = computeClassificationEntry(group.legacyRow.systemQuantity, group.targetRows)
      return {
        group,
        ...entry,
        cardDisplay: getClassificationCardDisplay(entry),
      }
    })
    // Only *selected* flavours (≥1 target counted) belong to this round. Blank
    // flavours are deferred and must never contribute their Legacy balance to
    // the summary — that double-charging was the -3,160 in the incident. The
    // numeric totals come from the shared, unit-tested summarizeClassificationRound.
    const selected = perGroup.filter(entry => entry.selected)
    const completeSelected = selected.filter(entry => entry.complete)
    const partialSelected = selected.filter(entry => !entry.complete)
    const totals = summarizeClassificationRound(classificationGroups.map(group => ({
      legacySystemQuantity: group.legacyRow.systemQuantity,
      unitCost: group.legacyRow.unitCost,
      targets: group.targetRows.map(row => ({ configCode: row.configCode, physicalCount: row.physicalCount })),
    })))
    return { perGroup, selected, completeSelected, partialSelected, ...totals }
  }, [classificationGroups])

  // Selected flavours whose targets are not all filled in — these block posting.
  const classificationPartialSelected = classificationSummary.partialSelected

  // The exact set of rows saveDraft persists to stock_count_session_items. Both
  // the save path and the client signature derive from this one memo so the
  // signature can never drift from what is actually written. In classification
  // mode ONLY selected flavours are persisted, so an unselected flavour's Legacy
  // balance is never written, validated, or posted (it stays for a later round).
  const draftRows = useMemo<CountRow[]>(() => (
    isClassificationMode
      ? classificationGroups
        .filter(group => group.targetRows.some(row => parseCount(row.physicalCount) !== null))
        .flatMap(group => [
          { ...group.legacyRow, physicalCount: '0' },
          ...group.targetRows.filter(row => parseCount(row.physicalCount) !== null || row.note.trim()),
        ])
      : isOpeningBalanceMode
        ? visibleRows
      // Full / Partial / Spot persist every entered count across all categories,
      // independent of the current category lens, so navigating categories never
      // drops saved work.
      : countableRows.filter(row => parseCount(row.physicalCount) !== null || row.note.trim())
  ), [isClassificationMode, isOpeningBalanceMode, classificationGroups, visibleRows, countableRows])

  // Snapshot the complete eligible catalog on first save, not only rows that
  // already have a physical count. Reopening a draft then remains stable even
  // when new variants/configurations are created later.
  const draftScopeRows = useMemo<CountRow[]>(() => (
    isClassificationMode
      ? classificationGroups.flatMap(group => [group.legacyRow, ...group.targetRows])
      : isOpeningBalanceMode
        // Snapshot only category-validated rows so the persisted scope can never
        // include a configuration from another Product Category (which would
        // then be dropped on reopen). Equivalent to the new-draft visibleRows,
        // but explicit and independent of the reopen display path.
        ? buildOpeningBalanceScopeRows(rows, selectedCategory)
        : countableRows
  ), [isClassificationMode, isOpeningBalanceMode, classificationGroups, rows, selectedCategory, countableRows])

  const allocationResolutionRows = useMemo(() => (
    isClassificationMode
      ? classificationGroups
        .filter(group =>
          group.legacyRow.quantityAllocated > 0
          && allocationTargets[group.variantId]
          && group.targetRows.some(row => parseCount(row.physicalCount) !== null),
        )
        .map(group => ({
          variantId: group.variantId,
          targetStockConfigId: allocationTargets[group.variantId],
        }))
      : []
  ), [allocationTargets, classificationGroups, isClassificationMode])

  const currentSignature = useMemo(() => stockCountDraftSignature(draftRows.map(row => ({
    stockConfigId: row.stockConfigId,
    variantId: row.variantId,
    physicalCount: parseCount(row.physicalCount),
    note: row.note,
  })), allocationResolutionRows), [allocationResolutionRows, draftRows])

  // Variants that still carry a Legacy/Unclassified balance at this warehouse.
  // Their 20NB/50NB/50OB configurations must be filled through Initial
  // Configuration Classification (which draws the legacy balance down), never
  // counted independently in a Full/Cycle/Spot count — that would add phantom
  // units on top of the untouched legacy balance (the incident's +150).
  const unclassifiedVariantIds = useMemo(
    () => new Set(rows.filter(row => row.configCode === LEGACY_CONFIG_CODE && row.systemQuantity > 0).map(row => row.variantId)),
    [rows],
  )
  const classificationMisuseRows = useMemo(() => {
    if (isClassificationMode || isOpeningBalanceMode) return [] as CountRow[]
    return draftRows.filter(row =>
      parseCount(row.physicalCount) !== null
      && (TARGET_CONFIG_CODES as readonly string[]).includes(row.configCode)
      && unclassifiedVariantIds.has(row.variantId)
      && !postedOpeningCategoryIds.has(row.categoryId)
      && !postedOpeningCategoryIds.has('*'))
  }, [isClassificationMode, isOpeningBalanceMode, draftRows, unclassifiedVariantIds, postedOpeningCategoryIds])
  const hasClassificationMisuse = classificationMisuseRows.length > 0

  // Centralized configuration-eligibility guard (client mirror of the DB guard).
  // A configuration that is ineligible for its product group — e.g. an invalid
  // 20mg/50mg configuration on a Device group — must never be counted or posted.
  // We only block when a count/note was actually entered against such a row, so
  // an untouched legacy phantom in an old snapshot never strands the operator;
  // the reviewed cleanup migration removes those. The DB trigger is authoritative.
  const configEligibilityViolations = useMemo(
    () => findIneligibleStockConfigs(
      draftRows
        .filter(row => parseCount(row.physicalCount) !== null || row.note.trim() !== '')
        .map(row => ({
          stockConfigId: row.stockConfigId,
          configCode: row.configCode,
          variantId: row.variantId,
          volumeMl: row.volumeMl,
          packaging: row.packagingVersion,
          groupProfile: row.groupConfigProfile,
          hasActivity: true,
        })),
    ),
    [draftRows],
  )
  const hasConfigEligibilityViolation = configEligibilityViolations.length > 0

  // On-screen counts differ from the saved draft. Review & Post must never run
  // against a dirty draft, and an issued code is void once the counts change.
  const hasUnsavedChanges = currentSignature !== lastSavedSignature
  const verificationStale = Boolean(verification) && verifiedSignature !== null && verifiedSignature !== currentSignature

  const canSave = Boolean(selectedWarehouse && selectedWarehouseIsValid
    && countDate && currentStatus !== 'posted' && !isOpeningBalanceReadOnly
    && (!isOpeningBalanceMode || selectedCategory)
    && !(isOpeningBalanceMode && openingBalancePosted)
    && !mustContinueExistingOpeningDraft
    && !openingDraftDetectionPending
    && (isClassificationMode
      ? classificationGroups.length > 0
      : isOpeningBalanceMode ? visibleRows.length > 0 : countableRows.length > 0))
  // In classification mode the round is postable once at least one flavour is
  // selected; a partial (incomplete) selection still opens Review so the block
  // can be shown, and the preflight/DB reject it.
  const canPost = !isOpeningBalanceMode && canSave
    && !hasConfigEligibilityViolation
    && (isClassificationMode ? classificationSummary.selectedFlavours > 0 : pageSummary.counted > 0)

  const updateRow = (stockConfigId: string, patch: Partial<Pick<CountRow, 'physicalCount' | 'note'>>) => {
    if (isOpeningBalanceReadOnly || !selectedWarehouseIsValid || currentStatus === 'posted') return
    setRows(prev => prev.map(row => row.stockConfigId === stockConfigId ? { ...row, ...patch } : row))
  }

  const handlePhysicalCountChange = (stockConfigId: string, value: string) => {
    if (value === '' || /^\d+$/.test(value)) updateRow(stockConfigId, { physicalCount: value })
  }

  const focusNextCountInput = (stockConfigId: string) => {
    const index = selectedGroupRows.findIndex(row => row.stockConfigId === stockConfigId)
    const next = selectedGroupRows[index + 1]
    if (next) document.querySelector<HTMLInputElement>(`input[data-count-input="${next.stockConfigId}"]`)?.focus()
  }

  // Reference / Batch Name is mandatory. Surfaces the inline error and moves the
  // operator to the field. Returns false when the action must be blocked. Legacy
  // read-only sessions are exempt (they cannot be saved anyway).
  const ensureReferenceProvided = (): boolean => {
    if (isOpeningBalanceReadOnly) return true
    const validation = validateStockCountReference(referenceName)
    if (!validation.valid) {
      setReferenceError(validation.message || null)
      toast({ title: 'Reference required', description: validation.message, variant: 'destructive' })
      referenceInputRef.current?.focus()
      referenceInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return false
    }
    setReferenceError(null)
    return true
  }

  const saveDraft = async (options: { noteOverride?: string; silent?: boolean } = {}): Promise<string | null> => {
    if (isCancelledOpeningBalanceReadOnly) {
      toast({
        title: 'Cancelled Opening Balance is read-only',
        description: 'Return to the active draft or create a new Opening Balance. Cancelled freezes cannot be edited.',
        variant: 'destructive',
      })
      return null
    }
    if (isLegacyInitialReadOnly) {
      toast({
        title: 'Legacy draft is read-only',
        description: 'Create an Inventory Opening Balance & Initial Classification draft for the official go-live process.',
        variant: 'destructive',
      })
      return null
    }
    if (isOpeningBalanceMode && openingBalancePosted) {
      toast({
        title: 'Opening Balance already posted',
        description: 'This warehouse already has its official Opening Balance. Use a Full or Partial / Cycle Count for later corrections.',
        variant: 'destructive',
      })
      return null
    }
    if (!selectedWarehouseIsValid) {
      toast({ title: 'Invalid warehouse', description: ACTIVE_WAREHOUSE_REQUIRED_MESSAGE, variant: 'destructive' })
      return null
    }
    // Never let a first Save outrun existing-draft detection or override a found
    // draft — either would try to create a second Opening Balance draft (and,
    // before the item upsert index existed, surface a raw ON CONFLICT error).
    if (openingDraftDetectionPending) {
      toast({ title: 'Checking for existing draft…', description: 'Please wait a moment while we check for an existing Opening Balance draft.' })
      return null
    }
    if (mustContinueExistingOpeningDraft) {
      toast({
        title: 'An active Opening Balance draft already exists',
        description: 'Continue the existing draft before saving. Your earlier quantities, imported data and scope are preserved.',
        variant: 'destructive',
      })
      return null
    }
    // Mandatory Reference / Batch Name. Blocks Save Draft and — because every
    // Excel-download, Import and Review & Post path funnels through saveDraft —
    // those actions too, so the rule cannot be side-stepped from the client.
    if (!ensureReferenceProvided()) return null
    if (hasConfigEligibilityViolation) {
      toast({
        title: 'Invalid configuration for this product group',
        description: configEligibilityViolations[0]?.message
          || 'A counted configuration is not valid for its product group.',
        variant: 'destructive',
      })
      return null
    }
    if (!canSave) return null
    if (countDate > todayIso()) {
      toast({ title: 'Invalid count date', description: 'Count date cannot be in the future.', variant: 'destructive' })
      return null
    }

    setSaving(true)
    try {
      if (!await validateActiveWarehouse()) throw new Error(ACTIVE_WAREHOUSE_REQUIRED_MESSAGE)
      const saveDraftCriteria = draftCriteriaKey
      if (isOpeningBalanceMode && !currentSessionId) {
        // UI gating is advisory only. Re-read the authoritative session table
        // immediately before insert so programmatic calls, delayed clicks and
        // another browser cannot create a second active draft.
        const { data: existingDraft, error: existingDraftError } = await supabase
          .from('stock_count_sessions' as any)
          .select('id')
          .eq('warehouse_organization_id', selectedWarehouse)
          .eq('product_category_id', selectedCategory)
          .eq('count_type', 'opening_balance_cutoff')
          .eq('status', 'draft')
          .limit(1)
          .maybeSingle()
        if (existingDraftError) throw existingDraftError
        if (draftCriteriaRef.current !== saveDraftCriteria) {
          toast({
            title: 'Opening Balance selection changed',
            description: 'The warehouse or category changed while the draft was being checked. Review the latest selection and save again.',
            variant: 'destructive',
          })
          return null
        }
        if ((existingDraft as any)?.id) {
          const { data: blockingCutoff } = await (supabase as any)
            .from('inventory_opening_cutoffs')
            .select('status')
            .eq('stock_count_session_id', (existingDraft as any).id)
            .maybeSingle()
          await loadDrafts(selectedWarehouse, saveDraftCriteria)
          if (blockingCutoff?.status === 'cancelled') {
            toast({
              title: 'A cancelled Opening Balance draft is still occupying this slot',
              description: 'Open the cancelled history entry and choose Create New Opening Balance, or discard that cancelled draft first. A cancelled freeze is never reused.',
              variant: 'destructive',
            })
          } else {
            toast({
              title: 'An active Opening Balance draft already exists',
              description: 'Use Continue Existing Draft. The existing draft and its saved snapshot have not been changed.',
              variant: 'destructive',
            })
          }
          return null
        }
      }
      const payload = {
        warehouse_organization_id: selectedWarehouse,
        product_category_id: isOpeningBalanceMode ? selectedCategory : null,
        count_date: countDate,
        count_type: countType,
        reference_name: referenceName.trim() || null,
        notes: normalizeStockCountPostingNote(options.noteOverride ?? notes) || null,
        status: 'draft',
        created_by: userProfile?.id || null,
        updated_by: userProfile?.id || null,
        updated_at: new Date().toISOString(),
      }

      let sessionId = currentSessionId
      const updatingExistingSession = Boolean(sessionId)
      if (sessionId) {
        const { error } = await supabase
          .from('stock_count_sessions' as any)
          .update(payload)
          .eq('id', sessionId)
          .eq('status', 'draft')
          .select('id')
          .single()
        if (error) throw error
      } else {
        const { data, error } = await supabase.from('stock_count_sessions' as any).insert(payload).select('id').single()
        if (error) {
          // The server-side preflight above can still lose a concurrency race.
          // The DB uniqueness rule is authoritative; refresh detection and make
          // the operator explicitly choose Continue Existing Draft.
          if (isOpeningBalanceMode && (error as any).code === '23505') {
            await loadDrafts(selectedWarehouse, saveDraftCriteria)
            toast({
              title: 'An active Opening Balance draft already exists',
              description: 'Use Continue Existing Draft. No second draft was created.',
              variant: 'destructive',
            })
            return null
          }
          throw error
        }
        sessionId = (data as any).id
        setCurrentSessionId(sessionId)
      }

      const { data: existingScope, error: scopeReadError } = await supabase
        .from('stock_count_session_scope' as any)
        .select('stock_config_id')
        .eq('session_id', sessionId)
      if (scopeReadError) throw scopeReadError
      if (!updatingExistingSession && (existingScope || []).length === 0 && draftScopeRows.length > 0) {
        const { error: scopeInsertError } = await supabase
          .from('stock_count_session_scope' as any)
          .insert(draftScopeRows.map(row => ({ session_id: sessionId, stock_config_id: row.stockConfigId })))
        if (scopeInsertError) throw scopeInsertError
      }
      if (isOpeningBalanceMode) {
        const persistedScopeIds = (existingScope || []).length > 0
          ? (existingScope || []).map((entry: any) => String(entry.stock_config_id))
          : draftScopeRows.map(row => row.stockConfigId)
        const expectedScopeIds = updatingExistingSession
          ? (openingDraftScopeIds.size > 0 ? openingDraftScopeIds : new Set(draftRows.map(row => row.stockConfigId)))
          : new Set(draftScopeRows.map(row => row.stockConfigId))
        const verifiedScopeIds = assertImmutableOpeningScopeComplete(persistedScopeIds, expectedScopeIds)
        assertOpeningDraftRowsComplete(verifiedScopeIds, draftRows.map(row => row.stockConfigId))
        // Publish only the complete authoritative set. A partial database read
        // can never replace a previously valid multi-row UI scope with one row.
        setOpeningDraftScopeIds(verifiedScopeIds)
      }

      // Classification sessions always force the Legacy/Unclassified row to a
      // physical count of exactly 0 (it is never user-typed — see
      // prepare_stock_count_verification's classification guard) and only
      // include target rows that already have a physical count entered. This is
      // the shared `draftRows` memo so the persisted set and the client
      // signature can never disagree.
      const savedSignature = currentSignature
      let savedItemCount = draftRows.length
      if (!isOpeningBalanceMode) {
        const { error: deleteError } = await supabase
          .from('stock_count_session_items' as any)
          .delete()
          .eq('session_id', sessionId)
        if (deleteError) throw deleteError
      }
      if (draftRows.length > 0) {
        const { data: persistedOpeningItems, error: persistedItemError } =
          isOpeningBalanceMode && updatingExistingSession
            ? await supabase
              .from('stock_count_session_items' as any)
              .select('stock_config_id, variant_id, sku, system_quantity, physical_quantity, unit_cost, note')
              .eq('session_id', sessionId)
            : { data: null, error: null }
        if (persistedItemError) throw persistedItemError

        const persistedByConfig = new Map((persistedOpeningItems || []).map((item: any) => [
          String(item.stock_config_id),
          item,
        ]))
        const changedConfigIds = isOpeningBalanceMode && updatingExistingSession
          ? new Set(changedOpeningDraftItems(
            draftRows.map(row => ({
              stockConfigId: row.stockConfigId,
              physicalQuantity: parseCount(row.physicalCount),
              note: row.note,
            })),
            (persistedOpeningItems || []).map((item: any) => ({
              stockConfigId: String(item.stock_config_id),
              physicalQuantity: item.physical_quantity === null ? null : Number(item.physical_quantity),
              note: item.note || '',
            })),
          ).map(item => item.stockConfigId))
          : null

        const itemPayload = draftRows
          .filter(row => !changedConfigIds || changedConfigIds.has(row.stockConfigId))
          .map(row => {
            const physical = parseCount(row.physicalCount)
            const persisted = persistedByConfig.get(row.stockConfigId)
            const snapshotSystemQuantity = persisted
              ? Number(persisted.system_quantity)
              : row.systemQuantity
            return {
              session_id: sessionId,
              variant_id: persisted ? persisted.variant_id : row.variantId,
              stock_config_id: row.stockConfigId,
              sku: persisted ? persisted.sku : skuForRow(row),
              system_quantity: snapshotSystemQuantity,
              physical_quantity: physical,
              adjustment_quantity: physical === null ? null : physical - snapshotSystemQuantity,
              unit_cost: persisted ? persisted.unit_cost : row.unitCost,
              note: row.note.trim() || null,
            }
          })
        savedItemCount = itemPayload.length
        // Opening Balance always persists the complete snapshot, including
        // null physical quantities on first save. Existing drafts upsert only
        // changed quantity/note rows and reuse the original snapshot columns,
        // so Update Draft cannot rebuild or drift immutable snapshot data.
        const itemWrite = isOpeningBalanceMode
          ? supabase.from('stock_count_session_items' as any).upsert(itemPayload, {
            onConflict: 'session_id,stock_config_id',
          })
          : supabase.from('stock_count_session_items' as any).insert(itemPayload)
        if (itemPayload.length > 0) {
          const { error: itemError } = await itemWrite
          if (itemError) throw itemError
        }
      }

      if (isClassificationMode) {
        const { error: resolutionDeleteError } = await supabase
          .from('stock_count_classification_allocation_resolutions' as any)
          .delete()
          .eq('session_id', sessionId)
        if (resolutionDeleteError) throw resolutionDeleteError
        if (allocationResolutionRows.length > 0) {
          const { error: resolutionInsertError } = await supabase
            .from('stock_count_classification_allocation_resolutions' as any)
            .insert(allocationResolutionRows.map((resolution) => ({
              session_id: sessionId,
              variant_id: resolution.variantId,
              target_stock_config_id: resolution.targetStockConfigId,
              created_by: userProfile?.id || null,
            })))
          if (resolutionInsertError) throw resolutionInsertError
        }
      }

      // The screen and the saved draft are now identical — clear the dirty flag.
      setLastSavedSignature(savedSignature)
      if (!options.silent) {
        const countedOrNotedCount = draftRows.filter(row =>
          parseCount(row.physicalCount) !== null || row.note.trim() !== ''
        ).length
        toast({
          title: updatingExistingSession ? 'Draft updated' : 'Draft saved',
          description: isOpeningBalanceMode
            ? openingDraftSaveDescription({
              scopeCount: draftRows.length,
              changedItemCount: savedItemCount,
              countedOrNotedCount,
            })
            : `${savedItemCount} counted or noted row(s) saved.`,
        })
      }
      await loadDrafts(selectedWarehouse)
      return sessionId
    } catch (error: any) {
      toast({ title: 'Save draft failed', description: error.message, variant: 'destructive' })
      return null
    } finally {
      setSaving(false)
    }
  }

  // Atomic autosave after an Excel import. Runs on the render *after* the
  // imported rows are committed (setRows is async), so saveDraft persists the
  // imported counts. "Import complete" is only shown once the save succeeds;
  // a failed save surfaces a blocking "not saved" warning instead of silently
  // leaving the screen ahead of the draft.
  useEffect(() => {
    if (!pendingAutoSave) return
    setPendingAutoSave(false)
    const summary = importSummary
    if (!canSave) {
      if (summary) toast({ title: 'Import applied', description: `${summary.updated} updated, ${summary.unchanged} unchanged, ${summary.failed} failed. Save the draft to persist.` })
      return
    }
    void (async () => {
      const savedId = await saveDraft({ silent: true })
      if (savedId) {
        toast({
          title: 'Import complete',
          description: summary
            ? `${summary.updated} updated, ${summary.unchanged} unchanged, ${summary.failed} failed. Saved to draft.`
            : 'Imported counts saved to the draft.',
        })
      } else {
        toast({ title: 'Imported counts not saved', description: UNSAVED_CHANGES_MESSAGE, variant: 'destructive' })
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutoSave])

  const loadDraft = async (sessionId: string) => {
    const { data: session, error } = await supabase.from('stock_count_sessions' as any)
      .select('id, warehouse_organization_id, product_category_id, count_date, count_type, reference_name, notes, status, created_at, updated_at')
      .eq('id', sessionId)
      .single()
    if (error) {
      toast({ title: 'Open draft failed', description: error.message, variant: 'destructive' })
      return
    }
    const draftWarehouseId = String((session as any).warehouse_organization_id || '')
    if (draftWarehouseId !== selectedWarehouse || !await validateActiveWarehouse(draftWarehouseId)) {
      toast({
        title: 'Invalid warehouse on saved Stock Count',
        description: `${ACTIVE_WAREHOUSE_REQUIRED_MESSAGE} This historical record remains unchanged; create a new draft using a valid warehouse.`,
        variant: 'destructive',
      })
      return
    }
    const baseCatalogRows = catalogRows.length > 0
      ? catalogRows
      : await loadCountRows(draftWarehouseId, { publish: false })
    const { data: items, error: itemError } = await supabase.from('stock_count_session_items' as any).select('stock_config_id, variant_id, physical_quantity, note').eq('session_id', sessionId)
    if (itemError) {
      toast({ title: 'Open draft failed', description: itemError.message, variant: 'destructive' })
      return
    }
    const { data: scope, error: scopeError } = await supabase
      .from('stock_count_session_scope' as any)
      .select('stock_config_id')
      .eq('session_id', sessionId)
    if (scopeError) {
      toast({ title: 'Open draft failed', description: scopeError.message, variant: 'destructive' })
      return
    }
    const { data: allocationResolutions, error: allocationResolutionError } = await supabase
      .from('stock_count_classification_allocation_resolutions' as any)
      .select('variant_id,target_stock_config_id')
      .eq('session_id', sessionId)
    if (allocationResolutionError) {
      toast({ title: 'Open draft failed', description: allocationResolutionError.message, variant: 'destructive' })
      return
    }

    const legacyItem = (items || []).find((item: any) => !item.stock_config_id)
    if (legacyItem) {
      setStaleDraftIds(prev => new Set(prev).add(sessionId))
      toast({
        title: 'This draft uses an older Stock Count format',
        description: 'Create a new configuration-aware count. The historical draft remains unchanged until archived.',
        variant: 'destructive',
      })
      return
    }
    const itemMap = new Map((items || []).map((item: any) => [item.stock_config_id, item]))
    const scopeIds = new Set((scope || []).map((entry: any) => entry.stock_config_id))
    if ((session as any).count_type === 'opening_balance_cutoff' && scopeIds.size === 0) {
      toast({
        title: 'Opening Balance scope unavailable',
        description: 'This draft has no immutable scope snapshot. The previous complete view was preserved and the draft was not changed.',
        variant: 'destructive',
      })
      return
    }
    const effectiveScopeIds = scopeIds.size > 0 ? scopeIds : new Set(itemMap.keys())
    let scopedCatalogRows = baseCatalogRows.filter(row => effectiveScopeIds.has(row.stockConfigId))
    const loadedScopeIds = new Set(scopedCatalogRows.map(row => row.stockConfigId))
    const missingScopeIds = [...effectiveScopeIds].filter(id => !loadedScopeIds.has(id))
    if (missingScopeIds.length > 0) {
      const [historicalConfigResult, historicalBalanceResult] = await Promise.all([
        (supabase as any)
          .from('inventory_stock_configurations')
          .select(`
            id, variant_id, config_code, config_label, stock_sku, volume_ml, packaging, status, sort_order,
            product_variants!inner (
              id, variant_name, alternative_name, variant_code, product_code, manufacturer_sku, manual_sku, image_url, base_cost, is_active,
              products!inner (
                id, product_name, is_active, category_id, group_id, brand_id, units_per_case,
                product_categories!inner (id, category_name, is_active),
                product_groups (id, group_name, group_description, stock_config_profile),
                brands (id, brand_name, logo_url)
              )
            )
          `)
          .in('id', missingScopeIds),
        (supabase as any)
          .from('product_inventory')
          .select('id, variant_id, stock_config_id, quantity_on_hand, quantity_allocated, warehouse_location')
          .eq('organization_id', draftWarehouseId)
          .in('stock_config_id', missingScopeIds),
      ])
      if (historicalConfigResult.error || historicalBalanceResult.error) {
        toast({
          title: 'Historical draft scope unavailable',
          description: historicalConfigResult.error?.message || historicalBalanceResult.error?.message,
          variant: 'destructive',
        })
        return
      }
      scopedCatalogRows = [
        ...scopedCatalogRows,
        ...buildStockCountCatalogRows(historicalConfigResult.data || [], historicalBalanceResult.data || []),
      ]
    }
    try {
      assertOpeningDraftRowsComplete(
        effectiveScopeIds as Set<string>,
        scopedCatalogRows.map(row => row.stockConfigId),
      )
    } catch (scopeCompletenessError: any) {
      toast({
        title: 'Incomplete draft reload blocked',
        description: scopeCompletenessError.message,
        variant: 'destructive',
      })
      return
    }
    setOpeningDraftScopeIds(
      (session as any).count_type === 'opening_balance_cutoff'
        ? effectiveScopeIds as Set<string>
        : new Set(),
    )
    // Reveal read-only history rows (inactive configs OR archived variants) that
    // a draft counted, so an archived variant is never silently dropped from an
    // existing draft — it stays visible as a historical draft item.
    if (scopedCatalogRows.some(row =>
      itemMap.has(row.stockConfigId)
      && (row.configStatus !== 'active' || !row.variantIsActive || !row.productIsActive)
    )) setShowInactive(true)
    setCurrentSessionId((session as any).id)
    setCurrentStatus((session as any).status)
    setCountDate((session as any).count_date)
    setCountType((session as any).count_type)
    setSelectedCategory((session as any).product_category_id || '')
    setReferenceName((session as any).reference_name || '')
    // An editable draft saved before Reference / Batch Name became mandatory must
    // be updated before it can be saved / imported / posted again. Notify and
    // highlight the field, but never silently generate a value. Posted / legacy
    // read-only records are left readable (handled in the UI, not blocked here).
    const referenceMissing = isStockCountReferenceMissing((session as any).reference_name)
    const editableSession = (session as any).status === 'draft' && (session as any).count_type !== 'initial_configuration_classification'
    if (referenceMissing && editableSession) {
      setReferenceError('This count does not have a Reference / Batch Name. Please update it before continuing.')
      toast({
        title: 'Reference / Batch Name missing',
        description: 'This count does not have a Reference / Batch Name. Please update it before continuing.',
        variant: 'destructive',
      })
    } else {
      setReferenceError(null)
    }
    setNotes((session as any).notes || '')
    setRows(scopedCatalogRows.map(row => {
      const item = itemMap.get(row.stockConfigId) as any
      return item ? { ...row, physicalCount: item.physical_quantity === null ? '' : String(item.physical_quantity), note: item.note || '' } : { ...row, physicalCount: '', note: '' }
    }))
    const loadedAllocationTargets = Object.fromEntries((allocationResolutions || []).map((resolution: any) => [
      resolution.variant_id,
      resolution.target_stock_config_id,
    ]))
    setAllocationTargets(loadedAllocationTargets)
    // The freshly loaded rows exactly match what is persisted, so seed the
    // saved-signature baseline from the loaded items (not from the pre-load
    // memo, which has not recomputed yet) to avoid a false "unsaved" flag.
    setLastSavedSignature(stockCountDraftSignature((items || []).map((item: any) => ({
      stockConfigId: item.stock_config_id ?? null,
      variantId: item.variant_id,
      physicalCount: item.physical_quantity === null || item.physical_quantity === undefined ? null : Number(item.physical_quantity),
      note: typeof item.note === 'string' ? item.note : '',
    })), (allocationResolutions || []).map((resolution: any) => ({
      variantId: resolution.variant_id,
      targetStockConfigId: resolution.target_stock_config_id,
    }))))
    setVerification(null)
    setVerifiedSignature(null)
    const legacyInitial = (session as any).count_type === 'initial_configuration_classification'
    toast({
      title: legacyInitial ? 'Legacy Initial draft opened read-only' : 'Draft opened',
      description: legacyInitial
        ? 'Historical counts remain viewable, but this retired workflow cannot be edited or posted.'
        : 'Saved counts are loaded for review.',
    })
  }

  const exitManageDrafts = () => {
    setManagingDrafts(false)
    setSelectedDraftIds(new Set())
    setDiscardConfirmIds(null)
  }

  const selectAllDrafts = () => {
    // Manage Drafts follows the selected Count Type: Select All only ever picks
    // the deletable drafts currently shown for this count type.
    setSelectedDraftIds(new Set(filterSessionsByCountType(drafts, countType).filter(draft => draft.deletable).map(draft => draft.id)))
  }

  const deselectAllDrafts = () => {
    setSelectedDraftIds(new Set())
  }

  const toggleDraftSelection = (sessionId: string, checked: boolean) => {
    setSelectedDraftIds(prev => {
      const next = new Set(prev)
      if (checked) next.add(sessionId)
      else next.delete(sessionId)
      return next
    })
  }

  const requestDiscardDrafts = (sessionIds: string[]) => {
    const uniqueIds = new Set(sessionIds.filter(Boolean))
    // Never send protected/official history to the RPC — keep only genuinely
    // deletable drafts so the confirmation and discard can only ever act on
    // records the backend will actually remove (no fake success).
    const removableIds = drafts.filter(draft => uniqueIds.has(draft.id) && draft.deletable).map(draft => draft.id)
    if (removableIds.length === 0 || discardingDrafts) return
    setDiscardConfirmIds(removableIds)
  }

  const discardDrafts = async (sessionIds: string[]) => {
    if (discardingDrafts) return
    const uniqueIds = [...new Set(sessionIds.filter(Boolean))]
    if (uniqueIds.length === 0) return

    setDiscardingDrafts(true)
    try {
      const { data, error } = await supabase.rpc('discard_stock_count_drafts' as any, {
        p_session_ids: uniqueIds,
      })
      if (error) throw error

      const result = (data || {}) as {
        discarded_ids?: string[]
        already_archived_ids?: string[]
        failed?: Array<{ session_id?: string; error?: string }>
      }
      const discardedIds = [
        ...(Array.isArray(result.discarded_ids) ? result.discarded_ids : []),
        ...(Array.isArray(result.already_archived_ids) ? result.already_archived_ids : []),
      ]
      const failed = Array.isArray(result.failed) ? result.failed : []
      const removedIds = new Set(discardedIds)

      if (removedIds.size > 0) {
        setDrafts(prev => prev.filter(draft => !removedIds.has(draft.id)))
        setStaleDraftIds(prev => {
          const next = new Set(prev)
          removedIds.forEach(id => next.delete(id))
          return next
        })
        setSelectedDraftIds(prev => {
          const next = new Set(prev)
          removedIds.forEach(id => next.delete(id))
          return next
        })
        if (currentSessionId && removedIds.has(currentSessionId)) {
          resetSession()
        }
        toast({
          title: discardedIds.length === 1 ? 'Draft discarded' : 'Drafts discarded',
          description: DISCARD_SUCCESS_TOAST,
        })
      }

      if (failed.length > 0) {
        const firstError = String(failed[0]?.error || '')
        toast({
          title: removedIds.size > 0 ? 'Some drafts could not be discarded' : 'Discard draft failed',
          description: discardErrorMessage(firstError),
          variant: 'destructive',
        })
        if (selectedWarehouse) await loadDrafts(selectedWarehouse)
      } else if (removedIds.size === 0) {
        toast({
          title: 'Discard draft failed',
          description: DISCARD_INELIGIBLE_MESSAGE,
          variant: 'destructive',
        })
      }

      if (managingDrafts && drafts.filter(draft => !removedIds.has(draft.id)).length === 0) {
        exitManageDrafts()
      }
    } catch (error: any) {
      const message = String(error?.message || '')
      toast({
        title: 'Discard draft failed',
        description: discardErrorMessage(message),
        variant: 'destructive',
      })
      if (selectedWarehouse) await loadDrafts(selectedWarehouse)
    } finally {
      setDiscardingDrafts(false)
      setDiscardConfirmIds(null)
    }
  }

  const resetSession = () => {
    setCurrentSessionId(null)
    setCurrentStatus('draft')
    setCountDate(todayIso())
    setCountType('full_count')
    setSelectedCategory('')
    setOpeningDraftScopeIds(new Set())
    setReferenceName('')
    setReferenceError(null)
    setNotes('')
    setRows(catalogRows.map(row => ({ ...row, physicalCount: '', note: '' })))
    setLastSavedSignature(EMPTY_SIGNATURE)
    setVerification(null)
    setVerifiedSignature(null)
    setImportSummary(null)
    setAllocationTargets({})
  }

  const downloadExcel = async () => {
    if (isCancelledOpeningBalanceReadOnly) {
      toast({
        title: 'Cancelled Opening Balance is read-only',
        description: 'Templates are not generated for cancelled freezes.',
        variant: 'destructive',
      })
      return
    }
    if (isLegacyInitialReadOnly) {
      toast({
        title: 'Legacy draft is read-only',
        description: 'Historical Initial Classification templates are no longer generated.',
        variant: 'destructive',
      })
      return
    }
    if (!selectedWarehouseIsValid || !await validateActiveWarehouse()) {
      toast({ title: 'Excel download blocked', description: ACTIVE_WAREHOUSE_REQUIRED_MESSAGE, variant: 'destructive' })
      return
    }
    if (isClassificationMode) {
      if (classificationGroups.length === 0) return
      const ExcelJS = (await import('exceljs')).default
      const workbook = new ExcelJS.Workbook()
      buildClassificationWorksheet(workbook, classificationSummary.perGroup.flatMap(({ group, classifiedTotal, variance }) => [
        {
          stockConfigId: group.legacyRow.stockConfigId, stockSku: group.legacyRow.stockSku, variantId: group.variantId,
          groupName: group.legacyRow.groupName, productName: group.legacyRow.productName,
          variantName: group.legacyRow.variantName, productCode: group.legacyRow.productCode,
          volumeMl: group.legacyRow.volumeMl, packagingVersion: group.legacyRow.packagingVersion, lifecycle: group.legacyRow.configLabel,
          isLegacy: true, legacySystemQuantity: group.legacyRow.systemQuantity, physicalCount: '0',
          classifiedTotal, variance,
        },
        ...group.targetRows.map(row => ({
          stockConfigId: row.stockConfigId, stockSku: row.stockSku, variantId: group.variantId,
          groupName: row.groupName, productName: row.productName,
          variantName: row.variantName, productCode: row.productCode,
          volumeMl: row.volumeMl, packagingVersion: row.packagingVersion, lifecycle: row.configLabel,
          isLegacy: false, legacySystemQuantity: group.legacyRow.systemQuantity, physicalCount: row.physicalCount,
          classifiedTotal, variance,
        })),
      ]))
      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([new Uint8Array(buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `Serapod2U_Initial_Configuration_Classification_${countDate}.xlsx`
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      return
    }

    if (visibleRows.length === 0) return
    let templateSessionId = currentSessionId
    if (!templateSessionId) {
      templateSessionId = await saveDraft({ silent: true })
      if (!templateSessionId) return
    }
    const ExcelJS = (await import('exceljs')).default
    const workbook = new ExcelJS.Workbook()
    buildStockCountWorksheet(workbook, visibleRows.map(row => ({
      stockConfigId: row.stockConfigId,
      stockSku: row.stockSku,
      variantId: row.variantId,
      volumeMl: row.volumeMl,
      packagingVersion: row.packagingVersion,
      groupName: row.groupName,
      variantName: row.variantName,
      productName: row.productName,
      productCode: row.productCode,
      systemQuantity: row.systemQuantity,
      physicalCount: row.physicalCount,
      note: row.note,
    })), {
      warehouseId: selectedWarehouse,
      sessionId: templateSessionId,
      countType,
      categoryId: selectedCategory || undefined,
    })
    const buffer = await workbook.xlsx.writeBuffer()
    const blob = new Blob([new Uint8Array(buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = isOpeningBalanceMode
      ? `Serapod2U_Opening_Balance_Initial_Classification_${countDate}.xlsx`
      : `Serapod2U_Stock_Count_${countDate}.xlsx`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  // Any change to the counted rows voids an outstanding verification code: the
  // code (and the server-side snapshot hash it is bound to) no longer describes
  // what is on screen. The user must review and request a fresh code.
  const invalidatePendingVerification = () => {
    setVerification(null)
    setVerifiedSignature(null)
    setVerificationCode('')
    setVerificationError(null)
    if (preflight.status !== 'idle') setPreflight({ status: 'idle' })
  }

  // Called after an Excel import has patched the on-screen rows. The imported
  // counts live only in React state until persisted, so we (1) void any pending
  // code and (2) request an atomic autosave so "Import complete" is only ever
  // shown after the counts are safely in stock_count_session_items.
  const onImportApplied = () => {
    invalidatePendingVerification()
    setPendingAutoSave(true)
  }

  const importExcel = async (file: File) => {
    try {
      if (isCancelledOpeningBalanceReadOnly) {
        throw new Error('This cancelled Opening Balance freeze is read-only and cannot accept imports.')
      }
      if (isLegacyInitialReadOnly) {
        throw new Error('This Legacy Initial Classification draft is read-only and cannot accept imports.')
      }
      if (!selectedWarehouseIsValid || !await validateActiveWarehouse()) {
        throw new Error(ACTIVE_WAREHOUSE_REQUIRED_MESSAGE)
      }
      // A draft must first exist to import into it, and a draft cannot exist
      // without a Reference / Batch Name — so block (and focus the field) when
      // an older draft without a reference is opened and an import is attempted.
      if (!ensureReferenceProvided()) return
      if (!currentSessionId) {
        throw new Error('Save this Stock Count draft or download its template before importing.')
      }
      const ExcelJS = (await import('exceljs')).default
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(await file.arrayBuffer())
      const sheet = workbook.worksheets[0]
      if (!sheet) throw new Error('The Excel file does not contain a worksheet.')

      if (isClassificationMode) {
        const targets = classificationGroups.flatMap(group => [
          {
            stockConfigId: group.legacyRow.stockConfigId,
            stockSku: group.legacyRow.stockSku,
            variantId: group.variantId,
            groupName: group.legacyRow.groupName,
            productName: group.legacyRow.productName,
            variantName: group.legacyRow.variantName,
            productCode: group.legacyRow.productCode,
            volumeMl: group.legacyRow.volumeMl,
            packagingVersion: group.legacyRow.packagingVersion,
            lifecycle: group.legacyRow.configLabel,
            isLegacy: true,
            legacySystemQuantity: group.legacyRow.systemQuantity,
            physicalCount: '0',
          },
          ...group.targetRows.map(row => ({
            stockConfigId: row.stockConfigId,
            stockSku: row.stockSku,
            variantId: group.variantId,
            groupName: row.groupName,
            productName: row.productName,
            variantName: row.variantName,
            productCode: row.productCode,
            volumeMl: row.volumeMl,
            packagingVersion: row.packagingVersion,
            lifecycle: row.configLabel,
            isLegacy: false,
            legacySystemQuantity: group.legacyRow.systemQuantity,
            physicalCount: row.physicalCount,
          })),
        ])
        const result = parseClassificationWorksheet(sheet, targets)
        setRows(prev => prev.map(row => result.patches.has(row.stockConfigId) ? { ...row, ...result.patches.get(row.stockConfigId)! } : row))
        setImportSummary({ updated: result.updated, unchanged: result.unchanged, failed: result.failed, rows: result.rows })
        onImportApplied()
        return
      }

      const result = parseStockCountWorksheet(sheet, visibleRows.map(row => ({
        stockConfigId: row.stockConfigId,
        variantId: row.variantId,
        stockSku: row.stockSku,
        physicalCount: row.physicalCount,
        note: row.note,
      })), {
        warehouseId: selectedWarehouse,
        sessionId: currentSessionId,
        countType,
        categoryId: selectedCategory || undefined,
      })
      setRows(prev => prev.map(row => result.patches.has(row.stockConfigId) ? { ...row, ...result.patches.get(row.stockConfigId)! } : row))
      setImportSummary({
        updated: result.updated,
        unchanged: result.unchanged,
        failed: result.failed,
        rows: result.rows,
      })
      onImportApplied()
    } catch (error: any) {
      toast({
        title: 'Excel import failed',
        description: error?.message || 'The Stock Count Excel file could not be read.',
        variant: 'destructive',
      })
    }
  }

  const requestVerificationCode = async () => {
    if (!canPost || currentStatus === 'posted' || posting) return
    if (reviewVarianceItems > 0 && !isValidStockCountPostingNote(notes)) {
      setVerificationError('A Posting Note is required when the Stock Count contains variance.')
      return
    }
    setPosting(true)
    setVerificationError(null)
    try {
      const sessionId = currentSessionId || await saveDraft()
      if (!sessionId) throw new Error('Save the draft before posting.')
      if (currentSessionId) {
        const savedSessionId = await saveDraft()
        if (!savedSessionId) throw new Error('The latest Stock Count changes could not be saved.')
      }
      // Only show the review-step preflight spinner when a code has not been
      // issued yet. Resend failures must not bury the verify UI behind the
      // review-step error panel.
      if (!verification) setPreflight({ status: 'loading' })
      const response = await fetch('/api/inventory/stock-count/verification/request', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }),
      })
      const result = await response.json()
      if (!response.ok) {
        const message = formatVerificationApiError(result, 'request')
        if (verification) {
          // Keep the issued-code UI; show the actionable failure inline.
          setVerificationError(message)
        } else {
          setPreflight({ status: 'error', code: result.code, message, guidance: result.guidance })
        }
        return
      }
      // Successful generation+delivery must always clear stale request/verify errors.
      setVerificationError(null)
      setPreflight({ status: 'ready', recipientCount: Array.isArray(result.recipients) ? result.recipients.length : 0 })
      setVerification({ ...result, sessionId })
      // Bind the issued code to the exact counts on screen. Any later edit/import
      // makes verificationStale true and blocks Verify & Post.
      setVerifiedSignature(currentSignature)
      setVerificationCode('')
      setVerificationNow(Date.now())
      toast({ title: 'Verification code sent', description: `Sent to ${result.recipients.length} authorized recipient(s).` })
    } catch (error: any) {
      const friendly = stockCountVerificationError('unexpected_error', { stage: 'request' })
      setVerificationError(error?.message || friendly.message)
      if (!verification) setPreflight({ status: 'error', code: friendly.code, message: friendly.message })
    } finally {
      setPosting(false)
    }
  }

  const runVerificationPreflight = async (sessionId: string) => {
    setPreflight({ status: 'loading' })
    setVerificationError(null)
    if (permissionGate === 'checking') return
    if (permissionGate === 'denied') {
      const friendly = stockCountVerificationError('permission_denied')
      setPreflight({ status: 'error', code: friendly.code, message: friendly.message })
      return
    }
    // Enforced on every preflight path (open, retry, permission re-check) so a
    // Full/Cycle/Spot count can never be used to reclassify a legacy balance.
    // The DB (migration 09) is the authoritative backstop; this is the friendly
    // early block. See classificationMisuseRows.
    if (hasClassificationMisuse) {
      const names = Array.from(new Set(classificationMisuseRows.map(row => `${row.productName} — ${row.variantName}`))).slice(0, 5)
      setPreflight({
        status: 'error',
        code: 'classification_misuse',
        message: `${names.join('; ')}${classificationMisuseRows.length > names.length ? '; …' : ''} still ${names.length === 1 ? 'has' : 'have'} a Legacy/Unclassified balance. Use "Inventory Opening Balance & Initial Classification" for the official go-live count — a normal Full/Cycle/Spot count would add phantom stock on top of the unclassified balance.`,
      })
      return
    }
    // A *selected* classification flavour (≥1 target counted) must have all three
    // targets counted. Deferred (all-blank) flavours are ignored. The DB
    // (prepare_stock_count_verification) is the backstop; this is the friendly
    // early block. See classificationPartialSelected.
    if (isClassificationMode && classificationPartialSelected.length > 0) {
      const names = classificationPartialSelected.map(entry => `${entry.group.productName} — ${entry.group.variantName}`).slice(0, 5)
      setPreflight({
        status: 'error',
        code: 'classification_incomplete',
        message: `Enter a physical count for all three target configurations (20 mg New Box, 50 mg New Box, 50 mg Old Box) for ${names.join('; ')}${classificationPartialSelected.length > names.length ? '; …' : ''}, or clear its counts to defer it to a later round.`,
      })
      return
    }
    // Live Legacy revalidation (allocation / already-classified). Target totals
    // above or below Legacy are genuine physical-count variance, not errors.
    // Server prepare + post re-check under row locks; this is the friendly early block.
    if (isClassificationMode) {
      const liveLegacyByVariant = new Map(
        classificationGroups.map((group) => [group.variantId, {
          variantId: group.variantId,
          productName: group.productName,
          variantName: group.variantName,
          liveOnHand: group.legacyRow.systemQuantity,
          liveAllocated: group.legacyRow.quantityAllocated,
        }]),
      )
      const flavours = classificationSummary.perGroup.map((entry) => ({
        variantId: entry.group.variantId,
        productName: entry.group.productName,
        variantName: entry.group.variantName,
        requestedTotal: entry.classifiedTotal,
        selected: entry.selected,
        allocationTargetStockConfigId: allocationTargets[entry.group.variantId] || null,
      }))
      const invalidAllocationTarget = classificationSummary.perGroup.find((entry) => {
        if (!entry.selected || entry.group.legacyRow.quantityAllocated <= 0) return false
        const targetId = allocationTargets[entry.group.variantId]
        if (!targetId) return false
        const target = entry.group.targetRows.find(row => row.stockConfigId === targetId)
        const targetPhysical = target ? parseCount(target.physicalCount) : null
        return !target
          || targetPhysical === null
          || targetPhysical < target.quantityAllocated + entry.group.legacyRow.quantityAllocated
      })
      if (invalidAllocationTarget) {
        const target = invalidAllocationTarget.group.targetRows.find(
          row => row.stockConfigId === allocationTargets[invalidAllocationTarget.group.variantId],
        )
        const required = (target?.quantityAllocated || 0) + invalidAllocationTarget.group.legacyRow.quantityAllocated
        setPreflight({
          status: 'error',
          code: 'classification_allocated_blocks_post',
          message: `${invalidAllocationTarget.group.productName} — ${invalidAllocationTarget.group.variantName}: the selected reservation target must have a final Physical Count of at least ${formatNumber(required)}. Increase that target count or choose another counted configuration.`,
        })
        return
      }
      const classificationGate = evaluateClassificationPostable(flavours, liveLegacyByVariant)
      if (!classificationGate.ok) {
        setPreflight({
          status: 'error',
          code: classificationGate.code,
          message: classificationGate.message,
        })
        return
      }
    }
    try {
      const response = await fetch(`/api/inventory/stock-count/verification/preflight?sessionId=${encodeURIComponent(sessionId)}`)
      const result = await response.json()
      if (!response.ok || !result.ok) {
        setPreflight({ status: 'error', code: result.code, message: result.error, guidance: result.guidance })
        return
      }
      // Requirement C: the server recomputed the summary from the *persisted*
      // draft. If its signature differs from what is on screen, the saved draft
      // is stale relative to the review — block before a code can be issued.
      if (typeof result.persistedSignature === 'string' && result.persistedSignature !== currentSignature) {
        setPreflight({ status: 'error', code: 'unsaved_changes', message: UNSAVED_CHANGES_MESSAGE })
        return
      }
      if (result.authoritativeBaseCosts && typeof result.authoritativeBaseCosts === 'object') {
        setRows(current => current.map(row => Object.prototype.hasOwnProperty.call(result.authoritativeBaseCosts, row.variantId)
          ? { ...row, unitCost: normalizeBaseCost(result.authoritativeBaseCosts[row.variantId]) }
          : row))
      }
      setPreflight({ status: 'ready', recipientCount: result.recipientCount, guidance: result.guidance })
    } catch {
      const friendly = stockCountVerificationError('unexpected_error', { stage: 'preflight' })
      setPreflight({ status: 'error', code: friendly.code, message: friendly.message })
    }
  }

  const openPostReview = async () => {
    setConfirmPostOpen(true)
    setPreflight({ status: 'loading' })
    setVerificationError(null)
    // Block the misuse before persisting anything (runVerificationPreflight
    // repeats this guard for the Retry path; the DB is the final backstop).
    if (hasClassificationMisuse) {
      const names = Array.from(new Set(classificationMisuseRows.map(row => `${row.productName} — ${row.variantName}`))).slice(0, 5)
      setPreflight({
        status: 'error',
        code: 'classification_misuse',
        message: `${names.join('; ')}${classificationMisuseRows.length > names.length ? '; …' : ''} still ${names.length === 1 ? 'has' : 'have'} a Legacy/Unclassified balance. Use "Inventory Opening Balance & Initial Classification" for the official go-live count — a normal Full/Cycle/Spot count would add phantom stock on top of the unclassified balance.`,
      })
      return
    }
    const sessionId = await saveDraft()
    if (!sessionId) {
      setPreflight({ status: 'error', message: 'Save the Stock Count draft before requesting verification.' })
      return
    }
    await runVerificationPreflight(sessionId)
  }

  const retryVerificationPreflight = async () => {
    setPreflight({ status: 'loading' })
    const sessionId = await saveDraft({ silent: true })
    if (!sessionId) {
      setPreflight({ status: 'error', message: 'The latest Stock Count changes could not be saved. Please try again.' })
      return
    }
    await runVerificationPreflight(sessionId)
  }

  const handlePostingNoteChange = (value: string) => {
    setNotes(value)
    if (reviewVarianceItems === 0) return

    if (!isValidStockCountPostingNote(value)) {
      if (postingNoteRecheckTimerRef.current !== null) window.clearTimeout(postingNoteRecheckTimerRef.current)
      postingNoteRecheckTimerRef.current = null
      postingNoteRecheckPendingRef.current = false
      const friendly = stockCountVerificationError('posting_note_required')
      setPreflight({ status: 'error', code: friendly.code, message: friendly.message })
      return
    }

    if (preflight.code !== 'posting_note_required' && !postingNoteRecheckPendingRef.current) return

    // Clear the local validation error immediately, then persist the final
    // debounced value before asking the authoritative server to check again.
    setPreflight({ status: 'loading' })
    postingNoteRecheckPendingRef.current = true
    if (postingNoteRecheckTimerRef.current !== null) window.clearTimeout(postingNoteRecheckTimerRef.current)
    postingNoteRecheckTimerRef.current = window.setTimeout(async () => {
      postingNoteRecheckTimerRef.current = null
      postingNoteRecheckPendingRef.current = false
      const normalizedNote = normalizeStockCountPostingNote(value)
      setNotes(normalizedNote)
      const sessionId = await saveDraft({ noteOverride: normalizedNote, silent: true })
      if (!sessionId) {
        setPreflight({ status: 'error', message: 'The Posting Note could not be saved. Please try again.' })
        return
      }
      await runVerificationPreflight(sessionId)
    }, 350)
  }

  useEffect(() => {
    if (confirmPostOpen && !verification && !permissionLoading && preflight.status === 'loading' && currentSessionId) {
      void runVerificationPreflight(currentSessionId)
    }
    // Re-run only when the permission lookup finishes for an open review.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permissionLoading])

  const verifyAndPostCount = async () => {
    if (!verification || verificationCode.length !== 8 || posting) return
    // Defence in depth on top of the server snapshot-hash check: never submit a
    // code once the on-screen counts have moved away from what it was issued for.
    if (verificationStale) {
      setVerificationError('The counts changed after this code was requested. Request a new code before posting.')
      return
    }
    setPosting(true)
    setVerificationError(null)
    setPreflight({ status: 'idle' })
    try {
      const response = await fetch('/api/inventory/stock-count/verification/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: verification.requestId, sessionId: verification.sessionId, code: verificationCode }),
      })
      const result = await response.json()
      if (!response.ok) {
        const message = formatVerificationApiError(result, 'post')
        setVerificationError(message)
        // Clear the code only when it can never succeed again; keep typos editable.
        if (result.code === 'expired_code' || result.code === 'code_already_used' || result.code === 'already_posted' || result.code === 'invalid_or_expired_code') {
          setVerificationCode('')
        }
        return
      }
      setCurrentStatus('posted')
      setVerification(null)
      setVerifiedSignature(null)
      setVerificationCode('')
      setVerificationError(null)
      setConfirmPostOpen(false)
      setLastSavedSignature(EMPTY_SIGNATURE)
      toast({ title: 'Stock count posted', description: `${result.movement_count || 0} variance movement(s) recorded.` })
      await loadCountRows(selectedWarehouse)
      await loadDrafts(selectedWarehouse)
    } catch (error: any) {
      setVerificationError(error?.message || stockCountVerificationError('unexpected_error', { stage: 'post' }).message)
    } finally {
      setPosting(false)
    }
  }

  const closePostDialog = () => {
    if (postingNoteRecheckTimerRef.current !== null) window.clearTimeout(postingNoteRecheckTimerRef.current)
    postingNoteRecheckTimerRef.current = null
    postingNoteRecheckPendingRef.current = false
    setConfirmPostOpen(false)
    setVerification(null)
    setVerifiedSignature(null)
    setVerificationCode('')
    setVerificationError(null)
  }

  const summaryCards = [
    { label: 'Total Items', value: formatNumber(pageSummary.totalItems), sub: `Across ${Math.max(groups.length - 1, 0)} groups`, icon: Boxes, color: 'text-violet-600 bg-violet-50' },
    { label: 'Counted', value: formatNumber(pageSummary.counted), sub: `${pageSummary.totalItems ? Math.round((pageSummary.counted / pageSummary.totalItems) * 100) : 0}% of total`, icon: CheckCircle2, color: 'text-green-600 bg-green-50' },
    { label: 'Not Counted', value: formatNumber(pageSummary.notCounted), sub: `${pageSummary.totalItems ? Math.round((pageSummary.notCounted / pageSummary.totalItems) * 100) : 0}% remaining`, icon: CalendarDays, color: 'text-amber-600 bg-amber-50' },
    { label: 'Variance Items', value: formatNumber(pageSummary.varianceItems), sub: 'Items with variance', icon: AlertTriangle, color: 'text-red-600 bg-red-50' },
    { label: 'Net Adjustment', value: `${pageSummary.netAdjustment > 0 ? '+' : ''}${formatNumber(pageSummary.netAdjustment)}`, sub: 'Total units', icon: RotateCcw, color: 'text-[var(--sera-orange)] bg-[var(--sera-orange)]/[0.06]' },
    { label: 'Estimated Value', value: formatMoney(pageSummary.estimatedValue), sub: 'Based on variance', icon: FileSpreadsheet, color: 'text-purple-600 bg-purple-50' },
  ]
  const warehouseName = warehouseLocations.find(location => location.id === selectedWarehouse)?.org_name || '—'
  const currentDraftMetadata = drafts.find(draft => draft.id === currentSessionId)
  const expirySeconds = verification ? Math.max(0, Math.ceil((new Date(verification.expiresAt).getTime() - verificationNow) / 1000)) : 0
  const resendSeconds = verification ? Math.max(0, Math.ceil((new Date(verification.resendAvailableAt).getTime() - verificationNow) / 1000)) : 0
  const reviewCounted = isClassificationMode ? classificationSummary.completeFlavours : pageSummary.counted
  const reviewVarianceItems = isClassificationMode
    ? classificationSummary.perGroup.filter(entry => entry.complete && entry.variance !== 0).length
    : pageSummary.varianceItems
  const reviewNetAdjustment = isClassificationMode ? classificationSummary.netVariance : pageSummary.netAdjustment
  const reviewEstimatedValue = isClassificationMode ? classificationSummary.estimatedValue : pageSummary.estimatedValue
  const highImpact = Math.abs(reviewEstimatedValue) >= HIGH_IMPACT_VALUE_THRESHOLD || Math.abs(reviewNetAdjustment) >= 1000
  const openingCountsComplete = isOpeningBalanceMode
    && visibleRows.length > 0
    && visibleRows.every(row => parseCount(row.physicalCount) !== null)

  // Per-configuration breakdown shown in Review & Post so the exact lines that
  // will post (system → physical → variance for each configuration, plus the
  // Legacy/Unclassified source) are visible before OTP. A summary-only review
  // is what let the stale 50/50/50 hide behind a single "+150" in the incident.
  const reviewBreakdown = useMemo<ReviewBreakdownGroup[]>(() => {
    if (isClassificationMode) {
      // Only selected flavours appear — deferred (all-blank) flavours are not
      // part of this round and their Legacy balance is left untouched.
      return classificationSummary.selected.map(entry => ({
        kind: 'classification' as const,
        variantId: entry.group.variantId,
        heading: `${entry.group.productName} — ${entry.group.variantName}`,
        legacy: { label: entry.group.legacyRow.configLabel, system: entry.group.legacyRow.systemQuantity },
        lines: entry.group.targetRows.map(row => ({
          key: row.stockConfigId,
          label: row.configLabel,
          system: row.systemQuantity,
          physical: parseCount(row.physicalCount),
        })),
        targetTotal: entry.classifiedTotal,
        variance: entry.variance,
        complete: entry.complete,
      }))
    }
    const counted = draftRows.filter(row => parseCount(row.physicalCount) !== null)
    const byVariant = new Map<string, CountBreakdownGroup>()
    counted.forEach(row => {
      const group = byVariant.get(row.variantId)
        || { kind: 'count' as const, variantId: row.variantId, heading: `${row.productName} — ${row.variantName}`, lines: [] }
      group.lines.push({ key: row.stockConfigId, label: row.configLabel, system: row.systemQuantity, physical: parseCount(row.physicalCount) })
      byVariant.set(row.variantId, group)
    })
    return Array.from(byVariant.values())
  }, [isClassificationMode, classificationSummary, draftRows])

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm text-slate-500">
            <span>Supply Chain</span><ChevronRight className="h-4 w-4" /><span>Inventory</span><ChevronRight className="h-4 w-4" /><span className="font-medium text-slate-900">Stock Count</span>
          </div>
          <h1 className="text-3xl font-bold tracking-normal text-slate-950">Stock Count</h1>
          <p className="mt-1 text-sm text-slate-600">Count inventory faster with grouped variants and Excel bulk update.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {onViewChange && <Button variant="outline" onClick={() => onViewChange('inventory')}><ArrowLeft className="mr-2 h-4 w-4" /> Inventory</Button>}
          <Button
            variant="outline"
            onClick={downloadExcel}
            disabled={isOpeningBalanceReadOnly || (isClassificationMode ? classificationGroups.length === 0 : visibleRows.length === 0)}
          >
            <Download className="mr-2 h-4 w-4" /> Download Excel Template
          </Button>
          <Button variant="outline" disabled={isOpeningBalanceReadOnly || currentStatus === 'posted'} onClick={() => fileInputRef.current?.click()}><Upload className="mr-2 h-4 w-4" /> Import Updated Excel</Button>
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={event => {
            const file = event.target.files?.[0]
            if (file) importExcel(file)
            event.target.value = ''
          }} />
          {hasUnsavedChanges && currentStatus !== 'posted' && (
            <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">Unsaved changes</Badge>
          )}
          <Button variant={hasUnsavedChanges ? 'default' : 'outline'} onClick={() => void saveDraft()} disabled={!canSave || saving || openingDraftDetectionPending} className={hasUnsavedChanges && currentStatus !== 'posted' ? 'bg-amber-600 hover:bg-amber-700' : ''}><Save className="mr-2 h-4 w-4" /> {saving ? 'Saving...' : openingDraftDetectionPending ? 'Checking for existing draft…' : isOpeningBalanceMode && currentSessionId ? 'Update Draft' : 'Save Draft'}</Button>
          {!isOpeningBalanceMode && !isOpeningBalanceReadOnly && (
            <Button onClick={openPostReview} disabled={!canPost || currentStatus === 'posted' || saving} className="bg-orange-600 hover:bg-orange-700">Review & Post Count <ArrowRight className="ml-2 h-4 w-4" /></Button>
          )}
        </div>
      </div>

      {invalidWarehouseDrafts.length > 0 && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="p-4 text-sm text-red-900">
            <p className="font-semibold">Stock Count drafts blocked by invalid warehouse master data</p>
            <p className="mt-1">{ACTIVE_WAREHOUSE_REQUIRED_MESSAGE} These drafts remain unchanged and cannot be edited, exported, verified, or posted. Select an active warehouse and create a new draft.</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {invalidWarehouseDrafts.slice(0, 10).map(draft => (
                <li key={draft.id}>
                  {draft.reference_name || countTypeOptions.find(option => option.value === draft.count_type)?.label || 'Stock Count'} · {draft.count_date}
                  <span className="ml-1 text-xs">({warehouseLocations.find(location => location.id === draft.warehouse_organization_id)?.org_name || draft.warehouse_name || 'Warehouse unavailable'})</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {isOpeningBalanceMode && (
        <Card className="border-orange-200 bg-orange-50">
          <CardContent className="p-4 text-sm text-orange-950">
            <p className="font-semibold">One official pre-go-live workflow</p>
            <p className="mt-1">Count every eligible configuration, including 20NB, 50NB, 50OB and any visible Legacy / Unclassified balance. Save the draft, then continue below to review orders, freeze the warehouse, preview, request OTP and post atomically.</p>
            {selectedCategory && pageSummary.notCounted > 0 && (
              <p className="mt-2 font-semibold">Opening Balance is incomplete: {pageSummary.notCounted} of {pageSummary.totalItems} items have not been counted. You may save and continue later.</p>
            )}
          </CardContent>
        </Card>
      )}

      {mustContinueExistingOpeningDraft && existingOpeningDraft && (
        <Card className="border-blue-300 bg-blue-50">
          <CardContent className="flex flex-wrap items-start justify-between gap-3 p-4 text-sm text-blue-950">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
              <div>
                <p className="font-semibold">An Opening Balance draft already exists for this warehouse &amp; category</p>
                <p className="mt-1">Only one active Opening Balance draft is allowed per warehouse and category. Continue the existing draft instead of starting a second one — your earlier counts are preserved.</p>
                <p className="mt-2 font-medium">
                  {existingOpeningDraft.reference_name || 'Opening Balance Draft'}
                </p>
                <p className="mt-1 text-xs">
                  Created {formatOpeningBalanceDraftCreatedAt(existingOpeningDraft.created_at)}
                  {' · '}
                  Progress {formatOpeningBalanceDraftProgress(existingOpeningDraft)}
                </p>
              </div>
            </div>
            <Button size="sm" onClick={() => void loadDraft(existingOpeningDraft.id)}>Continue Existing Draft</Button>
          </CardContent>
        </Card>
      )}

      {isLegacyInitialReadOnly && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="flex items-start gap-3 p-4 text-sm text-amber-950">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div><p className="font-semibold">Legacy Initial Classification — read only</p><p className="mt-1">This historical draft remains viewable but cannot be edited, imported, converted or posted. Start a new Inventory Opening Balance &amp; Initial Classification draft instead.</p></div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-6">
          <div>
            <label className="mb-2 block text-sm font-semibold text-slate-700">
              {isClassificationMode ? 'Inventory Organization' : 'Warehouse Location'} <span className="text-red-500">*</span>
            </label>
            <Select value={selectedWarehouse} disabled={Boolean(currentSessionId)} onValueChange={setSelectedWarehouse}>
              <SelectTrigger><SelectValue placeholder={isClassificationMode ? 'Select inventory organization' : 'Select warehouse'} /></SelectTrigger>
              <SelectContent>{locationOptions.map(loc => <SelectItem key={loc.id} value={loc.id}>{loc.org_name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <label className="mb-2 block text-sm font-semibold text-slate-700">Count Date <span className="text-red-500">*</span></label>
            <Input type="date" max={todayIso()} disabled={isOpeningBalanceReadOnly || currentStatus === 'posted'} value={countDate} onChange={event => setCountDate(event.target.value)} />
          </div>
          <div>
            <label className="mb-2 block text-sm font-semibold text-slate-700">Count Type <span className="text-red-500">*</span></label>
            <Select value={countType} disabled={Boolean(currentSessionId)} onValueChange={value => {
              setCountType(value as CountType)
              if (value !== 'opening_balance_cutoff') setSelectedCategory('')
              // History filter follows the new type; drop any Manage Drafts
              // selection so it can never act on a now-hidden count type.
              setSelectedDraftIds(new Set())
            }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(isLegacyInitialReadOnly ? countTypeOptions : countTypeCreationOptions).map(option => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    disabled={option.value === 'opening_balance_cutoff' && openingBalancePosted}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {openingBalancePosted && !isLegacyInitialReadOnly && <p className="mt-1 text-xs text-slate-500">Opening Balance is already posted for this warehouse/category; use a normal count.</p>}
          </div>
          <div>
            <label className="mb-2 block text-sm font-semibold text-slate-700">
              Product Category {isOpeningBalanceMode && <span className="text-red-500">*</span>}
            </label>
            <Select
              value={isOpeningBalanceMode ? selectedCategory : (selectedCategory || ALL_CATEGORIES_VALUE)}
              disabled={isOpeningBalanceReadOnly || currentStatus === 'posted' || (isOpeningBalanceMode && openingCategoryLocked)}
              onValueChange={value => setSelectedCategory(value === ALL_CATEGORIES_VALUE ? '' : value)}
            >
              <SelectTrigger><SelectValue placeholder={isOpeningBalanceMode ? 'Select active category' : 'All Categories'} /></SelectTrigger>
              <SelectContent>
                {!isOpeningBalanceMode && <SelectItem value={ALL_CATEGORIES_VALUE}>All Categories</SelectItem>}
                {productCategories.map(category => (
                  <SelectItem key={category.id} value={category.id}>{category.category_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isOpeningBalanceMode && !selectedCategory && <p className="mt-1 text-xs text-amber-700">Select a category to create the draft scope.</p>}
            {isOpeningBalanceMode && openingCategoryLocked && <p className="mt-1 text-xs text-slate-500">Category is locked after counting starts. Start a new count to choose another category.</p>}
            {!isOpeningBalanceMode && <p className="mt-1 text-xs text-slate-500">Scopes items, group tabs, totals and Excel to this category. Group tabs are secondary filters within it.</p>}
          </div>
          <div className="xl:col-span-1">
            <label className="mb-2 block text-sm font-semibold text-slate-700">
              Reference / Batch Name <span className="text-red-500">*</span>
            </label>
            <Input
              ref={referenceInputRef}
              value={referenceName}
              disabled={isOpeningBalanceReadOnly || currentStatus === 'posted'}
              maxLength={STOCK_COUNT_REFERENCE_MAX_LENGTH}
              aria-invalid={Boolean(referenceError)}
              className={referenceError ? 'border-red-400 focus-visible:ring-red-400' : undefined}
              onChange={event => {
                setReferenceName(event.target.value)
                if (referenceError && validateStockCountReference(event.target.value).valid) setReferenceError(null)
              }}
              placeholder="e.g. Monthly Count"
            />
            {referenceError && <p className="mt-1 text-xs text-red-600">{referenceError}</p>}
            {currentStatus === 'posted' && isStockCountReferenceMissing(referenceName) && (
              <p className="mt-1 text-xs text-slate-500">{STOCK_COUNT_REFERENCE_LEGACY_PLACEHOLDER}</p>
            )}
          </div>
          <div className="xl:col-span-1">
            <label className="mb-2 block text-sm font-semibold text-slate-700">Notes (Optional)</label>
            <Input value={notes} disabled={isOpeningBalanceReadOnly || currentStatus === 'posted'} onChange={event => setNotes(event.target.value)} placeholder="Add notes..." />
          </div>
        </CardContent>
      </Card>

      {selectedWarehouse && (
        <Card className="border-blue-100 bg-[var(--sera-orange)]/[0.06]/50">
          <CardContent className="space-y-3 p-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-semibold text-blue-950">Count Type History</span>
              <Badge variant="outline" className="border-orange-300 text-orange-700">{countTypeHistoryLabel}</Badge>
              {!managingDrafts ? (
                <Button variant="outline" size="sm" disabled={countTypeDrafts.length === 0} onClick={() => { setManagingDrafts(true); setSelectedDraftIds(new Set()) }}>
                  Manage Drafts
                </Button>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" onClick={selectAllDrafts} disabled={discardingDrafts || !countTypeDrafts.some(draft => draft.deletable)}>
                    Select All
                  </Button>
                  <Button variant="outline" size="sm" onClick={deselectAllDrafts} disabled={discardingDrafts || selectedDraftIds.size === 0}>
                    Deselect All
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => requestDiscardDrafts([...selectedDraftIds])}
                    disabled={discardingDrafts || selectedDraftIds.size === 0}
                  >
                    {discardingDrafts ? 'Discarding...' : 'Discard Selected Drafts'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={exitManageDrafts} disabled={discardingDrafts}>
                    Cancel
                  </Button>
                  <span className="text-xs text-slate-500">
                    {countTypeDrafts.filter(draft => draft.deletable).length} removable ·{' '}
                    {countTypeDrafts.filter(draft => !draft.deletable).length} protected
                  </span>
                </div>
              )}
            </div>
            {!managingDrafts ? <div className="flex flex-wrap items-center gap-2">
              {countTypeDrafts.length === 0 && (
                <span className="text-sm text-slate-500">{stockCountHistoryEmptyMessage(countType)}</span>
              )}
              {countTypeDrafts.map(draft => (
                <div key={draft.id} className="flex items-center gap-1">
                  <Button
                    variant={currentSessionId === draft.id ? 'default' : staleDraftIds.has(draft.id) ? 'destructive' : 'outline'}
                    size="sm"
                    disabled={discardingDrafts}
                    onClick={() => {
                      void loadDraft(draft.id)
                    }}
                  >
                    {draftLabel(draft)}
                  </Button>
                  {!managingDrafts && draft.deletable && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-8 w-8 px-0" aria-label={`Draft actions for ${draftLabel(draft)}`}>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        <DropdownMenuItem onClick={() => void loadDraft(draft.id)}>Open Draft</DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-red-700 focus:text-red-700"
                          onClick={() => requestDiscardDrafts([draft.id])}
                        >
                          Discard Draft
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              ))}
              <Button variant="ghost" size="sm" onClick={resetSession} disabled={discardingDrafts}>New count</Button>
            </div> : (
              <div className="overflow-x-auto rounded-lg border bg-white">
                <Table>
                  <TableHeader><TableRow>
                    <TableHead className="w-10">Select</TableHead><TableHead>Batch / draft</TableHead>
                    <TableHead>Warehouse</TableHead><TableHead>Category</TableHead><TableHead>Count type</TableHead>
                    <TableHead>Progress</TableHead><TableHead>Status</TableHead><TableHead>Created</TableHead>
                    <TableHead>Last updated</TableHead><TableHead>Created by</TableHead><TableHead>Open</TableHead>
                  </TableRow></TableHeader>
                  <TableBody>
                    {countTypeDrafts.length === 0 && (
                      <TableRow><TableCell colSpan={11} className="text-center text-sm text-slate-500">{stockCountHistoryEmptyMessage(countType)}</TableCell></TableRow>
                    )}
                    {countTypeDrafts.map(draft => {
                      const total = draft.scope_count || 0
                      const counted = draft.counted_count || 0
                      const legacyReset = isLegacyResetRequiredDraft(draft)
                      const statusBadge = legacyReset
                        ? LEGACY_RESET_REQUIRED_LABEL
                        : (draft.history_badge || (draft.deletable ? 'Draft — Removable' : 'Protected'))
                      const statusDetail = legacyReset
                        ? 'Legacy draft must be discarded before a new category-scoped count can continue.'
                        : (draft.history_detail || draft.protection_reason)
                      return <TableRow key={draft.id} className={draft.deletable ? undefined : 'bg-slate-50'}>
                        <TableCell><Checkbox checked={selectedDraftIds.has(draft.id)} disabled={discardingDrafts || !draft.deletable} onCheckedChange={checked => toggleDraftSelection(draft.id, checked === true)} aria-label={draft.deletable ? `Select ${draftLabel(draft)}` : `${draftLabel(draft)} is protected and cannot be discarded`} /></TableCell>
                        <TableCell className="font-medium">{draft.reference_name || 'Unnamed draft'}</TableCell>
                        <TableCell>{draft.warehouse_name}</TableCell><TableCell>{draft.category_name}</TableCell>
                        <TableCell>{countTypeOptions.find(option => option.value === draft.count_type)?.label}</TableCell>
                        <TableCell>{counted}/{total}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={!draft.deletable ? 'border-slate-300 text-slate-600' : legacyReset ? 'border-red-300 text-red-700' : 'border-emerald-300 text-emerald-700'}>{statusBadge}</Badge>
                          {statusDetail && (
                            <span className="mt-1 block text-xs text-slate-500">{statusDetail}</span>
                          )}
                        </TableCell>
                        <TableCell>{new Date(draft.created_at).toLocaleString()}</TableCell>
                        <TableCell>{draft.updated_at ? new Date(draft.updated_at).toLocaleString() : '—'}</TableCell>
                        <TableCell>{draft.created_by_name}</TableCell>
                        <TableCell><Button variant="outline" size="sm" onClick={() => void loadDraft(draft.id)}>Open</Button></TableCell>
                      </TableRow>
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {!isClassificationMode && (
        <>
        {isOpeningBalanceMode && selectedCategory && (
          <Card className="border-orange-200">
            <CardContent className="grid gap-3 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div><span className="text-slate-500">Warehouse</span><strong className="block">{warehouseName}</strong></div>
              <div><span className="text-slate-500">Category</span><strong className="block">{selectedCategoryName}</strong></div>
              <div><span className="text-slate-500">Count type</span><strong className="block">Opening Balance &amp; Initial Classification</strong></div>
              <div><span className="text-slate-500">Progress</span><strong className="block">{pageSummary.counted}/{pageSummary.totalItems} ({pageSummary.totalItems ? Math.round(pageSummary.counted / pageSummary.totalItems * 100) : 0}%)</strong></div>
              <div><span className="text-slate-500">Total in scope</span><strong className="block">{pageSummary.totalItems}</strong></div>
              <div><span className="text-slate-500">Counted</span><strong className="block">{pageSummary.counted}</strong></div>
              <div><span className="text-slate-500">Not counted</span><strong className="block">{pageSummary.notCounted}</strong></div>
              <div><span className="text-slate-500">Draft dates</span><strong className="block">{currentDraftMetadata ? `Created ${new Date(currentDraftMetadata.created_at).toLocaleString()} · Updated ${currentDraftMetadata.updated_at ? new Date(currentDraftMetadata.updated_at).toLocaleString() : '—'}` : 'Not created yet'}</strong></div>
            </CardContent>
          </Card>
        )}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
          {summaryCards.map(card => <Card key={card.label}><CardContent className="flex items-center gap-4 p-4"><div className={`flex h-12 w-12 items-center justify-center rounded-lg ${card.color}`}><card.icon className="h-6 w-6" /></div><div className="min-w-0"><p className="text-sm font-semibold text-slate-600">{card.label}</p><p className="truncate text-xl font-bold text-slate-950">{card.value}</p><p className="text-xs text-slate-500">{card.sub}</p></div></CardContent></Card>)}
        </div>
        </>
      )}

      {hasClassificationMisuse && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="flex items-start gap-3 p-4 text-sm text-red-900">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="font-semibold">This looks like a classification, not a {countTypeOptions.find(option => option.value === countType)?.label}.</p>
              <p className="mt-1">{classificationMisuseRows.length} configuration count{classificationMisuseRows.length === 1 ? '' : 's'} target a 20ml/50ml box for a variant that still holds a Legacy/Unclassified balance. Use <strong>Inventory Opening Balance &amp; Initial Classification</strong> for the official go-live baseline. Posting this as a normal count is blocked.</p>
            </div>
          </CardContent>
        </Card>
      )}

      {hasConfigEligibilityViolation && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="flex items-start gap-3 p-4 text-sm text-red-900">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="font-semibold">Invalid configuration for this product group</p>
              <p className="mt-1">{configEligibilityViolations.length} counted configuration{configEligibilityViolations.length === 1 ? '' : 's'} are not valid for their product group (for example a 20mg/50mg concentration configuration on a Device group). Remove these counts before saving or posting. {configEligibilityViolations[0]?.message}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {isClassificationMode && (
        <div className="grid gap-4 md:grid-cols-4">
          <Card><CardContent className="p-4"><p className="text-sm font-semibold text-slate-600">Flavours with Legacy balance</p><p className="text-xl font-bold text-slate-950">{formatNumber(classificationSummary.totalFlavours)}</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-sm font-semibold text-slate-600">Selected this round</p><p className="text-xl font-bold text-slate-950">{formatNumber(classificationSummary.selectedFlavours)}</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-sm font-semibold text-emerald-700">Fully classified (selected)</p><p className="text-xl font-bold text-emerald-700">{formatNumber(classificationSummary.completeFlavours)}</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-sm font-semibold text-slate-500">Deferred (blank)</p><p className="text-xl font-bold text-slate-500">{formatNumber(classificationSummary.deferredFlavours)}</p></CardContent></Card>
        </div>
      )}

      {!isClassificationMode && (
        <Card>
          <CardContent className="space-y-4 p-4">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="flex flex-wrap gap-2">
                {groups.map(group => <Button key={group.id} variant={selectedGroupId === group.id ? 'default' : 'outline'} onClick={() => setSelectedGroupId(group.id)} className={selectedGroupId === group.id ? 'bg-orange-600 hover:bg-orange-700' : ''}>{group.name} ({group.count})</Button>)}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="relative"><Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" /><Input className="w-72 pl-9" value={searchTerm} onChange={event => setSearchTerm(event.target.value)} placeholder={selectedGroupId === ALL_GROUP_ID ? 'Search all variants...' : 'Search variants in this group...'} /></div>
                <div className="flex items-center gap-2"><Switch checked={showVarianceOnly} onCheckedChange={setShowVarianceOnly} /><span className="text-sm font-semibold text-slate-700">Show Variance Only</span></div>
                {isOpeningBalanceMode && <div className="flex items-center gap-2"><Switch checked={showNotCountedOnly} onCheckedChange={setShowNotCountedOnly} /><span className="text-sm font-semibold text-slate-700">Not Counted</span></div>}
                {!isOpeningBalanceMode && <div className="flex items-center gap-2"><Switch checked={showInactive} onCheckedChange={setShowInactive} /><span className="text-sm font-semibold text-slate-700">Show inactive</span></div>}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button variant="outline"><Columns3 className="mr-2 h-4 w-4" /> Columns</Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {Object.entries({ unitCost: 'Unit Cost', adjustmentValue: 'Adjustment Value', note: 'Note / Status' }).map(([key, label]) => (
                      <DropdownMenuItem key={key} onClick={() => setVisibleColumns(prev => ({ ...prev, [key]: !prev[key as keyof typeof prev] }))}><Checkbox className="mr-2" checked={visibleColumns[key as keyof typeof visibleColumns]} readOnly /> {label}</DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            <div className="rounded-lg border">
              <button type="button" className="flex w-full items-center justify-between gap-4 p-4 text-left" onClick={() => setGroupExpanded(!groupExpanded)}>
                <div className="flex items-center gap-4">
                  <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-lg bg-slate-100">{selectedGroup?.logoUrl ? <img src={getStorageUrl(selectedGroup.logoUrl) || selectedGroup.logoUrl} alt="" className="h-full w-full object-cover" /> : <Package className="h-8 w-8 text-slate-400" />}</div>
                  <div><div className="flex items-center gap-2"><h2 className="text-xl font-bold text-slate-950">{selectedGroup?.name || 'All'}</h2><Badge variant="outline">{groupSummary.variants} configurations</Badge></div><p className="text-sm text-slate-500">{selectedGroup?.description || (selectedGroupId === ALL_GROUP_ID ? 'Configuration-aware inventory balances in the selected warehouse.' : 'Stock configurations in this product group.')}</p></div>
                </div>
                <div className="hidden flex-1 grid-cols-3 divide-x text-center md:grid">
                  <div><p className="text-xs font-semibold text-slate-500">System Qty (Total)</p><p className="text-lg font-bold">{formatNumber(groupSummary.systemTotal)}</p></div>
                  <div><p className="text-xs font-semibold text-slate-500">Counted (Total)</p><p className="text-lg font-bold">{formatNumber(groupSummary.countedTotal)}</p></div>
                  <div><p className="text-xs font-semibold text-slate-500">Variance (Total)</p><p className={`text-lg font-bold ${groupSummary.varianceTotal > 0 ? 'text-green-600' : groupSummary.varianceTotal < 0 ? 'text-red-600' : 'text-slate-700'}`}>{groupSummary.varianceTotal > 0 ? '+' : ''}{formatNumber(groupSummary.varianceTotal)}</p></div>
                </div>
                <ChevronDown className={`h-5 w-5 transition ${groupExpanded ? '' : '-rotate-90'}`} />
              </button>

              {groupExpanded && (
                <div className="overflow-x-auto border-t">
                  <Table>
                    <TableHeader><TableRow><TableHead className="min-w-[320px]">{showConfiguration ? 'Variant / Stock Configuration' : 'Variant'}</TableHead><TableHead className="text-right">System Quantity</TableHead><TableHead className="min-w-[240px]">Physical Count</TableHead><TableHead className="text-right">Variance</TableHead>{visibleColumns.unitCost && <TableHead className="text-right">Unit Cost</TableHead>}{visibleColumns.adjustmentValue && <TableHead className="text-right">Adjustment Value</TableHead>}{visibleColumns.note && <TableHead className="min-w-[240px]">Note / Status</TableHead>}</TableRow></TableHeader>
                    <TableBody>
                      {loadingRows && <TableRow><TableCell colSpan={7} className="py-8 text-center text-slate-500">Loading inventory configurations...</TableCell></TableRow>}
                      {!loadingRows && selectedGroupRows.length === 0 && <TableRow><TableCell colSpan={7} className="py-8 text-center text-slate-500">No variants match this view.</TableCell></TableRow>}
                      {selectedGroupRows.map(row => {
                        const variance = varianceForRow(row)
                        const adjustmentValue = adjustmentValueForRow(row)
                        return (
                          <TableRow key={row.stockConfigId}>
                            <TableCell><div className="flex items-center gap-3"><div className="flex h-11 w-11 items-center justify-center overflow-hidden rounded bg-slate-100">{row.imageUrl ? <img src={getStorageUrl(row.imageUrl) || row.imageUrl} alt="" className="h-full w-full object-cover" /> : <Package className="h-5 w-5 text-slate-400" />}</div><div><p className="font-semibold text-slate-950">{row.variantName}</p><div className="mt-1 flex flex-wrap items-center gap-1.5">{showConfiguration && <Badge variant={row.configStatus === 'active' ? 'secondary' : 'outline'}>{withStockStrengthUnit(row.configLabel)}</Badge>}{!row.variantIsActive && <Badge variant="outline" className="border-amber-300 text-amber-700" title="Archived variant — historical snapshot item">Archived variant · historical</Badge>}{row.variantIsActive && (!row.productIsActive || row.configStatus !== 'active') && <Badge variant="outline" className="border-amber-300 text-amber-700" title="Inactive master data — historical snapshot item">Historical configuration</Badge>}{row.productCode && <span className="text-xs text-slate-500">{row.productCode}</span>}</div><p className="text-xs text-slate-500">{row.productName}</p></div></div></TableCell>
                            <TableCell className="text-right font-medium tabular-nums">{formatNumber(row.systemQuantity)}{row.piecesPerCase && <p className="text-xs font-normal text-slate-500">{formatPiecesAsCases(row.systemQuantity, row.piecesPerCase)}</p>}</TableCell>
                            <TableCell><StockCountQuantityInput countInputId={row.stockConfigId} value={row.physicalCount} piecesPerCase={row.piecesPerCase} disabled={currentStatus === 'posted' || isOpeningBalanceReadOnly} onChange={value => handlePhysicalCountChange(row.stockConfigId, value)} onEnter={() => focusNextCountInput(row.stockConfigId)} /></TableCell>
                            <TableCell className={`text-right font-bold tabular-nums ${variance === null || variance === 0 ? 'text-slate-600' : variance > 0 ? 'text-green-600' : 'text-red-600'}`}>{variance === null ? 'Not counted' : `${variance > 0 ? '+' : ''}${formatNumber(variance)}`}{variance !== null && variance !== 0 && row.piecesPerCase && <p className="text-xs font-normal">{variance > 0 ? '+' : ''}{formatPiecesAsCases(variance, row.piecesPerCase)}</p>}</TableCell>
                            {visibleColumns.unitCost && <TableCell className="text-right tabular-nums">{row.unitCost === null ? '—' : formatMoney(row.unitCost)}</TableCell>}
                            {visibleColumns.adjustmentValue && <TableCell className={`text-right font-semibold tabular-nums ${!adjustmentValue ? 'text-slate-600' : adjustmentValue > 0 ? 'text-green-600' : 'text-red-600'}`}>{adjustmentValue === null ? '-' : formatMoney(adjustmentValue)}</TableCell>}
                            {visibleColumns.note && <TableCell><div className="flex items-center gap-2"><MessageSquare className="h-4 w-4 text-slate-400" /><Input value={row.note} disabled={currentStatus === 'posted' || isOpeningBalanceReadOnly} onChange={event => updateRow(row.stockConfigId, { note: event.target.value })} placeholder={variance === null ? 'Not counted' : variance === 0 ? 'Matched' : 'Add note'} /></div></TableCell>}
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {isClassificationMode && (
        <div className="space-y-4">
          {classificationSummary.perGroup.length === 0 && (
            <Card><CardContent className="p-8 text-center text-sm text-slate-500">No flavour at this warehouse has a Legacy/Unclassified balance to classify.</CardContent></Card>
          )}
          {classificationSummary.perGroup.map(({ group, complete, selected, cardDisplay }) => (
            <Card key={group.variantId} className={selected ? '' : 'opacity-70'}>
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-semibold text-slate-950">{group.productName} — {group.variantName}</h3>
                    <p className="text-xs text-slate-500">Enter the actual physical opening balance by box configuration. The final total may be above or below Legacy; the difference is posted as an approved stock-count variance.</p>
                  </div>
                  {!selected
                    ? <Badge variant="outline" className="border-slate-300 text-slate-500">Deferred — not this round</Badge>
                    : complete
                      ? <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Selected · Complete</Badge>
                      : <Badge variant="outline" className="border-amber-300 text-amber-800">Selected · Incomplete</Badge>}
                </div>

                {!selected && (
                  <div className="flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
                    <span>All three target counts are blank, so this flavour is deferred to a later round. Its Legacy balance is left untouched. Enter counts to include it now.</span>
                  </div>
                )}

                {group.legacyRow.quantityAllocated > 0 && (
                  <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>
                        Legacy contains {group.legacyRow.quantityAllocated} reserved{' '}
                        {group.legacyRow.quantityAllocated === 1 ? 'unit' : 'units'} from an active order.
                        Choose which counted configuration will inherit the reservation. The reservation is moved only after OTP approval, in the same transaction as this physical count; it is never silently released.
                      </span>
                    </div>
                    <div className="grid gap-1.5 sm:max-w-md">
                      <span className="font-semibold">Reservation target configuration</span>
                      <Select
                        value={allocationTargets[group.variantId] || ''}
                        disabled={currentStatus === 'posted' || isOpeningBalanceReadOnly}
                        onValueChange={(targetStockConfigId) => {
                          invalidatePendingVerification()
                          setAllocationTargets(prev => ({ ...prev, [group.variantId]: targetStockConfigId }))
                        }}
                      >
                        <SelectTrigger className="bg-white">
                          <SelectValue placeholder="Select a counted target…" />
                        </SelectTrigger>
                        <SelectContent>
                          {group.targetRows.map((row) => {
                            const physical = parseCount(row.physicalCount)
                            const required = row.quantityAllocated + group.legacyRow.quantityAllocated
                            const lifecycleAllowsReservation = row.configStatus === 'active'
                            const eligible = lifecycleAllowsReservation && physical !== null && physical >= required
                            return (
                              <SelectItem key={row.stockConfigId} value={row.stockConfigId} disabled={!eligible}>
                                {withStockStrengthUnit(row.configLabel)} {eligible
                                  ? `(final ${formatNumber(physical!)})`
                                  : !lifecycleAllowsReservation
                                    ? '(not available for an active order reservation)'
                                    : `(enter at least ${formatNumber(required)})`}
                              </SelectItem>
                            )
                          })}
                        </SelectContent>
                      </Select>
                      {allocationTargets[group.variantId] && (
                        <span className="text-emerald-800">
                          Ready to carry the reservation atomically. If the owning order changed, server verification will stop and identify it before posting.
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {selected && !complete && (
                  <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>Enter a physical count for all three target configurations before this flavour can be posted, or clear all three to defer it.</span>
                  </div>
                )}

                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader><TableRow><TableHead className="min-w-[180px]">Configuration</TableHead><TableHead className="min-w-[170px]">Row Type</TableHead><TableHead className="text-right">System Quantity</TableHead><TableHead className="min-w-[240px]">Physical Count</TableHead></TableRow></TableHeader>
                    <TableBody>
                      <TableRow className="bg-slate-50">
                        <TableCell><Badge variant="outline">{withStockStrengthUnit(group.legacyRow.configLabel)}</Badge><p className="mt-1 text-xs text-slate-500">To be classified</p></TableCell>
                        <TableCell><Badge variant="outline" className="border-slate-300 text-slate-600">Legacy Source — Read Only</Badge></TableCell>
                        <TableCell className="text-right font-medium tabular-nums">{formatNumber(group.legacyRow.systemQuantity)}</TableCell>
                        <TableCell>
                          <div className="relative">
                            <Input value="0" disabled className="w-36 bg-slate-100 font-semibold tabular-nums italic text-slate-400" />
                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-medium text-slate-400">Do not enter</span>
                          </div>
                        </TableCell>
                      </TableRow>
                      {group.targetRows.map(row => (
                        <TableRow key={row.stockConfigId}>
                          <TableCell><Badge variant="secondary">{withStockStrengthUnit(row.configLabel)}</Badge></TableCell>
                          <TableCell><Badge className="bg-[var(--sera-orange)]/[0.06] text-blue-700 hover:bg-[var(--sera-orange)]/[0.06]">Target Configuration</Badge></TableCell>
                          <TableCell className="text-right font-medium tabular-nums">{formatNumber(row.systemQuantity)}</TableCell>
                          <TableCell><StockCountQuantityInput value={row.physicalCount} piecesPerCase={row.piecesPerCase} disabled={currentStatus === 'posted' || isOpeningBalanceReadOnly} onChange={value => handlePhysicalCountChange(row.stockConfigId, value)} /></TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <div className="grid grid-cols-4 divide-x rounded-lg border bg-slate-50 text-center">
                  <div className="p-2"><p className="text-xs font-semibold text-slate-500">Legacy System Qty</p><p className="text-lg font-bold">{formatNumber(group.legacyRow.systemQuantity)}</p></div>
                  <div className="p-2"><p className="text-xs font-semibold text-slate-500">Total Target Physical Count</p><p className="text-lg font-bold">{cardDisplay.totalTargetPhysicalCount === null ? '—' : formatNumber(cardDisplay.totalTargetPhysicalCount)}</p></div>
                  <div className="p-2"><p className="text-xs font-semibold text-slate-500">Variance</p><p className={`text-lg font-bold ${cardDisplay.variance === null || cardDisplay.variance === 0 ? 'text-slate-700' : cardDisplay.variance > 0 ? 'text-green-600' : 'text-red-600'}`}>{cardDisplay.variance === null ? '—' : `${cardDisplay.variance > 0 ? '+' : ''}${formatNumber(cardDisplay.variance)}`}</p></div>
                  <div className="p-2"><p className="text-xs font-semibold text-slate-500">Completion Status</p><p className={`text-lg font-bold ${complete ? 'text-emerald-600' : selected ? 'text-amber-600' : 'text-slate-500'}`}>{cardDisplay.completionStatus}</p></div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {isOpeningBalanceMode && (
        <InventoryOpeningCutoffSection
          userProfile={userProfile}
          sessionId={currentSessionId}
          warehouseOrganizationId={selectedWarehouse}
          warehouseName={warehouseName}
          draftReference={referenceName.trim() || (countDate ? `OB-${countDate.replace(/-/g, '')}` : 'Opening Balance Draft')}
          productCategoryId={selectedCategory}
          productCategoryName={selectedCategoryName}
          countsReady={openingCountsComplete && !hasUnsavedChanges}
          savedDraftSignature={lastSavedSignature}
          openingBalancePosted={openingBalancePosted}
          activeDraft={(() => {
            const draft = resolveActiveOpeningBalanceDraft(
              criteriaDrafts,
              selectedWarehouse,
              selectedCategory,
              currentSessionId,
            )
            if (!draft) return null
            return {
              sessionId: draft.id,
              referenceName: draft.reference_name || 'Opening Balance Draft',
              createdAt: draft.created_at,
              progressLabel: formatOpeningBalanceDraftProgress(draft),
            }
          })()}
          onReturnToActiveDraft={(sessionId) => {
            void loadDraft(sessionId)
          }}
          onCreateNewOpeningBalance={async () => {
            const stuckCancelledSessionId = (
              currentSessionId
              && currentStatus === 'draft'
              && currentDraftCutoffStatus === 'cancelled'
            ) ? currentSessionId : null
            resetSession()
            if (stuckCancelledSessionId) {
              // Pre-migration / stuck draft+cancelled still occupies the one-active
              // draft slot. Soft-discard it so Create New can insert a new session.
              const { error } = await supabase.rpc('discard_stock_count_drafts' as any, {
                p_session_ids: [stuckCancelledSessionId],
              })
              if (error) {
                toast({
                  title: 'Could not clear cancelled draft',
                  description: discardErrorMessage(String(error.message || '')),
                  variant: 'destructive',
                })
              }
              await loadDrafts(selectedWarehouse)
            }
          }}
          onCancelled={async () => {
            // Keep the cancelled session mounted so the Opening Balance section can
            // render its read-only "Opening Balance cancelled" confirmation and the
            // View Cancelled Exercise / Create New choices — never a blank page.
            // Refresh the draft list so the archived session leaves the resumable
            // list; the user leaves this view explicitly via Create New.
            await loadDrafts(selectedWarehouse)
          }}
          onPosted={async () => {
            setCurrentStatus('posted')
            setLastSavedSignature(EMPTY_SIGNATURE)
            await loadCountRows(selectedWarehouse)
            await loadDrafts(selectedWarehouse)
            await loadPostedOpeningCategories(selectedWarehouse)
          }}
        />
      )}

      {importSummary && <Card className="border-slate-200"><CardHeader><CardTitle>Import Summary</CardTitle></CardHeader><CardContent><div className="mb-3 flex flex-wrap gap-2"><Badge className="bg-green-600">Updated {importSummary.updated}</Badge><Badge variant="secondary">Unchanged {importSummary.unchanged}</Badge><Badge variant="destructive">Failed {importSummary.failed}</Badge></div>{importSummary.rows.filter(row => row.status === 'Failed').slice(0, 6).map(row => <p key={`${row.row}-${row.sku}`} className="text-sm text-red-600">Row {row.row}: {row.sku} - {row.message}</p>)}</CardContent></Card>}

      <AlertDialog
        open={discardConfirmIds !== null}
        onOpenChange={(open) => {
          if (!discardingDrafts && !open) setDiscardConfirmIds(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {(discardConfirmIds?.length || 0) === 1
                ? `Discard '${drafts.find(item => item.id === discardConfirmIds?.[0])?.reference_name || 'Unnamed draft'}'?`
                : 'Discard selected drafts?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {(discardConfirmIds || []).some(id => drafts.find(item => item.id === id)?.count_type === 'opening_balance_cutoff')
                ? OPENING_BALANCE_DISCARD_CONFIRMATION
                : DISCARD_DRAFT_CONFIRMATION}
              <span className="mt-3 block font-medium text-slate-900">
                {discardConfirmIds?.length || 0} removable draft{(discardConfirmIds?.length || 0) === 1 ? '' : 's'} will be removed. Protected history is never included.
              </span>
              <span className="mt-2 block font-medium text-slate-900">Exact targets:</span>
              {(discardConfirmIds || []).map(id => {
                const draft = drafts.find(item => item.id === id)
                const countTypeLabel = countTypeOptions.find(option => option.value === draft?.count_type)?.label || draft?.count_type || 'Stock Count'
                return <span key={id} className="block">• {draft ? `${draft.reference_name || 'Unnamed draft'} — ${draft.warehouse_name} — ${draft.category_name} — ${countTypeLabel}` : id}</span>
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={discardingDrafts}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={discardingDrafts || !discardConfirmIds?.length}
              className="bg-red-600 hover:bg-red-700"
              onClick={(event) => {
                event.preventDefault()
                if (discardConfirmIds?.length) void discardDrafts(discardConfirmIds)
              }}
            >
              {discardingDrafts ? 'Discarding...' : 'Discard Drafts'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={confirmPostOpen} onOpenChange={(open) => open ? setConfirmPostOpen(true) : closePostDialog()}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{verification ? 'Verify Stock Count Posting' : 'Review & Post Count'}</DialogTitle>
            <DialogDescription>{verification ? 'Inventory remains unchanged until the code is verified.' : 'Review the complete posting context before requesting approval.'}</DialogDescription>
          </DialogHeader>
          {!verification ? <>
            <div className="grid gap-x-8 gap-y-3 rounded-lg border bg-slate-50 p-4 text-sm sm:grid-cols-2">
              <div><span className="text-slate-500">Warehouse</span><strong className="block text-slate-900">{warehouseName}</strong></div>
              <div><span className="text-slate-500">Count date</span><strong className="block text-slate-900">{countDate}</strong></div>
              <div><span className="text-slate-500">Count type</span><strong className="block text-slate-900">{countTypeOptions.find(option => option.value === countType)?.label}</strong></div>
              <div><span className="text-slate-500">Reference / batch</span><strong className="block text-slate-900">{referenceName || '—'}</strong></div>
              {isClassificationMode && (
                <>
                  <div className="flex justify-between sm:col-span-2"><span>Selected this round</span><strong>{formatNumber(classificationSummary.selectedFlavours)} flavour{classificationSummary.selectedFlavours === 1 ? '' : 's'}</strong></div>
                  <div className="flex justify-between sm:col-span-2 text-slate-500"><span>Deferred to a later round</span><strong className="text-slate-500">{formatNumber(classificationSummary.deferredFlavours)} flavour{classificationSummary.deferredFlavours === 1 ? '' : 's'}</strong></div>
                  <div className="flex justify-between sm:col-span-2"><span>Selected Legacy total</span><strong>{formatNumber(classificationSummary.selectedLegacyTotal)}</strong></div>
                  <div className="flex justify-between sm:col-span-2"><span>Selected target physical total</span><strong>{formatNumber(classificationSummary.selectedTargetTotal)}</strong></div>
                </>
              )}
              <div className="flex justify-between sm:col-span-2"><span>{isClassificationMode ? 'Flavours fully classified' : 'Total configurations counted'}</span><strong>{formatNumber(reviewCounted)}</strong></div>
              <div className="flex justify-between sm:col-span-2"><span>Variance items</span><strong>{formatNumber(reviewVarianceItems)}</strong></div>
              <div className={`flex justify-between rounded-md px-2 py-1 sm:col-span-2 ${highImpact ? 'bg-amber-100 text-amber-950' : ''}`}><span>{isClassificationMode ? 'Genuine net variance' : 'Net quantity adjustment'}</span><strong className={reviewNetAdjustment < 0 ? 'text-red-700' : reviewNetAdjustment > 0 ? 'text-emerald-700' : ''}>{reviewNetAdjustment > 0 ? '+' : ''}{formatNumber(reviewNetAdjustment)}</strong></div>
              <div className={`flex justify-between rounded-md px-2 py-1 sm:col-span-2 ${highImpact ? 'bg-amber-100 text-amber-950' : ''}`}><span>Estimated adjustment value</span><strong className={reviewEstimatedValue < 0 ? 'text-red-700' : reviewEstimatedValue > 0 ? 'text-emerald-700' : ''}>{formatMoney(reviewEstimatedValue)}</strong></div>
            </div>

            {/* Per-configuration breakdown — the exact lines that will post. */}
            <div className="max-h-64 space-y-3 overflow-y-auto rounded-lg border p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Configuration breakdown</p>
              {reviewBreakdown.length === 0 && <p className="text-sm text-slate-500">No configuration has a physical count entered yet.</p>}
              {reviewBreakdown.map(group => (
                <div key={group.variantId} className="rounded-md border border-slate-100">
                  <div className="flex items-center justify-between gap-2 border-b bg-slate-50 px-3 py-1.5">
                    <span className="text-sm font-semibold text-slate-900">{group.heading}</span>
                    {group.kind === 'classification' && (
                      group.complete
                        ? <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Complete</Badge>
                        : <Badge variant="outline" className="border-amber-300 text-amber-800">Incomplete</Badge>
                    )}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-slate-500">
                          <th className="px-3 py-1 text-left font-medium">Configuration</th>
                          <th className="px-3 py-1 text-right font-medium">Previous / System</th>
                          <th className="px-3 py-1 text-right font-medium">Physical</th>
                          <th className="px-3 py-1 text-right font-medium">Variance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.kind === 'classification' && (
                          <tr className="border-t bg-slate-50/60">
                            <td className="px-3 py-1 text-left text-slate-600">{group.legacy.label} <span className="text-xs text-slate-400">(source → 0)</span></td>
                            <td className="px-3 py-1 text-right tabular-nums">{formatNumber(group.legacy.system)}</td>
                            <td className="px-3 py-1 text-right tabular-nums text-slate-400">0</td>
                            <td className="px-3 py-1 text-right tabular-nums text-red-600">-{formatNumber(group.legacy.system)}</td>
                          </tr>
                        )}
                        {group.lines.map(line => {
                          const variance = line.physical === null ? null : line.physical - line.system
                          return (
                            <tr key={line.key} className="border-t">
                              <td className="px-3 py-1 text-left">{line.label}</td>
                              <td className="px-3 py-1 text-right tabular-nums">{formatNumber(line.system)}</td>
                              <td className="px-3 py-1 text-right tabular-nums">{line.physical === null ? '—' : formatNumber(line.physical)}</td>
                              <td className={`px-3 py-1 text-right font-semibold tabular-nums ${variance === null || variance === 0 ? 'text-slate-500' : variance > 0 ? 'text-emerald-600' : 'text-red-600'}`}>{variance === null ? '—' : `${variance > 0 ? '+' : ''}${formatNumber(variance)}`}</td>
                            </tr>
                          )
                        })}
                        {group.kind === 'classification' && (
                          <tr className="border-t bg-slate-50 font-semibold">
                            <td className="px-3 py-1 text-left">Target total vs legacy</td>
                            <td className="px-3 py-1 text-right tabular-nums">{formatNumber(group.legacy.system)}</td>
                            <td className="px-3 py-1 text-right tabular-nums">{formatNumber(group.targetTotal)}</td>
                            <td className={`px-3 py-1 text-right tabular-nums ${group.variance === 0 ? 'text-slate-600' : group.variance > 0 ? 'text-emerald-600' : 'text-red-600'}`}>{group.variance > 0 ? '+' : ''}{formatNumber(group.variance)}</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>

            {highImpact && <div className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"><AlertTriangle className="h-5 w-5 shrink-0" /><span><strong>High-impact adjustment.</strong> Review quantities and value carefully before requesting verification.</span></div>}
            <div><label className="mb-1.5 block text-sm font-medium">Posting Note {reviewVarianceItems > 0 && <span className="text-red-600">*</span>}</label><Textarea value={notes} onChange={event => handlePostingNoteChange(event.target.value)} placeholder="Explain the reason for this posting..." /></div>
            <div className="rounded-lg border border-[var(--sera-orange)]/20 bg-[var(--sera-orange)]/[0.06] p-3 text-sm text-blue-900">A verification code will be sent to authorized recipients. Inventory will only be updated after the code is verified.</div>
            {preflight.status === 'loading' && <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700"><Loader2 className="h-4 w-4 animate-spin" />Checking permission, notification recipients, and email provider…</div>}
            {preflight.status === 'ready' && <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /><span>Verification is ready. The code will be emailed to {preflight.recipientCount} authorized recipient{preflight.recipientCount === 1 ? '' : 's'}.</span></div>}
            {preflight.status === 'error' && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700"><div>{preflight.message}</div>{preflight.guidance && <div className="mt-1 text-xs text-red-600">{preflight.guidance}</div>}<Button type="button" variant="outline" size="sm" className="mt-3" onClick={retryVerificationPreflight} disabled={saving || permissionLoading}>{saving ? 'Saving Changes…' : 'Retry Check'}</Button></div>}
            {verificationError && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{verificationError}</div>}
            <DialogFooter><Button variant="outline" onClick={closePostDialog}>Cancel</Button><Button onClick={requestVerificationCode} disabled={posting || preflight.status !== 'ready' || !hasPostStockCountPermission || !canPost || (reviewVarianceItems > 0 && !isValidStockCountPostingNote(notes))} className="bg-orange-600 hover:bg-orange-700">{posting ? 'Sending Code...' : preflight.status === 'loading' ? 'Checking Configuration...' : 'Request Verification Code'}</Button></DialogFooter>
          </> : <>
            <div className="rounded-lg border border-[var(--sera-orange)]/20 bg-[var(--sera-orange)]/[0.06] p-4 text-sm text-blue-950">
              <div className="font-semibold">Code sent to authorized recipients</div>
              <div className="mt-2 flex flex-wrap gap-2">{verification.recipients.map(recipient => <Badge key={recipient} variant="secondary">{recipient}</Badge>)}</div>
            </div>
            <div className="space-y-2">
              <label className="block text-sm font-medium">8-digit verification code</label>
              <Input autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={8} value={verificationCode} onChange={event => setVerificationCode(event.target.value.replace(/\D/g, '').slice(0, 8))} onKeyDown={event => { if (event.key === 'Enter' && verificationCode.length === 8) void verifyAndPostCount() }} className="h-14 text-center font-mono text-2xl tracking-[0.4em]" placeholder="00000000" />
              <div className="flex justify-between text-xs text-slate-500"><span>{expirySeconds > 0 ? `Expires in ${Math.floor(expirySeconds / 60)}:${String(expirySeconds % 60).padStart(2, '0')}` : 'Code expired'}</span><span>Maximum 5 attempts</span></div>
            </div>
            {verificationStale && <div className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"><AlertTriangle className="h-5 w-5 shrink-0" /><span><strong>Counts changed after this code was issued.</strong> This code can no longer post. Cancel, save the draft, and request a new code.</span></div>}
            {verificationError && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{verificationError}</div>}
            <DialogFooter className="gap-2 sm:justify-between">
              <div className="flex gap-2"><Button variant="outline" onClick={closePostDialog}>Cancel</Button><Button variant="ghost" onClick={requestVerificationCode} disabled={posting || resendSeconds > 0}>{resendSeconds > 0 ? `Resend in ${resendSeconds}s` : 'Resend Code'}</Button></div>
              <Button onClick={verifyAndPostCount} disabled={posting || verificationCode.length !== 8 || expirySeconds <= 0 || verificationStale} className="bg-orange-600 hover:bg-orange-700">{posting ? 'Posting...' : 'Verify & Post Count'}</Button>
            </DialogFooter>
          </>}
        </DialogContent>
      </Dialog>

      <Card className="border-amber-200 bg-amber-50"><CardContent className="flex items-center gap-3 p-3 text-sm text-amber-900"><Warehouse className="h-4 w-4" /><span>Tip: select a group, update all variant physical counts directly or by Excel import, then save draft before posting.</span></CardContent></Card>
    </div>
  )
}
