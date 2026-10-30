/**
 * View Inventory aggregation — one summary row per organization + variant.
 *
 * The warehouse inventory detail (product_inventory / vw_inventory_on_hand) has
 * one row per stock configuration, so a single flavour at a single warehouse can
 * legitimately have four balance rows (20NB / 50NB / 50OB / Legacy). Rendering
 * those raw rows produced the reported defects:
 *   - four visually identical flavour rows,
 *   - the variant-level Incoming quantity repeated on every configuration,
 *   - a negative Total Value driven by movement-variance recomputation.
 *
 * This module collapses the configuration rows back to one authoritative summary
 * per (organization, variant) and derives the drill-down detail with the correct
 * per-configuration attribution:
 *   - Incoming is a VARIANT-level quantity. All new manufacturer ORD receipts
 *     land on 20ml New Box, so incoming is attributed to exactly ONE
 *     configuration (the 20NB config, or the ORD default) and surfaced once at
 *     the summary. It is never multiplied across configuration join rows.
 *   - Total Value uses the CURRENT balance: max(On Hand, 0) × unit/average cost.
 *     It is never derived from movement variance or a classification-out value,
 *     so clearing a Legacy balance can never drive inventory value negative.
 *
 * Pure and framework-free so the behaviour can be unit tested directly.
 */

import { isLegacyConfigCode } from './canonical-stock-config'
import { resolveStockUnit } from './stock-count-quantity'
import type { StockCountUnit } from './stock-count-catalog'

/** Unit a balance is denominated in, as resolved by resolveStockUnit(). */
export type InventoryStockUnit = StockCountUnit | 'unknown'

export interface InventoryConfigRow {
  id: string
  organization_id?: string | null
  organization_name?: string | null
  organization_code?: string | null
  variant_id?: string | null
  variant_code?: string | null
  variant_name?: string | null
  variant_image_url?: string | null
  /** product_variants.product_code — the variant Product Code (e.g. "LB"). */
  variant_product_code?: string | null
  /** product_variants.alternative_name — distributor-facing variant name. */
  alternative_name?: string | null
  product_name?: string | null
  /** products.product_code — the parent product code, shared by every variant. */
  product_code?: string | null
  stock_config_id?: string | null
  config_code?: string | null
  config_label?: string | null
  stock_sku?: string | null
  volume_ml?: number | null
  packaging?: string | null
  default_for_ord?: boolean | null
  stock_config_status?: string | null
  quantity_on_hand: number
  /** Loose pieces held on top of quantity_on_hand (0 for piece-stocked products). */
  pcs_on_hand?: number | null
  /** Pieces per case snapshotted on the balance row. */
  pcs_per_case?: number | null
  quantity_allocated: number
  quantity_available: number
  unit_cost?: number | null
  reorder_point?: number | null
  warehouse_location?: string | null
  updated_at?: string | null
}

export interface AggregatedConfig {
  /** Row id of the underlying balance row (stable React key). */
  id: string
  stockConfigId: string | null
  configCode: string | null
  stockSku: string | null
  /** Human label: e.g. "20ml · New Box" or "Legacy / Unclassified". */
  label: string
  volumeMl: number | null
  packaging: string | null
  lifecycleStatus: string | null
  isLegacy: boolean
  onHand: number
  pcsOnHand: number
  pcsPerCase: number
  /** Unit onHand/allocated/available/incoming/position are denominated in. */
  stockUnit: InventoryStockUnit
  /** Operator-facing reason the unit/ratio is uncertain, else null. */
  unitConflict: string | null
  allocated: number
  available: number
  incoming: number
  position: number
  unitCost: number | null
  value: number
}

