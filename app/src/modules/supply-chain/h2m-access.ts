/** The Security & Access permission every order-creation path is decided with (API, RPC, RLS, write guard). */
export const ORDER_CREATE_PERMISSION = 'supply_chain.order.create'

export function isHqOrganization(orgType?: string | null) {
    return String(orgType || '').trim().toUpperCase() === 'HQ'
}

/**
 * Legacy rule: role levels 1-40 are level 40 or higher privilege in this hierarchy. Once supply_chain.order.create is
 * S&A-authoritative the S&A decision replaces the role level (useOrderCreateAccess; sa_actor_may_create_h2m in SQL);
 * the HQ-only rule stays.
 */
export function canCreateH2MOrder(orgType?: string | null, roleLevel?: number | null) {
    return isHqOrganization(orgType)
        && typeof roleLevel === 'number'
        && Number.isFinite(roleLevel)
        && roleLevel <= 40
}

export function canOpenOrderEditor(roleLevel?: number | null) {
    return typeof roleLevel === 'number'
        && Number.isFinite(roleLevel)
        && roleLevel <= 40
}
