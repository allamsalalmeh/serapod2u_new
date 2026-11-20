// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ReservedQuantityTrigger from './ReservedQuantityTrigger'
import { CLICKABLE_QUANTITY_FIGURE, TABLE_QUANTITY_UNIT } from './StockQuantityDisplay'

afterEach(cleanup)

describe('ReservedQuantityTrigger', () => {
  it("nonzero: Incoming's orange dotted-underline button with an inline grey unit", async () => {
    const onOpen = vi.fn()
    const rowClick = vi.fn()
    render(<div onClick={rowClick}><ReservedQuantityTrigger reserved={950} pcsPerCase={4} unit="cases" onOpen={onOpen} /></div>)
    const button = screen.getByRole('button', { name: /View reservations for 950 cases/ })
    expect(button.textContent).toBe('950')
    // Exactly the Incoming classes, on the number only.
    expect(button.className).toBe(CLICKABLE_QUANTITY_FIGURE)
    expect(button.className).toContain('text-[var(--sera-orange)]')
    expect(button.className).toContain('decoration-dotted')
    expect(button.className).toContain('hover:text-[var(--sera-orange-deep)]')
    expect(button.className).toContain('focus-visible:ring-2')
    const unit = button.nextElementSibling as HTMLElement
    expect(unit.textContent).toBe('cases')
    expect(unit.className).toBe(TABLE_QUANTITY_UNIT)
    expect(unit.className).not.toContain('orange')
    expect(button.parentElement?.textContent).toBe('950cases')
    await userEvent.click(button)
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(rowClick).not.toHaveBeenCalled()
  })

  it('keyboard activation opens without toggling the row', async () => {
    const onOpen = vi.fn()
    const rowKey = vi.fn()
    render(<div onKeyDown={rowKey}><ReservedQuantityTrigger reserved={200} pcsPerCase={4} unit="cases" onOpen={onOpen} /></div>)
    const button = screen.getByRole('button')
    button.focus()
    await userEvent.keyboard('{Enter}')
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(rowKey).not.toHaveBeenCalled()
  })

  it('zero: plain muted text, not clickable', () => {
    const onOpen = vi.fn()
    const { container } = render(<ReservedQuantityTrigger reserved={0} pcsPerCase={4} unit="cases" onOpen={onOpen} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(container.textContent).toBe('0cases')
    expect(container.innerHTML).toContain('text-[var(--sera-muted)]/70')
    expect(container.innerHTML).not.toContain('sera-orange')
    fireEvent.click(container.firstChild as Element)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('pcs-only products keep pcs', () => {
    render(<ReservedQuantityTrigger reserved={4} pcsPerCase={1} unit="pcs" onOpen={() => {}} />)
    expect(screen.getByRole('button').parentElement?.textContent).toBe('4pcs')
  })
})
