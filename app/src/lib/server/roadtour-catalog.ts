import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { EllbowApiError } from '@/lib/server/ellbow-catalog'
import { authorizeOperation, organizationResource } from '@/lib/security-access/operation'
import { isCanonicalStaff } from '@/lib/identity/staff'

/**
 * RoadTour Product Catalog server logic.
 *
 * Stores assortment RULES only. The existing Product Master (products,
 * product_categories, brands, product_variants, product_images) remains the
 * single source of product data and is never written by this module.
 *
 * Effective visibility (which products appear on the Ellbow RoadTour mobile
 * Product page) is computed server-side here and in the mobile API, never in the
 * browser.
 */

export type InclusionMode = 'include_all' | 'selected_only' | 'excluded'
export type VisibilityOverride = 'include' | 'exclude'
export type CategoryKind = 'pet_food' | 'outdoor' | 'electronic' | 'vape' | 'other'

export const ELLBOW_CATALOG_CODE = 'ellbow-roadtour'
export const ELLBOW_CATALOG_NAME = 'Ellbow RoadTour Product Catalog'

const normalize = (value?: string | null) =>
  (value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '')

export interface CategoryRow {
  id: string
  category_code: string | null
  category_name: string | null
  is_vape: boolean | null
  is_active: boolean | null
}

/**
 * Classify a Product Master category robustly. We never rely on the display name
 * alone: is_vape (the authoritative flag) wins, then the category_code prefix
 * (PET-/OUT-/ELE-/VAP-), then a normalized name match.
 */
export function classifyCategory(category: Pick<CategoryRow, 'category_code' | 'category_name' | 'is_vape'>): CategoryKind {
  if (category.is_vape === true) return 'vape'
  const code = normalize(category.category_code)
  const name = normalize(category.category_name)
  if (code.startsWith('vap') || name.includes('vape')) return 'vape'
  if (code.startsWith('pet') || name.includes('petfood') || name.includes('pet')) return 'pet_food'
  if (code.startsWith('out') || name.includes('outdoor')) return 'outdoor'
  if (code.startsWith('ele') || name.includes('electronic')) return 'electronic'
  return 'other'
}

/** Default Ellbow inclusion mode for a category. "Other" uses the safest default. */
export function defaultInclusionMode(category: Pick<CategoryRow, 'category_code' | 'category_name' | 'is_vape'>): InclusionMode {
  switch (classifyCategory(category)) {
    case 'pet_food':
      return 'include_all'
    case 'outdoor':
    case 'electronic':
      return 'selected_only'
    case 'vape':
      return 'excluded'
    default:
      return 'excluded' // safest default for unmapped categories
  }
}

export type VisibilitySource = 'category' | 'manual' | 'vape_lock'

export interface EffectiveVisibility {
  included: boolean
  source: VisibilitySource
  mode: InclusionMode
}

/**
 * Single source of truth for a product's effective RoadTour visibility.
 *
 *  - category rule include_all   -> included, unless a manual `exclude` override
 *  - category rule selected_only -> excluded, unless a manual `include` override
 *  - category rule excluded      -> excluded (Vape is hard-locked here)
 *  - no category rule            -> excluded (safest)
 *
 * The product must also be active and its category must not be Vape.
 */
export function computeEffectiveVisibility(args: {
  isVapeCategory: boolean
  mode: InclusionMode | null
  override: VisibilityOverride | null | undefined
}): EffectiveVisibility {
  const mode: InclusionMode = args.mode ?? 'excluded'

  // Vape can never be shown for Ellbow, regardless of overrides.
  if (args.isVapeCategory) {
    return { included: false, source: 'vape_lock', mode: 'excluded' }
  }

  if (args.override === 'exclude') {
    return { included: false, source: 'manual', mode }
  }
  if (args.override === 'include') {
    return { included: true, source: 'manual', mode }
  }
  if (mode === 'include_all') {
    return { included: true, source: 'category', mode }
  }
  // selected_only or excluded with no override
  return { included: false, source: 'category', mode }
}

export interface AssortmentProduct {
  id: string
  product_code: string | null
  product_name: string
  product_description: string | null
  is_active: boolean | null
  is_vape: boolean | null
  category_id: string | null
  brand_id: string | null
  category_name: string | null
  category_is_vape: boolean | null
  hide_price: boolean | null
  brand_name: string | null
  primary_image_url: string | null
  price: number | null
  variant_count: number
}

