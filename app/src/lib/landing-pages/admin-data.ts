import 'server-only'

import {
  DEFAULT_LANDING_PAGE_DISPLAY_SETTINGS,
  DEFAULT_LANDING_PAGE_HERO,
  DEFAULT_LANDING_PAGE_TRACKING,
  EMPTY_LANDING_PAGE_METRICS,
  type LandingPageAdminRecord,
  type LandingPageCategoryOption,
  type LandingPageDisplaySettings,
  type LandingPageHeroConfig,
  type LandingPageMetrics,
  type LandingPagePayload,
  type LandingPageProductOption,
  type LandingPageStatus,
  type LandingPageTrackingDefaults,
} from '@/lib/landing-pages/types'
import { getLandingPageSlugError, normalizeLandingPageSlug } from '@/lib/landing-pages/slug'

function toStorefrontMediaUrl(rawPath: string | null): string | null {
  if (!rawPath) return null
  if (rawPath.startsWith('http://') || rawPath.startsWith('https://')) return rawPath

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!supabaseUrl) return rawPath

  const cleanPath = rawPath.replace(/^\/+/, '')
  const knownBuckets = ['product-variants', 'avatars']
  for (const bucket of knownBuckets) {
    if (cleanPath.startsWith(`${bucket}/`)) {
      const objectPath = cleanPath.slice(bucket.length + 1)
      return `${supabaseUrl}/storage/v1/object/public/${bucket}/${objectPath}`
    }
  }

  const defaultBucket = process.env.NEXT_PUBLIC_SUPABASE_STORAGE_BUCKET || 'avatars'
  return `${supabaseUrl}/storage/v1/object/public/${defaultBucket}/${cleanPath}`
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return Array.from(new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)))
}

function mergeHero(value: unknown): LandingPageHeroConfig {
  return { ...DEFAULT_LANDING_PAGE_HERO, ...((value && typeof value === 'object') ? value : {}) }
}

function mergeDisplaySettings(value: unknown): LandingPageDisplaySettings {
  return { ...DEFAULT_LANDING_PAGE_DISPLAY_SETTINGS, ...((value && typeof value === 'object') ? value : {}) }
}

function mergeTracking(value: unknown): LandingPageTrackingDefaults {
  return { ...DEFAULT_LANDING_PAGE_TRACKING, ...((value && typeof value === 'object') ? value : {}) }
}

function relationObject<T extends Record<string, any>>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function metricClone(): LandingPageMetrics {
  return { ...EMPTY_LANDING_PAGE_METRICS }
}

async function loadLandingPageCategoryMap(adminClient: any, rows: any[]) {
  const categoryIds = uniqueStrings(rows.map((row) => row?.category_id))
  if (categoryIds.length === 0) return new Map<string, any>()

  const { data, error } = await adminClient
    .from('product_categories')
    .select('id, category_name')
    .in('id', categoryIds)

  if (error) throw error
  return new Map((data || []).map((category: any) => [category.id, category]))
}

async function loadLandingPageProductMap(adminClient: any, rows: any[]) {
  const pageIds = uniqueStrings(rows.map((row) => row?.id))
  const productsByPage = new Map<string, any[]>()
  if (pageIds.length === 0) return productsByPage

  const { data, error } = await adminClient
    .from('landing_page_products')
    .select('landing_page_id, product_id, sort_order')
    .in('landing_page_id', pageIds)
    .order('sort_order', { ascending: true })

  if (error) throw error

  for (const row of data || []) {
    if (!productsByPage.has(row.landing_page_id)) productsByPage.set(row.landing_page_id, [])
    productsByPage.get(row.landing_page_id)?.push(row)
  }

  return productsByPage
}

async function hydrateLandingPageRows(adminClient: any, rows: any[]) {
  if (rows.length === 0) return rows

  const [categoriesById, productsByPage] = await Promise.all([
    loadLandingPageCategoryMap(adminClient, rows),
    loadLandingPageProductMap(adminClient, rows),
  ])

  return rows.map((row) => ({
    ...row,
    product_categories: row.category_id ? categoriesById.get(row.category_id) ?? null : null,
    landing_page_products: productsByPage.get(row.id) ?? [],
  }))
}