export interface VariantInventorySummary {
  key: string
  organizationId: string | null
  organizationName: string | null
  organizationCode: string | null
  variantId: string | null
  variantCode: string | null
  variantName: string | null
  variantImageUrl: string | null
  /** Variant Product Code from master data (product_variants.product_code). */
  variantProductCode: string | null
  /** Variant alternative name from master data (product_variants.alternative_name). */
  alternativeName: string | null
  productName: string | null
  productCode: string | null
  onHand: number
  /**
   * Loose pieces summed across configurations. Never folded into onHand:
   * configurations are different physical SKUs, and onHand must stay the sum
   * of quantity_on_hand that orders and reservations use.
   */
  pcsOnHand: number
  pcsPerCase: number
  /**
   * Unit every quantity on this summary is denominated in — On Hand, Reserved,
   * Available to Order, Incoming and Projected Position share it. Resolved from
   * the product line, never from a missing/defaulted pcs_per_case.
   */
  stockUnit: InventoryStockUnit
  /** Operator-facing reason the unit/ratio is uncertain, else null. */
  unitConflict: string | null
  allocated: number
  available: number
  incoming: number
  position: number
  unitCost: number | null
  value: number
  reorderPoint: number
  warehouseLocation: string | null
  /** Most recent balance update across the variant's configurations (ISO string). */
  updatedAt: string | null
  /** Configuration detail for the drill-down (zero Legacy hidden by default). */
  configs: AggregatedConfig[]
  /**
   * Every configuration id behind this summary, including hidden zero rows.
   * The Reserved drill-down scopes to exactly these.
   */
  allConfigIds: string[]
  /** Number of configuration rows hidden from the detail (zero Legacy/inactive). */
  hiddenConfigCount: number
  /** True when at least one configuration carries physical dimensions. */
  configuredVariant: boolean
  /**
   * Units this variant still holds under a retired legacy configuration
   * (50NB / 50OB / UNCLASSIFIED). Counts allocated as well as on hand: a
   * reserved legacy unit is still a unit the operator must be able to see.
   */
  legacyOnHand: number
  /**
   * True while any legacy balance is non-zero.
   *
   * This is the gate on the post-cutover UI simplification. The summary row's
   * On Hand already INCLUDES the legacy balance, so collapsing the detail away
   * while this is true would show an operator a total they cannot account for —
   * the one outcome the cutover plan explicitly forbids. Simplify only when it
   * is false, and until then say plainly that legacy stock is still present.
   */
  hasUnretiredLegacy: boolean
  /**
   * True when the variant has exactly one operational configuration and no
   * legacy balance left. The configuration expander carries no information at
   * this point and is dropped entirely.
   */
  operationalOnly: boolean
}

/** Resolve incoming for a warehouse + variant. Returns the variant-level total. */
export type IncomingResolver = (
  organizationId: string | null | undefined,
  variantId: string | null | undefined,
) => number

const num = (value: unknown): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

const normalizeCode = (value?: string | null): string => (value || '').trim().toUpperCase()

/**
 * A configuration is Legacy/Unclassified when it has no physical dimensions,
 * carries the UNCLASSIFIED code, or has no stock configuration identity at all.
 */
/**
 * Whether this balance sits under a configuration the legacy cutover retires.
 *
 * Deliberately NOT isLegacyConfigRow. That predicate answers a display
 * question — "does this row carry physical dimensions" — and STD, the canonical
 * configuration for every non-vape product, has neither volume nor packaging.
 * Treating STD as legacy would flag every tumbler and camping chair as holding
 * retired stock and would stop their rows ever collapsing.
 *
 * Retirement is decided by the configuration CODE, matching
 * legacy_cutover_config_codes() in the database. A row with no configuration at
 * all is legacy by definition: it predates the configuration model.
 */
export function isRetirableLegacyConfigRow(row: InventoryConfigRow): boolean {
  if (!row.stock_config_id) return true
  return isLegacyConfigCode(row.config_code)
}

export function isLegacyConfigRow(row: InventoryConfigRow): boolean {
  if (normalizeCode(row.config_code) === 'UNCLASSIFIED') return true
  if (!row.stock_config_id) return true
  return (row.volume_ml === null || row.volume_ml === undefined) &&
    (row.packaging === null || row.packaging === undefined)
}

function configLabel(row: InventoryConfigRow): string {
  if (isLegacyConfigRow(row)) return 'Legacy / Unclassified'
  const volume = row.volume_ml ? `${row.volume_ml}ml` : null
  const packaging = row.packaging === 'new_box' ? 'New Box' : row.packaging === 'old_box' ? 'Old Box' : null
  const dimensions = [volume, packaging].filter(Boolean).join(' · ')
  return dimensions || row.config_label || 'Configuration'
}

