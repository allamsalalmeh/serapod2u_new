import { categoryNameForProgram } from './constants'
import { classifyProductLine, getUnitsPerCase } from './format'
import { getStorageUrl } from '@/lib/utils'
import type { EligibleProduct, EligibleProductsResult, ReturnCategoryRef } from './types'

type Admin = any

/**
 * Phase 1 eligibility resolution (see product spec):
 *
 *   shop  →  loyalty program (membership)  →  mapped product category  →
 *   ALL active products / variants / SKUs in that category.
 *
 * This deliberately does NOT use shop-level availability, distributor stock,
 * order history or get_shop_available_products() — Serapod sells through
 * distributors on external systems, so shop-level availability is incomplete.
 *
 * If the category cannot be auto-resolved (unmapped/absent program), the caller
 * is expected to present a manual Category selector; passing `overrideCategoryId`
 * loads all active products from that category instead. We never silently fall
 * back to every category.
 */
export async function resolveEligibleProducts(
    admin: Admin,
    shopOrgId: string,
    overrideCategoryId?: string | null,
): Promise<EligibleProductsResult> {
    const categories = await loadActiveCategories(admin)

    // 1. Resolve the shop's (mapped) loyalty program.
    const program = await resolveShopProgram(admin, shopOrgId)

    // 2. Decide the category.
    let category: ReturnCategoryRef | null = null
    let resolved = false
    if (overrideCategoryId) {
        category = categories.find((c) => c.id === overrideCategoryId) || null
    } else if (program) {
        const wantName = categoryNameForProgram(program.code, program.name)
        if (wantName) {
            const target = wantName.trim().toLowerCase()
            category = categories.find((c) => c.category_name.trim().toLowerCase() === target) || null
            resolved = !!category
        }
    }

    // 3. Load the eligible product lines for the chosen category.
    const products = category ? await loadCategoryProducts(admin, category.id) : []

    return { program, category, resolved, categories, products }
}

async function loadActiveCategories(admin: Admin): Promise<ReturnCategoryRef[]> {
    const { data } = await admin
        .from('product_categories')
        .select('id, category_code, category_name, sort_order')
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
        .order('category_name', { ascending: true })
    return (data || []).map((c: any) => ({
        id: c.id,
        category_code: c.category_code ?? null,
        category_name: c.category_name,
    }))
}

/**
 * The shop's active, mapped loyalty program. Prefers a program that has a
 * category mapping (Cellera/Ellbow); returns null if the shop has none or the
 * membership tables are unavailable in this environment.
 */
async function resolveShopProgram(
    admin: Admin,
    shopOrgId: string,
): Promise<{ code: string; name: string } | null> {
    try {
        const { data: memberships, error } = await admin
            .from('loyalty_program_organization_memberships')
            .select('loyalty_program_id, status')
            .eq('member_organization_id', shopOrgId)
            .eq('status', 'active')
        if (error || !memberships || memberships.length === 0) return null

        const programIds = Array.from(
            new Set(memberships.map((m: any) => m.loyalty_program_id).filter(Boolean)),
        )
        if (programIds.length === 0) return null

        const { data: programs } = await admin
            .from('loyalty_programs')
            .select('id, code, name, active')
            .in('id', programIds)

        const active = (programs || []).filter((p: any) => p.active !== false)
        if (active.length === 0) return null

        // Prefer a program that has a category mapping.
        const mapped = active.find((p: any) => categoryNameForProgram(p.code, p.name))
        const chosen = mapped || active[0]
        return { code: chosen.code, name: chosen.name || chosen.code }
    } catch {
        return null
    }
}

/**
 * All active products (with active variants + first active SKU) in a category.
 * One worksheet line per active variant.
 */