// Stored rows use null for unset fields; every fallback read below is null-safe.
type LandingPagePayloadFallback = { [K in keyof LandingPagePayload]?: LandingPagePayload[K] | null }

export function normalizeLandingPagePayload(body: any, fallback?: LandingPagePayloadFallback): LandingPagePayload {
  const internalName = String(body?.internal_name ?? fallback?.internal_name ?? '').trim()
  const publicTitle = String(body?.public_title ?? fallback?.public_title ?? '').trim()
  const slugBase = String(body?.slug ?? fallback?.slug ?? publicTitle ?? internalName)
  const sourceMode = body?.source_mode === 'category' ? 'category' : 'manual'
  const status: LandingPageStatus = ['draft', 'published', 'archived'].includes(body?.status) ? body.status : fallback?.status ?? 'draft'

  return {
    internal_name: internalName,
    public_title: publicTitle,
    slug: normalizeLandingPageSlug(slugBase),
    description: String(body?.description ?? fallback?.description ?? '').trim(),
    status,
    source_mode: sourceMode,
    category_id: sourceMode === 'category' ? (body?.category_id || fallback?.category_id || null) : null,
    max_products: Math.min(Math.max(Number(body?.max_products ?? fallback?.max_products ?? 12) || 12, 1), 60),
    hero: mergeHero({ ...(fallback?.hero || {}), ...(body?.hero || {}) }),
    display_settings: mergeDisplaySettings({ ...(fallback?.display_settings || {}), ...(body?.display_settings || {}) }),
    tracking_defaults: mergeTracking({ ...(fallback?.tracking_defaults || {}), ...(body?.tracking_defaults || {}) }),
    publish_start_at: body?.publish_start_at || fallback?.publish_start_at || null,
    publish_end_at: body?.publish_end_at || fallback?.publish_end_at || null,
    selected_product_ids: uniqueStrings(body?.selected_product_ids ?? fallback?.selected_product_ids ?? []),
  }
}

export function validateLandingPageDraft(payload: LandingPagePayload): string[] {
  const errors: string[] = []
  if (!payload.internal_name) errors.push('Internal name is required.')
  if (!payload.public_title) errors.push('Public title is required.')
  const slugError = getLandingPageSlugError(payload.slug)
  if (slugError) errors.push(slugError)
  if (payload.source_mode === 'category' && !payload.category_id) errors.push('Category is required for category source.')
  if (payload.publish_start_at && payload.publish_end_at && new Date(payload.publish_start_at) >= new Date(payload.publish_end_at)) {
    errors.push('Publish end must be after publish start.')
  }
  return errors
}

export function validateLandingPagePublish(payload: LandingPagePayload, validProductCount: number): string[] {
  const errors = validateLandingPageDraft(payload)
  if (!payload.hero.headline.trim()) errors.push('Hero headline is required before publish.')
  if (!payload.hero.subtitle.trim() && !payload.description.trim()) errors.push('Hero subtitle or description is required before publish.')
  if (validProductCount <= 0) errors.push('At least one valid storefront product is required before publish.')

  const purchaseCtaRequested = payload.display_settings.cta_mode === 'add_to_cart' || payload.display_settings.cta_mode === 'buy_now' || payload.display_settings.enable_add_to_cart || payload.display_settings.enable_buy_now
  if (payload.display_settings.show_price === false && purchaseCtaRequested) {
    errors.push('Purchase CTAs cannot be enabled while price is hidden.')
  }
  return errors
}

export async function ensureUniqueLandingPageSlug(adminClient: any, slug: string, excludeId?: string) {
  let query = adminClient.from('landing_pages').select('id').eq('slug', slug).limit(1)
  if (excludeId) query = query.neq('id', excludeId)
  const { data, error } = await query
  if (error) throw error
  if ((data || []).length > 0) {
    const duplicateError = new Error('Slug already exists.') as Error & { status?: number }
    duplicateError.status = 409
    throw duplicateError
  }
}

