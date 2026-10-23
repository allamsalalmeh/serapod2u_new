import { describe, expect, it } from 'vitest'
import { itemLineValue, itemsTotalValue } from './compute'
import type { ReturnCaseItem } from './types'

const line = (patch: Partial<ReturnCaseItem>) => ({
    total_units: 0, quantity: 0, unit_cost: 0, units_per_case_snapshot: 1, ...patch,
}) as ReturnCaseItem

describe('itemLineValue', () => {
    it('values a cartridge line per case: 458 cases (1,832 pcs) at RM14 a case', () => {
        expect(itemLineValue(line({ total_units: 1832, unit_cost: 14, units_per_case_snapshot: 4 }))).toBe(6412)
    })

    it('values loose pieces as their share of a case', () => {
        expect(itemLineValue(line({ total_units: 2, unit_cost: 14, units_per_case_snapshot: 4 }))).toBe(7)
    })

    it('values lines without a pack size per piece, as before', () => {
        expect(itemLineValue(line({ total_units: 3, unit_cost: 60, units_per_case_snapshot: 1 }))).toBe(180)
        expect(itemLineValue(line({ total_units: 3, unit_cost: 60, units_per_case_snapshot: null }))).toBe(180)
        expect(itemLineValue(line({ total_units: 0, quantity: 5, unit_cost: 10, units_per_case_snapshot: null }))).toBe(50)
    })
})

describe('itemLineValue at the source price', () => {
    it('values 458 cases at the distributor price, not the factory cost', () => {
        expect(itemLineValue(line({ total_units: 1832, unit_cost: 14, unit_price: 32, units_per_case_snapshot: 4 }))).toBe(14656)
    })

    it('values shop returns at the retailer price', () => {
        expect(itemLineValue(line({ total_units: 800, unit_cost: 14, unit_price: 35, units_per_case_snapshot: 4 }))).toBe(7000)
    })

    it('keeps the old value for lines saved before prices were recorded', () => {
        expect(itemLineValue(line({ total_units: 1832, unit_cost: 14, unit_price: null, units_per_case_snapshot: 4 }))).toBe(6412)
    })
})

describe('itemsTotalValue', () => {
    it('sums cartridge and device lines on their own units', () => {
        expect(itemsTotalValue([
            line({ total_units: 800, unit_cost: 14, units_per_case_snapshot: 4 }),
            line({ total_units: 1600, unit_cost: 14, units_per_case_snapshot: 4 }),
            line({ total_units: 2, unit_cost: 60, units_per_case_snapshot: 1 }),
        ])).toBe(8520)
    })
})
