/**
 * HR Module Navigation Configuration
 *
 * Extracted from the global sidebar (src/components/layout/Sidebar.tsx)
 * to be shared between the sidebar (module-level entry) and the HR top nav bar.
 *
 * IMPORTANT: This is the single source of truth for HR navigation.
 * Do not duplicate HR menu definitions elsewhere.
 */

import {
    Users,
    ListTree,
    Building2,
    Briefcase,
    CalendarCheck2,
    Clock3,
    FileSpreadsheet,
    CalendarDays,
    ClipboardList,
    CheckCircle2,
    Wallet,
    Percent,
    Plus,
    FileText,
    TrendingUp,
    Star,
    FileCheck2,
    Settings as SettingsIcon,
    ShieldCheck,
    Wrench,
    Landmark,
    UserCircle,
    type LucideIcon,
} from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────

export interface HrNavChild {
    /** Route id – maps to currentView and resolves to /hr/... */
    id: string
    label: string
    icon: LucideIcon
    /** Resolved href for links (derived from id) */
    href: string
    /**
     * Destination ids (HR_DESTINATIONS) any one of which must be allowed for the item to show. Defaults to the item's
     * own id. Employee items map to the My Workspace destination (Employee Self-Service); administrative items to their
     * own permissions.
     */
    requiresAny?: string[]
}

export interface HrNavGroup {
    /** Group key, e.g. 'hr-people' */
    id: string
    label: string
    icon: LucideIcon
    /** If the group itself is clickable (optional landing) */
    href?: string
    children: HrNavChild[]
}

// ── Helper ───────────────────────────────────────────────────────

/** Convert a nested-submenu id like 'hr/people/employees' → '/hr/people/employees' */
function toHref(id: string): string {
    if (id.startsWith('/')) return id
    if (id.startsWith('hr/')) return `/${id}`
    return `/hr/${id}`
}

// ── Navigation tree ──────────────────────────────────────────────
// Matches the sidebar definition exactly (labels, ids, icons, order).

const WORKSPACE = ['hr/my-workspace']

export const hrNavGroups: HrNavGroup[] = [
    {
        id: 'hr-workspace',
        label: 'My Workspace',
        icon: UserCircle,
        children: [
            { id: 'hr/my-workspace', label: 'My Workspace', icon: UserCircle, href: toHref('hr/my-workspace') },
            { id: 'hr/mobile/attendance', label: 'My Attendance', icon: Clock3, href: '/hr/mobile/attendance', requiresAny: WORKSPACE },
            { id: 'hr/mobile/leave', label: 'My Leave', icon: CalendarDays, href: '/hr/mobile/leave', requiresAny: WORKSPACE },
            { id: 'hr/mobile/payslip', label: 'My Payslips', icon: FileText, href: '/hr/mobile/payslip', requiresAny: WORKSPACE },
        ],
    },
    {
        id: 'hr-people',
        label: 'People',
        icon: Users,
        children: [
            { id: 'hr/people/employees', label: 'Employees', icon: Users, href: toHref('hr/people/employees') },
            { id: 'hr/people/org-chart', label: 'Organization Chart', icon: ListTree, href: toHref('hr/people/org-chart'), requiresAny: ['hr/people/org-chart', 'hr/people/org-chart/staff'] },
            { id: 'hr/people/departments', label: 'Departments', icon: Building2, href: toHref('hr/people/departments') },
            { id: 'hr/people/positions', label: 'Positions (Job Titles)', icon: Briefcase, href: toHref('hr/people/positions') },
        ],
    },
    {
        id: 'hr-attendance',
        label: 'Attendance',
        icon: CalendarCheck2,
        children: [
            { id: 'hr/attendance/clock-in-out', label: 'Clock In / Out', icon: Clock3, href: toHref('hr/attendance/clock-in-out') },
            { id: 'hr/attendance/timesheets', label: 'Timesheets', icon: FileSpreadsheet, href: toHref('hr/attendance/timesheets') },
        ],
    },
    {
        id: 'hr-leave',
        label: 'Leave Management',
        icon: CalendarDays,
        children: [
            { id: 'hr/leave/types', label: 'Leave Types', icon: CalendarDays, href: toHref('hr/leave/types') },
            { id: 'hr/leave/requests', label: 'Leave Requests', icon: ClipboardList, href: toHref('hr/leave/requests') },
            { id: 'hr/leave/approval-flow', label: 'Approval Flow', icon: CheckCircle2, href: toHref('hr/leave/approval-flow') },
        ],
    },
    {
        id: 'hr-payroll',
        label: 'Payroll',
        icon: Wallet,
        children: [
            { id: 'hr/payroll/salary-structure', label: 'Salary Structure', icon: Wallet, href: toHref('hr/payroll/salary-structure') },
            { id: 'hr/payroll/allowances-deductions', label: 'Allowances / Deductions', icon: Plus, href: toHref('hr/payroll/allowances-deductions') },
            { id: 'hr/payroll/payslips', label: 'Payslips', icon: FileText, href: toHref('hr/payroll/payslips') },
            { id: 'hr/payroll/commission-settings', label: 'Commission Settings', icon: Percent, href: toHref('hr/payroll/commission-settings') },
        ],
    },
    {
        id: 'hr-performance',
        label: 'Performance',
        icon: TrendingUp,
        children: [
            { id: 'hr/performance/kpis', label: 'KPIs', icon: TrendingUp, href: toHref('hr/performance/kpis') },
            { id: 'hr/performance/appraisals', label: 'Appraisals', icon: Star, href: toHref('hr/performance/appraisals') },
            { id: 'hr/performance/reviews', label: 'Reviews', icon: FileCheck2, href: toHref('hr/performance/reviews') },
        ],
    },
    {
        id: 'hr-settings',
        label: 'HR Settings',
        icon: SettingsIcon,
        children: [
            { id: 'hr/settings/departments', label: 'Departments', icon: Building2, href: toHref('hr/settings/departments') },
            { id: 'hr/settings/positions', label: 'Positions', icon: Briefcase, href: toHref('hr/settings/positions') },
            { id: 'hr/settings/approval-rules', label: 'Approval Rules', icon: CheckCircle2, href: toHref('hr/settings/approval-rules') },
            { id: 'hr/settings/permissions', label: 'HR Permissions', icon: ShieldCheck, href: toHref('hr/settings/permissions') },
            { id: 'hr/settings/accounting', label: 'Accounting', icon: Landmark, href: toHref('hr/settings/accounting') },
            { id: 'hr/settings/configuration', label: 'Configuration', icon: Wrench, href: toHref('hr/settings/configuration') },
        ],
    },
]