export interface AssortmentRow extends AssortmentProduct {
  inclusion_mode: InclusionMode | null
  override: VisibilityOverride | null
  featured: boolean
  sort_order: number
  effective_included: boolean
  visibility_source: VisibilitySource
}

/**
 * Build the admin assortment table rows from Product Master products plus the
 * catalog's category rules and per-product overrides. Pure / testable.
 */
export function buildAssortmentRows(
  products: AssortmentProduct[],
  modeByCategory: Map<string, InclusionMode>,
  itemByProduct: Map<string, { override: VisibilityOverride | null; featured: boolean; sort_order: number }>,
): AssortmentRow[] {
  return products.map((product) => {
    const mode = product.category_id ? modeByCategory.get(product.category_id) ?? null : null
    const item = itemByProduct.get(product.id)
    const visibility = computeEffectiveVisibility({
      isVapeCategory: product.category_is_vape === true || product.is_vape === true,
      mode,
      override: item?.override ?? null,
    })
    return {
      ...product,
      inclusion_mode: mode,
      override: item?.override ?? null,
      featured: item?.featured ?? false,
      sort_order: item?.sort_order ?? 0,
      effective_included: visibility.included && product.is_active === true,
      visibility_source: visibility.source,
    }
  })
}

/** Mobile/sort order: featured first, then sort_order, then product name. */
export function sortAssortment<T extends { featured: boolean; sort_order: number; product_name: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
    return (a.product_name || '').localeCompare(b.product_name || '')
  })
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

interface ProgramRow {
  id: string
  organization_id: string
  code: string
  name: string
  active: boolean
}

export interface RoadtourCatalogContext {
  supabase: any
  admin: any
  user: { id: string }
  organizationId: string
  program: ProgramRow
  catalog: { id: string; code: string; name: string; active: boolean }
}

/**
 * Authenticated admin context for the Ellbow RoadTour catalog. Validates the
 * user, organization and HQ/power-user role (level <= 40), resolves the Ellbow
 * loyalty program for the caller's organization, and (when initialize) creates
 * the catalog and default category rules idempotently. organization_id is taken
 * from the user profile, never from the client.
 */
export async function getRoadtourCatalogContext({ initialize = false, permission = 'roadtour.campaign.manage' }: { initialize?: boolean; permission?: string } = {}): Promise<RoadtourCatalogContext> {
  const supabase = await createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) throw new EllbowApiError('Unauthorized', 401)

  const { data: profile, error: profileError } = await (supabase as any)
    .from('users')
    .select('organization_id, is_active, account_status, principal_type, roles:role_code(role_level)')
    .eq('id', user.id)
    .single()
  const role = Array.isArray(profile?.roles) ? profile.roles[0] : profile?.roles
  const legacyAllowed = !profileError && isCanonicalStaff(profile, role?.role_level, 40)
  // S&A decides in the actor's organization; the historical staff rule is
  // the legacy evaluator.
  const allowed = profile?.organization_id
    ? await authorizeOperation({
        actorId: user.id,
        permission,
        resource: organizationResource('loyalty_program', profile.organization_id),
        legacy: () => legacyAllowed,
      }).then(d => d.decision === 'ALLOW').catch(() => false)
    : false
  if (!allowed) {
    throw new EllbowApiError('Forbidden', 403)
  }
  const organizationId = profile.organization_id as string

  const { data: program, error: programError } = await (supabase as any)
    .from('loyalty_programs')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('code', 'ellbow')
    .maybeSingle()
  if (programError) throw programError
  if (!program) throw new EllbowApiError('Ellbow Loyalty is not available for this organization', 404)

  const catalog = await ensureCatalogAndRules(supabase, organizationId, program, initialize)

  return { supabase, admin: createAdminClient() as any, user, organizationId, program, catalog }
}

/**
 * Idempotently ensure the Ellbow RoadTour catalog exists and that default
 * category rules are present. Never overwrites an existing rule (so admin edits
 * are preserved); only inserts rules that are missing.
 */
