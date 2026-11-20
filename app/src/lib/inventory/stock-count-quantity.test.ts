import { describe, expect, it } from 'vitest'
import {
  EMPTY_QUANTITY_TOTALS,
  addToQuantityTotals,
  casesToPcs,
  formatQuantityTotals,
  formatQuantityWithUnit,
  formatSignedQuantityWithUnit,
  formatStockChange,
  formatStockQuantity,
  hasMixedUnits,
  normalizeStockQuantity,
  parseStockQuantityEntry,
  pcsEntryToCases,
  resolveCaseUnitsPerCase,
  stockQuantityFromRow,
  stockQuantityTotalPcs,
  stockUnitDisplayLabel,
  stockUnitForProduct,
  sumQuantityTotals,
} from './stock-count-quantity'

describe('stockUnitForProduct', () => {
  it('resolves cartridges to cases and everything else to pcs', () => {
    expect(stockUnitForProduct('Cellera Hero')).toBe('cases')
    expect(stockUnitForProduct('Cellera Zero')).toBe('cases')
    expect(stockUnitForProduct('Serapod Device S.Box')).toBe('pcs')
    expect(stockUnitForProduct('Cellera Hazelnut')).toBe('pcs')
    expect(stockUnitForProduct(null)).toBe('pcs')
  })

  it('labels units for worksheets and tables', () => {
    expect(stockUnitDisplayLabel('cases')).toBe('Cases')
    expect(stockUnitDisplayLabel('pcs')).toBe('Pcs')
  })
})

