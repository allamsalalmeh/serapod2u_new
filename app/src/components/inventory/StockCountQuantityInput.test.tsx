// @vitest-environment jsdom

import { useState } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { casesToPieces } from '@/lib/inventory/stock-count-units'
import StockCountQuantityInput from './StockCountQuantityInput'

let setExternal: (value: string) => void = () => {}

function Harness({ initial = '', onEnter, disabled }: { initial?: string; onEnter?: () => void; disabled?: boolean }) {
  const [value, setValue] = useState(initial)
  setExternal = setValue
  return (
    <>
      <StockCountQuantityInput
        countInputId="cfg-1"
        value={value}
        disabled={disabled}
        onEnter={onEnter}
        onChange={next => { if (next === '' || /^\d+$/.test(next)) setValue(next) }}
      />
      <output data-testid="stored">{value}</output>
    </>
  )
}

const stored = () => screen.getByTestId('stored').textContent

describe('casesToPieces', () => {
  it('multiplies whole cases by pieces per case', () => {
    expect(casesToPieces('10', '4')).toBe(40)
    expect(casesToPieces('0', '24')).toBe(0)
  })

  it('waits for both numbers and a case of at least one piece', () => {
    expect(casesToPieces('', '4')).toBeNull()
    expect(casesToPieces('3', '')).toBeNull()
    expect(casesToPieces('3', '0')).toBeNull()
    expect(casesToPieces('1.5', '4')).toBeNull()
  })
})

describe('StockCountQuantityInput', () => {
  afterEach(cleanup)

  it('counts in pieces by default', async () => {
    render(<Harness />)
    expect((screen.getByLabelText('Count unit') as HTMLSelectElement).value).toBe('pcs')
    await userEvent.type(screen.getByLabelText('Physical count in pieces'), '140')
    expect(stored()).toBe('140')
    expect(screen.queryByLabelText('Pieces per case')).toBeNull()
  })

  it('stores cases as pieces and shows the total', async () => {
    render(<Harness />)
    await userEvent.selectOptions(screen.getByLabelText('Count unit'), 'case')
    await userEvent.type(screen.getByLabelText('Number of cases'), '10')
    expect(stored()).toBe('')
    await userEvent.type(screen.getByLabelText('Pieces per case'), '4')
    expect(stored()).toBe('40')
    expect(screen.getByText('= 40 pcs')).toBeTruthy()

    await userEvent.selectOptions(screen.getByLabelText('Count unit'), 'pcs')
    expect((screen.getByLabelText('Physical count in pieces') as HTMLInputElement).value).toBe('40')
  })

  it('keeps an existing count until cases are typed, and remembers the case size', async () => {
    render(<Harness initial="72" />)
    await userEvent.selectOptions(screen.getByLabelText('Count unit'), 'case')
    expect(stored()).toBe('72')
    expect(screen.getByText('= 72 pcs')).toBeTruthy()
    await userEvent.type(screen.getByLabelText('Pieces per case'), '24')
    await userEvent.type(screen.getByLabelText('Number of cases'), '5')
    expect(stored()).toBe('120')

    await userEvent.selectOptions(screen.getByLabelText('Count unit'), 'pcs')
    await userEvent.selectOptions(screen.getByLabelText('Count unit'), 'case')
    expect((screen.getByLabelText('Pieces per case') as HTMLInputElement).value).toBe('24')
    expect((screen.getByLabelText('Number of cases') as HTMLInputElement).value).toBe('')
    expect(stored()).toBe('120')
  })

  it('shows pieces again when the count is replaced from outside', async () => {
    render(<Harness />)
    await userEvent.selectOptions(screen.getByLabelText('Count unit'), 'case')
    act(() => setExternal('55'))
    expect((screen.getByLabelText('Count unit') as HTMLSelectElement).value).toBe('pcs')
    expect((screen.getByLabelText('Physical count in pieces') as HTMLInputElement).value).toBe('55')
  })

  it('ignores non-numeric case entries', async () => {
    render(<Harness />)
    await userEvent.selectOptions(screen.getByLabelText('Count unit'), 'case')
    await userEvent.type(screen.getByLabelText('Number of cases'), '3x')
    await userEvent.type(screen.getByLabelText('Pieces per case'), '-6')
    expect(stored()).toBe('18')
  })

  it('Enter moves to pieces per case first, then to the next row', async () => {
    const onEnter = vi.fn()
    render(<Harness onEnter={onEnter} />)
    await userEvent.type(screen.getByLabelText('Physical count in pieces'), '5{Enter}')
    expect(onEnter).toHaveBeenCalledTimes(1)

    await userEvent.selectOptions(screen.getByLabelText('Count unit'), 'case')
    await userEvent.type(screen.getByLabelText('Number of cases'), '2{Enter}')
    expect(document.activeElement).toBe(screen.getByLabelText('Pieces per case'))
    await userEvent.type(screen.getByLabelText('Pieces per case'), '6{Enter}')
    expect(onEnter).toHaveBeenCalledTimes(2)
    expect(stored()).toBe('12')
  })

  it('locks every field on a posted count', () => {
    render(<Harness initial="9" disabled />)
    expect((screen.getByLabelText('Count unit') as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByLabelText('Physical count in pieces') as HTMLInputElement).disabled).toBe(true)
  })
})
