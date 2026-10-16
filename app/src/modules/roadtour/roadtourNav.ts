import { Map, Settings, BarChart3, QrCode, ClipboardList, Users, Smartphone, Store, UserCheck, Flag, Target, CalendarCheck, TrendingUp } from 'lucide-react'

export interface RoadtourNavChild {
    id: string
    label: string
    icon: any
    route?: string
    description?: string
    /** Destination (ROADTOUR_DESTINATIONS) that must be allowed for this item; defaults to the group's. */
    requires?: string
}

export interface RoadtourNavGroup {
    id: string
    label: string
    icon: any
    description?: string
    /** Destination (ROADTOUR_DESTINATIONS) that must be allowed for this group. */
    requires: string
    children: RoadtourNavChild[]
}

export const roadtourNavGroups: RoadtourNavGroup[] = [
    {
        id: 'rt-campaigns',
        requires: 'roadtour:campaigns',
        label: 'Campaign Management',
        icon: Map,
        description: 'Create and manage RoadTour campaigns, assign account managers, and track performance.',
        children: [
            { id: 'roadtour-campaigns', label: 'Campaigns', icon: Map, route: '/roadtour/campaigns' },
            { id: 'roadtour-qr', label: 'QR Management', icon: QrCode, route: '/roadtour/qr' },
        ],
    },
    {
        id: 'rt-reporting',
        requires: 'roadtour:reporting',
        label: 'RoadTour Reporting',
        icon: BarChart3,
        description: 'One monthly view of shops visited, shop response, account manager performance, ongoing shop trend and follow-up.',
        children: [
            { id: 'roadtour-monthly-overview', label: 'Monthly Overview', icon: BarChart3, route: '/roadtour/reporting' },
            { id: 'roadtour-am-performance', label: 'AM Performance', icon: UserCheck, route: '/roadtour/reporting/am-performance' },
            { id: 'roadtour-shop-performance', label: 'Shop Performance', icon: TrendingUp, route: '/roadtour/reporting/shop-performance' },
            { id: 'roadtour-shop-follow-up', label: 'Shop Follow-Up', icon: Flag, route: '/roadtour/reporting/follow-up' },
            { id: 'roadtour-visits', label: 'Visit Log', icon: Users, route: '/roadtour/visits', requires: 'roadtour:visits' },
            { id: 'roadtour-monthly-kpi-report', label: 'Monthly KPI Performance Report', icon: CalendarCheck, route: '/roadtour/analytics/monthly-kpi' },
            { id: 'roadtour-whatsapp', label: 'WhatsApp Monitoring', icon: Smartphone, route: '/roadtour/whatsapp' },
        ],
    },
    {
        id: 'rt-settings',
        requires: 'roadtour:settings',
        label: 'Settings',
        icon: Settings,
        description: 'Configure RoadTour module settings, surveys, user registration, and preferences.',
        children: [
            { id: 'roadtour-surveys', label: 'Surveys', icon: ClipboardList, route: '/roadtour/surveys' },
            { id: 'roadtour-kpi-settings', label: 'KPI & Incentive Settings', icon: Target, route: '/roadtour/settings/kpi', requires: 'roadtour:kpi-settings' },
            { id: 'roadtour-settings', label: 'RoadTour Settings', icon: Settings, route: '/roadtour/settings' },
        ],
    },
]

/**
 * The RoadTour menu the person may use. `allows` answers from the per-user Security & Access snapshot; a group is kept
 * only when a child remains. Navigation only: every RoadTour page and API decides again on the server.
 */
export function filterRoadtourNavGroups(allows: (destinationId: string) => boolean): RoadtourNavGroup[] {
    return roadtourNavGroups
        .filter((group) => allows(group.requires))
        .map((group) => ({ ...group, children: group.children.filter((child) => allows(child.requires ?? group.requires)) }))
        .filter((group) => group.children.length > 0)
}

/** The destination a RoadTour view is decided with: its menu item's, else its group's, else the module's. */
export function roadtourDestinationForView(viewId: string): string {
    const id = resolveRoadtourViewId(viewId)
    for (const group of roadtourNavGroups) {
        const child = group.children.find((c) => c.id === id)
        if (child) return child.requires ?? group.requires
    }
    const hidden = roadtourHiddenViews.find((v) => v.id === id)
    if (hidden) return roadtourNavGroups.find((g) => g.id === hidden.groupId)?.requires ?? 'roadtour'
    return 'roadtour'
}

