import { classifyProductLine, getRowUnitsPerCase } from '@/lib/returns/format'
import { normalizeBaseCost } from './stock-count-costing'
import {
  evaluateStockConfigEligibility,
  resolveStockConfigProfile,
  type StockConfigProfile,
} from './stock-count-config-eligibility'

export const STOCK_COUNT_UNGROUPED_ID = 'ungrouped'

export interface StockCountCatalogRow {
  inventoryId: string | null
  stockConfigId: string
  configCode: string
  stockSku: string
  configLabel: string
  volumeMl: number | null
  packagingVersion: string | null
  configStatus: string
  /**
   * Whether the owning variant is still active master data. Archived variants
   * (is_active = false) are excluded from new counts entirely; when they survive
   * inside a historical draft scope they are flagged so the UI can label them as
   * "Archived variant — historical draft item" instead of showing them as a
   * normal countable row.
   */
  variantIsActive: boolean
  /** Whether the owning product is still active master data. */
  productIsActive: boolean
  variantId: string
  productName: string
  productCode: string
  categoryId: string
  categoryName: string
  groupId: string
  groupName: string
  groupDescription: string | null
  /** Explicit configuration profile of the owning group (see eligibility). */
  groupConfigProfile: StockConfigProfile
  /** Whether this configuration is eligible to be counted for its group. */
  eligible: boolean
  brandLogoUrl: string | null
  variantName: string
  alternativeName: string | null
  variantCode: string
  manufacturerSku: string | null
  manualSku: string | null
  imageUrl: string | null
  systemQuantity: number
  quantityAllocated: number
  physicalCount: string
  note: string
  unitCost: number | null
  warehouseLocation: string | null
  /** Pieces in one case when the product is counted by the case (Cellera Hero/Zero = 4), otherwise null. */
  piecesPerCase?: number | null
}

export interface StockCountLocation {
  id: string
  org_code: string
  org_name: string
  org_type_code: string
  is_active: boolean
}

/**
 * Stock Count is always scoped to an active WH organization from Organization
 * master data. Historical sessions may retain other organization IDs, but they
 * are never eligible creation/posting locations.
 */
export function getStockCountLocationOptions(
  locations: StockCountLocation[],
): StockCountLocation[] {
  return locations
    .filter(location => location.org_type_code === 'WH' && location.is_active === true)
    .sort((a, b) => a.org_name.localeCompare(b.org_name))
}

export function resolveStockCountDefaultWarehouseId(
  configuredDefaultWarehouseId: string | null | undefined,
  currentOrganizationId: string | null | undefined,
  eligibleWarehouses: Array<{ id: string }>,
): string {
  if (configuredDefaultWarehouseId
    && eligibleWarehouses.some(warehouse => warehouse.id === configuredDefaultWarehouseId)) {
    return configuredDefaultWarehouseId
  }
  if (currentOrganizationId
    && eligibleWarehouses.some(warehouse => warehouse.id === currentOrganizationId)) {
    return currentOrganizationId
  }
  return ''
}

/** The shared pack-size rule (devices stay in pieces); null when a case is not more than one piece. */
export function resolveStockCountPiecesPerCase(productName: string | null | undefined, masterUnitsPerCase?: number | null): number | null {
  const pieces = getRowUnitsPerCase(classifyProductLine(productName), productName, masterUnitsPerCase)
  return pieces > 1 ? pieces : null
}

function relation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] || null
  return value || null
}

/**
 * Build the warehouse Stock Count catalog from configurations, then overlay
 * optional warehouse balances. A configuration does not need a
 * product_inventory row to be countable.
 */
export function buildStockCountCatalogRows(
  configurations: any[],
  warehouseBalances: any[],
): StockCountCatalogRow[] {
  const balancesByConfig = new Map<string, any>()
  for (const balance of warehouseBalances) {
    const configId = String(balance.stock_config_id || '')
    if (!configId) continue
    if (balancesByConfig.has(configId)) {
      throw new Error(`Duplicate inventory balance rows found for Stock Configuration ${configId}.`)
    }
    balancesByConfig.set(configId, balance)
  }

  const seenConfigs = new Set<string>()
  const rows = configurations.map((config) => {
    const stockConfigId = String(config.id || '')
    if (!stockConfigId) throw new Error('A Stock Configuration is missing its ID.')
    if (seenConfigs.has(stockConfigId)) throw new Error(`Duplicate Stock Configuration ${stockConfigId} in catalog.`)
    seenConfigs.add(stockConfigId)

    const variant: any = relation(config.product_variants)
    const product: any = relation(variant?.products)
    if (!variant?.id || !product?.id) {
      throw new Error(`Stock Configuration ${stockConfigId} is missing its active Product Variant relationship.`)
    }
    const group: any = relation(product.product_groups)
    const brand: any = relation(product.brands)
    const category: any = relation(product.product_categories)
    const balance = balancesByConfig.get(stockConfigId)

    const groupConfigProfile = resolveStockConfigProfile(group?.stock_config_profile)
    const systemQuantity = Number(balance?.quantity_on_hand || 0)
    const eligible = evaluateStockConfigEligibility({
      configCode: config.config_code,
      volumeMl: config.volume_ml,
      packaging: config.packaging,
      groupProfile: groupConfigProfile,
      // At catalog-build time only the persisted balance is known; physical
      // count / note are entered later. A concentration config on a non-flavour
      // group is ineligible regardless of activity, but the visibility rule
      // (see isStockCountCatalogRowVisible) still keeps any ineligible config
      // that carries a real balance so stock is never silently hidden.
      hasActivity: systemQuantity !== 0,
    }).eligible

    return {
      inventoryId: balance?.id || null,
      stockConfigId,
      configCode: config.config_code,
      stockSku: config.stock_sku,
      configLabel: config.config_label,
      volumeMl: config.volume_ml,
      packagingVersion: config.packaging,
      configStatus: config.status,
      variantIsActive: variant.is_active !== false,
      productIsActive: product.is_active !== false,
      variantId: variant.id,
      productName: product.product_name || 'Unnamed product',
      productCode: variant.product_code || '',
      categoryId: product.category_id || '',
      categoryName: category?.category_name || 'Uncategorized',
      groupId: group?.id || brand?.id || STOCK_COUNT_UNGROUPED_ID,
      groupName: group?.group_name || brand?.brand_name || 'Ungrouped',
      groupDescription: group?.group_description || null,
      groupConfigProfile,
      eligible,
      brandLogoUrl: brand?.logo_url || null,
      variantName: variant.variant_name || 'Unnamed variant',
      alternativeName: variant.alternative_name || null,
      variantCode: variant.variant_code || '',
      manufacturerSku: variant.manufacturer_sku || null,
      manualSku: variant.manual_sku || null,
      imageUrl: variant.image_url || null,
      systemQuantity,
      quantityAllocated: Number(balance?.quantity_allocated || 0),
      physicalCount: '',
      note: '',
      unitCost: normalizeBaseCost(variant.base_cost),
      warehouseLocation: balance?.warehouse_location || null,
      piecesPerCase: resolveStockCountPiecesPerCase(product.product_name, product.units_per_case),
    }
  })

  return rows.sort((a, b) =>
    `${a.groupName} ${a.productName} ${a.variantName} ${a.configLabel}`
      .localeCompare(`${b.groupName} ${b.productName} ${b.variantName} ${b.configLabel}`),
  )
}