// ── Access filtering ─────────────────────────────────────────────

/**
 * The navigation tree the person may use. `allowsAny` answers from the per-user Security & Access snapshot. A group is
 * kept only when at least one child remains, so a parent never shows without an accessible destination. This is
 * navigation only: every route and API decides again on the server.
 */
export function filterHrNavGroups(allowsAny: (destinationIds: readonly string[]) => boolean): HrNavGroup[] {
    return hrNavGroups
        .map((group) => ({
            ...group,
            children: group.children.filter((child) => allowsAny(child.requiresAny ?? [child.id])),
        }))
        .filter((group) => group.children.length > 0)
}

// ── Flat list helpers ────────────────────────────────────────────

/** All leaf-level nav items (for search, quick links, etc.) */
export function getAllHrNavItems(groups: HrNavGroup[] = hrNavGroups): HrNavChild[] {
    return groups.flatMap((g) => g.children)
}

/** Find which group a given view id belongs to */
export function findHrGroupForView(viewId: string): HrNavGroup | undefined {
    return hrNavGroups.find(
        (g) => g.id === viewId || g.children.some((c) => c.id === viewId)
    )
}

/**
 * Build breadcrumb segments from a view id, e.g. ['HR', 'People', 'Employees'].
 * My Workspace is both a group and its own first item, so it is named once: HR → My Workspace, and for a child page
 * HR → My Workspace → My Leave.
 */
export function getHrBreadcrumb(viewId: string): { label: string; href?: string }[] {
    const group = findHrGroupForView(viewId)
    // The first crumb is the person's own entry: My Workspace for employee views, the HR landing otherwise.
    const employeeView = group?.id === 'hr-workspace'
    const crumbs: { label: string; href?: string }[] = [{ label: 'HR', href: employeeView ? '/hr/my-workspace' : '/hr' }]
    if (group) {
        crumbs.push({ label: group.label, ...(employeeView ? { href: '/hr/my-workspace' } : {}) })
        const child = group.children.find((c) => c.id === viewId)
        if (child && !(employeeView && child.id === 'hr/my-workspace')) {
            crumbs.push({ label: child.label, href: child.href })
        }
    }
    return crumbs
}
