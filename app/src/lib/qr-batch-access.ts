/** Organization types whose users may trigger QR batch processing from the dashboard. */
export const PROCESSING_ORG_TYPES: readonly string[] = ['HQ', 'MFG']

export type OrderOwnership = {
  seller_org_id: string | null
  buyer_org_id: string | null
  company_id: string | null
}

/** Whether a user of `orgType`/`orgId` may process a batch for this order. */
export function canProcessBatchForOrder(orgType: string, orgId: string, order: OrderOwnership | null): boolean {
  if (!order || !orgId) return false
  // The manufacturer the order was placed with (what QRBatchesView lists).
  if (order.seller_org_id === orgId) return true
  // The HQ that owns the order.
  if (orgType === 'HQ') return order.company_id === orgId || order.buyer_org_id === orgId
  return false
}

/** Partner organization types: they act only on orders they are the seller (manufacturer) of. */
export const PARTNER_ORG_TYPES: readonly string[] = ['MFG', 'DIST', 'SHOP']

export const isPartnerOrgType = (orgType: string) => PARTNER_ORG_TYPES.includes(String(orgType || '').toUpperCase())

/**
 * Whether a caller may READ or DOWNLOAD a batch of this order. A partner
 * (manufacturer / distributor / shop) only sees batches of orders placed with
 * it: orders.seller_org_id is the manufacturer party. (qr_batches.company_id is
 * the owning HQ, so it never identifies the manufacturer.) Internal
 * organizations keep their existing behaviour.
 */
export function canAccessBatchForOrder(orgType: string, orgId: string, order: OrderOwnership | null): boolean {
  if (!order || !orgId) return false
  if (isPartnerOrgType(orgType)) return order.seller_org_id === orgId
  return true
}
