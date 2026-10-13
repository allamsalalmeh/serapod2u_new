/**
 * Supply Chain Module Navigation Configuration
 *
 * Single source of truth for Supply Chain navigation.
 * Mirrors the pattern used by Finance (src/modules/finance/financeNav.ts).
 *
 * This module groups existing Supply Chain features (Products, Order Management,
 * QR Tracking, Inventory, Quality & Returns) under a unified landing page.
 * All child routes are existing views — no new business logic.
 *
 * Access control: Each group and child can declare an `access` rule (organization type / role level business
 * boundaries). Components use `filterSupplyChainNavForUser()` with the Security & Access answer per view
 * (supplyChainViewVisible, nav-access.ts) to strip items the person may not open.
 */

import {
    Package,
    FileText,
    QrCode,
    Warehouse,
    ShieldCheck,
    ShoppingCart,
    Store,
    Factory,
    Truck,
    Plus,
    ListTree,
    Settings as SettingsIcon,
    Building2,
    Trophy,
    Undo2,
    BarChart3,
    type LucideIcon,
} from 'lucide-react'
import { canOpenOrderEditor } from './h2m-access'

// ── Types ────────────────────────────────────────────────────────

export interface SCAccessRule {
    /** Organisation types that see this item (empty / omitted = all) */
    allowedOrgTypes?: string[]
    /** Maximum role_level that may see this item (lower = more privileged) */
    maxRoleLevel?: number
}

export interface SupplyChainNavChild {
    /** View id – maps to currentView in DashboardContent */
    id: string
    label: string
    icon: LucideIcon
    /** If true, this item is marked as legacy (still accessible) */
    legacy?: boolean
    /** Optional access restriction */
    access?: SCAccessRule
}

export interface SupplyChainNavGroup {
    /** Group key, e.g. 'sc-products' */
    id: string
    label: string
    icon: LucideIcon
    description: string
    children: SupplyChainNavChild[]
    /** Optional access restriction that hides the entire group */
    access?: SCAccessRule
}

// ── Navigation tree ──────────────────────────────────────────────
// Each child.id maps to an existing view in DashboardContent's renderCurrentView().

