/**
 * Notification Types page — presentation helpers.
 *
 * Categories are grouped under the Security & Access module taxonomy so the
 * page reads in the same order as S&A. Grouping is display only: routing still
 * resolves Default → Category → Notification, never per module.
 *
 * Supply Chain notifications are shown in display groups (Sales Orders,
 * Purchase Orders, Production & Receiving, Documents & Payments) chosen per
 * event. The stored category (notification_types.category) stays the routing
 * key: a display group always routes through its events' stored category, so
 * regrouping never changes an inherited category route. Event codes are
 * unchanged.
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
  system_log: 'platform_settings',
}

export const CATEGORY_LABELS: Record<string, string> = {
  order: 'Order Status',
  document: 'Order Document',
  inventory: 'Inventory & Stock',
  return: 'Returns',
  qr: 'QR & Consumer',
  roadtour: 'RoadTour',
  ecommerce: 'E-Commerce',
  security: 'Security & OTP',
  user: 'User Account',
  'Delete Organization Masterdata': 'Delete Organization Masterdata',
  system: 'System Check',
  system_log: 'System Log',
}

/** Category order inside each module; unknown categories follow alphabetically. */
const CATEGORY_ORDER = ['sales_orders', 'purchase_orders', 'production_receiving', 'documents_payments', 'order', 'document', 'inventory', 'return', 'qr', 'roadtour', 'ecommerce', 'security', 'user', 'Delete Organization Masterdata', 'system', 'system_log']

export const categoryLabel = (category: string) => DISPLAY_GROUPS[category]?.label || CATEGORY_LABELS[category] || category
export const categoryModule = (category: string) => CATEGORY_MODULE[category] || CATEGORY_MODULE[DISPLAY_GROUPS[category]?.routingCategory || ''] || OTHER_MODULE.id

export interface DisplayGroup { label: string; routingCategory: string; description: string }

/** Supply Chain display groups. Each routes through one stored category. */
export const DISPLAY_GROUPS: Record<string, DisplayGroup> = {
  sales_orders: { label: 'Sales Orders', routingCategory: 'order', description: 'Order lifecycle: submitted, approved, rejected and closed. These cover every order type — sales orders (D2H, S2D) and purchase orders to manufacturers (H2M) — and are listed once, here.' },
  purchase_orders: { label: 'Purchase Orders', routingCategory: 'document', description: 'Purchase order (PO) documents. Order Submitted/Approved/Rejected/Closed for purchase orders are under Sales Orders.' },
  production_receiving: { label: 'Production & Receiving', routingCategory: 'order', description: 'QR batch generation, manufacturer production and warehouse receiving.' },
  documents_payments: { label: 'Documents & Payments', routingCategory: 'document', description: 'Invoices, payments and receipts. Each follows the order it belongs to.' },
}

/** Event → display group. Only applied when the event's stored category is the group's routing category. */
export const EVENT_DISPLAY_GROUP: Record<string, string> = {
  order_submitted: 'sales_orders', order_approved: 'sales_orders', order_rejected: 'sales_orders', order_closed: 'sales_orders',
  order_deleted: 'sales_orders', order_confirmed: 'sales_orders',
  po_created: 'purchase_orders', po_acknowledged: 'purchase_orders',
  qr_batch_generated: 'production_receiving', manufacturer_scan_complete: 'production_receiving', warehouse_received: 'production_receiving',
  invoice_created: 'documents_payments', invoice_acknowledged: 'documents_payments', balance_request_created: 'documents_payments',
  payment_received: 'documents_payments', balance_payment_received: 'documents_payments', receipt_issued: 'documents_payments',
}

/** Who an event is about, shown next to it so a shared event is not mistaken for a duplicate. */
export const EVENT_SCOPE: Record<string, string> = {
  order_submitted: 'All order types', order_approved: 'All order types', order_rejected: 'All order types', order_closed: 'All order types',
  po_created: 'PO document · follows its order', po_acknowledged: 'PO document · follows its order',
  qr_batch_generated: 'Manufacturer orders (H2M)', manufacturer_scan_complete: 'Manufacturer orders (H2M)', warehouse_received: 'Manufacturer orders (H2M)',
  invoice_created: 'Follows its order', invoice_acknowledged: 'Follows its order', balance_request_created: 'Follows its order',
  payment_received: 'Follows its order', balance_payment_received: 'Follows its order', receipt_issued: 'Follows its order',
}

