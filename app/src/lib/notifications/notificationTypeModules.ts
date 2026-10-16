/**
 * Notification Types page — presentation helpers.
 *
 * Categories are grouped under the Security & Access module taxonomy so the
 * page reads in the same order as S&A. Grouping is display only: routing still
 * resolves Default → Category → Notification, never per module.
 */
import { MODULE_TAXONOMY, OTHER_MODULE } from '@/lib/security-access/modules'
import type { NotificationRoutingPreset } from '@/lib/notifications/routing'

/** Stable category key (notification_types.category) → S&A module group id. */
export const CATEGORY_MODULE: Record<string, string> = {
  order: 'supply_chain',
  document: 'supply_chain',
  inventory: 'supply_chain',
  return: 'supply_chain',
  qr: 'customer_growth',
  roadtour: 'customer_growth',
  ecommerce: 'customer_growth',
  security: 'platform_settings',
  user: 'platform_settings',
  'Delete Organization Masterdata': 'platform_settings',
  system: 'platform_settings',
}

export const CATEGORY_LABELS: Record<string, string> = {
  order: 'Order Status',
  document: 'Order Document',
  inventory: 'Inventory & Stock',
  return: 'Return Product',
  qr: 'QR & Consumer',
  roadtour: 'RoadTour',
  ecommerce: 'E-Commerce',
  security: 'Security & OTP',
  user: 'User Account',
  'Delete Organization Masterdata': 'Delete Organization Masterdata',
  system: 'System Check',
}

/** Category order inside each module; unknown categories follow alphabetically. */
const CATEGORY_ORDER = ['order', 'document', 'inventory', 'return', 'qr', 'roadtour', 'ecommerce', 'security', 'user', 'Delete Organization Masterdata', 'system']

export const categoryLabel = (category: string) => CATEGORY_LABELS[category] || category
export const categoryModule = (category: string) => CATEGORY_MODULE[category] || OTHER_MODULE.id

const MODULE_ORDER = [...MODULE_TAXONOMY.map((group) => group.id), OTHER_MODULE.id]
const MODULE_NAMES = new Map<string, string>([...MODULE_TAXONOMY.map((g) => [g.id, g.name] as [string, string]), [OTHER_MODULE.id, OTHER_MODULE.name]])
export const moduleName = (id: string) => MODULE_NAMES.get(id) || id

export interface GroupableType { category: string; event_code: string }
export interface CategoryGroup<T> { category: string; label: string; types: T[] }
export interface ModuleSection<T> { id: string; name: string; categories: CategoryGroup<T>[] }

/**
 * Every existing type lands in exactly one module/category. Only modules that
 * hold at least one type are returned (no empty HR/Finance sections).
 */
export function groupByModule<T extends GroupableType>(types: T[]): ModuleSection<T>[] {
  const byCategory = new Map<string, T[]>()
  types.forEach((type) => {
    const list = byCategory.get(type.category) || []
    list.push(type)
    byCategory.set(type.category, list)
  })
  const rank = (category: string) => {
    const index = CATEGORY_ORDER.indexOf(category)
    return index < 0 ? CATEGORY_ORDER.length : index
  }
  const categories = Array.from(byCategory.keys()).sort((a, b) => rank(a) - rank(b) || categoryLabel(a).localeCompare(categoryLabel(b)))
  const sections = new Map<string, ModuleSection<T>>()
  categories.forEach((category) => {
    const id = categoryModule(category)
    const section = sections.get(id) || { id, name: moduleName(id), categories: [] }
    section.categories.push({ category, label: categoryLabel(category), types: byCategory.get(category)! })
    sections.set(id, section)
  })
  return Array.from(sections.values()).sort((a, b) => MODULE_ORDER.indexOf(a.id) - MODULE_ORDER.indexOf(b.id))
}

export const PRESET_LABELS: Record<NotificationRoutingPreset, string> = {
  whatsapp_only: 'WhatsApp',
  email_only: 'Email',
  sms_only: 'SMS',
  whatsapp_email_fallback: 'WhatsApp → Email',
  whatsapp_sms_email_fallback: 'WhatsApp → SMS → Email',
}

export type DeliverySource = 'default' | 'category' | 'custom' | 'fixed'

export interface RoutingState {
  defaultPreset: NotificationRoutingPreset
  categoryPresets: Record<string, NotificationRoutingPreset | null | undefined>
  eventPresets: Record<string, NotificationRoutingPreset | null | undefined>
}

/** Default → Category override → Notification override (forced presets win). */
export function resolveEventDelivery(
  type: GroupableType,
  routing: RoutingState,
  forced: Record<string, NotificationRoutingPreset> = {},
): { preset: NotificationRoutingPreset; source: DeliverySource } {
  if (forced[type.event_code]) return { preset: forced[type.event_code], source: 'fixed' }
  const own = routing.eventPresets[type.event_code]
  if (own) return { preset: own, source: 'custom' }
  const category = routing.categoryPresets[type.category]
  if (category) return { preset: category, source: 'category' }
  return { preset: routing.defaultPreset, source: 'default' }
}

const SOURCE_LABELS: Record<DeliverySource, string> = { default: 'Default', category: 'Category', custom: 'Custom', fixed: 'Fixed' }

/** "Default · Email", "Category · SMS", "Custom · WhatsApp → Email". */
export const deliveryLabel = (source: DeliverySource, preset: NotificationRoutingPreset) => `${SOURCE_LABELS[source]} · ${PRESET_LABELS[preset]}`

export interface SearchableType extends GroupableType { event_name: string; event_description?: string | null }
export type StatusFilter = 'all' | 'enabled' | 'disabled'

/**
 * Notifications in a category that pass the current filters. A category whose
 * name matches the search keeps every notification that passes the status
 * filter; otherwise only notifications whose name/description match remain.
 */
export function filterCategoryTypes<T extends SearchableType>(
  category: CategoryGroup<T>,
  query: string,
  status: StatusFilter,
  isEnabled: (type: T) => boolean,
): T[] {
  const needle = query.trim().toLowerCase()
  const categoryMatch = !needle || category.label.toLowerCase().includes(needle)
  return category.types.filter((type) => {
    if (status === 'enabled' && !isEnabled(type)) return false
    if (status === 'disabled' && isEnabled(type)) return false
    if (categoryMatch) return true
    return type.event_name.toLowerCase().includes(needle) || String(type.event_description || '').toLowerCase().includes(needle)
  })
}
