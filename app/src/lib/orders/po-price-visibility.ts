/**
 * The Purchase Order HQ sends a manufacturer for an H2M order lists what to
 * make, never what HQ pays: no unit price, line amount or total. Other order
 * types and other documents (invoices, receipts) keep their prices.
 */

const MANUFACTURER_ORG_TYPES = ['MANU', 'MFG']

export function isH2MOrderType(orderType: string | null | undefined): boolean {
  return String(orderType || '').toUpperCase() === 'H2M'
}

export function purchaseOrderHidesPrices(orderType: string | null | undefined, docType: string | null | undefined): boolean {
  return String(docType || '').toUpperCase() === 'PO' && isH2MOrderType(orderType)
}

export function isManufacturerOrgType(orgTypeCode: string | null | undefined): boolean {
  return MANUFACTURER_ORG_TYPES.includes(String(orgTypeCode || '').toUpperCase())
}