/**
 * Pick the single configuration row that receives the variant's incoming stock.
 * All new manufacturer ORD receipts use 20ml New Box, so incoming attaches to
 * the 20NB configuration; failing that, the ORD default; failing that, the sole
 * row of a non-configured (STD) variant. Returns null when it cannot be
 * attributed to one row (so incoming is never repeated across configurations).
 */
export function pickIncomingConfigRowId(rows: InventoryConfigRow[]): string | null {
  const twentyNewBox = rows.find((row) => normalizeCode(row.config_code) === '20NB')
  if (twentyNewBox) return twentyNewBox.id
  const ordDefault = rows.find((row) => row.default_for_ord === true)
  if (ordDefault) return ordDefault.id
  if (rows.length === 1) return rows[0].id
  return null
}

export interface AggregateOptions {
  /** Include zero-balance Legacy/inactive configurations in the detail list. */
  includeInactive?: boolean
}

export type InventorySummarySortColumn =
  | 'variant_code'
  | 'product_name'
  | 'location'
  | 'on_hand'
  | 'allocated'
  | 'available'
  | 'incoming'
  | 'position'
  | 'total_value'

export interface InventorySummaryFilterOptions {
  searchQuery?: string
  statusFilter?: 'all' | 'low_stock' | 'out_of_stock' | 'in_stock'
  valueRangeFilter?: 'all' | 'under_1000' | '1000_5000' | '5000_10000' | 'over_10000'
}

/**
 * Filter only after aggregation. In particular, a Stock SKU search may match
 * one configuration, but the returned row must retain the flavour's complete
 * totals rather than being re-aggregated from that one matching configuration.
 */
export function filterVariantInventorySummaries(
  summaries: VariantInventorySummary[],
  options: InventorySummaryFilterOptions,
): VariantInventorySummary[] {
  const search = (options.searchQuery || '').trim().toLowerCase()
  const status = options.statusFilter || 'all'
  const valueRange = options.valueRangeFilter || 'all'

  return summaries.filter((summary) => {
    const matchesSearch = !search || [
      summary.variantCode,
      summary.variantName,
      // Both are rendered on the row, so both must be searchable.
      summary.variantProductCode,
      summary.alternativeName,
      summary.productName,
      summary.productCode,
      summary.organizationName,
      summary.organizationCode,
      ...summary.configs.flatMap((config) => [
        config.stockSku,
        config.configCode,
        config.label,
      ]),
    ].filter(Boolean).some((value) => String(value).toLowerCase().includes(search))

    let matchesStatus = true
    if (status === 'low_stock') matchesStatus = summary.available > 0 && summary.available <= summary.reorderPoint
    else if (status === 'out_of_stock') matchesStatus = summary.available <= 0
    else if (status === 'in_stock') matchesStatus = summary.available > 0

    let matchesValue = true
    if (valueRange === 'under_1000') matchesValue = summary.value < 1000
    else if (valueRange === '1000_5000') matchesValue = summary.value >= 1000 && summary.value < 5000
    else if (valueRange === '5000_10000') matchesValue = summary.value >= 5000 && summary.value < 10000
    else if (valueRange === 'over_10000') matchesValue = summary.value >= 10000

    return matchesSearch && matchesStatus && matchesValue
  })
}

export function sortVariantInventorySummaries(
  summaries: VariantInventorySummary[],
  column: InventorySummarySortColumn | null,
  direction: 'asc' | 'desc',
): VariantInventorySummary[] {
  if (!column) return [...summaries]

  const value = (summary: VariantInventorySummary): string | number => {
    switch (column) {
      case 'variant_code': return summary.variantCode || ''
      case 'product_name': return summary.productName || ''
      case 'location': return summary.organizationName || ''
      case 'on_hand': return summary.onHand
      case 'allocated': return summary.allocated
      case 'available': return summary.available
      case 'incoming': return summary.incoming
      case 'position': return summary.position
      case 'total_value': return summary.value
    }
  }

  return [...summaries].sort((a, b) => {
    const aValue = value(a)
    const bValue = value(b)
    const comparison = typeof aValue === 'string' && typeof bValue === 'string'
      ? aValue.localeCompare(bValue)
      : Number(aValue) - Number(bValue)
    return direction === 'asc' ? comparison : -comparison
  })
}

