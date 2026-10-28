import { isCelleraVapeVariant } from '@/lib/inventory/cellera-variant'
import { isLegacyConfigCode, shouldShowConfigurationColumn } from './canonical-stock-config'

export interface ExistingStockBalance {
  quantity_on_hand: number
  quantity_allocated: number
  quantity_available: number
  warehouse_name: string
  warehouse_location: string | null
  average_cost: number | null
}

interface ExistingStockRow {
  quantity_on_hand: number | null
  quantity_allocated: number | null
  quantity_available: number | null
  warehouse_location: string | null
  average_cost: number | null
  organization: { org_name?: string | null } | { org_name?: string | null }[] | null
}

export const MANUAL_STOCK_ADDITION_REASONS = [
  'Non-PO Receipt',
  'Free / Replacement Stock',
  'Opening Balance',
  'Stock Correction Inbound',
  'Other',
] as const

export type ManualStockAdditionReason = (typeof MANUAL_STOCK_ADDITION_REASONS)[number]

export const CELLERA_DEFAULT_CONFIGURATION_KEY = '20|new_box|20ml · New Box'

export interface ManualStockCatalogRow {
  rowKey: string
  stockConfigId: string
  variantId: string
  productId: string
  productCode: string
  productName: string
  variantName: string
  variantProductCode: string
  alternativeName: string
  baseCost: number | null
  flavour: string
  productLine: string
  manufacturerId: string | null
  manufacturerName: string
  configCode: string
  configLabel: string
  stockSku: string
  volumeMl: number | null
  packaging: string | null
  status: string
  isCellera: boolean
  currentOnHand: number
  /** Loose pieces held on top of currentOnHand (product_inventory.pcs_on_hand). */
  currentPcsOnHand?: number
  /** product_inventory.pcs_per_case snapshot; null/undefined when unknown. */
  pcsPerCase?: number | null
  averageCost: number | null
}

export interface ManualStockLineInput {
  stockConfigId: string
  variantId: string
  /** Whole stock units (cases for cartridges, pieces for other products). */
  quantity: number
  /** Loose pieces added on top of `quantity`; 0 when none were entered. */
  pcs?: number
  unitCost: number | null
  rowNote?: string | null
}

export interface ManualStockPostPayload {
  requestId: string
  warehouseId: string
  companyId: string
  createdBy: string
  reason: ManualStockAdditionReason | string
  externalReference?: string | null
  manufacturerId?: string | null
  warehouseLocation?: string | null
  notes?: string | null
  items: ManualStockLineInput[]
}

export function extractFlavour(variantName: string): string {
  const match = variantName.match(/\[([^\]]*)\]/)
  const flavour = match?.[1].trim()
  return flavour ? `[${flavour}]` : ''
}

export function catalogRowKey(variantId: string, stockConfigId: string): string {
  return `${variantId}:${stockConfigId}`
}

export function configurationFilterKey(row: Pick<ManualStockCatalogRow, 'volumeMl' | 'packaging' | 'configLabel'>): string {
  return `${row.volumeMl ?? 'std'}|${row.packaging ?? 'none'}|${row.configLabel}`
}

export function isSelectableManualStockConfiguration(row: {
  stockConfigId?: string | null
  configCode?: string | null
  configLabel?: string | null
  status?: string | null
}): boolean {
  if (!row.stockConfigId) return false
  const code = (row.configCode || '').toUpperCase()
  const label = (row.configLabel || '').toUpperCase()
  if (!code) return false
  // Legacy configurations (50NB / 50OB / UNCLASSIFIED) are retired to zero by
  // LEGACY-CONFIG-CUTOVER-2026 and can never receive new stock. Only the
  // canonical operational configuration is selectable - 20NB for Cellera
  // cartridges, STD for non-vape.
  if (isLegacyConfigCode(code)) return false
  if (label.includes('LEGACY') || label.includes('UNCLASSIFIED')) return false
  if (row.status && row.status !== 'active') return false
  return true
}

export function parseAddQuantity(raw: string | number | null | undefined): {
  ok: true
  value: number
} | {
  ok: false
  error: string
} {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, error: 'Quantity is required' }
  }
  const text = String(raw).trim()
  if (!/^\d+$/.test(text)) {
    return { ok: false, error: 'Add quantities must be positive whole numbers' }
  }
  const value = Number(text)
  if (!Number.isInteger(value) || value <= 0) {
    return { ok: false, error: 'Add quantities must be positive whole numbers' }
  }
  return { ok: true, value }
}