export const supplyChainNavGroups: SupplyChainNavGroup[] = [
    {
        id: 'sc-organizations',
        label: 'Organizations',
        icon: Building2,
        description: 'Manage supply chain partner organizations, distributors, and warehouses.',
        access: { allowedOrgTypes: ['HQ'], maxRoleLevel: 30 },
        children: [
            { id: 'organizations', label: 'Organizations', icon: Building2 },
            { id: 'add-organization', label: 'Add Organization', icon: Plus, access: { allowedOrgTypes: ['HQ'], maxRoleLevel: 20 } },
        ],
    },
    {
        id: 'sc-products',
        label: 'Products',
        icon: Package,
        description: 'Maintain product catalog and master data used across ordering and QR tracking.',
        children: [
            { id: 'products', label: 'Product List', icon: Package },
            { id: 'product-management', label: 'Master Data', icon: Package, access: { allowedOrgTypes: ['HQ'] } },
        ],
    },
    {
        id: 'sc-orders',
        label: 'Order Management',
        icon: FileText,
        description: 'Create and track orders by channel: HQ, Distributor, and Shop.',
        children: [
            { id: 'orders', label: 'Orders', icon: FileText },
            { id: 'distributor-order', label: 'Distributor Order', icon: ShoppingCart, access: { allowedOrgTypes: ['HQ', 'DIST'], maxRoleLevel: 40 } },
            { id: 'distributor-incentive', label: 'Distributor Incentive', icon: Trophy, access: { allowedOrgTypes: ['HQ'] } },
            { id: 'shop-order', label: 'Shop Order', icon: Store, access: { allowedOrgTypes: ['HQ', 'SHOP'] } },
        ],
    },
    {
        id: 'sc-qr',
        label: 'QR Tracking',
        icon: QrCode,
        description: 'Trace cartons/cases through scan events, receiving, and shipping operations.',
        children: [
            { id: 'qr-batches', label: 'QR Batches', icon: QrCode },
            { id: 'manufacturer-scan-2', label: 'Manufacturer Scan', icon: Factory, access: { allowedOrgTypes: ['HQ', 'MFG'] } },
            { id: 'warehouse-receive-2', label: 'Warehouse Receive', icon: Warehouse, access: { allowedOrgTypes: ['HQ', 'DIST', 'WH'] } },
            { id: 'warehouse-ship-v2', label: 'Warehouse Ship', icon: Truck, access: { allowedOrgTypes: ['HQ', 'DIST', 'WH'] } },
        ],
    },
    {
        id: 'sc-inventory',
        label: 'Inventory',
        icon: Warehouse,
        description: 'Monitor stock on hand, adjustments, transfers, and movement reporting.',
        // Entire Inventory group is hidden for manufacturers
        access: { allowedOrgTypes: ['HQ', 'DIST', 'WH'] },
        children: [
            { id: 'inventory-list', label: 'View Inventory', icon: Package },
            { id: 'inventory-settings', label: 'Inventory Settings', icon: SettingsIcon, access: { allowedOrgTypes: ['HQ'], maxRoleLevel: 10 } },
            { id: 'add-stock', label: 'Add Stock', icon: Plus },
            { id: 'stock-adjustment', label: 'Stock Adjustment', icon: SettingsIcon },
            { id: 'stock-transfer', label: 'Stock Transfer', icon: Truck },
            { id: 'stock-movements', label: 'Movement Reports', icon: ListTree },
        ],
    },
    {
        id: 'sc-quality',
        label: 'Quality & Returns',
        icon: ShieldCheck,
        description: 'Create and manage product return cases from shops to warehouse.',
        children: [
            { id: 'return-product', label: 'Return Product', icon: Undo2 },
            { id: 'return-settings', label: 'Return Settings', icon: SettingsIcon, access: { allowedOrgTypes: ['HQ', 'WH', 'DIST'] } },
            { id: 'return-reporting', label: 'Return Reporting', icon: BarChart3 },
        ],
    },
]

// ── Shared Product Catalog ────────────────────────────────────────
// The existing catalog page (/catalog/products) is shared with Customer & Growth. It is added to the Products group
// at filter time, only for people whose catalog lives in Supply Chain; it is not part of the static tree so the
// Supply Chain view detection and access rules stay unchanged. Offering it here grants nothing: the page and its APIs
// decide with product.catalog.view.
const SHARED_CATALOG_GROUP = 'sc-products'
export const SHARED_PRODUCT_CATALOG_CHILD: SupplyChainNavChild = { id: 'product-catalog', label: 'Product Catalog', icon: ShoppingCart }

// ── Access filtering ─────────────────────────────────────────────

/**
 * `permissionDecided`: the Security & Access answer for the view is available (viewAllowed). The role-level limits are
 * the legacy rules that answer already applies in each permission's legacy modes, so they are not applied a second time
 * (they would hide a function a Group Policy grants). Organization-type rules stay: they describe where a screen lives.
 */
function matchesAccess(access: SCAccessRule | undefined, orgType?: string, roleLevel?: number, permissionDecided = false): boolean {
    if (!access) return true
    const normalizedOrgType = orgType?.trim().toUpperCase()
    if (access.allowedOrgTypes && access.allowedOrgTypes.length > 0) {
        const allowedOrgTypes = access.allowedOrgTypes.map((type) => type.toUpperCase())
        if (!normalizedOrgType || !allowedOrgTypes.includes(normalizedOrgType)) return false
    }
    if (access.maxRoleLevel !== undefined && !permissionDecided) {
        if (roleLevel === undefined) return false
        if (roleLevel > access.maxRoleLevel) return false
    }
    return true
}

/**
 * Return a filtered copy of supplyChainNavGroups where groups / children
 * that the current user is not allowed to see are removed.
 */
