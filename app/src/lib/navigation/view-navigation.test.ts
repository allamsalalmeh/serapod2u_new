import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveSupplyChainSlug, supplyChainViewToPath } from '@/modules/supply-chain/supplyChainNav'
import { normalizeNavPath, shouldSwitchViewInMemory } from './view-navigation'

const shellSource = () =>
    readFileSync(path.join(process.cwd(), 'src/components/dashboard/DashboardContent.tsx'), 'utf8')

describe('normalizeNavPath', () => {
    it('compares locations the way the router does', () => {
        expect(normalizeNavPath('/supply-chain/inventory')).toBe('/supply-chain/inventory')
        expect(normalizeNavPath('/supply-chain/inventory/')).toBe('/supply-chain/inventory')
        expect(normalizeNavPath('/supply-chain/inventory///')).toBe('/supply-chain/inventory')
        expect(normalizeNavPath('/supply-chain/inventory?page=2')).toBe('/supply-chain/inventory')
        expect(normalizeNavPath('/supply-chain/inventory#stock')).toBe('/supply-chain/inventory')
        expect(normalizeNavPath('  /users/u-1 ')).toBe('/users/u-1')
    })

    it('keeps the root and reports an unknown location as empty', () => {
        expect(normalizeNavPath('/')).toBe('/')
        expect(normalizeNavPath('')).toBe('')
        expect(normalizeNavPath(null)).toBe('')
        expect(normalizeNavPath(undefined)).toBe('')
        expect(normalizeNavPath('?tab=1')).toBe('')
    })
})

describe('shouldSwitchViewInMemory', () => {
    it('paints the view itself only when the URL cannot deliver it', () => {
        // Same page: the push is a no-op, so the shell is the only renderer.
        expect(shouldSwitchViewInMemory('/supply-chain/inventory', '/supply-chain/inventory')).toBe(true)
        expect(shouldSwitchViewInMemory('/supply-chain/inventory', '/supply-chain/inventory/')).toBe(true)
        expect(shouldSwitchViewInMemory('/supply-chain/inventory', '/supply-chain/inventory?tab=stock')).toBe(true)
    })

    it('never paints a view that its destination page paints: a path change recreates the route segment', () => {
        // The reported flicker: sidebar → View Inventory loads the view twice (old page + arriving page).
        expect(shouldSwitchViewInMemory('/dashboard', '/supply-chain/inventory')).toBe(false)
        // Supply Chain tab → tab: both pages render the shell for their own URL.
        expect(shouldSwitchViewInMemory('/supply-chain/products', '/supply-chain/inventory')).toBe(false)
        expect(shouldSwitchViewInMemory('/supply-chain/inventory', '/supply-chain/inventory/movements')).toBe(false)
        // Leaving a module for another module.
        expect(shouldSwitchViewInMemory('/supply-chain/inventory', '/finance')).toBe(false)
        // A sibling that only shares a prefix is still a different page.
        expect(shouldSwitchViewInMemory('/users', '/users/u-1')).toBe(false)
        expect(shouldSwitchViewInMemory('/supply-chain', '/supply-chain/products')).toBe(false)
        // Paths are case-sensitive.
        expect(shouldSwitchViewInMemory('/Supply-Chain/Inventory', '/supply-chain/inventory')).toBe(false)
    })

    it('falls back to the push when a location is unknown', () => {
        expect(shouldSwitchViewInMemory(null, '/supply-chain/inventory')).toBe(false)
        expect(shouldSwitchViewInMemory(undefined, '/supply-chain/inventory')).toBe(false)
        expect(shouldSwitchViewInMemory('', '/supply-chain/inventory')).toBe(false)
        expect(shouldSwitchViewInMemory('/dashboard', '')).toBe(false)
    })
})

describe('the page that arrives can deliver the view the shell pushed', () => {
    // Two ids render the same view: both stack in one case of the shell switch, so the swap is not a remount.
    const aliasOf: Record<string, string> = { inventory: 'inventory-list' }

    it('every Supply Chain view path resolves back to the view it was pushed for', () => {
        for (const [view, viewPath] of Object.entries(supplyChainViewToPath)) {
            const { initialView } = resolveSupplyChainSlug(viewPath.split('/'))
            expect(initialView, `${view} -> /supply-chain/${viewPath}`).toBe(aliasOf[view] ?? view)
        }
    })
})

describe('DashboardContent leaves the arriving page as the only renderer of a URL-backed view', () => {
    // The one place the in-memory switch is allowed to precede a push, and the guard it must carry.
    const openViewBlock = (source: string) => {
        const start = source.indexOf('const openView = ')
        const end = source.indexOf('const handleViewChange = (view: string) => {', start)
        return start >= 0 && end > start ? source.slice(start, end) : ''
    }

    it('switches the in-memory view before a push only inside openView, behind the URL guard', () => {
        const source = shellSource()
        const openView = openViewBlock(source)
        expect(openView).toContain('shouldSwitchViewInMemory(pathname, href)')
        // `setCurrentView(x); router.push(y)` with x !== y mounts the view in both pages (two data loads, flicker).
        expect(source.replace(openView, '')).not.toMatch(/setCurrentView\([^)]*\)\s*\r?\n\s*router\.push\(/)
    })

    it('sends every URL-backed view through openView', () => {
        const source = shellSource()
        for (const href of [
            '/finance',
            '/customer-growth',
            '/supply-chain',
            '/notifications',
            '/reporting',
            '/my-profile',
            '/users',
            '/security-access',
        ]) {
            expect(source).not.toContain(`router.push('${href}')`)
        }
        // Supply Chain view ids travel through the shared mapping, not a bare push.
        expect(source).toContain('openView(view, `/supply-chain/${supplyChainPath}`)')
        expect(source).toContain('openView(view, `/supply-chain/${orgPath}`)')
    })

    it('keeps staging finance URLs while using the shared destination-render guard', () => {
        const source = shellSource()
        const start = source.indexOf("const financeViewId = view.replace")
        const end = source.indexOf('// ── Redirect Customer & Growth', start)
        const finance = source.slice(start, end)
        expect(finance).toContain("view.replace(/^\\//, '')")
        expect(finance).toContain("financeViewId === 'finance' || financeViewId.startsWith('finance/')")
        expect(finance).toContain('openView(financeViewId, `/${financeViewId}`)')
        expect(finance).not.toContain('setCurrentView(')
        expect(finance).not.toContain('router.push(')
        for (const destination of ['/finance', '/finance/gl/journals', '/finance/cash/bank-accounts']) {
            expect(shouldSwitchViewInMemory('/dashboard', destination)).toBe(false)
            expect(shouldSwitchViewInMemory(destination, destination)).toBe(true)
        }
    })

    it('keeps the S&A gate in front of every Supply Chain view it renders', () => {
        const source = shellSource()
        expect(source).toContain("navAccess.status === 'loading'")
        expect(source).toContain(
            'canAccessSupplyChainView(viewId, orgTypeCode, roleLevel, orderEditorAllowed, supplyChainViewAllowed)'
        )
        expect(source).toMatch(/You do not have permission to view this Supply Chain page\./)
    })
})