async function loadCategoryProducts(admin: Admin, categoryId: string): Promise<EligibleProduct[]> {
    // NB: `products` has no `sort_order` column — do NOT select it (the final
    // ordering is by product/variant name in JS). Selecting a non-existent column
    // returns a PostgREST 400 that would otherwise be swallowed into an empty
    // worksheet. Every query below surfaces its error instead of falling back to
    // `[]`, so a schema/RLS problem is visible rather than silently "no products".
    const { data: products, error: prodErr } = await admin
        .from('products')
        .select('id, product_name, units_per_case, is_active')
        .eq('category_id', categoryId)
        .eq('is_active', true)
    if (prodErr) throw new Error(`Failed to load products for category ${categoryId}: ${prodErr.message}`)
    if (!products || products.length === 0) return []

    const productMap = new Map<string, any>(products.map((p: any) => [p.id, p]))
    const productIds = products.map((p: any) => p.id)

    // Variants + their media (reuse the existing `variant_media` table — same
    // source the Product Variant screen uses — so each flavour shows its own image).
    const { data: variants, error: varErr } = await admin
        .from('product_variants')
        .select('id, product_id, variant_name, product_code, alternative_name, barcode, manufacturer_sku, manual_sku, image_url, base_cost, distributor_price, retailer_price, is_active, is_default, sort_order, variant_media(type, url, is_default, sort_order)')
        .in('product_id', productIds)
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
    if (varErr) throw new Error(`Failed to load product variants: ${varErr.message}`)
    const variantList = variants || []
    if (variantList.length === 0) return []

    const variantIds = variantList.map((v: any) => v.id)
    const { data: skus, error: skuErr } = await admin
        .from('product_skus')
        .select('id, variant_id, sku_code, quantity_per_package, is_active, created_at')
        .in('variant_id', variantIds)
        .eq('is_active', true)
        .order('created_at', { ascending: true })
    if (skuErr) throw new Error(`Failed to load product SKUs: ${skuErr.message}`)

    // First active SKU per variant.
    const skuByVariant = new Map<string, any>()
    for (const s of skus || []) {
        if (!skuByVariant.has(s.variant_id)) skuByVariant.set(s.variant_id, s)
    }

    // Product-level primary image (last-resort fallback below the variant media).
    const { data: productImages, error: imgErr } = await admin
        .from('product_images')
        .select('product_id, image_url, is_primary, is_active, sort_order')
        .in('product_id', productIds)
        .eq('is_active', true)
    if (imgErr) throw new Error(`Failed to load product images: ${imgErr.message}`)
    const productImageByProduct = new Map<string, any[]>()
    for (const img of productImages || []) {
        const arr = productImageByProduct.get(img.product_id) || []
        arr.push(img)
        productImageByProduct.set(img.product_id, arr)
    }

    const rows: EligibleProduct[] = variantList.map((v: any) => {
        const product = productMap.get(v.product_id)
        const sku = skuByVariant.get(v.id) || null
        const productName = product?.product_name ?? 'Product'
        const imageUrl = resolveVariantImage(v, productImageByProduct.get(v.product_id) || [])
        return {
            product_id: v.product_id,
            variant_id: v.id,
            sku_id: sku?.id ?? null,
            sku: sku?.sku_code ?? null,
            manual_sku: v.manual_sku ?? null,
            manufacturer_sku: v.manufacturer_sku ?? null,
            barcode: v.barcode ?? null,
            product_name: productName,
            variant_name: v.variant_name ?? null,
            variant_product_code: v.product_code ?? null,
            alternative_name: v.alternative_name ?? null,
            product_line: classifyProductLine(productName),
            image_url: imageUrl,
            units_per_case: getUnitsPerCase(productName, product?.units_per_case ?? sku?.quantity_per_package),
            unit_cost: v.base_cost != null ? Number(v.base_cost) : 0,
            distributor_price: v.distributor_price != null ? Number(v.distributor_price) : null,
            retailer_price: v.retailer_price != null ? Number(v.retailer_price) : null,
            is_active: true,
        }
    })

    // When the category is Vape (Cellera Loyalty), auto-load all four supported
    // product lines: Hero, Zero, S.Box, S.Line. Unsupported / legacy / accessory
    // products (classified as "other") are left to "Add Other Product".
    // Categories with no recognised line (e.g. Pet Food) keep loading every
    // active variant, so this never narrows a non-Vape category.
    const supportedLines: Set<string> = new Set(['hero', 'zero', 'sbox', 'sline'])
    const hasSupportedLines = rows.some((r) => supportedLines.has(r.product_line))
    const scoped = hasSupportedLines
        ? rows.filter((r) => supportedLines.has(r.product_line))
        : rows

    // Stable sort: product name, then variant name.
    scoped.sort((a, b) => {
        const p = a.product_name.localeCompare(b.product_name)
        if (p !== 0) return p
        return (a.variant_name || '').localeCompare(b.variant_name || '')
    })
    return scoped
}

/**
 * Resolve a worksheet thumbnail for a variant, reusing the existing media system
 * (variant_media table + the shared `getStorageUrl` resolver that appends the
 * storage apikey for self-hosted Kong). Priority:
 *   1. Variant default/primary image (variant_media default, else legacy image_url)
 *   2. First active variant_media image (by is_default, then sort_order)
 *   3. Product primary image (product_images)
 * Returns a full URL, or null so the client shows the placeholder.
 */
function resolveVariantImage(variant: any, productImages: any[]): string | null {
    const mediaImages = ((variant.variant_media || []) as any[])
        .filter((m) => m?.type === 'image' && typeof m.url === 'string' && m.url.trim())
        .sort((a, b) => (Number(Boolean(b.is_default)) - Number(Boolean(a.is_default)))
            || ((a.sort_order ?? Number.MAX_SAFE_INTEGER) - (b.sort_order ?? Number.MAX_SAFE_INTEGER)))

    const defaultMedia = mediaImages.find((m) => m.is_default)?.url
    const legacyVariantImage = typeof variant.image_url === 'string' && variant.image_url.trim() ? variant.image_url : null
    const firstMedia = mediaImages[0]?.url
    const productPrimary = [...productImages]
        .sort((a, b) => (Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary)))
            || ((a.sort_order ?? Number.MAX_SAFE_INTEGER) - (b.sort_order ?? Number.MAX_SAFE_INTEGER)))
        .find((img) => typeof img.image_url === 'string' && img.image_url.trim())?.image_url

    const path = defaultMedia || legacyVariantImage || firstMedia || productPrimary || null
    if (!path) return null
    return getStorageUrl(path) || null
}
