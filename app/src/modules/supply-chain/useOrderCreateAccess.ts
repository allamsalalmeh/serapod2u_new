'use client'

import { useSaCapabilityState } from '@/hooks/useSaCapability'
import { ORDER_CREATE_PERMISSION, canCreateH2MOrder, canOpenOrderEditor, isHqOrganization } from './h2m-access'

const MANUFACTURER_ORG_TYPES = ['MANU', 'MFG']

export interface OrderCreateAccess {
    /** The Create Order action (organization rules still decide which order types are offered). */
    canCreateOrders: boolean
    /** H2M: HQ organizations only. */
    canCreateH2M: boolean
    /** The order editor views (create-order, distributor-order). */
    canOpenEditor: boolean
    loading: boolean
}

/**
 * Who may create orders, decided like the server decides it.
 *
 * Once supply_chain.order.create is enforced (NEW_ENFORCED / LEGACY_RETIRED) the caller's own S&A answer decides every
 * creation control — an Order Creator grant (or Root Access) opens them, a role level alone does not. Until then each
 * control keeps its historical rule (`legacyCreateOrders`, the HQ level-40 H2M rule, the level-40 editor rule). The
 * organization rules never change: manufacturers do not create orders and H2M stays HQ-only. Presentation only: the
 * API, the save RPC, orders_insert and the write guard re-decide every save.
 */
export function useOrderCreateAccess(orgType: string | null | undefined, roleLevel: number | null | undefined, legacyCreateOrders: boolean): OrderCreateAccess {
    // Same permission and organization, so the three lookups share one in-flight request.
    const create = useSaCapabilityState(ORDER_CREATE_PERMISSION, legacyCreateOrders)
    const h2m = useSaCapabilityState(ORDER_CREATE_PERMISSION, canCreateH2MOrder(orgType, roleLevel))
    const editor = useSaCapabilityState(ORDER_CREATE_PERMISSION, canOpenOrderEditor(roleLevel))
    const manufacturer = MANUFACTURER_ORG_TYPES.includes(String(orgType || '').trim().toUpperCase())
    return {
        canCreateOrders: !manufacturer && create.allowed,
        canCreateH2M: isHqOrganization(orgType) && h2m.allowed,
        canOpenEditor: editor.allowed,
        loading: create.loading || h2m.loading || editor.loading,
    }
}