export function filterSupplyChainNavForUser(
    orgType?: string,
    roleLevel?: number,
    /** Offer the shared Product Catalog (see productCatalogHome in nav-access.ts): it lives in Supply Chain only for people who work here. */
    includeProductCatalog = false,
    /**
     * The Security & Access answer per view (supplyChainViewVisible in nav-access.ts, from the navigation snapshot).
     * Applied on top of the organization rules; a group without an allowed child is dropped. The shared catalog child is
     * already decided by includeProductCatalog.
     */
    viewAllowed?: (viewId: string) => boolean,
): SupplyChainNavGroup[] {
    return supplyChainNavGroups
        .filter((g) => matchesAccess(g.access, orgType, roleLevel, Boolean(viewAllowed)))
        .map((g) => ({
            ...g,
            children: [
                ...g.children.filter((c) => matchesAccess(c.access, orgType, roleLevel, Boolean(viewAllowed)) && (!viewAllowed || viewAllowed(c.id))),
                ...(includeProductCatalog && g.id === SHARED_CATALOG_GROUP ? [SHARED_PRODUCT_CATALOG_CHILD] : []),
            ],
        }))
        .filter((g) => g.children.length > 0)
}

export function canAccessSupplyChainView(
    viewId: string,
    orgType?: string,
    roleLevel?: number,
    /**
     * The order-editor answer from useOrderCreateAccess (S&A once supply_chain.order.create is enforced, else the
     * level-40 rule). Omitted = the legacy rule. Replaces only the role level; organization rules stay.
     */
    orderEditorAllowed?: boolean,
    /** The Security & Access answer for the view (supplyChainViewVisible); omitted = organization rules only. */
    viewAllowed?: (viewId: string) => boolean,
): boolean {
    if (viewAllowed && !viewAllowed(viewId)) return false
    if (viewId === 'supply-chain') return true
    if (viewId === 'create-order') return orderEditorAllowed ?? canOpenOrderEditor(roleLevel)
    if (viewId === 'distributor-order' && orderEditorAllowed !== undefined) {
        return ['HQ', 'DIST'].includes(String(orgType || '').trim().toUpperCase()) && orderEditorAllowed
    }
    // Order Details: the S&A answer for supply-chain/view-order (View Orders, whose legacy rule is this same level-40
    // rule) already decided above; without it, the legacy rule alone.
    if (viewId === 'view-order' || viewId === 'track-order') return viewAllowed ? true : canOpenOrderEditor(roleLevel)

    // Product list actions render as internal views rather than top-nav items.
    // They inherit the Product List access rule so the guard does not reject
    // a user immediately after an authorized list-to-detail transition.
    //
    // Organization detail/edit views are the same shape: they are reached by
    // clicking a row in the Organizations list, so they inherit the
    // Organizations list access rule. (edit-organization-hq routes HQ users to
    // Settings but is still gated here.) Without this mapping an authorized HQ
    // admin who opens an organization is wrongly shown "Unauthorized".
    const accessViewId = ['view-product', 'edit-product', 'add-product'].includes(viewId)
        ? 'products'
        : ['view-organization', 'edit-organization', 'edit-organization-hq'].includes(viewId)
        ? 'organizations'
        : viewId

    return supplyChainNavGroups.some((group) => {
        if (!matchesAccess(group.access, orgType, roleLevel, Boolean(viewAllowed))) return false
        return group.children.some((child) => child.id === accessViewId && matchesAccess(child.access, orgType, roleLevel, Boolean(viewAllowed)))
    })
}

export function resolveSupplyChainDeepLink(view?: string | null, orderId?: string | null) {
    const isOrderView = view === 'view-order' || view === 'track-order'
    const normalizedOrderId = String(orderId || '').trim()
    if (!isOrderView || !normalizedOrderId) {
        return { initialView: 'supply-chain', initialOrderId: undefined }
    }
    return { initialView: view, initialOrderId: normalizedOrderId }
}

// ── Flat list helpers ────────────────────────────────────────────

/** All leaf-level nav items (for search, quick links, etc.) */
export function getAllSupplyChainNavItems(): SupplyChainNavChild[] {
    return supplyChainNavGroups.flatMap((g) => g.children)
}