export function stockCountRowHasActivity(row: Pick<StockCountCatalogRow, 'systemQuantity' | 'physicalCount' | 'note'>): boolean {
  return row.systemQuantity !== 0 || row.physicalCount.trim() !== '' || row.note.trim() !== ''
}

export function isStockCountCatalogRowVisible(row: StockCountCatalogRow, showInactive: boolean): boolean {
  const hasActivity = stockCountRowHasActivity(row)
  // A configuration that is ineligible for its group (e.g. an invalid 20mg/50mg
  // configuration generated on a Device group) is hidden — but only while it
  // carries no balance. An ineligible config that still holds real stock stays
  // visible so nothing is silently dropped; it is corrected via the reviewed
  // cleanup migration, not hidden from the operator.
  if (!row.eligible && !hasActivity) return false
  if (row.configCode === 'UNCLASSIFIED' && !hasActivity) return false
  // Archived master data is never part of a NEW operational selection. When such
  // a row only survives because it is inside a historical draft scope, it is
  // treated exactly like an inactive configuration: hidden from fresh lists and
  // only revealed (as read-only history) when the operator opts into Show
  // Inactive. This is defence in depth on top of the is_active query filter.
  if (row.variantIsActive === false || row.productIsActive === false) return showInactive
  if (row.configStatus === 'inactive') return showInactive
  if (row.configStatus === 'phase_out' && !hasActivity) return showInactive
  return true
}

/**
 * The immutable Opening Balance scope captured at draft-creation time. Category
 * membership is validated HERE so the persisted snapshot can never include a
 * configuration from another Product Category. This is what stops a snapshot
 * being polluted with out-of-category rows that would then be dropped on reopen.
 */
export function buildOpeningBalanceScopeRows<T extends Pick<StockCountCatalogRow, 'categoryId' | 'configCode' | 'configStatus' | 'systemQuantity' | 'physicalCount' | 'note' | 'eligible'>>(
  rows: T[],
  categoryId: string,
): T[] {
  if (!categoryId) return []
  return rows.filter(row => row.categoryId === categoryId && isStockCountCatalogRowVisible(row as unknown as StockCountCatalogRow, false))
}

/**
 * The rows an Opening Balance draft displays (and therefore exports to Excel).
 *
 *  - A NEW draft (no session id yet) shows the live, category-scoped eligible
 *    catalog — the same set that becomes the immutable scope on first save.
 *  - A REOPENED draft is bound to its immutable snapshot scope: every row whose
 *    configuration is in `scopeIds` is shown, WITHOUT re-applying the live
 *    Product Category filter. A snapshot row must never disappear because its
 *    product was later recategorized, deactivated, or otherwise drifted from the
 *    live catalog — the frozen snapshot is authoritative. This is the fix for a
 *    140-row draft collapsing to a single surviving item on reopen.
 */
export function resolveOpeningBalanceVisibleRows<T extends Pick<StockCountCatalogRow, 'stockConfigId' | 'categoryId' | 'configCode' | 'configStatus' | 'systemQuantity' | 'physicalCount' | 'note' | 'eligible'>>(
  rows: T[],
  options: { currentSessionId: string | null; selectedCategory: string; scopeIds: Set<string> },
): T[] {
  if (options.currentSessionId) {
    return rows.filter(row => options.scopeIds.has(row.stockConfigId))
  }
  return buildOpeningBalanceScopeRows(rows, options.selectedCategory)
}

export function matchesStockCountSearch(row: StockCountCatalogRow, search: string): boolean {
  const query = search.trim().toLocaleLowerCase()
  if (!query) return true
  return [
    row.productName,
    row.variantName,
    row.alternativeName,
    row.productCode,
    row.variantCode,
    row.stockSku,
    row.configLabel,
    row.manufacturerSku,
    row.manualSku,
  ].some((value) => String(value || '').toLocaleLowerCase().includes(query))
}
