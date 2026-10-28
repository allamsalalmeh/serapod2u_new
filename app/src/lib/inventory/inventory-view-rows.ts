/**
 * View Inventory: one balance row from the API (vw_inventory_on_hand, or the
 * product_inventory fallback select) projected into the row the aggregation
 * consumes.
 *
 * Extracted verbatim from InventoryView so the projection is unit tested with
 * the real API shape. The Cases/Pcs defect lived here: the projection rebuilt
 * each row without pcs_on_hand / pcs_per_case, so every downstream consumer
 * saw "no ratio", defaulted it to 1, and labelled Cellera case balances "pcs".
 */

export interface InventoryRowLookups {
  variantBaseCostMap: Map<string, number>
  variantImageMap: Map<string, string>
  variantProductCodeMap: Map<string, string>
  variantAlternativeNameMap: Map<string, string>
  /** org:variant:config → warranty_bonus quantity excluded from value. */
  warrantyBonusMap: Map<string, number>
}

export const emptyInventoryRowLookups = (): InventoryRowLookups => ({
  variantBaseCostMap: new Map(),
  variantImageMap: new Map(),
  variantProductCodeMap: new Map(),
  variantAlternativeNameMap: new Map(),
  warrantyBonusMap: new Map(),
})

export const parseInventoryNumber = (value: any): number | null => {
  if (value === null || value === undefined || value === '') {
    return null
  }
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

export function normalizeInventoryApiRow(item: any, index: number, lookups: InventoryRowLookups) {
  const {
    variantBaseCostMap,
    variantImageMap,
    variantProductCodeMap,
    variantAlternativeNameMap,
    warrantyBonusMap,
  } = lookups
  const parseNumber = parseInventoryNumber
  const rawVariant = Array.isArray(item.product_variants)
    ? item.product_variants[0]
    : item.product_variants

  const rawProduct = rawVariant?.products
    ? Array.isArray(rawVariant.products)
      ? rawVariant.products[0]
      : rawVariant.products
    : null

  const rawOrg = Array.isArray(item.organizations)
    ? item.organizations[0]
    : item.organizations

  const variantId = item.variant_id ?? rawVariant?.id ?? null
  const organizationId = item.organization_id ?? rawOrg?.id ?? null

  const variantBaseCostCandidates: Array<number | null> = []
  if (variantId && variantBaseCostMap.has(variantId)) {
    variantBaseCostCandidates.push(variantBaseCostMap.get(variantId) ?? null)
  }
  variantBaseCostCandidates.push(parseNumber(rawVariant?.base_cost))
  variantBaseCostCandidates.push(parseNumber(item.base_cost))

  const variantBaseCost = variantBaseCostCandidates.find(cost => cost !== null) ?? null

  const quantityOnHand = parseNumber(item.quantity_on_hand) ?? 0
  const allocatedQuantity = parseNumber(item.quantity_allocated) ?? 0
  const quantityAvailable = parseNumber(item.quantity_available) ?? quantityOnHand

  const resolvedUnitCost = (() => {
    if (variantBaseCost !== null) return variantBaseCost
    const directUnit = parseNumber(item.unit_cost)
    if (directUnit !== null && directUnit !== 0) return directUnit
    const average = parseNumber(item.average_cost)
    return average
  })()

  const resolvedTotalValue = (() => {
    if (resolvedUnitCost !== null) {
      // Exclude warranty_bonus quantities from value calculation
      const key = organizationId && variantId ? `${organizationId}:${variantId}:${item.stock_config_id || 'legacy'}` : null
      const warrantyBonusQty = key ? (warrantyBonusMap.get(key) ?? 0) : 0
      // Inventory value is a current-balance measure: On Hand × cost. It
      // must never go negative just because a warranty bonus or a
      // classification-out movement exceeds the remaining balance.
      const valuableQty = Math.max(0, quantityOnHand - warrantyBonusQty)
      return Number((valuableQty * resolvedUnitCost).toFixed(2))
    }
    const directTotal = parseNumber(item.total_value)
    if (directTotal !== null) return directTotal
    return null
  })()

  const variantImage = variantId && variantImageMap.has(variantId)
    ? variantImageMap.get(variantId)
    : (item.variant_image_url ?? rawVariant?.image_url ?? null)

  return {
    id: item.id || `${organizationId || 'org'}-${variantId || rawVariant?.variant_code || index}`,
    variant_id: variantId,
    variant_code: item.variant_code ?? rawVariant?.variant_code ?? null,
    variant_name: item.variant_name ?? rawVariant?.variant_name ?? null,
    variant_image_url: variantImage,
    variant_product_code:
      (variantId ? variantProductCodeMap.get(variantId) : null) ?? rawVariant?.product_code ?? null,
    alternative_name:
      (variantId ? variantAlternativeNameMap.get(variantId) : null) ?? rawVariant?.alternative_name ?? null,
    stock_config_id: item.stock_config_id ?? null,
    config_code: item.config_code ?? item.inventory_stock_configurations?.config_code ?? null,
    config_label: item.config_label ?? item.inventory_stock_configurations?.config_label ?? null,
    stock_sku: item.stock_sku ?? item.inventory_stock_configurations?.stock_sku ?? null,
    volume_ml: parseNumber(item.volume_ml ?? item.inventory_stock_configurations?.volume_ml),
    packaging: item.packaging ?? item.inventory_stock_configurations?.packaging ?? null,
    default_for_ord: item.default_for_ord ?? item.inventory_stock_configurations?.default_for_ord ?? null,
    stock_config_status: item.stock_config_status ?? item.inventory_stock_configurations?.status ?? null,
    product_name: item.product_name ?? rawProduct?.product_name ?? null,
    product_code: item.product_code ?? rawProduct?.product_code ?? null,
    organization_id: organizationId,
    organization_name: item.organization_name ?? rawOrg?.org_name ?? null,
    organization_code: item.organization_code ?? rawOrg?.org_code ?? null,
    quantity_on_hand: quantityOnHand,
    // The loose-piece pair travels with the balance. Dropping these two
    // fields here is what made every Cellera row render in "pcs": the
    // aggregation saw no ratio and the formatter read 1 as "pcs".
    // A missing ratio stays null (unknown), never a fabricated 1.
    pcs_on_hand: parseNumber(item.pcs_on_hand) ?? 0,
    pcs_per_case: parseNumber(item.pcs_per_case),
    quantity_allocated: allocatedQuantity,
    quantity_available: quantityAvailable,
    reorder_point: Number(item.reorder_point ?? 0),
    reorder_quantity: Number(item.reorder_quantity ?? 0),
    max_stock_level: parseNumber(item.max_stock_level),
    safety_stock: parseNumber(item.safety_stock),
    lead_time_days: parseNumber(item.lead_time_days),
    unit_cost: resolvedUnitCost,
    total_value: resolvedTotalValue,
    manual_balance_qty:
      item.manual_balance_qty !== undefined && item.manual_balance_qty !== null
        ? Number(item.manual_balance_qty)
        : null,
    warehouse_location: item.warehouse_location ?? null,
    updated_at: item.updated_at ?? null
  }
}

export type NormalizedInventoryRow = ReturnType<typeof normalizeInventoryApiRow>
