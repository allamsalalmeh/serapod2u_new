/**
 * Manufacturer product-category classification.
 *
 * Assigned categories are an admin's explicit choice (manufacturer_product_categories).
 * Derived categories are only read from linked products (products.manufacturer_id +
 * products.category_id) and are never saved automatically. Classification is
 * informational: it does not restrict ordering, product pickers, QR, loyalty or access.
 */

export type CategoryOption = { id: string; category_name: string; is_active: boolean | null }

/** category_name / is_active are null when the viewer's RLS hides the category (inactive, non-HQ viewer). */
export type AssignedCategory = { category_id: string; category_name: string | null; is_active: boolean | null }
export type DerivedCategory = AssignedCategory & { product_count: number }

export type ManufacturerCategorySummary = {
  manufacturer_id: string
  assigned: AssignedCategory[]
  derived: DerivedCategory[]
  product_count: number
  uncategorized_product_count: number
}

export type CategoryFormMode = 'create' | 'edit'

/** Query parameter the Product List reads to filter by manufacturer. */
export const MANUFACTURER_PRODUCTS_PARAM = 'manufacturer'

export function manufacturerProductsHref(manufacturerId: string): string {
  return `/supply-chain/products?${MANUFACTURER_PRODUCTS_PARAM}=${encodeURIComponent(manufacturerId)}`
}

export function categoryLabel(category: Pick<AssignedCategory, 'category_name'>): string {
  return category.category_name || 'Unavailable category'
}

export function diffCategorySelection(saved: string[], selected: string[]) {
  const before = new Set(saved)
  const after = new Set(selected)
  const add = Array.from(after).filter((id) => !before.has(id))
  const remove = Array.from(before).filter((id) => !after.has(id))
  return { add, remove, changed: add.length > 0 || remove.length > 0 }
}

/**
 * Shared Add/Edit validation. New manufacturers need at least one category; an existing
 * unclassified manufacturer may stay unclassified, but a classified one cannot be emptied.
 * Only categories that are newly added must be active; kept inactive ones are preserved.
 */
export function validateManufacturerCategories({
  mode,
  saved,
  selected,
  options,
}: {
  mode: CategoryFormMode
  saved: string[]
  selected: string[]
  options: CategoryOption[]
}): string | null {
  if (selected.length === 0) {
    if (mode === 'create') return 'Select at least one product category for this manufacturer.'
    if (saved.length > 0) return 'Keep at least one product category. A classified manufacturer cannot be cleared.'
    return null
  }
  const byId = new Map(options.map((option) => [option.id, option]))
  const { add } = diffCategorySelection(saved, selected)
  const unavailable = add.filter((id) => byId.get(id)?.is_active !== true)
  if (unavailable.length > 0) {
    const names = unavailable.map((id) => byId.get(id)?.category_name).filter(Boolean)
    return names.length > 0
      ? `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} inactive and cannot be newly assigned.`
      : 'One or more selected categories are inactive or no longer exist.'
  }
  return null
}

/** Categories found on linked products that are not in `assignedIds` (the classification). */
export function categoriesOutsideClassification(assignedIds: string[], derived: DerivedCategory[]): DerivedCategory[] {
  const assigned = new Set(assignedIds)
  return derived.filter((category) => !assigned.has(category.category_id))
}

/** Derived categories an admin may confirm: active and not already selected. */
export function suggestedCategories(selectedIds: string[], derived: DerivedCategory[]): DerivedCategory[] {
  return categoriesOutsideClassification(selectedIds, derived).filter((category) => category.is_active === true)
}

/**
 * Organization list filter: 'all', 'unclassified' or a category id (assigned categories only).
 * Any value other than 'all' narrows the list to manufacturers.
 */
export function matchesManufacturerCategoryFilter(
  org: { id: string; org_type_code: string },
  filter: string,
  summaries: Map<string, ManufacturerCategorySummary> | null | undefined,
): boolean {
  if (filter === 'all') return true
  if (org.org_type_code !== 'MFG' || !summaries) return false
  const assigned = summaries.get(org.id)?.assigned || []
  if (filter === 'unclassified') return assigned.length === 0
  return assigned.some((category) => category.category_id === filter)
}

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function normalizeSummary(row: any): ManufacturerCategorySummary {
  const list = (value: unknown) => (Array.isArray(value) ? value : [])
  return {
    manufacturer_id: String(row.manufacturer_id),
    assigned: list(row.assigned).map((item: any) => ({
      category_id: String(item.category_id),
      category_name: item.category_name ?? null,
      is_active: item.is_active ?? null,
    })),
    derived: list(row.derived).map((item: any) => ({
      category_id: String(item.category_id),
      category_name: item.category_name ?? null,
      is_active: item.is_active ?? null,
      product_count: toNumber(item.product_count),
    })),
    product_count: toNumber(row.product_count),
    uncategorized_product_count: toNumber(row.uncategorized_product_count),
  }
}

export function emptySummary(manufacturerId: string): ManufacturerCategorySummary {
  return { manufacturer_id: manufacturerId, assigned: [], derived: [], product_count: 0, uncategorized_product_count: 0 }
}

/**
 * Aggregated per-manufacturer summary (one row each, computed in SQL). Returns null when
 * it cannot be read, e.g. before migration 20261018100000 is applied.
 */
export async function loadManufacturerCategorySummaries(
  supabase: any,
  manufacturerIds: string[],
): Promise<Map<string, ManufacturerCategorySummary> | null> {
  const ids = Array.from(new Set(manufacturerIds.filter(Boolean)))
  const summaries = new Map<string, ManufacturerCategorySummary>()
  if (ids.length === 0) return summaries
  const chunkSize = 500
  for (let start = 0; start < ids.length; start += chunkSize) {
    const { data, error } = await supabase.rpc('manufacturer_category_summary', {
      p_manufacturer_ids: ids.slice(start, start + chunkSize),
    })
    if (error) {
      console.error('Error loading manufacturer categories:', error)
      return null
    }
    for (const row of data || []) {
      const summary = normalizeSummary(row)
      summaries.set(summary.manufacturer_id, summary)
    }
  }
  return summaries
}

/** Product Master categories, including inactive ones the viewer can read (shown only when already assigned). */
export async function loadCategoryOptions(supabase: any): Promise<CategoryOption[]> {
  const { data, error } = await supabase
    .from('product_categories')
    .select('id, category_name, is_active')
    .order('category_name')
  if (error) throw error
  return (data || []) as CategoryOption[]
}

export function translateCategorySaveError(error: any): string {
  const message = String(error?.message || '')
  if (error?.code === '42501') return "You don't have permission to change this manufacturer's product categories."
  if (error?.code === 'PGRST202' || /set_manufacturer_product_categories/.test(message)) {
    return 'Product categories cannot be saved yet: the database update for manufacturer categories is not installed.'
  }
  return message || 'Product categories could not be saved.'
}

/** Replaces the manufacturer's assigned categories atomically on the server. */
export async function saveManufacturerCategories(supabase: any, manufacturerId: string, categoryIds: string[]) {
  const { data, error } = await supabase.rpc('set_manufacturer_product_categories', {
    p_manufacturer_id: manufacturerId,
    p_category_ids: categoryIds,
  })
  if (error) throw new Error(translateCategorySaveError(error))
  return (data || []) as string[]
}
