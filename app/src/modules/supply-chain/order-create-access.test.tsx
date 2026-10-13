/** @vitest-environment jsdom */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'

import { ORDER_CREATE_PERMISSION } from './h2m-access'
import { canAccessSupplyChainView } from './supplyChainNav'
import { useOrderCreateAccess } from './useOrderCreateAccess'

type Answer = { allowed: boolean; enforced: boolean } | 'fail'
function mockCapabilities(answer: Answer) {
    const fetchMock = vi.fn(async (url: string) => {
        expect(url).toContain(`permissions=${ORDER_CREATE_PERMISSION}`)
        if (answer === 'fail') return { ok: false, json: async () => null }
        return { ok: true, json: async () => ({ capabilities: { [ORDER_CREATE_PERMISSION]: answer } }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
}
async function access(orgType: string, roleLevel: number, legacyCreateOrders: boolean) {
    const { result } = renderHook(() => useOrderCreateAccess(orgType, roleLevel, legacyCreateOrders))
    expect(result.current.loading).toBe(true)
    expect(result.current.canCreateOrders).toBe(false) // hidden while being looked up
    await waitFor(() => expect(result.current.loading).toBe(false))
    return result.current
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('order creation follows Security & Access once enforced', () => {
    it('HQ level 50 with an Order Creator grant: Create Order, H2M and the editor are offered', async () => {
        const fetchMock = mockCapabilities({ allowed: true, enforced: true })
        expect(await access('HQ', 50, false)).toEqual({ canCreateOrders: true, canCreateH2M: true, canOpenEditor: true, loading: false })
        expect(fetchMock).toHaveBeenCalledTimes(1) // the three lookups share one request
    })

    it('without the grant (e.g. Order Approver only) nothing is offered, whatever the role level', async () => {
        mockCapabilities({ allowed: false, enforced: true })
        expect(await access('HQ', 50, false)).toMatchObject({ canCreateOrders: false, canCreateH2M: false, canOpenEditor: false })
        mockCapabilities({ allowed: false, enforced: true })
        expect(await access('HQ', 10, true)).toMatchObject({ canCreateOrders: false, canCreateH2M: false, canOpenEditor: false })
    })

    it('organization rules stay: a distributor never gets H2M, a manufacturer never creates', async () => {
        mockCapabilities({ allowed: true, enforced: true })
        expect(await access('DIST', 50, false)).toMatchObject({ canCreateOrders: true, canCreateH2M: false, canOpenEditor: true })
        mockCapabilities({ allowed: true, enforced: true })
        expect(await access('MFG', 30, true)).toMatchObject({ canCreateOrders: false, canCreateH2M: false })
    })

    it('before enforcement (or if the lookup fails) the legacy rules decide unchanged', async () => {
        mockCapabilities({ allowed: true, enforced: false })
        expect(await access('HQ', 50, false)).toMatchObject({ canCreateOrders: false, canCreateH2M: false, canOpenEditor: false })
        mockCapabilities({ allowed: false, enforced: false })
        expect(await access('HQ', 40, true)).toMatchObject({ canCreateOrders: true, canCreateH2M: true, canOpenEditor: true })
        mockCapabilities('fail')
        expect(await access('HQ', 50, false)).toMatchObject({ canCreateOrders: false, canCreateH2M: false, canOpenEditor: false })
    })
})

describe('Supply Chain page guard with the order-editor answer', () => {
    it('create-order follows the answer; without one the level-40 rule applies', () => {
        expect(canAccessSupplyChainView('create-order', 'HQ', 50, true)).toBe(true)
        expect(canAccessSupplyChainView('create-order', 'HQ', 10, false)).toBe(false)
        expect(canAccessSupplyChainView('create-order', 'HQ', 50)).toBe(false)
        expect(canAccessSupplyChainView('create-order', 'HQ', 40)).toBe(true)
    })

    it('distributor-order follows the answer but stays HQ/distributor only', () => {
        expect(canAccessSupplyChainView('distributor-order', 'DIST', 50, true)).toBe(true)
        expect(canAccessSupplyChainView('distributor-order', 'HQ', 50, true)).toBe(true)
        expect(canAccessSupplyChainView('distributor-order', 'SHOP', 10, true)).toBe(false)
        expect(canAccessSupplyChainView('distributor-order', 'DIST', 10, false)).toBe(false)
        expect(canAccessSupplyChainView('distributor-order', 'DIST', 50)).toBe(false)
        expect(canAccessSupplyChainView('distributor-order', 'DIST', 40)).toBe(true)
    })

    it('other views ignore the answer', () => {
        expect(canAccessSupplyChainView('inventory-list', 'MFG', 30, true)).toBe(false)
        expect(canAccessSupplyChainView('view-order', 'HQ', 50, true)).toBe(false)
    })
})

describe('database rule (20261028100000)', () => {
    const sql = fs.readFileSync(path.resolve(process.cwd(), '../supabase/migrations/20261028100000_sa_order_creator_policy.sql'), 'utf8')
    it('seeds a standard Order Creator holding exactly order creation', () => {
        expect(sql).toMatch(/'order-creator', 'Order Creator'[\s\S]*'template', 'active', array\['HQ','DIST','SHOP'\]/)
        expect(sql).toContain("is distinct from array['supply_chain.order.create']")
        expect(sql).not.toMatch(/supply_chain\.order\.(approve|cancel)'/)
    })
    it('keeps the legacy level-40 rule until S&A is authoritative and the HQ-only rule always', () => {
        expect(sql).toContain("public.get_org_type(public.current_user_org_id()) = 'HQ'")
        expect(sql).toContain("public.sa_is_new_authoritative('supply_chain.order.create')")
        expect(sql).toContain('else public.current_user_role_level() <= 40 end')
        expect(sql).toContain("order_type <> 'H2M'\n        or public.sa_actor_may_create_h2m()")
    })
})