describe('Stock Count case/pcs quantities', () => {
  describe('resolveCaseUnitsPerCase', () => {
    it('defaults Cellera cartridges to 4 pcs per case', () => {
      expect(resolveCaseUnitsPerCase('Cellera Hero')).toBe(4)
      expect(resolveCaseUnitsPerCase('Cellera Zero')).toBe(4)
    })

    it('lets an explicit pack size on master data win', () => {
      expect(resolveCaseUnitsPerCase('Cellera Hero', 6)).toBe(6)
    })

    it('never reuses a pack size for products that are stocked in pieces', () => {
      // product_groups/orders "units_per_case" legacy value must not leak in:
      // a device is counted in pieces, so its case factor is exactly 1.
      expect(resolveCaseUnitsPerCase('S.Box Device', 100)).toBe(1)
      expect(resolveCaseUnitsPerCase(null)).toBe(1)
    })
  })

  describe('formatQuantityWithUnit', () => {
    it('keeps the case balance authoritative and shows NO piece equivalent', () => {
      // BV on hand is 3,861 CASES. It must read as 3,861 — never 15,444, and
      // never "= 15,444 pcs" underneath: that invited the wrong unit.
      expect(formatQuantityWithUnit(3861, 'cases', 4)).toBe('3,861 cases')
    })

    it('labels piece-stocked rows in pieces only', () => {
      expect(formatQuantityWithUnit(140, 'pcs')).toBe('140 pcs')
      expect(formatQuantityWithUnit(1, 'pcs')).toBe('1 pc')
    })

    it('handles singular and unpacked cases', () => {
      expect(formatQuantityWithUnit(1, 'cases', 1)).toBe('1 case')
      expect(formatQuantityWithUnit(0, 'cases', 4)).toBe('0 cases')
    })

    it('signs variances without losing the unit', () => {
      expect(formatSignedQuantityWithUnit(2, 'cases', 4)).toBe('+2 cases')
      expect(formatSignedQuantityWithUnit(-3, 'pcs')).toBe('-3 pcs')
    })
  })

  describe('pcsEntryToCases', () => {
    it('converts a whole number of cases', () => {
      expect(pcsEntryToCases('8', 4)).toEqual({
        cases: 2,
        totalPcs: 8,
        loosePcs: 0,
        message: '= 2 cases',
      })
    })

    it('rejects a partial case instead of rounding it away', () => {
      const result = pcsEntryToCases('9', 4)
      expect(result.cases).toBeNull()
      expect(result.totalPcs).toBe(9)
      expect(result.loosePcs).toBe(1)
      expect(result.message).toContain('9 pcs is not a whole number of cases')
      expect(result.message).toContain('4 pcs per case')
    })

    it('treats blank as not counted, not as zero', () => {
      expect(pcsEntryToCases('', 4)).toEqual({ cases: null, totalPcs: 0, loosePcs: 0, message: null })
      expect(pcsEntryToCases('   ', 4).cases).toBeNull()
    })

    it('rejects non-numeric and negative entries', () => {
      expect(pcsEntryToCases('4.5', 4).message).toBe('Physical count must be a whole number of pieces.')
      expect(pcsEntryToCases('-4', 4).message).toBe('Physical count must be a whole number of pieces.')
    })

    it('is a pass-through for piece-stocked rows', () => {
      expect(pcsEntryToCases('7', 1)).toEqual({ cases: 7, totalPcs: 7, loosePcs: 0, message: null })
    })
  })

  describe('casesToPcs', () => {
    it('opens a case quantity in pieces', () => {
      expect(casesToPcs(3861, 4)).toBe(15444)
      expect(casesToPcs(0, 4)).toBe(0)
      expect(casesToPcs(7, 1)).toBe(7)
    })
  })

  describe('QuantityTotals', () => {
    it('never adds cases and pieces into one figure', () => {
      const totals = sumQuantityTotals([
        { value: 3861, unit: 'cases', unitsPerCase: 4 },
        { value: 140, unit: 'pcs' },
      ])
      expect(totals).toEqual({ cases: 3861, pcs: 140, casePieces: 15444 })
      expect(formatQuantityTotals(totals)).toBe('3,861 cases · 140 pcs')
    })

    it('renders a single unit without an empty part', () => {
      expect(formatQuantityTotals(sumQuantityTotals([{ value: 12, unit: 'cases', unitsPerCase: 4 }])))
        .toBe('12 cases')
      expect(formatQuantityTotals(sumQuantityTotals([{ value: 140, unit: 'pcs' }]))).toBe('140 pcs')
    })

    it('renders an empty scope as zero cases', () => {
      expect(formatQuantityTotals(EMPTY_QUANTITY_TOTALS)).toBe('0 cases')
    })

    it('accumulates negative variances per unit', () => {
      const totals = addToQuantityTotals(
        addToQuantityTotals(EMPTY_QUANTITY_TOTALS, -2, 'cases', 4),
        -3,
        'pcs',
      )
      expect(formatQuantityTotals(totals)).toBe('-2 cases · -3 pcs')
    })

    it('detects a mixed-unit scope', () => {
      expect(hasMixedUnits([{ unit: 'cases' }, { unit: 'pcs' }])).toBe(true)
      expect(hasMixedUnits([{ unit: 'pcs' }, { unit: 'pcs' }])).toBe(false)
      expect(hasMixedUnits([])).toBe(false)
    })
  })
})