export async function replaceLandingPageProducts(adminClient: any, landingPageId: string, productIds: string[]) {
  const uniqueIds = uniqueStrings(productIds)
  const { error: deleteError } = await adminClient
    .from('landing_page_products')
    .delete()
    .eq('landing_page_id', landingPageId)
  if (deleteError) throw deleteError

  if (uniqueIds.length === 0) return

  const { error: insertError } = await adminClient
    .from('landing_page_products')
    .insert(uniqueIds.map((productId, index) => ({ landing_page_id: landingPageId, product_id: productId, sort_order: index + 1 })))
  if (insertError) throw insertError
}

export async function getLandingPageMetrics(adminClient: any, pageIds: string[]) {
  const metrics = new Map<string, LandingPageMetrics>()
  pageIds.forEach((id) => metrics.set(id, metricClone()))
  if (pageIds.length === 0) return metrics

  const { data: events } = await adminClient
    .from('landing_page_events')
    .select('landing_page_id, landing_page_session_id, event_type')
    .in('landing_page_id', pageIds)

  const sessions = new Map<string, Set<string>>()
  for (const event of events || []) {
    const metric = metrics.get(event.landing_page_id)
    if (!metric) continue
    if (event.landing_page_session_id) {
      if (!sessions.has(event.landing_page_id)) sessions.set(event.landing_page_id, new Set())
      sessions.get(event.landing_page_id)?.add(event.landing_page_session_id)
    }
    if (event.event_type === 'page_view') metric.views += 1
    if (event.event_type === 'product_click' || event.event_type === 'product_view') metric.product_clicks += 1
    if (event.event_type === 'add_to_cart') metric.add_to_cart += 1
    if (event.event_type === 'checkout_start') metric.checkout_starts += 1
  }

  const { data: attributions, error: attributionError } = await adminClient
    .from('landing_page_order_attributions')
    .select('landing_page_id, order_id, order_total')
    .in('landing_page_id', pageIds)

  if (attributionError) throw attributionError

  const orderIds = uniqueStrings((attributions || []).map((attribution: any) => attribution.order_id))
  const ordersById = new Map<string, any>()
  if (orderIds.length > 0) {
    const { data: orders, error: ordersError } = await adminClient
      .from('storefront_orders')
      .select('id, total_amount, status')
      .in('id', orderIds)

    if (ordersError) throw ordersError

    for (const order of orders || []) {
      ordersById.set(order.id, order)
    }
  }

  for (const attribution of attributions || []) {
    const metric = metrics.get(attribution.landing_page_id)
    if (!metric) continue
    const order = attribution.order_id ? ordersById.get(attribution.order_id) : null
    metric.orders += 1
    const status = String(order?.status || '').toLowerCase()
    if (['paid', 'completed', 'payment_success', 'fulfilled', 'success'].includes(status)) {
      metric.revenue += Number(order?.total_amount ?? attribution.order_total ?? 0)
    }
  }

  for (const [pageId, metric] of metrics.entries()) {
    metric.sessions = sessions.get(pageId)?.size || 0
    metric.conversion_rate = metric.views > 0 ? Number(((metric.orders / metric.views) * 100).toFixed(2)) : 0
  }

  return metrics
}

