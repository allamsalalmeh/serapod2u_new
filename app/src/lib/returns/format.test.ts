import { describe, it, expect } from 'vitest'
import {
    getVariantDisplayName, classifyProductLine, productLineLabel, getUnitsPerCase, getRowUnitsPerCase,
    getSavedRowUnitsPerCase, isCartridgeLine, isDeviceLine, formatReturnAmount, caseUnitLabel,
} from './format'

describe('getVariantDisplayName', () => {
    // Spec §5 display-extraction table.
    it.each([
        ['Zero Edition Novella [ Buttercake ]', 'Buttercake'],
        ['Zero Edition Novella [ Strawberry Vanilla ]', 'Strawberry Vanilla'],
        ['Deluxe Cellera Cartridge [ Banana Milk ]', 'Banana Milk'],
        ['Cellera Zero [ Novella ] [ Buttercake ]', 'Buttercake'],
        ['Honeydew', 'Honeydew'],
    ])('%s -> %s', (input, expected) => {
        expect(getVariantDisplayName(input)).toBe(expected)
    })

    it('falls back to the full name when brackets are empty', () => {
        expect(getVariantDisplayName('Plain Name [  ]')).toBe('Plain Name [  ]')
    })

    it('handles null/undefined/blank', () => {
        expect(getVariantDisplayName(null)).toBe('')
        expect(getVariantDisplayName(undefined)).toBe('')
        expect(getVariantDisplayName('   ')).toBe('')
    })
})

describe('classifyProductLine', () => {
    it.each([
        ['Cellera Hero', 'hero'],
        ['Cellera Zero', 'zero'],
        ['CELLERA HERO', 'hero'],
        ['Some Device', 'other'],
        [null, 'other'],
    ])('%s -> %s', (input, expected) => {
        expect(classifyProductLine(input as any)).toBe(expected)
    })
})

describe('productLineLabel', () => {
    it('maps lines to badge labels', () => {
        expect(productLineLabel('hero')).toBe('Hero')
        expect(productLineLabel('zero')).toBe('Zero')
        expect(productLineLabel('other')).toBe('Other')
    })
})

describe('getUnitsPerCase', () => {
    it('uses the Cellera default of 4 when master data is unreliable (1 / null)', () => {
        expect(getUnitsPerCase('Cellera Hero', 1)).toBe(4)
        expect(getUnitsPerCase('Cellera Zero', 1)).toBe(4)
        expect(getUnitsPerCase('Cellera Hero', null)).toBe(4)
        expect(getUnitsPerCase('Cellera Zero', undefined)).toBe(4)
    })
    it('never silently defaults Cellera Hero/Zero to 1', () => {
        expect(getUnitsPerCase('Cellera Hero', 0)).toBe(4)
        expect(getUnitsPerCase('Cellera Zero', 1)).not.toBe(1)
    })
    it('prefers a reliable configured pack size (> 1) from master data', () => {
        expect(getUnitsPerCase('Cellera Hero', 6)).toBe(6)
        expect(getUnitsPerCase('Some Device', 12)).toBe(12)
    })
    it('falls back to 1 for non-Cellera products without a reliable pack size', () => {
        expect(getUnitsPerCase('Some Device', 1)).toBe(1)
        expect(getUnitsPerCase('Accessory', null)).toBe(1)
    })
})

describe('isCartridgeLine / getRowUnitsPerCase', () => {
    it('marks only Hero and Zero as cartridges', () => {
        expect(isCartridgeLine('hero')).toBe(true)
        expect(isCartridgeLine('zero')).toBe(true)
        expect(isCartridgeLine('sbox')).toBe(false)
        expect(isCartridgeLine('sline')).toBe(false)
        expect(isCartridgeLine('other')).toBe(false)
        expect(isDeviceLine('sbox')).toBe(true)
    })

    it('Cases pack size is only for cartridges — devices and other products stay at 1 pcs', () => {
        expect(getRowUnitsPerCase('hero', 'Cellera Hero', 1)).toBe(4)
        expect(getRowUnitsPerCase('zero', 'Cellera Zero', null)).toBe(4)
        expect(getRowUnitsPerCase('sbox', 'Serapod Device S.Box', 10)).toBe(1)
        expect(getRowUnitsPerCase('other', 'SERAPOD PRESTIGE KUREX', 12)).toBe(1)
        expect(getRowUnitsPerCase('other', 'Moonchair Camping Chair', 6)).toBe(1)
    })
})

describe('getSavedRowUnitsPerCase', () => {
    it('reads a saved cartridge line back with the pack size it was posted with', () => {
        expect(getSavedRowUnitsPerCase('hero', 'Cellera Hero', 4, 4)).toBe(4)
        expect(getSavedRowUnitsPerCase('hero', 'Cellera Hero', 1, 4)).toBe(1)
        expect(getSavedRowUnitsPerCase('zero', 'Cellera Zero', 6, 4)).toBe(6)
    })
    it('resolves like a new row when the line has no usable snapshot', () => {
        expect(getSavedRowUnitsPerCase('hero', 'Cellera Hero', null, 4)).toBe(4)
        expect(getSavedRowUnitsPerCase('hero', 'Cellera Hero', 0, 1)).toBe(4)
        expect(getSavedRowUnitsPerCase('zero', 'Cellera Zero', undefined, null)).toBe(4)
    })
    it('keeps devices and other products at 1 pcs whatever was saved', () => {
        expect(getSavedRowUnitsPerCase('sbox', 'Serapod Device S.Box', 10, 1)).toBe(1)
        expect(getSavedRowUnitsPerCase('other', 'Moonchair Camping Chair', 6, 6)).toBe(1)
    })
})

describe('formatReturnAmount', () => {
    it.each([
        [1788, '1,788.00'],
        [1050, '1,050.00'],
        [3513, '3,513.00'],
        [1234, '1,234.00'],
        [1234567.5, '1,234,567.50'],
        [28, '28.00'],
        [0, '0.00'],
    ])('%s -> %s', (input, expected) => {
        expect(formatReturnAmount(input)).toBe(expected)
    })

    it('accepts numeric strings and falls back to 0.00 for missing/invalid values', () => {
        expect(formatReturnAmount('3513.00')).toBe('3,513.00')
        expect(formatReturnAmount(null)).toBe('0.00')
        expect(formatReturnAmount(undefined)).toBe('0.00')
        expect(formatReturnAmount('abc')).toBe('0.00')
    })
})

describe('caseUnitLabel', () => {
    it('is singular only for exactly one', () => {
        expect(caseUnitLabel(1)).toBe('Case')
        expect(caseUnitLabel(0)).toBe('Cases')
        expect(caseUnitLabel(2)).toBe('Cases')
    })
})
