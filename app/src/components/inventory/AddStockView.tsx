'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSupabaseAuth } from '@/lib/hooks/useSupabaseAuth'
import { usePermissions } from '@/hooks/usePermissions'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { useToast } from '@/components/ui/use-toast'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  AlertTriangle, ArrowLeft, CheckCircle2, Download, Eraser, Factory, PackagePlus,
  Search, Upload, Warehouse,
} from 'lucide-react'
import {
  MANUAL_STOCK_ADDITION_REASONS,
  additionValue,
  buildManualStockRpcItems,
  buildPostManualStockAdditionParams,
  catalogRowKey,
  configBadgeClass,
  configurationFilterKey,
  effectiveConfigurationFilterKey,
  filterManualStockCatalogRows,
  isHqManualStockAdmin,
  isSelectableManualStockConfiguration,
  mapCatalogRowFromQuery,
  newBalance,
  paginateRows,
  parseAddQuantity,
  parseUnitCost,
  summarizeManualStockSelection,
  type ManualStockCatalogRow,
  type ManualStockAdditionReason,
} from '@/lib/inventory/add-stock-inventory'
import {
  buildManualStockAdditionWorksheet,
  parseManualStockAdditionImport,
} from '@/lib/inventory/add-stock-excel'
import {
  variantAlternativeLabel,
  variantIdentityLabel,
} from '@/lib/inventory/variant-display-label'
import { withStockStrengthUnit } from '@/lib/inventory/stock-config-unit-label'
import { shouldShowConfigurationColumn } from '@/lib/inventory/canonical-stock-config'
import StockQuantityDisplay from '@/components/inventory/StockQuantityDisplay'
import { formatStockQuantity, resolveStockUnit, stockUnitForProduct } from '@/lib/inventory/stock-count-quantity'

/**
 * Unit the balance is stored in: cartridges are integer CASES, everything else
 * integer PIECES. Manual additions post in this unit, so the row says which one
 * is in play instead of leaving the operator to guess.
 */
const stockUnitLabel = (productName: string): string => stockUnitForProduct(productName)

/**
 * A catalog row's balance as a labelled pair. The unit is resolved from the
 * product line (shared rule), so a missing/defaulted pcs_per_case can never
 * relabel a Cellera case balance as pieces. Loose pieces carry through a
 * whole-unit addition unchanged.
 */
const rowBalanceQuantity = (
  row: { productName: string; pcsPerCase?: number | null; currentPcsOnHand?: number },
  cases: number,
) => {
  const resolved = resolveStockUnit({ productName: row.productName, balancePcsPerCase: row.pcsPerCase })
  return {
    cases,
    pcs: row.currentPcsOnHand ?? 0,
    pcsPerCase: resolved.pcsPerCase,
    unit: resolved.unit,
  }
}

interface WarehouseLocation {
  id: string
  org_code: string
  org_name: string
}

interface Manufacturer {
  id: string
  org_code: string
  org_name: string
}

interface AddStockViewProps {
  userProfile: any
  onViewChange?: (view: string) => void
}

const PAGE_SIZE = 25

