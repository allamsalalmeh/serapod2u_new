/**
 * Marketing Module Navigation Configuration
 *
 * Single source of truth for Marketing navigation.
 * Mirrors the pattern used by Supply Chain and Finance modules.
 *
 * Groups:
 *  - Campaigns & Outreach: journey builder + WhatsApp broadcasts
 */

import {
    Megaphone,
    BookOpen,
    MessageSquare,
    PanelTop,
    CalendarRange,
    type LucideIcon,
} from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────

export interface MarketingNavChild {
    /** View id – maps to currentView in DashboardContent */
    id: string
    label: string
    icon: LucideIcon
}

export interface MarketingNavGroup {
    id: string
    label: string
    icon: LucideIcon
    description: string
    children: MarketingNavChild[]
}

// ── Navigation tree ──────────────────────────────────────────────

export const marketingNavGroups: MarketingNavGroup[] = [
    {
        id: 'mkt-campaigns',
        label: 'Campaigns & Outreach',
        icon: Megaphone,
        description: 'Build automated consumer journeys and send targeted WhatsApp broadcasts.',
        children: [
            { id: 'landing-pages', label: 'Landing Pages', icon: PanelTop },
            { id: 'journey-builder', label: 'Journey Builder', icon: BookOpen },
            { id: 'event-management', label: 'Event Management', icon: CalendarRange },
            { id: 'marketing', label: 'WhatsApp Broadcast', icon: MessageSquare },
        ],
    },
]

// ── Flat list helpers ────────────────────────────────────────────

export function getAllMarketingNavItems(): MarketingNavChild[] {
    return marketingNavGroups.flatMap((g) => g.children)
}

const _allMarketingViewIds = new Set<string>([
    'mktg',
    ...marketingNavGroups.flatMap((g) => g.children.map((c) => c.id)),
])

export function isMarketingViewId(viewId: string): boolean {
    return _allMarketingViewIds.has(viewId)
}

/** Admin URL paths for Marketing subviews under /marketing/... */
export const marketingViewToPath: Record<string, string> = {
    'landing-pages': 'landing-pages',
    'journey-builder': 'journey-builder',
    'event-management': 'event-management',
    // view id "marketing" is WhatsApp Broadcast (module landing is "mktg" at /marketing)
    'marketing': 'whatsapp',
}

export const marketingPathToView: Record<string, string> = Object.fromEntries(
    Object.entries(marketingViewToPath).map(([view, path]) => [path, view])
)

export function marketingHrefForView(viewId: string): string | null {
    if (viewId === 'mktg') return '/marketing'
    const path = marketingViewToPath[viewId]
    return path ? `/marketing/${path}` : null
}

export function resolveMarketingSlug(slug: string[]): string {
    const path = slug.join('/')
    return marketingPathToView[path] || marketingPathToView[slug[0] || ''] || 'mktg'
}

export function findMarketingGroupForView(viewId: string): MarketingNavGroup | undefined {
    return marketingNavGroups.find(
        (g) => g.id === viewId || g.children.some((c) => c.id === viewId)
    )
}

export function getMarketingBreadcrumb(viewId: string): { label: string; href?: string }[] {
    const crumbs: { label: string; href?: string }[] = [{ label: 'Customer & Growth', href: 'customer-growth' }, { label: 'Marketing', href: 'mktg' }]
    const group = findMarketingGroupForView(viewId)
    if (group) {
        crumbs.push({ label: group.label })
        const child = group.children.find((c) => c.id === viewId)
        if (child) {
            crumbs.push({ label: child.label, href: child.id })
        }
    }
    return crumbs
}
