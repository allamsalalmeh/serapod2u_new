import { describe, expect, it } from 'vitest'
import { canAccessBatchForOrder, canProcessBatchForOrder, isPartnerOrgType } from './qr-batch-access'
import { classifyPermission } from './security-access/modules'
import { isEnforcementReady } from './security-access/readiness'

// An H2M order is owned by HQ (company/buyer) and placed WITH a manufacturer (seller).
const order = { seller_org_id: 'mfg-a', buyer_org_id: 'hq', company_id: 'hq' }

describe('QR batch ownership', () => {
  it('a manufacturer reaches only batches of orders placed with it', () => {
    expect(canAccessBatchForOrder('MFG', 'mfg-a', order)).toBe(true)
    expect(canAccessBatchForOrder('MFG', 'mfg-b', order)).toBe(false)           // other manufacturer
    expect(canProcessBatchForOrder('MFG', 'mfg-b', order)).toBe(false)
  })
  it('a manufacturer is never identified by the HQ ownership fields of the batch/order', () => {
    expect(canAccessBatchForOrder('MFG', 'hq', order)).toBe(false)
    expect(canAccessBatchForOrder('DIST', 'hq', order)).toBe(false)
    expect(canAccessBatchForOrder('SHOP', 'mfg-a', { ...order, seller_org_id: null })).toBe(false)
  })
  it('HQ and other internal organizations keep their existing behaviour', () => {
    expect(canAccessBatchForOrder('HQ', 'hq', order)).toBe(true)
    expect(canProcessBatchForOrder('HQ', 'hq', order)).toBe(true)
    expect(canProcessBatchForOrder('HQ', 'other-hq', order)).toBe(false)
    expect(canAccessBatchForOrder('WH', 'wh-1', order)).toBe(true)
  })
  it('denies when the order or caller organization is unknown', () => {
    expect(canAccessBatchForOrder('MFG', '', order)).toBe(false)
    expect(canAccessBatchForOrder('MFG', 'mfg-a', null)).toBe(false)
  })
  it('partner types are manufacturer, distributor and shop', () => {
    for (const t of ['MFG', 'DIST', 'SHOP', 'mfg']) expect(isPartnerOrgType(t)).toBe(true)
    for (const t of ['HQ', 'WH', '']) expect(isPartnerOrgType(t)).toBe(false)
  })
})

describe('qr.batch.manage classification', () => {
  it('sits under Supply Chain → QR & Traceability and stays enforcement-ready only because its paths are guarded', () => {
    expect(classifyPermission('qr.batch.manage')).toEqual({ groupId: 'supply_chain', areaId: 'qr', areaName: 'QR & Traceability' })
    expect(isEnforcementReady('qr.batch.manage')).toBe(true)
  })
})
