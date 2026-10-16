import { sellableStock } from '@/lib/storefront/order-stock'
import { outdoorStaticImage, outdoorSwatchesFromVariants } from '@/lib/outdoor/merch'
import {
  bundleAvailability,
  bundleComparePrice,
  checkoutSettingsFromRow,
  defaultOrderBumpText,
  DEFAULT_OUTDOOR_CHECKOUT_SETTINGS,
  normalizeAffiliateCode,
  type OutdoorBundle,
  type OutdoorCheckoutSettings,
  type OutdoorOrderBumpOffer,
} from '@/lib/outdoor/sales-tools'

/** Tables not migrated yet: behave as if every tool is switched off. */
function isMissingTable(error: any) {
  return /outdoor_(checkout_settings|bundles|bundle_items|affiliates)|PGRST205|42P01|does not exist/i.test(
    `${error?.code || ''} ${error?.message || ''}`,
  )
}

export async function loadOutdoorCheckoutSettings(supabase: any): Promise<OutdoorCheckoutSettings> {
  const { data, error } = await supabase.from('outdoor_checkout_settings').select('*').eq('id', 1).maybeSingle()
  if (error) {
    if (!isMissingTable(error)) console.error('[outdoor sales tools] settings', error)
    return { ...DEFAULT_OUTDOOR_CHECKOUT_SETTINGS }
  }
  return checkoutSettingsFromRow(data)
}

/** The checkout offer as the shopper sees it, or null when it is off, unpriced or sold out. */
export async function loadOrderBumpOffer(
  supabase: any,
  settings?: OutdoorCheckoutSettings,
): Promise<OutdoorOrderBumpOffer | null> {
  const s = settings || (await loadOutdoorCheckoutSettings(supabase))
  if (!s.orderBumpEnabled || !s.orderBumpVariantId || s.orderBumpPrice == null || s.orderBumpPrice < 0) return null
  const { data: variant, error } = await supabase
    .from('product_variants')
    .select('id, product_id, variant_name, image_url, attributes, is_active, products(product_name)')
    .eq('id', s.orderBumpVariantId)
    .maybeSingle()
  if (error || !variant || variant.is_active === false) return null
  const stock = await sellableStock(supabase, [variant.id])
  if (stock && (stock.get(variant.id) ?? 0) <= 0) return null
  const productName = String(variant.products?.product_name || variant.variant_name || 'add-on').trim()
  return {
    variantId: variant.id,
    productId: String(variant.product_id || ''),
    productName,
    variantName: String(variant.variant_name || ''),
    imageUrl: outdoorSwatchesFromVariants([variant], productName)[0]?.imageUrl || outdoorStaticImage(productName, 'burgundy') || null,
    price: s.orderBumpPrice,
    comparePrice: s.orderBumpComparePrice,
    text: s.orderBumpText || defaultOrderBumpText(s.orderBumpPrice, productName, s.orderBumpComparePrice),
  }
}

/**
 * Combos with their real items. Shoppers only get active combos whose items are
 * all still on sale; staff (includeInactive) see every combo.
 */
export async function loadOutdoorBundles(
  supabase: any,
  options?: { ids?: string[]; includeInactive?: boolean; withStock?: boolean },
): Promise<Array<OutdoorBundle & { isActive: boolean; sortOrder: number; complete: boolean }>> {
  let query = supabase
    .from('outdoor_bundles')
    .select('id, name, description, price, image_url, is_active, sort_order, outdoor_bundle_items(variant_id, quantity)')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
  if (options?.ids) {
    if (options.ids.length === 0) return []
    query = query.in('id', options.ids)
  }
  if (!options?.includeInactive) query = query.eq('is_active', true)
  const { data: rows, error } = await query
  if (error) {
    if (!isMissingTable(error)) console.error('[outdoor sales tools] bundles', error)
    return []
  }

  const variantIds = [
    ...new Set((rows || []).flatMap((row: any) => (row.outdoor_bundle_items || []).map((item: any) => String(item.variant_id)))),
  ] as string[]
  const variants = new Map<string, any>()
  if (variantIds.length > 0) {
    const { data } = await supabase
      .from('product_variants')
      .select('id, product_id, variant_name, suggested_retail_price, is_active, image_url, attributes, products(product_name)')
      .in('id', variantIds)
    for (const variant of data || []) variants.set(String(variant.id), variant)
  }
  const stock = options?.withStock === false ? null : await sellableStock(supabase, variantIds)

  const out: Array<OutdoorBundle & { isActive: boolean; sortOrder: number; complete: boolean }> = []
  for (const row of rows || []) {
    const items = row.outdoor_bundle_items || []
    const components = items
      .map((item: any) => {
        const variant = variants.get(String(item.variant_id))
        if (!variant) return null
        const productName = String(variant.products?.product_name || '').trim()
        return {
          variantId: String(variant.id),
          productId: String(variant.product_id || ''),
          productName,
          imageUrl:
            outdoorSwatchesFromVariants([variant], productName)[0]?.imageUrl ||
            outdoorStaticImage(productName, 'burgundy') ||
            null,
          variantName: String(variant.variant_name || ''),
          quantity: Math.max(1, Number(item.quantity) || 1),
          retailPrice: Number(variant.suggested_retail_price) || 0,
          active: variant.is_active !== false,
        }
      })
      .filter(Boolean) as Array<OutdoorBundle['components'][number] & { active: boolean }>
    const complete = components.length > 0 && components.length === items.length && components.every((c) => c.active)
    if (!options?.includeInactive && !complete) continue
    out.push({
      id: String(row.id),
      name: String(row.name || ''),
      description: String(row.description || ''),
      price: Number(row.price) || 0,
      imageUrl: row.image_url || null,
      components: components.map(({ active: _active, ...c }) => c),
      comparePrice: bundleComparePrice(components),
      available: bundleAvailability(components, stock),
      isActive: row.is_active !== false,
      sortOrder: Number(row.sort_order) || 0,
      complete,
    })
  }
  return out
}

export async function resolveOutdoorAffiliate(supabase: any, raw: unknown): Promise<{ id: string; code: string } | null> {
  const code = normalizeAffiliateCode(raw)
  if (!code) return null
  const { data, error } = await supabase
    .from('outdoor_affiliates')
    .select('id, code')
    .eq('code', code)
    .eq('is_active', true)
    .maybeSingle()
  if (error) {
    if (!isMissingTable(error)) console.error('[outdoor sales tools] affiliate', error)
    return null
  }
  return data ? { id: String(data.id), code: String(data.code) } : null
}