/** Unmapped order/document events stay visible under a neutral label. */
const LEFTOVER_LABELS: Record<string, string> = { order: 'Other order notifications', document: 'Other document notifications' }

/** The display group an event is listed under (falls back to its stored category). */
export function displayGroupOf(type: GroupableType): string {
  const group = EVENT_DISPLAY_GROUP[type.event_code]
  if (group && DISPLAY_GROUPS[group].routingCategory === type.category) return group
  return type.category
}

/** Independent multi-channel delivery is offered for Supply Chain order and document notifications only. */
export const allowsMultiChannelDelivery = (category: string) => category === 'order' || category === 'document'

const MODULE_ORDER = [...MODULE_TAXONOMY.map((group) => group.id), OTHER_MODULE.id]
const MODULE_NAMES = new Map<string, string>([...MODULE_TAXONOMY.map((g) => [g.id, g.name] as [string, string]), [OTHER_MODULE.id, OTHER_MODULE.name]])
export const moduleName = (id: string) => MODULE_NAMES.get(id) || id

export interface GroupableType { category: string; event_code: string }
export interface CategoryGroup<T> {
  /** Display key (a display group, or the stored category). */
  category: string
  label: string
  types: T[]
  /** Stored category the group's routing select reads and writes. */
  routingCategory: string
  description?: string
  /** Other visible groups that share this routing category. */
  sharesRoutingWith: string[]
}
export interface ModuleSection<T> { id: string; name: string; categories: CategoryGroup<T>[] }

/**
 * Every existing type lands in exactly one module/category. Only modules that
 * hold at least one type are returned (no empty HR/Finance sections).
 */
export function groupByModule<T extends GroupableType>(types: T[]): ModuleSection<T>[] {
  const byCategory = new Map<string, T[]>()
  types.forEach((type) => {
    const key = displayGroupOf(type)
    const list = byCategory.get(key) || []
    list.push(type)
    byCategory.set(key, list)
  })
  const routingOf = (key: string) => DISPLAY_GROUPS[key]?.routingCategory || key
  const rank = (category: string) => {
    const index = CATEGORY_ORDER.indexOf(category)
    return index < 0 ? CATEGORY_ORDER.length : index
  }
  const categories = Array.from(byCategory.keys()).sort((a, b) => rank(a) - rank(b) || categoryLabel(a).localeCompare(categoryLabel(b)))
  const sections = new Map<string, ModuleSection<T>>()
  categories.forEach((category) => {
    const id = categoryModule(category)
    const section = sections.get(id) || { id, name: moduleName(id), categories: [] }
    const routingCategory = routingOf(category)
    const label = DISPLAY_GROUPS[category]?.label || LEFTOVER_LABELS[category] || categoryLabel(category)
    section.categories.push({
      category,
      label,
      types: byCategory.get(category)!,
      routingCategory,
      description: DISPLAY_GROUPS[category]?.description,
      sharesRoutingWith: [],
    })
    sections.set(id, section)
  })
  const result = Array.from(sections.values()).sort((a, b) => MODULE_ORDER.indexOf(a.id) - MODULE_ORDER.indexOf(b.id))
  const all = result.flatMap((section) => section.categories)
  all.forEach((group) => {
    group.sharesRoutingWith = all.filter((other) => other !== group && other.routingCategory === group.routingCategory).map((other) => other.label)
  })
  return result
}

export const PRESET_LABELS: Record<NotificationRoutingPreset, string> = {
  whatsapp_only: 'WhatsApp',
  email_only: 'Email',
  sms_only: 'SMS',
  whatsapp_email_fallback: 'WhatsApp → Email',
  whatsapp_sms_email_fallback: 'WhatsApp → SMS → Email',
  whatsapp_sms: 'WhatsApp + SMS',
  whatsapp_email: 'WhatsApp + Email',
  sms_email: 'SMS + Email',
  whatsapp_sms_email: 'WhatsApp + SMS + Email',
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
