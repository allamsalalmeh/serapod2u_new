/**
 * Settings Module Navigation Configuration
 *
 * Single source of truth for Settings navigation.
 * Mirrors the pattern used by HR (src/modules/hr/hrNav.ts) and
 * Finance (src/modules/finance/financeNav.ts).
 *
 * Settings is restructured as a module landing page with a top nav
 * row, cards grid, and deep-linked sub-routes.
 */

import {
    User,
    Building2,
    Bell,
    Settings as SettingsIcon,
    Lock,
    AlertTriangle,
    FileText,
    Hash,
    Palette,
    MessageSquare,
    Megaphone,
    Bot,
    BarChart3,
    CreditCard,
    ScrollText,
    ServerCog,
    type LucideIcon,
} from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────

export interface SettingsNavChild {
    /** Route id – maps to currentView and resolves to /settings/... */
    id: string
    label: string
    icon: LucideIcon
    /** Resolved href for links (derived from id) */
    href: string
    /** Description for landing page cards */
    description?: string
}

export interface SettingsNavGroup {
    /** Group key, e.g. 'settings-profile' */
    id: string
    label: string
    icon: LucideIcon
    /** Description for landing page cards */
    description?: string
    /** If the group itself is clickable (optional landing) */
    href?: string
    children: SettingsNavChild[]
}

export interface SettingsNavAccess {
    allowedOrgTypes: string[]
    maxRoleLevel: number
}

// ── Access rule ──────────────────────────────────────────────────

export const settingsAccess: SettingsNavAccess = {
    allowedOrgTypes: ['HQ'],
    maxRoleLevel: 40,
}

// ── Helper ───────────────────────────────────────────────────────

/** Convert a nested id like 'settings/profile' → '/settings/profile' */
function toHref(id: string): string {
    if (id.startsWith('/')) return id
    if (id.startsWith('settings/')) return `/${id}`
    return `/settings/${id}`
}

// ── Navigation tree ──────────────────────────────────────────────
// Each group represents a Settings category card on the landing page.
// Groups with only one child still follow the group → child pattern
// for consistency. The single child routes to the actual content.

export const settingsNavGroups: SettingsNavGroup[] = [
    {
        id: 'settings-profile',
        label: 'Profile',
        icon: User,
        description: 'Update your personal information and contact details.',
        children: [
            { id: 'settings/profile', label: 'Profile Settings', icon: User, href: toHref('settings/profile'), description: 'Name, phone, avatar' },
        ],
    },
    {
        id: 'settings-organization',
        label: 'Organization',
        icon: Building2,
        description: 'Company info, logo, branding, and business configuration.',
        children: [
            { id: 'settings/organization', label: 'Organization Info', icon: Building2, href: toHref('settings/organization'), description: 'Company details, logo, signature' },
        ],
    },
    {
        id: 'settings-notifications',
        label: 'Notifications',
        icon: Bell,
        description: 'Manage notification types, providers, and delivery preferences.',
        children: [
            { id: 'settings/notifications/providers', label: 'Notification Providers', icon: MessageSquare, href: toHref('settings/notifications/providers'), description: 'Email, SMS, WhatsApp channels' },
            { id: 'settings/notifications/types', label: 'Notification Types', icon: Megaphone, href: toHref('settings/notifications/types'), description: 'Configure notification categories' },
        ],
    },
    {
        id: 'settings-preferences',
        label: 'Preferences',
        icon: Palette,
        description: 'Theme, language, timezone, document templates, and sequences.',
        children: [
            { id: 'settings/preferences', label: 'System Preferences', icon: SettingsIcon, href: toHref('settings/preferences'), description: 'Theme, timezone, language' },
            { id: 'settings/preferences/document-template', label: 'Document Templates', icon: FileText, href: toHref('settings/preferences/document-template'), description: 'Order & invoice templates' },
            { id: 'settings/preferences/doc-sequence', label: 'Document Sequences', icon: Hash, href: toHref('settings/preferences/doc-sequence'), description: 'Auto numbering rules' },
        ],
    },
    {
        id: 'settings-authorization',
        label: 'Authorization',
        icon: Lock,
        description: 'Role-based permissions and access control management.',
        children: [
            { id: 'settings/authorization', label: 'Authorization Rules', icon: Lock, href: toHref('settings/authorization'), description: 'Permissions & roles' },
        ],
    },
    {
        id: 'settings-ai',
        label: 'AI Settings',
        icon: Bot,
        description: 'Configure AI assistant provider, model, and connection settings.',
        children: [
            { id: 'settings/ai', label: 'AI Provider Settings', icon: Bot, href: toHref('settings/ai'), description: 'Provider, model & connection config' },
            { id: 'settings/ai/usage', label: 'AI Usage', icon: BarChart3, href: toHref('settings/ai/usage'), description: 'Usage analytics & reports' },
        ],
    },
    {
        // Placed after AI Settings and before Danger Zone (landing card beside Danger Zone).
        // Visible only to holders of platform.system_logs.view (see visibleSettingsGroups); the page and APIs decide again.
        id: 'settings-system',
        label: 'System',
        icon: ServerCog,
        description: 'System Logs — diagnostic errors and recorded user activity, with copyable reports.',
        children: [
            { id: 'settings/system/logs', label: 'System Logs', icon: ScrollText, href: toHref('settings/system/logs'), description: 'Errors & user activity' },
        ],
    },
    {
        id: 'settings-danger-zone',
        label: 'Danger Zone',
        icon: AlertTriangle,
        description: 'Destructive operations — data reset, cache purge, advanced admin tools.',
        children: [
            { id: 'settings/danger-zone', label: 'Danger Zone', icon: AlertTriangle, href: toHref('settings/danger-zone'), description: 'Reset & cleanup tools' },
        ],
    },
]

// ── Visibility (presentation only; never authorization) ──────────

export interface SettingsVisibility {
    roleLevel?: number | null
    /** platform.system_logs.view (from /api/system-logs/access). Unknown/false hides the System group. */
    canViewSystemLogs?: boolean
}

/** Groups shown on the landing page and the top navigation. */
export function visibleSettingsGroups(visibility: SettingsVisibility, groups: SettingsNavGroup[] = settingsNavGroups): SettingsNavGroup[] {
    return groups.filter((group) => {
        if (group.id === 'settings-authorization' || group.id === 'settings-danger-zone') {
            return visibility.roleLevel != null && visibility.roleLevel === 1
        }
        if (group.id === 'settings-system') return visibility.canViewSystemLogs === true
        return true
    })
}

// ── Flat list helpers ────────────────────────────────────────────

/** All leaf-level nav items (for search, quick links, etc.) */
export function getAllSettingsNavItems(): SettingsNavChild[] {
    return settingsNavGroups.flatMap((g) => g.children)
}

/** Find which group a given view id belongs to */
export function findSettingsGroupForView(viewId: string): SettingsNavGroup | undefined {
    return settingsNavGroups.find(
        (g) => g.id === viewId || g.children.some((c) => c.id === viewId)
    )
}

/** Build breadcrumb segments from a view id, e.g. ['Settings', 'Notifications', 'Types'] */
export function getSettingsBreadcrumb(viewId: string): { label: string; href?: string }[] {
    const crumbs: { label: string; href?: string }[] = [{ label: 'Settings', href: '/settings' }]
    const group = findSettingsGroupForView(viewId)
    if (group) {
        crumbs.push({ label: group.label })
        const child = group.children.find((c) => c.id === viewId)
        if (child) {
            crumbs.push({ label: child.label, href: child.href })
        }
    }
    return crumbs
}