describe('canonical pair: cases + loose pieces', () => {
  describe('normalizeStockQuantity', () => {
    it('folds loose pieces into whole units', () => {
      expect(normalizeStockQuantity(100, 7, 4)).toEqual({ cases: 101, pcs: 3, pcsPerCase: 4 })
      expect(normalizeStockQuantity(3861, 4, 4)).toEqual({ cases: 3862, pcs: 0, pcsPerCase: 4 })
      expect(normalizeStockQuantity(3861, 2, 4)).toEqual({ cases: 3861, pcs: 2, pcsPerCase: 4 })
    })

    it('keeps piece-stocked products free of a loose remainder', () => {
      expect(normalizeStockQuantity(0, 5, 1)).toEqual({ cases: 5, pcs: 0, pcsPerCase: 1 })
    })

    it('is idempotent', () => {
      const once = normalizeStockQuantity(100, 7, 4)
      expect(normalizeStockQuantity(once.cases, once.pcs, once.pcsPerCase)).toEqual(once)
    })
  })

  it('totals in pieces without losing the remainder', () => {
    expect(stockQuantityTotalPcs({ cases: 3861, pcs: 2, pcsPerCase: 4 })).toBe(15446)
    expect(stockQuantityTotalPcs({ cases: 29, pcs: 0, pcsPerCase: 1 })).toBe(29)
  })

  describe('formatStockQuantity', () => {
    it('shows whole cases with no equivalent total', () => {
      expect(formatStockQuantity({ cases: 3861, pcs: 0, pcsPerCase: 4 })).toEqual({
        primary: '3,861 cases', secondary: null, text: '3,861 cases', isZero: false,
      })
    })

    it('shows additional pieces underneath, never "+ 0 pcs"', () => {
      expect(formatStockQuantity({ cases: 3861, pcs: 2, pcsPerCase: 4 })).toEqual({
        primary: '3,861 cases', secondary: '+ 2 pcs', text: '3,861 cases + 2 pcs', isZero: false,
      })
    })

    it('shows less than one case as pieces only', () => {
      expect(formatStockQuantity({ cases: 0, pcs: 2, pcsPerCase: 4 }).primary).toBe('2 pcs')
    })

    it('labels piece-stocked products in pieces', () => {
      expect(formatStockQuantity({ cases: 29, pcs: 0, pcsPerCase: 1 }).primary).toBe('29 pcs')
    })

    it('shows a labelled zero', () => {
      expect(formatStockQuantity({ cases: 0, pcs: 0, pcsPerCase: 4 }).text).toBe('0 cases')
      expect(formatStockQuantity({ cases: 0, pcs: 0, pcsPerCase: 1 }).text).toBe('0 pcs')
    })
  })

  describe('formatStockChange', () => {
    it('collapses a mixed vector to the net pieces actually moved', () => {
      // +1 case -2 pcs at 4 pcs/case is really +2 pcs on the shelf.
      expect(formatStockChange({ cases: 1, pcs: -2, pcsPerCase: 4 }).text).toBe('+2 pcs')
    })

    it('keeps a pure piece variance in pieces', () => {
      expect(formatStockChange({ cases: 0, pcs: -2, pcsPerCase: 4 }).text).toBe('-2 pcs')
    })

    it('signs case movements', () => {
      expect(formatStockChange({ cases: -3, pcs: 0, pcsPerCase: 4 }).text).toBe('-3 cases')
      expect(formatStockChange({ cases: 3, pcs: 0, pcsPerCase: 4 }).text).toBe('+3 cases')
    })

    it('says so when nothing changed', () => {
      expect(formatStockChange({ cases: 0, pcs: 0, pcsPerCase: 4 }).text).toBe('No change')
    })
  })

  describe('parseStockQuantityEntry', () => {
    it('treats both boxes blank as not counted', () => {
      expect(parseStockQuantityEntry('', '', 4)).toEqual({ cases: null, pcs: 0, quantity: null, error: null })
      expect(parseStockQuantityEntry('  ', ' ', 4).cases).toBeNull()
    })

    it('accepts a normalised pair as typed', () => {
      const entry = parseStockQuantityEntry('100', '7', 4)
      expect(entry.quantity).toEqual({ cases: 101, pcs: 3, pcsPerCase: 4 })
      expect(entry.error).toBeNull()
    })

    it('rejects a fractional entry with a usable message', () => {
      expect(parseStockQuantityEntry('4.5', '', 4).error).toBe('Cases must be a whole number.')
      expect(parseStockQuantityEntry('2', 'x', 4).error).toBe('Pieces must be a whole number.')
    })

    it('reads a pair out of a balance row', () => {
      expect(stockQuantityFromRow({ quantity_on_hand: 3861, pcs_on_hand: 2, pcs_per_case: 4 }))
        .toEqual({ cases: 3861, pcs: 2, pcsPerCase: 4 })
      expect(stockQuantityFromRow({ quantity_on_hand: 140 }))
        .toEqual({ cases: 140, pcs: 0, pcsPerCase: 1 })
    })
  })
})