export default function AddStockView({ userProfile, onViewChange }: AddStockViewProps) {
  const { isReady, supabase } = useSupabaseAuth()
  const { toast } = useToast()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [warehouses, setWarehouses] = useState<WarehouseLocation[]>([])
  const [manufacturers, setManufacturers] = useState<Manufacturer[]>([])
  const [selectedWarehouse, setSelectedWarehouse] = useState('')
  const [reason, setReason] = useState<ManualStockAdditionReason | ''>('')
  const [externalReference, setExternalReference] = useState('')
  const [warehouseLocationText, setWarehouseLocationText] = useState('')
  const [notes, setNotes] = useState('')
  const [selectedManufacturer, setSelectedManufacturer] = useState('')

  const [catalogRows, setCatalogRows] = useState<ManualStockCatalogRow[]>([])
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  // Loose pieces added on top of the whole units: "add 2 pcs" is a real stock
  // change, not a rounding detail, so it gets its own input and its own value.
  const [pcsQuantities, setPcsQuantities] = useState<Record<string, string>>({})
  const [unitCosts, setUnitCosts] = useState<Record<string, string>>({})
  const [rowNotes, setRowNotes] = useState<Record<string, string>>({})
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())

  const [search, setSearch] = useState('')
  const [productLine, setProductLine] = useState('all')
  const [manufacturerFilter, setManufacturerFilter] = useState('all')
  const [configurationKey, setConfigurationKey] = useState('all')
  const [activeOnly, setActiveOnly] = useState(true)
  const [quantityOnly, setQuantityOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [applyCostValue, setApplyCostValue] = useState('')

  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [posting, setPosting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [isHqAdmin, setIsHqAdmin] = useState(false)
  const [successBatchNo, setSuccessBatchNo] = useState<string | null>(null)
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const postingLockRef = useRef(false)

  const roleLevel = Number(userProfile?.roles?.role_level)
  const profileSaysHqAdmin = isHqManualStockAdmin(roleLevel)
  const { hasPermission, loading: permissionLoading } = usePermissions(
    userProfile?.roles?.role_level,
    userProfile?.roles?.role_code,
    userProfile?.department_id,
  )
  const canPost = !permissionLoading && (isHqAdmin || profileSaysHqAdmin || hasPermission('adjust_stock'))

  useEffect(() => {
    if (!isReady) return
    void loadWarehouses()
    void loadManufacturers()
    void supabase.rpc('is_hq_admin').then(({ data, error }) => {
      if (error) {
        setIsHqAdmin(profileSaysHqAdmin)
        return
      }
      setIsHqAdmin(Boolean(data) || profileSaysHqAdmin)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, profileSaysHqAdmin])

  useEffect(() => {
    if (!selectedWarehouse) {
      setCatalogRows([])
      return
    }
    void loadCatalog(selectedWarehouse)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWarehouse])

  const loadWarehouses = async () => {
    const { data, error } = await supabase
      .from('organizations')
      .select('id, org_code, org_name')
      .in('org_type_code', ['HQ', 'WH'])
      .eq('is_active', true)
      .order('org_name')
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' })
      return
    }
    setWarehouses(data || [])
  }

  const loadManufacturers = async () => {
    const { data, error } = await supabase
      .from('organizations')
      .select('id, org_code, org_name')
      .eq('org_type_code', 'MFG')
      .eq('is_active', true)
      .order('org_name')
    if (error) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' })
      return
    }
    setManufacturers(data || [])
  }

  const loadCatalog = async (warehouseId: string) => {
    try {
      setLoadingCatalog(true)
      const { data: configs, error } = await supabase
        .from('inventory_stock_configurations')
        .select(`
          id,
          config_label,
          stock_sku,
          volume_ml,
          packaging,
          config_code,
          status,
          variant_id,
          product_variants!inner (
            id,
            variant_name,
            variant_code,
            product_code,
            alternative_name,
            base_cost,
            product_id,
            products!inner (
              id,
              product_code,
              product_name,
              is_active,
              is_vape,
              manufacturer_id,
              product_groups (id, group_name),
              organizations:manufacturer_id (id, org_name)
            )
          )
        `)
        .eq('status', 'active')
        .order('sort_order')

      if (error) throw error

      const { data: inventory, error: inventoryError } = await supabase
        .from('product_inventory')
        .select('variant_id, stock_config_id, quantity_on_hand, pcs_on_hand, pcs_per_case, average_cost')
        .eq('organization_id', warehouseId)
        .eq('is_active', true)
      if (inventoryError) throw inventoryError

      const balanceByKey = new Map<string, {
        quantity_on_hand: number
        pcs_on_hand: number
        pcs_per_case: number | null
        average_cost: number | null
      }>()
      for (const row of (inventory || []) as any[]) {
        if (!row.stock_config_id) continue
        balanceByKey.set(catalogRowKey(row.variant_id, row.stock_config_id), {
          quantity_on_hand: Number(row.quantity_on_hand ?? 0),
          pcs_on_hand: Number(row.pcs_on_hand ?? 0) || 0,
          pcs_per_case: row.pcs_per_case === null || row.pcs_per_case === undefined
            ? null
            : Number(row.pcs_per_case),
          average_cost: row.average_cost === null || row.average_cost === undefined
            ? null
            : Number(row.average_cost),
        })
      }

      const rows: ManualStockCatalogRow[] = []
      for (const item of configs || []) {
        const mapped = mapCatalogRowFromQuery({
          quantity_on_hand: 0,
          average_cost: null,
          inventory_stock_configurations: item,
          product_variants: (item as any).product_variants,
        })
        if (!mapped) continue
        if (!isSelectableManualStockConfiguration(mapped)) continue
        const balance = balanceByKey.get(mapped.rowKey)
        rows.push({
          ...mapped,
          currentOnHand: balance?.quantity_on_hand ?? 0,
          currentPcsOnHand: balance?.pcs_on_hand ?? 0,
          pcsPerCase: balance?.pcs_per_case ?? null,
          averageCost: balance?.average_cost ?? null,
        })
      }

      rows.sort((a, b) =>
        a.productName.localeCompare(b.productName)
        || a.variantName.localeCompare(b.variantName)
        || a.configLabel.localeCompare(b.configLabel),
      )

      setCatalogRows(rows)
      // Unit Cost defaults to the variant Base Cost from Master Data; users can still override.
      setUnitCosts((prev) => {
        const next = { ...prev }
        for (const row of rows) {
          if (row.baseCost === null) continue
          if (next[row.rowKey] !== undefined && next[row.rowKey] !== '') continue
          next[row.rowKey] = String(row.baseCost)
        }
        return next
      })
      setConfigurationKey('all')
      setPage(1)
    } catch (error: any) {
      toast({ title: 'Catalog error', description: error.message, variant: 'destructive' })
      setCatalogRows([])
    } finally {
      setLoadingCatalog(false)
    }
  }

  const productLines = useMemo(
    () => Array.from(new Set(catalogRows.map((row) => row.productLine))).sort(),
    [catalogRows],
  )

  const configurationOptions = useMemo(() => {
    const map = new Map<string, string>()
    for (const row of catalogRows) {
      map.set(configurationFilterKey(row), row.configLabel)
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]))
  }, [catalogRows])

  // Never let a hidden Configuration control keep filtering the table.
  const activeConfigurationKey = useMemo(
    () => effectiveConfigurationFilterKey(catalogRows, configurationKey),
    [catalogRows, configurationKey],
  )

  const filteredRows = useMemo(
    () => filterManualStockCatalogRows(catalogRows, {
      search,
      productLine,
      manufacturerId: manufacturerFilter,
      configurationKey: activeConfigurationKey,
      activeOnly,
      quantityOnly,
      quantities,
    }),
    [catalogRows, search, productLine, manufacturerFilter, activeConfigurationKey, activeOnly, quantityOnly, quantities],
  )

  const pageRows = useMemo(
    () => paginateRows(filteredRows, page, PAGE_SIZE),
    [filteredRows, page],
  )
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE))

  // Each variant now has exactly one canonical operational configuration, so a
  // Configuration column would print the same value on every row. It reappears
  // by itself if a second configuration is ever genuinely in play.
  const showConfiguration = useMemo(
    () => shouldShowConfigurationColumn(catalogRows),
    [catalogRows],
  )

  const summary = useMemo(
    () => summarizeManualStockSelection(catalogRows, selectedKeys, quantities, unitCosts),
    [catalogRows, selectedKeys, quantities, unitCosts],
  )

  const warehouseName = warehouses.find((wh) => wh.id === selectedWarehouse)?.org_name || '—'
  const manufacturerName = manufacturers.find((mfg) => mfg.id === selectedManufacturer)?.org_name || '—'

  const reviewLines = useMemo(() => {
    try {
      return buildManualStockRpcItems(catalogRows, selectedKeys, quantities, unitCosts, rowNotes, pcsQuantities)
        .map((item) => {
          const row = catalogRows.find((entry) => entry.rowKey === catalogRowKey(item.variantId, item.stockConfigId))!
          return { item, row }
        })
    } catch {
      return []
    }
  }, [catalogRows, selectedKeys, quantities, unitCosts, rowNotes])

  const setQuantity = (key: string, value: string) => {
    setQuantities((prev) => ({ ...prev, [key]: value }))
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (value.trim()) next.add(key)
      else next.delete(key)
      return next
    })
  }

  const toggleRow = (key: string, checked: boolean) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (checked) next.add(key)
      else next.delete(key)
      return next
    })
  }

  const selectAllVisible = (checked: boolean) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      for (const row of filteredRows) {
        if (checked) next.add(row.rowKey)
        else next.delete(row.rowKey)
      }
      return next
    })
  }

  const clearQuantities = () => {
    setQuantities({})
    setUnitCosts({})
    setRowNotes({})
    setSelectedKeys(new Set())
  }

  const applyUnitCostToSelected = () => {
    const parsed = parseUnitCost(applyCostValue)
    if (!parsed.ok) {
      toast({ title: 'Invalid unit cost', description: parsed.error, variant: 'destructive' })
      return
    }
    if (selectedKeys.size === 0) {
      toast({ title: 'No rows selected', description: 'Select rows before applying a unit cost.', variant: 'destructive' })
      return
    }
    setUnitCosts((prev) => {
      const next = { ...prev }
      for (const key of selectedKeys) {
        next[key] = parsed.value === null ? '' : String(parsed.value)
      }
      return next
    })
    toast({ title: 'Unit cost applied', description: `Updated ${selectedKeys.size} selected row(s).` })
  }

  const exportExcelTemplate = async () => {
    try {
      const ExcelJS = (await import('exceljs')).default
      const workbook = new ExcelJS.Workbook()
      buildManualStockAdditionWorksheet(workbook, filteredRows, quantities, unitCosts, rowNotes)
      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `manual-stock-addition-${selectedWarehouse || 'template'}.xlsx`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (error: any) {
      toast({ title: 'Export failed', description: error.message, variant: 'destructive' })
    }
  }

  const importExcel = async (file: File) => {
    try {
      const ExcelJS = (await import('exceljs')).default
      const workbook = new ExcelJS.Workbook()
      const buffer = await file.arrayBuffer()
      await workbook.xlsx.load(buffer)
      const result = await parseManualStockAdditionImport(workbook, catalogRows)
      if (result.failed > 0 && result.updated === 0) {
        toast({
          title: 'Import rejected',
          description: result.rows.find((row) => row.status === 'Failed')?.message || 'Template is invalid.',
          variant: 'destructive',
        })
        return
      }

      setQuantities((prev) => {
        const next = { ...prev }
        result.patches.forEach((patch, key) => { next[key] = patch.quantity })
        return next
      })
      setUnitCosts((prev) => {
        const next = { ...prev }
        result.patches.forEach((patch, key) => { next[key] = patch.unitCost })
        return next
      })
      setRowNotes((prev) => {
        const next = { ...prev }
        result.patches.forEach((patch, key) => { next[key] = patch.rowNote })
        return next
      })
      setSelectedKeys((prev) => {
        const next = new Set(prev)
        result.patches.forEach((_patch, key) => next.add(key))
        return next
      })

      toast({
        title: 'Import complete',
        description: `Updated ${result.updated}, unchanged ${result.unchanged}, failed ${result.failed}.`,
        variant: result.failed > 0 ? 'destructive' : 'default',
      })
    } catch (error: any) {
      toast({ title: 'Import failed', description: error.message, variant: 'destructive' })
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const openReview = () => {
    if (!canPost) {
      toast({
        title: 'Not authorized',
        description: 'Manual stock addition requires HQ Admin (level 10) or adjust_stock permission.',
        variant: 'destructive',
      })
      return
    }
    if (!selectedWarehouse) {
      toast({ title: 'Warehouse required', description: 'Select a warehouse for the whole batch.', variant: 'destructive' })
      return
    }
    if (!reason) {
      toast({ title: 'Reason required', description: 'Select an addition reason/source type.', variant: 'destructive' })
      return
    }
    try {
      buildManualStockRpcItems(catalogRows, selectedKeys, quantities, unitCosts, rowNotes, pcsQuantities)
    } catch (error: any) {
      toast({ title: 'Validation error', description: error.message, variant: 'destructive' })
      return
    }
    if (!summary.ready) {
      toast({
        title: 'Not ready',
        description: summary.errors[0] || 'Enter positive whole quantities for selected rows.',
        variant: 'destructive',
      })
      return
    }
    setConfirmOpen(true)
  }

  const postBatch = async () => {
    if (postingLockRef.current || posting) return
    postingLockRef.current = true
    setPosting(true)
    try {
      const items = buildManualStockRpcItems(catalogRows, selectedKeys, quantities, unitCosts, rowNotes, pcsQuantities)
      const params = buildPostManualStockAdditionParams({
        requestId,
        warehouseId: selectedWarehouse,
        companyId: userProfile.organizations.id,
        createdBy: userProfile.id,
        reason,
        externalReference,
        manufacturerId: selectedManufacturer || null,
        warehouseLocation: warehouseLocationText || null,
        notes,
        items,
      })

      const { data, error } = await supabase.rpc('post_manual_stock_addition', params as any)
      if (error) throw error

      const batchNo = (data as any)?.batch_no || null
      setSuccessBatchNo(batchNo)
      toast({
        title: (data as any)?.idempotent_replay ? 'Already posted' : 'Stock added',
        description: batchNo
          ? `Batch ${batchNo} posted ${items.length} configuration(s).`
          : `Posted ${items.length} configuration(s).`,
      })

      // Refresh balances and clear inputs only after confirmed success.
      await loadCatalog(selectedWarehouse)
      clearQuantities()
      setExternalReference('')
      setWarehouseLocationText('')
      setNotes('')
      setRequestId(crypto.randomUUID())
      setConfirmOpen(false)
    } catch (error: any) {
      toast({
        title: 'Posting failed',
        description: error.message || 'Manual stock addition failed. Your inputs were preserved for retry.',
        variant: 'destructive',
      })
    } finally {
      setPosting(false)
      postingLockRef.current = false
    }
  }

  const allVisibleSelected = filteredRows.length > 0
    && filteredRows.every((row) => selectedKeys.has(row.rowKey))

  return (
    <div className="sera-sc-page space-y-6 pb-28">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold text-[var(--sera-ink)]">Manual Stock Addition</h1>
          <p className="text-[var(--sera-muted)] mt-1">
            Directly increases inventory for authorized manual or non-PO additions. Every posted row uses an exact stock configuration.
          </p>
        </div>
        {onViewChange && (
          <Button variant="outline" onClick={() => onViewChange('inventory')}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Inventory
          </Button>
        )}
      </div>

      <Card className="border-amber-200 bg-amber-50">
        <CardContent className="p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-700 mt-0.5 shrink-0" />
          <p className="text-sm text-amber-900">
            Use ORD Receiving for stock linked to a manufacturer order. This page is for authorized manual or non-PO additions.
          </p>
        </CardContent>
      </Card>

      {!canPost && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="p-4 text-sm text-red-800">
            Your role cannot post manual stock additions. HQ Admin Level 10 (or users with adjust_stock) are authorized. Unauthorized warehouse/distributor users are blocked server-side.
          </CardContent>
        </Card>
      )}

      {successBatchNo && (
        <Card className="border-emerald-200 bg-emerald-50">
          <CardContent className="p-4 flex items-start gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-700 mt-0.5" />
            <div className="text-sm text-emerald-900">
              <p className="font-medium">Batch posted successfully</p>
              <p>Generated batch reference: <span className="font-mono">{successBatchNo}</span></p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Warehouse className="w-5 h-5" />
            Addition Context
          </CardTitle>
          <CardDescription>Select once for the whole batch. Inventory increases immediately on post.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">Warehouse *</label>
            <Select value={selectedWarehouse} onValueChange={setSelectedWarehouse}>
              <SelectTrigger>
                <SelectValue placeholder="Select warehouse" />
              </SelectTrigger>
              <SelectContent>
                {warehouses.map((wh) => (
                  <SelectItem key={wh.id} value={wh.id}>{wh.org_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">Addition reason / source type *</label>
            <Select value={reason} onValueChange={(value) => setReason(value as ManualStockAdditionReason)}>
              <SelectTrigger>
                <SelectValue placeholder="Select reason" />
              </SelectTrigger>
              <SelectContent>
                {MANUAL_STOCK_ADDITION_REASONS.map((entry) => (
                  <SelectItem key={entry} value={entry}>{entry}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">External / supporting reference</label>
            <Input value={externalReference} onChange={(e) => setExternalReference(e.target.value)} placeholder="PO exception, email ref, etc." />
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">Physical location / shelf</label>
            <Input value={warehouseLocationText} onChange={(e) => setWarehouseLocationText(e.target.value)} placeholder="Optional shelf / bin" />
          </div>
          <div>
            <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2 flex items-center gap-2">
              <Factory className="w-4 h-4" /> Manufacturer / source
            </label>
            <Select value={selectedManufacturer || 'none'} onValueChange={(value) => setSelectedManufacturer(value === 'none' ? '' : value)}>
              <SelectTrigger>
                <SelectValue placeholder="Optional" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {manufacturers.map((mfg) => (
                  <SelectItem key={mfg.id} value={mfg.id}>{mfg.org_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="md:col-span-2 xl:col-span-1">
            <label className="block text-sm font-medium text-[var(--sera-ink)]/80 mb-2">Notes</label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Batch notes" />
          </div>
          <div className="md:col-span-2 xl:col-span-3 rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            Auto-generated batch reference after successful posting (MSA-…). Current request id: <span className="font-mono text-xs">{requestId}</span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PackagePlus className="w-5 h-5" />
            Bulk Stock Table
          </CardTitle>
          <CardDescription>
            Exact stock configurations as individual rows. Legacy/Unclassified is never selectable. STD products still post their exact stock_config_id.
            Quantities are entered in each row&apos;s stock unit — <span className="font-medium">cases</span> for cartridges,
            {' '}<span className="font-medium">pcs</span> for everything else — and are never converted between the two.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-3">
            <div className="xl:col-span-2 relative">
              <Search className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
              <Input
                className="pl-9"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1) }}
                placeholder="Search product, flavour, product code or alternative name"
                disabled={!selectedWarehouse}
              />
            </div>
            <Select value={productLine} onValueChange={(value) => { setProductLine(value); setPage(1) }} disabled={!selectedWarehouse}>
              <SelectTrigger><SelectValue placeholder="Product group" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All product groups</SelectItem>
                {productLines.map((line) => <SelectItem key={line} value={line}>{line}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={manufacturerFilter} onValueChange={(value) => { setManufacturerFilter(value); setPage(1) }} disabled={!selectedWarehouse}>
              <SelectTrigger><SelectValue placeholder="Manufacturer" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All manufacturers</SelectItem>
                {manufacturers.map((mfg) => <SelectItem key={mfg.id} value={mfg.id}>{mfg.org_name}</SelectItem>)}
              </SelectContent>
            </Select>
            {showConfiguration && (
              <Select value={activeConfigurationKey} onValueChange={(value) => { setConfigurationKey(value); setPage(1) }} disabled={!selectedWarehouse}>
                <SelectTrigger><SelectValue placeholder="Configuration" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All configurations</SelectItem>
                  {configurationOptions.map(([key, label]) => (
                    <SelectItem key={key} value={key}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm">
                  <Switch checked={activeOnly} onCheckedChange={setActiveOnly} /> Active only
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Switch checked={quantityOnly} onCheckedChange={(checked) => { setQuantityOnly(checked); setPage(1) }} /> Qty only
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => selectAllVisible(!allVisibleSelected)} disabled={!selectedWarehouse || filteredRows.length === 0}>
              Select all visible
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void exportExcelTemplate()} disabled={!selectedWarehouse || filteredRows.length === 0}>
              <Download className="w-4 h-4 mr-2" /> Export Excel Template
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={!selectedWarehouse || catalogRows.length === 0}>
              <Upload className="w-4 h-4 mr-2" /> Import Updated Excel
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void importExcel(file)
              }}
            />
            <Button type="button" variant="outline" size="sm" onClick={clearQuantities} disabled={Object.keys(quantities).length === 0}>
              <Eraser className="w-4 h-4 mr-2" /> Clear quantities
            </Button>
            <div className="flex items-center gap-2 ml-auto">
              <Input
                className="w-32"
                value={applyCostValue}
                onChange={(e) => setApplyCostValue(e.target.value)}
                placeholder="Unit cost"
              />
              <Button type="button" variant="secondary" size="sm" onClick={applyUnitCostToSelected}>
                Apply unit cost to selected rows
              </Button>
            </div>
          </div>

          {!selectedWarehouse ? (
            <p className="text-sm text-slate-600">Select a warehouse to load exact stock configurations.</p>
          ) : loadingCatalog ? (
            <p className="text-sm text-slate-600">Loading configurations…</p>
          ) : (
            <>
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          checked={allVisibleSelected}
                          onCheckedChange={(checked) => selectAllVisible(Boolean(checked))}
                          aria-label="Select all visible"
                        />
                      </TableHead>
                      <TableHead>Product / Flavour</TableHead>
                      {showConfiguration && <TableHead>Configuration</TableHead>}
                      <TableHead className="text-right">Current On Hand</TableHead>
                      <TableHead className="text-right">Add Quantity</TableHead>
                      <TableHead className="text-right">Unit Cost</TableHead>
                      <TableHead className="text-right">New Balance</TableHead>
                      <TableHead className="text-right">Addition Value</TableHead>
                      <TableHead>Optional row note</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((row) => {
                      const qtyParsed = parseAddQuantity(quantities[row.rowKey] || '')
                      const costParsed = parseUnitCost(unitCosts[row.rowKey] || '')
                      const addQty = qtyParsed.ok ? qtyParsed.value : 0
                      const unitCost = costParsed.ok ? costParsed.value : null
                      const value = addQty > 0 ? additionValue(addQty, unitCost) : null
                      return (
                        <TableRow key={row.rowKey}>
                          <TableCell>
                            <Checkbox
                              checked={selectedKeys.has(row.rowKey)}
                              onCheckedChange={(checked) => toggleRow(row.rowKey, Boolean(checked))}
                              aria-label={`Select ${row.variantName || row.productName}`}
                            />
                          </TableCell>
                          <TableCell>
                            <div className="font-medium text-slate-900">{row.productName}</div>
                            <div className="text-xs text-slate-500">
                              {variantIdentityLabel(row.variantName, row.variantProductCode)}
                            </div>
                            {variantAlternativeLabel(row.alternativeName) && (
                              <div className="text-xs text-slate-400">
                                {variantAlternativeLabel(row.alternativeName)}
                              </div>
                            )}
                          </TableCell>
                          {showConfiguration && (
                            <TableCell>
                              <Badge variant="outline" className={configBadgeClass(row.volumeMl, row.packaging)}>
                                {withStockStrengthUnit(row.configLabel)}
                              </Badge>
                            </TableCell>
                          )}
                          <TableCell className="text-right tabular-nums">
                            <StockQuantityDisplay
                              quantity={rowBalanceQuantity(row, row.currentOnHand)}
                              note={resolveStockUnit({ productName: row.productName, balancePcsPerCase: row.pcsPerCase }).conflict}
                              className="items-end"
                            />
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-end justify-end gap-1.5">
                              <label className="flex flex-col items-end gap-0.5">
                                <span className="text-[10px] font-semibold uppercase tracking-wide text-blue-800">
                                  {stockUnitLabel(row.productName) === 'cases' ? 'Cases' : 'Pcs'}
                                </span>
                                <Input
                                  className="w-24 text-right"
                                  inputMode="numeric"
                                  aria-label={`Add quantity in ${stockUnitLabel(row.productName)} for ${row.variantName || row.productName}`}
                                  value={quantities[row.rowKey] || ''}
                                  onChange={(e) => setQuantity(row.rowKey, e.target.value)}
                                  placeholder="0"
                                />
                              </label>
                              {stockUnitLabel(row.productName) === 'cases' && (
                                <label className="flex flex-col items-end gap-0.5">
                                  <span className="text-[10px] font-semibold uppercase tracking-wide text-teal-600">Pcs</span>
                                  <Input
                                    className="w-16 text-right"
                                    inputMode="numeric"
                                    aria-label={`Add extra pieces for ${row.variantName || row.productName}`}
                                    value={pcsQuantities[row.rowKey] || ''}
                                    onChange={(e) => setPcsQuantities((prev) => ({
                                      ...prev,
                                      [row.rowKey]: e.target.value.replace(/[^\d]/g, ''),
                                    }))}
                                    placeholder="0"
                                  />
                                </label>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-right">
                            <Input
                              className="w-28 ml-auto text-right"
                              inputMode="decimal"
                              value={unitCosts[row.rowKey] || ''}
                              onChange={(e) => setUnitCosts((prev) => ({ ...prev, [row.rowKey]: e.target.value }))}
                              placeholder={row.baseCost != null ? String(row.baseCost) : (row.averageCost != null ? String(row.averageCost) : '—')}
                            />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {addQty > 0 ? (
                              <StockQuantityDisplay
                                quantity={rowBalanceQuantity(row, newBalance(row.currentOnHand, addQty))}
                                className="items-end"
                              />
                            ) : '—'}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {value == null ? '—' : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </TableCell>
                          <TableCell>
                            <Input
                              value={rowNotes[row.rowKey] || ''}
                              onChange={(e) => setRowNotes((prev) => ({ ...prev, [row.rowKey]: e.target.value }))}
                              placeholder="Optional"
                            />
                          </TableCell>
                        </TableRow>
                      )
                    })}
                    {pageRows.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={showConfiguration ? 9 : 8} className="text-center text-sm text-slate-500 py-8">
                          No configurations match the current filters.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>

              <div className="flex items-center justify-between text-sm text-slate-600">
                <span>
                  Showing {filteredRows.length === 0 ? 0 : ((page - 1) * PAGE_SIZE) + 1}
                  –{Math.min(page * PAGE_SIZE, filteredRows.length)} of {filteredRows.length}
                  {' '}(quantities preserved across pages)
                </span>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                  <span>Page {page} / {totalPages}</span>
                  <Button type="button" variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <div className="fixed bottom-0 inset-x-0 z-20 border-t bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
        <div className="mx-auto max-w-7xl px-4 py-3 flex flex-wrap items-center gap-4 justify-between">
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3 text-sm">
            <div><div className="text-slate-500">Selected flavours</div><div className="font-semibold">{summary.selectedFlavours}</div></div>
            <div><div className="text-slate-500">Selected configurations</div><div className="font-semibold">{summary.selectedConfigurations}</div></div>
            <div><div className="text-slate-500">Quantity added (per row&apos;s stock unit)</div><div className="font-semibold">{summary.totalUnits.toLocaleString()}</div></div>
            <div><div className="text-slate-500">Total addition value</div><div className="font-semibold">{summary.totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div></div>
            <div><div className="text-slate-500">Warehouse</div><div className="font-semibold truncate max-w-[10rem]">{warehouseName}</div></div>
            <div><div className="text-slate-500">Reason</div><div className="font-semibold truncate max-w-[10rem]">{reason || '—'}</div></div>
            <div><div className="text-slate-500">Manufacturer/source</div><div className="font-semibold truncate max-w-[10rem]">{manufacturerName}</div></div>
            <div><div className="text-slate-500">Batch status</div><div className="font-semibold text-emerald-700">{summary.ready && selectedWarehouse && reason ? 'Ready to Post' : 'Incomplete'}</div></div>
          </div>
          <Button
            type="button"
            onClick={openReview}
            disabled={!canPost || posting || !summary.ready || !selectedWarehouse || !reason}
            className="bg-teal-700 hover:bg-teal-800"
          >
            Review & Add Stock
          </Button>
        </div>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Manual Stock Addition</AlertDialogTitle>
            <AlertDialogDescription>
              Inventory will increase immediately. This is not a draft and does not require approval.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-2">
              <div><span className="text-slate-500">Warehouse:</span> {warehouseName}</div>
              <div><span className="text-slate-500">Reason:</span> {reason}</div>
              <div><span className="text-slate-500">Reference:</span> {externalReference || '—'}</div>
              <div><span className="text-slate-500">Manufacturer/source:</span> {manufacturerName}</div>
            </div>
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product / Flavour</TableHead>
                    {showConfiguration && <TableHead>Configuration</TableHead>}
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Current → New</TableHead>
                    <TableHead className="text-right">Unit Cost</TableHead>
                    <TableHead className="text-right">Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {reviewLines.map(({ item, row }) => (
                    <TableRow key={row.rowKey}>
                      <TableCell>
                        <div className="font-medium">{row.productName}</div>
                        <div className="text-xs text-slate-500">
                          {variantIdentityLabel(row.variantName, row.variantProductCode)}
                        </div>
                      </TableCell>
                      {showConfiguration && <TableCell>{withStockStrengthUnit(row.configLabel)}</TableCell>}
                      <TableCell className="text-right">{item.quantity}</TableCell>
                      <TableCell className="text-right">
                        {formatStockQuantity(rowBalanceQuantity(row, row.currentOnHand)).text} → {formatStockQuantity(rowBalanceQuantity(row, newBalance(row.currentOnHand, item.quantity))).text}
                      </TableCell>
                      <TableCell className="text-right">{item.unitCost ?? '—'}</TableCell>
                      <TableCell className="text-right">
                        {additionValue(item.quantity, item.unitCost)?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
              Warning: inventory will increase immediately for every listed configuration.
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={posting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={posting}
              onClick={(e) => {
                e.preventDefault()
                void postBatch()
              }}
            >
              {posting ? 'Posting…' : 'Confirm & Add Stock'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
