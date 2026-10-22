'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
    Plus, RefreshCw, Search, Trash2, Loader2, FileText, Eye, Send,
    ArrowLeft, PackageOpen, Ban, Save, ChevronRight, Store, ExternalLink,
    Package, Boxes, RotateCcw, Info, Lightbulb, Download, Upload,
    CheckCircle2, AlertTriangle, XCircle, Zap, Wand2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import ReturnStatusStepper from './ReturnStatusStepper'
import {
    RETURN_STATUS_LABELS,
    RETURN_NEXT_ACTION_LABEL,
    RETURN_SOURCE_LABELS,
    canAdvanceStatus,
    showsWarehouseProcessing,
    isTerminalStatus,
    computeReturnTotal,
    normalizeReturnSourceType,
    sourceTypeForOrgTypeCode,
    type ReturnStatus,
    type ReturnSourceType,
} from '@/lib/returns/constants'
import { ReturnSourceCombobox } from './ReturnSourceCombobox'
import { generateReturnPdf } from '@/lib/returns/pdf'
import { itemLineValue } from '@/lib/returns/compute'
import { variantAlternativeLabel, variantIdentityLabel } from '@/lib/inventory/variant-display-label'
import {
    getVariantDisplayName, classifyProductLine, productLineLabel,
    isCartridgeLine, getRowUnitsPerCase, getSavedRowUnitsPerCase,
    getUnitsPerCase, getUnitsPerBox, computePcsMode, computeBoxMode,
    pcsModeToStorage, boxModeToStorage, storageToPcsMode, storageToBoxMode,
    formatReturnAmount, caseUnitLabel, CASE_UNIT_LABEL,
    type ProductLine, type EntryUnit,
} from '@/lib/returns/format'
import type {
    ReturnCase, ReturnCaseItem, ReturnMeta, ReturnCategoryRef,
    EligibleProduct, EligibleProductsResult, OrgRef,
} from '@/lib/returns/types'
import { EMPTY_RETURN_META, getCategorySelectorState, normalizeReturnMeta } from '@/lib/returns/meta'
import {
    buildReturnExcelFilename, exportReturnWorkbookBlob, parseReturnWorkbook,
    type ReturnExcelContext, type ReturnExcelImportResult,
} from '@/lib/returns/excel'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import SupplyChainPageHeader from '@/modules/supply-chain/components/SupplyChainPageHeader'
import { SC_PANEL_CLASS } from '@/modules/supply-chain/components/supplyChainChrome'

interface UserProfile { id: string; full_name?: string | null }

const STATUS_BADGE: Record<string, string> = {
    return_draft: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    return_submitted: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    return_received: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    return_processing: 'bg-[var(--sera-orange)]/10 text-[var(--sera-orange-deep)]',
    return_completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    return_cancelled: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
}

function StatusBadge({ status }: { status: string }) {
    return (
        <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', STATUS_BADGE[status] || STATUS_BADGE.return_draft)}>
            {RETURN_STATUS_LABELS[status as ReturnStatus] || status}
        </span>
    )
}