export async function ensureCatalogAndRules(supabase: any, organizationId: string, program: ProgramRow, initialize: boolean) {
  let { data: catalog, error: catalogError } = await supabase
    .from('roadtour_product_catalogs')
    .select('id, code, name, active')
    .eq('organization_id', organizationId)
    .eq('loyalty_program_id', program.id)
    .maybeSingle()
  if (catalogError) throw catalogError

  if (!catalog) {
    if (!initialize) throw new EllbowApiError('Ellbow RoadTour catalog is not initialized', 404)
    const inserted = await supabase
      .from('roadtour_product_catalogs')
      .upsert({
        organization_id: organizationId,
        loyalty_program_id: program.id,
        code: ELLBOW_CATALOG_CODE,
        name: ELLBOW_CATALOG_NAME,
        active: true,
      }, { onConflict: 'organization_id,loyalty_program_id' })
      .select('id, code, name, active')
      .single()
    if (inserted.error) throw inserted.error
    catalog = inserted.data
  }

  if (initialize) {
    const { data: categories, error: catErr } = await supabase
      .from('product_categories')
      .select('id, category_code, category_name, is_vape, is_active')
    if (catErr) throw catErr
    const rules = (categories ?? []).map((c: CategoryRow) => ({
      organization_id: organizationId,
      loyalty_program_id: program.id,
      catalog_id: catalog.id,
      product_category_id: c.id,
      inclusion_mode: defaultInclusionMode(c),
    }))
    if (rules.length > 0) {
      // ignoreDuplicates so existing admin-set rules are never overwritten.
      const ruleResult = await supabase
        .from('roadtour_product_category_rules')
        .upsert(rules, { onConflict: 'catalog_id,product_category_id', ignoreDuplicates: true })
      if (ruleResult.error) throw ruleResult.error
    }
  }

  return catalog
}

const PRODUCT_SELECT = `
  id,
  product_code,
  product_name,
  product_description,
  is_active,
  is_vape,
  category_id,
  brand_id,
  brands ( brand_name ),
  product_categories ( category_name, is_vape, hide_price ),
  product_images ( image_url, is_primary ),
  product_variants ( id, suggested_retail_price, other_price )
`

function transformProduct(item: any): AssortmentProduct {
  const category = Array.isArray(item.product_categories) ? item.product_categories[0] : item.product_categories
  const brand = Array.isArray(item.brands) ? item.brands[0] : item.brands
  const variants: any[] = item.product_variants || []
  const primary = (item.product_images || []).find((img: any) => img.is_primary) || (item.product_images || [])[0]
  const price = variants
    .map((v) => v.suggested_retail_price ?? v.other_price)
    .filter((p) => p !== null && p !== undefined)
    .map(Number)
    .sort((a, b) => a - b)[0] ?? null
  return {
    id: item.id,
    product_code: item.product_code,
    product_name: item.product_name,
    product_description: item.product_description,
    is_active: item.is_active,
    is_vape: item.is_vape,
    category_id: item.category_id,
    brand_id: item.brand_id,
    category_name: category?.category_name ?? null,
    category_is_vape: category?.is_vape ?? null,
    hide_price: category?.hide_price ?? false,
    brand_name: brand?.brand_name ?? null,
    primary_image_url: primary?.image_url ?? null,
    price,
    variant_count: variants.length,
  }
}

/**
 * Load the full admin assortment for a catalog: every Product Master product the
 * caller can see, annotated with its effective RoadTour visibility. Uses the
 * caller's RLS-scoped client so org isolation is enforced by the database.
 */
export async function loadAssortment(ctx: RoadtourCatalogContext): Promise<AssortmentRow[]> {
  const { supabase, organizationId, program, catalog } = ctx

  const [{ data: productsData, error: productsError }, { data: rulesData, error: rulesError }, { data: itemsData, error: itemsError }] =
    await Promise.all([
      supabase.from('products').select(PRODUCT_SELECT).order('product_name'),
      supabase.from('roadtour_product_category_rules')
        .select('product_category_id, inclusion_mode')
        .eq('catalog_id', catalog.id).eq('organization_id', organizationId).eq('loyalty_program_id', program.id),
      supabase.from('roadtour_product_catalog_items')
        .select('product_id, visibility_override, featured, sort_order')
        .eq('catalog_id', catalog.id).eq('organization_id', organizationId).eq('loyalty_program_id', program.id),
    ])
  if (productsError) throw productsError
  if (rulesError) throw rulesError
  if (itemsError) throw itemsError

  const modeByCategory = new Map<string, InclusionMode>(
    (rulesData ?? []).map((r: any) => [r.product_category_id, r.inclusion_mode as InclusionMode]),
  )
  const itemByProduct = new Map<string, { override: VisibilityOverride | null; featured: boolean; sort_order: number }>(
    (itemsData ?? []).map((i: any) => [i.product_id, { override: i.visibility_override, featured: i.featured, sort_order: i.sort_order }]),
  )
  const products = (productsData ?? []).map(transformProduct)
  return buildAssortmentRows(products, modeByCategory, itemByProduct)
}

export { PRODUCT_SELECT, transformProduct }