export function serializeLandingPage(row: any, metrics: LandingPageMetrics = EMPTY_LANDING_PAGE_METRICS): LandingPageAdminRecord {
  const category = relationObject(row.product_categories)
  const selectedProducts = (row.landing_page_products || [])
    .sort((left: any, right: any) => (left.sort_order ?? 999) - (right.sort_order ?? 999))
    .map((product: any) => product.product_id)

  return {
    id: row.id,
    organization_id: row.organization_id,
    internal_name: row.internal_name,
    public_title: row.public_title,
    slug: row.slug,
    description: row.description,
    status: row.status,
    source_mode: row.source_mode,
    category_id: row.category_id,
    category_name: category?.category_name ?? null,
    max_products: row.max_products ?? 12,
    hero: mergeHero(row.hero),
    display_settings: mergeDisplaySettings(row.display_settings),
    tracking_defaults: mergeTracking(row.tracking_defaults),
    publish_start_at: row.publish_start_at,
    publish_end_at: row.publish_end_at,
    published_at: row.published_at,
    selected_product_ids: selectedProducts,
    selected_products_count: selectedProducts.length,
    metrics: { ...EMPTY_LANDING_PAGE_METRICS, ...metrics },
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export async function fetchLandingPageDetail(adminClient: any, id: string, organizationId: string) {
  const { data, error } = await adminClient
    .from('landing_pages')
    .select('*')
    .eq('id', id)
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null
  const [page] = await hydrateLandingPageRows(adminClient, [data])
  const metrics = await getLandingPageMetrics(adminClient, [data.id])
  return serializeLandingPage(page, metrics.get(data.id))
}

export async function listLandingPages(adminClient: any, organizationId: string) {
  const { data, error } = await adminClient
    .from('landing_pages')
    .select('*')
    .eq('organization_id', organizationId)
    .order('updated_at', { ascending: false })

  if (error) throw error
  const rows = await hydrateLandingPageRows(adminClient, data || [])
  const pageIds = rows.map((row: any) => row.id)
  const metrics = await getLandingPageMetrics(adminClient, pageIds)
  return rows.map((row: any) => serializeLandingPage(row, metrics.get(row.id)))
}

export async function listLandingPageProductOptions(adminClient: any): Promise<{ products: LandingPageProductOption[]; categories: LandingPageCategoryOption[] }> {
  const [{ data: categories }, { data: products, error: productError }] = await Promise.all([
    adminClient
      .from('product_categories')
      .select('id, category_name')
      .eq('is_active', true)
      .order('category_name', { ascending: true }),
    adminClient
      .from('products')
      .select(`
        id,
        product_name,
        product_code,
        short_description,
        category_id,
        is_active,
        product_categories(id, category_name),
        brands(id, brand_name),
        product_groups(id, hide_ecommerce, hide_product, hide_price),
        product_variants(id, image_url, animation_url, suggested_retail_price, is_active, is_default, sort_order)
      `)
      .eq('is_active', true)
      .order('product_name', { ascending: true })
      .limit(250),
  ])

  if (productError) throw productError

  const productOptions = (products || [])
    .map((product: any): LandingPageProductOption | null => {
      const group = relationObject(product.product_groups)
      if (group?.hide_ecommerce === true || group?.hide_product === true) return null
      const activeVariants = (product.product_variants || []).filter((variant: any) => variant.is_active !== false)
      if (activeVariants.length === 0) return null
      const prices = activeVariants.map((variant: any) => Number(variant.suggested_retail_price || 0)).filter((price: number) => price > 0)
      const firstMediaVariant = activeVariants.find((variant: any) => variant.image_url || variant.animation_url) || activeVariants[0]
      const category = relationObject(product.product_categories)
      const brand = relationObject(product.brands)
      const priceHidden = group?.hide_price === true

      return {
        id: product.id,
        product_name: product.product_name,
        product_code: product.product_code,
        short_description: product.short_description,
        category_id: product.category_id,
        category_name: category?.category_name ?? null,
        brand_name: brand?.brand_name ?? null,
        image_url: toStorefrontMediaUrl(firstMediaVariant?.image_url || firstMediaVariant?.animation_url || null),
        starting_price: !priceHidden && prices.length > 0 ? Math.min(...prices) : null,
        variant_count: (product.product_variants || []).length,
        active_variant_count: activeVariants.length,
        can_purchase: !priceHidden && prices.length > 0,
      }
    })
    .filter((product: LandingPageProductOption | null): product is LandingPageProductOption => Boolean(product))

  return {
    products: productOptions,
    categories: (categories || []).map((category: any) => ({ id: category.id, name: category.category_name })),
  }
}