export function parseUnitCost(raw: string | number | null | undefined): {
  ok: true
  value: number | null
} | {
  ok: false
  error: string
} {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, value: null }
  }
  const text = String(raw).trim()
  if (!/^\d+(\.\d{1,4})?$/.test(text)) {
    return { ok: false, error: 'Unit cost must be a non-negative number' }
  }
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, error: 'Unit cost must be a non-negative number' }
  }
  return { ok: true, value }
}

export function newBalance(currentOnHand: number, addQty: number): number {
  return currentOnHand + addQty
}

export function additionValue(quantity: number, unitCost: number | null): number | null {
  if (unitCost === null || unitCost === undefined) return null
  return quantity * unitCost
}

export function weightedAverageCost(
  currentOnHand: number,
  currentAvgCost: number | null,
  addQty: number,
  unitCost: number | null,
): number | null {
  if (addQty <= 0) return currentAvgCost
  if (unitCost === null || unitCost === undefined) return currentAvgCost
  const baseQty = Math.max(0, currentOnHand)
  const baseCost = currentAvgCost ?? 0
  if (baseQty + addQty <= 0) return unitCost
  return ((baseQty * baseCost) + (addQty * unitCost)) / (baseQty + addQty)
}

export function paginateRows<T>(rows: T[], page: number, pageSize: number): T[] {
  const safePage = Math.max(1, page)
  const start = (safePage - 1) * pageSize
  return rows.slice(start, start + pageSize)
}

export function filterManualStockCatalogRows(
  rows: ManualStockCatalogRow[],
  options: {
    search?: string
    productLine?: string
    manufacturerId?: string
    configurationKey?: string
    activeOnly?: boolean
    quantityOnly?: boolean
    quantities?: Record<string, string>
  },
): ManualStockCatalogRow[] {
  const search = (options.search || '').trim().toLowerCase()
  return rows.filter((row) => {
    if (options.activeOnly !== false && row.status !== 'active') return false
    if (options.productLine && options.productLine !== 'all' && row.productLine !== options.productLine) {
      return false
    }
    if (options.manufacturerId && options.manufacturerId !== 'all' && row.manufacturerId !== options.manufacturerId) {
      return false
    }
    if (options.configurationKey && options.configurationKey !== 'all') {
      if (configurationFilterKey(row) !== options.configurationKey) return false
    }
    if (options.quantityOnly) {
      const qty = options.quantities?.[row.rowKey]
      if (!qty || !String(qty).trim()) return false
    }
    if (!search) return true
    const haystack = [
      row.flavour,
      row.variantName,
      row.productName,
      row.productCode,
      row.variantProductCode,
      row.alternativeName,
      row.stockSku,
      row.configLabel,
      row.configCode,
    ].join(' ').toLowerCase()
    return haystack.includes(search)
  })
}

// The configuration filter only applies while the Configuration control is
// actually shown. When every variant has a single canonical configuration
// (Cellera 20NB, non-vape STD) the control is hidden, and a leftover key such as
// 20NB would otherwise silently hide every STD row. Also falls back to 'all'
// when the key no longer matches anything in the loaded catalog.
export function effectiveConfigurationFilterKey(
  rows: ManualStockCatalogRow[],
  configurationKey: string | null | undefined,
): string {
  if (!configurationKey || configurationKey === 'all') return 'all'
  if (!shouldShowConfigurationColumn(rows)) return 'all'
  if (!rows.some((row) => configurationFilterKey(row) === configurationKey)) return 'all'
  return configurationKey
}

export function summarizeManualStockSelection(
  rows: ManualStockCatalogRow[],
  selectedKeys: Set<string>,
  quantities: Record<string, string>,
  unitCosts: Record<string, string>,
): {
  selectedFlavours: number
  selectedConfigurations: number
  totalUnits: number
  totalValue: number
  ready: boolean
  errors: string[]
} {
  const errors: string[] = []
  let totalUnits = 0
  let totalValue = 0
  const flavourIds = new Set<string>()
  let selectedConfigurations = 0

  for (const key of selectedKeys) {
    const row = rows.find((entry) => entry.rowKey === key)
    if (!row) continue
    const qtyRaw = quantities[key]
    if (!qtyRaw || !String(qtyRaw).trim()) continue
    const parsedQty = parseAddQuantity(qtyRaw)
    if (!parsedQty.ok) {
      errors.push(`${row.stockSku}: ${parsedQty.error}`)
      continue
    }
    const parsedCost = parseUnitCost(unitCosts[key])
    if (!parsedCost.ok) {
      errors.push(`${row.stockSku}: ${parsedCost.error}`)
      continue
    }
    selectedConfigurations += 1
    flavourIds.add(row.variantId)
    totalUnits += parsedQty.value
    if (parsedCost.value !== null) {
      totalValue += parsedQty.value * parsedCost.value
    }
  }

  return {
    selectedFlavours: flavourIds.size,
    selectedConfigurations,
    totalUnits,
    totalValue,
    ready: selectedConfigurations > 0 && errors.length === 0,
    errors,
  }
}

