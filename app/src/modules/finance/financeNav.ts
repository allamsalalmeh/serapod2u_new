/**
 * Finance Module Navigation Configuration
 *
 * Single source of truth for Finance navigation.
 * Mirrors the pattern used by HR (src/modules/hr/hrNav.ts).
 *
 * The old Settings → Accounting tab is replaced by this standalone
 * Finance module with its own top-nav, landing page, and sub-routes.
 */

import {
    BookOpen,
    FileText,
    Calculator,
    Landmark,
    Receipt,
    CreditCard,
    Wallet,
    TrendingUp,
    BarChart3,
    PieChart,
    ArrowLeftRight,
    Settings as SettingsIcon,
    ShieldCheck,
    Wrench,
    DollarSign,
    CalendarRange,
    FileCheck2,
    ClipboardList,
    type LucideIcon,
} from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────

export interface FinanceNavChild {
    /** Route id – maps to currentView and resolves to /finance/... */
    id: string
    label: string
    icon: LucideIcon
    /** Resolved href for links (derived from id) */
    href: string
}

export interface FinanceNavGroup {
    /** Group key, e.g. 'finance-gl' */
    id: string
    label: string
    icon: LucideIcon
    /** If the group itself is clickable (optional landing) */
    href?: string
    children: FinanceNavChild[]
}

export interface FinanceNavAccess {
    requiredPermissionsAny: string[]
    maxRoleLevel: number
    allowedOrgTypes: string[]
}

// ── Access rule ──────────────────────────────────────────────────

export const financeAccess: FinanceNavAccess = {
    requiredPermissionsAny: ['view_settings'],
    maxRoleLevel: 40,
    allowedOrgTypes: ['HQ', 'DIST', 'WH'],
}

// ── Helper ───────────────────────────────────────────────────────

/** Convert a nested-submenu id like 'finance/gl/journals' → '/finance/gl/journals' */
function toHref(id: string): string {
    if (id.startsWith('/')) return id
    if (id.startsWith('finance/')) return `/${id}`
    return `/finance/${id}`
}

// ── Navigation tree ──────────────────────────────────────────────

export const financeNavGroups: FinanceNavGroup[] = [
    {
        id: 'finance-gl',
        label: 'General Ledger',
        icon: BookOpen,
        children: [
            { id: 'finance/gl/journals', label: 'GL Journals', icon: FileText, href: toHref('finance/gl/journals') },
            { id: 'finance/gl/pending-postings', label: 'Pending Postings', icon: ClipboardList, href: toHref('finance/gl/pending-postings') },
            { id: 'finance/gl/chart-of-accounts', label: 'Chart of Accounts', icon: BookOpen, href: toHref('finance/gl/chart-of-accounts') },
        ],
    },
    {
        id: 'finance-ar',
        label: 'Receivables',
        icon: TrendingUp,
        children: [
            { id: 'finance/ar/invoices', label: 'Customer Invoices', icon: Receipt, href: toHref('finance/ar/invoices') },
            { id: 'finance/ar/receipts', label: 'Receipts', icon: CreditCard, href: toHref('finance/ar/receipts') },
            { id: 'finance/ar/aging', label: 'AR Aging', icon: BarChart3, href: toHref('finance/ar/aging') },
        ],
    },
    {
        id: 'finance-ap',
        label: 'Payables',
        icon: Wallet,
        children: [
            { id: 'finance/ap/bills', label: 'Supplier Bills', icon: FileText, href: toHref('finance/ap/bills') },
            { id: 'finance/ap/payments', label: 'Payment Vouchers', icon: DollarSign, href: toHref('finance/ap/payments') },
            { id: 'finance/ap/aging', label: 'AP Aging', icon: BarChart3, href: toHref('finance/ap/aging') },
        ],
    },
    {
        id: 'finance-cash',
        label: 'Cash & Banking',
        icon: Landmark,
        children: [
            { id: 'finance/cash/bank-accounts', label: 'Bank Accounts', icon: Landmark, href: toHref('finance/cash/bank-accounts') },
            { id: 'finance/cash/statements', label: 'Bank Statements', icon: FileText, href: toHref('finance/cash/statements') },
            { id: 'finance/cash/reconciliation', label: 'Bank Reconciliation', icon: ArrowLeftRight, href: toHref('finance/cash/reconciliation') },
            { id: 'finance/cash/cashflow', label: 'Cash Flow', icon: TrendingUp, href: toHref('finance/cash/cashflow') },
        ],
    },
    {
        id: 'finance-reports',
        label: 'Reports',
        icon: PieChart,
        children: [
            { id: 'finance/reports/trial-balance', label: 'Trial Balance', icon: Calculator, href: toHref('finance/reports/trial-balance') },
            { id: 'finance/reports/profit-loss', label: 'Profit & Loss', icon: TrendingUp, href: toHref('finance/reports/profit-loss') },
            { id: 'finance/reports/balance-sheet', label: 'Balance Sheet', icon: BarChart3, href: toHref('finance/reports/balance-sheet') },
            { id: 'finance/reports/gl-detail', label: 'GL Detail Report', icon: FileText, href: toHref('finance/reports/gl-detail') },
            { id: 'finance/reports/cashflow', label: 'Cash Flow Statement', icon: ArrowLeftRight, href: toHref('finance/reports/cashflow') },
        ],
    },
    {
        id: 'finance-settings',
        label: 'Finance Settings',
        icon: SettingsIcon,
        children: [
            { id: 'finance/settings/default-accounts', label: 'Default Accounts', icon: FileCheck2, href: toHref('finance/settings/default-accounts') },
            { id: 'finance/settings/currency', label: 'Currency', icon: DollarSign, href: toHref('finance/settings/currency') },
            { id: 'finance/settings/fiscal-year', label: 'Fiscal Year & Periods', icon: CalendarRange, href: toHref('finance/settings/fiscal-year') },
            { id: 'finance/settings/posting-rules', label: 'Posting Rules', icon: Wrench, href: toHref('finance/settings/posting-rules') },
            { id: 'finance/settings/permissions', label: 'Finance Permissions', icon: ShieldCheck, href: toHref('finance/settings/permissions') },
            { id: 'finance/settings/configuration', label: 'Configuration', icon: Wrench, href: toHref('finance/settings/configuration') },
        ],
    },
]

// ── Flat list helpers ────────────────────────────────────────────

/** All leaf-level nav items (for search, quick links, etc.) */
export function getAllFinanceNavItems(): FinanceNavChild[] {
    return financeNavGroups.flatMap((g) => g.children)
}

/** Find which group a given view id belongs to */
export function findFinanceGroupForView(viewId: string): FinanceNavGroup | undefined {
    return financeNavGroups.find(
        (g) => g.id === viewId || g.children.some((c) => c.id === viewId)
    )
}

/** Build breadcrumb segments from a view id, e.g. ['Finance', 'General Ledger', 'Journals'] */
export function getFinanceBreadcrumb(viewId: string): { label: string; href?: string }[] {
    const crumbs: { label: string; href?: string }[] = [{ label: 'Finance', href: '/finance' }]
    const group = findFinanceGroupForView(viewId)
    if (group) {
        crumbs.push({ label: group.label })
        const child = group.children.find((c) => c.id === viewId)
        if (child) {
            crumbs.push({ label: child.label, href: child.href })
        }
    }
    return crumbs
}
