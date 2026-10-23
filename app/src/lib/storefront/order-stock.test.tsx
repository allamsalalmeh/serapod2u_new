import { describe, expect, it, vi } from 'vitest'
import { sellableStock, stockErrorMessage, stockMoveNote, stockShortfall, takeOrderStock } from './order-stock'

describe('order stock', () => {
  it('turns database refusals into messages staff can act on', () => {
    expect(stockErrorMessage({ message: 'storefront_stock_short: Cellera (Mango) has 1 in the warehouse, this order needs 3.' }))
      .toBe('Not enough stock to ship: Cellera (Mango) has 1 in the warehouse, this order needs 3. Add stock in Inventory first.')
    expect(stockErrorMessage({ message: 'inventory_cutoff_warehouse_frozen: ...' })).toContain('stock count')
    expect(stockErrorMessage({ message: 'storefront_no_fulfilment_warehouse: none' })).toContain('Ship Website Orders From This Warehouse')
  })

  it('keeps shipping when the stock functions are not deployed yet', async () => {
    const admin = { rpc: vi.fn(async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } })) }
    expect(await takeOrderStock(admin, 'o1', 'u1')).toEqual({ ok: true, status: 'unavailable', units: 0 })
  })

  it('reports a failed stock move instead of throwing', async () => {
    const admin = { rpc: vi.fn(async () => { throw new Error('network down') }) }
    const result = await takeOrderStock(admin, 'o1', 'u1')
    expect(result.ok).toBe(false)
  })

  it('only writes a note when stock actually moved', () => {
    expect(stockMoveNote({ ok: true, status: 'taken', units: 3 }, 'out')).toBe('3 items taken out of warehouse stock')
    expect(stockMoveNote({ ok: true, status: 'returned', units: 1 }, 'back')).toBe('1 item put back into warehouse stock')
    expect(stockMoveNote({ ok: true, status: 'already', units: 0 }, 'out')).toBeNull()
    expect(stockMoveNote({ ok: true, status: 'unavailable', units: 0 }, 'out')).toBeNull()
  })

  it('keeps selling when stock cannot be read', async () => {
    const admin = { rpc: vi.fn(async () => ({ data: null, error: { message: 'storefront_no_fulfilment_warehouse: none' } })) }
    expect(await sellableStock(admin, ['v1'])).toBeNull()
    expect(stockShortfall([{ variantId: 'v1', quantity: 5, name: 'Cellera' }], null)).toBeNull()
  })

  it('asks for the stock of the shop it sells in', async () => {
    const admin = { rpc: vi.fn(async () => ({ data: [], error: null })) }
    await sellableStock(admin, ['v1'])
    await sellableStock(admin, ['v1'], 'outdoor')
    expect(admin.rpc).toHaveBeenNthCalledWith(1, 'storefront_variant_stock', { p_variant_ids: ['v1'], p_channel: 'store' })
    expect(admin.rpc).toHaveBeenNthCalledWith(2, 'storefront_variant_stock', { p_variant_ids: ['v1'], p_channel: 'outdoor' })
  })

  it('stops a cart the warehouse cannot cover', async () => {
    const admin = { rpc: vi.fn(async () => ({ data: [{ variant_id: 'v1', available: 2 }, { variant_id: 'v2', available: 0 }], error: null })) }
    const stock = await sellableStock(admin, ['v1', 'v2'])
    expect(stockShortfall([{ variantId: 'v1', quantity: 2, name: 'Cellera Mango' }], stock)).toBeNull()
    expect(stockShortfall([
      { variantId: 'v1', quantity: 1, name: 'Cellera Mango' },
      { variantId: 'v1', quantity: 2, name: 'Cellera Mango' },
    ], stock)).toBe('Only 2 of Cellera Mango left. Lower the quantity to continue.')
    expect(stockShortfall([{ variantId: 'v2', quantity: 1, name: 'Cellera Lime' }], stock))
      .toBe('Cellera Lime is out of stock. Remove it from your cart to continue.')
  })
})