/**
 * Views that are reachable and URL-addressable but are drill-downs rather than
 * menu entries — they are opened from a report, not from the navigation.
 */
export const roadtourHiddenViews: Array<{ id: string; label: string; icon: any; groupId: string }> = [
    { id: 'roadtour-shop-drilldown', label: 'Shop Impact Detail', icon: Store, groupId: 'rt-reporting' },
]

/**
 * Old Analytics view ids kept working after the reporting consolidation, so
 * bookmarks and any in-app link that still names them land on the report that
 * replaced them instead of a blank page.
 */
export const legacyRoadtourViewRedirects: Record<string, string> = {
    'roadtour-analytics': 'roadtour-monthly-overview',
    'roadtour-post-visit-impact': 'roadtour-monthly-overview',
    'roadtour-shop-impact': 'roadtour-shop-drilldown',
    'roadtour-am-impact': 'roadtour-am-performance',
    'roadtour-follow-up-priority': 'roadtour-shop-follow-up',
}

/** Map a possibly-legacy view id onto the view that renders it today. */
export function resolveRoadtourViewId(viewId: string): string {
    return legacyRoadtourViewRedirects[viewId] || viewId
}

const _allRoadtourViewIds = new Set<string>([
    'roadtour',
    ...roadtourNavGroups.flatMap((g) => g.children.map((c) => c.id)),
    ...roadtourHiddenViews.map((v) => v.id),
    ...Object.keys(legacyRoadtourViewRedirects),
])

export function isRoadtourViewId(viewId: string): boolean {
    return _allRoadtourViewIds.has(viewId)
}

/**
 * Admin URL paths for RoadTour subviews.
 * Keep these as static first segments (never a 4-digit year) so they do not
 * collide with public consumer URLs: /roadtour/[year]/[campaignSlug]/[referenceSlug].
 */
export const roadtourViewToPath: Record<string, string> = {
    'roadtour-campaigns': 'campaigns',
    'roadtour-qr': 'qr',
    'roadtour-surveys': 'surveys',
    'roadtour-visits': 'visits',
    'roadtour-monthly-overview': 'reporting',
    'roadtour-am-performance': 'reporting/am-performance',
    'roadtour-shop-performance': 'reporting/shop-performance',
    'roadtour-shop-follow-up': 'reporting/follow-up',
    'roadtour-shop-drilldown': 'reporting/shops',
    'roadtour-monthly-kpi-report': 'analytics/monthly-kpi',
    'roadtour-whatsapp': 'whatsapp',
    'roadtour-kpi-settings': 'settings/kpi',
    'roadtour-settings': 'settings',
}

export const roadtourPathToView: Record<string, string> = Object.fromEntries(
    Object.entries(roadtourViewToPath).map(([view, path]) => [path, view])
)

/** Full admin href for a RoadTour view id, or null if not URL-addressable here. */
export function roadtourHrefForView(viewId: string): string | null {
    if (viewId === 'roadtour') return '/roadtour'
    const path = roadtourViewToPath[resolveRoadtourViewId(viewId)]
    return path ? `/roadtour/${path}` : null
}

export function resolveRoadtourAdminPath(path: string): string {
    return roadtourPathToView[path] || 'roadtour'
}

export function findRoadtourGroupForView(viewId: string): RoadtourNavGroup | undefined {
    const resolved = resolveRoadtourViewId(viewId)
    const hidden = roadtourHiddenViews.find((v) => v.id === resolved)
    if (hidden) return roadtourNavGroups.find((g) => g.id === hidden.groupId)
    return roadtourNavGroups.find((g) => g.children.some((c) => c.id === resolved))
}

export function getRoadtourBreadcrumb(viewId: string): { group?: string; item?: string } {
    const resolved = resolveRoadtourViewId(viewId)
    const group = findRoadtourGroupForView(resolved)
    if (!group) return {}
    const child = group.children.find((c) => c.id === resolved)
    if (child) return { group: group.label, item: child.label }
    const hidden = roadtourHiddenViews.find((v) => v.id === resolved)
    return { group: group.label, item: hidden?.label }
}