/** Set of all Supply Chain child view IDs (for detecting if a view belongs to SC) */
const _allSupplyChainViewIds = new Set<string>([
    'supply-chain',
    ...supplyChainNavGroups.flatMap((g) => g.children.map((c) => c.id)),
    // Also include related child views not in the nav but triggered from SC views
    'view-product', 'edit-product', 'add-product',
    'create-order', 'view-order', 'track-order',
    'manufacturer-scan-2',
    'manufacturer-quality-issues',
    'inventory',
    // Organization views (moved from sidebar to Supply Chain)
    'organizations', 'add-organization', 'edit-organization', 'edit-organization-hq', 'view-organization',
])

/** Check if a given view ID belongs to the Supply Chain module */
export function isSupplyChainViewId(viewId: string): boolean {
    return _allSupplyChainViewIds.has(viewId)
}

export const supplyChainViewToPath: Record<string, string> = {
    'products': 'products',
    'product-management': 'products/master-data',
    'add-product': 'products/new',
    'orders': 'orders',
    'distributor-order': 'orders/distributor',
    'distributor-incentive': 'orders/incentive',
    'shop-order': 'orders/shop',
    'create-order': 'orders/new',
    'qr-batches': 'qr/batches',
    'manufacturer-scan-2': 'qr/manufacturer',
    'warehouse-receive-2': 'qr/receive',
    'warehouse-ship-v2': 'qr/ship',
    'inventory': 'inventory',
    'inventory-list': 'inventory',
    'inventory-settings': 'inventory-settings',
    'add-stock': 'inventory/add',
    'stock-adjustment': 'inventory/count',
    'stock-transfer': 'inventory/transfer',
    'stock-movements': 'inventory/movements',
    'return-product': 'returns',
    'return-settings': 'returns/settings',
    'return-reporting': 'returns/reporting',
    'manufacturer-quality-issues': 'quality/manufacturer-issues',
}

export const supplyChainPathToView: Record<string, string> = {
    'inventory': 'inventory-list',
    'inventory/settings': 'inventory-settings',
    'inventory/add': 'add-stock',
    'inventory/count': 'stock-adjustment',
    'inventory/transfer': 'stock-transfer',
    'inventory/movements': 'stock-movements',
    'view-inventory': 'inventory-list',
    'inventory-settings': 'inventory-settings',
    'settings': 'inventory-settings',
    'products': 'products',
    'products/master-data': 'product-management',
    'products/new': 'add-product',
    'orders': 'orders',
    'orders/distributor': 'distributor-order',
    'orders/incentive': 'distributor-incentive',
    'orders/shop': 'shop-order',
    'orders/new': 'create-order',
    'qr/batches': 'qr-batches',
    'qr/manufacturer': 'manufacturer-scan-2',
    'qr/receive': 'warehouse-receive-2',
    'qr/ship': 'warehouse-ship-v2',
    'returns': 'return-product',
    'returns/settings': 'return-settings',
    'returns/reporting': 'return-reporting',
    'quality/manufacturer-issues': 'manufacturer-quality-issues',
    'organizations': 'organizations',
    'organizations/new': 'add-organization',
}

/**
 * Build the URL path for an Organizations view so it survives a refresh and
 * browser back/forward (the org id lives in the URL, not only React state).
 *
 *   organizations        → /supply-chain/organizations
 *   add-organization     → /supply-chain/organizations/new
 *   view-organization    → /supply-chain/organizations/<id>
 *   edit-organization    → /supply-chain/organizations/<id>/edit
 *
 * Returns null for views that are not URL-addressable here (caller falls back
 * to its existing in-memory behaviour, e.g. edit-organization-hq → Settings).
 */
export function supplyChainOrganizationPath(view: string, orgId?: string | null): string | null {
    if (view === 'organizations') return 'organizations'
    if (view === 'add-organization') return 'organizations/new'
    const id = String(orgId || '').trim()
    if (!id) return null
    if (view === 'view-organization') return `organizations/${id}`
    if (view === 'edit-organization') return `organizations/${id}/edit`
    return null
}

