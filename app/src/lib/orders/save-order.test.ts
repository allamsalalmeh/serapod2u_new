import { describe, expect, it } from 'vitest'
import { classifySaveOrderError, parseSaveOrderRequest, stageFromError } from './save-order'

const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const base = () => ({
  mode: 'create',
  orderId: uuid(1),
  requestedStatus: 'submitted',
  sellerOrgId: uuid(2),
  unitsPerCase: 4,
  qrBufferPercent: 10,
  extraQrMaster: 5,
  hasRfid: false,
  hasPoints: true,
  hasLuckyDraw: false,
  hasRedeem: false,
  notes: 'Customer: A',
  // the production order: 1,000 / 2,000 / 3,000 / 5,000 / 8,000 cases
  items: [1000, 2000, 3000, 5000, 8000].map((qty, i) => ({ product_id: uuid(10), variant_id: uuid(20 + i), qty, unit_price: 12.5 })),
})

describe('parseSaveOrderRequest', () => {
  it('accepts the multi-line production order', () => {
    const parsed = parseSaveOrderRequest(base())
    expect(parsed?.items).toHaveLength(5)
    expect(parsed?.items.map(i => i.qty)).toEqual([1000, 2000, 3000, 5000, 8000])
  })

  it('requires the loaded updated_at for edits so concurrent saves cannot overwrite', () => {
    expect(parseSaveOrderRequest({ ...base(), mode: 'update' })).toBeNull()
    expect(parseSaveOrderRequest({ ...base(), mode: 'update', expectedUpdatedAt: '2026-10-07T01:02:03.123456+00:00' })?.expectedUpdatedAt)
      .toBe('2026-10-07T01:02:03.123456+00:00')
  })

  it.each([
    ['unknown mode', { mode: 'upsert' }],
    ['status other than draft/submitted', { requestedStatus: 'approved' }],
    ['non-uuid order id', { orderId: 'abc' }],
    ['empty items', { items: [] }],
    ['zero quantity', { items: [{ product_id: uuid(1), variant_id: uuid(2), qty: 0, unit_price: 1 }] }],
    ['fractional quantity', { items: [{ product_id: uuid(1), variant_id: uuid(2), qty: 1.5, unit_price: 1 }] }],
    ['negative price', { items: [{ product_id: uuid(1), variant_id: uuid(2), qty: 1, unit_price: -1 }] }],
    ['missing config number', { unitsPerCase: undefined }],
  ])('rejects %s', (_label, patch) => {
    expect(parseSaveOrderRequest({ ...base(), ...patch })).toBeNull()
  })

  it('does not accept identity or ownership fields from the client', () => {
    const parsed = parseSaveOrderRequest({ ...base(), createdBy: 'x', companyId: 'y', buyerOrgId: 'z', warehouseOrgId: 'w', orderType: 'H2M' }) as any
    expect(parsed).not.toBeNull()
    for (const key of ['createdBy', 'companyId', 'buyerOrgId', 'warehouseOrgId', 'orderType']) expect(parsed[key]).toBeUndefined()
  })
})

describe('classifySaveOrderError', () => {
  it.each([
    ['40001', 409, 'order_changed'],
    ['P0002', 404, 'order_not_found'],
    ['55000', 409, 'order_not_editable'],
    ['42501', 403, 'forbidden'],
    ['22023', 400, 'invalid_request'],
    ['55P03', 409, 'order_busy'],
    ['57014', 504, 'timeout'],
    ['XX000', 500, 'save_failed'],
  ])('maps SQLSTATE %s', (code, status, mapped) => {
    expect(classifySaveOrderError({ code, message: 'x' })).toMatchObject({ status, code: mapped })
  })

  it('distinguishes a missing HQ warehouse from a status conflict', () => {
    expect(classifySaveOrderError({ code: '55000', message: 'hq_default_warehouse_missing' }).code).toBe('configuration')
  })

  it('only claims "Nothing was saved" in messages the atomic database call can guarantee', () => {
    for (const code of ['40001', '42501', '57014', 'XX000']) {
      expect(classifySaveOrderError({ code }).message).toMatch(/nothing was saved/i)
    }
  })

  it('extracts the failing stage without exposing payload', () => {
    expect(stageFromError({ details: 'stage=delete_items' })).toBe('delete_items')
    expect(stageFromError({ details: null })).toBeUndefined()
  })
})