export function paginateVariantInventorySummaries(
  summaries: VariantInventorySummary[],
  page: number,
  pageSize: number,
): VariantInventorySummary[] {
  const start = Math.max(0, page - 1) * pageSize
  return summaries.slice(start, start + pageSize)
}

/** Snapshot the exact summary rows consumed by the Excel writer. */
export function buildInventorySummaryExportRows(summaries: VariantInventorySummary[]) {
  return summaries.map((summary) => ({
    key: summary.key,
    productName: summary.productName,
    productCode: summary.productCode,
    variantName: summary.variantName,
    variantCode: summary.variantCode,
    organizationName: summary.organizationName,
    warehouseLocation: summary.warehouseLocation,
    stockUnit: summary.stockUnit,
    onHand: summary.onHand,
    pcsOnHand: summary.pcsOnHand,
    allocated: summary.allocated,
    available: summary.available,
    incoming: summary.incoming,
    position: summary.position,
    reorderPoint: summary.reorderPoint,
    unitCost: summary.unitCost,
    value: summary.value,
    updatedAt: summary.updatedAt,
  }))
}

/**
 * Collapse per-configuration balance rows into one summary per organization +
 * variant. Warehouse and distributor inventories remain separate because the
 * grouping key includes the organization id.
 */
export function aggregateVariantInventory(
  rows: InventoryConfigRow[],
  getIncoming: IncomingResolver,
  options: AggregateOptions = {},
): VariantInventorySummary[] {
  const includeInactive = options.includeInactive === true
  const groups = new Map<string, InventoryConfigRow[]>()

  for (const row of rows) {
    // Every row is keyed by organization + variant so identical flavours in
    // different organizations never merge.
    const key = `${row.organization_id ?? 'org'}::${row.variant_id ?? row.variant_code ?? row.id}`
    const list = groups.get(key)
    if (list) list.push(row)
    else groups.set(key, [row])
  }

  const summaries: VariantInventorySummary[] = []

  for (const [key, groupRows] of groups) {
    const first = groupRows[0]
    const incomingTotal = num(getIncoming(first.organization_id, first.variant_id))
    const incomingRowId = incomingTotal > 0 ? pickIncomingConfigRowId(groupRows) : null

    // One unit for the whole flavour row, resolved from the product line and
    // every configuration's snapshotted ratio (a defaulted 1 cannot win).
    const groupUnit = resolveStockUnit({
      productName: first.product_name,
      balancePcsPerCase: groupRows.map((row) => row.pcs_per_case),
    })

    let onHand = 0
    let pcsOnHand = 0
    let allocated = 0
    let available = 0
    let value = 0
    let representativeUnitCost: number | null = null
    let reorderPoint = 0
    let configuredVariant = false
    let updatedAt: string | null = null

    const configs: AggregatedConfig[] = groupRows.map((row) => {
      const rowOnHand = num(row.quantity_on_hand)
      const rowAllocated = num(row.quantity_allocated)
      const rowAvailable = row.quantity_available === null || row.quantity_available === undefined
        ? rowOnHand - rowAllocated
        : num(row.quantity_available)
      const rowIncoming = row.id === incomingRowId ? incomingTotal : 0
      const unitCost = row.unit_cost === null || row.unit_cost === undefined ? null : Number(row.unit_cost)
      const rowUnit = resolveStockUnit({
        productName: row.product_name ?? first.product_name,
        balancePcsPerCase: row.pcs_per_case,
      })
      const rowPcs = num(row.pcs_on_hand)
      // Current-balance value only. Clearing a Legacy balance (On Hand → 0)
      // yields 0, never a negative movement-variance value. Cost is per stock
      // unit; loose pieces are worth unitCost / pcsPerCase (same rule as the
      // generated product_inventory.pcs_value). A piece-stocked row has none.
      const pcsValue = unitCost !== null && rowUnit.unit === 'cases' && rowUnit.pcsPerCase > 1
        ? (Math.max(0, rowPcs) * unitCost) / rowUnit.pcsPerCase
        : 0
      const rowValue = unitCost === null ? 0 : Math.max(0, rowOnHand) * unitCost + pcsValue
      const legacy = isLegacyConfigRow(row)

      onHand += rowOnHand
      pcsOnHand += rowPcs
      allocated += rowAllocated
      available += rowAvailable
      value += rowValue
      if (unitCost !== null && representativeUnitCost === null) representativeUnitCost = unitCost
      reorderPoint = Math.max(reorderPoint, num(row.reorder_point))
      if (!legacy) configuredVariant = true
      if (row.updated_at && (updatedAt === null || row.updated_at > updatedAt)) updatedAt = row.updated_at

      return {
        id: row.id,
        stockConfigId: row.stock_config_id ?? null,
        configCode: row.config_code ?? null,
        stockSku: row.stock_sku ?? null,
        label: configLabel(row),
        volumeMl: row.volume_ml ?? null,
        packaging: row.packaging ?? null,
        lifecycleStatus: row.stock_config_status ?? null,
        isLegacy: legacy,
        onHand: rowOnHand,
        pcsOnHand: rowPcs,
        pcsPerCase: rowUnit.pcsPerCase,
        stockUnit: rowUnit.unit,
        unitConflict: rowUnit.conflict,
        allocated: rowAllocated,
        available: rowAvailable,
        incoming: rowIncoming,
        position: rowAvailable + rowIncoming,
        unitCost,
        value: Number(rowValue.toFixed(2)),
      }
    })

    // Order: configured rows first (by volume then packaging), Legacy last.
    configs.sort((a, b) => {
      if (a.isLegacy !== b.isLegacy) return a.isLegacy ? 1 : -1
      const volumeDelta = (a.volumeMl ?? 0) - (b.volumeMl ?? 0)
      if (volumeDelta !== 0) return volumeDelta
      return (a.packaging ?? '').localeCompare(b.packaging ?? '')
    })

    // Hide zero Legacy/Unclassified (and other zero inactive rows) by default.
    const visibleConfigs = includeInactive
      ? configs
      : configs.filter((config) => !(config.isLegacy && config.onHand === 0 && config.allocated === 0 && config.incoming === 0))

    // Legacy stock the cutover has not yet retired. Allocated counts too: a
    // reserved legacy unit is still a unit the operator must be able to see.
    const retirable = new Set(
      rows.filter(isRetirableLegacyConfigRow).map((row) => row.id),
    )
    const legacyOnHand = configs
      .filter((config) => retirable.has(config.id))
      .reduce((sum, config) => sum + Math.max(config.onHand, 0) + Math.max(config.allocated, 0), 0)
    const hasUnretiredLegacy = legacyOnHand > 0
    const operationalConfigCount = configs.filter((config) => !retirable.has(config.id)).length

    summaries.push({
      key,
      organizationId: first.organization_id ?? null,
      organizationName: first.organization_name ?? null,
      organizationCode: first.organization_code ?? null,
      variantId: first.variant_id ?? null,
      variantCode: first.variant_code ?? null,
      variantName: first.variant_name ?? null,
      variantImageUrl: first.variant_image_url ?? null,
      variantProductCode: first.variant_product_code ?? null,
      alternativeName: first.alternative_name ?? null,
      productName: first.product_name ?? null,
      productCode: first.product_code ?? null,
      onHand,
      pcsOnHand,
      pcsPerCase: groupUnit.pcsPerCase,
      stockUnit: groupUnit.unit,
      unitConflict: groupUnit.conflict,
      allocated,
      available,
      incoming: incomingTotal,
      position: available + incomingTotal,
      unitCost: representativeUnitCost,
      value: Number(value.toFixed(2)),
      reorderPoint,
      warehouseLocation: first.warehouse_location ?? null,
      updatedAt,
      configs: visibleConfigs,
      allConfigIds: Array.from(new Set(groupRows.map((row) => row.stock_config_id).filter((id): id is string => Boolean(id)))),
      hiddenConfigCount: configs.length - visibleConfigs.length,
      configuredVariant,
      legacyOnHand,
      hasUnretiredLegacy,
      operationalOnly: !hasUnretiredLegacy && operationalConfigCount <= 1,
    })
  }

  return summaries
}
