import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  classifyCategory,
  computeEffectiveVisibility,
  sortAssortment,
  type InclusionMode,
  type VisibilityOverride,
} from '@/lib/server/roadtour-catalog'

/**
 * GET /api/roadtour/products?org_id=...
 *
 * Effective Ellbow RoadTour mobile Product assortment. Unlike the legacy
 * /api/consumer/products (which returned ALL active products and caused the
 * mixed Vape/Outdoor/Electronic bug), this endpoint returns only products
 * allowed by the Ellbow RoadTour catalog:
 *   - active products allowed by category rules (Pet Food include_all by default)
 *   - plus manually included products (Outdoor / Electronic selected-only)
 *   - minus manually excluded products
 *   - Vape is always excluded
 * sorted by featured then sort_order then name.
 *
 * Filtering happens here (database + server), never in the browser. The response
 * shape mirrors /api/consumer/products so the mobile cards render unchanged.
 */
export async function GET(request: NextRequest) {
  try {
    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } },
    )

    const { searchParams } = new URL(request.url)
    const orgId = searchParams.get('org_id')
    if (!orgId) {
      return NextResponse.json({ success: false, error: 'Organization ID is required' }, { status: 400 })
    }

    // Resolve the Ellbow loyalty program by walking up the org hierarchy from the
    // event/campaign org until we find a program with code 'ellbow'. We never
    // trust a client-supplied catalog id.
    let program: { id: string; organization_id: string } | null = null
    let cursor: string | null = orgId
    const visited = new Set<string>()
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor)
      const { data: prog } = await supabaseAdmin
        .from('loyalty_programs')
        .select('id, organization_id')
        .eq('organization_id', cursor)
        .eq('code', 'ellbow')
        .maybeSingle()
      if (prog) { program = prog as any; break }
      const { data: org }: { data: { parent_org_id: string | null } | null } = await supabaseAdmin
        .from('organizations')
        .select('parent_org_id')
        .eq('id', cursor)
        .maybeSingle()
      cursor = (org as any)?.parent_org_id ?? null
    }

    // Common product select (matches /api/consumer/products field set).
    const productSelect = `
      id,
      product_code,
      product_name,
      product_description,
      is_active,
      is_vape,
      category_id,
      brands (brand_name),
      product_categories (category_name, is_vape, hide_price),
      product_groups ( hide_price, hide_product ),
      product_images ( image_url, is_primary ),
      product_variants (
        id, variant_name, suggested_retail_price, other_price, image_url, animation_url
      )
    `

    const transform = (item: any) => {
      const category = Array.isArray(item.product_categories) ? item.product_categories[0] : item.product_categories
      const group = Array.isArray(item.product_groups) ? item.product_groups[0] : item.product_groups
      return {
        id: item.id,
        product_code: item.product_code,
        product_name: item.product_name,
        product_description: item.product_description,
        brand_name: item.brands?.brand_name || 'No Brand',
        category_name: (category?.category_name || 'Uncategorized').trim(),
        hide_price: (group?.hide_price === true) || (category?.hide_price === true) || false,
        hide_product: group?.hide_product === true,
        primary_image_url:
          item.product_images?.find((img: any) => img.is_primary)?.image_url ||
          item.product_images?.[0]?.image_url ||
          null,
        variants: item.product_variants || [],
        _category_id: item.category_id ?? null,
        _category: category,
        _is_vape: item.is_vape === true || category?.is_vape === true,
      }
    }

    // ----- Fallback: Ellbow program/catalog not configured -----
    // Never fall back to all active products and never expose Vape. The safest
    // fallback is active Pet Food products only.
    if (!program) {
      const { data, error } = await supabaseAdmin.from('products').select(productSelect).eq('is_active', true).order('product_name')
      if (error) throw error
      const products = (data || [])
        .map(transform)
        .filter((p) => !p.hide_product && !p._is_vape && classifyCategory({ category_code: null, category_name: p.category_name, is_vape: p._category?.is_vape }) === 'pet_food')
        .map(({ _category_id, _category, _is_vape, ...rest }) => rest)
      console.warn(`[roadtour/products] Ellbow program not found for org ${orgId}; returning Pet Food fallback (${products.length}).`)
      return NextResponse.json({ success: true, products, fallback: 'pet_food_only' })
    }

    const { data: catalog } = await supabaseAdmin
      .from('roadtour_product_catalogs')
      .select('id')
      .eq('organization_id', program.organization_id)
      .eq('loyalty_program_id', program.id)
      .maybeSingle()

    if (!catalog) {
      const { data, error } = await supabaseAdmin.from('products').select(productSelect).eq('is_active', true).order('product_name')
      if (error) throw error
      const products = (data || [])
        .map(transform)
        .filter((p) => !p.hide_product && !p._is_vape && classifyCategory({ category_code: null, category_name: p.category_name, is_vape: p._category?.is_vape }) === 'pet_food')
        .map(({ _category_id, _category, _is_vape, ...rest }) => rest)
      console.warn(`[roadtour/products] Ellbow catalog not initialized for org ${program.organization_id}; returning Pet Food fallback (${products.length}).`)
      return NextResponse.json({ success: true, products, fallback: 'pet_food_only' })
    }

    const [{ data: rules, error: ruleError }, { data: items, error: itemError }, { data: productData, error: productError }] =
      await Promise.all([
        supabaseAdmin.from('roadtour_product_category_rules')
          .select('product_category_id, inclusion_mode').eq('catalog_id', (catalog as any).id),
        supabaseAdmin.from('roadtour_product_catalog_items')
          .select('product_id, visibility_override, featured, sort_order').eq('catalog_id', (catalog as any).id),
        supabaseAdmin.from('products').select(productSelect).eq('is_active', true).order('product_name'),
      ])
    if (ruleError) throw ruleError
    if (itemError) throw itemError
    if (productError) throw productError

    const modeByCategory = new Map<string, InclusionMode>(
      (rules || []).map((r: any) => [r.product_category_id, r.inclusion_mode as InclusionMode]),
    )
    const itemByProduct = new Map<string, { override: VisibilityOverride | null; featured: boolean; sort_order: number }>(
      (items || []).map((i: any) => [i.product_id, { override: i.visibility_override, featured: i.featured, sort_order: i.sort_order }]),
    )

    const rows = (productData || [])
      .map(transform)
      .filter((p) => !p.hide_product)
      .map((p) => {
        const item = itemByProduct.get(p.id)
        const visibility = computeEffectiveVisibility({
          isVapeCategory: p._is_vape,
          mode: p._category_id ? modeByCategory.get(p._category_id) ?? null : null,
          override: item?.override ?? null,
        })
        return { ...p, _included: visibility.included, featured: item?.featured ?? false, sort_order: item?.sort_order ?? 0 }
      })
      .filter((p) => p._included)

    const products = sortAssortment(rows).map(({ _category_id, _category, _is_vape, _included, featured, sort_order, ...rest }) => rest)

    return NextResponse.json({ success: true, products })
  } catch (error: any) {
    console.error('Error in roadtour products API:', error)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
