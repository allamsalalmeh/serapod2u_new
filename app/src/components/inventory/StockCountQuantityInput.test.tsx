// @vitest-environment jsdom

import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveStockCountUnit, type StockCountUnit } from '@/lib/inventory/stock-count-catalog'
import StockCountQuantityInput, { type StockCountQuantityValue } from './StockCountQuantityInput'

function Harness({
  initialCases = '',
  initialPcs = '',
  onEnter,
  disabled,
  unit,
  unitsPerCase,
}: {
  initialCases?: string
  initialPcs?: string
  onEnter?: () => void
  disabled?: boolean
  unit?: StockCountUnit
  unitsPerCase?: number
}) {
  const [value, setValue] = useState<StockCountQuantityValue>({ cases: initialCases, pcs: initialPcs })
  return (
    <>
      <StockCountQuantityInput
        countInputId="cfg-1"
        cases={value.cases}
        pcs={value.pcs}
        unit={unit}
        unitsPerCase={unitsPerCase}
        disabled={disabled}
        onEnter={onEnter}
        onChange={next => setValue(next)}
      />
      <output data-testid="stored-cases">{value.cases}</output>
      <output data-testid="stored-pcs">{value.pcs}</output>
    </>
  )
}

const stored = () =>
  `${screen.getByTestId('stored-cases').textContent}|${screen.getByTestId('stored-pcs').textContent}`

describe('resolveStockCountUnit', () => {
  it('counts Cellera Hero/Zero cartridges in cases — the unit they are stocked in', () => {
    expect(resolveStockCountUnit('Cellera Hero')).toBe('cases')
    expect(resolveStockCountUnit('Cellera Zero')).toBe('cases')
  })

  it('counts devices and every other product in pieces', () => {
    expect(resolveStockCountUnit('Serapod Device S.Box')).toBe('pcs')
    expect(resolveStockCountUnit('Moonchair Camping Chair')).toBe('pcs')
    expect(resolveStockCountUnit('SERAPOD PRESTIGE KUREX')).toBe('pcs')
    expect(resolveStockCountUnit(null)).toBe('pcs')
  })
})

describe('StockCountQuantityInput — piece-stocked products', () => {
  afterEach(cleanup)

  it('shows one Pcs box and stores the count as typed', async () => {
    render(<Harness unit="pcs" unitsPerCase={1} />)
    expect(screen.queryByLabelText('Physical count in extra pieces')).toBeNull()
    expect(screen.queryByLabelText('Physical count in cases')).toBeNull()
    expect(screen.getByText('pcs')).toBeTruthy()
    await userEvent.type(screen.getByLabelText('Physical count in pieces'), '140')
    expect(stored()).toBe('140|')
  })

  it('advances on Enter', async () => {
    const onEnter = vi.fn()
    render(<Harness unit="pcs" onEnter={onEnter} />)
    await userEvent.type(screen.getByLabelText('Physical count in pieces'), '5{Enter}')
    expect(onEnter).toHaveBeenCalledTimes(1)
    expect(stored()).toBe('5|')
  })

  it('locks the field on a posted count', () => {
    render(<Harness initialPcs="9" unit="pcs" disabled />)
    expect((screen.getByLabelText('Physical count in pieces') as HTMLInputElement).disabled).toBe(true)
  })
})

describe('StockCountQuantityInput — Cases + Pcs boxes', () => {
  afterEach(cleanup)

  it('offers adjacent Cases and Pcs boxes for case-stocked products', () => {
    render(<Harness unit="cases" unitsPerCase={4} />)
    expect(screen.getByLabelText('Physical count in cases')).toBeTruthy()
    expect(screen.getByLabelText('Physical count in extra pieces')).toBeTruthy()
    expect(screen.getByText('Cases')).toBeTruthy()
    expect(screen.getByText('Pcs')).toBeTruthy()
    expect(screen.queryByLabelText('Count unit')).toBeNull()
  })

  it('renders a saved pair unchanged — never multiplied', () => {
    render(<Harness initialCases="3861" initialPcs="2" unit="cases" unitsPerCase={4} />)
    expect((screen.getByLabelText('Physical count in cases') as HTMLInputElement).value).toBe('3861')
    expect((screen.getByLabelText('Physical count in extra pieces') as HTMLInputElement).value).toBe('2')
  })

  it('keeps a partial case as typed while editing, then normalises on blur', async () => {
    render(<Harness unit="cases" unitsPerCase={4} />)
    const cases = screen.getByLabelText('Physical count in cases')
    const pcs = screen.getByLabelText('Physical count in extra pieces')

    await userEvent.type(cases, '100')
    await userEvent.type(pcs, '7')
    // Exactly what the operator typed — nothing jumps mid-entry.
    expect((cases as HTMLInputElement).value).toBe('100')
    expect((pcs as HTMLInputElement).value).toBe('7')

    // Editing finished: 100 cases + 7 pcs at 4 pcs/case is 101 cases + 3 pcs.
    fireEvent.blur(pcs)
    expect(stored()).toBe('101|3')
  })

  it('treats both boxes blank as not counted, never as zero', async () => {
    render(<Harness unit="cases" unitsPerCase={4} />)
    await userEvent.type(screen.getByLabelText('Physical count in cases'), '0')
    fireEvent.blur(screen.getByLabelText('Physical count in cases'))
    expect(stored()).toBe('0|')

    await userEvent.clear(screen.getByLabelText('Physical count in cases'))
    fireEvent.blur(screen.getByLabelText('Physical count in cases'))
    expect(stored()).toBe('|')
  })

  it('accepts a pieces-only count without inventing a case', async () => {
    render(<Harness unit="cases" unitsPerCase={4} />)
    const pcs = screen.getByLabelText('Physical count in extra pieces')
    await userEvent.type(pcs, '3')
    fireEvent.blur(pcs)
    expect(stored()).toBe('0|3')
  })

  it('folds pieces that reach a full case without an error', async () => {
    render(<Harness unit="cases" unitsPerCase={4} />)
    const pcs = screen.getByLabelText('Physical count in extra pieces')
    await userEvent.type(pcs, '9')
    fireEvent.blur(pcs)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(stored()).toBe('2|1')
  })

  it('advances on Enter from the Pcs box too', async () => {
    const onEnter = vi.fn()
    render(<Harness unit="cases" unitsPerCase={4} onEnter={onEnter} />)
    await userEvent.type(screen.getByLabelText('Physical count in extra pieces'), '8{Enter}')
    expect(stored()).toBe('2|')
    expect(onEnter).toHaveBeenCalledTimes(1)
  })
})

