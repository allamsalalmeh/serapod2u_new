import { describe, expect, it, vi } from 'vitest'
import { applyReturnSourcePrices, buildReturnItemRows } from './server'

function adminWithPrices(rows: any[]) {
    const builder: any = {
        select: vi.fn(() => builder),
        in: vi.fn(() => builder),
        then: (resolve: (value: any) => unknown, reject: (reason: any) => unknown) =>
            Promise.resolve({ data: rows, error: null }).then(resolve, reject),
    }
    return { from: vi.fn(() => builder), builder }
}

const lines = () => buildReturnItemRows('rc-1', [
    { variant_id: 'v-cellera', product_name: 'Cellera Hero', case_qty: 458, loose_piece_qty: 0, units_per_case_snapshot: 4, unit_cost: 14, unit_price: 1 },
    { variant_id: 'v-none', product_name: 'Other', case_qty: 0, loose_piece_qty: 2, units_per_case_snapshot: 1, unit_cost: 60 },
]).rows!

describe('applyReturnSourcePrices', () => {
    const prices = [
        { id: 'v-cellera', distributor_price: 32, retailer_price: 35 },
        { id: 'v-none', distributor_price: null, retailer_price: null },
    ]

    it('prices distributor returns at the distributor price', async () => {
        const { from } = adminWithPrices(prices)
        const rows = await applyReturnSourcePrices({ from }, lines(), 'distributor')
        expect(rows.map((r) => r.unit_price)).toEqual([32, null])
    })

    it('prices shop returns at the retailer price', async () => {
        const { from } = adminWithPrices(prices)
        const rows = await applyReturnSourcePrices({ from }, lines(), 'shop')
        expect(rows.map((r) => r.unit_price)).toEqual([35, null])
    })

    it('never takes the price from the client and keeps the stock cost', async () => {
        const built = lines()
        expect((built[0] as any).unit_price).toBeUndefined()
        const { from } = adminWithPrices(prices)
        const rows = await applyReturnSourcePrices({ from }, built, 'distributor')
        expect(rows[0].unit_cost).toBe(14)
    })

    it('fails instead of saving unpriced lines when prices cannot be read', async () => {
        const builder: any = {
            select: vi.fn(() => builder),
            in: vi.fn(() => builder),
            then: (resolve: (value: any) => unknown) => Promise.resolve({ data: null, error: { message: 'down' } }).then(resolve),
        }
        await expect(applyReturnSourcePrices({ from: () => builder }, lines(), 'shop')).rejects.toThrow('Could not load product prices')
    })
})
