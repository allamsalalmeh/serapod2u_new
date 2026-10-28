// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import StockQuantityDisplay from './StockQuantityDisplay'

afterEach(cleanup)

describe('StockQuantityDisplay', () => {
  it('renders a whole-case balance in blue with no extra-pcs line', () => {
    const { container } = render(
      <StockQuantityDisplay quantity={{ cases: 3861, pcs: 0, pcsPerCase: 4, unit: 'cases' }} />,
    )
    const primary = screen.getByText('3,861 cases')
    expect(primary.className).toContain('text-blue-800')
    expect(container.textContent).toBe('3,861 cases')
    expect(container.textContent).not.toMatch(/pcs/)
  })

  it('keeps a case balance in cases even when the ratio is unknown (1)', () => {
    // The original defect: ratio 1 was read as "piece-stocked".
    const { container } = render(
      <StockQuantityDisplay quantity={{ cases: 3861, pcs: 0, pcsPerCase: 1, unit: 'cases' }} />,
    )
    expect(container.textContent).toBe('3,861 cases')
  })

  it('renders additional pieces as a smaller teal line beneath the cases', () => {
    render(<StockQuantityDisplay quantity={{ cases: 3861, pcs: 2, pcsPerCase: 4, unit: 'cases' }} />)
    expect(screen.getByText('3,861 cases').className).toContain('text-blue-800')
    const pcs = screen.getByText('+ 2 pcs')
    expect(pcs.className).toContain('text-teal-600')
    expect(pcs.className).toContain('text-[11px]')
  })

  it('renders a pcs-only readout in teal', () => {
    render(<StockQuantityDisplay quantity={{ cases: 29, pcs: 0, pcsPerCase: 1, unit: 'pcs' }} />)
    expect(screen.getByText('29 pcs').className).toContain('text-teal-600')
  })

  it('shows a visible check note only when the unit is uncertain', () => {
    const { rerender, container } = render(
      <StockQuantityDisplay quantity={{ cases: 3861, pcs: 0, pcsPerCase: 1, unit: 'unknown' }} note="Product identity is missing" />,
    )
    expect(container.textContent).toContain('3,861')
    expect(container.textContent).toContain('Unit unconfirmed')
    expect(container.textContent).not.toMatch(/cases|pcs/)

    rerender(<StockQuantityDisplay quantity={{ cases: 3861, pcs: 0, pcsPerCase: 4, unit: 'cases' }} />)
    expect(container.textContent).toBe('3,861 cases')
  })
})