export function buildManualStockRpcItems(
  rows: ManualStockCatalogRow[],
  selectedKeys: Set<string>,
  quantities: Record<string, string>,
  unitCosts: Record<string, string>,
  rowNotes: Record<string, string>,
  pcsQuantities: Record<string, string> = {},
): ManualStockLineInput[] {
  const items: ManualStockLineInput[] = []
  for (const key of selectedKeys) {
    const row = rows.find((entry) => entry.rowKey === key)
    if (!row) continue
    const qtyRaw = quantities[key]
    const pcsRaw = pcsQuantities[key]
    const hasQty = Boolean(qtyRaw && String(qtyRaw).trim())
    const hasPcs = Boolean(pcsRaw && String(pcsRaw).trim() && Number(pcsRaw) > 0)
    // A line may carry whole units, loose pieces, or both — "add 2 pcs" is a
    // legitimate addition on its own.
    if (!hasQty && !hasPcs) continue
    const parsedQty = parseAddQuantity(hasQty ? qtyRaw : '0')
    if (!parsedQty.ok) throw new Error(`${row.stockSku}: ${parsedQty.error}`)
    const parsedPcs = Number(pcsRaw ?? 0)
    if (!Number.isFinite(parsedPcs) || parsedPcs < 0 || !Number.isInteger(parsedPcs)) {
      throw new Error(`${row.stockSku}: extra pieces must be a whole number`)
    }
    const parsedCost = parseUnitCost(unitCosts[key])
    if (!parsedCost.ok) throw new Error(`${row.stockSku}: ${parsedCost.error}`)
    if (!isSelectableManualStockConfiguration(row)) {
      throw new Error(`${row.stockSku}: Legacy/Unclassified stock cannot be selected`)
    }
    items.push({
      stockConfigId: row.stockConfigId,
      variantId: row.variantId,
      quantity: parsedQty.value,
      pcs: parsedPcs,
      unitCost: parsedCost.value,
      rowNote: rowNotes[key]?.trim() || null,
    })
  }
  if (items.length === 0) {
    throw new Error('Select at least one configuration with a positive add quantity')
  }
  return items
}

export function buildPostManualStockAdditionParams(input: ManualStockPostPayload) {
  if (!input.warehouseId) throw new Error('A warehouse must be selected')
  if (!input.requestId) throw new Error('A request id is required')
  if (!input.reason?.trim()) throw new Error('Addition reason/source type is required')
  if (!input.items.length) throw new Error('At least one stock configuration line is required')

  return {
    p_request_id: input.requestId,
    p_organization_id: input.warehouseId,
    p_items: input.items.map((item) => ({
      pcs: item.pcs ?? 0,
      stock_config_id: item.stockConfigId,
      variant_id: item.variantId,
      quantity: item.quantity,
      unit_cost: item.unitCost,
      row_note: item.rowNote ?? null,
    })),
    p_reason: input.reason.trim(),
    p_external_reference: input.externalReference?.trim() || null,
    p_manufacturer_id: input.manufacturerId || null,
    p_warehouse_location: input.warehouseLocation?.trim() || null,
    p_notes: input.notes?.trim() || null,
    p_company_id: input.companyId,
    p_created_by: input.createdBy,
  }
}

/** @deprecated Prefer buildPostManualStockAdditionParams for atomic bulk posting. */
export function buildAddStockMovementParams(input: {
  variantId: string
  warehouseId: string
  quantity: number
  unitCost: number | null
  manufacturerId: string | null
  warehouseLocation: string | null
  notes: string | null
  companyId: string
  createdBy: string
  stockConfigId?: string
  reason?: string
  referenceNo?: string | null
  referenceId?: string | null
}) {
  if (!input.warehouseId) throw new Error('A warehouse must be selected')

  return {
    p_movement_type: 'manual_in',
    p_variant_id: input.variantId,
    p_organization_id: input.warehouseId,
    p_quantity_change: input.quantity,
    p_unit_cost: input.unitCost,
    p_manufacturer_id: input.manufacturerId,
    p_warehouse_location: input.warehouseLocation,
    p_reason: input.reason?.trim() || 'Manual stock addition',
    p_notes: input.notes,
    p_reference_type: 'manual',
    p_reference_id: input.referenceId ?? null,
    p_reference_no: input.referenceNo ?? null,
    p_company_id: input.companyId,
    p_created_by: input.createdBy,
    ...(input.stockConfigId ? { p_stock_config_id: input.stockConfigId } : {}),
  }
}

