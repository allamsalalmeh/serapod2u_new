// @vitest-environment jsdom

import { useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveStockCountUnit, type StockCountUnit } from '@/lib/inventory/stock-count-catalog'
import StockCountQuantityInput from './StockCountQuantityInput'

function Harness({ initial = '', onEnter, disabled, unit }: { initial?: string; onEnter?: () => void; disabled?: boolean; unit?: StockCountUnit }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <StockCountQuantityInput
        countInputId="cfg-1"
        value={value}
        unit={unit}
        disabled={disabled}
        onEnter={onEnter}
        onChange={next => { if (next === '' || /^\d+$/.test(next)) setValue(next) }}
      />
      <output data-testid="stored">{value}</output>
    </>
  )
}

const stored = () => screen.getByTestId('stored').textContent

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

describe('StockCountQuantityInput', () => {
  afterEach(cleanup)

  it('is PCS for devices and non-cartridge products', async () => {
    render(<Harness />)
    expect(screen.queryByLabelText('Count unit')).toBeNull()
    expect(screen.getByText('pcs')).toBeTruthy()
    await userEvent.type(screen.getByLabelText('Physical count in pieces'), '140')
    expect(stored()).toBe('140')
  })

  it('stores a Cellera count exactly as entered in cases — never multiplied', async () => {
    render(<Harness unit="cases" />)
    expect(screen.queryByLabelText('Count unit')).toBeNull()
    expect(screen.getByText('cases')).toBeTruthy()
    await userEvent.type(screen.getByLabelText('Physical count in cases'), '478')
    expect(stored()).toBe('478')
  })

  it('shows a saved count unchanged', () => {
    render(<Harness initial="2828" unit="cases" />)
    expect((screen.getByLabelText('Physical count in cases') as HTMLInputElement).value).toBe('2828')
  })

  it('Enter advances to the next row', async () => {
    const onEnter = vi.fn()
    render(<Harness unit="cases" onEnter={onEnter} />)
    await userEvent.type(screen.getByLabelText('Physical count in cases'), '5{Enter}')
    expect(onEnter).toHaveBeenCalledTimes(1)
    expect(stored()).toBe('5')
  })

  it('locks the field on a posted count', () => {
    render(<Harness initial="9" unit="cases" disabled />)
    expect((screen.getByLabelText('Physical count in cases') as HTMLInputElement).disabled).toBe(true)
  })
})
