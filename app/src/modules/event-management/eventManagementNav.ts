/**
 * Event Management Module Navigation Configuration.
 *
 * Mirrors the pattern used by marketing/roadtour nav modules. Event Management
 * sits under Customer & Growth -> Marketing, directly below Road Tour.
 *
 * Module pages (real URLs, rendered inside the standard dashboard shell):
 *   Overview  /marketing/event-management
 *   Events    /marketing/event-management/events
 *   Settings  /marketing/event-management/settings
 * Each event opens its own page with tabs (real URLs too):
 *   Overview / Visitors / Staff & QR / Settings  →  /marketing/event-management/<eventId>[/<tab>]
 */

import { CalendarRange, QrCode, Settings, Users, LayoutDashboard, type LucideIcon } from 'lucide-react'

export interface EventManagementNavChild {
  id: string
  label: string
  icon: LucideIcon
  route?: string
  description?: string
}

export interface EventManagementNavGroup {
  id: string
  label: string
  icon: LucideIcon
  description?: string
  children: EventManagementNavChild[]
}

export const EVENT_MANAGEMENT_BASE_PATH = '/marketing/event-management'

/** Module-level tabs shown in the Event Management top navigation. */
export const eventManagementModuleTabs: EventManagementNavChild[] = [
  { id: 'event-management', label: 'Overview', icon: LayoutDashboard, route: EVENT_MANAGEMENT_BASE_PATH },
  { id: 'event-management-events', label: 'Events', icon: CalendarRange, route: `${EVENT_MANAGEMENT_BASE_PATH}/events` },
  { id: 'event-management-settings', label: 'Settings', icon: Settings, route: `${EVENT_MANAGEMENT_BASE_PATH}/settings` },
]

export const eventManagementNavGroups: EventManagementNavGroup[] = [
  {
    id: 'evm-main',
    label: 'Event Management',
    icon: CalendarRange,
    description: 'Create events, assign staff, generate QR codes and track visitor registrations.',
    children: eventManagementModuleTabs,
  },
]

export type EventTabId = 'event-overview' | 'event-visitors' | 'event-staff-qr' | 'event-settings'

/** Drill-down tabs inside an event (not top-level menu entries). `segment` is the URL suffix after the event id. */
export const eventManagementEventTabs: Array<EventManagementNavChild & { id: EventTabId; segment: string }> = [
  { id: 'event-overview', label: 'Overview', icon: LayoutDashboard, segment: '' },
  { id: 'event-visitors', label: 'Visitors', icon: Users, segment: 'visitors' },
  { id: 'event-staff-qr', label: 'Staff & QR', icon: QrCode, segment: 'staff-qr' },
  { id: 'event-settings', label: 'Settings', icon: Settings, segment: 'settings' },
]

const _allEventManagementViewIds = new Set<string>([
  'event-management',
  // legacy alias of the module overview
  'event-management-overview',
  ...eventManagementModuleTabs.map((c) => c.id),
  ...eventManagementEventTabs.map((t) => t.id),
])

export function isEventManagementViewId(viewId: string): boolean {
  return _allEventManagementViewIds.has(viewId)
}

/** True for the per-event tab views (inside one event). */
export function isEventManagementEventViewId(viewId: string): boolean {
  return eventManagementEventTabs.some((t) => t.id === viewId)
}

/** The module tab that is active for a view: per-event views belong to "Events". */
export function activeEventManagementModuleTab(viewId: string): string | null {
  if (viewId === 'event-management' || viewId === 'event-management-overview') return 'event-management'
  if (isEventManagementEventViewId(viewId)) return 'event-management-events'
  return eventManagementModuleTabs.find((t) => t.id === viewId)?.id ?? null
}

/**
 * Whether the dashboard shell should show the server-rendered page content (`children`, which belongs to the page's
 * `initialView`) or render `currentView` itself. The shell moves `currentView` as soon as a module link is clicked,
 * before the next page arrives. Event Management content comes only from its server pages, so when Event Management is
 * on either side of such a move the old page's content would sit under the new module header; the current view is
 * rendered instead, which for an Event Management view is its loading state, never the general dashboard.
 */
export function shouldRenderServerContent({
  hasServerContent,
  currentView,
  initialView,
}: {
  hasServerContent: boolean
  currentView: string
  initialView?: string | null
}): boolean {
  if (!hasServerContent) return false
  const canonical = (view: string) => (view === 'event-management-overview' ? 'event-management' : view)
  const pageView = initialView ?? ''
  if (canonical(currentView) === canonical(pageView)) return true
  return !isEventManagementViewId(currentView) && !isEventManagementViewId(pageView)
}

export function eventManagementHrefForView(viewId: string): string | null {
  if (viewId === 'event-management-overview') return EVENT_MANAGEMENT_BASE_PATH
  return eventManagementModuleTabs.find((c) => c.id === viewId)?.route ?? null
}

/** Resolve the per-event tab from the URL segments after the event id; null when unknown. */
export function resolveEventTab(segments: string[] | undefined): EventTabId | null {
  const parts = segments ?? []
  if (parts.length > 1) return null
  const segment = parts[0] ?? ''
  return eventManagementEventTabs.find((t) => t.segment === segment)?.id ?? null
}

export function eventTabHref(eventId: string, tabId: EventTabId): string {
  const tab = eventManagementEventTabs.find((t) => t.id === tabId)
  const base = `${EVENT_MANAGEMENT_BASE_PATH}/${encodeURIComponent(eventId)}`
  return tab?.segment ? `${base}/${tab.segment}` : base
}

export function getEventManagementBreadcrumb(viewId: string): { label: string; href?: string }[] {
  const crumbs: { label: string; href?: string }[] = [
    { label: 'Customer & Growth', href: 'customer-growth' },
    { label: 'Marketing', href: 'mktg' },
    { label: 'Event Management', href: 'event-management' },
  ]
  const moduleTab = eventManagementModuleTabs.find((t) => t.id === viewId && t.id !== 'event-management')
  if (moduleTab) crumbs.push({ label: moduleTab.label })
  const tab = eventManagementEventTabs.find((t) => t.id === viewId)
  if (tab) crumbs.push({ label: 'Events', href: 'event-management-events' }, { label: tab.label })
  return crumbs
}