export default function ReturnProductView({ userProfile }: { userProfile: UserProfile }) {
    const { toast } = useToast()
    const [meta, setMeta] = useState<ReturnMeta>(EMPTY_RETURN_META)
    const [metaLoading, setMetaLoading] = useState(true)
    const [metaError, setMetaError] = useState<string | null>(null)
    const [cases, setCases] = useState<ReturnCase[]>([])
    const [loading, setLoading] = useState(true)
    const [mode, setMode] = useState<'list' | 'editor'>('list')
    const [editingId, setEditingId] = useState<string | null>(null)
    const [statusFilter, setStatusFilter] = useState<string>('all')
    const [search, setSearch] = useState('')

    const loadMeta = useCallback(async () => {
        setMetaLoading(true)
        setMetaError(null)
        try {
            const res = await fetch('/api/returns/meta')
            const json = await res.json()
            if (!res.ok) throw new Error(json.error || 'Failed to load return metadata')
            setMeta(normalizeReturnMeta(json))
        } catch (e: any) {
            const message = e?.message || 'Failed to load return metadata'
            setMetaError(message)
            toast({ title: 'Failed to load return settings', description: message, variant: 'destructive' })
        } finally {
            setMetaLoading(false)
        }
    }, [toast])

    const loadCases = useCallback(async () => {
        setLoading(true)
        try {
            const params = new URLSearchParams()
            if (statusFilter !== 'all') params.set('status', statusFilter)
            if (search.trim()) params.set('search', search.trim())
            const res = await fetch(`/api/returns?${params.toString()}`)
            const json = await res.json()
            if (!res.ok) throw new Error(json.error)
            setCases(json.cases || [])
        } catch (e: any) {
            toast({ title: 'Failed to load returns', description: e.message, variant: 'destructive' })
        } finally {
            setLoading(false)
        }
    }, [statusFilter, search, toast])

    useEffect(() => { loadMeta() }, [loadMeta])
    useEffect(() => { if (mode === 'list') loadCases() }, [mode, loadCases])

    // Deep link from Return Reporting: a row click stores the case id, then
    // switches the dashboard view to return-product. Open it directly.
    useEffect(() => {
        if (typeof window === 'undefined') return
        const id = sessionStorage.getItem('openReturnCaseId')
        if (id) {
            sessionStorage.removeItem('openReturnCaseId')
            setEditingId(id)
            setMode('editor')
        }
    }, [])

    const openNew = () => { setEditingId(null); setMode('editor') }
    const openCase = (id: string) => { setEditingId(id); setMode('editor') }
    const backToList = () => { setMode('list'); setEditingId(null) }

    if (mode === 'editor') {
        return (
            <ReturnCaseEditor
                userProfile={userProfile}
                meta={meta}
                metaLoading={metaLoading}
                caseId={editingId}
                onBack={backToList}
                onSaved={() => { loadCases() }}
            />
        )
    }

    return (
        <div className="sera-sc-page space-y-4">
            <SupplyChainPageHeader
                eyebrow="Quality · Returns"
                title="Return Product"
                description="Create and manage product return cases from shops to warehouse."
                actions={
                    <Button onClick={openNew} className="gap-1.5 bg-[var(--sera-orange)] hover:bg-[var(--sera-orange-deep)] text-white" disabled={metaLoading || !!metaError}>
                        {metaLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} New Return
                    </Button>
                }
            />

            {metaError && (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    <span>Return metadata could not be loaded: {metaError}</span>
                    <Button type="button" variant="outline" size="sm" onClick={loadMeta} disabled={metaLoading}>
                        {metaLoading && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Retry
                    </Button>
                </div>
            )}

            <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2">
                <div className="relative flex-1 min-w-0 sm:min-w-[200px]">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                        placeholder="Search return no…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && loadCases()}
                        className="pl-8"
                    />
                </div>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="w-full sm:w-[190px]"><SelectValue placeholder="Status" /></SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">All Statuses</SelectItem>
                        {Object.entries(RETURN_STATUS_LABELS).map(([k, v]) => (
                            <SelectItem key={k} value={k}>{v}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Button variant="outline" size="icon" className="shrink-0 self-end sm:self-auto" onClick={loadCases} disabled={loading} title="Refresh">
                    <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                </Button>
            </div>

            <div className={`${SC_PANEL_CLASS} overflow-x-auto sera-sc-table-scroll`}>
                <table className="sera-sc-table w-full min-w-[720px] text-sm">
                    <thead className="text-left text-xs uppercase text-[var(--sera-muted)]">
                        <tr>
                            <th className="px-3 py-2 font-medium">Return No</th>
                            <th className="px-3 py-2 font-medium">Shop</th>
                            <th className="px-3 py-2 font-medium">Warehouse</th>
                            <th className="px-3 py-2 font-medium">Status</th>
                            <th className="px-3 py-2 text-right font-medium">Total Pcs</th>
                            <th className="px-3 py-2 text-right font-medium">Value (RM)</th>
                            <th className="px-3 py-2 font-medium">Created</th>
                            <th className="px-3 py-2" />
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {loading ? (
                            <tr><td colSpan={8} className="px-3 py-10 text-center text-muted-foreground"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>
                        ) : cases.length === 0 ? (
                            <tr><td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">
                                <PackageOpen className="mx-auto mb-2 h-8 w-8 opacity-40" />
                                No return cases yet.
                            </td></tr>
                        ) : cases.map((c) => (
                            <tr key={c.id} className="cursor-pointer hover:bg-[var(--sera-ink)]/[0.03]" onClick={() => openCase(c.id)}>
                                <td className="px-3 py-2 font-medium text-foreground">{c.return_no}</td>
                                <td className="px-3 py-2">{c.shop?.org_name || '—'}</td>
                                <td className="px-3 py-2">{c.warehouse?.org_name || '—'}</td>
                                <td className="px-3 py-2">
                                    <StatusBadge status={c.status} />
                                    {c.is_overdue && <Badge variant="destructive" className="ml-1 text-[10px]">Overdue</Badge>}
                                </td>
                                <td className="px-3 py-2 text-right">{c.total_qty ?? 0}</td>
                                <td className="px-3 py-2 text-right">{formatReturnAmount(c.total_value)}</td>
                                <td className="px-3 py-2 text-muted-foreground">{c.created_at ? new Date(c.created_at).toLocaleDateString('en-MY') : '—'}</td>
                                <td className="px-3 py-2 text-right"><ChevronRight className="h-4 w-4 text-muted-foreground" /></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    )
}

// ─────────────────────────── Worksheet row model ───────────────────────────

interface WorksheetRow {
    key: string
    product_id: string | null
    variant_id: string | null
    sku_id: string | null
    sku: string | null
    manual_sku: string | null
    manufacturer_sku: string | null
    barcode: string | null
    product_name: string
    variant_name: string | null
    variant_product_code: string | null
    alternative_name: string | null
    product_line: ProductLine
    image_url: string | null
    units_per_case: number
    unit_cost: number
    is_active: boolean
    isExtra: boolean
    // Pcs/Cases mode
    entry_unit: EntryUnit
    entered_pcs: number
    entered_box_qty: number
    entered_extra_pcs: number
    // derived (computed from entry)
    case_qty: number
    loose_piece_qty: number
    total_units: number
    reason: string | null
    condition: string | null
    notes: string | null
}

function newKey() { return Math.random().toString(36).slice(2) }

function eligibleToRow(p: EligibleProduct): WorksheetRow {
    return {
        key: p.variant_id || p.sku || newKey(),
        product_id: p.product_id,
        variant_id: p.variant_id,
        sku_id: p.sku_id,
        sku: p.sku,
        manual_sku: p.manual_sku,
        manufacturer_sku: p.manufacturer_sku,
        barcode: p.barcode,
        product_name: p.product_name,
        variant_name: p.variant_name,
        variant_product_code: p.variant_product_code ?? null,
        alternative_name: p.alternative_name ?? null,
        product_line: p.product_line,
        image_url: p.image_url,
        units_per_case: getRowUnitsPerCase(p.product_line, p.product_name, p.units_per_case),
        unit_cost: p.unit_cost,
        is_active: p.is_active,
        isExtra: false,
        entry_unit: 'pcs',
        entered_pcs: 0,
        entered_box_qty: 0,
        entered_extra_pcs: 0,
        case_qty: 0,
        loose_piece_qty: 0,
        total_units: 0,
        reason: null,
        condition: null,
        notes: null,
    }
}

function savedItemToExtraRow(it: ReturnCaseItem): WorksheetRow {
    const upc = Number(it.units_per_case_snapshot)
    const productName = it.product_name || 'Product'
    const line = classifyProductLine(productName)
    const upcVal = getSavedRowUnitsPerCase(line, productName, upc, getUnitsPerBox(productName))
    const caseQty = Number(it.case_qty || 0)
    const looseQty = Number(it.loose_piece_qty || 0)
    const total = caseQty * upcVal + looseQty
    return {
        key: `extra-${it.variant_id || it.sku || it.id || newKey()}`,
        product_id: it.product_id,
        variant_id: it.variant_id,
        sku_id: null,
        sku: it.sku,
        manual_sku: null,
        manufacturer_sku: null,
        barcode: null,
        product_name: productName,
        variant_name: it.variant_name,
        // return_case_items stores a name snapshot only, so a saved historical
        // row degrades to product + variant name with no code or alternative.
        variant_product_code: null,
        alternative_name: null,
        product_line: classifyProductLine(productName),
        image_url: null,
        units_per_case: upcVal,
        unit_cost: Number(it.unit_cost || 0),
        is_active: false,
        isExtra: true,
        entry_unit: 'pcs',
        entered_pcs: total,
        entered_box_qty: Math.floor(total / upcVal),
        entered_extra_pcs: total % upcVal,
        case_qty: caseQty,
        loose_piece_qty: looseQty,
        total_units: total,
        reason: it.reason,
        condition: it.condition,
        notes: it.notes,
    }
}

/** Recompute derived fields from the entry unit and entered values. */
function recomputeRow(r: WorksheetRow): WorksheetRow {
    // Non-cartridge lines (devices and everything else) are PCS-only.
    if (!isCartridgeLine(r.product_line)) {
        const pcs = Math.max(0, Math.floor(r.entry_unit === 'box' ? r.total_units : r.entered_pcs))
        return {
            ...r,
            entry_unit: 'pcs',
            entered_pcs: pcs,
            entered_box_qty: 0,
            entered_extra_pcs: 0,
            case_qty: 0,
            loose_piece_qty: pcs,
            total_units: pcs,
        }
    }
    const upb = r.units_per_case > 0 ? r.units_per_case : 1
    if (r.entry_unit === 'pcs') {
        const pcs = Math.max(0, Math.floor(r.entered_pcs))
        const result = computePcsMode({ enteredPcs: pcs, unitsPerBox: upb })
        return {
            ...r,
            entered_pcs: pcs,
            entered_box_qty: result.boxQty,
            entered_extra_pcs: result.loosePcs,
            case_qty: result.boxQty,
            loose_piece_qty: result.loosePcs,
            total_units: result.totalPcs,
        }
    } else {
        const b = Math.max(0, Math.floor(r.entered_box_qty))
        const e = Math.max(0, Math.floor(r.entered_extra_pcs))
        const result = computeBoxMode({ boxQty: b, extraPcs: e, unitsPerBox: upb })
        return {
            ...r,
            entered_box_qty: result.boxQty,
            entered_extra_pcs: result.loosePcs,
            entered_pcs: result.totalPcs,
            case_qty: result.boxQty,
            loose_piece_qty: result.loosePcs,
            total_units: result.totalPcs,
        }
    }
}

/** Row total pieces from live row. */
function rowTotal(r: WorksheetRow): number {
    return r.total_units
}

// ─────────────────────────── Editor ───────────────────────────

function ReturnCaseEditor({
    userProfile, meta, metaLoading, caseId, onBack, onSaved,
}: {
    userProfile: UserProfile
    meta: ReturnMeta
    metaLoading: boolean
    caseId: string | null
    onBack: () => void
    onSaved: () => void
}) {
    const { toast } = useToast()
    const supabase = useMemo(() => createClient(), [])
    const [currentId, setCurrentId] = useState<string | null>(caseId)
    const isNew = !currentId

    const [rc, setRc] = useState<ReturnCase | null>(null)
    const [loading, setLoading] = useState(!!caseId)
    const [saving, setSaving] = useState(false)
    const [advancing, setAdvancing] = useState(false)

    // Header form
    // Return source (Shop or Distributor). A self-service user's own org type
    // determines the source; managers choose it explicitly.
    const [sourceType, setSourceType] = useState<ReturnSourceType>(
        meta.isManager ? 'shop' : (sourceTypeForOrgTypeCode(meta.orgTypeCode) || 'shop'),
    )
    const [shopId, setShopId] = useState<string>(meta.isManager ? '' : (meta.userOrgId || ''))
    // Full org record for the selected source (Shop/Distributor) — the selector
    // uses server-side search, so we keep the chosen org here for display + Excel.
    const [selectedSourceOrg, setSelectedSourceOrg] = useState<OrgRef | null>(null)
    const [warehouseId, setWarehouseId] = useState<string>(() => {
        const id = meta.settings.default_return_warehouse_id
        return id && meta.warehouses.some((w) => w.id === id) ? id : ''
    })
    const [contactPerson, setContactPerson] = useState('')
    const [contactPhone, setContactPhone] = useState('')
    const [contactEmail, setContactEmail] = useState('')
    const [reportedDate, setReportedDate] = useState<string>(new Date().toISOString().slice(0, 10))
    const [notes, setNotes] = useState('')

    // Program / category (auto-detected from shop; category can be manual when unresolved)
    const [program, setProgram] = useState<{ code: string; name: string } | null>(null)
    const [category, setCategory] = useState<ReturnCategoryRef | null>(null)
    const [categoryResolved, setCategoryResolved] = useState(false)
    const [manualCategoryId, setManualCategoryId] = useState<string>('')

    // Worksheet
    const [rows, setRows] = useState<WorksheetRow[]>([])
    const [eligibleLoading, setEligibleLoading] = useState(false)

    // Excel bulk data-entry
    const excelInputRef = useRef<HTMLInputElement>(null)
    const [excelBusy, setExcelBusy] = useState(false)
    const [importResult, setImportResult] = useState<ReturnExcelImportResult | null>(null)
    const [unsavedChanges, setUnsavedChanges] = useState(false)

    // Warehouse processing form
    const [wh, setWh] = useState({ received_by: '', received_date: '', processing_notes: '', action_taken: '', return_courier: '', tracking_no: '', completed_date: '' })

    const status: ReturnStatus = rc?.status || 'return_draft'
    const readOnly = isTerminalStatus(status)
    const warehouseLocked = status !== 'return_draft' && status !== 'return_submitted'
    const isDraft = status === 'return_draft'
    const savedItemsRef = useRef<ReturnCaseItem[]>([])
    const categorySelector = getCategorySelectorState(meta, metaLoading, categoryResolved)
    const categories = categorySelector.categories

    // ── Eligible product loading ──
    const fetchEligible = useCallback(async (
        shop: string,
        categoryOverride?: string,
    ): Promise<EligibleProductsResult | null> => {
        if (!shop) return null
        setEligibleLoading(true)
        try {
            const params = new URLSearchParams({ shop })
            if (categoryOverride) params.set('category', categoryOverride)
            const res = await fetch(`/api/returns/eligible-products?${params.toString()}`)
            const json = await res.json()
            if (!res.ok) throw new Error(json.error)
            return json as EligibleProductsResult
        } catch (e: any) {
            toast({ title: 'Failed to load products', description: e.message, variant: 'destructive' })
            return null
        } finally {
            setEligibleLoading(false)
        }
    }, [toast])

    const buildRows = useCallback((products: EligibleProduct[], saved: ReturnCaseItem[]): WorksheetRow[] => {
        const savedByKey = new Map<string, ReturnCaseItem>()
        for (const it of saved) {
            const k = (it.variant_id || it.sku || '').toLowerCase()
            if (k) savedByKey.set(k, it)
        }
        const usedKeys = new Set<string>()

        const base: WorksheetRow[] = products.map((p) => {
            const row = eligibleToRow(p)
            const k = (p.variant_id || p.sku || '').toLowerCase()
            const s = k ? savedByKey.get(k) : undefined
            if (s) {
                usedKeys.add(k)
                const upc = Number(s.units_per_case_snapshot)
                const upcVal = getSavedRowUnitsPerCase(row.product_line, row.product_name, upc, row.units_per_case)
                row.units_per_case = upcVal
                const cq = Number(s.case_qty || 0)
                const lq = Number(s.loose_piece_qty || 0)
                const total = cq * upcVal + lq
                row.case_qty = cq
                row.loose_piece_qty = lq
                row.total_units = total
                // Default to pcs mode restoring total
                row.entry_unit = 'pcs'
                row.entered_pcs = total
                row.entered_box_qty = Math.floor(total / upcVal)
                row.entered_extra_pcs = total % upcVal
                row.reason = s.reason
                row.condition = s.condition
                row.notes = s.notes
            }
            return row
        })

        const extras: WorksheetRow[] = []
        for (const it of saved) {
            const k = (it.variant_id || it.sku || '').toLowerCase()
            if (k && usedKeys.has(k)) continue
            extras.push(savedItemToExtraRow(it))
        }
        return [...base, ...extras]
    }, [])

    const hydrateCase = useCallback(async (id: string) => {
        const res = await fetch(`/api/returns/${id}`)
        const json = await res.json()
        if (!res.ok) throw new Error(json.error)
        const c: ReturnCase = json.case
        setRc(c)
        setCurrentId(c.id)
        setSourceType(normalizeReturnSourceType(c.return_source_type))
        setShopId(c.return_source_organization_id || c.shop_org_id)
        setSelectedSourceOrg(c.source || c.shop || null)
        setWarehouseId(c.return_warehouse_id || '')
        setContactPerson(c.contact_person || '')
        setContactPhone(c.contact_phone || '')
        setContactEmail(c.contact_email || '')
        setReportedDate(c.reported_date || (c.created_at ? c.created_at.slice(0, 10) : new Date().toISOString().slice(0, 10)))
        setNotes(c.notes || '')
        setWh({
            received_by: c.received_by || '',
            received_date: c.received_date || '',
            processing_notes: c.processing_notes || '',
            action_taken: c.action_taken || '',
            return_courier: c.return_courier || '',
            tracking_no: c.tracking_no || '',
            completed_date: c.completed_date || '',
        })

        const saved = c.items || []
        savedItemsRef.current = saved
        const elig = await fetchEligible(c.shop_org_id)
        if (elig) {
            setProgram(elig.program)
            setCategory(elig.category)
            setCategoryResolved(elig.resolved)
            setManualCategoryId(elig.category?.id || '')
            setRows(buildRows(elig.products, saved))
        } else {
            setRows(saved.map(savedItemToExtraRow))
            setProgram(c.program_snapshot ? { code: '', name: c.program_snapshot } : null)
        }
    }, [fetchEligible, buildRows])

    const loadCase = useCallback(async () => {
        if (!caseId) return
        setLoading(true)
        try {
            await hydrateCase(caseId)
        } catch (e: any) {
            toast({ title: 'Failed to load return', description: e.message, variant: 'destructive' })
        } finally {
            setLoading(false)
        }
    }, [caseId, toast, hydrateCase])

    useEffect(() => { loadCase() }, [loadCase])

    const selectedShop = useMemo(
        () => selectedSourceOrg || rc?.source || rc?.shop || null,
        [selectedSourceOrg, rc?.source, rc?.shop],
    )
    const sourceLabel = RETURN_SOURCE_LABELS[sourceType]

    const warehouseOptions = useMemo(() => {
        const opts = meta.warehouses.map((w) => ({ ...w, inactive: false }))
        if (warehouseId && !opts.some((w) => w.id === warehouseId)) {
            const saved = rc?.warehouse && rc.warehouse.id === warehouseId ? rc.warehouse : null
            opts.push({
                id: warehouseId,
                org_code: saved?.org_code ?? null,
                org_name: saved?.org_name ?? 'Unknown warehouse',
                contact_name: saved?.contact_name ?? null,
                contact_phone: saved?.contact_phone ?? null,
                contact_email: saved?.contact_email ?? null,
                address: saved?.address ?? null,
                city: saved?.city ?? null,
                postal_code: saved?.postal_code ?? null,
                inactive: true,
            })
        }
        return opts
    }, [meta.warehouses, warehouseId, rc?.warehouse])

    const selectedWarehouse = useMemo(
        () => warehouseOptions.find((w) => w.id === warehouseId) || null,
        [warehouseOptions, warehouseId],
    )

    const applyOrgContacts = useCallback((org: OrgRef | null) => {
        setContactPerson(org?.contact_name || '')
        setContactPhone(org?.contact_phone || '')
        setContactEmail(org?.contact_email || '')
    }, [])

    // Self-service user: preload their own org (shop) source on a fresh return.
    useEffect(() => {
        if (isNew && !meta.isManager && shopId) {
            const ownOrg = meta.shops.find((s) => s.id === shopId) || null
            setSelectedSourceOrg(ownOrg)
            applyOrgContacts(ownOrg)
            void selectSourceOrg(ownOrg || { id: shopId } as OrgRef)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    /** Select a source organization (Shop or Distributor) and load its products. */
    const selectSourceOrg = async (org: OrgRef) => {
        setShopId(org.id)
        setSelectedSourceOrg(org)
        applyOrgContacts(org)
        savedItemsRef.current = []
        const elig = await fetchEligible(org.id)
        if (elig) {
            setProgram(elig.program)
            setCategory(elig.category)
            setCategoryResolved(elig.resolved)
            setManualCategoryId(elig.category?.id || '')
            setRows(buildRows(elig.products, []))
        }
    }

    /** Switch between Shop and Distributor, clearing the previous selection. */
    const changeSourceType = (next: ReturnSourceType) => {
        if (next === sourceType) return
        const hasWork = shopId || rows.some((r) => rowTotal(r) > 0) || unsavedChanges
        if (hasWork && !confirm('Switching the source type will clear the selected organization and any entered items. Continue?')) {
            return
        }
        setSourceType(next)
        setShopId('')
        setSelectedSourceOrg(null)
        applyOrgContacts(null)
        setProgram(null)
        setCategory(null)
        setCategoryResolved(false)
        setManualCategoryId('')
        setRows([])
        savedItemsRef.current = []
    }

    const selectManualCategory = async (categoryId: string) => {
        setManualCategoryId(categoryId)
        if (!shopId) return
        const saved = collectItems()
        const elig = await fetchEligible(shopId, categoryId)
        if (elig) {
            setProgram(elig.program)
            setCategory(elig.category)
            setCategoryResolved(elig.resolved)
            setRows(buildRows(elig.products, saved as ReturnCaseItem[]))
        }
    }

    const openShopContactEditor = () => {
        if (!shopId) return
        window.open(`/supply-chain/organizations/${shopId}/edit#contact-information`, '_blank')
    }

    // ── Row helpers ──
    const updateRow = (key: string, patch: Partial<WorksheetRow>) => {
        setRows((prev) => prev.map((r) => {
            if (r.key !== key) return r
            const merged = { ...r, ...patch }
            // If entry values changed, recompute
            if ('entry_unit' in patch || 'entered_pcs' in patch || 'entered_box_qty' in patch || 'entered_extra_pcs' in patch) {
                return recomputeRow(merged)
            }
            return merged
        }))
    }

    const removeExtraRow = (key: string) => setRows((prev) => prev.filter((r) => r.key !== key))

    const resetQuantities = () => {
        if (!confirm('Reset all entered quantities, reasons and conditions?')) return
        setRows((prev) => prev.map((r) => ({
            ...r,
            entry_unit: 'pcs' as EntryUnit,
            entered_pcs: 0,
            entered_box_qty: 0,
            entered_extra_pcs: 0,
            case_qty: 0,
            loose_piece_qty: 0,
            total_units: 0,
            reason: null,
            condition: null,
            notes: null,
        })))
    }

    const addOtherRow = (v: ExtraProductOption) => {
        setRows((prev) => {
            const k = (v.variant_id || v.sku || '').toLowerCase()
            if (k && prev.some((r) => (r.variant_id || r.sku || '').toLowerCase() === k)) {
                toast({ title: 'Already in the list', description: `${v.product_name} is already a worksheet row.` })
                return prev
            }
            const vLine = classifyProductLine(v.product_name)
            const upc = getRowUnitsPerCase(vLine, v.product_name, v.units_per_case)
            return [...prev, {
                key: `extra-${v.variant_id || v.sku || newKey()}`,
                product_id: v.product_id, variant_id: v.variant_id, sku_id: null,
                sku: v.sku, manual_sku: v.manual_sku, manufacturer_sku: v.manufacturer_sku,
                barcode: v.barcode, product_name: v.product_name, variant_name: v.variant_name,
                variant_product_code: v.variant_product_code ?? null,
                alternative_name: v.alternative_name ?? null,
                product_line: vLine,
                image_url: v.image_url, units_per_case: upc,
                unit_cost: v.unit_cost, is_active: v.is_active, isExtra: true,
                entry_unit: 'pcs' as EntryUnit,
                entered_pcs: 0, entered_box_qty: 0, entered_extra_pcs: 0,
                case_qty: 0, loose_piece_qty: 0, total_units: 0,
                reason: null, condition: null, notes: null,
            }]
        })
    }

    // ── Bulk update Reason / Condition for all entered rows (Total Pcs > 0) ──
    const bulkApplyReasonCondition = (reason: string | null, condition: string | null) => {
        if (!reason && !condition) return
        const enteredCount = rows.filter((r) => r.total_units > 0).length
        if (enteredCount === 0) {
            toast({
                title: 'Nothing to update',
                description: 'Enter a return quantity for at least one item first.',
                variant: 'destructive',
            })
            return
        }
        setRows((prev) => prev.map((r) => {
            if (r.total_units <= 0) return r
            const patch: Partial<WorksheetRow> = {}
            if (reason) patch.reason = reason
            if (condition) patch.condition = condition
            return { ...r, ...patch }
        }))
        setUnsavedChanges(true)
        const noun = enteredCount === 1 ? 'entered item' : 'entered items'
        const description =
            reason && condition
                ? `Reason and condition applied to ${enteredCount} ${noun}.`
                : reason
                    ? `Reason applied to ${enteredCount} ${noun}.`
                    : `Condition applied to ${enteredCount} ${noun}.`
        toast({ title: 'Bulk update applied', description })
    }

    // ── Summary ──
    const summary = useMemo(() => {
        let entered = 0, totalCase = 0, totalLoose = 0, totalPcs = 0, value = 0
        for (const r of rows) {
            const n = computeReturnTotal(r.case_qty, r.loose_piece_qty, r.units_per_case)
            if (n.total_units > 0) {
                entered += 1
                totalCase += n.case_qty
                totalLoose += n.loose_piece_qty
                totalPcs += n.total_units
                value += itemLineValue({
                    total_units: n.total_units, quantity: n.total_units,
                    unit_cost: r.unit_cost, units_per_case_snapshot: r.units_per_case,
                })
            }
        }
        return { entered, totalRows: rows.length, totalCase, totalLoose, totalPcs, value }
    }, [rows])

    // ── Persist ──
    const collectItems = () => rows
        .map((r) => {
            const n = computeReturnTotal(r.case_qty, r.loose_piece_qty, r.units_per_case)
            return {
                product_id: r.product_id, variant_id: r.variant_id, sku: r.sku,
                product_name: r.product_name, variant_name: r.variant_name,
                case_qty: n.case_qty, loose_piece_qty: n.loose_piece_qty,
                units_per_case_snapshot: r.units_per_case,
                unit_cost: r.unit_cost,
                reason: r.reason, condition: r.condition, notes: r.notes,
                _total: n.total_units,
            }
        })
        .filter((it) => it._total > 0)
        .map(({ _total, ...it }) => it)

    const buildPayload = () => ({
        return_source_type: sourceType,
        return_source_organization_id: meta.isManager ? shopId : meta.userOrgId,
        shop_org_id: meta.isManager ? shopId : meta.userOrgId, // legacy compat
        return_warehouse_id: warehouseId || null,
        contact_person: contactPerson || null,
        contact_phone: contactPhone || null,
        contact_email: contactEmail || null,
        reported_date: reportedDate || null,
        program_snapshot: program?.name || null,
        category_snapshot: category?.category_name || null,
        notes: notes || null,
        items: collectItems(),
    })

    const validate = (): string | null => {
        if (meta.isManager && !shopId) {
            return sourceType === 'distributor' ? 'Please select a distributor.' : 'Please select a shop.'
        }
        return null
    }

    const saveDraft = async (): Promise<string | null> => {
        const err = validate()
        if (err) { toast({ title: 'Missing information', description: err, variant: 'destructive' }); return null }
        setSaving(true)
        try {
            if (!currentId) {
                const res = await fetch('/api/returns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildPayload()) })
                const json = await res.json()
                if (!res.ok) throw new Error(json.error)
                toast({ title: 'Draft saved', description: json.return_no })
                setUnsavedChanges(false)
                onSaved()
                await hydrateCase(json.id)
                return json.id
            } else {
                const payload: any = buildPayload()
                if (!isDraft) Object.assign(payload, wh)
                const res = await fetch(`/api/returns/${currentId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
                const json = await res.json()
                if (!res.ok) throw new Error(json.error)
                toast({ title: 'Saved' })
                setUnsavedChanges(false)
                onSaved()
                await hydrateCase(currentId)
                return currentId
            }
        } catch (e: any) {
            toast({ title: 'Save failed', description: e.message, variant: 'destructive' })
            return null
        } finally {
            setSaving(false)
        }
    }

    const submitPreCheck = (): string | null => {
        if (meta.isManager && !shopId) {
            return sourceType === 'distributor' ? 'Please select a distributor.' : 'Please select a shop.'
        }
        if (!warehouseId) return 'Please select a Return Warehouse.'
        if (!reportedDate) return 'Please set a Reported Date.'
        const entered = rows.filter((r) => rowTotal(r) > 0)
        if (entered.length === 0) return 'Enter a quantity for at least one product.'
        for (const r of entered) {
            if (!r.reason || !r.condition) {
                return 'Every entered item needs a Reason and Condition.'
            }
        }
        return null
    }

    const advance = async () => {
        if (isDraft) {
            const err = submitPreCheck()
            if (err) { toast({ title: 'Cannot submit yet', description: err, variant: 'destructive' }); return }
        }
        const id = await saveDraft()
        if (!id) return
        setAdvancing(true)
        try {
            const res = await fetch(`/api/returns/${id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
            const json = await res.json()
            if (!res.ok) throw new Error(json.error)
            const inventoryNotice = json.inventoryPosting?.historically_excluded
                ? (json.inventoryPosting?.notice
                    || 'Status updated. Inventory was not changed because this return was excluded by a posted Opening Balance.')
                : null
            toast({
                title: 'Status updated',
                description: inventoryNotice
                    || RETURN_STATUS_LABELS[json.status as ReturnStatus],
            })
            onSaved()
            onBack()
        } catch (e: any) {
            toast({ title: 'Status update failed', description: e.message, variant: 'destructive' })
        } finally {
            setAdvancing(false)
        }
    }

    const cancelReturn = async () => {
        const id = currentId
        if (!id) return
        if (!confirm('Cancel this return? This cannot be undone.')) return
        try {
            const res = await fetch(`/api/returns/${id}`, { method: 'DELETE' })
            const json = await res.json()
            if (!res.ok) throw new Error(json.error)
            toast({ title: 'Return cancelled' })
            onSaved()
            onBack()
        } catch (e: any) {
            toast({ title: 'Cancel failed', description: e.message, variant: 'destructive' })
        }
    }

    const makePdfCase = (): ReturnCase => ({
        ...(rc || ({} as ReturnCase)),
        return_no: rc?.return_no || 'DRAFT',
        status,
        contact_person: contactPerson, contact_phone: contactPhone, contact_email: contactEmail, notes,
        reported_date: reportedDate,
        program_snapshot: program?.name || null,
        category_snapshot: category?.category_name || null,
        return_source_type: sourceType,
        return_source_organization_id: shopId || null,
        source: selectedShop,
        shop: selectedShop,
        warehouse: meta.warehouses.find((w) => w.id === warehouseId) || rc?.warehouse || null,
        items: collectItems().map((it, i) => ({
            id: String(i), return_case_id: currentId || '',
            product_id: it.product_id, variant_id: it.variant_id, sku: it.sku,
            product_name: it.product_name, variant_name: it.variant_name,
            quantity: 0, case_qty: it.case_qty, loose_piece_qty: it.loose_piece_qty,
            units_per_case_snapshot: it.units_per_case_snapshot,
            total_units: it.case_qty * (it.units_per_case_snapshot || 1) + it.loose_piece_qty,
            unit_cost: it.unit_cost, reason: it.reason, condition: it.condition, photo_url: null, notes: it.notes,
        })) as ReturnCaseItem[],
        created_at: rc?.created_at || new Date().toISOString(),
        created_by_name: rc?.created_by_name || userProfile.full_name || null,
    } as ReturnCase)

    const previewPdf = () => generateReturnPdf(makePdfCase(), { instructionText: meta.settings.pdf_instruction_text, preview: true })
    const downloadPdf = () => generateReturnPdf(makePdfCase(), { instructionText: meta.settings.pdf_instruction_text, preview: false })

    // ── Excel bulk data-entry ──
    const buildExcelContext = useCallback((): ReturnExcelContext => ({
        returnId: currentId,
        returnNo: rc?.return_no || null,
        sourceType,
        shopId: (meta.isManager ? shopId : meta.userOrgId) || shopId,
        shopCode: selectedShop?.org_code || null,
        shopName: selectedShop?.org_name || null,
        contactName: contactPerson || selectedShop?.contact_name || null,
        contactPhone: contactPhone || selectedShop?.contact_phone || null,
        contactEmail: contactEmail || selectedShop?.contact_email || null,
        warehouseId: warehouseId || null,
        warehouseCode: selectedWarehouse?.org_code || null,
        warehouseName: selectedWarehouse?.org_name || null,
        reportedDate: reportedDate || null,
        programCode: program?.code || null,
        programName: program?.name || null,
        categoryId: category?.id || null,
        categoryName: category?.category_name || null,
        organizationId: meta.userOrgId || null,
        instructionText: meta.settings.pdf_instruction_text,
        reasons: meta.reasons.map((r) => ({ code: r.code, label: r.label })),
        conditions: meta.conditions.map((c) => ({ code: c.code, label: c.label })),
    }), [currentId, rc?.return_no, meta.isManager, meta.userOrgId, meta.reasons, meta.conditions, meta.settings.pdf_instruction_text, sourceType, shopId, selectedShop, contactPerson, contactPhone, contactEmail, warehouseId, selectedWarehouse, reportedDate, program, category])

    // Excel actions unlock only once the mandatory return context is resolved.
    const excelReady = useMemo(() => (
        !!shopId && !!warehouseId && !!reportedDate && !!program && !!category
        && rows.length > 0 && !eligibleLoading
    ), [shopId, warehouseId, reportedDate, program, category, rows.length, eligibleLoading])

    const downloadExcel = async () => {
        if (!excelReady) return
        setExcelBusy(true)
        try {
            const ctx = buildExcelContext()
            const blob = await exportReturnWorkbookBlob(ctx, rows)
            const url = URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = url
            link.download = buildReturnExcelFilename(ctx)
            document.body.appendChild(link)
            link.click()
            link.remove()
            window.setTimeout(() => URL.revokeObjectURL(url), 1000)
            toast({ title: 'Excel template downloaded', description: link.download })
        } catch (e: any) {
            toast({ title: 'Excel download failed', description: e.message, variant: 'destructive' })
        } finally {
            setExcelBusy(false)
        }
    }

    const importExcel = async (file: File) => {
        if (!excelReady) return
        setExcelBusy(true)
        try {
            const ctx = buildExcelContext()
            const result = await parseReturnWorkbook(file, ctx, rows)
            setImportResult(result)
        } catch (e: any) {
            toast({ title: 'Could not read Excel file', description: e.message, variant: 'destructive' })
        } finally {
            setExcelBusy(false)
        }
    }

    const applyImport = () => {
        const result = importResult
        if (!result || !result.ok || result.updates.length === 0) { setImportResult(null); return }
        const updatesByKey = new Map(result.updates.map((u) => [u.rowKey, u]))
        setRows((prev) => prev.map((r) => {
            const u = updatesByKey.get(r.key)
            if (!u) return r
            return recomputeRow({
                ...r,
                entry_unit: u.entry_unit,
                entered_pcs: u.entered_pcs,
                entered_box_qty: u.entered_box_qty,
                entered_extra_pcs: u.entered_extra_pcs,
                reason: u.reason,
                condition: u.condition,
                notes: u.notes,
            })
        }))
        setUnsavedChanges(true)
        setImportResult(null)
        toast({ title: 'Excel imported successfully', description: 'Review the updated return items before saving.' })
    }

    const nextActionLabel = RETURN_NEXT_ACTION_LABEL[status]
    const canAdvance = canAdvanceStatus(status, meta.isManager)

    if (loading) {
        return <div className="flex items-center justify-center p-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
    }

    const shopName = selectedShop?.org_name || rc?.source?.org_name || rc?.shop?.org_name || '—'

    return (
        <div className="sera-sc-page space-y-4">
            {/* Header bar */}
            <header className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="flex items-start gap-2 min-w-0">
                    <Button variant="ghost" size="icon" onClick={onBack} className="shrink-0 mt-0.5 border border-transparent hover:border-[var(--sera-line)]"><ArrowLeft className="h-4 w-4" /></Button>
                    <div className="min-w-0">
                        <p className="text-[11px] font-medium tracking-[0.16em] uppercase text-[var(--sera-muted)] mb-1">Quality · Returns</p>
                        <div className="flex items-center gap-2 flex-wrap">
                            <h1 className="font-display text-2xl font-semibold text-[var(--sera-ink)]">Return Product</h1>
                            <StatusBadge status={status} />
                        </div>
                        <p className="text-sm text-[var(--sera-muted)] mt-0.5">Create and manage product return cases from shops to warehouse.</p>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {unsavedChanges && !readOnly && (
                        <Badge variant="outline" className="border-[var(--sera-orange)]/30 bg-[var(--sera-orange)]/8 text-[var(--sera-orange-deep)]">
                            Unsaved changes
                        </Badge>
                    )}
                    {!readOnly && (
                        <Button variant="outline" onClick={() => saveDraft()} disabled={saving} className="gap-1.5">
                            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Draft
                        </Button>
                    )}
                    <Button
                        variant="outline" onClick={downloadExcel}
                        disabled={!excelReady || excelBusy}
                        title={excelReady ? 'Download the Excel worksheet for this return' : 'Complete the required Return Information before using Excel.'}
                        className="gap-1.5"
                    >
                        {excelBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Download Excel Template
                    </Button>
                    {!readOnly && (
                        <Button
                            variant="outline" onClick={() => excelInputRef.current?.click()}
                            disabled={!excelReady || excelBusy}
                            title={excelReady ? 'Import an updated Excel worksheet' : 'Complete the required Return Information before using Excel.'}
                            className="gap-1.5"
                        >
                            <Upload className="h-4 w-4" /> Import Updated Excel
                        </Button>
                    )}
                    <input
                        ref={excelInputRef} type="file" accept=".xlsx" className="hidden"
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) importExcel(f); e.target.value = '' }}
                    />
                    <Button variant="outline" onClick={previewPdf} className="gap-1.5"><Eye className="h-4 w-4" /> Preview PDF</Button>
                    <Button variant="outline" onClick={downloadPdf} className="gap-1.5"><FileText className="h-4 w-4" /> Generate PDF</Button>
                    {nextActionLabel && canAdvance && (
                        <Button onClick={advance} disabled={advancing || saving} className="gap-1.5 bg-[var(--sera-orange)] hover:bg-[var(--sera-orange-deep)] text-white">
                            {advancing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {nextActionLabel}
                        </Button>
                    )}
                    {currentId && !readOnly && (
                        <Button variant="ghost" size="icon" onClick={cancelReturn} className="text-red-600 hover:text-red-700" title="Cancel Return">
                            <Ban className="h-4 w-4" />
                        </Button>
                    )}
                </div>
            </header>

            {!excelReady && !readOnly && (
                <div className="flex items-center gap-2 rounded-lg border border-[var(--sera-line)] bg-[var(--sera-ink)]/[0.03] px-3 py-2 text-xs text-[var(--sera-muted)]">
                    <Info className="h-3.5 w-3.5 shrink-0" />
                    Complete the required Return Information before using Excel.
                </div>
            )}

            {/* Import preview dialog */}
            <ReturnExcelImportDialog
                result={importResult}
                onCancel={() => setImportResult(null)}
                onApply={applyImport}
            />

            {/* Stepper */}
            <div className="rounded-lg sera-sc-panel overflow-hidden p-4">
                <ReturnStatusStepper status={status} />
            </div>

            {/* Return Information */}
            <section className="rounded-lg sera-sc-panel overflow-hidden p-4">
                <div className="mb-3 flex items-center gap-2">
                    <PackageOpen className="h-4 w-4 text-muted-foreground" />
                    <h2 className="text-sm font-semibold text-[var(--sera-ink)]">Return Information</h2>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <Field label="Return From Type" required>
                        {meta.isManager ? (
                            <div className="inline-flex rounded-md border border-input p-0.5" role="radiogroup" aria-label="Return From Type">
                                {(['shop', 'distributor'] as ReturnSourceType[]).map((t) => (
                                    <button
                                        key={t}
                                        type="button"
                                        role="radio"
                                        aria-checked={sourceType === t}
                                        disabled={!isDraft}
                                        onClick={() => changeSourceType(t)}
                                        className={cn(
                                            'rounded px-4 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                                            sourceType === t ? 'bg-[var(--sera-orange)] text-white' : 'text-[var(--sera-muted)] hover:text-[var(--sera-ink)]',
                                        )}
                                    >
                                        {RETURN_SOURCE_LABELS[t]}
                                    </button>
                                ))}
                            </div>
                        ) : (
                            <Input value={sourceLabel} readOnly disabled />
                        )}
                    </Field>
                    <Field label={`Return From ${sourceLabel}`} required>
                        {meta.isManager ? (
                            <ReturnSourceCombobox
                                sourceType={sourceType}
                                value={shopId || null}
                                selectedOrg={selectedShop}
                                onSelect={(org) => void selectSourceOrg(org)}
                                disabled={!isDraft}
                            />
                        ) : (
                            <Input value={shopName} readOnly disabled />
                        )}
                        {selectedShop?.address && (
                            <span className="mt-1 block text-xs text-muted-foreground">{[selectedShop.address, selectedShop.city, selectedShop.postal_code].filter(Boolean).join(', ')}</span>
                        )}
                    </Field>
                    <Field label="Return Warehouse" required>
                        <Select value={warehouseId} onValueChange={setWarehouseId} disabled={readOnly || warehouseLocked || warehouseOptions.length === 0}>
                            <SelectTrigger><SelectValue placeholder="Select warehouse" /></SelectTrigger>
                            <SelectContent>
                                {warehouseOptions.map((w) => (
                                    <SelectItem key={w.id} value={w.id}>
                                        {w.org_name}{w.org_code ? ` (${w.org_code})` : ''}{w.inactive ? ' — Inactive' : ''}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        {warehouseOptions.length === 0 && (
                            <span className="mt-1 block text-xs text-amber-600 dark:text-amber-400">
                                No active Serapod HQ warehouse available
                            </span>
                        )}
                        {warehouseLocked && (
                            <span className="mt-1 block text-xs text-muted-foreground">
                                Return warehouse is locked after inventory receipt/posting.
                            </span>
                        )}
                        {selectedWarehouse?.inactive && (
                            <span className="mt-1 block text-xs text-amber-600 dark:text-amber-400">
                                This warehouse is inactive — retained from the original return.
                            </span>
                        )}
                        {selectedWarehouse?.address && (
                            <span className="mt-1 block text-xs text-muted-foreground">
                                {[selectedWarehouse.address, selectedWarehouse.city, selectedWarehouse.postal_code].filter(Boolean).join(', ')}
                            </span>
                        )}
                    </Field>
                    <Field label="Contact Person">
                        <Input value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} disabled={readOnly} placeholder="Name" />
                    </Field>
                    <Field label="Contact Phone">
                        <Input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} disabled={readOnly} placeholder="Phone" />
                    </Field>
                    <Field label="Reported Date" required>
                        <Input type="date" value={reportedDate} onChange={(e) => setReportedDate(e.target.value)} disabled={readOnly} />
                        <span className="mt-1 block text-xs text-muted-foreground">A historical date is allowed for cases received earlier (e.g. via WhatsApp).</span>
                    </Field>
                    <Field label="Return No.">
                        <Input value={rc?.return_no || 'Auto-generated on first save'} readOnly disabled />
                    </Field>
                    <Field label="Current Status">
                        <Input value={RETURN_STATUS_LABELS[status]} readOnly disabled />
                    </Field>
                    <ReadOnlyCard label="Program" value={program?.name || '—'} hint={`Auto-detected from selected ${sourceLabel.toLowerCase()}`} />
                    {categoryResolved || !shopId ? (
                        <ReadOnlyCard label="Category" value={category?.category_name || '—'} hint={`Auto-detected from selected ${sourceLabel.toLowerCase()}`} />
                    ) : (
                        <Field label="Category" required>
                            <Select value={manualCategoryId} onValueChange={selectManualCategory} disabled={readOnly || categorySelector.disabled}>
                                <SelectTrigger><SelectValue placeholder={categorySelector.placeholder} /></SelectTrigger>
                                <SelectContent>
                                    {categories.map((c) => (
                                        <SelectItem key={c.id} value={c.id}>{c.category_name}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            {categorySelector.empty && (
                                <span className="mt-1 block text-xs text-muted-foreground">No active product categories are available.</span>
                            )}
                            <span className="mt-1 block text-xs text-amber-600 dark:text-amber-400">
                                Category could not be auto-detected — please select one to load products.
                            </span>
                        </Field>
                    )}
                </div>

                {/* Shop master-data card + shortcut */}
                {selectedShop && (
                    <div className="mt-3 flex flex-col gap-3 rounded-lg sera-sc-panel overflow-hidden bg-[var(--sera-ink)]/[0.02] p-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex min-w-0 items-start gap-2.5">
                            <Store className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 text-sm">
                                <div className="font-medium text-foreground">
                                    {selectedShop.org_name || '—'}
                                    {selectedShop.org_code && <span className="ml-1 text-xs text-muted-foreground">({selectedShop.org_code})</span>}
                                </div>
                                <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                                    <span>Contact: {selectedShop.contact_name || '—'}</span>
                                    <span>Phone: {selectedShop.contact_phone || '—'}</span>
                                    <span>Email: {selectedShop.contact_email
                                        ? selectedShop.contact_email
                                        : <span className="text-amber-600 dark:text-amber-400">Email not updated yet</span>}</span>
                                </div>
                            </div>
                        </div>
                        {meta.isManager && (
                            <Button type="button" variant="outline" size="sm" onClick={openShopContactEditor} className="shrink-0 gap-1.5">
                                <ExternalLink className="h-3.5 w-3.5" /> Edit {sourceLabel} Contact
                            </Button>
                        )}
                    </div>
                )}
            </section>

            {/* Packing reference */}
            <PackingReference />

            {/* Worksheet */}
            <ReturnWorksheet
                rows={rows}
                meta={meta}
                readOnly={!isDraft}
                loading={eligibleLoading}
                summary={summary}
                shopSelected={!!shopId}
                supabase={supabase}
                onUpdate={updateRow}
                onRemoveExtra={removeExtraRow}
                onReset={resetQuantities}
                onAddOther={addOtherRow}
                onBulkApply={bulkApplyReasonCondition}
            />

            {/* Additional Notes */}
            <section className="rounded-lg sera-sc-panel overflow-hidden p-4">
                <h2 className="mb-2 text-sm font-semibold text-[var(--sera-ink)]">Additional Notes</h2>
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={readOnly} rows={3} placeholder="General return notes…" />
            </section>

            {/* Warehouse Processing */}
            {showsWarehouseProcessing(status) && (
                <section className="rounded-lg sera-sc-panel overflow-hidden p-4">
                    <h2 className="mb-3 text-sm font-semibold text-[var(--sera-ink)]">Warehouse Processing</h2>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Received Date"><Input type="date" value={wh.received_date} onChange={(e) => setWh({ ...wh, received_date: e.target.value })} disabled={readOnly || !meta.isManager} /></Field>
                        <Field label="Received By"><Input value={wh.received_by} onChange={(e) => setWh({ ...wh, received_by: e.target.value })} disabled={readOnly || !meta.isManager} /></Field>
                        <Field label="Action Taken"><Input value={wh.action_taken} onChange={(e) => setWh({ ...wh, action_taken: e.target.value })} disabled={readOnly || !meta.isManager} placeholder="e.g. Replaced, Refunded, Scrapped" /></Field>
                        <Field label="Return/Replacement Courier"><Input value={wh.return_courier} onChange={(e) => setWh({ ...wh, return_courier: e.target.value })} disabled={readOnly || !meta.isManager} /></Field>
                        <Field label="Tracking No."><Input value={wh.tracking_no} onChange={(e) => setWh({ ...wh, tracking_no: e.target.value })} disabled={readOnly || !meta.isManager} /></Field>
                        <Field label="Completed Date"><Input type="date" value={wh.completed_date} onChange={(e) => setWh({ ...wh, completed_date: e.target.value })} disabled={readOnly || !meta.isManager} /></Field>
                        <div className="sm:col-span-2">
                            <Field label="Processing Notes"><Textarea value={wh.processing_notes} onChange={(e) => setWh({ ...wh, processing_notes: e.target.value })} disabled={readOnly || !meta.isManager} rows={2} /></Field>
                        </div>
                    </div>
                </section>
            )}

            {/* Timeline */}
            {rc?.status_history && rc.status_history.length > 0 && (
                <section className="rounded-lg sera-sc-panel overflow-hidden p-4">
                    <h2 className="mb-3 text-sm font-semibold text-[var(--sera-ink)]">Return Case Timeline</h2>
                    <ol className="space-y-3">
                        {rc.status_history.map((h) => (
                            <li key={h.id} className="flex gap-2 text-sm">
                                <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[var(--sera-orange)]" />
                                <div>
                                    <div className="font-medium text-[var(--sera-ink)]">{RETURN_STATUS_LABELS[h.to_status as ReturnStatus] || h.to_status}</div>
                                    <div className="text-xs text-[var(--sera-muted)]">
                                        {new Date(h.changed_at).toLocaleString('en-MY')}
                                        {h.changed_by_name ? ` • ${h.changed_by_name}` : ''}
                                    </div>
                                    {h.notes && <div className="text-xs text-[var(--sera-muted)]">{h.notes}</div>}
                                </div>
                            </li>
                        ))}
                    </ol>
                </section>
            )}
        </div>
    )
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
    return (
        <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{label}{required && <span className="text-red-500"> *</span>}</span>
            {children}
        </label>
    )
}

function ReadOnlyCard({ label, value, hint }: { label: string; value: string; hint: string }) {
    return (
        <div className="space-y-1">
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            <div className="rounded-md border border-[var(--sera-line)] bg-[var(--sera-ink)]/[0.03] px-3 py-2">
                <div className="text-sm font-medium text-[var(--sera-ink)]">{label}: {value}</div>
                <div className="mt-0.5 flex items-center gap-1 text-xs text-[var(--sera-muted)]"><Info className="h-3 w-3" /> {hint}</div>
            </div>
        </div>
    )
}

function PackingReference() {
    return (
        <div className="grid gap-3 lg:grid-cols-3">
            <div className="flex items-start gap-3 rounded-lg sera-sc-panel overflow-hidden p-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[var(--sera-orange)]/10"><Package className="h-5 w-5 text-[var(--sera-orange)]" /></div>
                <div>
                    <div className="text-sm font-semibold text-[var(--sera-ink)]">Enter Quantity in Pcs or Cases</div>
                    <div className="text-xs text-[var(--sera-muted)]">Choose Pcs mode to enter the total piece count, or Cases mode to enter full cases plus extra pieces.</div>
                </div>
            </div>
            <div className="flex items-start gap-3 rounded-lg sera-sc-panel overflow-hidden p-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[var(--sera-ink)]/5"><Boxes className="h-5 w-5 text-[var(--sera-ink)]" /></div>
                <div>
                    <div className="text-sm font-semibold text-[var(--sera-ink)]">Cases (4 Pcs)</div>
                    <div className="text-xs text-[var(--sera-muted)]">1 Case = 4 Pcs for Cellera Hero and Cellera Zero. Varies by product — see tooltip on each row.</div>
                </div>
            </div>
            <div className="flex items-start gap-3 rounded-lg sera-sc-panel overflow-hidden border border-[var(--sera-orange)]/20 bg-[var(--sera-orange)]/[0.05] p-4">
                <Lightbulb className="mt-0.5 h-5 w-5 shrink-0 text-[var(--sera-orange)]" />
                <div className="text-xs text-[var(--sera-orange-deep)]">
                    Total Pcs is auto-calculated. Switch between Pcs and Cases mode without losing your quantity.
                </div>
            </div>
        </div>
    )
}

// ─────────────────────────── Worksheet ───────────────────────────

interface ExtraProductOption {
    product_id: string | null
    variant_id: string | null
    sku: string | null
    manual_sku: string | null
    manufacturer_sku: string | null
    barcode: string | null
    product_name: string
    variant_name: string | null
    variant_product_code: string | null
    alternative_name: string | null
    image_url: string | null
    units_per_case: number
    unit_cost: number
    is_active: boolean
}

function ReturnWorksheet({
    rows, meta, readOnly, loading, summary, shopSelected, supabase,
    onUpdate, onRemoveExtra, onReset, onAddOther, onBulkApply,
}: {
    rows: WorksheetRow[]
    meta: ReturnMeta
    readOnly: boolean
    loading: boolean
    summary: { entered: number; totalRows: number; totalCase: number; totalLoose: number; totalPcs: number; value: number }
    shopSelected: boolean
    supabase: ReturnType<typeof createClient>
    onUpdate: (key: string, patch: Partial<WorksheetRow>) => void
    onRemoveExtra: (key: string) => void
    onReset: () => void
    onAddOther: (v: ExtraProductOption) => void
    onBulkApply: (reason: string | null, condition: string | null) => void
}) {
    const [search, setSearch] = useState('')
    const [viewMode, setViewMode] = useState<'all' | 'entered'>('all')
    const [hideEmpty, setHideEmpty] = useState(false)
    const [showAddOther, setShowAddOther] = useState(false)
    const [lineTab, setLineTab] = useState<'all' | 'hero' | 'zero' | 'sbox' | 'sline'>('all')
    const [bulkReason, setBulkReason] = useState('')
    const [bulkCondition, setBulkCondition] = useState('')

    const lineCounts = useMemo(() => {
        let hero = 0, zero = 0, sbox = 0, sline = 0
        for (const r of rows) {
            if (r.isExtra) continue
            if (r.product_line === 'hero') hero += 1
            else if (r.product_line === 'zero') zero += 1
            else if (r.product_line === 'sbox') sbox += 1
            else if (r.product_line === 'sline') sline += 1
        }
        return { hero, zero, sbox, sline, all: hero + zero + sbox + sline }
    }, [rows])

    const visibleRows = useMemo(() => {
        const q = search.trim().toLowerCase()
        return rows.filter((r) => {
            if (lineTab !== 'all' && r.product_line !== lineTab) return false
            const total = rowTotal(r)
            if (viewMode === 'entered' && total <= 0) return false
            if (hideEmpty && total <= 0) return false
            if (q) {
                // The Product Line and Internal SKU columns are gone from the
                // table, not from the data: both stay searchable, alongside the
                // variant Product Code and Alternative Name now on screen.
                const hay = [
                    getVariantDisplayName(r.variant_name), r.variant_name, r.product_name,
                    r.variant_product_code, r.alternative_name,
                    r.manual_sku, r.manufacturer_sku, r.sku, r.barcode,
                    r.product_line, productLineLabel(r.product_line),
                ].filter(Boolean).join(' ').toLowerCase()
                if (!hay.includes(q)) return false
            }
            return true
        })
    }, [rows, search, viewMode, hideEmpty, lineTab])

    return (
        <section className="rounded-lg sera-sc-panel overflow-hidden p-4">
            <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                <div>
                    <h2 className="text-sm font-semibold text-[var(--sera-ink)]">Return Items (Worksheet)</h2>
                    <p className="text-xs text-muted-foreground">All available flavours and devices for the selected category are preloaded below.</p>
                </div>
                <div className="flex items-center gap-2">
                    <span className="hidden text-xs font-medium text-muted-foreground sm:inline">Product Line</span>
                    <div className="inline-flex overflow-hidden rounded-md border border-[var(--sera-line)]">
                        <LineTab label="All Items" count={lineCounts.all} active={lineTab === 'all'} onClick={() => setLineTab('all')} />
                        <LineTab label="Hero" count={lineCounts.hero} active={lineTab === 'hero'} onClick={() => setLineTab('hero')} />
                        <LineTab label="Zero" count={lineCounts.zero} active={lineTab === 'zero'} onClick={() => setLineTab('zero')} />
                        <LineTab label="S.Box" count={lineCounts.sbox} active={lineTab === 'sbox'} onClick={() => setLineTab('sbox')} />
                        <LineTab label="S.Line" count={lineCounts.sline} active={lineTab === 'sline'} onClick={() => setLineTab('sline')} />
                    </div>
                </div>
            </div>

            {/* Toolbar */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="relative min-w-[220px] flex-1">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input placeholder="Search flavour, device variant, Internal SKU or barcode" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8" />
                </div>
                <button
                    type="button"
                    onClick={() => setViewMode((v) => (v === 'entered' ? 'all' : 'entered'))}
                    className={cn('rounded-md border border-[var(--sera-line)] px-3 py-1.5 text-xs font-medium', viewMode === 'entered' ? 'bg-[var(--sera-orange)] text-white' : 'bg-white text-[var(--sera-muted)] hover:bg-[var(--sera-ink)]/[0.03]')}
                >
                    Entered Items Only
                </button>
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground">
                    <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} className="h-3.5 w-3.5" />
                    Hide Empty Rows
                </label>
                {!readOnly && (
                    <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setShowAddOther((v) => !v)}>
                        <Plus className="h-4 w-4" /> Add Other Product
                    </Button>
                )}
            </div>

            {showAddOther && !readOnly && (
                <AddOtherProduct supabase={supabase} onAdd={(v) => { onAddOther(v); }} onClose={() => setShowAddOther(false)} />
            )}

            {/* Bulk update panel — applies Reason/Condition to every entered row (Total Pcs > 0). */}
            {!readOnly && (
                <div className="mb-3 flex flex-col gap-3 rounded-lg sera-sc-panel overflow-hidden bg-[var(--sera-orange)]/[0.04] border border-[var(--sera-orange)]/15 p-3 lg:flex-row lg:items-end">
                    <div className="flex items-center gap-2 lg:min-w-[220px]">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--sera-orange)]/10 text-[var(--sera-orange)]">
                            <Zap className="h-4 w-4" />
                        </div>
                        <div>
                            <div className="text-sm font-semibold text-foreground">Bulk update entered items</div>
                            <div className="text-xs text-muted-foreground">Only rows with qty &gt; 0 will be updated.</div>
                        </div>
                    </div>
                    <div className="flex flex-1 flex-col gap-3 sm:flex-row sm:items-end">
                        <label className="block flex-1 space-y-1">
                            <span className="text-xs font-medium text-muted-foreground">Reason</span>
                            <Select value={bulkReason} onValueChange={setBulkReason}>
                                <SelectTrigger className="h-8"><SelectValue placeholder="Select reason…" /></SelectTrigger>
                                <SelectContent>{meta.reasons.map((x) => <SelectItem key={x.code} value={x.code}>{x.label}</SelectItem>)}</SelectContent>
                            </Select>
                        </label>
                        <label className="block flex-1 space-y-1">
                            <span className="text-xs font-medium text-muted-foreground">Condition</span>
                            <Select value={bulkCondition} onValueChange={setBulkCondition}>
                                <SelectTrigger className="h-8"><SelectValue placeholder="Select condition…" /></SelectTrigger>
                                <SelectContent>{meta.conditions.map((x) => <SelectItem key={x.code} value={x.code}>{x.label}</SelectItem>)}</SelectContent>
                            </Select>
                        </label>
                        <Button
                            type="button"
                            size="sm"
                            className="gap-1.5 bg-[var(--sera-orange)] hover:bg-[var(--sera-orange-deep)] text-white"
                            disabled={!bulkReason && !bulkCondition}
                            onClick={() => onBulkApply(bulkReason || null, bulkCondition || null)}
                        >
                            <Wand2 className="h-4 w-4" /> Apply to Entered Items
                        </Button>
                    </div>
                </div>
            )}

            {/* Table */}
            <div className="overflow-x-auto sera-sc-panel overflow-hidden">
                <table className="sera-sc-table w-full text-sm">
                    <thead className="text-left text-xs uppercase text-[var(--sera-muted)]">
                        <tr>
                            <th className="px-2 py-2 font-medium">No.</th>
                            <th className="px-2 py-2 font-medium">Image</th>
                            <th className="px-2 py-2 font-medium">Product Name</th>
                            <th className="px-2 py-2 font-medium" style={{ minWidth: 200 }}>Return Qty</th>
                            <th className="px-2 py-2 font-medium">Breakdown</th>
                            <th className="px-2 py-2 font-medium">Total Pcs</th>
                            <th className="px-2 py-2 font-medium">Reason</th>
                            <th className="px-2 py-2 font-medium">Condition</th>
                            <th className="px-2 py-2 font-medium">Notes</th>
                            {!readOnly && <th className="px-2 py-2" />}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                        {loading ? (
                            <tr><td colSpan={10} className="px-2 py-10 text-center text-muted-foreground"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>
                        ) : !shopSelected ? (
                            <tr><td colSpan={10} className="px-2 py-10 text-center text-muted-foreground">Select a shop or distributor to load its eligible products.</td></tr>
                        ) : visibleRows.length === 0 ? (
                            <tr><td colSpan={10} className="px-2 py-10 text-center text-muted-foreground">No products match the current view.</td></tr>
                        ) : visibleRows.map((r, i) => {
                            const total = rowTotal(r)
                            const entered = total > 0
                            const needsReason = entered && !r.reason
                            const needsCondition = entered && !r.condition
                            const upb = r.units_per_case > 0 ? r.units_per_case : 1
                            return (
                                <tr key={r.key} className={cn('align-top', entered && 'bg-emerald-50/60 dark:bg-emerald-900/10')}>
                                    <td className="px-2 py-2 text-muted-foreground">{i + 1}</td>
                                    <td className="px-2 py-2"><ProductThumb url={r.image_url} /></td>
                                    <td className="px-2 py-2">
                                        <div
                                            className="min-w-0"
                                            title={[
                                                `Product: ${r.product_name}`,
                                                r.variant_name ? `Full Variant: ${r.variant_name}` : null,
                                                `Product Line: ${productLineLabel(r.product_line)}`,
                                                r.manual_sku ? `Internal SKU: ${r.manual_sku}` : 'Internal SKU: not assigned',
                                                r.manufacturer_sku ? `Manufacturer SKU: ${r.manufacturer_sku}` : null,
                                                r.barcode ? `Barcode: ${r.barcode}` : null,
                                            ].filter(Boolean).join('\n')}
                                        >
                                            <div className="font-medium text-foreground">{r.product_name}</div>
                                            <div className="text-xs text-muted-foreground">
                                                {variantIdentityLabel(r.variant_name, r.variant_product_code)}
                                            </div>
                                            {variantAlternativeLabel(r.alternative_name) && (
                                                <div className="text-xs text-muted-foreground/80">
                                                    {variantAlternativeLabel(r.alternative_name)}
                                                </div>
                                            )}
                                            {!r.is_active && <Badge variant="outline" className="mt-0.5 text-[10px]">Inactive</Badge>}
                                        </div>
                                    </td>
                                    <td className="px-2 py-2">
                                        {readOnly ? (
                                            <div className="text-sm">
                                                {r.entry_unit === 'pcs'
                                                    ? `${r.entered_pcs} Pcs`
                                                    : `${r.entered_box_qty} ${caseUnitLabel(r.entered_box_qty)}${r.entered_extra_pcs > 0 ? ` + ${r.entered_extra_pcs} Pcs` : ''}`}
                                            </div>
                                        ) : (
                                            <QuantityCell
                                                row={r}
                                                onUpdate={(patch) => onUpdate(r.key, patch)}
                                            />
                                        )}
                                    </td>
                                    <td className="px-2 py-2 text-center text-xs text-muted-foreground">
                                        {!isCartridgeLine(r.product_line)
                                            ? '—'
                                            : entered ? `${r.case_qty} ${caseUnitLabel(r.case_qty)} + ${r.loose_piece_qty} Pc${r.loose_piece_qty !== 1 ? 's' : ''}` : '—'}
                                    </td>
                                    <td className="px-2 py-2 text-center font-semibold text-foreground">{total}</td>
                                    <td className="px-2 py-2">
                                        {readOnly ? (meta.reasons.find((x) => x.code === r.reason)?.label || r.reason || '—') : (
                                            <Select value={r.reason || ''} onValueChange={(v) => onUpdate(r.key, { reason: v })}>
                                                <SelectTrigger className={cn('h-8 min-w-[130px]', needsReason && 'border-red-400')} disabled={!entered}>
                                                    <SelectValue placeholder="Select reason" />
                                                </SelectTrigger>
                                                <SelectContent>{meta.reasons.map((x) => <SelectItem key={x.code} value={x.code}>{x.label}</SelectItem>)}</SelectContent>
                                            </Select>
                                        )}
                                    </td>
                                    <td className="px-2 py-2">
                                        {readOnly ? (meta.conditions.find((x) => x.code === r.condition)?.label || r.condition || '—') : (
                                            <Select value={r.condition || ''} onValueChange={(v) => onUpdate(r.key, { condition: v })}>
                                                <SelectTrigger className={cn('h-8 min-w-[130px]', needsCondition && 'border-red-400')} disabled={!entered}>
                                                    <SelectValue placeholder="Select condition" />
                                                </SelectTrigger>
                                                <SelectContent>{meta.conditions.map((x) => <SelectItem key={x.code} value={x.code}>{x.label}</SelectItem>)}</SelectContent>
                                            </Select>
                                        )}
                                    </td>
                                    <td className="px-2 py-2">
                                        {readOnly ? (r.notes || '—') : (
                                            <Input value={r.notes || ''} onChange={(e) => onUpdate(r.key, { notes: e.target.value })} placeholder="—" className="h-8 min-w-[120px]" />
                                        )}
                                    </td>
                                    {!readOnly && (
                                        <td className="px-2 py-2 text-right">
                                            {r.isExtra ? (
                                                <Button variant="ghost" size="icon" className="h-8 w-8 text-red-600" onClick={() => onRemoveExtra(r.key)} title="Remove"><Trash2 className="h-4 w-4" /></Button>
                                            ) : (
                                                <span className="text-xs text-muted-foreground">—</span>
                                            )}
                                        </td>
                                    )}
                                </tr>
                            )
                        })}
                    </tbody>
                </table>
            </div>

            {/* Summary */}
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
                <SummaryCard label="Total Products Entered" value={`${summary.entered} / ${summary.totalRows}`} />
                <SummaryCard label={`Total Qty (${CASE_UNIT_LABEL})`} value={String(summary.totalCase)} />
                <SummaryCard label="Total Qty (Loose Pcs)" value={String(summary.totalLoose)} />
                <SummaryCard label="Total Pcs" value={String(summary.totalPcs)} />
                <SummaryCard label="Estimated Return Value (RM)" value={formatReturnAmount(summary.value)} />
                <div className="flex items-center">
                    {!readOnly && (
                        <Button variant="outline" onClick={onReset} className="w-full gap-1.5"><RotateCcw className="h-4 w-4" /> Reset Quantities</Button>
                    )}
                </div>
            </div>
        </section>
    )
}

// ── Quantity Cell (Pcs/Cases mode) ──

function QuantityCell({ row, onUpdate }: { row: WorksheetRow; onUpdate: (patch: Partial<WorksheetRow>) => void }) {
    const [unit, setUnit] = useState<EntryUnit>(row.entry_unit)
    const upb = row.units_per_case > 0 ? row.units_per_case : 1

    // Cases / Pcs is only for vape cartridges (Cellera Hero / Zero). Devices
    // and every other product are PCS-only — no mode selector, no Cases.
    if (!isCartridgeLine(row.product_line)) {
        return (
            <div className="flex items-center gap-1.5">
                <Input
                    type="number" min={0}
                    value={row.entered_pcs || ''}
                    onChange={(e) => onUpdate({ entry_unit: 'pcs', entered_pcs: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                    className="h-8 w-16 text-center"
                />
                <Badge variant="secondary" className="h-6 px-2 text-[11px] font-medium">PCS</Badge>
            </div>
        )
    }

    // When unit changes: preserve total pieces
    const handleUnitChange = (newUnit: EntryUnit) => {
        if (newUnit === unit) return
        setUnit(newUnit)
        if (newUnit === 'pcs') {
            // Switch from Cases to Pcs: preserve total
            const totalPcs = row.total_units
            onUpdate({ entry_unit: 'pcs', entered_pcs: totalPcs, entered_box_qty: 0, entered_extra_pcs: 0 })
        } else {
            // Switch from Pcs to Cases: preserve total
            const boxQty = Math.floor(row.total_units / upb)
            const extraPcs = row.total_units % upb
            onUpdate({ entry_unit: 'box', entered_pcs: row.total_units, entered_box_qty: boxQty, entered_extra_pcs: extraPcs })
        }
    }

    if (unit === 'pcs') {
        return (
            <div className="flex items-center gap-1">
                <Input
                    type="number" min={0}
                    value={row.entered_pcs || ''}
                    onChange={(e) => onUpdate({ entry_unit: 'pcs', entered_pcs: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                    className="h-8 w-16 text-center"
                />
                <Select value="pcs" onValueChange={(v) => handleUnitChange(v as EntryUnit)}>
                    <SelectTrigger className="h-8 w-16">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="pcs">Pcs</SelectItem>
                        <SelectItem value="box">Cases</SelectItem>
                    </SelectContent>
                </Select>
                <span title={`1 Case = ${upb} Pcs`} className="cursor-help text-[10px] text-muted-foreground">
                    <Info className="inline h-3 w-3" />
                </span>
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
                <Input
                    type="number" min={0}
                    value={row.entered_box_qty || ''}
                    onChange={(e) => onUpdate({ entry_unit: 'box', entered_box_qty: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                    className="h-8 w-14 text-center"
                />
                <Select value="box" onValueChange={(v) => handleUnitChange(v as EntryUnit)}>
                    <SelectTrigger className="h-8 w-16">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="pcs">Pcs</SelectItem>
                        <SelectItem value="box">Cases</SelectItem>
                    </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground">+</span>
                <Input
                    type="number" min={0}
                    value={row.entered_extra_pcs || ''}
                    onChange={(e) => onUpdate({ entry_unit: 'box', entered_extra_pcs: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                    className="h-8 w-14 text-center"
                    placeholder="Extra"
                />
                <span className="text-xs text-muted-foreground">Pcs</span>
                <span title={`1 Case = ${upb} Pcs`} className="cursor-help text-[10px] text-muted-foreground">
                    <Info className="inline h-3 w-3" />
                </span>
            </div>
            {row.entered_extra_pcs >= upb && (
                <div className="text-[10px] leading-tight text-muted-foreground">
                    {row.entered_extra_pcs} Extra Pcs normalised to {row.entered_box_qty} {caseUnitLabel(row.entered_box_qty)} + {row.entered_extra_pcs} Pcs
                </div>
            )}
        </div>
    )
}

// ── Excel import preview dialog ──

function ReturnExcelImportDialog({
    result, onCancel, onApply,
}: {
    result: ReturnExcelImportResult | null
    onCancel: () => void
    onApply: () => void
}) {
    const open = !!result
    const s = result?.summary
    const blocked = !!result && (!result.ok)
    const rowsToShow = useMemo(() => {
        if (!result) return []
        // Surface problems first, then a sample of successful updates.
        const problems = result.rows.filter((r) => r.status === 'error' || r.status === 'warning')
        const updates = result.rows.filter((r) => r.status === 'update')
        return [...problems, ...updates].slice(0, 200)
    }, [result])

    return (
        <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel() }}>
            <DialogContent className="max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Import Excel — Review</DialogTitle>
                    <DialogDescription>
                        {blocked
                            ? 'The file could not be imported. Fix the issues below and try again — nothing has changed yet.'
                            : 'Review the parsed rows below. Matching worksheet rows will be updated; blank rows are ignored.'}
                    </DialogDescription>
                </DialogHeader>

                {result && result.fatalErrors.length > 0 && (
                    <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                        <div className="mb-1 font-medium">This template cannot be used for the current return:</div>
                        <ul className="list-inside list-disc space-y-0.5">
                            {result.fatalErrors.map((e, i) => <li key={i}>{e}</li>)}
                        </ul>
                    </div>
                )}

                {s && result!.fatalErrors.length === 0 && (
                    <>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                            <ImportStat label="With Quantity" value={s.withQuantity} tone="good" />
                            <ImportStat label="Valid Rows" value={s.valid} tone="good" />
                            <ImportStat label="Skipped Empty" value={s.skippedEmpty} tone="muted" />
                            <ImportStat label="Warnings" value={s.warnings} tone="warn" />
                            <ImportStat label="Errors" value={s.errors} tone="error" />
                        </div>

                        {rowsToShow.length > 0 && (
                            <div className="max-h-72 overflow-y-auto rounded-md border border-border">
                                <table className="w-full text-xs">
                                    <thead className="sticky top-0 bg-muted/70 text-left text-muted-foreground">
                                        <tr>
                                            <th className="px-2 py-1.5 font-medium">Row</th>
                                            <th className="px-2 py-1.5 font-medium">Product</th>
                                            <th className="px-2 py-1.5 font-medium">Status</th>
                                            <th className="px-2 py-1.5 font-medium">Detail</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-border">
                                        {rowsToShow.map((r, i) => (
                                            <tr key={i}>
                                                <td className="px-2 py-1.5 text-muted-foreground">{r.excelRow}</td>
                                                <td className="px-2 py-1.5">{r.label || r.identifier}</td>
                                                <td className="px-2 py-1.5"><ImportRowBadge status={r.status} /></td>
                                                <td className="px-2 py-1.5 text-muted-foreground">{r.message}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </>
                )}

                <DialogFooter>
                    <Button variant="outline" onClick={onCancel}>Cancel</Button>
                    <Button
                        onClick={onApply}
                        disabled={blocked || !result || result.updates.length === 0}
                        className="gap-1.5"
                    >
                        <CheckCircle2 className="h-4 w-4" />
                        Apply {result && result.updates.length > 0 ? `${result.updates.length} Row${result.updates.length !== 1 ? 's' : ''}` : ''}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    )
}

function ImportStat({ label, value, tone }: { label: string; value: number; tone: 'good' | 'muted' | 'warn' | 'error' }) {
    const toneCls = {
        good: 'text-emerald-600 dark:text-emerald-400',
        muted: 'text-muted-foreground',
        warn: 'text-amber-600 dark:text-amber-400',
        error: 'text-red-600 dark:text-red-400',
    }[tone]
    return (
        <div className="rounded-md border border-border bg-muted/30 p-2 text-center">
            <div className={cn('text-lg font-semibold', toneCls)}>{value}</div>
            <div className="text-[11px] text-muted-foreground">{label}</div>
        </div>
    )
}

function ImportRowBadge({ status }: { status: ReturnExcelImportResult['rows'][number]['status'] }) {
    if (status === 'update') return <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> Update</span>
    if (status === 'warning') return <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400"><AlertTriangle className="h-3.5 w-3.5" /> Warning</span>
    if (status === 'error') return <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400"><XCircle className="h-3.5 w-3.5" /> Error</span>
    return <span className="text-muted-foreground">Skipped</span>
}

function SummaryCard({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-lg border border-border bg-muted/30 p-3">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-1 text-lg font-semibold text-foreground">{value}</div>
        </div>
    )
}

function LineTab({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn('px-3 py-1.5 text-xs font-medium', active ? 'bg-[var(--sera-orange)] text-white' : 'bg-white text-[var(--sera-muted)] hover:bg-[var(--sera-ink)]/[0.03]')}
        >
            {label} ({count})
        </button>
    )
}

function ProductLineBadge({ line }: { line: ProductLine }) {
    if (line === 'other') {
        return <Badge variant="outline" className="text-[10px]">Other</Badge>
    }
    let styles: string
    if (line === 'hero') {
        styles = 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/40 dark:bg-blue-900/20 dark:text-blue-300'
    } else if (line === 'zero') {
        styles = 'border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-900/40 dark:bg-purple-900/20 dark:text-purple-300'
    } else {
        // S.Box / S.Line — neutral device treatment
        styles = 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800/40 dark:text-slate-300'
    }
    return <span className={cn('inline-flex rounded-md border px-2 py-0.5 text-[11px] font-medium', styles)}>{productLineLabel(line)}</span>
}

function ProductThumb({ url }: { url: string | null }) {
    const [err, setErr] = useState(false)
    if (!url || err) {
        return <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-muted"><Package className="h-4 w-4 text-muted-foreground" /></div>
    }
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" onError={() => setErr(true)} className="h-9 w-9 shrink-0 rounded object-cover" />
}

// ── Add Other Product ──

function AddOtherProduct({
    supabase, onAdd, onClose,
}: {
    supabase: ReturnType<typeof createClient>
    onAdd: (v: ExtraProductOption) => void
    onClose: () => void
}) {
    const { toast } = useToast()
    const [q, setQ] = useState('')
    const [opts, setOpts] = useState<ExtraProductOption[]>([])
    const [loading, setLoading] = useState(false)

    const load = useCallback(async () => {
        if (opts.length > 0) return
        setLoading(true)
        try {
            const { data, error } = await (supabase as any)
                .from('product_variants')
                .select('id, product_id, variant_name, product_code, alternative_name, barcode, manufacturer_sku, manual_sku, image_url, base_cost, is_active, products!inner(id, product_name, units_per_case), product_skus(sku_code, quantity_per_package, is_active)')
                .order('variant_name', { ascending: true })
                .limit(500)
            if (error) throw error
            const mapped: ExtraProductOption[] = (data || []).map((v: any) => {
                const activeSku = (v.product_skus || []).find((s: any) => s.is_active) || (v.product_skus || [])[0]
                const upc = Number(v.products?.units_per_case ?? activeSku?.quantity_per_package)
                return {
                    product_id: v.products?.id || v.product_id,
                    variant_id: v.id,
                    sku: activeSku?.sku_code || null,
                    manual_sku: v.manual_sku || null,
                    manufacturer_sku: v.manufacturer_sku || null,
                    barcode: v.barcode || null,
                    product_name: v.products?.product_name || 'Product',
                    variant_name: v.variant_name || null,
                    variant_product_code: v.product_code || null,
                    alternative_name: v.alternative_name || null,
                    image_url: v.image_url || null,
                    units_per_case: Number.isFinite(upc) && upc > 0 ? Math.floor(upc) : 1,
                    unit_cost: v.base_cost != null ? Number(v.base_cost) : 0,
                    is_active: v.is_active !== false,
                }
            })
            setOpts(mapped)
        } catch (e: any) {
            toast({ title: 'Failed to load products', description: e.message, variant: 'destructive' })
        } finally {
            setLoading(false)
        }
    }, [opts.length, supabase, toast])

    useEffect(() => { load() }, [load])

    const filtered = useMemo(() => {
        const s = q.trim().toLowerCase()
        const base = s ? opts.filter((o) => [getVariantDisplayName(o.variant_name), o.product_name, o.variant_name, o.manual_sku, o.manufacturer_sku, o.sku, o.barcode].filter(Boolean).join(' ').toLowerCase().includes(s)) : opts
        return base.slice(0, 30)
    }, [opts, q])

    return (
        <div className="mb-3 rounded-lg border border-border bg-muted/20 p-3">
            <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Add a product not in the auto-loaded list (inactive / legacy / exception)</span>
                <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
            </div>
            <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input placeholder="Search any product, variant, SKU or barcode" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
            </div>
            <div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-border bg-popover">
                {loading ? (
                    <div className="p-3 text-center text-sm text-muted-foreground"><Loader2 className="mx-auto h-4 w-4 animate-spin" /></div>
                ) : filtered.length === 0 ? (
                    <div className="p-3 text-center text-sm text-muted-foreground">No matches</div>
                ) : filtered.map((o) => (
                    <button key={o.variant_id || o.sku} type="button" onClick={() => onAdd(o)} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent">
                        <span className="min-w-0">
                            <span className="font-medium text-foreground">{getVariantDisplayName(o.variant_name) || o.product_name}</span>
                            <span className="text-muted-foreground"> · {o.product_name}{o.manual_sku ? ` · ${o.manual_sku}` : ''}</span>
                            {!o.is_active && <span className="ml-1 text-xs text-amber-600">(inactive)</span>}
                        </span>
                        <span className="text-xs text-muted-foreground">1 Case = {o.units_per_case}</span>
                    </button>
                ))}
            </div>
        </div>
    )
}
