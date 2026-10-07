/**
 * Event Management Module Navigation Configuration.
 *
 * Mirrors the pattern used by marketing/roadtour nav modules. Event Management
 * sits under Customer & Growth -> Marketing, directly below Road Tour.
 *
 * The module landing uses client-side tabs (Overview / Events / Settings) and
 * each event opens its own page with its own tabs (Overview / Visitors /
 * Staff & QR / Settings).
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

export const eventManagementNavGroups: EventManagementNavGroup[] = [
  {
    id: 'evm-main',
    label: 'Event Management',
    icon: CalendarRange,
    description: 'Create events, assign staff, generate QR codes and track visitor registrations.',
    children: [
      { id: 'event-management-overview', label: 'Overview', icon: LayoutDashboard, route: '/marketing/event-management' },
      { id: 'event-management-events', label: 'Events', icon: CalendarRange, route: '/marketing/event-management' },
      { id: 'event-management-settings', label: 'Settings', icon: Settings, route: '/marketing/event-management' },
    ],
  },
]

/** Drill-down tabs inside an event (not top-level menu entries). */
export const eventManagementEventTabs: EventManagementNavChild[] = [
  { id: 'event-overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'event-visitors', label: 'Visitors', icon: Users },
  { id: 'event-staff-qr', label: 'Staff & QR', icon: QrCode },
  { id: 'event-settings', label: 'Settings', icon: Settings },
]

const _allEventManagementViewIds = new Set<string>([
  'event-management',
  ...eventManagementNavGroups.flatMap((g) => g.children.map((c) => c.id)),
  ...eventManagementEventTabs.map((t) => t.id),
])

export function isEventManagementViewId(viewId: string): boolean {
  return _allEventManagementViewIds.has(viewId)
}

export function eventManagementHrefForView(viewId: string): string | null {
  if (viewId === 'event-management' || viewId === 'event-management-overview') return '/marketing/event-management'
  const child = eventManagementNavGroups.flatMap((g) => g.children).find((c) => c.id === viewId)
  return child?.route ?? null
}

export function getEventManagementBreadcrumb(viewId: string): { label: string; href?: string }[] {
  const crumbs: { label: string; href?: string }[] = [
    { label: 'Customer & Growth', href: 'customer-growth' },
    { label: 'Marketing', href: 'mktg' },
    { label: 'Event Management', href: 'event-management' },
  ]
  const tab = eventManagementEventTabs.find((t) => t.id === viewId)
  if (tab) crumbs.push({ label: tab.label })
  return crumbs
}