/** Product detail/edit deep links under /supply-chain/products/... */
export function supplyChainProductPath(view: string, productId?: string | null): string | null {
    if (view === 'add-product') return 'products/new'
    const id = String(productId || '').trim()
    if (!id) return null
    if (view === 'view-product') return `products/${id}`
    if (view === 'edit-product') return `products/${id}/edit`
    return null
}

/** Order detail/track deep links under /supply-chain/orders/... */
export function supplyChainOrderPath(view: string, orderId?: string | null): string | null {
    if (view === 'create-order') return 'orders/new'
    const id = String(orderId || '').trim()
    if (!id) return null
    if (view === 'view-order') return `orders/${id}`
    if (view === 'track-order') return `orders/${id}/track`
    return null
}

const PRODUCT_PATH_RESERVED = new Set(['new', 'master-data'])
const ORDER_PATH_RESERVED = new Set(['new', 'distributor', 'incentive', 'shop'])

/**
 * Resolve a Supply Chain catch-all slug into a view id (and optional entity ids).
 * Handles Organizations / Products / Orders deep links plus the static path map.
 */
export function resolveSupplyChainSlug(slug: string[]): {
    initialView: string
    initialOrgId?: string
    initialOrderId?: string
    initialProductId?: string
} {
    if (slug[0] === 'organizations') {
        if (slug.length === 1) return { initialView: 'organizations' }
        if (slug[1] === 'new') return { initialView: 'add-organization' }
        const initialOrgId = slug[1]
        const initialView = slug[2] === 'edit' ? 'edit-organization' : 'view-organization'
        return { initialView, initialOrgId }
    }

    if (slug[0] === 'products' && slug[1] && !PRODUCT_PATH_RESERVED.has(slug[1])) {
        const initialProductId = slug[1]
        const initialView = slug[2] === 'edit' ? 'edit-product' : 'view-product'
        return { initialView, initialProductId }
    }

    if (slug[0] === 'orders' && slug[1] && !ORDER_PATH_RESERVED.has(slug[1])) {
        const initialOrderId = slug[1]
        const initialView = slug[2] === 'track' ? 'track-order' : 'view-order'
        return { initialView, initialOrderId }
    }

    const path = slug.join('/')
    const initialView = supplyChainPathToView[path] || supplyChainPathToView[slug[0] || ''] || 'supply-chain'
    return { initialView }
}

/** Find which group a given view id belongs to */
export function findSupplyChainGroupForView(viewId: string): SupplyChainNavGroup | undefined {
    return supplyChainNavGroups.find(
        (g) => g.id === viewId || g.children.some((c) => c.id === viewId)
    )
}

/** Build breadcrumb segments from a view id, e.g. ['Supply Chain', 'Products', 'Product List'] */
export function getSupplyChainBreadcrumb(rawViewId: string, includeProductCatalog = false): { label: string; href?: string }[] {
    const crumbs: { label: string; href?: string }[] = [{ label: 'Supply Chain', href: 'supply-chain' }]
    // The Product Catalog landing ('catalog') and its page ('product-catalog') are one destination here.
    const viewId = includeProductCatalog && rawViewId === 'catalog' ? SHARED_PRODUCT_CATALOG_CHILD.id : rawViewId
    if (includeProductCatalog && viewId === SHARED_PRODUCT_CATALOG_CHILD.id) {
        const products = supplyChainNavGroups.find((g) => g.id === SHARED_CATALOG_GROUP)
        if (products) crumbs.push({ label: products.label })
        crumbs.push({ label: SHARED_PRODUCT_CATALOG_CHILD.label, href: SHARED_PRODUCT_CATALOG_CHILD.id })
        return crumbs
    }
    const group = findSupplyChainGroupForView(viewId)
    if (group) {
        crumbs.push({ label: group.label })
        const child = group.children.find((c) => c.id === viewId)
        if (child) {
            crumbs.push({ label: child.label, href: child.id })
        }
    }
    return crumbs
}