export function mapCatalogRowFromQuery(item: any): ManualStockCatalogRow | null {
  const config = Array.isArray(item.inventory_stock_configurations)
    ? item.inventory_stock_configurations[0]
    : item.inventory_stock_configurations
  const variant = Array.isArray(item.product_variants) ? item.product_variants[0] : item.product_variants
  const product = Array.isArray(variant?.products) ? variant.products[0] : variant?.products
  const group = Array.isArray(product?.product_groups) ? product.product_groups[0] : product?.product_groups
  const manufacturer = Array.isArray(product?.organizations) ? product.organizations[0] : product?.organizations

  if (!config?.id || !variant?.id || !product?.id) return null
  if (!isSelectableManualStockConfiguration({
    stockConfigId: config.id,
    configCode: config.config_code,
    configLabel: config.config_label,
    status: config.status,
  })) {
    return null
  }

  const isCellera = isCelleraVapeVariant({
    is_active: product.is_active,
    is_vape: product.is_vape,
    product_name: product.product_name,
    product_code: product.product_code,
  })

  return {
    rowKey: catalogRowKey(variant.id, config.id),
    stockConfigId: config.id,
    variantId: variant.id,
    productId: product.id,
    productCode: product.product_code || '',
    productName: product.product_name || '',
    variantName: variant.variant_name || '',
    variantProductCode: variant.product_code || '',
    alternativeName: variant.alternative_name || '',
    baseCost: variant.base_cost === null || variant.base_cost === undefined
      ? null
      : Number(variant.base_cost),
    flavour: extractFlavour(variant.variant_name || ''),
    productLine: group?.group_name || 'Ungrouped',
    manufacturerId: product.manufacturer_id || null,
    manufacturerName: manufacturer?.org_name || '—',
    configCode: config.config_code || '',
    configLabel: config.config_label || '',
    stockSku: config.stock_sku || '',
    volumeMl: config.volume_ml ?? null,
    packaging: config.packaging ?? null,
    status: config.status || 'active',
    isCellera,
    currentOnHand: Number(item.quantity_on_hand ?? 0),
    averageCost: item.average_cost === null || item.average_cost === undefined
      ? null
      : Number(item.average_cost),
  }
}

export async function fetchExistingStockForWarehouse(
  supabase: any,
  warehouseId: string,
  variantId: string,
  stockConfigId?: string
): Promise<ExistingStockBalance | null> {
  if (!warehouseId || !variantId) return null

  let query = supabase
    .from('product_inventory')
    .select(`
      quantity_on_hand,
      quantity_allocated,
      quantity_available,
      warehouse_location,
      average_cost,
      organization:organizations(org_name)
    `)
    .eq('organization_id', warehouseId)
    .eq('variant_id', variantId)
    .eq('is_active', true)
  if (stockConfigId) query = query.eq('stock_config_id', stockConfigId)
  const { data, error } = await query.maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as ExistingStockRow
  const organization = Array.isArray(row.organization) ? row.organization[0] : row.organization
  const quantityOnHand = Number(row.quantity_on_hand ?? 0)
  const quantityAllocated = Number(row.quantity_allocated ?? 0)

  return {
    quantity_on_hand: quantityOnHand,
    quantity_allocated: quantityAllocated,
    quantity_available: Number(row.quantity_available ?? (quantityOnHand - quantityAllocated)),
    warehouse_name: organization?.org_name || 'Unknown warehouse',
    warehouse_location: row.warehouse_location,
    average_cost: row.average_cost === null ? null : Number(row.average_cost),
  }
}

export function configBadgeClass(volumeMl: number | null, packaging: string | null): string {
  if (volumeMl === 20 && packaging === 'new_box') return 'bg-blue-100 text-blue-800 border-blue-200'
  if (volumeMl === 50 && packaging === 'new_box') return 'bg-emerald-100 text-emerald-800 border-emerald-200'
  if (volumeMl === 50 && packaging === 'old_box') return 'bg-amber-100 text-amber-800 border-amber-200'
  return 'bg-slate-100 text-slate-700 border-slate-200'
}

export function isHqManualStockAdmin(roleLevel: number | null | undefined): boolean {
  return typeof roleLevel === 'number' && Number.isFinite(roleLevel) && roleLevel > 0 && roleLevel <= 10
}
